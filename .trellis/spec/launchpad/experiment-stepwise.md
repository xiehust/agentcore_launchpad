# Experiment Stepwise Actions (backend + frontend)

> Configuration A/B and Runtime Canary are separate, user-triggered workflows
> under `/evaluation?view=experiment`. Both use server-side orchestration,
> per-record progress, and artifact-driven UI, but they have different tables,
> APIs, state machines, and cleanup ownership.

## Scenario: driving one configuration A/B stage

### 1. Scope / Trigger

- Cross-layer API contract: `POST /api/experiments/{id}/action` owns only
  configuration recommendation, bundle A/B, promotion, and cleanup.
- DB schema: `experiments.running_action` (VARCHAR 24, nullable),
  `experiments.progress` (TEXT, nullable) — added via the additive `_migrate`
  in `app/core/db.py` (no Alembic).
- Anything editing `backend/app/optimization/service.py`,
  `backend/app/optimization/routers.py`, or
  `frontend/src/pages/EvaluationExperiment.tsx` must respect this contract.

### 2. Signatures

```text
POST /api/experiments                     {agent_id}            → 201 experiment
GET  /api/experiments                                            → {experiments: [...]}
GET  /api/experiments/{id}                                       → experiment
POST /api/experiments/{id}/action         ActionRequest          → 200 | 202 {"experiment": ...}
```

```python
class ActionRequest(BaseModel):
    action: str  # recommend|accept|bundles|gateway|abtest|traffic|verdict
                 # |promote|cleanup
    accepted_prompt: str | None                        # accept
    accepted_tool_descriptions: dict[str, str] | None  # accept
    dataset_id: str | None                             # traffic
```

Service layer (`app/optimization/service.py`):

```python
run_action(exp_id, action, fn: Callable[[Progress], Any])  # daemon thread runner
act_recommend/act_gateway/act_abtest/act_traffic/act_verdict/act_promote/act_cleanup(exp_id, ..., progress)
action_accept(exp, prompt, tool_descriptions)  # sync
action_bundles(exp)  # sync
stage_not_ready_reason(exp, action) -> str | None
resolve_traffic_prompts(dataset) -> list[str]
create_bundle_idempotent(control, **kwargs)    # conflict-adopt via ListConfigurationBundles
clear_stale_running_actions() -> list[str]     # startup sweep (main.py resume block)
assert_shared_gateway_available(own_test_name=None) -> None
```

### 3. Contracts

- **Async actions** `{recommend, gateway, abtest, traffic, verdict, promote,
  cleanup}` → `202`, work runs on a daemon thread; the thread persists its
  artifact + stage on success. **Sync actions** `{accept, bundles}` → `200`
  inline. Both response bodies are `{"experiment": <row>}`
  (NOT the pre-refactor `{"result": ...}`).
- Experiment serialization adds `running_action: str|null` and
  `progress: str|null`. The UI polls `GET /api/experiments` every 8s, and
  2.5s while `running_action` is set.
- `stage` is a **furthest-completed marker** in
  `recommend|bundles|gateway|abtest|traffic|verdict|promote|cleanup`;
  card visibility in the UI is **artifact-driven**, not stage-driven, so old
  auto-pipeline rows render unchanged (A8 backward compat).
- New configuration records own `recommend/bundles/gateway/abtest/traffic/
  verdict/promote/cleanup`. A stored legacy `canary` artifact remains readable
  and cleanable, but is never created or ramped by this API.
- Other artifact keys include:
  - `agent_meta` — runtime snapshot written at create
    (`{id,name,arn,resource_id,runtime_name,system_prompt}`); rebuilt lazily
    by `_agent_meta()` for old rows.
  - `recommend.accepted_prompt` / `recommend.accepted_tool_descriptions` —
    written by `accept`; `bundles` uses accepted → recommended fallback.
  - `traffic.dataset_id` / `traffic.dataset_name` — when a dataset was
    replayed instead of the built-in `TRAFFIC_PROMPTS*2`.
- `POST /api/experiments` performs **no AWS-mutating work** (A1) — only the
  row + `agent_meta` (one `get_agent_runtime` read).
- The Gateway is the shared `EXP_GATEWAY_NAME`. `gateway` and `abtest` run a
  read-only active-test preflight before mutation. Any foreign test on the same
  Gateway whose `executionStatus != "STOPPED"` returns
  `409 experiment.gateway_busy`; an exact record-owned test name is adoptable
  on idempotent retry.
- Cleanup deletes only configuration-owned bundles, targets, online evaluator
  configs, and A/B tests. It passes `delete_gateway=False`; the shared Gateway
  is never deleted.
- `canary` and `ramp` are compatibility-only request values. They return
  `410 experiment.action_moved` and point callers to `/api/runtime-canaries`;
  they never dispatch asynchronous work.
- Failure: the runner stores `error = "<action>: <Type>: <msg>"` (action
  prefix is a UI contract — the page pins the retry button by
  `error.startsWith(action + ": ")`), clears `running_action`, KEEPS the
  stage. Retry = re-POST the same action (AWS creates are idempotent,
  conflict-adopt by name — bundles via `create_bundle_idempotent`).
- `status="failed"` is LEGACY-ONLY (old auto-pipeline rows): stepwise
  failures keep `status="running"` with inline retry. A permanently stuck
  experiment therefore holds the single-running-experiment slot — the
  escape hatch is `cleanup` (→ `cleaned`). Sync-action failures
  (accept/bundles) surface as the HTTP error → UI toast; they
  do NOT write `exp.error` (only the async runner does).

### 4. Validation & Error Matrix

| Condition | Error |
|---|---|
| unknown action | 422 (pydantic pattern) |
| `running_action` non-null | 409 `experiment.action_in_flight` |
| prerequisite artifact missing (see table below) | 409 `experiment.stage_not_ready` |
| accept with no prompt anywhere | 400 `experiment.accept_invalid` |
| traffic dataset not found | 404 `dataset.not_found` |
| traffic dataset kind `simulated` / no usable prompts | 422 `experiment.dataset_unsupported` |
| foreign active A/B test on shared Gateway | 409 `experiment.gateway_busy`, with `gateway_arn` and `active_tests` |
| legacy `canary` or `ramp` action | 410 `experiment.action_moved`, with `runtime_canaries_path` |
| second concurrent experiment (create) | 409 `experiment.already_running` |

Prerequisites (`stage_not_ready_reason`): accept←recommend artifact;
bundles←`recommend.accepted_prompt` OR existing bundles artifact (old-row
retry); gateway←bundles; abtest←gateway; traffic←abtest; verdict←traffic;
promote←verdict; recommend/cleanup←none.

### 5. Good/Base/Bad Cases

- **Good**: create → recommend(202, poll) → accept(edited prompt) → bundles →
  gateway → abtest → traffic(dataset_id) → verdict → promote → cleanup. The
  promoted Agent can be handed off into a separate Runtime Canary record.
- **Base**: old auto-pipeline row (all artifacts, no `accepted_*`, NULL new
  columns, possible `canary` artifact) — GET serializes, the legacy Canary
  renders read-only, cleanup still owns its old resources, and re-running
  `bundles` is allowed.
- **Bad**: POST `gateway` before `bundles` → 409 stage_not_ready; POST while
  recommend runs → 409 action_in_flight; active Canary test on the shared
  Gateway → 409 gateway_busy before configuration resources are mutated.

### 6. Tests Required

`backend/tests/optimization/test_stepwise_actions.py`:
- guard matrix (every action w/o prereq → 409; in-flight → 409)
- accept persists edit + keeps `recommended_prompt`; empty accept → 400
- `act_recommend` re-run preserves prior `accepted_*`
- bundles consumes accepted prompt/tool-descs (capture via monkeypatched
  `stage_bundles`)
- `resolve_traffic_prompts`: legacy prompt, predefined first-turn (incl.
  dict `input` via `scenario_prompts` reuse), simulated → ValueError
- runner lifecycle: failure keeps stage + `"<action>: "` error prefix;
  success clears error/progress (monkeypatch `svc._spawn` to run inline)
- `clear_stale_running_actions` clears only stuck rows, writes retryable error
- create defers all stage work (`artifacts == {agent_meta}`)
- old `canary`/`ramp` actions return `experiment.action_moved`
- Gateway conflict is detected before config mutation; exact own test is
  adoptable; cleanup never calls shared-Gateway deletion

Frontend has NO test runner — verify via the fetch-stub browser evidence
flow with synthetic experiment states plus a real handoff URL.

### 7. Wrong vs Correct

#### Wrong
```python
# Orchestrate in the frontend / auto-run stages at create
threading.Thread(target=run_experiment_loop, ...).start()   # removed
# Continue target canary work on the configuration record
POST /api/experiments/{id}/action {"action": "canary"}
```

#### Correct
```python
# Configuration A/B ends at promotion/cleanup. Canary gets a separate row.
POST /api/runtime-canaries {
    "champion_agent_id": promoted_agent_id,
    "challenger_agent_id": challenger_id,
    "source_experiment_id": experiment_id,
}
```

## Design Decisions

### Server-side orchestration (vs agentxray's frontend chaining)

agentxray's Live console chains AWS calls in the browser and PUTs artifacts
back — closing the tab strands a stage. Launchpad keeps stage logic in
`service.py`; the browser only POSTs actions and polls. Progress lives on
the experiment ROW (`running_action`/`progress`), not in a button closure,
so a reload resumes the same spinner mid-action.

### Startup sweep for stale actions

Action threads are daemons — a backend restart (incl. `--reload`) kills them
without clearing `running_action`, which would 409 every retry forever.
`clear_stale_running_actions()` runs in the `resume_jobs` startup block of
`create_app` and converts the stuck flag into a retryable
`"<action>: interrupted by a backend restart — retry the action"` error.

### Traffic dataset replay

The traffic stage accepts any legacy/predefined `EvalDataset`; prompt
extraction reuses `app.evaluation.scenarios.scenario_prompts` so dict turn
inputs unwrap exactly as in eval replay. Simulated datasets are rejected —
they need an actor loop, not a fire-and-forget prompt replay.

> **Warning**: AgentCore permits only one active A/B test per Gateway.
> Configuration A/B and Runtime Canary therefore share the
> `experiment.gateway_busy` mutex; neither workflow may stop the other's test
> to make room.

## Scenario: independent Runtime Canary

### 1. Scope / Trigger

- Runtime Canary compares two active HTTP AgentCore Runtime Agents by routing
  target traffic on the shared experiment Gateway.
- It is not a configuration-bundle stage and never updates a production
  Gateway or target.
- Changes to `canary_routers.py`, `canary_service.py`, `RuntimeCanary`, or
  `EvaluationRuntimeCanary.tsx` must preserve this separate lifecycle.

### 2. Signatures

```text
GET  /api/runtime-canaries
GET  /api/runtime-canaries/{id}
POST /api/runtime-canaries
     {champion_agent_id, challenger_agent_id, source_experiment_id?}
     -> 201 canary
POST /api/runtime-canaries/{id}/action
     {action, dataset_id?, allow_non_significant?}
     -> 202 {"canary": canary}
```

```python
class RuntimeCanary(Base):
    id: str
    champion_agent_id: str
    challenger_agent_id: str
    source_experiment_id: str | None
    status: str  # running|completed|rolled_back|cleaned
    stage: str   # setup|traffic|verdict|ramp|complete|rollback|cleanup
    artifacts: dict[str, Any]
    running_action: str | None
    progress: str | None
    error: str | None

canary_capability(agent) -> {"eligible": bool, "reason": str | None}
stage_not_ready_reason(canary, action) -> str | None
assert_verdict_allows(canary, allow_non_significant: bool) -> None
```

### 3. Contracts

- Create validates both Agents with the backend-owned `canary_capability`,
  requires distinct active Agents, snapshots both Runtime identities, and
  writes only the `runtime_canaries` row. Setup remains an explicit action.
- Optional `source_experiment_id` is valid only when that experiment has a
  completed production promotion and its Agent is the selected champion.
  Direct Canary creation does not require any configuration experiment.
- Every action is asynchronous and uses the Canary row's
  `running_action/progress/error` fields. Backend startup clears stale action
  flags into retryable `"<action>: interrupted..."` errors.
- State machine:
  `setup(90/10) -> traffic -> verdict -> advance(50/50) -> traffic -> verdict
  -> advance(1/99) -> traffic -> verdict -> complete`. Each gate is manually
  triggered; `rollback` is available after setup and `cleanup` is always
  available.
- `artifacts.setup` owns the Gateway identity, record-derived A/B test name,
  A/B test ID, champion/challenger target and online-evaluation IDs,
  `ramp_stage`, and weights. `artifacts.rounds[]` owns one evidence record per
  ramp stage.
- Before every traffic attempt, normalize current A/B metrics and store their
  aggregate sample count as `baseline_n`. Recording a verdict waits for
  `sample_n > baseline_n`; otherwise it stores `insufficient-data`. Sending
  more traffic removes the prior verdict for that stage.
- Significant `treatment-wins` advances directly. `tie` or any result with
  `significant=false` requires `allow_non_significant=true`.
  `control-wins`, `insufficient-data`, and `insufficient-n` cannot be
  overridden.
- Setup runs the shared-Gateway active-test preflight before targets are
  created and again before A/B creation. A conflict returns
  `experiment.gateway_busy`. A retry may adopt only its own exact
  `can_<id>_target` test.
- Complete and rollback stop the Canary A/B test and record
  `experimental_only=true`; they do not deploy either Agent. Cleanup discovers
  resources by record-derived names, deletes only Canary-owned A/B tests,
  evaluator configs, and targets, and always passes `delete_gateway=False`.

### 4. Validation & Error Matrix

| Condition | Error |
|---|---|
| Canary not found | 404 `canary.not_found` |
| Agent missing or inactive | 400 `canary.agent_not_active` |
| Harness, A2A, missing Runtime ARN, or unsupported method | 400 `canary.agent_unsupported`, with role and `canary_capability` |
| champion equals challenger | 400 `canary.same_agent` |
| invalid/incomplete source experiment | 400 `canary.source_experiment_invalid` |
| source experiment Agent is not champion | 400 `canary.source_champion_mismatch` |
| action already running | 409 `canary.action_in_flight` |
| setup/traffic/verdict/ramp prerequisite missing | 409 `canary.stage_not_ready` |
| simulated or unusable traffic dataset | 422 `canary.dataset_unsupported` |
| foreign active test on shared Gateway | 409 `experiment.gateway_busy` before setup mutation |
| tie/non-significant without explicit override | 409 `canary.override_required` |
| control win or insufficient evidence | 409 `canary.verdict_blocked` |

### 5. Good/Base/Bad Cases

- **Good**: create directly -> setup 90/10 -> fresh traffic/verdict at all
  three stages -> treatment wins -> complete -> cleanup. Completion records a
  challenger winner but performs no production update.
- **Base**: promoted configuration experiment opens
  `mode=canary&canary=new&champion=<agent>&sourceExp=<experiment>`; create
  validates the linkage and starts a separate record.
- **Bad**: an unrelated configuration A/B test is active; setup returns
  `experiment.gateway_busy` before creating Canary targets or evaluators.

### 6. Tests Required

- API create: direct record, optional valid source, source mismatch,
  same/inactive/unsupported Agents, and no AWS mutation.
- Setup: shared-Gateway conflict before mutation, exact-name idempotent retry,
  90/10 artifact ownership, and no Gateway deletion.
- Every ramp: traffic required before verdict; fresh sample growth required
  after the latest baseline; prior-stage evidence cannot unlock the next gate.
- Verdict policy: treatment win, tie, non-significant, control win,
  insufficient-data, and insufficient-n, including explicit override behavior.
- Terminal actions: complete/rollback stop only the Canary A/B test; cleanup
  discovers partial resources, is retryable, and never deletes the Gateway.
- Browser: direct create, promotion handoff, disabled capability reasons,
  every gate/override/blocked state, EN/ZH, and desktop/mobile overflow.

### 7. Wrong vs Correct

#### Wrong

```python
# Treat completion as production promotion or reuse an old verdict.
update_production_target(challenger)
round_1["verdict"] = round_0["verdict"]
```

#### Correct

```python
baseline_n = metric_sample_count(current_metrics)
send_gateway_traffic(...)
assert metric_sample_count(next_metrics) > baseline_n
stop_canary_ab_test()
record_complete(winner="challenger", experimental_only=True)
```

## Scenario: official AgentCore production promotion

### 1. Scope / Trigger

- `promote` means completing the AgentCore experiment lifecycle, not changing
  variant weights to `C=1/T1=99`.
- This contract covers experiment eligibility, configuration-bundle payloads,
  production defaults, A/B test shutdown, in-place runtime deployment, legacy
  1/99 records, and optional Runtime Canary handoff validation.

### 2. Signatures

```python
experiment_capability(agent: Agent) -> {
    "eligible": bool,
    "system_prompt": bool,
    "tool_descriptions": bool,
    "reason": str | None,
}
promotion_complete(artifacts: dict[str, Any]) -> bool
legacy_promotion(artifacts: dict[str, Any]) -> bool
act_promote(exp_id: str, progress: Progress) -> dict[str, Any]

create_deployment(
    db: Session,
    agent: Agent,
    mode: str = "create",
    *,
    skip_register: bool = False,
) -> tuple[Deployment, Job]
```

```python
class AgentSpec(BaseModel):
    tool_description_overrides: dict[str, str]  # max 100 entries
```

`GET /api/agents` and agent create/read responses expose
`experiment_capability`. `POST /api/experiments` enforces that same
backend-owned projection and returns `400` when `eligible=false`.

### 3. Contracts

- Eligible agents are active Launchpad-generated HTTP `zip_runtime` agents and
  converted harness runtimes with a recognized config-bundle graft. Harness,
  container, Studio, A2A, and arbitrary custom source are not assumed to
  consume bundles. A legacy converted graft supports system prompts but reports
  `tool_descriptions=false`; the v2 graft supports both.
- New AgentCore configuration bundles write tool descriptions as
  `configuration.tools.<name>.description`. Generated and converted runtimes
  continue reading legacy `configuration.tool_descriptions`, then let the
  documented `tools` shape win. Without a routed bundle, promoted
  `Agent.spec.system_prompt` and `tool_description_overrides` are defaults.
- Promotion is asynchronous (`202`). It stops the bundle A/B test and waits
  until `executionStatus == "STOPPED"`, writes `promotion_attempt`, applies the
  accepted prompt and tool descriptions to `Agent.spec`, upgrades a managed
  harness graft when needed, then creates an in-place deployment with
  `mode="update", skip_register=True`.
- `skip_register` skips only the `register` stage. Generate, package,
  provision, and deploy still run, preserving runtime identity through the
  normal update path.
- A successful `artifacts.promote` contains `ab_test_id`,
  `ab_test_status="STOPPED"`, `agent_id`, `deployment_id`, `job_id`,
  `agent_version`, `applied_system_prompt`, `applied_tool_descriptions`, and
  `completed_at`. Only after both deployment and job succeed may the service
  set `status="promoted"` and `stage="promote"`.
- A legacy artifact with `after_weights` but no completed deployment is
  projected as `status="ready"` without mutating its stored row. The UI labels
  it `LEGACY TRAFFIC SHIFT` and requires explicit `COMPLETE PROMOTION`.
  Completion preserves its former weights as `promote.prior_shift`.
- A Runtime Canary handoff with `source_experiment_id` requires
  `promote.deployment_id` and `promote.ab_test_status == "STOPPED"`; a legacy
  1/99 artifact is insufficient. Direct Runtime Canary creation has no
  configuration-experiment prerequisite.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| capability `eligible=false` | `POST /api/experiments` returns `400` with capability details |
| tool override name empty or over 200 chars | `AgentSpec` validation error |
| tool override description over 4000 chars | `AgentSpec` validation error |
| more than 100 tool overrides | `AgentSpec` validation error |
| A/B stop API fails or never reaches `STOPPED` | no deployment and no success artifact; async error is retryable |
| managed converted source lacks graft anchors | promotion fails before deployment |
| production agent is missing/deleted | promotion fails before deployment |
| deployment or job does not succeed | keep `status="ready"`; retain `promotion_attempt`; no success artifact |
| Canary source references legacy 1/99 shift | `400 canary.source_experiment_invalid` |

### 5. Good/Base/Bad Cases

- **Good**: treatment accepted → promote returns `202` → A/B test reaches
  `STOPPED` → accepted defaults are persisted → update deployment succeeds →
  `promote` records the deployed version and status becomes `promoted`.
- **Base**: legacy `{"after_weights":{"C":1,"T1":99}}` row renders as ready;
  explicit completion stops the existing test, deploys treatment, and retains
  the old weights in `prior_shift`.
- **Bad**: runtime update fails after the test stopped; the row stays ready,
  `promotion_attempt` proves where it failed, and retry does not try to stop an
  already-stopped test.

### 6. Tests Required

- Capability matrix: generated runtime, v2/legacy converted runtime, harness,
  container, Studio, A2A, and arbitrary source; assert API projection and create
  enforcement.
- Bundle shape: assert new writes use `tools.<name>.description`; runtime tests
  assert documented shape, legacy fallback, and promoted defaults.
- Promotion: assert stop-before-deploy ordering, already-stopped retry,
  stop failure, deployment failure, legacy completion, success artifact shape,
  and success-only status transition.
- Deployment pipeline: assert `skip_register=True` skips only registration and
  preserves `mode="update"`.
- Frontend/browser: assert legacy label and confirmation, running/failed/success
  states, deployed version, disabled unsupported agents, and mobile layout.

### 7. Wrong vs Correct

#### Wrong

```python
# A weight floor is an A/B test constraint, not production deployment.
update_ab_test(variants={"C": 1, "T1": 99})
_update(exp.id, status="promoted")
```

#### Correct

```python
stopped = _stop_ab_test(data, ab_test_id, progress)
deployment, job = create_deployment(
    db, agent, mode="update", skip_register=True
)
execute_deploy_job(job.id)
# Write status="promoted" only after deployment and job are both succeeded.
```
