# Research: Launchpad Complete Agent Lifecycle (for Strands Studio Canvas)

- **Query**: Document the full agent create → build → publish → registry → chat/eval/experiment lifecycle so a native "Strands Studio" canvas page can reuse the SAME publish pipeline.
- **Scope**: internal
- **Date**: 2026-07-11

## TL;DR (headline findings)

1. **The backend "studio" method already exists and is fully wired.** `AgentSpec` has a `code` field (pre-generated agent code that bypasses the strands template) and a `requirements` field. `method="studio"` is a supported method that rides the exact same zip fast path as `zip_runtime`, and studio-generated code is adapted into an AgentCore module by `adapt_studio_code()`. A native canvas that POSTs `{name, method:"studio", code, requirements}` to `POST /api/agents` needs **no backend changes**.
2. **Today "Studio / 方式C" is an EXTERNAL vendored app** at `apps/studio/` (React + XYFlow visual flow builder, port 5273, own backend :8100). It generates Strands code and POSTs it to the platform via a `/launchpad-api` proxy. The platform's own `CreateAgent.tsx` only shows a card that *links out* to that external app — it never submits `method:"studio"` itself.
3. **Every creation method converges on one pipeline** (`generate → package → provision → deploy → register`) and one ledger. Any agent that reaches `status="active"` with an `arn` automatically works in Chat, Evaluation, Experiments, and Observability because those features key off the ledger `agent_id` (and the agent's `method` ∈ the runtime-backed set).
4. **Frontend gap for a native canvas**: the typed client `AgentSpecInput` (`frontend/src/lib/api.ts:54-62`) does NOT include `code` / `requirements` / `env`. A native page must either extend `AgentSpecInput` + `api.createAgent`, or POST via raw `fetch` (as the external studio app does).

---

## 1. Frontend — Create Agent flow

### File: `frontend/src/pages/CreateAgent.tsx` (route `/create`, App.tsx:19)

- **3-step wizard** via `useState<Step>` (1=method, 2=configure, 3=launch sequence). Steps rendered at `CreateAgent.tsx:250-611`.
- **Method type (frontend)**: `type Method = "harness" | "zip_runtime" | "container"` (`CreateAgent.tsx:23`). Note there is NO `"studio"` in the visible picker even though the backend supports it.
- **Three method cards** (`CreateAgent.tsx:261-319`):
  - `harness` — CreateHarness · InvokeHarness (managed).
  - `container` — CodeBuild → ECR → Runtime (Claude SDK, `CLAUDE_CODE_USE_BEDROCK=1`).
  - `zip_runtime` — labeled with `create.methods.studio.*` i18n keys, "pip (arm64) → zip → S3 → Runtime". This card also renders a `studio-link` anchor to `STUDIO_URL` = `VITE_STUDIO_URL` default `http://localhost:5273` (`CreateAgent.tsx:11-12,300-318`). **This is the current "Strands Studio" entry point — an external link, not a native page.**
- **Form state / fields collected** (`CreateAgent.tsx:55-72`): `name`, `modelId` (default `global.anthropic.claude-sonnet-4-6`, line 10), `systemPrompt`, `tools[]` (builtin: `code-interpreter`, `browser` — line 13), `selectedGateway[]`, `selectedMcp[]`, `skills[]`, `longTerm` (long-term memory), `mcpServers` (container only), `method`.
- **buildSpec()** (`CreateAgent.tsx:157-178`) produces the POST body:
  ```
  { name, method, model_id, system_prompt,
    tools: [{type:"builtin",name}|{type:"gateway",name}|{type:"mcp",name,config:{url}}],
    memory: { short_term: true, long_term },
    skills?, env?: { LAUNCHPAD_MCP_SERVERS } }
  ```
  (harness attaches tools/skills; container passes MCP JSON via env; `code`/`requirements` are NOT produced here.)
- **Validation** (`CreateAgent.tsx:244`): name `^[a-z][a-z0-9-]{2,47}$`, system prompt non-empty.
- **Submit** (`CreateAgent.tsx:180-198`): `editing ? api.redeployAgent(id,spec) : api.createAgent(spec)`; stores `{agentId, jobId}`, moves to step 3.
- **Polling** (`CreateAgent.tsx:110-140`): every 2 s calls `api.getAgent(agentId)` + `api.getJob(jobId)` until status `active`/`failed`.
- **LaunchSequence** (`CreateAgent.tsx:746-832`): renders `deployment.stages` as a pipeline (node status ✓/●/✕) + a live job-event log (`job.events`, JSONL). Stage i18n keys: `create.stages.{generate|package|provision|deploy|register}`.
- **Attachables** (`CreateAgent.tsx:74-87`): `fetch("/api/registry/attachables")` → `{mcp_servers[], skills[]}` (only APPROVED registry records) populate the tool/skill chips.
- **AgentList** (`CreateAgent.tsx:647-730`): table of existing agents with columns name/method/status/revision/updated + row actions Edit, Chat (`Link to /chat?agent={id}`, line 699), Details, Delete. `startEdit` (line 200-216) reloads a stored spec into the wizard and switches submit to re-publish; `openDetails` (line 218-229) opens read-only launch sequence.

### File: `frontend/src/pages/Registry.tsx` (route `/registry`)

- Record type shown: `RegistryRecord { record_id, name, description, type: "A2A"|"MCP"|"AGENT_SKILLS", status, version, descriptors?, updated_at }` (`Registry.tsx:11-20`).
- **3 tabs**: A2A (agents), MCP (tools/gateway), AGENT_SKILLS (`Registry.tsx:22-26`).
- **Status chips / state machine mapping** (`Registry.tsx:28-34`): `DRAFT`(○ muted) → `PENDING_APPROVAL`(◍ warn "SUBMITTED") → `APPROVED`(● good "PUBLISHED"); `REJECTED`(✕ crit); `DEPRECATED`(✕ muted "DISABLED").
- **Lifecycle action buttons** (`Registry.tsx:487-514`): DRAFT→submit; PENDING_APPROVAL/REJECTED→approve; PENDING_APPROVAL→reject; APPROVED→disable (confirm); always→delete (confirm). Actions POST `/api/registry/records/{id}/action`.
- **Manual registration** (`Registry.tsx:145-180`): only MCP and AGENT_SKILLS via `POST /api/registry/records`. **A2A records are NEVER hand-registered — deploys create/refresh them** (backend note `routers/registry.py:63-64`).
- **"Use in new agent"** (`Registry.tsx:203-223`): MCP → `navigate("/create?gateway=<name>")`; AGENT_SKILLS → `navigate("/create?skill=<s3 path>")`. `CreateAgent` reads these prefill params (`CreateAgent.tsx:52-66`).
- **No "re-publish" for A2A agent records here** — agent re-publish lives in `CreateAgent.tsx` (edit → redeploy), not Registry.

---

## 2. Backend — routes, build, publish, registry

### Routes: `backend/app/routers/agents.py` (prefix `/api`, tags agents)

| Endpoint | Line | Notes |
|---|---|---|
| `POST /api/agents` (202) | 79-101 | Validates `method ∈ SUPPORTED_METHODS = {harness, zip_runtime, container, studio}` (line 24). Rejects duplicate active name (409). Creates `Agent(status="deploying", spec=spec.model_dump())`, then `create_deployment` + `start_deploy_async`. Returns `{agent, job_id, deployment_id}`. |
| `GET /api/agents` | 104-120 | Lists non-deleted; adds `revision` = count of Deployment rows. |
| `GET /api/agents/{id}` | 123-136 | Includes `deployments[]`. |
| `POST /api/agents/{id}/redeploy` (202) | 139-179 | In-place re-publish, `mode="update"`. **name & method immutable** (400 if changed). Overwrites `agent.spec`, sets status deploying. |
| `POST /api/agents/{id}/invoke` | 182-205 | Requires `status=="active"` + `arn`. |
| `DELETE /api/agents/{id}` | 208-217 | Tears down method-specific AWS resource, sets `status="deleted"` (soft delete; name reusable). |
| `GET /api/jobs/{id}` | 220-235 | Returns parsed JSONL `events`. |

`_agent_out` (line 27-45) shape returned to frontend: `{id,name,method,status,arn,resource_id,registry_record_id,version,owner,error,spec,created_at,updated_at, (deployment?)}`.

### Schema: `backend/app/schemas/agent.py`

`AgentSpec` (line 32-46) — the single artifact every method converges into:
```
name: str  (pattern ^[a-z][a-z0-9-]{2,47}$)
method: Literal["harness","zip_runtime","container","studio"]
model_id: str = "global.anthropic.claude-sonnet-4-6"
system_prompt: str  (1..20000)
tools: list[ToolRef]              # ToolRef = {type: builtin|gateway|mcp, name, config}
skills: list[str]
requirements: list[str]           # extra pip reqs for zip_runtime/studio (line 39-40)
code: str | None  (max 200000)    # STUDIO pre-generated code, bypasses strands template (line 41-42)
memory: {short_term=True, long_term=False}
env: dict[str,str]
max_iterations: int = 10;  timeout_seconds: int = 300
```
`InvokeRequest`/`InvokeResponse` at line 49-58.

### Unified pipeline: `backend/app/deployer/pipeline.py`

- `STAGE_ORDER = ["generate","package","provision","deploy","register"]` (line 26).
- Methods register a stage-fn dict via `register_method(name, stages)` (line 55-62). A missing stage-fn = skipped (line 159).
- `create_deployment(db, agent, mode)` (line 100-121): writes a `Deployment` (all stages pending) + a `Job(type="deploy_agent", payload={agent_id, deployment_id, mode})`.
- `execute_deploy_job(job_id)` (line 124-180): runs on a daemon thread (`start_deploy_async`, line 205); iterates stages, **resumes from first non-succeeded stage** (line 145-147); persists stage status on the Deployment row + JSONL to `Job.log`; on exception marks stage+job+deployment+agent failed (line 160-166, `_finish` 183-202).
- On success `_finish` sets `agent.status="active"` (line 190-194).
- `resume_pending_jobs()` (line 211-225) re-runs interrupted deploy jobs at startup (called from `main.py:69`).

### Ledger data model: `backend/app/models/ledger.py` (SQLite at `data/launchpad.db`)

- **Agent** (line 25-45): `id` (uuid hex), `name`, `method` (`harness|zip_runtime|container|studio`, line 32), **`status` state machine: `draft | deploying | active | failed | deleted`** (line 33-34), `spec` (JSON — **stores full AgentSpec incl. studio `code`**), `resource_id` (AgentCore runtime/harness id), `arn`, `registry_record_id`, `version`, `owner` (default "river"), `error`, timestamps.
- **Deployment** (line 48-59): `id`, `agent_id`, `job_id`, `status` (`running|succeeded|failed`), `stages` (JSON list `[{name,status: pending|running|succeeded|skipped|failed, detail, started_at, ended_at}]`), timestamps.
- **Job** (line 114-127): `id`, `type`, `status` (`queued|running|succeeded|failed`), `payload` (JSON), `log` (JSONL, one event per line), `error`.
- Also: `ChatSession`, `ChatMessage` (per-agent chat history), `ApiKey`, `PolicyDecision`.
- DB: SQLite `sqlite:///data/launchpad.db` (`core/config.py:47`, engine in `core/db.py`); additive migrations, no Alembic (`db.py:44-65`).

### Studio / zip build: `backend/app/deployer/zip_runtime.py`

- **Registers BOTH methods with identical STAGES** (line 219-220):
  ```
  register_method("zip_runtime", STAGES)
  register_method("studio", STAGES)  # studio agents ride the same zip fast path
  ```
- **generate** (`_stage_generate` 106-113 → `_generate_code` 86-92): if `spec.method=="studio" and spec.code` → `adapt_studio_code(spec.code)`; else `render_main_py(spec)` (strands template). Requirements via `_method_requirements` (101-103): base template reqs + (`strands-agents-tools[mem0_memory]` for studio, line 95-98) + `spec.requirements`.
- **package** (`_stage_package` 116-135): `build_zip()` (43-83) pip-installs ARM64 wheels (`--platform manylinux2014_aarch64 --only-binary=:all: --python-version 3.13`) into `/tmp/launchpad_build_{name}`, writes `main.py` + `requirements.txt`, zips, uploads to `s3://{artifacts_bucket}/agents/{name}/deployment_package.zip` (line 131-132).
- **provision** (138-143): reuses shared `execution_role_arn` from config (CDK `launchpad-base`).
- **deploy** (146-202): `mode=="update"` + existing `resource_id` → `rt.update_code_runtime` (new version, same ARN); else `rt.create_code_runtime`. Then `rt.wait_runtime_ready` (poll GetAgentRuntime → READY, up to ~20 min). Injects `LAUNCHPAD_MEMORY_ID` env when memory enabled (line 157-160).
- **register** (205-208) → shared `register_stage`.
- `delete_agent_resources` (223-230): `rt.delete_runtime`.

### Runtime API wrappers: `backend/app/services/agentcore/runtime.py`

- `create_code_runtime` (16-40): `CreateAgentRuntime` with `codeConfiguration.code.s3`, `runtime="PYTHON_3_13"`, **`entryPoint=["opentelemetry-instrument","main.py"]`** (ADOT auto-instrumentation), `networkMode="PUBLIC"`.
- `update_code_runtime` (75-94): `UpdateAgentRuntime` — new version, same `agentRuntimeId`/ARN, DEFAULT endpoint auto-rolls.
- `wait_runtime_ready` (125-149): READY / CREATE_FAILED|UPDATE_FAILED terminal.
- `invoke_runtime_text` (152-174): `InvokeAgentRuntime`, payload `{"prompt","actor_id"}`, expects `{"result": ...}` back (matches the studio entrypoint wrapper).

### Studio code adaptation: `backend/app/templates/studio_agent/__init__.py`

- `adapt_studio_code(code)` (80-94): the platform contract for turning canvas output into an AgentCore module **without rewriting user code**:
  1. If code already has `@app.entrypoint` → use as-is.
  2. Else `_wrap_studio_module` (70-77): keep module verbatim, drop trailing `if __name__ == ...` argparse block, append `ENTRYPOINT_WRAPPER`.
  3. Inject `BUNDLE_SHIM` (`launchpad_config_bundle()`, line 17-29) unless code already reads `get_config_bundle`.
- `ENTRYPOINT_WRAPPER` (31-67): a `BedrockAgentCoreApp` `@app.entrypoint async def invoke(payload, context)` that reads `payload["prompt"]`, arity-probes `main()`, captures stdout, returns `{"result": text}` (or `{"error": ...}`).
- Documented in `docs/studio-integration.md`.

### Shared registration: `backend/app/deployer/registration.py` + `services/registry_console.py` + `services/agentcore/registry.py`

- `register_stage` (registration.py:8-19) → `register_agent_record(agent)` → sets `agent.registry_record_id`.
- `register_agent_record` (registry_console.py:32-56): builds an **A2A card** from the agent (name; description = `system_prompt[:180]`; `url=arn`; `version`; `metadata.launchpad.method`), `upsert_record(descriptor_type="A2A")`, and **auto-submits** new records (settle → submit → `PENDING_APPROVAL`).
- A2A card builder `build_a2a_card` (registry.py:22-37): `protocolVersion "0.3.0"`, `preferredTransport "JSONRPC"`, `capabilities.streaming`.

#### Registry record state machine (registry.py:5-8, 204-240) — canonical

```
create_registry_record → CREATING/UPDATING ──(settle)──▶ DRAFT
DRAFT ──submit_registry_record_for_approval──▶ PENDING_APPROVAL   (UI chip: SUBMITTED)
PENDING_APPROVAL ──approve (status=APPROVED)──▶ APPROVED          (UI chip: PUBLISHED — live/consumable/attachable)
PENDING_APPROVAL ──reject  (status=REJECTED)──▶ REJECTED          (recoverable: later APPROVED accepted, line 232-236)
APPROVED ──disable (status=DEPRECATED)──▶ DEPRECATED              (TERMINAL — service refuses further status change; only delete, line 224-229)
any ──delete_registry_record──▶ (gone)
```
- NB the API enum has **no PUBLISHED**; platform maps APPROVED→"PUBLISHED" in UI (registry.py:5-8).
- `attachable_records()` (registry_console.py:193-243): the create-wizard catalog is sourced **ONLY from APPROVED** MCP + AGENT_SKILLS records — the registry lifecycle is the availability gate.

### Router wiring: `backend/app/main.py`

- `import app.deployer.zip_runtime  # registers zip_runtime + studio methods` (line 10); container + harness likewise (line 8-9).
- Routers included (line 57-67): overview, **agents**, tools, **registry**, **chat**, governance, observability, **evaluation**, experiments (optimization), apikeys, public (`/v1`).

### Registry router: `backend/app/routers/registry.py` (prefix `/api/registry`)

`GET /records` (33), `GET /records/search?q` (39), `GET /records/{id}` (44), `POST /records/{id}/action` (53, `{action: submit|approve|publish|reject|disable}`), `POST /records` (73, MCP/AGENT_SKILLS only — A2A rejected by design), `DELETE /records/{id}` (92), `GET /attachables?refresh` (98, 60 s cache), `POST /sync-defaults` (113). `_record_out` shape at line 18-30.

---

## 3. How Chat / Evaluation / Experiment identify an agent

**All key off the ledger `agent_id` (Agent.id PK), then use `agent.arn` / `agent.resource_id`.** So any agent created via the normal pipeline (incl. `method="studio"`) that reaches `status="active"` is automatically usable.

- **Chat** — `POST /api/chat/{agent_id}` (`routers/chat.py:66`); `_get_active_agent` requires `status=="active"` + `arn` (line 27-33). Sessions/history/memory endpoints also keyed on `agent_id` (line 109,148,173). Frontend `Chat.tsx` selects via `?agent=<id>` query param or first active agent (`Chat.tsx:92,113,122`); `CreateAgent` links `/chat?agent={id}` (`CreateAgent.tsx:699`).
- **Invoke chain** — `services/invoke.py:16-31`: dispatch by method — `harness`→`invoke_harness_text`; **`zip_runtime|studio|container`→`invoke_runtime_text`** (line 23). Uses `agent.arn`. Chat + `/v1` public API share this single entry point.
- **Evaluation** — `RunCreate.agent_id` (`evaluation/routers.py:446`); `create_run` requires `agent.status=="active"` (line 493). `resolve_telemetry(agent)` (`evaluation/service.py:38-53`) requires `method ∈ EVAL_SUPPORTED_METHODS = {"zip_runtime","studio","container"}` (line 35) and `resource_id`; derives `service_name = "{runtime_name}.DEFAULT"` + CloudWatch log group. **Managed-harness agents are excluded** from batch eval (no span service name).
- **Experiments (optimization)** — requires `agent.method ∈ ("zip_runtime","studio","container")` (`optimization/routers.py:67`); `EvaluationExperiment.tsx:168` mirrors this ("runtime-backed agents").
- **Observability** — trace/session views map by service.name (runtime name); studio agents emit ADOT traces via the `opentelemetry-instrument` entrypoint, so they appear automatically.

**Conclusion:** a canvas-created `method="studio"` agent gets chat + evaluation + experiment + observability with zero extra wiring.

---

## 4. Where agent source artifacts live

- **Generated Python code** is NOT kept per-agent on disk long-term: built in ephemeral `/tmp/launchpad_build_{name}` (`zip_runtime.py:125`), uploaded to **S3** `s3://{artifacts_bucket}/agents/{name}/deployment_package.zip` (`zip_runtime.py:131-132`).
- **The spec — including the studio `code` string — IS persisted in the ledger DB** (`Agent.spec` JSON column, `ledger.py:35`). Re-publish reads it back via `AgentSpec(**agent.spec)` (`zip_runtime.py:107,121`; redeploy overwrites `agent.spec` in `routers/agents.py:172`). So **editing/re-publishing a studio agent later is already possible** as long as the canvas re-submits the generated `code` (or the platform reloads `spec.code`).
- The external studio app keeps its own `flow.json` / `generate.py` artifacts in its separate backend storage (`apps/studio/backend/storage/...`, see `apps/studio/CLAUDE.md`) — that is NOT the platform ledger.
- **Design implication**: to support editing a canvas agent, the *flow graph* (node/edge JSON) must be persisted somewhere the platform can reload. `Agent.spec` currently stores only the generated `code`, not the source graph. A native canvas would need to decide where to store the graph (e.g. an added `spec.studio_flow` field, or a new column/table).

---

## 5. Frontend conventions (for adding a native canvas page)

- **Routing**: `react-router-dom` v6, `BrowserRouter` + `Routes/Route` under a `Shell` layout with `<Outlet/>` (`frontend/src/App.tsx`, `layout/Shell.tsx`). Adding a page = add a `<Route path="…"/>` in `App.tsx` + a `NavEntry` in `layout/nav.ts` (7 entries idx 01-07; `PLATFORM_COUNT=4`) + i18n keys under `nav.*`.
- **i18n**: `i18next` + `react-i18next` + `LanguageDetector` (`i18n.ts`); locales `en` and `zh-CN` at `frontend/src/locales/{lng}/common.json`. Top keys include `create`, `registry`, `chat`, `evaluation`, etc.; existing `create.methods.studio.*` keys already describe the studio card. **Parity rule**: both languages required — the ONLY declared exception is the vendored studio UI (`docs/studio-integration.md` §i18n).
- **Theme**: dark palette via CSS custom properties in `frontend/src/theme/tokens.css` (brand amber `#FFB000` chrome-only, series colors `--s1..--s5`, fonts Archivo + IBM Plex Mono). Class-based styling in `theme/app.css` (~32 KB) — classes like `.panel`, `.steps`/`.step`, `.methods`/`.method`, `.cfg-grid`, `.selchip`, `.pipeline`/`.pstage`, `.code`, `.reg-grid`, `.drawer`.
- **Shared components** (`frontend/src/components/index.ts`): `Btn`, `Chip` (+`ChipTone`), `ConfirmDialog`, `ToastProvider`/`useToast`, `DataTable` (+`Column`), `Kicker`, `Panel`, `StatTile`, `ViewHead`. Reuse these for a native canvas page's chrome.
- **Backend transport**: Vite dev proxy `/api → http://localhost:8000` (`frontend/vite.config.ts`); frontend calls relative `/api/*`. Typed client `frontend/src/lib/api.ts` (`api.createAgent`, `redeployAgent`, `getAgent`, `getJob`, `listAgents`, `deleteAgent`, plus obs endpoints). **`AgentSpecInput` (api.ts:54-62) lacks `code`/`requirements`/`env`** — extend it (and `api.createAgent`) or use raw `fetch` like `apps/studio/src/lib/launchpad-client.ts`.
- **Platform frontend deps** (`frontend/package.json`): React 18.3, react-router 6.30, i18next only — **no XYFlow, no Monaco, no state library, no Tailwind** (platform uses hand-rolled CSS). The external studio app DOES use XYFlow/React + Monaco + Tailwind + shadcn/ui.

### Existing external studio app (reference for the canvas) — `apps/studio/`

- Deploy contract client `apps/studio/src/lib/launchpad-client.ts`: `deployToLaunchpad(name, code, requirements)` POSTs to `/launchpad-api/agents` (proxied to platform `:8000/api`) with body `{name, method:"studio", system_prompt:"Strands Studio generated agent", code, requirements, memory:{short_term:false,long_term:false}}` (line 25-53); then polls `getLaunchpadAgent`/`getLaunchpadJob`.
- Deploy UI `apps/studio/src/components/launchpad-deploy-section.tsx`: name input + Deploy button + live 4 s job-event poll.
- Canvas internals (from `apps/studio/CLAUDE.md`): XYFlow flow editor (`flow-editor.tsx`), node types (Agent, Orchestrator, Input, Output, builtin Tool, Custom Tool, MCP Tool), Graph Mode (DAG via `GraphBuilder`), code generation in `src/lib/code-generator.ts` (~57 KB) and `graph-code-generator.ts`, validators `connection-validator.ts` / `graph-validator.ts`, Monaco code panel. These are the artifacts a **native** port would reimplement/reuse to produce the `code` string.
- Ports (`docs/studio-integration.md` §Running locally): platform backend 8000, platform UI 5173, studio backend 8100, studio UI 5273.

---

## Caveats / Not found

- **No existing native canvas page** in `frontend/src/pages/` — the canvas is entirely the external `apps/studio/` app today. Building a native one is net-new frontend; the backend `method="studio"` path is the only piece already done.
- **Flow-graph persistence for edit/re-publish is unresolved**: `Agent.spec` stores generated `code`, not the source node/edge graph. Deciding where to store the graph (so a canvas can reload it) is an open design question — flagged, not prescribed.
- I did not exhaustively read the harness (`deployer/harness.py`) or container (`deployer/container.py`) stage internals — they are alternate methods not used by studio; only their existence and delete hooks (`routers/agents.py:69-77`) were confirmed. If design.md needs their exact CodeBuild/harness API calls, read those two files.
- `apps/studio/src/lib/code-generator.ts` (57 KB) was not read line-by-line; the flow→Strands-code mapping detail lives there and in `graph-code-generator.ts` if a native port must match output shape.
- Verify the exact vite dev port at design time (memory notes it floats 5173/5174 for the platform UI).
