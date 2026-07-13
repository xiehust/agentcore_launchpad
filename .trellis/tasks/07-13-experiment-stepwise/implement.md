# Implementation plan — Experiment step-by-step interactive flow

Order matters: backend first (frontend consumes the new contract), e2e/spec
last. Each block ends with a validation gate; don't proceed past a failing
gate.

## Block 1 — Backend: action runner + per-stage actions

1. `backend/app/optimization/models.py`
   - [x] Add `running_action: Mapped[str | None]` and
         `progress: Mapped[str | None]` columns (String(24)/Text, default
         None). Confirm startup column-add path covers the `experiments`
         table the same way other launchpad tables get new columns (check
         `app/core/db.py` bootstrap; add ALTER shim if needed).
2. `backend/app/optimization/service.py`
   - [x] Add `run_action(exp_id, action, fn)` daemon-thread runner per
         design §1.3 (sets/clears `running_action`, streams `progress` via
         `_update`, persists `{action: result}` artifact + stage/status on
         success, `error` on failure with stage kept).
   - [x] Thread a `progress: Callable[[str], None]` param through
         `stage_recommend`, `stage_gateway`, `stage_abtest`,
         `send_gateway_traffic` (per-prompt `sent i/N (f failed)`),
         verdict loop (`aggregating…` ticks), `action_canary`,
         `action_cleanup`.
   - [x] `start_experiment`: stop spawning `run_experiment_loop`; persist
         `artifacts["agent_meta"] = {arn, resource_id, runtime_name, spec
         subset}` so later actions don't re-resolve the agent row each time.
         Delete `run_experiment_loop`.
   - [x] New `action_accept(exp, prompt, tool_descriptions)` — validates
         non-empty prompt, dict-of-str tool descriptions; writes
         `artifacts["recommend"]["accepted_prompt"|"accepted_tool_descriptions"]`.
   - [x] `stage_bundles`: treatment prompt/tool-descs =
         `accepted_* or recommended_prompt` fallback chain; control stays
         current config.
   - [x] `stage_traffic(dataset_id)`: dataset prompt extraction (legacy
         `prompt`, predefined first user turn; simulated → AppError 422);
         `None` → `TRAFFIC_PROMPTS * 2`. Persist dataset id/name in artifact.
3. `backend/app/optimization/routers.py`
   - [x] Extend `ActionRequest` pattern to the full verb set + optional
         fields (`accepted_prompt`, `accepted_tool_descriptions`,
         `dataset_id`, `challenger_agent_id`).
   - [x] Dispatch table: async actions → `run_action` + 202
         `{"experiment": _out(exp)}`; sync actions inline → 200. Guards:
         409 `experiment.action_in_flight` when `running_action`; 409
         `experiment.stage_not_ready` on missing prerequisite artifact
         (matrix per design §1.3 table).
   - [x] `_out`: add `running_action`, `progress`.
4. Tests `backend/tests/optimization/`
   - [x] New `test_stepwise_actions.py`: guard matrix (each action without
         prereq → 409; action while running → 409), accept persists edited
         config, bundles consumes accepted config, traffic dataset
         resolution (legacy/predefined/simulated/missing/None), runner
         success clears `running_action` + bumps stage, runner failure
         stores error + keeps stage + allows retry, old-shape artifacts
         serialize (A8).
   - [x] Update `test_experiments_crud.py`: create no longer spawns a
         thread (assert no AWS-mutating call at create; stage stays
         `recommend`, artifacts only `agent_meta`).

**Gate 1**: `cd backend && python -m pytest tests/optimization -q` green;
`python -m pytest -q` (full backend) green.

## Block 2 — Frontend: stage cards

5. `frontend/src/pages/EvaluationExperiment.tsx` (rebuild body; keep route,
   list panel, start form, ConfirmDialogs)
   - [x] `ActionButton` (design §2.2) + `DiffPanes` (side-by-side `<pre>`,
         CHANGED tag) as local components in the file (launchpad keeps
         page-local components; extract only if reused elsewhere later).
   - [x] Poll: keep 8s list poll; add 2.5s single-experiment poll while
         `exp.running_action` set.
   - [x] Cards per design §2.3: Header / Recommend (diff + editable
         textareas + ACCEPT) / Bundles / Gateway+AB / Traffic (dataset
         select from `GET /api/evaluation/datasets`, kinds legacy+
         predefined) / Verdict (existing verdict semantics + per-metric
         bars + p/n + promote incl. weak-evidence ConfirmDialog) / Canary
         (challenger select excl. self, START 90/10, weights bar, RAMP) /
         Cleanup (confirm + table).
   - [x] `reached()` gate incl. old-row artifact fallback (A8); active-card
         accent; drop the old StagePipeline/terminal collapse (keep
         `exp-summary-card` for cleaned/failed terminal state).
   - [x] Keep existing `data-testid`s where the element survives
         (`promote-btn`, `ramp-btn`, `cleanup-btn`, `verdict-significance`,
         `ab-metric`, `stage-hint`…); add `card-<stage>`,
         `action-<action>`, `progress-line`.
6. i18n `frontend/src/locales/{en,zh-CN}/common.json`
   - [x] Add `expPage.stage.*`, action labels, hints, dataset picker,
         progress fallback strings; zh-CN wording per deployed reference
         (research: deployed-site-observations.md). Keep existing keys.

**Gate 2**: `cd frontend && npm run lint && npm run build` clean; fetch-stub
browser states per design §3 captured (agent-browser against dev server —
confirm vite port 5173/5174 first per project memory).

## Block 3 — e2e + spec + wrap-up

7. [ ] Rewrite `backend/scripts/e2e_experiment.py`: create → per-action
       POST → poll `running_action`/`error` between async actions → accept
       (pass-through prompt) → … → verdict → canary(90/10) → ramp → cleanup;
       print stage table. Run against real AWS once for A7 evidence.
8. [ ] Live UI walkthrough (agent-browser, real backend) — the A2 reload
       resume check: kill the page mid-recommend, reopen, progress line
       still there.
9. [ ] Spec: author `.trellis/spec/launchpad/experiment-stepwise.md`
       (stage machine, action contract, artifact shapes, compat) + row in
       `.trellis/spec/launchpad/index.md` (step 3.3, trellis-update-spec).
10. [ ] Journal + commit (conventional message), archive task.

**Gate 3**: e2e script completes with verdict + canary + cleanup rows; spec
indexed; `git status` clean after commit.

## Rollback points

- After Block 1: backend is stepwise but old frontend still shows pipeline —
  functional (buttons missing for new verbs only in UI); safe stop point.
- Any point: `git revert` the block commits; columns are additive.

## Review gates

- Before `task.py start`: user reviews prd/design/implement (step 1.4).
- After Block 1 and Block 2: self-review with trellis-check before moving on.
