# Design — Experiment step-by-step interactive flow

Reference research: `research/agentxray-live-reference.md`,
`research/deployed-site-observations.md`, `research/launchpad-experiment-current.md`.

## 0. Design stance

Port agentxray's **interaction model** (stage cards, per-stage user actions,
button-while-pending → artifact-echo-once-done, advisory verdict) onto
launchpad's **existing architecture** (SQLAlchemy `Experiment` row with
`artifacts` JSON keyed by stage, idempotent AWS helpers, polling frontend).
Two deliberate differences from agentxray:

1. **Orchestration stays server-side.** agentxray's frontend chains AWS calls
   and PUTs artifacts back; that makes the browser a single point of failure
   mid-stage. Launchpad keeps stage logic in `service.py`; the frontend only
   POSTs `action` requests and polls. A closed tab never strands a stage.
2. **Progress lives on the experiment row, not in a button closure.**
   agentxray loses progress text on reload (research §Caveats). We persist
   `{running_action, progress}` server-side so a reload resumes the same
   spinner mid-action.

## 1. Backend

### 1.1 Model changes (`backend/app/optimization/models.py`)

`STAGES` list and artifact keys are **unchanged** (backward compat, R6):
`recommend, bundles, gateway, abtest, traffic, verdict, promote, canary,
ramp, cleanup`. `stage` becomes a *furthest-completed* pointer instead of an
auto-loop cursor.

New columns (nullable, default None — old rows valid without migration since
SQLite ALTER adds them via the existing create_all + startup check pattern):

```python
running_action: Mapped[str | None]   # action currently executing, None if idle
progress: Mapped[str | None]         # free-form progress line for the UI
```

`status` values unchanged: `running | ready | promoted | cleaned | failed`.
New experiments still start `status="running"`, `stage="recommend"` — but
`start_experiment` no longer spawns the auto-loop thread (it only creates the
row and resolves runtime metadata into `artifacts["agent_meta"]`, see 1.3).
`failed` becomes recoverable: a failed action stores `error`, keeps the stage,
and the UI offers retry (re-POST the same action; idempotent helpers make
re-runs safe).

### 1.2 API (`backend/app/optimization/routers.py`)

Single action endpoint, extended verb set:

```
POST /api/experiments/{id}/action
{ "action": "recommend" | "accept" | "bundles" | "gateway" | "abtest"
           | "traffic" | "verdict" | "promote" | "canary" | "ramp" | "cleanup",
  # action-specific optional fields:
  "accepted_prompt": str,                  # accept
  "accepted_tool_descriptions": dict,      # accept
  "dataset_id": str | None,                # traffic (None → built-in prompts)
  "challenger_agent_id": str | None }      # canary
```

- Long actions (`recommend, gateway, abtest, traffic, verdict, canary,
  cleanup`) return `202 {"experiment": {...}}` immediately and run on a daemon
  thread that updates `running_action/progress` then persists the stage
  artifact (same `_update` helper).
- Short actions (`accept, bundles, promote, ramp`) run inline and return
  `200` with the refreshed experiment. (`bundles` is two control-plane calls
  ≈ seconds; if it proves slow in practice it can move to the async set
  without an API change.)
- Guards (409 unless satisfied): no `running_action` in flight; stage
  ordering — each action requires its prerequisite artifact
  (`accept`→`recommend`, `bundles`→accepted config, `abtest`→`gateway`+
  `bundles`, `traffic`→`abtest`, `verdict`→`traffic`, `promote`/`canary`→
  `verdict`, `ramp`→`canary`). Re-running a completed action is ALLOWED
  (idempotent adopt) — that's the retry path.
- `GET /api/experiments/{id}` response gains `running_action` + `progress`.
  The page's list poll today is 8s (`EvaluationExperiment.tsx:178`); with an
  action in flight that cadence makes progress strings feel dead. Frontend
  polls the single experiment at 2.5s while `running_action` is set, falling
  back to the 8s list poll when idle.
- The create-endpoint 409 single-running-experiment guard stays (shared
  gateway constraint). "running" now means from creation to cleanup/failure,
  which matches the constraint's intent (one live experiment topology).

### 1.3 Service (`backend/app/optimization/service.py`)

- Delete `run_experiment_loop`. Add a generic runner:

```python
def run_action(exp_id: str, action: str, fn: Callable[[Progress], dict]) -> None:
    # sets running_action, wraps fn with progress(msg) → _update(progress=msg),
    # on success: _update(artifact={action: result}, stage=..., running_action=None)
    # on failure: _update(error=..., running_action=None)  # stage unchanged
```

- Existing stage fns get a `progress` callback param and emit the messages the
  UI shows (e.g. recommend: `"polling system-prompt recommendation (12/45)"`;
  gateway: `"waiting for gateway READY"`; traffic: `"sent 4/12 (0 failed)"` —
  mirrors agentxray's `gateway/traffic` job progress).
- `stage_recommend` — unchanged AWS flow, plus result keeps existing keys and
  adds nothing. **Accept** is a new pure-DB action: validates/normalizes the
  edited prompt + tool-descriptions JSON, writes
  `artifacts["recommend"]["accepted_prompt"|"accepted_tool_descriptions"]`,
  bumps `stage="recommend"`→ no; stage stays `recommend` until accept, then
  becomes... (see stage-transition table below).
- `stage_bundles(treatment_prompt=accepted or recommended)` — treatment uses
  the accepted config; `tool_descs` for the treatment bundle come from
  `accepted_tool_descriptions` (falling back to current hardcoded dict).
- `stage_traffic(dataset_id)` — resolves prompts: `None` → `TRAFFIC_PROMPTS*2`
  (current behavior); else load `EvalDataset`, extract prompts (legacy items:
  `item["prompt"]`; predefined items: first user turn content; `simulated`
  datasets rejected 422). Persists `{"dataset_id", "dataset_name"}` into the
  traffic artifact alongside sent/failed counts.
- `stage_verdict` — the current 900s polling loop, now emitting progress
  (`"aggregating · n=4 sessions"` style) and terminating via the same
  `compute_verdict` gate. Sets `status="ready"`.
- `action_canary/action_ramp/action_promote/action_cleanup` — logic unchanged;
  canary + cleanup move onto the async runner (they block for minutes in the
  worst case: target READY polling, resource teardown).

Stage-transition table (stage = furthest-completed marker, updated on action
success):

| action     | requires artifact      | sets stage | sets status |
|------------|------------------------|------------|-------------|
| recommend  | —                      | recommend  |             |
| accept     | recommend              | bundles*   |             |
| bundles    | recommend.accepted_*   | bundles    |             |
| gateway    | bundles                | gateway    |             |
| abtest     | gateway                | abtest     |             |
| traffic    | abtest                 | traffic    |             |
| verdict    | traffic                | verdict    | ready       |
| promote    | verdict                | promote    | promoted    |
| canary     | verdict                | canary     |             |
| ramp       | canary                 | ramp       |             |
| cleanup    | any                    | cleanup    | cleaned     |

\* `accept` doesn't create AWS resources; it marks the recommend card complete
and reveals the bundles card. The bundles card's own action then overwrites
stage with the same value — harmless.

Backward compat (R6/A8): old rows have all-stage artifacts and
`stage="verdict"|"cleanup"` etc. with `running_action` column NULL — every
card renders from its artifact key exactly as new rows do; `accepted_*`
absence means the bundles card shows the recommended prompt as treatment
(which is what the old pipeline did).

### 1.4 e2e script (`backend/scripts/e2e_experiment.py`)

Rewrite the walk: create → POST each action in order, polling
`GET /experiments/{id}` between async actions until `running_action` clears
(fail on `error`), with `accept` passing through the recommended prompt
verbatim and `traffic` exercising a dataset id when one exists.

## 2. Frontend (`frontend/src/pages/EvaluationExperiment.tsx`)

### 2.1 Structure

Keep the `?view=experiment&exp=` sub-page route and 2s polling. Rebuild the
body as progressive stage cards (agentxray render-gate pattern):

```
<HeaderCard/>                                  // name, status+stage badges, mono id strip
<RecommendCard/>                               // always
{reached("bundles")  && <BundlesCard/>}
{reached("gateway")  && <GatewayAbCard/>}      // gateway + abtest sub-steps in one card
{reached("traffic")  && <TrafficCard/>}
{reached("verdict")  && <VerdictCard/>}        // metrics bars + significance + promote
{reached("promote") || reached("canary") ? <CanaryCard/> : null}
<CleanupCard/>                                 // always available at bottom
```

`reached(s)` compares indices in the `stages` array the API already returns,
plus artifact presence for old rows. Active card = first card whose artifact
is missing → gets the accent highlight (existing `--warn`-style left border,
launchpad idiom).

### 2.2 New shared component: `ActionButton`

Launchpad-idiom port of `LiveRunButton`, but progress comes from the polled
experiment (`exp.running_action === action ? exp.progress : null`), not a
local closure — survives reload:

- idle → `Btn` with label; click → POST action (optimistic disable)
- running (`exp.running_action === action`) → disabled + spinner + mono
  progress line
- done (artifact exists) → the card renders the artifact echo instead of the
  button (agentxray "button → artifact echo" pattern)
- error (`exp.error` + no artifact) → danger note + `↻ retry` (re-POST)

### 2.3 Per-card contents

- **Recommend**: hint line (needs traces); ActionButton "GENERATE
  RECOMMENDATIONS"; result: side-by-side `DiffPanes` (new tiny component,
  `<pre>` pair, green border + CHANGED tag on the changed side), explanation
  text; while stage==recommend and artifact exists: textarea (prompt) +
  textarea (tool-descriptions JSON) prefilled, `ACCEPT & CONTINUE` button →
  POST accept.
- **Bundles**: CONTROL vs TREATMENT DiffPanes (current vs accepted prompt);
  ActionButton "CREATE BUNDLES"; echo `control: <id> @ <ver>` /
  `treatment: <id> @ <ver>` mono lines.
- **Gateway + A/B**: ActionButton "CREATE GATEWAY + ONLINE EVAL" then
  ActionButton "CREATE A/B TEST 50/50" (two sub-steps, second gated on
  first's artifact); echo `gw <id> · target <name> · ab <id>`.
- **Traffic**: `<select>` of datasets (`GET /api/evaluation/datasets`,
  filtered to kinds legacy/predefined, labeled `name (n items)`) with a
  "built-in demo prompts" default option; ActionButton "SEND TRAFFIC"; echo
  `sent N · failed M · dataset <name>`.
- **Verdict**: ActionButton "MONITOR RESULTS" with the aggregation hint
  (10–15 min note, 45s poll cadence); result: keep launchpad's existing
  verdict rendering (metric rows, insufficient/nonsig notes) and add
  per-metric bars (existing `split` bar idiom — no chart lib) + `p=… n=…` +
  significant/not pill per metric; promote button below (advisory verdict,
  offered once metrics exist — current semantics preserved).
- **Canary**: existing challenger select + START CANARY 90/10 + weights split
  bar + RAMP button, relocated into the card with the agentxray empty-state
  copy when no other active agent exists.
- **Cleanup**: existing confirm + result table, plus done note when
  status=cleaned.

Terminal/log collapse behavior: the existing stage-pipeline/terminal element
is dropped (superseded by per-card progress); the run-log data stays available
in artifacts if some evidence view needs it later.

### 2.4 i18n

All new strings under `expPage.*` in
`frontend/src/locales/{en,zh-CN}/common.json`; keep existing keys, add
`expPage.stage.*` card titles, action labels, hints, progress fallbacks,
dataset picker strings. zh-CN wording follows the deployed reference
(`推荐 System Prompt`, `创建网关 + 在线评估 + A/B 测试`, `发送流量`,
`监控结果`, `挑战者 AGENT`…).

## 3. Testing

- **Backend** (`backend/tests/optimization/`): extend the existing suite —
  action guard matrix (each action 409s without prerequisite, 409 while
  running_action set), accept persists edited config and bundles uses it,
  traffic dataset resolution (legacy/predefined/simulated/missing), runner
  success/failure persistence (running_action cleared, error stored, stage
  kept), old-artifact-shape rendering via `_out` (A8). AWS layer mocked as in
  existing tests (`test_bundles_abtest_shape.py` pattern).
- **Frontend**: there is NO committed frontend test runner (research
  confirmed — package.json has only dev/build/lint/preview). "Fetch-stub
  state testing" here means the project's established evidence pattern:
  drive the page via agent-browser with `window.fetch` stubbed to synthetic
  experiment states, screenshot each state. States to cover: fresh experiment
  (only recommend card), mid-action (`running_action` shows progress), accept
  flow, verdict card with metrics fixture (significant + not), canary
  weights, old-pipeline record fixture rendering all cards (A8). Introducing
  vitest is explicitly out of scope for this task.
- **e2e**: updated `e2e_experiment.py` against real AWS (A7); UI walkthrough
  via agent-browser for evidence.

## 4. Rollout / rollback

Single PR-sized change but staged commits: (1) backend actions + tests,
(2) frontend cards + i18n, (3) e2e script + docs/spec. No data migration; old
rows render through the same artifact keys. Rollback = revert; new columns
are additive and ignored by old code.

Spec: no experiment spec page exists today — author
`.trellis/spec/launchpad/experiment-stepwise.md` at wrap-up and add its row
to `.trellis/spec/launchpad/index.md` (step 3.3).

## 5. Open items folded from research

- agentxray persists job ids pre-poll but has no real resume; our
  server-side runner supersedes that (progress + result survive reload) — no
  job table needed since only one action runs per experiment at a time.
- Recharts not adopted; launchpad has no chart lib on this page and the
  split-bar idiom covers the two-metric comparison.
- `promote` offered regardless of significance (both codebases agree —
  advisory verdict).
