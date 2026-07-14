# Fix canary challenger eligibility

## Goal

Allow every compatible AgentCore Runtime HTTP agent to be selected as the
target-canary challenger, while preventing incompatible resources from being
submitted through either the UI or API.

## Background

- The experiment page currently loads active agents, filters them through
  `experiment_capability.eligible`, and reuses that list for both experiment
  creation and target-canary selection
  (`frontend/src/pages/EvaluationExperiment.tsx:232`,
  `frontend/src/pages/EvaluationExperiment.tsx:1122`).
- `experiment_capability` intentionally requires a runtime that consumes
  routed configuration bundles (`backend/app/optimization/service.py:193`).
  That requirement applies to the initial bundle A/B test, not to the later
  target-routing canary.
- The current canary API validates only active state and self-selection
  (`backend/app/optimization/routers.py:165`), so its contract is broader than
  the UI and does not reject protocol/resource incompatibility before AWS
  provisioning starts.
- Experiment `162277dc8917` has three bundle-experiment-eligible agents. Its
  champion, `aurora-support-rt`, is excluded from challenging itself, leaving
  only `eval-target-v2` and `eval-target` in the current UI.

## Requirements

### R1. Separate capability contracts

Expose a backend-owned `canary_capability` projection separately from
`experiment_capability`. Do not broaden or otherwise change configuration
bundle experiment eligibility.

### R2. Compatible challenger definition

A canary challenger must:

- be active when submitted;
- resolve to an AgentCore Runtime resource, not an AgentCore Harness;
- use the HTTP runtime protocol expected by the existing
  `/{target}/invocations` prompt payload path;
- be different from the experiment champion.

Custom-source HTTP runtimes, container runtimes, and studio runtimes are
eligible. Consuming Launchpad configuration bundles is not required.

### R3. Consistent frontend and backend enforcement

- The frontend must use `canary_capability`, not `experiment_capability`, for
  challenger selection.
- The backend action endpoint must enforce the same capability before starting
  asynchronous AWS work.
- A rejected API response must include a stable error code, a useful reason,
  and the capability details.

### R4. Explain exclusions

The canary selector must retain incompatible active agents as disabled options
with their reason instead of silently omitting them.

## Acceptance Criteria

- [x] AC1: An active custom-source HTTP `zip_runtime` agent is offered as a
      challenger.
- [x] AC2: Active HTTP `container` and `studio` runtime agents are offered as
      challengers.
- [x] AC3: Harness agents and A2A runtime agents appear disabled with a reason.
- [x] AC4: The current champion never appears as a selectable challenger.
- [x] AC5: Direct API submission of inactive, self, Harness, or A2A challengers
      returns a 400 before `run_action` starts.
- [x] AC6: Existing initial experiment creation eligibility remains unchanged.
- [x] AC7: Backend focused tests, frontend type/build checks, and a browser
      snapshot of experiment `162277dc8917` pass.

## Out Of Scope

- Supporting A2A payload translation in target canaries.
- Making Harness resources valid `agentcoreRuntime` gateway targets.
- Proving semantic comparability between the champion and challenger prompts,
  models, or tools.
- Changing the existing promotion, traffic, ramp, or cleanup lifecycle.
