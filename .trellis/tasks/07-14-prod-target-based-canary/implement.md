# Implement — Production-grade target-based A/B canary

Build backend inside-out, keep `make verify` green each step. AWS-touching
behavior is validated by a manual e2e (not in the verify gate).

## Phase 0 — De-risk AWS mechanics (spike before building)
- [ ] 0.1 Confirm named-endpoint lifecycle: `CreateAgentRuntimeEndpoint` /
  `UpdateAgentRuntimeEndpoint(agentRuntimeVersion=…)` / delete, and READY polling.
- [ ] 0.2 Confirm `invoke_agent_runtime(..., qualifier=<endpoint>)` targets the
  pinned version.
- [ ] 0.3 **Confirm the log-group + service.name pattern for named endpoints**
  (online-eval needs the per-endpoint stream; DEFAULT today = `{resource_id}-DEFAULT`
  / `{runtime_name}.DEFAULT`). This is the largest unknown — settle it first.
- [ ] 0.4 Confirm gateway `http-runtime` target accepts `qualifier=<endpoint>` (not
  just DEFAULT).

## Phase 1 — agentcore wrappers (`app/services/agentcore/runtime.py`)
- [ ] 1.1 Add endpoint wrappers: create/update/get/delete runtime endpoint + wait-ready.
- [ ] 1.2 `invoke_runtime_text(..., qualifier=None)` → pass `qualifier` to
  `invoke_agent_runtime` when set.
- [ ] 1.3 Extract a shared `sigv4_post(url, json_body, session_id=None)` helper
  (from `service.send_gateway_traffic`) that signs `bedrock-agentcore` and sets the
  sticky session header; reuse response parsing from `invoke_runtime_text`.

## Phase 2 — canary state machine (`app/optimization/canary_service.py`)
- [ ] 2.1 `act_setup`: create per-canary gateway; `UpdateAgentRuntime(edited spec)`
  → v_candidate; ensure `stable`→v_current + `treatment`→v_candidate endpoints;
  2 `http-runtime` targets (qualifier=endpoint); per-variant online-eval; ab_test
  90/10 RUNNING. Persist all ids/versions/endpoints in `artifacts.setup`.
- [ ] 2.2 `act_complete` → promote: stop test; `UpdateAgentRuntimeEndpoint(stable,
  v_candidate)`; drop `experimental_only`. `act_rollback`: stop test only (stable
  stays v_current).
- [ ] 2.3 `act_cleanup`: delete this canary's gateway, treatment endpoint, targets,
  online-eval, ab_test (STOPPED first); keep stable endpoint.
- [ ] 2.4 `service.canary_capability` → single-agent eligibility (active HTTP
  zip/container/studio runtime w/ ARN); drop champion/challenger framing.
- [ ] 2.5 Model/artifacts (`models.py`): single `agent_id`; store versions/
  endpoints/gateway in artifacts (no migration of old rows).

## Phase 3 — invoke routing (`app/services/invoke.py`) — guarded hot path
- [ ] 3.1 Add cheap "active canary for agent?" lookup (indexed query + short-TTL
  in-process cache; no per-invoke AWS call).
- [ ] 3.2 Active → `sigv4_post(gateway_url/<control_target>/invocations, …,
  session_id)`; else direct `invoke_runtime_text(arn, qualifier=stable)`.
- [ ] 3.3 Fail-safe: gateway error mid-canary → fall back to stable endpoint
  (v_current), never DEFAULT; record error.
- [ ] 3.4 Confirm non-canaried agents are byte-for-byte unaffected.

## Phase 4 — API / routers (`app/optimization/canary_routers.py`)
- [ ] 4.1 Canary-create payload: one agent id + candidate edit (system_prompt /
  tools / code). Validate against capability.
- [ ] 4.2 Adjust response shapes / `AgentInfo` types as needed.

## Phase 5 — frontend
- [ ] 5.1 `EvaluationRuntimeCanary.tsx`: single-agent + candidate-edit entry;
  version-vs-version display; promote/rollback = real cutover; relabel "send
  **test** traffic" with augments-organic note.
- [ ] 5.2 `EvaluationExperiment.tsx`: update meta/handoff/panel titles; remove
  "experimental only / no production change" copy.
- [ ] 5.3 i18n en + zh in lockstep (`scripts/i18n_check.py` parity).

## Phase 6 — tests
- [ ] 6.1 `tests/optimization/test_runtime_canaries.py`: new setup/promote/rollback/
  cleanup with stubbed endpoint + gateway + ab_test clients.
- [ ] 6.2 `tests/test_chat_api.py` / invoke tests: canary-active routes via gateway;
  non-canary unaffected; post-promote/rollback qualifier=stable.
- [ ] 6.3 Capability test updated to single-agent.
- [ ] 6.4 New e2e (`backend/scripts/e2e_*`) for the real-AWS canary happy path
  (manual, not in verify).

## Validation commands
- `make verify` (backend ruff+pytest, infra, frontend eslint+tsc+build, i18n) — green each phase.
- Manual: `cd backend && uv run python scripts/e2e_<canary>.py` (real AWS, post-bootstrap).
- Browser (zh + en) check of the new canary flow via agent-browser on :5173.

## Risky files / rollback points
- `app/services/invoke.py` — hot path; guard + fail-safe; a bug here affects ALL
  invocations. Land behind the "active canary?" guard so non-canary path is inert.
- `app/optimization/canary_service.py` — largest rewrite; keep AWS calls in wrappers.
- `app/optimization/models.py` — schema tweak (demo DB; safe to reset).
- Rollback = revert commits; no data migration to undo.

## Pre-start gate (sub-agent dispatch)
- Curate real entries in `implement.jsonl` (spec/context for implement sub-agent)
  and `check.jsonl` (review targets) before `task.py start`.
