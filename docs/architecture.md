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
| **4. Evaluation & Optimization** | Evaluation page, Experiments | Evaluation (batch + online, LLM-judge, insights), Optimization (config bundles, A/B, canary) |

## Platform ↔ AgentCore service mapping

| AgentCore service | How the platform uses it |
|---|---|
| **Runtime** | Hosts zip and container agents (`CreateAgentRuntime`); the invoke chain calls the runtime data plane. |
| **Harness** | Hosts 方式B agents (`CreateHarness`) — a managed entrypoint with no build artifact. |
| **Memory** | One shared `launchpad_memory` singleton: short-term session events + long-term semantic & user-preference strategies. Managed-harness agents extract preferences to `/preferences/{actor}` and auto-retrieve them in new sessions. |
| **Gateway** | `launchpad-gw` turns a REST API (office-facts) and a Lambda (hr-database) into MCP tools with Cognito-JWT auth; agent tool calls flow through it. |
| **Identity** | Token vault backing the gateway — an OAuth2 provider (agent outbound auth) and an API-key provider. |
| **Registry** | `launchpad-registry` catalogues three descriptor types: A2A (agents), MCP (tools), AGENT_SKILLS (skills). Every deploy auto-creates and submits an A2A record. |
| **Policy** | A Cedar policy engine attached to the gateway in `ENFORCE` mode; deny decisions carry the deciding policy id. Supports NL → Cedar policy generation. |
| **Evaluation** | Real `StartBatchEvaluation` / insights over CloudWatch traces, scoped to the sessions a run produced. 13 built-in evaluators plus custom LLM-as-a-judge. |
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
| `eval_datasets` / `eval_runs` | Evaluation datasets and run state (scores or insight trees) |
| `experiments` | Optimization loop — stage + per-stage artifacts, resumable |

**Job/event model.** Creating an agent returns `202` with a `job_id`. The
deploy job runs on a background thread, appending one JSONL event per stage
transition to `Job.log`; `GET /api/jobs/{id}` returns those events and
`GET /api/agents/{id}` returns the `Deployment.stages` array. The agent moves
`deploying → active` (or `failed`) as the job finishes. Authoritative resource
state (runtime status, registry record status, eval/trace data) always lives in
AWS; the ledger holds identifiers and derived progress only.

## Local process topology

`bash scripts/dev.sh` (`make dev`) starts up to four processes; ports are
overridable via environment variables.

| Service | Port | Override |
|---|---|---|
| platform backend | 8000 | `PLATFORM_API_PORT` |
| platform frontend | 5173 (auto-shifts if taken) | `PLATFORM_UI_PORT` |
| studio backend | 8100 | `STUDIO_API_PORT` |
| studio frontend | 5273 | `STUDIO_UI_PORT` |

Studio's Launchpad deploy section proxies `/launchpad-api` to the platform
backend's `/api`, so studio-created agents ride the same pipeline, ledger and
registry. See [studio-integration.md](studio-integration.md).
