# A2A-Protocol Agents

> Create agents that serve the standard Agent-to-Agent protocol (JSON-RPC)
> on AgentCore Runtime via `protocolConfiguration.serverProtocol=A2A`, with
> real (resolvable) Registry agent cards. Introduced 2026-07-13 (task
> 07-13-a2a-agent-create, parent 07-13-a2a-e2e). Companion research:
> `.trellis/tasks/07-13-a2a-e2e/research/a2a-registry-findings.md`.

## Scenario: creating / operating an A2A agent

### 1. Scope / Trigger

- Anything touching `AgentSpec.protocol` / `a2a_skills`, the
  `templates/strands_a2a_agent/` template, protocolConfiguration deploy
  params, the JSON-RPC invoke branch, or A2A card registration.

### 2. Signatures

```python
# schemas/agent.py
AgentSpec.protocol: Literal["http", "a2a"] = "http"   # zip_runtime only for a2a
AgentSpec.a2a_skills: list[A2ASkill]                  # {id,name,description,tags}; a2a only
# a2a is incompatible with code/code_bundle (always the platform template)

# services/agentcore/runtime.py
create_code_runtime(..., protocol=None)   # a2a → protocolConfiguration {serverProtocol: A2A}
update_code_runtime(..., protocol=None)   # MUST echo protocol on every update (omit=RESET)
invoke_a2a_text(client, arn, prompt, session_id=None) -> {text, session_id}
a2a_result_text(result) -> str            # Task artifacts[].parts[] | Message parts[]

# services/agentcore/registry.py
data_plane_invocations_url(arn, region) -> str
build_a2a_card(..., url=None, skills=None, transport="agentcore-http")
# transport: "a2a-jsonrpc" (real A2A endpoint) | "agentcore-http" (platform invoke)

# templates/strands_a2a_agent/__init__.py
render_a2a_main_py(spec) -> str           # A2AServer(agent_factory=..., serve_at_root=True, skills=...)
a2a_base_requirements() -> list[str]      # strands-agents[a2a,otel] + fastapi/uvicorn
```

### 3. Load-bearing facts (all probed live 2026-07-13)

- **zip + A2A works**: `codeConfiguration` zip artifact + `protocolConfiguration
  {serverProtocol: A2A}` → READY. The managed PYTHON_3_13 runtime does NOT
  install requirements.txt — wheels must be vendored (production `build_zip`
  does; `strands-agents[a2a,otel]` fully resolves to aarch64/pure wheels,
  ≈46 MB package).
- **`AGENTCORE_RUNTIME_URL` is auto-injected** by the runtime — the served
  card carries the correct data-plane invocations URL with no env wiring.
- **UpdateAgentRuntime protocolConfiguration is omit=RESET** (opposite of
  UpdateHarness omit=keep): omitting it silently reverts the runtime to HTTP
  (well-known card → 400). Every update path echoes `spec.protocol`.
- **JSON-RPC passthrough**: `InvokeAgentRuntime` with a `message/send`
  envelope returns the A2A result unmodified. Task replies carry the final
  text in `result.artifacts[].parts[].text`; `result.history` contains
  STREAMING FRAGMENTS (agent messages split mid-word) — never join history.
- Well-known card fetch: SigV4 GET
  `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{urlencode(arn)}/invocations/.well-known/agent-card.json`
  (needs `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header).

### 4. Behavior contracts

- Chat playground and the public API dispatch through
  `services/invoke.py::invoke_agent_text` (`spec.protocol == "a2a"` →
  `invoke_a2a_text`). The eval runner and persona simulator BYPASS that entry
  point (`evaluation/service.py::execute_run`, `evaluation/simulation.py`) and
  carry their own protocol branch — any NEW direct `InvokeAgentRuntime` caller
  must dispatch on protocol too, or A2A runtimes reject the `{prompt}` payload
  with JSON-RPC -32600 (the live eval-run failure that forced this note).
  Users see plain text either way.
- The A2A template deliberately drops the config-bundle contract and the
  platform memory envelope (A2A server owns conversation state). Because of
  that, **experiments reject A2A agents** (400
  `experiment.protocol_unsupported`; UI picker disables with a reason —
  mirrors the harness pattern).
- Register stage publishes a REAL card for A2A agents: `url` = data-plane
  invocations URL, `skills` = spec.a2a_skills, `metadata.launchpad.transport`
  = `a2a-jsonrpc`. HTTP agents keep `agentcore-http` cards (platform invoke).
- UI: SERVICE PROTOCOL selector on the Strands zip configure step; AGENT CARD
  SKILLS editor (seeded from template tools; id auto-slugged from name);
  agent list shows `zip_runtime · a2a`.

### 5. Verification

- `backend/tests/test_a2a_agent.py` (validator matrix, template compile,
  deploy params incl. update-echo, invoke parsing incl. history-fragment
  guard, card builder, experiment 400).
- Live proof: agent `aurora-faq-a2a` (KEPT — demo specialist for
  07-13-a2a-frontdesk-demo): UI create → card fetch 200 with configured
  skills → chat `17*23 → "391"` → registry record PENDING_APPROVAL with
  a2a-jsonrpc transport → experiment picker disabled.

### 6. Known gaps / follow-ups

- A2A streaming (`message/stream`) not surfaced in chat (sync only).
- Sibling task 07-13-a2a-registry-cards generalizes card enrichment
  (skills derivation) for HTTP agents + Registry drawer AGENT CARD panel.
- OAuth inbound auth unsupported (SigV4 only, platform-mediated).
