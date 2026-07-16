# Architecture / 架构

AgentCore Launchpad is a thin, opinionated platform layer over Amazon Bedrock
AgentCore. Every feature in the console maps to a real AgentCore service and a
real resource in your account — the platform's job is to give those services a
unified create → deploy → invoke → observe experience, not to reimplement them.

中文版: [architecture.zh-CN.md](architecture.zh-CN.md)

## System diagram

```
 Browser
 ┌─────────────────────────────┐        ┌──────────────────────────┐
 │ Platform console  :5173     │        │ Strands Studio UI  :5273 │
 │  Overview · Create · Chat   │        │  drag-and-drop canvas    │
 │  Registry · Governance ·    │        │  (方式C, vendored)       │
 │  Evaluation                 │        └────────────┬─────────────┘
 └──────────────┬──────────────┘            /api,/ws │  /launchpad-api
                │ /api  /v1                           │  (→ platform /api)
                ▼                                     ▼
 ┌─────────────────────────────┐        ┌──────────────────────────┐
 │ Platform backend  :8000     │◀───────│ Studio backend    :8100  │
 │  FastAPI                    │ deploy  │  FastAPI (local run,     │
 │  · deploy pipeline          │ via     │  chat, exec history)     │
 │  · invoke chain (/api,/v1)  │ pipeline└──────────────────────────┘
 │  · SQLite ledger (data/)    │
 └──────────────┬──────────────┘
                │ boto3 (bedrock-agentcore control + data planes)
                ▼
 ┌───────────────────────────────────────────────────────────────┐
 │ AWS · us-west-2                                                 │
 │  AgentCore: Runtime · Harness · Memory · Gateway · Identity ·   │
 │             Registry · Policy(Cedar) · Evaluation/Optimization  │
 │  Shared infra (CDK launchpad-base): S3 · ECR · CodeBuild ·      │
 │             Cognito · IAM exec role · HR Lambda · Facts API     │
 │  Observability: CloudWatch Transaction Search (aws/spans)       │
 └───────────────────────────────────────────────────────────────┘
```

## The four-layer mapping (from prompt.md)

The brief organizes AgentCore capabilities into four layers; each is backed by
real, runnable code in this repo.

| Layer | Platform surface | AgentCore services |
|---|---|---|
| **1. Build Core** | Create Agent (方式A/B/C), unified pipeline, Chat memory | Runtime, Harness, Memory |
| **2. Build Tools** | Tool catalog, builtin-tool demos | Gateway (REST + Lambda → MCP), Builtin Tools (Code Interpreter, Browser) |
| **3. Governance** | Governance page, Registry console, trace rail | Observability (Transaction Search), Registry, Policy (Cedar) |
| **4. Evaluation & Optimization** | Evaluation page, Experiments (`?view=experiment` sub-page: stage pipeline + verdict semantics) | Evaluation (batch + online, LLM-judge, insights), Optimization (config bundles, A/B, canary) |

## Platform ↔ AgentCore service mapping

| AgentCore service | How the platform uses it |
|---|---|
| **Runtime** | Hosts zip and container agents (`CreateAgentRuntime`); the invoke chain calls the runtime data plane. |
| **Harness** | Hosts 方式B agents (`CreateHarness`) — a managed entrypoint with no build artifact. |
| **Memory** | One shared `launchpad_memory` singleton: short-term session events + long-term semantic & user-preference strategies. Namespaces are keyed only on `{actorId}` (there is no `{agentId}` template), so the platform folds the agent id into the actor — `scoped_actor(agent_id, human)` → `<agent>__<human>` — which partitions **both** short-term events and long-term records (`/facts/<agent>__<human>`) per agent. Generated Strands runtimes restore short-term turns through `AgentCoreMemorySessionManager`. Claude Agent SDK containers create one request-local `MemorySessionManager`, inject bounded short-term turns plus `/facts/<actor>` and `/preferences/<actor>` records through a `UserPromptSubmit` hook, then persist the successful USER/ASSISTANT pair as one event. A2A runtimes use `<agent>__a2a__<contextId>` because direct A2A currently has no authenticated human actor envelope. One agent's learned facts never bleed into another's for the same person or A2A context; the ledger still stores the bare human actor for display. |
| **Gateway** | `launchpad-gw` turns a REST API (office-facts) and a Lambda (hr-database) into MCP tools with Cognito-JWT auth; agent tool calls flow through it. |
| **Identity** | Token vault backing the gateway — an OAuth2 provider (agent outbound auth) and an API-key provider. |
| **Registry** | `launchpad-registry` catalogues three descriptor types: A2A (agents), MCP (tools), AGENT_SKILLS (skills). Every deploy auto-creates and submits an A2A record. The console also registers records by hand — external remote MCP servers (streamable-http URL) and skills (SKILL.md → artifacts bucket) — and drives the full lifecycle: submit → approve/reject (a REJECTED record can still be approved), deprecate (terminal — verified live; only delete remains), delete. The registry doubles as the **mount catalog**: `GET /api/registry/attachables` serves only APPROVED MCP/skill records to the create wizard, where MCP records split on URL — the shared gateway attaches as `agentcore_gateway` (OAuth), any other URL as `remote_mcp` (unauthenticated for now) — and skills attach via their s3 `skills[{path}]`. |
| **Policy** | A Cedar policy engine attached to the gateway in `ENFORCE` mode; deny decisions carry the deciding policy id. Supports NL → Cedar policy generation. |
| **Evaluation** | Real `StartBatchEvaluation` / insights over CloudWatch traces. A run's scope is exactly one of: a **dataset** (replay items — multi-turn scenarios replay sequentially in one session), explicit **session ids**, or a **time window** (`lookback_hours` 1–336 — passive: no new invocations, `filterConfig.timeRange` over existing traffic). 13 general built-in evaluators plus the 3 ground-truth-only `Builtin.Trajectory*Match` matchers (selectable only on dataset runs whose scenarios define `expected_trajectory`) plus custom LLM-as-a-judge evaluators with full CRUD — create/edit (UpdateEvaluator is a full-config replace) on the `?view=evaluators` sub-page. Insights runs pick a subset of the three analysis types (failure analysis / user intent / execution summary). Datasets live in SQLite as devguide scenarios (`?view=datasets` sub-page: scenario editor, JSON/JSONL import) and sync one-way to immutable AWS Dataset resources (`AGENTCORE_EVALUATION_PREDEFINED_V1`); scenario ground truth (assertions / expected responses / expected trajectory) is injected into batch runs via `evaluationMetadata.sessionMetadata`. One batch per account — queue managed, unchanged. |
| **Optimization** | Recommendations → configuration bundles → gateway A/B (config-bundle 50/50) → target-based canary → verdict → promote → cleanup. |
| **Observability** | CloudWatch Transaction Search (X-Ray trace segment destination → CloudWatch Logs). Traces are read from the `aws/spans` log group and rendered as a per-session rail. |
| **Builtin Tools** | Code Interpreter (`aws.codeinterpreter.v1`) and Browser (`aws.browser.v1`) each have a live demo endpoint. |

## The unified five-stage deploy pipeline

All three creation methods converge into the same ordered stages, defined in
`backend/app/deployer/pipeline.py`:

```
generate → package → provision → deploy → register
```

Each method contributes one callable per stage (or omits it to skip). Stage
progress is persisted on the `Deployment` row and mirrored as JSONL events into
the `Job` log, so a restarted backend resumes from the first non-succeeded
stage (`resume_pending_jobs()` runs on startup).

| Stage | 方式B — harness | zip_runtime / 方式C — studio | 方式A — container |
|---|---|---|---|
| **generate** | Build `CreateHarness` request from the AgentSpec | Render the Strands template (studio: adapt user code verbatim) | Assemble ARM64 build context (Dockerfile + `main.py` + `.claude` scaffold) |
| **package** | *skipped* (no artifact) | `pip install` ARM64 wheels → zip → S3 | zip context → S3 → CodeBuild (docker build+push) → ECR |
| **provision** | Reuse the shared execution role | Reuse the shared execution role | Reuse the shared execution role |
| **deploy** | `CreateHarness` + poll READY | `CreateAgentRuntime` + poll READY | `CreateAgentRuntime(containerConfiguration)` + poll READY |
| **register** | A2A registry record, auto-submitted | A2A registry record, auto-submitted | A2A registry record, auto-submitted |

Typical timings: harness ≈ 30 s, zip ≈ 1–3 min (incl. pip), container ≈ 2–4 min (observed: 1.7 min CodeBuild + seconds to READY)
(via CodeBuild). See [troubleshooting.md](troubleshooting.md).

## The invoke chain

The Chat playground (`/api/chat/{id}`) and the public API
(`/v1/agents/{id}/invoke` + `/invoke-stream`) share **one** entry point,
`app.services.invoke.invoke_agent_text` (and `app.services.chat.chat_stream` for
SSE), so both entrances behave identically:

```
console /api  ─┐
               ├─▶ invoke_agent_text / chat_stream
public  /v1  ──┘        │
                        ├─ method dispatch:
                        │    harness            → harness data client
                        │    zip/studio/container → runtime data client
                        ▼
             AgentCore Runtime / Harness
                        │  (session isolation, streaming)
                        ├─ Memory        (session context read/write)
                        ├─ Gateway tools (MCP over Cognito JWT)
                        ├─ Policy        (Cedar ENFORCE at the gateway)
                        └─ Observability (spans → CloudWatch Transaction Search)
```

The public `/v1` surface adds `X-Api-Key` auth (keys stored sha256-hashed);
everything downstream of the dispatch is identical to the console path.

## Console authentication

The platform console has an optional local operator gate, independent from both
the Cognito users used by Gateway/Cedar demos and the `/v1` API-key surface.
Setting `LAUNCHPAD_AUTH_PASSWORD` enables it; the username defaults to `admin`
and can be changed with `LAUNCHPAD_AUTH_USERNAME`. No AWS call or ledger row is
involved.

`POST /api/auth/login` verifies the configured credentials and issues a
12-hour, HMAC-signed HttpOnly cookie. The cookie is stateless, so it survives a
backend restart; changing the credentials and restarting invalidates all
existing sessions. When enabled, middleware protects every `/api/*` route,
including API docs, except `/api/health`, `/api/auth/status`, and
`/api/auth/login`. The middleware does not guard `/v1/*`, whose existing
`X-Api-Key` contract remains authoritative.

The default cookie works with the local HTTP stack. HTTPS deployments must set
`LAUNCHPAD_AUTH_COOKIE_SECURE=true`. Leaving the password unset disables the
gate, preserving the bootstrap-free local development and test flow.

## The Observability module (console 05)

`/observability` is a read-only telemetry console over three data sources
(`backend/app/services/observability.py`, endpoints under
`/api/observability/*`):

| Source | Used for | How |
|---|---|---|
| `aws/spans` log group (CloudWatch Transaction Search) | trace/session lists, dashboard counts + p50/p95 + hourly series, top tools, span trees | Logs Insights `start_query`, one bounded query set per view |
| `bedrock-agentcore` metrics namespace | tokens-by-model tile + chart | `ListMetrics` (dimension discovery) → `GetMetricData` sums of `gen_ai.client.token.usage` |
| AgentCore Memory `ListEvents` | session conversation transcript | ChatSession-ledger join (`session_id → actor_id`); harness message envelopes are decoded, tool-result turns dropped |

Every view is served from a **60-second TTL cache** keyed by (view, range) —
Logs Insights is billed per scan — with `force=true` (the ⟳ REFRESH button)
bypassing it. Ranges are whitelisted (`1h/6h/24h/7d`); trace ids
(`^[0-9a-f]{32}$`) and session ids (`^[A-Za-z0-9_-]{8,128}$`) are validated at
the router **and** re-checked in the query builders before being interpolated
into Logs Insights query strings. Token sums count only terminal LLM
operations (`chat` / `text_completion` / `generate_content`) because
agent-level `invoke_agent` spans repeat their children's `gen_ai.usage.*`
values.

Cost figures are **advisory estimates**: token counts × `model_prices` from
`config/launchpad.yaml` (USD per 1M tokens, substring-matched against
`gen_ai.request.model`; unknown models show token counts with a `—` cost). The
UI labels them `≈ / EST`. The price map is kept fresh from litellm's public
price file (`app/services/model_prices.py`): a daily daemon plus the dashboard's
`⟳ UPDATE PRICES` button (`POST /api/observability/prices/refresh`) pull exact
per-model entries — including regional Bedrock premiums and cache read/write
rates — for every model seen in the account's telemetry, refresh the operator's
short fallback keys, and leave unmatched keys untouched. Source URL and
interval are configurable (`model_prices_source_url`,
`model_prices_refresh_hours`; `0` disables the daemon).

**Telemetry per creation method:** Strands (zip/studio) and harness agents emit
gen_ai spans natively. Claude Agent SDK containers drive the `claude` CLI as a
subprocess — invisible to ADOT auto-instrumentation — so the generated agent
emits the telemetry manually (`app/templates/claude_sdk_agent/tracing.py`,
adapted from the agentxray demo-agent): an `invoke_agent` root span, one
`execute_tool` span per tool call, one aggregate `chat` span carrying the
query's token usage (`ResultMessage.usage`; the SDK's `cache_creation` maps to
`cache_write`), and Strands-shaped content events for the span drawer's
input/output messages. The scope name must stay `strands.telemetry.tracer` —
AgentCore only parses spans/events from supported instrumentation scopes.

Tab IA: **DASHBOARD** (5 stat tiles + traffic/latency/tokens/tools charts) ·
**SESSIONS** (list → detail with memory transcript + traces-in-session cards) ·
**TRACES** (filterable list → waterfall Gantt with span drawer: token usage
incl. cache read/write, est cost, tool schema, raw attributes). Cross-links:
deep links `/observability?trace=<id>` / `?session=<id>`; the Chat trace rail
links to the current session's detail (`OPEN IN OBSERVABILITY ↗`) and session
detail links back (`OPEN IN CHAT ↗`); `service.name` values are mapped to
platform agent names via the ledger (`resource_id` base-name match, raw name
fallback).

## The SQLite ledger and job/event model

State that is cheap and local lives in a SQLite ledger at `data/launchpad.db`
(`backend/app/models/ledger.py` + the evaluation/optimization models):

| Table | Holds |
|---|---|
| `agents` | Agent records — name, method, status, ARN, resource id, registry record id, version, spec |
| `deployments` | One row per deploy run — the five-stage array with per-stage status/detail/timestamps |
| `jobs` | Async work (type `deploy_agent`) — status + a JSONL `log` of stage events |
| `chat_sessions` | Chat playground sessions — turns, actor, last-seen |
| `api_keys` | Public-API keys — sha256 hash + prefix (plaintext never stored) |
| `policy_decisions` | Governance decision log — principal, tool, ALLOW/DENY, reason |
| `eval_datasets` / `eval_runs` | Evaluation datasets (legacy prompts or devguide scenarios + description + last AWS-sync blob) and run state (scores or insight trees; window runs encode their scope as `dataset_name="window:<N>h"`) |
| `experiments` | Optimization loop — stage + per-stage artifacts, resumable |

**Job/event model.** Creating an agent returns `202` with a `job_id`. The
deploy job runs on a background thread, appending one JSONL event per stage
transition to `Job.log`; `GET /api/jobs/{id}` returns those events and
`GET /api/agents/{id}` returns the `Deployment.stages` array. The agent moves
`deploying → active` (or `failed`) as the job finishes. Authoritative resource
state (runtime status, registry record status, eval/trace data) always lives in
AWS; the ledger holds identifiers and derived progress only.

## Local process topology

`./start.py` starts the two platform processes, waits for every HTTP health
check, and records process ownership plus logs under `.run/`. `./stop.sh`
gracefully stops only those recorded process groups. The default uses
development servers; `./start.py --prod` builds the platform frontend and
serves its production bundle without backend auto-reload. `bash scripts/dev.sh`
(`make dev`) remains the foreground, terminal-attached alternative.

| Service | Port | Override |
|---|---|---|
| platform backend | 8000 | `PLATFORM_API_PORT` |
| platform frontend | 5173 | `PLATFORM_UI_PORT` |

The lifecycle script fails fast when a configured port is occupied. Development
mode binds both services to loopback by default; production mode binds both
services to `0.0.0.0`. `LAUNCHPAD_HOST` and `LAUNCHPAD_API_HOST` override those
bindings.

The standalone app under `apps/studio/` is not started by the root lifecycle.
The platform console provides the supported native canvas at `/create/studio`.
See [studio-integration.md](studio-integration.md).
