# Design: AgentCore-Accurate Promotion

## Source Contracts

AWS documentation establishes these invariants:

- An A/B test always has exactly two variants; each weight is at least 1 and
  all weights sum to 100. A running test can reach at most 1/99.
- Promotion stops the A/B test, applies the treatment to the managed production
  configuration, and deploys it.
- The SDK has no atomic promote call. Callers must orchestrate stop + apply.

References:

- https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore/update-ab-test.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ab-testing-manage.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ab-testing-config-bundle.html

## Boundaries

The change stays inside the main Launchpad app:

- `backend/app/optimization/`: eligibility, bundle shape, promotion orchestration
- `backend/app/schemas/agent.py`: durable production configuration fields
- `backend/app/templates/strands_agent/`: generated runtime defaults and bundle reads
- `backend/app/services/harness_convert.py`: owned bundle-contract graft for converted runtimes
- `backend/app/deployer/pipeline.py`: reusable in-place deployment without unrelated registration
- `frontend/src/pages/EvaluationExperiment.tsx`: promotion and legacy-state rendering
- frontend translations and focused backend tests

No parent/child task split is needed because the backend contract and frontend
state are one cross-layer behavior and cannot be accepted independently.

## Capability Contract

Add one backend-owned projection describing whether an agent can participate in
configuration-bundle experiments:

```text
eligible
system_prompt
tool_descriptions
reason
```

The agent API serializes this projection; both the experiment create endpoint
and frontend consume it. The frontend must not duplicate source-code heuristics.

Eligible runtimes:

1. Platform-generated HTTP `zip_runtime` agents.
2. Harness-converted HTTP `zip_runtime` agents whose owned code-bundle graft
   contains the Launchpad contract marker.

Ineligible runtimes include harness, A2A, container, Studio, and arbitrary
user-supplied code bundles. The backend remains authoritative even if a stale
frontend submits an ineligible agent.

Converted runtimes with the old prompt-only graft remain system-prompt capable.
The updated graft adds tool-description support for future conversions and is
upgraded idempotently when a converted runtime is promoted.

## Configuration Shape

New bundles use the AWS-documented shape:

```json
{
  "system_prompt": "...",
  "tools": {
    "tool_name": {"description": "..."}
  }
}
```

Runtime readers accept both this shape and the legacy
`tool_descriptions: {name: description}` shape so existing bundle versions and
experiment rows continue to work.

`Agent.spec` gains a bounded `tool_description_overrides` map. It is the
Launchpad equivalent of the production configuration stored in
`agentcore.json`; `system_prompt` remains the durable prompt field.

Generated Strands code embeds those values as its no-bundle defaults. The
harness-conversion graft owns a marked source block that:

- resolves bundle prompt/tool values;
- falls back to promoted production defaults;
- applies tool descriptions to the constructed Strands tool registry,
  including tools loaded from a `ToolProvider`;
- can be replaced idempotently without rewriting arbitrary source outside the
  managed marker block.

## Promotion Flow

Promotion becomes an asynchronous stage because an in-place runtime deployment
can take minutes:

```text
POST action=promote
  -> mark running_action=promote and effective status=ready
  -> get A/B test; stop it unless already STOPPED
  -> poll until STOPPED
  -> persist promotion_attempt audit artifact
  -> derive accepted treatment prompt/tool descriptions
  -> update Agent.spec production defaults
  -> upgrade the owned converted-runtime graft when applicable
  -> create and execute an in-place deployment (same AgentCore resource)
  -> skip registry publication because ARN/identity is unchanged
  -> verify deploy stage succeeded
  -> write new promote artifact and status=promoted
```

The success artifact records:

```text
ab_test_id
ab_test_status=STOPPED
agent_id
deployment_id
job_id
agent_version
applied_system_prompt=true
applied_tool_descriptions=[...]
completed_at
prior_shift={C:1,T1:99}  # legacy completion only
```

It does not use `after_weights` as evidence of promotion.

## Failure And Retry

Cross-service promotion cannot be atomic, so ordering favors truthful state:

1. Stop mixed A/B traffic.
2. Record the stop in `promotion_attempt`.
3. Apply and deploy production configuration.
4. Mark promoted only after the runtime deploy stage succeeds.

If any step fails:

- `status` remains/effectively becomes `ready`;
- `running_action` clears and the existing `<action>: ...` error contract is used;
- no new successful `promote` artifact is written;
- the stopped-test attempt remains visible for diagnosis;
- retry skips an already-stopped test and repeats the idempotent in-place deploy.

A promotion deployment skips the registry stage. This avoids reporting failure
after the runtime version is already live merely because unrelated registry
metadata refresh failed.

## Legacy Projection

A legacy promotion is identified by top-level `promote.after_weights` without a
new deployment identity.

API/UI behavior:

- project its effective status as `ready`, not `promoted`;
- render `LEGACY TRAFFIC SHIFT · T1 99%`;
- show `Complete promotion`;
- require explicit confirmation;
- keep its old weights as audit data;
- replace the top-level legacy artifact with the new success artifact only
  after full deployment, moving old weights to `prior_shift`.

Canary is unlocked only by a completed new-format promotion. After promotion,
the original runtime is the updated champion, so the existing target-based
canary can continue to compare it with a separate challenger.

## Frontend Contract

The frontend distinguishes:

- no promotion: regular Promote action;
- promotion running: progress and disabled controls;
- legacy shift: warning state + explicit completion action;
- completed promotion: success chip containing deployed agent version, not T1
  weight;
- failed attempt: retry action plus persisted action error/progress contract.

The non-significant and insufficient-data confirmation gate remains. Legacy
completion always uses confirmation because it mutates production.

## Compatibility

- Existing bundle versions remain readable through dual-shape runtime parsing.
- Existing experiment rows remain readable without a destructive database
  migration.
- Existing agent specs deserialize because the new overrides field defaults to
  an empty map.
- New experiments are intentionally narrower; unsupported agents remain
  invokable and deployable outside experiments.

## Rollback

The in-place AgentCore update creates a new runtime version on the same resource.
This task records the resulting version and prior experiment configuration but
does not add a new rollback UI. Existing AgentCore version rollback remains the
operational escape hatch.
