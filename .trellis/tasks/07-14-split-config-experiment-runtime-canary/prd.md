# Separate bundle experiments from runtime canaries

## Goal

Make configuration-bundle experiments and Runtime target canaries distinct
workflows so each one communicates what it changes, evaluates, promotes, and
rolls back.

## Background

- A configuration-bundle experiment compares control and treatment
  configuration on one Runtime target.
- A Runtime canary compares a champion Runtime Agent with a challenger Runtime
  Agent and gradually changes target traffic.
- The current experiment detail presents Runtime canary and ramp actions as
  later steps in the configuration experiment, which implies that they are one
  mandatory lifecycle.

## Requirements

### R1. Separate user workflows

Configuration A/B and Runtime Canary must be independently discoverable and
startable workflows with separate persistent records and APIs. Completing a
configuration experiment must not require starting a Runtime canary, and its
action API must not start new Runtime canaries.

### R2. Configuration experiment boundary

The configuration experiment owns recommendation, bundle creation, bundle A/B
traffic, evaluation, verdict, accepted-configuration deployment, and cleanup.
Its detail view must not present Runtime challenger selection or target ramping
as numbered continuation steps.

### R3. Runtime canary boundary

The Runtime canary owns champion/challenger selection, target traffic,
evaluation, verdict, experimental ramp or rollback, and cleanup. It must use
the existing backend-owned `canary_capability` contract for both champion and
challenger eligibility.

The canary runs only on the Launchpad shared experiment Gateway. It creates
canary-owned temporary targets and online evaluation configurations, routes
test traffic through the target A/B test, and records a winner. A successful
canary does not update any production Gateway or claim to deploy the
challenger into production.

Ramp stages are manually gated. The initial 90/10 stage and the subsequent
50/50 stage each require traffic generated at the current weights and a
corresponding verdict before the next ramp action is accepted. The final
experimental stage is 1/99 because AgentCore A/B variants have a weight floor
of one.

A `treatment-wins` verdict unlocks the next ramp directly. A tie or
non-significant result requires an explicit operator override. A
`control-wins`, `insufficient-data`, or `insufficient-n` result cannot be
overridden; the operator must send more traffic or roll back.

### R4. Optional handoff

After a successful configuration promotion, the UI must offer a shortcut that
starts a new Runtime canary with the promoted Agent preselected as champion.
The resulting canary remains a separate record and lifecycle.

### R5. Gateway exclusivity

The backend must prevent conflicting configuration A/B and Runtime canary
tests from running concurrently on the same Gateway. The conflict must be
reported before creating or mutating AWS test resources.

### R6. Experimental resource safety

- Track configuration-experiment and Runtime-canary targets, online evaluation
  configurations, bundles, and A/B tests under their owning record.
- Never delete the shared experiment Gateway.
- Make setup, ramp, rollback, and cleanup retryable after process interruption.
- Return stable error codes before conflicting AWS mutations.

### R7. Compatibility

Existing experiment records and completed artifacts must remain readable.
The rollout must not require destructive database migration or lose cleanup
access for resources created by the legacy combined flow.

## Acceptance Criteria

- [x] AC1: The evaluation UI exposes Configuration A/B and Runtime Canary as
      separate workflows.
- [x] AC2: A new configuration experiment ends without a Runtime challenger or
      ramp step.
- [x] AC3: A Runtime canary can be created directly without first completing a
      configuration-bundle experiment.
- [x] AC4: A Runtime canary sends and evaluates its own traffic; it does not
      reuse the configuration experiment's verdict.
- [x] AC5: A successful configuration experiment offers an optional handoff
      into a separate Runtime canary.
- [x] AC6: Runtime challenger eligibility and disabled reasons remain
      consistent between UI and API.
- [x] AC7: Conflicting tests on the same Gateway are rejected before AWS
      mutation with a stable error code and useful details.
- [x] AC8: Runtime canary ramp and rollback affect only its target A/B test and
      are labeled as experimental traffic, not production promotion.
- [x] AC9: Advancing from 90/10 to 50/50 and from 50/50 to 1/99 is rejected
      until the current stage has its own traffic and verdict records.
- [x] AC10: A treatment win unlocks ramp; tie/non-significant requires explicit
      override; control win or insufficient evidence blocks ramp.
- [x] AC11: Cleanup removes only record-owned temporary resources and never the
      shared experiment Gateway.
- [x] AC12: Legacy combined experiment rows remain readable and cleanable.
- [x] AC13: Focused backend tests, the full backend suite, frontend build/lint,
      and browser checks for both workflows pass.

## Out Of Scope

- Adding A2A request translation to Runtime canaries.
- Supporting Harness resources as Gateway Runtime targets.
- Running multiple AgentCore A/B tests concurrently on one Gateway.
- Updating a production Gateway/Target or claiming production deployment.
- Redesigning evaluator definitions or evaluation datasets.
