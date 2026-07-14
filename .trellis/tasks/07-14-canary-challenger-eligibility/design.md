# Canary Challenger Eligibility Design

## Boundary

This change separates two capabilities that currently share one frontend list:

- `experiment_capability`: can consume routed configuration bundles during the
  initial 50/50 configuration experiment.
- `canary_capability`: can serve as an HTTP AgentCore Runtime target during the
  later target-routing canary.

The backend service owns both projections. The frontend renders them but does
not recreate their rules.

## Backend Contract

Add:

```python
canary_capability(agent: Agent) -> {
    "eligible": bool,
    "reason": str | None,
}
```

Eligibility requires an AgentCore Runtime ARN and an HTTP protocol. Supported
Launchpad deployment methods are `zip_runtime`, `container`, and `studio`.
`harness` is rejected because its ARN cannot be used in
`targetConfiguration.http.agentcoreRuntime`. A2A is rejected because the
existing gateway traffic contract posts Launchpad prompt JSON to
`/{target}/invocations`, not A2A JSON-RPC.

The agents API includes `canary_capability` alongside
`experiment_capability`.

The experiment action router validates in this order:

1. challenger exists and is active;
2. challenger is not the champion;
3. `canary_capability.eligible` is true;
4. snapshot plain fields and start the asynchronous action.

An incompatible challenger returns
`400 experiment.challenger_unsupported` with
`{"canary_capability": capability}` details.

## Frontend Data Flow

```text
GET /api/agents
  -> active agents
  -> experiment-capable list for new experiment
  -> canary-capable list for challenger selector
```

For a selected experiment, the frontend excludes its champion from both the
enabled and disabled challenger option groups. Compatible challengers are
enabled. Incompatible active agents remain visible as disabled options with
the backend reason.

The existing `AgentInfo` type gains the backend projection; no local protocol
or method casts are introduced.

## Compatibility

- Existing API consumers receive one additive response field.
- `experiment_capability` and experiment creation behavior do not change.
- Existing experiment rows require no migration because challenger capability
  is projected from the current agent ledger.
- Existing completed canary artifacts render unchanged.

## Failure And Rollback

Capability rejection occurs before any target, online evaluation, or A/B test
is created. The change can be rolled back by removing the additive projection
and restoring the old frontend list; no persisted schema is involved.

## Test Strategy

- Unit-test the canary capability matrix independently from bundle capability.
- Verify the agents API projects both capabilities.
- Exercise canary action rejection and successful dispatch with a compatible
  custom HTTP runtime.
- Run TypeScript/build checks.
- Use `agent-browser` to confirm the live selector enables compatible runtime
  agents and explains incompatible active agents.
