# Configuration Experiment and Runtime Canary Separation

## Decision Summary

Configuration experiments remain in the existing `experiments` table and
`/api/experiments` API. Runtime canaries get a separate `runtime_canaries`
table, `/api/runtime-canaries` API, service module, and frontend view. The new
backend boundary is `optimization/canary_routers.py` plus
`optimization/canary_service.py`; the existing router/service remain the
configuration-experiment boundary.

This is one integrated task because the data model, action guards, shared
Gateway mutex, and UI navigation form one cross-layer contract. Splitting them
into independently shipped child tasks would temporarily expose records that
the UI cannot operate or controls that call an incomplete API.

## Data Model

Add `RuntimeCanary` beside `Experiment` in
`backend/app/optimization/models.py`:

```python
class RuntimeCanary(Base):
    id: str
    name: str
    champion_agent_id: str
    champion_agent_name: str
    challenger_agent_id: str
    challenger_agent_name: str
    source_experiment_id: str | None
    status: str
    stage: str
    artifacts: dict[str, Any]
    running_action: str | None
    progress: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime
```

The new table is additive and created by the existing `Base.metadata.create_all`
path. Agent IDs are snapshots rather than foreign keys, matching `Experiment`,
so deleted ledger rows do not make historical canaries unreadable.

Statuses are `running | completed | rolled_back | cleaned`. Stages are
`setup | traffic | verdict | ramp | complete | rollback | cleanup`.

## API Contracts

```text
GET  /api/runtime-canaries
GET  /api/runtime-canaries/{id}
POST /api/runtime-canaries
POST /api/runtime-canaries/{id}/action
```

Create request:

```json
{
  "champion_agent_id": "...",
  "challenger_agent_id": "...",
  "source_experiment_id": "optional"
}
```

Both agents must be active, different, and eligible under the backend-owned
`canary_capability`. Creation writes only the row and immutable agent
snapshots; it performs no AWS mutation.

Action request:

```json
{
  "action": "setup|traffic|verdict|advance|complete|rollback|cleanup",
  "dataset_id": "traffic only, optional",
  "allow_non_significant": false
}
```

All actions are asynchronous and return `202 {"canary": ...}`. The runner owns
`running_action`, `progress`, and retryable `<action>: ...` errors exactly as
the existing experiment runner does, but updates the `runtime_canaries` table.

## Runtime Canary State Machine

```text
create
  -> setup target A/B at 90/10
  -> traffic(stage=0)
  -> verdict(stage=0)
  -> advance to 50/50
  -> traffic(stage=1)
  -> verdict(stage=1)
  -> advance to 1/99
  -> traffic(stage=2)
  -> verdict(stage=2)
  -> complete
```

`rollback` is available after setup and stops the A/B test while retaining
evidence. `cleanup` is available from any state and deletes only resources
owned by the canary record.

Each stage has one round entry:

```json
{
  "ramp_stage": 1,
  "weights": {"C": 50, "T1": 50},
  "traffic_attempts": [
    {"session_ids": [], "sent": 12, "failed": 0, "baseline_n": 14}
  ],
  "verdict": {"verdict": "treatment-wins", "n": 28, "metrics": []}
}
```

Before sending traffic, the service snapshots the current aggregate sample
count as `baseline_n`. Verdict polling must observe a larger sample count than
the latest traffic attempt's baseline before accepting the result. This keeps
an earlier round's already-aggregated metrics from satisfying a later gate.

Verdict gating:

- significant `treatment-wins`: advance/complete directly;
- tie or any non-significant result: require
  `allow_non_significant=true`;
- `control-wins`, `insufficient-data`, or `insufficient-n`: reject advance and
  complete; the operator sends more traffic or rolls back.

## Gateway and Resource Ownership

Both workflows use `EXP_GATEWAY_NAME`. Add a service preflight that lists
AgentCore A/B tests and finds any test on that Gateway whose
`executionStatus` is not `STOPPED`. Setup rejects a conflict with
`409 experiment.gateway_busy` before creating canary-owned targets or online
evaluation configurations. A second check immediately precedes A/B creation;
an AWS conflict is translated to the same stable error unless it is an
idempotent retry adopting this record's exact test name.

Runtime canary setup creates:

- champion and challenger HTTP Runtime targets with `can_<id>_*` names;
- one online evaluation configuration per Runtime;
- one target-routing A/B test, initially 90/10.

Configuration experiments keep their bundle-specific target, evaluator,
bundles, and A/B test. Promotion already stops their bundle A/B test, so the
optional handoff can then start a Runtime canary on the shared Gateway.

Canary cleanup stops/deletes its A/B test, deletes its two online evaluation
configs and two targets, and never deletes the shared Gateway. Configuration
cleanup remains responsible for configuration-owned resources and legacy
combined canary artifacts.

## Configuration Experiment Compatibility

Remove canary and ramp from the configuration workflow and stage list. Calls to
the old configuration actions return `410 experiment.action_moved`; cleanup
remains available.

Existing rows with a `canary` artifact continue rendering a read-only legacy
summary and retain cleanup access. No stored artifact is rewritten.

After successful configuration promotion, the UI offers an optional handoff to
the Runtime Canary create form with the promoted Agent preselected as champion
and `source_experiment_id` attached.

## Frontend

The experiment sub-page gains a compact segmented mode control:

- Configuration A/B
- Runtime Canary

Existing `?view=experiment&exp=<id>` links remain configuration links.
Runtime canaries use `?view=experiment&mode=canary&canary=<id>`. The new form
uses `canary=new`, with optional `champion` and `sourceExp` handoff params.

The canary create form shows champion and challenger selectors separately.
Compatible Runtime agents are enabled; Harness/A2A agents stay visible but
disabled with `canary_capability.reason`. Selecting the same agent twice is
blocked in the browser and API.

The detail view presents setup, per-stage traffic/verdict evidence,
advance/complete, rollback, and cleanup. All traffic percentages are labeled
as experiment Gateway traffic, never production traffic.

## Failure and Recovery

- Startup stale-action recovery covers both tables.
- Every create operation uses record-derived names and conflict adoption for
  idempotent retry.
- Rollback stops the target A/B test but leaves evidence and temporary
  resources until cleanup.
- Cleanup is idempotent and can run after setup failure, completion, rollback,
  or backend restart.
- If Gateway preflight finds an unrelated active test, no canary-owned AWS
  resource is created.

## Test Strategy

- Unit-test capability, verdict-gate, sample-baseline, stage prerequisites, and
  active-Gateway-test detection.
- API-test create validation, separate records, every action guard, override
  semantics, conflict-before-mutation, async lifecycle, and cleanup ownership.
- Preserve configuration experiment tests while replacing combined-canary
  action expectations with `experiment.action_moved`.
- Browser-test both mode lists, direct creation, handoff, disabled agent
  reasons, each gated stage, rollback, legacy rendering, and mobile layout.
