# A2A × Registry — verified findings (2026-07-13)

All facts below were probed live in this account/codebase during the research
session; nothing is assumed from training data.

## What the Registry A2A records are today (platform side)

- Every deploy method's final register stage (`backend/app/deployer/registration.py`,
  shared by harness/zip/container/studio) upserts an A2A record via
  `register_agent_record` (`backend/app/services/registry_console.py:48`).
- Card builder: `build_a2a_card` (`backend/app/services/agentcore/registry.py:22`),
  schema version 0.3.0. Current content:
  - `url` = **runtime/harness ARN** — NOT a resolvable A2A endpoint
  - `description` = system_prompt[:180]
  - `skills: []` — always empty (nothing derived from tools/skills/KBs)
  - `preferredTransport: JSONRPC`, `capabilities.streaming: true`, text/plain modes
  - `metadata.launchpad.method`, `metadata.launchpad.invoke: "platform /v1 API"`
- Descriptor shape: `descriptors.a2a.agentCard.{schemaVersion, inlineContent(JSON str)}`.
- A2A records are deploy-managed: console edit/reimport is rejected
  (`registry_console.py:569-585`, router PUT guard).
- Status machine (UI mapping in `services/agentcore/registry.py` docstring):
  submit → PENDING_APPROVAL (chip SUBMITTED), approve → APPROVED (chip PUBLISHED),
  REJECTED is **recoverable**, DEPRECATED is **terminal** (verified live earlier —
  use reject/approve for on/off demos, never disable).
- New records auto-submit on create (`register_agent_record` auto_submit=True).
- Semantic search exposed: `GET /api/registry/records/search?q=` →
  `console_search` → data-plane `search_registry_records` (registryIds list).
- Live inventory: ~10 A2A records (aurora-support, hr-assistant, eval-target,
  eval-target-v2, golden-path-*, studio-*, plain-probe), all v1.0.0.

## AgentCore native A2A support (AWS side)

- `CreateAgentRuntime.protocolConfiguration.serverProtocol` enum (probed via the
  installed botocore model): `['MCP', 'HTTP', 'A2A', 'AGUI']`. Same param exists
  on `UpdateAgentRuntime` (verify at implementation time).
- A2A runtime contract (starter-toolkit doc
  https://aws.github.io/bedrock-agentcore-starter-toolkit/user-guide/runtime/a2a.md):
  - container runs a stateless streamable-HTTP A2A server on **port 9000 at `/`**
    (vs 8080 `/invocations` HTTP, 8000 `/mcp` MCP)
  - `InvokeAgentRuntime` passes JSON-RPC payloads through **unmodified**
  - agent card served at
    `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{urlencode(arn)}/invocations/.well-known/agent-card.json`
  - auth: SigV4 or OAuth (Cognito). SigV4 is enough for platform-mediated calls —
    backend already has httpx+SigV4Auth plumbing (experiment traffic sender).
  - errors: JSON-RPC error codes mapped from runtime exceptions (HTTP 200 wrapping)
- Server building blocks: `strands-agents[a2a]` provides
  `strands.multiagent.a2a.A2AServer` (wrap Agent, `http_url=AGENTCORE_RUNTIME_URL`
  env, `serve_at_root=True`); client is the official `a2a-sdk`
  (A2ACardResolver + ClientFactory) or raw JSON-RPC `message/send`.

## Platform extension points (for the feature work)

- Runtime param builders: `backend/app/services/agentcore/runtime.py` —
  `create_code_runtime`/`update_code_runtime` (zip, codeConfiguration PYTHON_3_13,
  entryPoint `opentelemetry-instrument main.py`) and container variants. Adding
  `protocolConfiguration` is a param-level change on create + update.
- Strands zip template: `backend/app/templates/strands_agent/main.py.tmpl` +
  `requirements.txt` (A2A variant: A2AServer wrapper, port 9000, serve_at_root,
  keep ADOT entrypoint).
- Invoke plumbing: `backend/app/services/invoke.py::invoke_runtime_text(agent, prompt)`
  — single choke point used by chat + eval; A2A branch = build JSON-RPC
  message/send, parse Message/Task result.
- Registry UI drawer: `frontend/src/pages/Registry.tsx` — A2A descriptors render
  only as a raw excerpt (`descriptorExcerpt`); skills records get special parsing,
  A2A cards do not.

## Open risks (probe FIRST during implementation)

1. zip `codeConfiguration` artifact + `protocolConfiguration: A2A` combination —
   the official tutorial deploys A2A via **container**; zip+A2A is unverified.
   Fallback: route A2A agents through the container path.
2. `UpdateAgentRuntime` with protocolConfiguration on republish — keep/reject
   semantics unverified.
3. gen_ai telemetry from an A2AServer-wrapped strands agent (ADOT entrypoint
   retained — expected to work, verify spans arrive).

## Step-0 probe results (2026-07-13, live, resources cleaned up)

1. **zip + A2A: WORKS.** `codeConfiguration` zip artifact + `protocolConfiguration
   {serverProtocol: A2A}` → READY. Caveat: the managed PYTHON_3_13 runtime does
   NOT install requirements.txt — wheels must be vendored into the zip exactly
   as production `build_zip` does (probe reused it; `strands-agents[a2a,otel]`
   resolves fully to manylinux2014_aarch64/pure wheels; package ≈ 45.6 MB).
   First attempt with bare requirements.txt failed CREATE with "OpenTelemetry
   instrumentation executable not found".
2. **AGENTCORE_RUNTIME_URL is auto-injected by the runtime** — the served agent
   card carried the correct data-plane invocations URL with no env configured.
   No create→update env two-step needed.
3. **Card + invoke proven.** SigV4 GET `…/invocations/.well-known/agent-card.json`
   → 200 (A2AServer card). `InvokeAgentRuntime` with JSON-RPC `message/send` →
   `result` is a **Task**: reply text lives in `result.artifacts[].parts[].text`;
   `result.history` contains streaming fragments (role=agent messages split
   mid-word) — parse artifacts, never join history.
4. **UpdateAgentRuntime protocolConfiguration is omit=RESET** (opposite of
   UpdateHarness omit=keep): updating without the field silently reverts the
   runtime to HTTP (card fetch → 400); re-sending `{serverProtocol: A2A}`
   restores it (card → 200). Republish paths MUST always echo the protocol.

## registry-cards live findings (2026-07-13)

- **UpdateRegistryRecord resets status to DRAFT** — the update transitions
  through async UPDATING, and once settled the record is DRAFT regardless of
  its prior status (APPROVED included). Any card-refresh flow must
  `wait_record_settled` then re-submit / re-approve. `refresh_a2a_cards.py`
  does this; register-on-redeploy of an APPROVED record likewise knocks it
  back to DRAFT and it re-enters the approval queue (auto_submit covers the
  submit half only — approval is a deliberate human step, EXCEPT the
  refresher restores prior APPROVED records automatically).
- Post-refresh registry state: aurora-support / hr-assistant /
  aurora-support-rt / aurora-faq-a2a APPROVED (front-desk demo set); other
  live agents PENDING_APPROVAL; DEPRECATED records untouched (terminal).
- Derived skills now on live cards: aurora-support → aurora-deck-docs (with
  the KB description as routing signal), hr-assistant → hr-database,
  zip template agents → calculator/current-time; code-defined agents
  (studio/container/converted) honestly derive [] — spec declares nothing.
