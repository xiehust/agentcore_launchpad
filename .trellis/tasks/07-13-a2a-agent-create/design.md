# Technical design — A2A agent creation

Verified groundwork: `../07-13-a2a-e2e/research/a2a-registry-findings.md`.

## Decision log

- **Protocol toggle on the zip path, not a new method.** A new method card
  would duplicate the whole configure UI; a `protocol` field reuses generate/
  package/provision/deploy/register untouched except where protocol matters.
- **SigV4 only.** `InvokeAgentRuntime` passes JSON-RPC through unmodified, so
  the platform backend (and any boto3-holding agent) can call A2A runtimes
  without OAuth infrastructure.
- **Probe-first for zip+A2A.** Contract risk isolated to one param; fallback is
  the existing container path (design below is artifact-agnostic).

## Data model

`AgentSpec` (backend/app/schemas — locate exact module at implementation):

```python
protocol: Literal["http", "a2a"] = "http"
a2a_skills: list[A2ASkill] | None = None   # {id, name, description, tags[]}
```

Validator: `a2a_skills` only meaningful when `protocol == "a2a"`; A2A allowed
only for `method == "zip_runtime"` (v1) — 422 `agent.protocol_unsupported`
otherwise. Ledger `Agent` row needs no schema change (protocol lives in spec).

## Pipeline changes by stage

1. **generate** — template selection keyed by `spec.protocol`:
   `templates/strands_agent/main.py.tmpl` (unchanged) vs new
   `templates/strands_a2a_agent/main.py.tmpl`:
   - same tool set / model loading / memory env as the strands template
   - `A2AServer(agent=…, http_url=os.environ.get("AGENTCORE_RUNTIME_URL", "http://127.0.0.1:9000/"), serve_at_root=True)`
   - FastAPI mount at `/` + `/ping` health route, uvicorn `0.0.0.0:9000`
   - skills injected into the Agent/`A2AServer` card config from spec.a2a_skills
   - requirements: `strands-agents[a2a]` + existing pins
2. **package** — unchanged (zip of generated files).
3. **provision** — unchanged (role, bucket).
4. **deploy** — `create_code_runtime`/`update_code_runtime`
   (`services/agentcore/runtime.py`) accept `protocol: str | None`; when `a2a`,
   add `protocolConfiguration={"serverProtocol": "A2A"}` and inject
   `AGENTCORE_RUNTIME_URL` env (data-plane invocations URL — constructible from
   region+ARN after create; pattern: create → derive URL → update env, or set
   post-create via the same Update call that already runs for env wiring —
   confirm ordering at implementation).
5. **register** — pass `protocol` + `a2a_skills` into `register_agent_record`;
   card gets real `url`/`skills` (shared builder work coordinated with
   `07-13-a2a-registry-cards`).

## Invoke path

`services/invoke.py::invoke_runtime_text` branches on `spec.protocol`:

```python
if spec.get("protocol") == "a2a":
    payload = {"jsonrpc": "2.0", "id": uuid4().hex, "method": "message/send",
               "params": {"message": {"role": "user", "messageId": uuid4().hex,
                          "parts": [{"kind": "text", "text": prompt}]}}}
    raw = invoke_agent_runtime(data_client, arn, json.dumps(payload), session_id)
    return _a2a_text(raw)   # Message.parts[].text | Task artifacts | JSON-RPC error → raise
```

Session id maps to `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` exactly as the
HTTP path already does (same InvokeAgentRuntime API). Response parsing handles
the three shapes: `result.parts` (Message), `result.artifacts[].parts` (Task),
`error` (raise with code/message). Chat history/memory: A2A server manages its
own conversation; platform memory envelope hooks are out of scope v1 (note in
agent detail panel).

## Experiment gating

`POST /api/experiments` create guard + frontend picker: reject/disable when
`spec.protocol == "a2a"` (`experiment.protocol_unsupported`, reuse the
harness-hint UI slot with a new i18n key).

## UI

`CreateAgent` zip configure step:
- SERVICE PROTOCOL radio (default HTTP). A2A selected →
  - AGENT CARD SKILLS editor (list of {name, description, tags-as-csv} rows,
    add/remove; prefilled one skill per selected template tool)
  - note card: A2A semantics (9000/JSON-RPC/registry real card; chat works)
- Agent list/detail: protocol chip for a2a agents; detail shows card URL with
  copy button.

## Rollout / rollback

Additive, feature-scoped: no change for `protocol="http"` (default). Rollback =
revert commits; existing A2A agents (if any deployed) keep running — their
runtimes are independent of console code.

## Test strategy

- Unit: spec validator matrix; runtime param builder (protocolConfiguration
  presence/absence); invoke A2A branch parsing (Message/Task/error fixtures);
  register payload with skills.
- Live (manual, one agent): probe zip+A2A create → well-known card fetch →
  chat round-trip → eval run → republish keeps protocol. Keep the agent as the
  demo specialist for `07-13-a2a-frontdesk-demo`.
