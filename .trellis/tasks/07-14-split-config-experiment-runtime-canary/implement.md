# Configuration Experiment and Runtime Canary Implementation

## Backend Model and API

- [x] Add `RuntimeCanary` and its stage/status constants.
- [x] Add `/api/runtime-canaries` list, detail, create, and action routes.
- [x] Snapshot champion/challenger metadata at create with no AWS mutation.
- [x] Validate active, distinct, HTTP Runtime-capable agents in the API.
- [x] Add a canary-specific asynchronous runner and stale-action recovery.

## Backend Service

- [x] Extract reusable shared-Gateway, Runtime target, online-evaluation, and
      A/B metric helpers without changing configuration-bundle semantics.
- [x] Add active A/B test discovery by Gateway ARN and stable
      `experiment.gateway_busy` errors.
- [x] Implement idempotent canary setup at 90/10 with record-owned names.
- [x] Implement per-ramp-stage traffic attempts with metric baselines.
- [x] Implement verdict polling that requires sample growth after traffic.
- [x] Implement verdict gating and explicit non-significant override.
- [x] Implement 50/50 and 1/99 advance actions.
- [x] Implement completion and rollback by stopping the target A/B test.
- [x] Implement idempotent canary cleanup without deleting the shared Gateway.

## Configuration Compatibility

- [x] Remove canary/ramp from the new configuration workflow stage projection.
- [x] Return `410 experiment.action_moved` for old create/ramp actions.
- [x] Preserve cleanup of legacy combined canary artifacts.
- [x] Keep existing bundle experiment eligibility and promotion behavior.
- [x] Update the real-AWS E2E script to drive the two records separately.

## Frontend

- [x] Add `RuntimeCanaryInfo` API types and client methods.
- [x] Add the Configuration A/B / Runtime Canary segmented mode control.
- [x] Build the canary list, creation form, and deep-link selection state.
- [x] Render compatible and disabled champion/challenger choices from
      `canary_capability`.
- [x] Build setup, traffic, verdict, advance/complete, rollback, and cleanup
      states with progress/retry handling.
- [x] Remove new-canary controls from configuration details.
- [x] Keep legacy canary artifacts readable and cleanable.
- [x] Add the post-promotion handoff with champion/source prefill.
- [x] Add English and Chinese copy without labeling experimental traffic as
      production.

## Tests and Validation

- [x] Add focused model/service/router tests for the new canary lifecycle.
- [x] Test Gateway conflict before AWS mutation and idempotent retry.
- [x] Test sample-growth and verdict override gates at every ramp stage.
- [x] Test rollback and cleanup resource ownership.
- [x] Update configuration action/stage compatibility tests.
- [x] Run Ruff on all changed Python files.
- [x] Run focused optimization and API tests.
- [x] Run the full backend test suite.
- [x] Run frontend build and lint.
- [x] Use `agent-browser` at desktop and mobile widths to verify both
      workflows, handoff, disabled reasons, gates, and legacy rendering.

## Review and Rollback Points

- [x] Review the final cross-layer API/type flow before browser validation.
- [x] Confirm no production Gateway/Target update API is called.
- [x] Confirm unrelated worktree files remain untouched.
- [x] Update the experiment stepwise code-spec with both state machines and
      the Gateway mutex/error contract.
