# Evaluation Sub-page Interaction (table + URL-param selection)

> Status: Active · 2026-07-14
> Files: `frontend/src/pages/EvaluationExperiment.tsx`,
> `frontend/src/pages/EvaluationRuntimeCanary.tsx`,
> `frontend/src/pages/EvaluationEvaluators.tsx`,
> `frontend/src/pages/EvaluationDatasets.tsx`, router
> `frontend/src/pages/Evaluation.tsx`

All three Evaluation sub-pages share one interaction shape (Experiment introduced it;
Evaluators/Datasets adopted it in task 07-13-eval-pages-experiment-layout):

1. Full-width table `Panel` (brk, `pad={false}`) on top — row click selects, selected row
   background `rgba(255,176,0,.045)`, `+ NEW …` primary `Btn` in the Panel `end`.
2. Selection lives in URL search params (linkable, back-button steps through selections).
3. Below: `eval-grid` two columns — left = detail/editor Panel, right = "how it works" Panel
   (numbered `kv` rows + note, same shape as `evalPage.newRun.how`).
4. No row-level action buttons — mutations (Delete / Sync / Save) live in the detail Panel
   (Delete/Sync in the Panel `end`, confirm via `ConfirmDialog`).

## URL contracts

| Page | param | values | default (no param) |
|------|-------|--------|--------------------|
| `?view=experiment` | `exp` | `<id>` \| `new` | `experiments[0]` |
| `?view=experiment&mode=canary` | `canary` | `<id>` \| `new` | `canaries[0]` |
| `?view=evaluators` | `ev` | `<evaluatorId>` (builtin or custom) \| `new` | first **custom** row, else create form |
| `?view=datasets` | `ds` | `<localId>` \| `cloud:<datasetId>` \| `new` | `rows[0]` (local), else create form |

- `setSearchParams` must always carry `view=…` — dropping it falls back to the runs dashboard.
- Experiment mode is URL-owned: no `mode` means Configuration A/B;
  `mode=canary` means Runtime Canary. Switching modes drops the other mode's
  selection and handoff params instead of retaining hidden state.
- Optional promotion handoff URL:
  `?view=experiment&mode=canary&canary=new&champion=<agentId>&sourceExp=<experimentId>`.
  It prefills the champion and source linkage only. If the operator changes
  champion, clear `sourceExp` from form state so create cannot submit a stale
  source/champion pair.
- `cloud:` prefix matches the runs-scope encoding (`Evaluation.tsx` CLOUD_VALUE_PREFIX).
- Unknown id → fall back to the default (never crash). Unresolved `cloud:` id while the cloud
  list loads → create form; do NOT fall back to a local row (would flash the wrong editor).
- After create: `await load()` then select the new id (`evaluator_id` from POST /evaluators;
  `id` from POST /datasets or POST `/runtime-canaries`). After delete: if the
  deleted id is the current param, clear it.

## Experiment workflow split (2026-07-14)

- The segmented control is navigation, not shared form state. Configuration
  A/B continues using `exp`; Runtime Canary uses `canary`.
- Configuration promotion may render a handoff button, but it only opens the
  separate Canary create form. It does not call a configuration action.
- Runtime Canary selectors render every active Agent: options with
  `canary_capability.eligible=false` stay visible and disabled with the
  backend-provided reason. The same Agent cannot be selected in both roles.
- The Canary table uses an internal horizontal scroll container with a stable
  minimum table width; mobile document width must remain viewport-bounded.
- Legacy `experiment.artifacts.canary` is read-only in Configuration A/B.
  Cleanup stays available because the configuration record still owns those
  historical resources.

## Editor rehydration — the one real gotcha

Selection is declarative, so the editor hydrates in a `useEffect`. Key that effect on a
**stable selection key**, never on row object identity:

- Evaluators: `useEffect(..., [selectedId])` — body fetches `/api/eval/evaluators/{id}` with a
  `cancelled` flag and resets draft/formError first.
- Datasets: `selKey` = `"new" | "local:<id>" | "cloud:<id>"` + a render-assigned
  `selRef.current = selection`; effect deps `[selKey]`, reads `selRef.current`.

**Why**: `save()`/`sync()` call `load()`, which replaces the rows array. If the effect depended
on the selection object (or `rows`), every refresh would rehydrate the editor and wipe unsaved
edits mid-typing. Same key ⇒ no rehydrate; key change (row switch) ⇒ full reset — both AC-tested
(no draft leak across rows, no wipe on sync).

## Dataset editor scenario types (2026-07-13)

The create form's SCENARIO EDITOR mode has a dataset-level type selector (create only —
kind is inferred server-side from the items and immutable after): MULTI-TURN (`turns`
scenarios, predefined/legacy) vs USER SIMULATION (devguide user-simulation.html personas).

- Simulated item shape (verified against the devguide): `{scenario_id, scenario_description?,
  actor_profile: {context, goal, traits?}, input, max_turns? (number, default 10, min 1),
  assertions?}` — NO turns / expected_response / expected_trajectory. `toSimItems` omits
  optional fields when empty and omits `max_turns` when it equals the default 10 (backend
  `simulation.py` applies `or 10`, so semantics are identical).
- Editing pins the editor to the row's kind (`activeType`); the sim drafts hydrate in the
  same `[selKey]` effect as everything else.
- **Mixed guard**: `kind === "simulated"` with any item lacking `actor_profile` (only
  reachable via JSON import) collapses the form to a warning note with no Save — the form
  editor can't represent those items and saving would silently drop them. Sync/Delete stay.
- Prefill is type-aware (`support-personas-sample` for simulated). Testids
  `type-predefined` / `type-simulated`.

## Read-only variants

- Builtin evaluators: detail panel is read-only (GET works on `Builtin.*`; PUT returns 400
  `evaluator.builtin_immutable`) — render no Save/Delete entry points; degrade to list-row info
  if the detail fetch fails.
- Cloud-only datasets: read-only kv detail + Delete only (cloud datasets are immutable
  snapshots; source of truth stays the local SQLite row).

## Testids (browser automation)

Rows `evaluator-row-<id>` / `dataset-row-<id>` / `dataset-row-cloud-<datasetId>` (colon avoided
in testids); create buttons `new-evaluator-btn` / `new-dataset-btn`; sync keeps `sync-<name>`.
Dashboard entry buttons `datasets-btn` / `evaluators-btn` / `experiment-btn` unchanged.

## Runs dashboard — insights re-run confirm (07-14)

`Evaluation.tsx` insights Panel `end` button (`insights-on-sessions-btn`, "洞察 · 这些会话"):

- Disabled while an insights run over the **same sorted session_ids set** is queued/running
  (`insightsPending` — the account batch lock would just queue a duplicate).
- Click → `ConfirmDialog`. Body is picked by `insightsAlreadyRan` (a **completed**
  insights run over the same session set exists — an insights-mode selected run matches
  itself): `evalPage.insights.confirmRun.bodyRepeat` warns the same analysis will run
  **one more time** (new run row, evaluation service re-invoked, extra usage); otherwise
  the original `confirmRun.body` (new run + queue note). Keys exist in zh-CN and en.
