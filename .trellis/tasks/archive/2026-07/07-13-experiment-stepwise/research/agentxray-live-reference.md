# Research: agentxray "Live on AWS" step-by-step experiment console (reference for Launchpad port)

- **Query**: Replicate agentxray's step-by-step, user-participating experiment UX (the Live console `ExperimentsPage`) inside AgentCore Launchpad. Document stage machine, per-stage user actions, job-polling contract, supporting components, backend contract, i18n, verdict/promote.
- **Scope**: internal (read-only reference repo `/home/ubuntu/workspace/agentxray`)
- **Date**: 2026-07-13

> All paths below are inside `/home/ubuntu/workspace/agentxray` unless noted.

---

## 0. Where the console lives / how it's reached

- `src/console/ConsoleShell.tsx` — the Live-mode frame. A `PAGES` record maps `ConsoleSection → page component`; `experiments: ExperimentsPage` (`ConsoleShell.tsx:36`). Section chosen by left-nav `dispatch({type:"GO_SECTION", section})`. **NOT** a `?view=` sub-route like Launchpad — it's one of 7 flat console sections (`agents, datasets, evaluators, runs, insights, experiments, cleanup`), persisted to `localStorage["lab4.consoleSection"]`.
- Navigation state store: `src/state/console.ts` — tiny Context+useReducer. Relevant action: `{type:"OPEN_EXPERIMENT", experimentId}` toggles `state.viewingExperimentId`. `ExperimentsPage` renders `ExperimentDetail` when set, else `ExperimentList` (`ExperimentsPage.tsx:24-35`). `GO_SECTION` clears `viewingExperimentId` (leaving the section closes the detail view).
- Server data is **not** in the store — every page fetches via `useResource` (`src/lib/useResource.ts`): fetch-on-mount + manual `reload()` (a `tick` counter forces the effect to re-run). Returns `{data, loading, error, reload}`.

---

## Findings

### Files Found

| File Path | Description |
|---|---|
| `src/console/pages/ExperimentsPage.tsx` | **The whole feature** (935 lines): list/create + `ExperimentDetail` + 4 stage components + `monitorAbTest` + `putArtifacts` helper |
| `src/lib/liveApi.ts` | Typed API client + all record types: `ExperimentStage`, `EXPERIMENT_STAGES`, `ExperimentArtifacts`, `ExperimentRecord`, `ABTestMetric`, `AgentRecord`, `legacyItems`, `LiveApi` class w/ `pollJob` |
| `src/lib/abVerdict.ts` | `promoteVerdict(metrics)` + `verdictSentence(v,t)` + `fmtPct` — the A/B verdict interpretation |
| `src/lib/experimentNames.ts` | Deterministic AWS-resource names from experiment id (satisfies service name regexes) |
| `src/components/LiveRunButton.tsx` | **Key port target**: real-async button w/ idle/running/done/error phases + live progress string + retry |
| `src/components/AsyncRunButton.tsx` | Sim-wizard sibling: staged progress list (framer-motion), driven by `sim/engine` (NOT used in the live console) |
| `src/components/DiffView.tsx` | Side-by-side before/after panes; "after" highlighted green when changed |
| `src/components/LazyABChart.tsx` + `ABComparisonChart.tsx` | Recharts grouped-bar (control vs treatment) + per-evaluator significance rows; lazy-loaded |
| `src/components/ui/{Card,Badge,Button}.tsx` + `index.ts` | Primitives (Tailwind styling system) |
| `src/components/StepShell.tsx` | Frame for the **sim wizard** (linear stepper) — different feature; see §6 |
| `src/state/console.ts` | Console nav store (`OPEN_EXPERIMENT`, `GO_SECTION`) |
| `src/lib/useResource.ts`, `src/lib/useLiveApi.ts` | Data-fetch hook + API-client hook (base URL + creds from journey state) |
| `backend/app/routers/experiments.py` | Experiment CRUD (thin — frontend orchestrates stages) |
| `backend/app/routers/recommend.py` | `/recommend/system-prompt`, `/recommend/tool-descriptions` (background jobs) |
| `backend/app/routers/bundles.py` | `/bundles` create/read/version/compare (synchronous) |
| `backend/app/routers/abtest.py` | `/gateway/setup`, `/gateway/traffic`, `/abtest/config-bundle`, `/abtest/target`, `/abtest/target-setup`, `GET /abtest/{id}`, `/abtest/{id}/weights` |
| `backend/app/jobs.py` | Background-job store + `GET /api/jobs/{id}` poll endpoint |
| `backend/app/models.py` | Pydantic request/response models incl. `EXPERIMENT_STAGES`, `ExperimentUpdateRequest` |
| `backend/app/db.py` (601-708) | SQLite experiment rows; `update_experiment` **shallow-merges** artifacts under a lock |
| `backend/app/agentcore.py:507` | `normalize_ab_results` → maps `get_ab_test` into the `ABTestMetric` chart shape |
| `src/i18n/messages.ts` | `t.console.experiments.*` (en @1699, zh @2731) + `t.verdict.*` (en @1391, zh @2428) |

---

### 1. The stage state machine

**Type + ordered list** (`src/lib/liveApi.ts:311-330`):

```ts
export type ExperimentStage =
  | "recommend" | "bundles" | "abtest" | "monitor"
  | "promoted" | "canary" | "canary_monitor" | "done";

export const EXPERIMENT_STAGES: ExperimentStage[] = [
  "recommend","bundles","abtest","monitor",
  "promoted","canary","canary_monitor","done",
];
```

Mirrored verbatim on the backend as a tuple in `backend/app/models.py:311-320`.

**Key insight — `stage` is a "furthest-reached" pointer, not a strict cursor.** The 8 stages collapse into **4 visible stage Cards** on the detail page. Progressive rendering is done by comparing the ordinal of the current stage against the ordinal at which each card first appears:

`ExperimentsPage.tsx:37-39`
```ts
function stageIndex(stage: ExperimentStage): number {
  return EXPERIMENT_STAGES.indexOf(stage);
}
```

`ExperimentDetail` render gate (`ExperimentsPage.tsx:249, 277-285`):
```ts
const idx = stageIndex(exp.stage);
<RecommendStage ctx={ctx} />                                      // always
{idx >= stageIndex("bundles") && <BundlesStage ctx={ctx} />}
{idx >= stageIndex("abtest")  && <AbTestStage ctx={ctx} />}       // covers abtest+monitor
{idx >= stageIndex("promoted")&& <CanaryStage ctx={ctx} />}      // covers promoted+canary+canary_monitor
{exp.stage === "done" && <Card>…done…</Card>}
```

**Active-stage highlighting** — each stage Card sets `accent={active ? "orange" : "none"}` where `active` = the stage(s) that card owns is the current one:
- Recommend: `active = exp.stage === "recommend"` (`:298`)
- Bundles: `exp.stage === "bundles"` (`:478`)
- AbTest: `active = exp.stage === "abtest" || exp.stage === "monitor"` (`:601`)
- Canary: `active = exp.stage === "promoted" || "canary" || "canary_monitor"` (`:811`)

The orange left-edge accent bar (`Card` accent) is the only "you are here" affordance; the list view + detail header also show a `Badge` colored via `STAGE_VARIANT` (`ExperimentsPage.tsx:41-50`): `recommend→neutral, bundles→cyan, abtest/monitor/canary*→warn, promoted/done→ok`.

**Header** (`:253-275`) shows name + stage Badge + Back button, and a mono ID strip echoing accumulated artifact ids (`agentName`, `runtimeArn`, `gatewayId`, `bundleAbTestId`, `targetAbTestId`).

**How artifacts persist + resume** — the single helper (`ExperimentsPage.tsx:189-197`):
```ts
async function putArtifacts(ctx, artifacts, stage?) {
  await ctx.api.updateExperiment(ctx.exp.id, { artifacts, ...(stage ? { stage } : {}) });
  ctx.reload();
}
```
`artifacts` is the open bag `ExperimentArtifacts` (`liveApi.ts:350-392`) — ~45 optional fields (job ids, resource ids/arns, bundle ids+versions, metrics arrays, weights, counts). **Job ids are persisted BEFORE polling** (comment at `liveApi.ts:348-349`, and e.g. `:317` writes `recommendSpJobId` before `pollJob`), so a page reload can in principle resume an in-flight job. A stage bump is passed only when a stage's terminal action succeeds (`accept()`→"bundles", `createBundles`→"abtest", `sendTraffic`→"monitor", `promote`→"promoted", target-setup→"canary", canary traffic→"canary_monitor", finish→"done").

---

### 2. Per-stage user-interaction inventory

Each stage Card mixes: (a) `LiveRunButton`s that fire real backend ops, (b) editable inputs, (c) read-only ID/metric displays that appear once the artifact exists (idempotent re-entry). A completed sub-step swaps its button for a static mono ID line or a Badge — the pattern is "**button while pending → artifact echo once done**".

#### Stage 1 — RecommendStage (`ExperimentsPage.tsx:291-433`)
- Hint text: recommendations analyze CloudWatch traces → run an eval first (`recommend.hintNeedsTraces`).
- Optional warn banner if `usedFallbackSp || usedFallbackTd` (service returned no rec, showing current value).
- **Two buttons** (`LiveRunButton`, secondary): "Recommend system prompt" → `runSp`, "Recommend tool descriptions" → `runTd`. Each: POST recommend endpoint → persist job id → `api.pollJob` (progress piped to button) → persist `recommendedSystemPrompt` / `recommendedToolDescriptions` + `usedFallback*`.
- **DiffView** shown once a recommendation exists: current vs recommended system prompt (`:391-400`); current vs recommended tool descriptions as pretty JSON (`:401-410`).
- **User-editable inputs** (only while `active` and a rec exists, `:412-430`): a `<textarea rows=5>` pre-filled with `acceptedSp` (edited ?? recommended ?? current), and a `<textarea rows=5 spellCheck=false>` pre-filled with the tool-descriptions JSON. Local state `editedSp`/`editedTd` (`useState<string|null>`).
- **"Accept & continue"** `Button` → `accept()` (`:352-364`): JSON.parse the TD textarea (falls back to recommended/current on parse error), persist `acceptedSystemPrompt` + `acceptedToolDescriptions`, bump stage→`bundles`.

#### Stage 2 — BundlesStage (`ExperimentsPage.tsx:436-502`)
- Note: bundles only take effect if agent code reads `BedrockAgentCoreContext.get_config_bundle()`.
- **DiffView**: control (current system prompt) vs treatment (accepted system prompt).
- If not yet created: one **`LiveRunButton`** "Create control + treatment bundles" → `createBundles` (`:444-475`): `onProgress("creating control bundle")`, `api.createBundle(control)`, `onProgress("creating treatment bundle")`, `api.createBundle(treatment)`, persist the 4 bundle id/version artifacts, bump stage→`abtest`. Progress here is **manual string emission** (not job polling — createBundle is synchronous).
- Once created: static mono line echoing `control: <id> @ <ver>` / `treatment: <id> @ <ver>`.

#### Stage 3 — AbTestStage (`ExperimentsPage.tsx:505-690`) — 4 numbered sub-steps in one card
- **① Setup** (`:605-612`): if no `bundleAbTestId`, `LiveRunButton` "Create gateway + online eval + A/B test" → `setup` (`:514-558`). Chains TWO awaited ops in one run: `gatewaySetup` (job → poll → persist gateway/target/eval ids) then `abtestConfigBundle` (sync → persist `bundleAbTestId`). Once done: mono line `gw <id> · target <name> · A/B <id>`.
- **② Traffic** (`:614-638`): a `<select>` of datasets (`api.listDatasets`) + `LiveRunButton` "Send traffic" → `sendTraffic` (`:560-575`): maps `legacyItems(dataset)` to `{prompt,context}`, POST `gateway/traffic` job → poll → persist `gwTrafficCount`, bump stage→`monitor`. Button `doneLabel` shows `✓ <count>`. Warn if no datasets.
- **③ Monitor** (`:640-669`): shows only after traffic (`gwTrafficCount !== undefined || metrics`). Aggregation hint. If no metrics yet, `LiveRunButton` "Monitor results" → `monitor` → `monitorAbTest(...)` (see §1c below) → persist `bundleMetrics` + `bundleAnalysisAt`. Once metrics: `LazyABChart` + a **verdict banner** (colored win/loss/mixed, see §5).
- **④ Promote** (`:671-687`): shows only once metrics exist. If already promoted: `Badge ok` "Promoted @ <versionId>". Else `LiveRunButton` "Promote treatment to control bundle" → `promote` (`:583-595`): `api.updateBundle(controlBundleId, {…accepted prompt/tools, parentVersionIds:[controlVersion]…})`, persist `promotedVersionId`, bump stage→`promoted`.

#### Stage 4 — CanaryStage (`ExperimentsPage.tsx:693-934`) — optional target-routing rollout
- **Challenger picker** (`:822-849`, shown until `targetAbTestId`): `<select>` of *other* deployed agents (`x.deployment.status==="deployed" && x.id !== exp.agentId`). `onChange` → `pickChallenger(id)` immediately persists `challengerAgentId` server-side + reloads. Once a challenger is picked, a `LiveRunButton` "Add challenger target + target A/B (90/10)" → `setup` (`:723-760`): `abtestTargetSetup` job → poll → persist v2 target/eval ids + `targetAbTestId` + `weights:{control:90,treatment:10}`, bump stage→`canary`.
- After setup: mono line `challenger <name> · target <v2> · A/B <id>`.
  - **Traffic** (`:857-875`): dataset `<select>` + "Send traffic" → `sendTraffic` (`:762-777`, same shape as stage 3 but through the v2 target) → persist `targetTrafficCount`, bump→`canary_monitor`.
  - **Monitor** (`:877-893`): "Monitor results" → `monitor` → `monitorAbTest` on `targetAbTestId` → persist `targetMetrics`+`targetAnalysisAt` → `LazyABChart` (labels "v1 (champion)" / "v2 (challenger)").
  - **Weights / rollout** (`:895-913`, shown once `targetMetrics`): a cyan Badge "Challenger traffic: {w}%" + buttons for the other values in `[10,50,100]` → `shiftWeight(w)` (`:785-802`): `api.setWeights(targetAbTestId, {controlWeight:100-w, treatmentWeight:w, variants:[{C…},{T1…}]})`, update local `weight` + persist `weights`. This is the **live traffic-shift knob**.
- **Finish row** (`:917-931`): `Button` "Experiment complete" (or "Finish without canary" if no target A/B) → `finish()` sets stage→`done`; plus a ghost "Go to Cleanup →" that `dispatch({type:"GO_SECTION", section:"cleanup"})`.
- Local `error` state rendered as a `role="alert"` banner; `shiftWeight`/`pickChallenger` set it on failure.

#### 1c. `monitorAbTest` polling helper (`ExperimentsPage.tsx:199-224`)
Separate from `pollJob` — this polls the **A/B test resource** (not a job):
```ts
async function monitorAbTest(api, abTestId, onProgress) {
  const deadline = Date.now() + 25*60*1000;         // 25-min cap
  for (;;) {
    const res = await api.getAbTest(abTestId);
    onProgress(`status ${res.status} / ${res.executionStatus}${res.analysisTimestamp ? " · analyzed" : " · aggregating"}`);
    if (res.analysisTimestamp && res.metrics?.length) return { metrics, analysisTimestamp };
    if (Date.now() > deadline) throw new Error("A/B results not ready within 25 minutes");
    await new Promise(r => setTimeout(r, 30_000));    // poll every 30s
  }
}
```

---

### 3. Supporting components (enough to re-create under a different styling system)

**`LiveRunButton<T>`** (`src/components/LiveRunButton.tsx`) — the single most reusable pattern:
- Props: `label`, `doneLabel="Complete"`, `run: (onProgress:(msg:string)=>void)=>Promise<T>`, `onComplete?`, `variant`, `className`.
- Internal `phase: "idle"|"running"|"done"|"error"` + `progress` string + `error` string + a `busy` ref (guards double-fire).
- `start()`: guard → set running/clear → `await run(setProgress)` → `done` (+`onComplete`) OR catch → `error`.
- Render: a `Button` disabled while running/done, `aria-busy` while running. Face text is phase-driven: idle=`label`; running=spinner + "Running…"; done=`${doneLabel} ✓`; error=`↻ Retry` (clicking retries). While running + progress, a mono progress span renders beside it. On error, a `role="alert"` danger box shows the message. **Progress is a free-form string** set by the async body (either from `pollJob` progress or manual `onProgress("…")` calls).

**`AsyncRunButton<T>`** (`src/components/AsyncRunButton.tsx`) — the **simulation** sibling (not used in the live console). Takes a `stages: SimStage[]` list, calls `simulateAsync(stages,{speed,onProgress})` from `src/sim/engine`, and animates a per-stage checklist (framer-motion `AnimatePresence`) with pending/running/done dots + optional per-stage `terminal` text. Same idle/running/done phase + double-fire guard, plus `allowRerun`. Port target only if you want the *fake* staged animation; the live UX uses `LiveRunButton`.

**`DiffView`** (`src/components/DiffView.tsx`): props `before, after, beforeLabel="Before", afterLabel="After", stacked?, className`. `changed = before.trim() !== after.trim()`. Renders two `DiffPane`s in a `md:grid-cols-2` grid (or stacked). The "after" pane gets a green (`ok`) border/bg + a "changed" tag when different, else neutral. Panes are `<pre>` with `whitespace-pre-wrap`, `max-h-80 overflow-auto`, mono. No token-level diffing — intentionally a simple panel diff.

**`ABComparisonChart`** (`src/components/ABComparisonChart.tsx`, lazy-wrapped by `LazyABChart.tsx`): Recharts grouped `BarChart` (control gray `#5d6a80` vs treatment orange `#ff9900`), Y domain `[0,1]`, label lists on bars, plus a legend and a **per-evaluator significance row list** (`:83-120`): each row shows `label`, signed `percentChange` (green/red), `p = <pValue>`, `n = <controlN>/<variantN>`, and a `Badge` "significant"/"not significant" (ok/warn). Reads `ABMetric[]` (same shape as `ABTestMetric`). `LazyABChart` wraps it in `Suspense` with a "Loading chart…" fallback (keeps Recharts out of the initial bundle).

**UI primitives** (`src/components/ui/`):
- `Card` — titled panel; props `eyebrow, title, action, accent("orange"|"cyan"|"danger"|"none")`. Renders a left-edge accent bar via `before:` pseudo-element; header has eyebrow + title (left) and `action` slot (right). This is the workhorse container — every stage is a `Card`.
- `Badge` — pill; `variant(neutral|orange|cyan|ok|warn|danger|info)`, `dot`, `pulse`, `mono`. Used for stage status + significance + weights.
- `Button` — `variant(primary|secondary|ghost|danger)`, `size(sm|md)`, `icon`; renders a real `<button>`; disabled/aria-busy handled by callers. Primary = orange.
- Styling system = **Tailwind with a custom palette** (`ink-*`, `fog-*`, `aws-orange`, `cyan`, `ok/warn/danger`, `line`, `eyebrow` utility class, `panel-glow`, `animate-pulse-dot`). A port to a different design system must remap these tokens but the component contracts (props/phases) carry over 1:1.

**`StepShell`** (`src/components/StepShell.tsx`) — the frame for the **sim wizard** (linear 9-11 step `Stepper` + code-view toggle + credentials panel), NOT the experiments console. Included for completeness; the console uses `ConsoleShell` instead. Do not confuse the two.

---

### 4. Backend contract

**Architecture**: `backend/app/main.py` (110 lines) is just the FastAPI app factory + `include_router(...)` for ~16 routers; every router uses `prefix="/api"`. The frontend calls them via `src/lib/liveApi.ts` (`class LiveApi`, default base `/api`, proxied to FastAPI in dev). Errors: non-2xx → `LiveApiError(detail,status)` (reads `{detail}` from body).

**Background-job pattern** (`backend/app/jobs.py`):
- `create_job()` → uuid hex, stores `JobStatus(id,state="pending")` in an in-memory dict *and* SQLite (`db.upsert_job`).
- `run_job(job_id, fn)` runs `fn(progress)` on a **daemon thread**; `fn` receives a `progress(msg)` callback that writes `job.progress`. Return value → `state="completed", result=…`; any exception → `state="failed", error="<Type>: <msg>"` (never crashes the server).
- `start_job(fn)` = create + run → returns `jobId`. Long-op endpoints return `JobRef{jobId}` immediately.
- `GET /api/jobs/{id}` (`jobs.py:101`) → `JobStatus{id, state("pending"|"running"|"completed"|"failed"), result?, error?, progress?}`. On cache miss (after restart) it rehydrates from SQLite. This is what the frontend `LiveApi.pollJob` (`liveApi.ts:743-770`) drives: poll every 2s (20-min cap), calls `onProgress(job)` each tick, resolves `job.result` on completed, throws on failed/timeout.

**Which ops are jobs vs synchronous**:
- **Jobs (return `{jobId}`, poll)**: `/recommend/system-prompt`, `/recommend/tool-descriptions`, `/gateway/setup`, `/gateway/traffic`, `/abtest/target-setup`. (Also `/deploy`, `/traffic`, `/evaluate`, `/runs`, `/insights`, dataset sync, telemetry-check.)
- **Synchronous (return result directly)**: `/bundles`, `/bundles/{id}/version`, `/abtest/config-bundle`, `/abtest/target`, `GET /abtest/{id}`, `/abtest/{id}/weights`, all `/experiments` CRUD.

**Endpoints used by the experiment flow**:
- `POST /recommend/system-prompt` (`recommend.py:27`) → job → `{recommendationId, status, recommendedSystemPrompt, usedFallback}`. Falls back to the current prompt on service error/empty.
- `POST /recommend/tool-descriptions` (`recommend.py:60`) → job → `{recommendationId, status, recommendedToolDescriptions:{name→desc}, usedFallback}`.
- `POST /bundles` (`bundles.py:31`) → `{bundleId, versionId, bundleArn?}`. `POST /bundles/{id}/version` (`:55`, used for promote) → `{bundleId, versionId, bundleArn?}`.
- `POST /gateway/setup` (`abtest.py:193`) → job → `{gatewayId, gatewayArn, targetId, onlineEvalArn, onlineEvalId, roleArn}`. Creates gateway + v1 target + online-eval, polls each to READY; **idempotent** — adopts existing by name on `ConflictException` (so a retried partial setup succeeds).
- `POST /gateway/traffic` (`abtest.py:297`) → job → `{sessionIds, count, failed}`. SigV4-signs and POSTs each prompt to `{gatewayUrl}/{target}/invocations` (must enter via gateway so the A/B test routes it). Progress: `sent i/N (f failed)`.
- `POST /abtest/config-bundle` (`abtest.py:325`) → `{abTestId, variants}`. Resolves bare bundle ids to ARNs, creates the A/B test (idempotent by name).
- `POST /abtest/target-setup` (`abtest.py:443`) → job → `{targetIdV2, onlineEvalArnV2, onlineEvalIdV2, abTestId}`. Adds v2 target + v2 online-eval, stops the bundle A/B test, creates the target A/B test (reuses the step-3 gateway).
- `GET /abtest/{id}` (`abtest.py:457`) → `{abTestId, status, executionStatus, analysisTimestamp, metrics:[ABTestMetric]}`. `metrics` via `agentcore.normalize_ab_results` (`agentcore.py:507`) which maps `results.evaluatorMetrics[]` → `{evaluatorId,label,control:{name,mean,sampleSize},variants:[{name,mean,sampleSize,pValue,percentChange,isSignificant}]}`.
- `POST /abtest/{id}/weights` (`abtest.py:470`) → `{abTestId, updated, status}`. Pauses a RUNNING test (polls until PAUSED), updates variant weights, resumes.

**ExperimentRecord shape + stage persistence — server vs frontend**:
- CRUD is **deliberately thin** (docstring `experiments.py:1-3`): "the frontend orchestrates each stage by calling the existing recommend/bundles/gateway/abtest endpoints and persisting job ids + results into the experiment's artifacts blob." **The server does NOT drive stage transitions or call AWS on behalf of an experiment.** All orchestration + stage bumps happen in the frontend via `putArtifacts`.
- `POST /experiments` (`experiments.py:34`) requires the agent to be `deployed` (400 otherwise); creates a row at stage `recommend`, artifacts `{}`. `PUT /experiments/{id}` (`:54`) validates `stage ∈ EXPERIMENT_STAGES` (422), resolves `challengerAgentId`→name, and **shallow-merges** `artifacts`.
- Row shape (`db.py:601-614`, `_experiment_row_to_dict`): `{id,name,agentId,agentName,challengerAgentId,challengerAgentName,stage,artifacts,error,createdAt,updatedAt}` — matches TS `ExperimentRecord` (`liveApi.ts:394-406`).
- **Shallow merge under a lock** (`db.py:657-700`): `artifacts = {**current, **incoming}` inside the module `_lock`, so concurrent stage writes can't clobber each other. This is why the frontend can `putArtifacts` a *partial* patch (e.g. just `{recommendSpJobId}`) without losing prior fields.

---

### 5. Verdict / significance display + how promote is offered

- `src/lib/abVerdict.ts`:
  - `promoteVerdict(metrics)` (`:27-39`) → `{status:"win"|"mixed"|"loss", improvedCount, total, significant, summary}`. Higher mean = better; `percentChange > 0` counts as improved. `win` = all improved, `loss` = none, else `mixed`. `significant` = any *improved* metric is statistically significant. `summary` = e.g. `"GoalSuccessRate +2.1%, Helpfulness −7.9%"` (uses real minus sign via `fmtPct`).
  - `verdictSentence(v, t)` (`:43-55`) → localized lead sentence pulling from `t.verdict.*` (win/loss/mixed templates + significance tail).
- Rendered in AbTestStage (`ExperimentsPage.tsx:655-667`): a bordered banner colored by status — win→`ok`, loss→`danger`, mixed→`warn` — containing `verdictSentence`. Sits directly under the `LazyABChart`.
- **Promote is offered unconditionally once metrics exist** (`:672`, gated on `metrics` truthy, not on `verdict.status`). The verdict banner is advisory only — the user decides. Promote button → `promote()` → `updateBundle` on the control bundle, stage→`promoted`, then the CanaryStage appears.
- i18n `t.verdict.*` (`messages.ts` en@1391, zh@2428): `win/loss/mixed` template fns, `bothMetrics/allMetrics(n)/eitherMetric/anyMetric` scope phrases, `significant`/`notSignificant` tails.

---

### 6. i18n structure

- `src/i18n/messages.ts` (136 KB) exports `en` and `zh` (both typed `Messages`), plus `Messages` interface. `src/i18n/lang.ts` + `index.tsx` provide `useLang()` → `{t, lang, setLang}`; `LangToggle`.
- Experiment console strings live at `t.console.experiments.*`:
  - **en**: `messages.ts:1699-1773`. **zh**: `messages.ts:2731` (parallel structure). Interface decl for the block: `messages.ts:643`.
  - Sub-objects: `stages{recommend,bundles,abtest,monitor,promoted,canary,canary_monitor,done}`, `recommend{title,hintNeedsTraces,spBtn,tdBtn,usedFallback,currentLabel,recommendedLabel,acceptBtn,editHint}`, `bundles{title,controlLabel,treatmentLabel,createBtn,hookNote}`, `abtest{setupTitle,setupBtn,trafficTitle,pickDataset,noDatasets,sendBtn,monitorTitle,monitorBtn,aggregationHint,controlLabel,treatmentLabel,promoteTitle,promoteBtn,promoted}`, `canary{title,skipBtn,pickChallenger,noChallenger,setupBtn,trafficTitle,monitorTitle,v1Label,v2Label,weightsTitle,setWeight(w),currentWeight(w),rolloutHint}`, plus top-level `title,eyebrow,empty,createTitle,namePlaceholder,pickAgent,noConfigWarning,create,open,resume,resumeHint,doneTitle,doneBody,goCleanup`.
  - Some values are **functions** (interpolation): `setWeight(w)`, `currentWeight(w)`, and in `t.console.datasets.itemCount(n)`. Ports must preserve these as callables, not plain strings.
- `t.verdict.*` (top-level, not under console): en@1391, zh@2428.

---

## Caveats / Not Found

- The **simulation wizard** (`src/steps/Step5Recommend..Step9Cleanup.tsx`, framed by `StepShell`) is a *separate* linear 9–11-step guided tour using `AsyncRunButton` + `simulateAsync` (fake staged progress, `FAKE_ACCOUNT_ID`, no real AWS). The **live console `ExperimentsPage`** is the real thing: single detail page, 4 progressively-revealed stage Cards, `LiveRunButton` firing real backend jobs, artifacts persisted to SQLite. Port the console, not the wizard. (Per task instructions, the wizard was not deep-dived.)
- Resume UX: strings `experiments.resume`/`resumeHint` exist in i18n and job ids are persisted-before-poll, but `ExperimentsPage.tsx` has **no visible "Resume" button wiring** in the current source — a reload re-renders the stage at its persisted `stage`/artifacts, and an in-flight `LiveRunButton` simply resets to idle (the job keeps running server-side and its result must be re-fetched by re-clicking / re-monitoring). Treat resume as partially-implemented.
- `AgentRecord.config` (`{systemPrompt, toolDescriptions}`) is the input to recommend/bundles; an agent with null config is blocked at create-time (`noConfigWarning`, `ExperimentsPage.tsx:70,122`).
- Weights buttons are hard-coded to `[10,50,100]` (`:904`); initial canary split is `90/10` (`:755`).
- Not read in depth (out of scope): `agentcore.py` AWS wrappers beyond `normalize_ab_results`, `deployer.py`, `cleanup.py`/`CleanupPage.tsx` (teardown is a separate console section reached via "Go to Cleanup →").
