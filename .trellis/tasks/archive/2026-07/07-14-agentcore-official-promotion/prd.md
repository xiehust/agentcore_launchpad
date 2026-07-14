# Align experiment promotion with AgentCore

## Goal

Make the experiment promotion stage match the documented Amazon Bedrock
AgentCore lifecycle so the UI never reports a completed promotion while the
A/B test still routes traffic to both variants.

## Background

- AWS requires an A/B test to contain exactly two variants. Each variant
  weight is an integer from 1 through 100 and the weights must sum to 100.
  Therefore 1/99 is the maximum treatment allocation while the A/B test is
  still active; it is not a full rollout.
- AWS documents promotion as stopping the A/B test, applying the treatment
  variant to the managed production configuration, and deploying it. The SDK
  has no single promote operation.
- The current implementation in
  `backend/app/optimization/service.py:846` leaves the A/B test active at
  `C=1, T1=99`, then persists `status="promoted"`.
- The current UI in
  `frontend/src/pages/EvaluationExperiment.tsx:969` accurately displays that
  stored 99% allocation but labels it `PROMOTED`.
- Launchpad does not use a repository `agentcore.json` as its deployment source
  of truth. Runtime-backed agents are persisted in `Agent.spec`; an in-place
  re-publish creates a new version on the same AgentCore resource.
- Configuration-only experiments use a dedicated experiment gateway and
  immutable control/treatment bundles. Stopping a test routes that gateway's
  traffic back to control. Normal Launchpad invocation does not make the
  experiment gateway itself the production source of truth.
- Generated Strands runtimes consume routed configuration bundles dynamically.
  Arbitrary Studio code only consumes them when the author opts into the
  injected bundle helper; other runtime templates have different capabilities.
- The current experiment creation guard nevertheless accepts all
  `zip_runtime`, `studio`, and `container` agents. For agents that do not
  consume `BedrockAgentCoreContext.get_config_bundle()`, the control and
  treatment arms do not reliably represent different production behavior.

## Requirements

- Promotion terminology and persisted status must represent a completed
  production rollout, not a 99% A/B allocation.
- The A/B test must be stopped as part of promotion.
- The accepted treatment system prompt and accepted tool-description changes
  must be applied through a durable Launchpad-owned production configuration.
- The experiment must not be marked promoted until the production update
  succeeds.
- A failed production update must remain retryable and must not claim that the
  treatment is live.
- Existing experiment rows containing the legacy
  `promote.after_weights={C:1,T1:99}` artifact must remain readable and must be
  presented as a legacy traffic shift rather than a completed rollout.
- Legacy 1/99 rows must expose an explicit `Complete promotion` action. They
  must never trigger production deployment automatically during startup or
  read-time migration.
- The frontend must show the deployment outcome and no longer present `T1 99%`
  as successful promotion.
- `PROMOTE` is the single full-rollout action. Launchpad will not retain a
  separately named 1/99 traffic-shift stage.
- Promotion must preserve the explicit confirmation gate for statistically
  non-significant or insufficient verdicts.
- New experiments must be rejected unless Launchpad can prove that the runtime
  consumes routed configuration bundles. The supported set is the
  platform-generated Strands `zip_runtime` and harness-converted runtimes with
  the grafted bundle contract; ordinary container and arbitrary Studio agents
  are excluded.
- New configuration bundles must use the documented
  `tools.<name>.description` shape. Runtime bundle readers must retain support
  for existing `tool_descriptions` bundle versions.
- Backend behavior must have focused regression coverage; frontend behavior
  must be verified with the repository's supported browser evidence flow.

## Acceptance Criteria

- [x] A new successful promotion leaves the original A/B test in `STOPPED`
      execution status.
- [x] The accepted treatment is durably applied to the production agent
      configuration before the experiment receives `status="promoted"`.
- [x] The promotion artifact records the stopped test and production deployment
      identity/status without using `after_weights` as proof of promotion.
- [x] Promotion failure leaves the experiment unpromoted, exposes a retryable
      action error, and does not render a success chip.
- [x] Legacy 1/99 rows render without crashing and are not described as a full
      100% rollout.
- [x] A legacy row offers an explicitly confirmed completion action and becomes
      promoted only after that action deploys successfully.
- [x] The experiment page communicates a completed production deployment for
      new promotions and contains no `PROMOTED · T1 99%` success state.
- [x] Existing non-significant/insufficient confirmation behavior still works.
- [x] Ineligible agents are disabled in the experiment picker and rejected by
      the create API; eligible generated/converted runtimes remain usable.
- [x] New bundles use the documented tool-description shape while existing
      legacy-shaped bundles still resolve correctly at runtime.
- [x] Accepted treatment prompt and tool-description defaults survive the
      production Agent spec/deployment round trip.
- [x] Backend tests, frontend type checking/build, and targeted browser
      verification pass.

## Out Of Scope

- Changing AWS's minimum A/B variant weight constraint.
- Replacing the entire Launchpad deployment pipeline with the AgentCore CLI.
- Retrofitting arbitrary user-authored Studio/container code to consume
  configuration bundles when it currently does not.
