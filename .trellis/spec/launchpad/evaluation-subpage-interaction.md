# Evaluation Sub-page Interaction (table + URL-param selection)

> Status: Active · 2026-07-13
> Files: `frontend/src/pages/EvaluationExperiment.tsx` (reference), `frontend/src/pages/EvaluationEvaluators.tsx`, `frontend/src/pages/EvaluationDatasets.tsx`, router `frontend/src/pages/Evaluation.tsx`

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
| `?view=evaluators` | `ev` | `<evaluatorId>` (builtin or custom) \| `new` | first **custom** row, else create form |
| `?view=datasets` | `ds` | `<localId>` \| `cloud:<datasetId>` \| `new` | `rows[0]` (local), else create form |

- `setSearchParams` must always carry `view=…` — dropping it falls back to the runs dashboard.
- `cloud:` prefix matches the runs-scope encoding (`Evaluation.tsx` CLOUD_VALUE_PREFIX).
- Unknown id → fall back to the default (never crash). Unresolved `cloud:` id while the cloud
  list loads → create form; do NOT fall back to a local row (would flash the wrong editor).
- After create: `await load()` then select the new id (`evaluator_id` from POST /evaluators;
  `id` from POST /datasets). After delete: if the deleted id is the current param, clear it.

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
