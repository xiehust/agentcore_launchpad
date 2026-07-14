# Experiment Stepwise Actions (backend + frontend)

> The optimization experiment (`/evaluation?view=experiment`) runs as
> user-triggered stage actions, not an auto pipeline. Server-side
> orchestration; per-row progress; artifact-driven progressive UI.
> Introduced 2026-07-13 (task 07-13-experiment-stepwise, modeled on the
> agentxray Live console UX).

## Scenario: driving one experiment stage

### 1. Scope / Trigger

- Cross-layer API contract: `POST /api/experiments/{id}/action` verb set,
  202-vs-200 semantics, `running_action`/`progress` polling fields.
- DB schema: `experiments.running_action` (VARCHAR 24, nullable),
  `experiments.progress` (TEXT, nullable) — added via the additive `_migrate`
  in `app/core/db.py` (no Alembic).
- Anything editing `backend/app/optimization/*` or
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
                 # |promote|canary|ramp|cleanup
    accepted_prompt: str | None                        # accept
    accepted_tool_descriptions: dict[str, str] | None  # accept
    dataset_id: str | None                             # traffic
    challenger_agent_id: str | None                    # canary
```

Service layer (`app/optimization/service.py`):

```python
run_action(exp_id, action, fn: Callable[[Progress], Any])  # daemon thread runner
act_recommend/act_gateway/act_abtest/act_traffic/act_verdict/act_promote/act_canary/act_cleanup(exp_id, ..., progress)
action_accept(exp, prompt, tool_descriptions)  # sync
action_bundles(exp) / action_ramp(exp)  # sync
stage_not_ready_reason(exp, action) -> str | None
resolve_traffic_prompts(dataset) -> list[str]
create_bundle_idempotent(control, **kwargs)    # conflict-adopt via ListConfigurationBundles
clear_stale_running_actions() -> list[str]     # startup sweep (main.py resume block)
canary_capability(agent) -> {
    "eligible": bool,
    "reason": str | None,
}
```

### 3. Contracts

- **Async actions** `{recommend, gateway, abtest, traffic, verdict, promote,
  canary, cleanup}` → `202`, work runs on a daemon thread; the thread persists
  its artifact + stage on success. **Sync actions** `{accept, bundles, ramp}` →
  `200` inline. Both response bodies are `{"experiment": <row>}`
  (NOT the pre-refactor `{"result": ...}`).
- Experiment serialization adds `running_action: str|null` and
  `progress: str|null`. The UI polls `GET /api/experiments` every 8s, and
  2.5s while `running_action` is set.
- `stage` is a **furthest-completed marker** (same `STAGES` list as before);
  card visibility in the UI is **artifact-driven**, not stage-driven, so old
  auto-pipeline rows render unchanged (A8 backward compat).
- Artifact keys are unchanged (`recommend/bundles/gateway/abtest/traffic/
  verdict/promote/canary/cleanup`) plus:
  - `agent_meta` — runtime snapshot written at create
    (`{id,name,arn,resource_id,runtime_name,system_prompt}`); rebuilt lazily
    by `_agent_meta()` for old rows.
  - `recommend.accepted_prompt` / `recommend.accepted_tool_descriptions` —
    written by `accept`; `bundles` uses accepted → recommended fallback.
  - `traffic.dataset_id` / `traffic.dataset_name` — when a dataset was
    replayed instead of the built-in `TRAFFIC_PROMPTS*2`.
- `POST /api/experiments` performs **no AWS-mutating work** (A1) — only the
  row + `agent_meta` (one `get_agent_runtime` read).
- `GET /api/agents` exposes `canary_capability` separately from
  `experiment_capability`. Target-canary challengers must be active HTTP
  AgentCore Runtime resources deployed by `zip_runtime`, `container`, or
  `studio`; they do not need to consume Launchpad configuration bundles.
  Harness and A2A agents remain visible in the challenger selector as disabled
  options with the backend-provided reason.
- The current experiment champion is omitted from the challenger selector.
  The action endpoint repeats the active/self/capability checks before calling
  `run_action`; frontend filtering is explanatory UX, not authorization.
- Failure: the runner stores `error = "<action>: <Type>: <msg>"` (action
  prefix is a UI contract — the page pins the retry button by
  `error.startsWith(action + ": ")`), clears `running_action`, KEEPS the
  stage. Retry = re-POST the same action (AWS creates are idempotent,
  conflict-adopt by name — bundles via `create_bundle_idempotent`).
- `status="failed"` is LEGACY-ONLY (old auto-pipeline rows): stepwise
  failures keep `status="running"` with inline retry. A permanently stuck
  experiment therefore holds the single-running-experiment slot — the
  escape hatch is `cleanup` (→ `cleaned`). Sync-action failures
  (accept/bundles/ramp) surface as the HTTP error → UI toast; they
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
| canary challenger missing/inactive/self | 400 `experiment.challenger_required` |
| canary challenger is Harness, A2A, lacks a Runtime ARN, or uses an unsupported method | 400 `experiment.challenger_unsupported` with `detail.canary_capability` |
| second concurrent experiment (create) | 409 `experiment.already_running` |

Prerequisites (`stage_not_ready_reason`): accept←recommend artifact;
bundles←`recommend.accepted_prompt` OR existing bundles artifact (old-row
retry); gateway←bundles; abtest←gateway; traffic←abtest; verdict←traffic;
promote/canary←verdict; ramp←canary; recommend/cleanup←none.

### 5. Good/Base/Bad Cases

- **Good**: create → recommend(202, poll) → accept(edited prompt) → bundles →
  gateway → abtest → traffic(dataset_id) → verdict → promote → canary →
  ramp×2 → cleanup. Each card shows button → progress → artifact echo.
- **Base**: old auto-pipeline row (all artifacts, no `accepted_*`, NULL new
  columns) — GET serializes, all cards render read-only results,
  promote/canary/ramp/cleanup still work; re-running `bundles` is allowed.
- **Bad**: POST `gateway` before `bundles` → 409 stage_not_ready; POST while
  recommend runs → 409 action_in_flight; simulated dataset → 422; Harness or
  A2A challenger → 400 before asynchronous AWS work starts.

### 6. Tests Required

`backend/tests/optimization/test_stepwise_actions.py` (31 total in the dir):
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
- canary capability matrix: custom HTTP zip runtime, container, and Studio are
  eligible; inactive, Harness, A2A, and missing-Runtime-ARN agents are not
- canary action rejects inactive/self/incompatible challengers before
  `run_action`, while a compatible custom HTTP runtime dispatches successfully

Frontend has NO test runner — verify via the fetch-stub browser evidence
flow (stub `window.fetch` with synthetic experiment states; screenshots in
the task's `evidence/`).

### 7. Wrong vs Correct

#### Wrong
```python
# Orchestrate in the frontend / auto-run stages at create
threading.Thread(target=run_experiment_loop, ...).start()   # removed
# Pass the ORM row into the action thread
run_action(exp.id, "canary", lambda p: act_canary(exp, ...))  # detached-row risk
# Reuse bundle-consumption eligibility for target routing
challengers = [a for a in agents if experiment_capability(a)["eligible"]]
```

#### Correct
```python
# Router validates inline, thread gets plain snapshots + exp_id only
capability = canary_capability(challenger)
if not capability["eligible"]:
    raise AppError("experiment.challenger_unsupported", ...)
snapshot = {"name": challenger.name, "arn": challenger.arn,
            "resource_id": challenger.resource_id}
service.run_action(exp.id, "canary",
                   lambda progress: service.act_canary(exp_id, snapshot, progress))
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

> **Warning**: only ONE A/B test can run per gateway — `act_canary` still
> STOPs the bundle test before creating the canary test, and the
> single-running-experiment guard on create remains load-bearing.

## Scenario: official AgentCore production promotion

### 1. Scope / Trigger

- `promote` means completing the AgentCore experiment lifecycle, not changing
  variant weights to `C=1/T1=99`.
- This contract covers experiment eligibility, configuration-bundle payloads,
  production defaults, A/B test shutdown, in-place runtime deployment, legacy
  1/99 records, and the canary prerequisite.

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
- Canary requires `promote.deployment_id` and
  `promote.ab_test_status == "STOPPED"`; a legacy 1/99 artifact is insufficient.

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
| canary requested after legacy 1/99 shift | `409 experiment.stage_not_ready` |

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
