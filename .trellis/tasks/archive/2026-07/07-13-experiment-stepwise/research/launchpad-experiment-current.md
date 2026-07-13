# Research: Current Launchpad Experiment / Optimization Implementation

- **Query**: Document the current experiment/optimization pipeline (backend + frontend + tests + specs) to prepare a refactor from auto-pipeline → step-by-step user-driven flow.
- **Scope**: internal
- **Date**: 2026-07-13

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/app/optimization/models.py` | `Experiment` SQLAlchemy model + `STAGES` list |
| `backend/app/optimization/routers.py` | `/api/experiments` API: list/get/create/action |
| `backend/app/optimization/service.py` | Orchestration: auto loop thread, stage impls, explicit actions, idempotent helpers |
| `backend/app/evaluation/agentcore_eval.py` | AWS helper functions (recommendation, bundles, A/B variants, normalize, cleanup) |
| `backend/app/services/agentcore/client.py` | boto3 client factories: `control_client()`=`bedrock-agentcore-control`, `data_client()`=`bedrock-agentcore` |
| `backend/app/main.py:17,75` | Router registration (`experiments_router`) |
| `backend/scripts/e2e_experiment.py` | E2E demo script driving the full loop against real AWS |
| `backend/tests/optimization/test_experiments_crud.py` | CRUD + gateway-traffic tests |
| `backend/tests/optimization/test_bundles_abtest_shape.py` | Bundle/variant/normalize payload-shape tests |
| `backend/tests/optimization/test_weights_and_cleanup.py` | Weights ramp + cleanup + verdict tests |
| `frontend/src/pages/EvaluationExperiment.tsx` | The experiment sub-page (`ExperimentView`) |
| `frontend/src/pages/Evaluation.tsx:12,416-418,782-785` | Mounts `ExperimentView` at `?view=experiment`; dashboard entry button |
| `frontend/src/locales/en/common.json` | `expPage.*` + `evalPage.experiment.*` i18n keys |
| `frontend/src/locales/zh-CN/common.json` | zh-CN mirror (key parity confirmed) |

---

### 1. Backend optimization module

#### `Experiment` model (`models.py`)

Columns: `id` (12-hex), `name` (`EXP-<agent name[:20]>`), `agent_id` (indexed), `agent_name`,
`status`, `stage`, `artifacts` (JSON dict keyed by stage name), `error` (Text), `created_at`,
`updated_at` (onupdate).

- **status** state machine (comment `models.py:34`): `running | ready` (verdict done) `| promoted | cleaned | failed`
- **stage** default `"recommend"`.
- **STAGES** (`models.py:12`): `["recommend","bundles","gateway","abtest","traffic","verdict","promote","canary","ramp","cleanup"]` — the frontend duplicates this as `LOOP_STAGES` (`EvaluationExperiment.tsx:50`).
- `artifacts` is a per-stage dict; `_update(..., artifact={...})` (`service.py:47`) **merges** into existing artifacts (does not overwrite the whole dict).

#### `artifacts` JSON shape per stage (what each stage persists)

| Stage | Artifact key | Shape (persisted by `_update(artifact=…)`) |
|---|---|---|
| recommend | `recommend` | `{system_prompt_status, recommended_prompt (≤4000), explanation (≤600), tool_descriptions:{name:desc} or {_error}}` (`service.py:127-132`) |
| bundles | `bundles` | `{control:{bundle_id,arn,version}, treatment:{bundle_id,arn,version}}` (`service.py:163-174`) |
| gateway | `gateway` | `{gateway_id, gateway_arn, gateway_url, target_v1, target_id_v1, online_eval_arn, online_eval_id}` (`service.py:277-285`) |
| abtest | `abtest` | `{ab_test_id, variants}` (`service.py:315`) |
| traffic | `traffic` | `{session_ids[], sent, failed}` (`service.py:353`) |
| verdict | `verdict` | `{metrics:[ABMetric], verdict, avg_delta?, n?, significant?, reason?}` (`service.py:424-425` + `compute_verdict`) — also sets `status="ready"` |
| promote | `promote` | `{before_weights:{name:w}, after_weights:{name:w}}` (`service.py:498-503`) — sets `status="promoted"`, `stage="promote"` |
| canary | `canary` | `{canary_ab_test_id, target_v2, target_id_v2, online_eval_id_v2, challenger_agent, weights:{C,T1}, ramp_stage:0}` (`service.py:558-567`) — sets `stage="canary"` |
| ramp | `canary` (overwritten) | prior canary dict + `{ramp_stage, before_weights, after_weights}` (`service.py:588-594`) — sets `stage="ramp"` |
| cleanup | `cleanup` | `[{category, status, detail}]` (`service.py:632-634`) — sets `status="cleaned"`, `stage="cleanup"` |

#### The auto-stage background thread

`start_experiment(agent_row)` (`service.py:430`): resolves runtime name via `rt_name()`, inserts the `Experiment` row (committing to get `id`), then spawns a **daemon `threading.Thread`** running `run_experiment_loop(exp_id, agent)` and returns the fresh row.

`run_experiment_loop` (`service.py:389-428`) drives the 6 auto stages sequentially inside **one big `try/except`**:
1. `stage="recommend"` → `stage_recommend()` → persist `recommend`
2. `stage="bundles"` → `stage_bundles(..., rec["recommended_prompt"])` → persist `bundles`
3. `stage="gateway"` → `stage_gateway()` → persist `gateway`
4. `stage="abtest"` → `stage_abtest(gateway, bundles)` → persist `abtest`
5. `stage="traffic"` → `send_gateway_traffic(gateway_url, target_v1, TRAFFIC_PROMPTS*2)` → persist `traffic`
6. `stage="verdict"` → poll loop: `deadline = now+900s`, every 45s call `ac.get_ab_test` + `normalize_ab_results`; break once `compute_verdict` ≠ `insufficient-data`; then persist verdict and set `status="ready"`.

**Error handling:** any exception in the whole loop → `_update(status="failed", error="<Type>: <msg>"[:500])`. There is **no per-stage retry and no resume-from-stage** — a failure aborts the entire loop; the only recovery is `cleanup` or a brand-new experiment. (The idempotent helpers below make individual AWS *creates* safe to re-run, but nothing re-invokes the loop.)

What each stage does (AWS calls):
- **stage_recommend** (`service.py:72`): builds log-group ARNs (runtime log group + `aws/spans`) via `ac.to_log_group_arn`; calls `ac.start_system_prompt_recommendation` + `ac.poll_recommendation(max_polls=45)`; falls back to `_fallback_treatment_prompt(current)` if AWS returns nothing; then a best-effort `ac.start_tool_description_recommendation` (`max_polls=30`, wrapped in try/except → `{_error}`). Uses `data_client()`.
- **stage_bundles** (`service.py:143`): `ac.create_configuration_bundle` twice (control = current prompt, treatment = recommended prompt) with fixed `tool_descriptions={"calculator": …}`. Uses `control_client()`.
- **stage_gateway** (`service.py:238`): create/adopt gateway `launchpad-exp-gw` (`AWS_IAM` auth), wait READY (≤30×5s), create v1 runtime target (`create_runtime_target_idempotent`), create online-eval (`create_online_eval_idempotent`, evaluators `Builtin.GoalSuccessRate` + `Builtin.Helpfulness`, 100% sampling, 2-min session). Uses `control_client()`.
- **stage_abtest** (`service.py:288`): builds `config_bundle_variants` (50/50 C/T1), `ac.create_ab_test` (bundle-variant type, `enableOnCreate=True`, `onlineEvaluationConfigArn`), conflict → adopt from `list_ab_tests`. Uses `data_client()`.
- **traffic**: `send_gateway_traffic` (`service.py:318`) SigV4-signs (`bedrock-agentcore` service) each of `TRAFFIC_PROMPTS*2` (12 calc prompts) as `POST {gateway_url}/{target}/invocations`, collects session ids, counts failures. Injectable `poster`/`signer` for tests.
- **verdict**: `compute_verdict` (`service.py:356`) — honest small-n: `insufficient-data` (no metrics), `insufficient-n` (`total_n < min_n*2`, min_n=3 ⇒ <6), else `treatment-wins/control-wins/tie` by avg delta, plus `significant` if any variant `isSignificant`.

#### Explicit action endpoints (`routers.py:77-99`)

`POST /api/experiments/{exp_id}/action` with `ActionRequest{action: promote|canary|ramp|cleanup, challenger_agent_id?}`. Returns `{"result": <service return>}`. Each runs **synchronously in the request handler** (blocking — canary/ramp include pause-poll waits):
- `service.action_promote(exp)` (`service.py:484`): pause A/B, set variants to C=1/T1=99 (weight floor is 1), resume; status→`promoted`.
- `service.action_canary(exp, challenger)` (`service.py:506`): needs active challenger Agent row (router validates, 400 `experiment.challenger_required`); adds v2 target + v2 online-eval, STOPs the bundle A/B (only one test per gateway), creates a **new target-variant A/B test** (`exp_<id>_canary`, 90/10, `gatewayFilter` on target path, per-variant online-eval); conflict→adopt; `ramp_stage=0`.
- `service.action_ramp(exp)` (`service.py:574`): steps `RAMP_STEPS=[(90,10),(50,50),(1,99)]` by `ramp_stage+1` (clamped), pause/update/resume weights, overwrites `canary` artifact with new `ramp_stage`.
- `service.action_cleanup(exp)` (`service.py:598`): resolves ab-test ids, online-eval ids (**by live name prefix `exp_<id[:8]>_`**, not artifact id — tolerates stale ids), bundle ids, gateway + target ids; calls `ac.cleanup_resources` (per-category tolerant); status→`cleaned`.

#### Idempotency / resume

- `_is_conflict(exc)` (`service.py:43`): checks `type(exc).__name__ == "ConflictException"`.
- `create_runtime_target_idempotent` (`service.py:177`): create target → on conflict, look up by name in `list_gateway_targets`; then poll to READY (≤30×5s).
- `create_online_eval_idempotent` (`service.py:204`): create → on conflict, look up by name in `list_online_evaluation_configs`.
- gateway create (`service.py:242`) and both A/B creates use the same conflict-adopt pattern (adopt by name from list).
- **All AWS creates carry `clientToken=str(uuid.uuid4())`.** Resume of the *loop itself* does NOT exist — persistence survives restart (artifacts in SQLite) but no code re-drives an interrupted/failed loop from its last stage.

#### Polling / status endpoints used by the frontend

- `GET /api/experiments` (`routers.py:33`) → `{experiments:[…]}` (newest first, limit 20).
- `GET /api/experiments/{exp_id}` (`routers.py:39`) → single experiment.
- `_out(exp)` (`routers.py:18`) serializes: `id,name,agent_id,agent_name,status,stage,stages(=STAGES),artifacts,error,created_at`.
- **No dedicated progress/streaming endpoint** — the frontend polls `GET /api/experiments` every 8s.

#### Create endpoint (`routers.py:47-74`)

`POST /api/experiments` `{agent_id}` → 201 with `_out`. Guards:
- 409 `experiment.already_running` if any `status=="running"` exists (single shared gateway = one active A/B).
- 400 `agent.not_active` if agent missing/not active.
- 400 `experiment.method_unsupported` unless `method in {zip_runtime, studio, container}` (harness rejected).
- Then `service.start_experiment(agent)` (spawns the thread immediately — **AWS-mutating work starts at creation today**, which R1/A1 want to defer).

---

### 2. Frontend experiment page (`EvaluationExperiment.tsx`)

- **Entry/route**: `Evaluation.tsx:417-418` renders `<ExperimentView onBack=… />` when `?view=experiment`. Dashboard button (`Evaluation.tsx:782-785`, testid `experiment-btn`) sets `view=experiment`. Row/new selection via `?exp=<id>` / `?exp=new` (`EvaluationExperiment.tsx:184-192`).
- **Data fetching / polling**: `refresh()` (`:153`) does raw `fetch("/api/experiments")`; `setInterval` every **8000ms** (`:178`). Agents fetched once via `api.listAgents()` (`:165`) filtered to `status==="active" && method!=="harness"`. **The page uses raw `fetch` for experiments** and only `api.listAgents()` from `../lib/api` — there is no dedicated experiments API client module.
- **Selected experiment**: `exp = creatingNew ? null : (find by exp param ?? experiments[0] ?? null)` (`:187`).
- **Stage pipeline UI**: `StagePipeline` (`:82`) — 10-segment rail, done ✓ / current ◐(running)/●(ready) / future ·, ✕ on failure; per-current-stage hint from `evalPage.experiment.stageHint.<stage|ready>`; on failure shows `exp.error`. `data-testid="stage-pipeline"`, `stage-<name>` with `data-state`, `stage-hint`.
- **Terminal collapse**: `terminal = status in {cleaned, failed}` (`:211`) → read-only summary card (`exp-summary-card`, `exp-error`, `exp.error`, cleanup table, plus a `start-new` form). Non-terminal → live pipeline + metrics + verdict + canary + cleanup.
- **Metrics rendering** (`:488-554`): per-`verdict.metrics` `ab-metric` bars (CONTROL vs TREAT), n/p/significance line (`metric-stats`), `evaluatorLabel(t, metric.label)` from `../lib/evaluators`. `metrics-pending` while running with no metrics.
- **Verdict rendering** (`:556-668`): `verdictLabel()` neutralizes non-significant winners to `nonsig.title`; warn styling for insufficient/non-sig; `insufficient`/`nonsig` advisory notes with a1/a2/a3; `verdict-significance` testid.
- **Controls**:
  - **Promote** (`:595-624`): only when `status==="ready" && !artifacts.promote`. Strong evidence → primary button fires `onAction(exp.id,"promote")`; weak (insufficient/non-sig) → secondary `promote-btn` opening `confirmPromote` `ConfirmDialog`. After promote → PROMOTED chip w/ `after_weights.T1`.
  - **Canary** (`:670-728`, gated on `artifacts.promote`): if no `canaryWeights`, shows challenger `<select>` (excludes `exp.agent_id`) + START CANARY (`onAction(...,"canary",challengerId)`); else weight split bar + RAMP button (`ramp-btn`) while `ramp_stage < 2`.
  - **Cleanup** (`:730-746`): `cleanup-btn` → `confirmCleanup` `ConfirmDialog` → `onAction(...,"cleanup")`; cleanup result table.
- **Actions**: `onStart` (`:216`) raw `POST /api/experiments`; `onAction` (`:239`) raw `POST /api/experiments/{id}/action` with `{action, challenger_agent_id}`; both `void refresh()` after. `busy` state disables buttons (no per-action streaming progress — R3 gap).
- **"How a loop works" panel** (`:777-794`): lists 10 `LOOP_STAGES` from `evalPage.experiment.how.<stage>`.

#### API client functions

- `frontend/src/lib/api.ts` — `api.listAgents()` and `AgentInfo` type (the only api-module use). Everything experiment-specific is inline `fetch` (`/api/experiments`, `/api/experiments/{id}/action`). No `createExperiment`/`experimentAction` wrappers exist yet.
- `frontend/src/lib/evaluators.ts` — `evaluatorLabel(t, id)`.
- `frontend/src/components` — `Btn, Chip, ConfirmDialog, Panel, useToast, ViewHead`.

#### i18n keys (parity confirmed en ↔ zh-CN)

- **`expPage`**: `sub, startHint, start, promote, promoted, canaryTitle, ramp, cleanup, pickChallenger, startCanary, confirmCleanup{title,body}`.
- **`evalPage.experiment`**: `title, meta, how{title,sub,recommend,bundles,gateway,abtest,traffic,verdict,promote,canary,ramp,cleanup,note}, startNew, metricsPending, stageHint{recommend,bundles,gateway,abtest,traffic,verdict,ready,promote,canary,ramp,cleanup}, summary{agent,verdict,created,cleaned,failed}, insufficient{reason,a1,a2,a3,promotedContext}, significant, notSignificant, nonsig{title,observed,reason,a1,a2,a3,promotedContext,confirmPromote{title,body}}, list{title,sub,new,name,agent,stage,verdict,created,status,empty}, runningGuard`.
- Also uses `evalPage.newRun.agent`, `evalPage.newRun.noAgents`, `evalPage.backToRuns`, `evaluation.kicker`, `common.actionFailed`.

#### Tests covering this page

**None.** There is no frontend test runner configured: `frontend/package.json` scripts are only `dev/build/lint/preview`; no vitest/jest/playwright dep, no `*.test.tsx`/`*.spec.ts`, no `__tests__` dir, no root Playwright config. The "fetch-stub state testing" in project memory refers to a manual/ad-hoc dev approach (agent-browser + stubbed `fetch`), not committed tests. **A6 requires adding frontend fetch-stub tests — the harness itself does not yet exist.**

---

### 3. Backend tests for optimization (`backend/tests/optimization/`)

| File | Locks down |
|---|---|
| `test_experiments_crud.py` | POST create → 201 + persisted stages (`stages[:6] == recommend…verdict`, `artifacts.bundles.control.arn`); 409 `experiment.already_running` when a `running` exists; 400 `experiment.method_unsupported` for harness; `send_gateway_traffic` signs (SigV4) + collects session ids + hits `{gw}/{target}/invocations` with the session-id header. **Monkeypatches `service.start_experiment`** so tests never spawn the real loop. |
| `test_bundles_abtest_shape.py` | `create_configuration_bundle` payload (`bundleName`, `components[arn].configuration.system_prompt/tool_descriptions`, clientToken≥33); `config_bundle_variants` 50/50 with C/T1 names + bundleArn; `target_variants` 90/10 with target names; `normalize_ab_results` shape (label from evaluatorArn suffix, control mean, variant isSignificant). |
| `test_weights_and_cleanup.py` | `update_ab_test_weights` payload (`abTestId`, variant weights); `RAMP_STEPS == [(90,10),(50,50),(1,99)]`; `cleanup_resources` per-category tolerance (deleted vs skipped); `compute_verdict` small-n honesty (`insufficient-data`/`insufficient-n`/`treatment-wins`+`significant`). |

These shape/state assertions are what a refactor must keep (or intentionally update). Note the create test asserts `stages[:6]` equals the auto-loop order — a stepwise refactor that changes stage semantics but keeps `STAGES` will still pass this.

---

### 4. How experiments are created (end to end)

- **Entry**: `Evaluation.tsx:782-785` "⚗ EXPERIMENT" button → `?view=experiment`; then in `ExperimentView`, "NEW EXPERIMENT" (`new-experiment-btn`) or `?exp=new` → `startForm` → `exp-start-btn` → `onStart` → `POST /api/experiments {agent_id}`.
- **Backend**: router create guards → `service.start_experiment` → inserts row + **immediately spawns the auto loop thread**. (Refactor A1 wants creation to do *no* AWS-mutating work and land on the recommend card.)
- Start is gated in the UI by `hasRunning` (any experiment `running`) matching the backend 409.

---

### 5. Relevant spec docs (what needs updating after a refactor)

- **There is NO dedicated experiment/optimization spec page.** `.trellis/spec/launchpad/` has: `index.md`, `evaluation-agent-eligibility.md`, `evaluation-cloud-dataset-runs.md`, `managed-kb.md`, `container-capabilities-filesystem.md`, `registry-skill-ingestion.md`. None documents the experiment module (grep for experiment/abtest/canary/bundle in specs only hits unrelated mentions).
- `.trellis/spec/launchpad/index.md` — spec catalogue table; would gain a new row if a stepwise-experiment spec is authored (use the `update-spec` skill; research agent must not edit specs).
- `.trellis/spec/guides/` — generic thinking guides only (`code-reuse`, `cross-layer`); not experiment-specific.
- `backend/scripts/e2e_experiment.py` — not a spec but the PRD (constraint + A7) requires it be rewritten to drive the new per-stage flow (currently drives auto-loop via `wait_stage` polling for `ready`).

## Caveats / Not Found

- **No frontend test infrastructure exists** — A6's "frontend fetch-stub tests" require introducing a test runner first.
- **No experiment spec doc exists** — a refactor should likely create one (e.g. `.trellis/spec/launchpad/experiment-stepwise.md`) and add it to `index.md`; not present today.
- `agentcore_eval.py` `cleanup_resources` tail (gateway/target/runtime/role/delivery deletion) continues past line 641; only the ab-test/online-eval/bundle branches were read in full — behavior confirmed by `test_weights_and_cleanup.py` for the categories the experiment uses.
- The reference project (`/home/ubuntu/workspace/agentxray` Live console) is being researched by a separate agent — not covered here.
