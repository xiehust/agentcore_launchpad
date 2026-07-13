# Implementation plan — Harness → runtime conversion

Backend first (frontend consumes the new endpoint), live evidence last.
Don't edit backend/**/*.py while a live deploy/e2e is in flight (uvicorn
--reload kills daemon threads — see 07-13-experiment-stepwise lessons).

## Block 1 — Backend: bundle carrier + conversion service + endpoint

1. `backend/app/schemas/agent.py`
   - [ ] `code_bundle` / `source_harness` / `conversion_notes` fields +
         validators (safe relpaths, ≤64 files, ≤1MB, main.py required,
         XOR with `code`).
2. `backend/app/deployer/zip_runtime.py`
   - [ ] Bundle-aware staging: `spec.code_bundle` → write files into
         `pkg_dir` (skip `_generate_code`); keep skills `on_pkg_ready`
         composition intact.
3. `backend/app/services/harness_convert.py` (new)
   - [ ] `export_harness` (scratch project under DATA_DIR/harness-export,
         created once; subprocess `agentcore export harness --json`,
         120s timeout, `agent.convert_cli_missing` on absent CLI).
   - [ ] `graft_config_bundle` (anchors: DEFAULT_SYSTEM_PROMPT constant,
         `system_prompt=DEFAULT_SYSTEM_PROMPT`; raise on miss). Fixture
         from the real aurora-support export (check into
         tests/fixtures/harness_export_main.py).
   - [ ] `discover_env` + `build_conversion_spec` (requirements flatten
         from pyproject, base-pin dedupe; env wiring per design §1.5 —
         memory yes, gateway URL no).
4. `backend/app/routers/agents.py`
   - [ ] `POST /api/agents/{id}/convert` → guards (400 convert_unsupported,
         409 convert_in_flight), name dedupe `{name}-rt[-N]`, create row +
         async deploy with export/graft pre-step (or sync-in-request
         fallback per design §1.4 — pick after reading pipeline.py).
5. Tests (`backend/tests/test_harness_convert.py` + deployer test update)
   - [ ] graft/discover/validate/flatten units; endpoint guards + mocked
         happy path; build_zip carries bundle files.

**Gate 1**: full backend suite green; ruff clean on changed files.

## Block 2 — Frontend

6. - [ ] `api.convertAgent` + `AgentInfo.source_harness`.
7. - [ ] AgentList convert action + ConfirmDialog (KB-not-carried notice);
         agent detail source-harness + conversion_notes rendering.
8. - [ ] Experiment select: disabled harness options + guidance note.
9. - [ ] i18n en/zh-CN (`agentsPage.convert.*`, `expPage.harnessHint`).

**Gate 2**: lint/build clean; fetch-stub states for the new UI captured.

## Block 3 — Live evidence + wrap-up

10. - [ ] Convert `aurora-support` live: progress → active agent; chat
          sanity (answers reflect harness prompt; KB tools absent per
          notes); appears in experiment select (A1/A5/A7 screenshots).
11. - [ ] Optional stretch (evidence only if cheap): create an experiment
          on the converted agent and run recommend to prove eligibility.
12. - [ ] Spec update (evaluation-agent-eligibility.md conversion section
          or new page + index), journal, commit, archive.

**Gate 3**: A1–A7 checked against evidence; suites green; committed.

## Rollback points

- After Block 1: endpoint exists, UI absent — inert.
- Fields are additive; revert-safe at any block boundary.
