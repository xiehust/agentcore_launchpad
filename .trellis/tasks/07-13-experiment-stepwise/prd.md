# PRD — Experiment step-by-step interactive flow (agentxray Live parity)

## Background / requirement source

The experiments module (`/evaluation?view=experiment&exp=…`) currently runs six
stages (`recommend → bundles → gateway → abtest → traffic → verdict`) in one
automatic background thread; the user only watches the pipeline scroll and can
act after the verdict (promote / canary / ramp / cleanup).

User request (2026-07-13): the experiment flow should surface more step-by-step
process and let the user participate in the steps. Reference: the **Live on
AWS console** of `/home/ubuntu/workspace/agentxray` (also deployed at
https://d3qnw1rhjyi9ke.cloudfront.net/). Confirmed via AskUserQuestion:
**full agentxray-parity interaction depth** — every stage manually triggered,
recommendations editable, challenger pick, manual ramp; backend split into
per-stage actions with per-action persistence and resume.

## Requirements

- **R1 Stage-card flow.** The experiment detail page renders one card per
  stage, progressively revealed (later stages hidden until reached), with the
  active stage visually highlighted. Completed stages stay visible with their
  results.
- **R2 User-triggered stages.** No monolithic auto pipeline. Each stage runs
  only when the user clicks its action button:
  - **Recommend** — user triggers recommendation generation; sees a
    before/after diff of current vs recommended system prompt (and tool
    descriptions where applicable); can **edit** the recommendation in-place;
    explicit **Accept** advances to the next stage.
  - **Bundles** — user triggers creation of control/treatment config bundles
    from the accepted config.
  - **A/B test** — user triggers gateway + config-bundle A/B test creation;
    user triggers traffic send; monitoring shows live progress until results
    aggregate; verdict rendered with existing significance semantics.
  - **Promote** — user decision (kept), offered per verdict semantics.
  - **Canary** — user picks a challenger agent (experiment's own agent
    excluded), starts 90/10, ramps manually 10 → 50 → 100.
  - **Cleanup** — user-triggered, with confirmation (kept).
- **R3 Per-action progress feedback.** Every long-running action shows a
  running state with streaming progress messages (agentxray `LiveRunButton`
  pattern), not a frozen button.
- **R4 Persist + resume.** Every action persists its artifacts and stage
  transition server-side immediately on completion. Reloading the page or
  restarting the backend resumes the experiment at its current stage with all
  prior results visible.
- **R5 i18n.** All new strings in both `en` and `zh-CN` locales.
- **R6 Backward compatibility.** Experiments already created/completed under
  the old auto pipeline must still render correctly (artifacts from old runs
  map onto the stage cards; no crashes on old artifact shapes).
- **R7 Preserve semantics.** Verdict significance semantics, the
  insufficient/non-significant advisory notes, and cleanup result table are
  preserved (relocated into their stage cards as needed).

## Constraints

- Port agentxray's **interaction patterns**, not its visual design: reuse
  launchpad's existing UI idiom (`Btn`, `note`, `mono`, split bars, existing
  page styling in `EvaluationExperiment.tsx`).
- Backend stays FastAPI + SQLite `Experiment` model; keep the idempotent AWS
  helper pattern (`create_*_idempotent`, `_is_conflict`) so re-clicking a
  stage button never double-creates AWS resources.
- Long AWS operations must not block request handlers — background execution
  with status polling.
- One A/B test per gateway constraint remains (stop bundle test before canary
  test).
- `backend/scripts/e2e_experiment.py` must be updated to drive the new
  per-stage flow end to end.

## Acceptance criteria

- **A1** Creating a new experiment performs no AWS-mutating stage work until
  the user triggers stage 1; the page lands on the recommend stage card.
- **A2** Each stage card: trigger → visible progress → persisted result
  rendering. Killing/reloading the page mid-stage and reopening the experiment
  shows the correct current stage and prior results.
- **A3** Recommend stage shows current-vs-recommended diff, allows editing the
  recommendation text before Accept, and the accepted (possibly edited) config
  is what the bundles stage uses.
- **A4** Verdict card reproduces existing semantics (significant / non-sig /
  insufficient) and gates promote accordingly.
- **A5** Canary card: challenger dropdown excludes the experiment agent;
  START CANARY 90/10 → RAMP to 50 → RAMP to 100; weights bar reflects each
  stage.
- **A6** All new UI strings exist in `en` and `zh-CN`; backend tests cover the
  new stage/action state machine; the new page states are verified via the
  project's fetch-stub browser evidence flow (no frontend test runner exists —
  adding one is out of scope); existing optimization tests updated, backend
  suite passes.
- **A7** `e2e_experiment.py` exercises the full new flow against real AWS and
  is the documented demo path.
- **A8** An old-pipeline experiment record (verdict-complete artifacts, no new
  fields) renders without errors and still offers promote/canary/cleanup.

## Out of scope

- The agentxray simulation wizard (`src/steps/`) — only the Live console is
  the reference.
- Agent code editing / dataset management consoles from agentxray — launchpad
  has its own equivalents.
- Changing the underlying AWS experiment topology (gateway type, A/B variant
  shapes, online-eval wiring stays as is).
