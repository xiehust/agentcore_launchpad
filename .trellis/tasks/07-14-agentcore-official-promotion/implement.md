# Implementation Plan

## 1. Capability And Contracts

- [x] Add a backend-owned experiment capability projection for Agent specs.
- [x] Include that projection in agent API responses.
- [x] Enforce it in `POST /api/experiments`.
- [x] Update experiment agent selection to consume the backend projection and
      show unsupported agents as disabled with the server-provided reason.
- [x] Add backend tests for generated zip, converted zip, container, Studio,
      arbitrary bundle, harness, and A2A eligibility.

## 2. Bundle And Runtime Defaults

- [x] Add validated `tool_description_overrides` to `AgentSpec`.
- [x] Emit AWS-documented `tools.<name>.description` in new configuration
      bundles.
- [x] Make the generated Strands runtime parse documented and legacy bundle
      shapes, with promoted spec values as no-bundle defaults.
- [x] Refactor the harness-conversion graft into a versioned/marked,
      idempotently replaceable contract that supports prompt and tool
      descriptions.
- [x] Add tests for documented/legacy bundle parsing, default fallbacks,
      converted-source upgrade, and tool-registry overrides.

## 3. Official Promotion Orchestration

- [x] Replace synchronous 1/99 `action_promote` with asynchronous
      `act_promote(exp_id, progress)`.
- [x] Add idempotent stop-and-wait behavior for the bundle A/B test.
- [x] Derive the accepted treatment, update Agent.spec, and upgrade converted
      source where required.
- [x] Extend deployment creation with an explicit promotion mode/skip-register
      contract while retaining in-place UpdateAgentRuntime behavior.
- [x] Execute and verify the deployment before writing the success artifact.
- [x] Persist `promotion_attempt` and new success artifact shapes; preserve
      legacy weights under `prior_shift`.
- [x] Add tests for success, already-stopped retry, stop failure, deployment
      failure, legacy completion, and success-only status transition.

## 4. Experiment UI

- [x] Update `ExperimentInfo` types for capability, promotion attempt, new
      success artifact, and legacy artifact.
- [x] Render legacy traffic shift separately from completed promotion.
- [x] Add explicit confirmed `Complete promotion` flow for legacy rows.
- [x] Render asynchronous promotion progress/retry through the existing action
      contract.
- [x] Show deployed version on success and remove T1 weight from new promotion
      summaries.
- [x] Keep canary locked until full promotion and preserve weak-evidence
      confirmation behavior.
- [x] Update English and Chinese translations.

## 5. Verification

- [x] Run focused optimization, template, conversion, agent API, and deployment
      pipeline tests.
- [x] Run the complete backend test suite or document any unrelated failure.
- [x] Run frontend lint/type-check/build commands defined by the repository.
- [x] Start/reuse the local app and verify with `agent-browser`:
      - real legacy 1/99 state projects as ready;
      - completion requires an explicit confirmation;
      - no AWS-mutating confirmation is submitted during verification.
- [x] Check desktop and mobile screenshots for overflow/overlap.
- [x] Update `.trellis/spec/launchpad/experiment-stepwise.md` with the final
      cross-layer contract after implementation is verified.

## Risk And Rollback Points

- Before changing bundle JSON shape, preserve dual-read compatibility.
- Before changing deployment mode, prove normal create/update jobs retain their
  current register behavior.
- Never mark the experiment promoted before the runtime deploy stage succeeds.
- Do not automatically execute AWS mutations for legacy rows.
- If the converted-source rewrite cannot find its owned markers/anchors, fail
  promotion before deployment and leave the action retryable.
