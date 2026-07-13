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
act_recommend/act_gateway/act_abtest/act_traffic/act_verdict/act_canary/act_cleanup(exp_id, ..., progress)
action_accept(exp, prompt, tool_descriptions)  # sync
action_bundles(exp) / action_promote(exp) / action_ramp(exp)  # sync
stage_not_ready_reason(exp, action) -> str | None
resolve_traffic_prompts(dataset) -> list[str]
create_bundle_idempotent(control, **kwargs)    # conflict-adopt via ListConfigurationBundles
clear_stale_running_actions() -> list[str]     # startup sweep (main.py resume block)
```

### 3. Contracts

- **Async actions** `{recommend, gateway, abtest, traffic, verdict, canary,
  cleanup}` → `202`, work runs on a daemon thread; the thread persists its
  artifact + stage on success. **Sync actions** `{accept, bundles, promote,
  ramp}` → `200` inline. Both response bodies are `{"experiment": <row>}`
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
- Failure: the runner stores `error = "<action>: <Type>: <msg>"` (action
  prefix is a UI contract — the page pins the retry button by
  `error.startsWith(action + ": ")`), clears `running_action`, KEEPS the
  stage. Retry = re-POST the same action (AWS creates are idempotent,
  conflict-adopt by name — bundles via `create_bundle_idempotent`).
- `status="failed"` is LEGACY-ONLY (old auto-pipeline rows): stepwise
  failures keep `status="running"` with inline retry. A permanently stuck
  experiment therefore holds the single-running-experiment slot — the
  escape hatch is `cleanup` (→ `cleaned`). Sync-action failures
  (accept/bundles/promote/ramp) surface as the HTTP error → UI toast; they
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
  recommend runs → 409 action_in_flight; simulated dataset → 422.

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
```

#### Correct
```python
# Router validates inline, thread gets plain snapshots + exp_id only
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
