# Canary Challenger Eligibility Implementation

## Backend

- [x] Add `canary_capability` to `backend/app/optimization/service.py`.
- [x] Project it from `backend/app/routers/agents.py`.
- [x] Enforce it in the canary action branch in
      `backend/app/optimization/routers.py`.
- [x] Return `experiment.challenger_unsupported` with capability details before
      asynchronous AWS work.

## Frontend

- [x] Extend `AgentInfo` with the canary capability projection.
- [x] Keep initial experiment choices based on `experiment_capability`.
- [x] Build canary choices from active agents and `canary_capability`.
- [x] Show incompatible active agents as disabled options with reasons.
- [x] Continue excluding the current champion.

## Tests

- [x] Add a backend canary capability matrix covering generated/custom HTTP
      runtimes, container, studio, Harness, A2A, and missing runtime ARN.
- [x] Extend the agent API projection contract test.
- [x] Add canary action tests for compatible dispatch and incompatible
      rejection before `run_action`.
- [x] Run focused backend optimization and agent API tests.
- [x] Run the frontend type/build check.
- [x] Run the full backend test suite if focused checks pass.

## Documentation And Verification

- [x] Update the experiment stepwise spec with the new capability and error
      contract.
- [x] Inspect experiment `162277dc8917` with `agent-browser`; verify compatible
      runtime challengers are enabled and Harness/A2A options are disabled with
      reasons.
- [x] Review the final diff and confirm unrelated worktree changes remain
      untouched.
