# PRD — Production-grade target-based A/B canary

## Goal & user value

Turn the "Runtime Canary" (now labelled **TARGET-BASED A/B**) from an
experiment-gateway *sandbox* into a **real production canary**: gradually shift
**live production traffic** to a candidate version of an agent, evaluate on real
traffic, and either **promote** the candidate to production or **roll back** —
using AWS AgentCore's documented target-based A/B testing.

Today the feature spins up a throwaway "experiment gateway", pushes *synthetic*
traffic through it, and `complete`/`rollback` only stop the A/B test
(`experimental_only: True`) — **production is never touched.**

## Confirmed facts (from code + AWS docs)

### AWS target-based A/B testing is the production mechanism
- Callers invoke the **Gateway HTTP endpoint**, not the runtime ARN:
  `https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/<target>/invocations`.
  Docs: "splits **live production traffic** between two variants … your agent
  code does not change."
- A **variant → a gateway target**; a target fronts an AgentCore Runtime via
  `targetConfiguration.http.agentcoreRuntime = {arn, qualifier}`. `qualifier`
  may be a **named endpoint** pinned to a version → champion=v_current,
  challenger=v_candidate on **one runtime** is the documented pattern.
- Variant assignment is **sticky per session** via
  `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`.
- API (data plane): `create_ab_test`, `update_ab_test` (only mutates
  `executionStatus` RUNNING/PAUSED/STOPPED), `get_ab_test` (→ `results` with
  per-evaluator pValue/isSignificant), `delete_ab_test` (requires STOPPED).
  **One RUNNING test per gateway.**
- **Promote** (documented): stop the test, point the **control** endpoint/target
  at the **treatment** version, remove the treatment endpoint. **STOPPED** →
  traffic reverts to the **default/control** target; **PAUSED** → all traffic to
  control.

### The platform's invoke path today
- `app/services/invoke.py::invoke_agent_text` (shared by `/v1` + Chat) invokes
  **directly by runtime ARN** (`invoke_agent_runtime`, DEFAULT endpoint). No
  gateway, no weighting in the path.
- `UpdateAgentRuntime` publishes a **new immutable version in place** (same ARN;
  DEFAULT endpoint auto-rolls). Named endpoints pin a version and do **not**
  auto-follow latest. AgentCore has **no native weighted/canary** routing on an
  endpoint — weighting must come from the gateway A/B test.

### Building blocks that already exist (reuse, don't rebuild)
- `service.py::ensure_experiment_gateway` — creates/adopts a gateway
  (`authorizerType=AWS_IAM`, `gateway_role_arn`), returns `gateway_url/arn/id`.
- `service.py::update_weights_with_pause` — **ramp works**: pause (async, wait
  for PAUSED) → `update_ab_test_weights` → resume RUNNING.
- `service.py::send_gateway_traffic` — **SigV4-signs** POSTs to the gateway URL
  (`SigV4Auth(creds, "bedrock-agentcore", region)`); the production invoke chain
  can reuse this signing.
- `service.py::create_runtime_target_idempotent`, `create_online_eval_idempotent`,
  `assert_gateway_available` (one-RUNNING-test mutex).
- `agentcore_eval.py`: `target_variants`, `create_ab_test`, `get_ab_test`,
  `update_ab_test_weights`, `normalize_ab_results`, `compute_verdict`.
- `service.py::act_promote` (~1088) — the **config-A/B production-promote
  precedent**: in-place `UpdateAgentRuntime` via `create_deployment(mode="update")`.
- Canary state machine: `RUNTIME_CANARY_STAGES = [setup, traffic, verdict, ramp,
  complete, rollback, cleanup]`; ramp weights 90/10 → 50/50 → 1/99.

## Decisions already made with the user
1. **Topology = Model 1**: champion/challenger are two **versions of the same
   agent runtime** via named endpoints (control=v_current, treatment=v_candidate
   from in-place `UpdateAgentRuntime`). This makes TARGET-BASED A/B (code/version
   change) the sibling of CONFIGURATION-BUNDLE A/B (config change) — both on one
   production agent.
2. **Gateway is the front door ONLY during the canary**: while a canary runs,
   `invoke_agent_text` routes that agent's real production traffic through the
   gateway URL (SigV4 + sticky session header); after promote/rollback it reverts
   to direct-ARN invocation.
3. **promote** = stop test + point control endpoint/target at the treatment
   version (+ remove treatment endpoint). **rollback** = stop test (traffic
   reverts to control default).
4. **Candidate is minted inside the canary flow**: setup takes an edited spec
   (prompt/tools/code) and runs `UpdateAgentRuntime` to create **v_candidate**.
   Because `UpdateAgentRuntime` auto-rolls DEFAULT to the new version, setup also
   pins a **named "stable" (control) endpoint to v_current**, and the treatment
   endpoint to v_candidate. Production keeps serving v_current (via the stable
   endpoint / gateway) until promote → **rollback is safe** (production never
   leaves v_current). promote repoints the stable endpoint to v_candidate; the
   agent's DEFAULT already tracks latest (v_candidate) so post-promote direct-ARN
   invocation is consistent.
5. **Dedicated per-canary gateway**: setup creates a gateway for this canary and
   cleanup tears it down (no shared gateway, no one-canary-at-a-time mutex).
   Enables concurrent canaries across agents and matches the "front door only
   during the canary" lifecycle.
6. **Replaces** the experiment-only behavior (removes the `experimental_only`
   path). Existing demo canary ledger rows are not migrated (demo/sample asset).

## Requirements (draft — refined during brainstorm)
- R1. Setup creates a **persistent production gateway** with two `http-runtime`
  targets pinned to control/treatment **named endpoints** of the same runtime,
  plus per-variant online-eval configs, and a RUNNING A/B test at 90/10.
- R2. `invoke_agent_text` detects an active canary for the agent and routes real
  traffic through the gateway URL (SigV4, sticky session id) during the canary.
- R3. Verdict is computed from **real-traffic** per-variant online-eval results
  (`get_ab_test.results`). A relabelled, optional **"send test traffic"** seed
  affordance is retained to generate evidence on demand in low-traffic demos;
  the UI must make clear it augments (not replaces) organic traffic.
- R4. Ramp advances 90/10 → 50/50 → 1/99 via `update_weights_with_pause`, gated
  by verdicts (existing gate logic).
- R5. **promote** repoints the control endpoint to the treatment version (real
  production cutover, same ARN); **rollback** stops the test (revert to control).
  After either, invoke reverts to direct-ARN.
- R6. Cleanup tears down canary-owned gateway/targets/endpoints/eval/A-B test.
- R7. Frontend flow (EvaluationRuntimeCanary.tsx / EvaluationExperiment.tsx)
  reflects the version-vs-version model and the "live traffic" semantics
  (remove the "experimental only / no production change" copy).
- R8. Tests updated for the new state machine and invoke-routing.

## Acceptance criteria (draft)
- AC1. With a canary RUNNING, a real `/v1` or Chat invoke of the agent is routed
  through the gateway and assigned a variant by sticky session id (verifiable via
  telemetry variant attribution).
- AC2. `promote` results in the agent's DEFAULT/production invocation returning
  the treatment version's behavior, same ARN; `get_ab_test` is STOPPED.
- AC3. `rollback` leaves production serving the control version; test STOPPED.
- AC4. After promote/rollback, `invoke_agent_text` no longer routes through the
  gateway (direct ARN).
- AC5. `make verify` green; new/updated backend + i18n checks pass.

## Out of scope (draft)
- Config-bundle A/B tab productionization (its promote is already real; its ramp
  stays as-is unless we decide otherwise).
- Non-HTTP (A2A) agents as canary subjects (already excluded by capability).

## Open questions (blocking planning)
- None. All planning questions resolved; see `design.md` / `implement.md`.
