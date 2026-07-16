# Design: AgentCore Memory for Claude Agent SDK containers

## Architecture

The change stays within the existing container generation and runtime
boundaries:

```text
Chat or /v1
  -> invoke_agent_text
  -> invoke_runtime_text
       payload.actor_id = <agent-id>__<human>
       runtimeSessionId = stable platform session
  -> generated Claude SDK container
       context.session_id + payload.actor_id
       -> AgentCore Memory read
       -> Claude UserPromptSubmit hook additionalContext
       -> Claude query
       -> AgentCore Memory write
```

No router, public API, frontend, ledger, or shared invoke-chain contract changes
are required.

## Deployment Contract

The zip and container deployers must derive runtime environment variables
through one shared helper:

- Begin with a copy of `spec.env`.
- When `spec.memory.short_term` or `spec.memory.long_term` is enabled and the
  bootstrapped `memory_id` exists, set `LAUNCHPAD_MEMORY_ID` to the platform
  value.
- The platform value overrides a same-named user value.
- When memory is disabled, do not inject a platform memory ID.

Both CreateAgentRuntime and UpdateAgentRuntime receive the resulting
environment so republishing can enable or disable memory without changing the
runtime identity.

## Generated Runtime

The rendered template bakes the two `AgentSpec.memory` flags into constants and
reads the resource ID from `LAUNCHPAD_MEMORY_ID`. Each invocation constructs a
request-local memory adapter using:

- `actor_id`: the already-scoped payload actor.
- `session_id`: `context.session_id`, with the existing payload/`adhoc`
  fallback.
- `memory_id`: the platform-injected environment variable.

The adapter uses `bedrock_agentcore.memory.MemorySessionManager` and its
request-local `MemorySession`. It must not be module-global because the SDK
documents the manager as not thread-safe.

### Retrieval

Before the Claude query:

- With short-term memory enabled, fetch a bounded number of recent turns from
  the current actor/session and format user/assistant messages in chronological
  order.
- With long-term memory enabled, semantically query both exact namespaces
  `/facts/<actor_id>` and `/preferences/<actor_id>` using the current prompt.
- Bound the number and rendered character size of retrieved records.
- Return the formatted text through a `UserPromptSubmit` hook's
  `additionalContext`, keeping the original prompt unchanged for tracing and
  persistence.

The hook closes over the invocation-local adapter; no global mutable manager or
actor/session state is introduced.

### Persistence

After a successful Claude query, store exactly one event containing:

- one `ConversationalMessage` with role `USER`;
- one `ConversationalMessage` with role `ASSISTANT`.

Persistence happens from the existing collected `QueryOutcome`, rather than
parsing the Claude transcript in a Stop hook. This is an intentional adaptation
of the reference guide: the runtime already owns the authoritative final
response, so direct persistence is simpler and avoids transcript-format
coupling or duplicate events.

If the Claude query fails, no incomplete turn is written.

## Failure Behavior

Memory is optional infrastructure for an invocation:

- Missing `LAUNCHPAD_MEMORY_ID`: skip all memory work.
- Retrieval failure: log a warning and invoke Claude without memory context.
- Persistence failure: log a warning after the answer is produced and return
  the answer unchanged.
- Empty or malformed memory records: ignore them.

Warnings include the operation and session identifier but never the full prompt,
response, or retrieved memory content.

## Compatibility

- Existing buffered response and usage shapes remain unchanged.
- Existing manual gen_ai tracing continues to use the original user prompt and
  final answer.
- MCP tools, skills, subagents, and tool-call tracing remain unchanged.
- Memory-disabled and bootstrap-free agents remain importable and invokable.
- Existing container agents require an in-place republish to receive the new
  image.

## Testing

Focused tests will compile/import the rendered template with fake Claude and
Memory collaborators and verify:

- memory flags render correctly;
- automatic hook context uses the platform actor/session;
- short- and long-term retrieval formatting;
- exactly-once persistence after success;
- no persistence after query failure;
- read and write failures degrade gracefully;
- disabled/missing-ID behavior performs no memory calls;
- deploy environment injection works for create/update inputs and platform
  values override user input;
- existing telemetry, tool parsing, and build-context assertions still pass.

## Rollout And Rollback

Rollout is a normal container republish, producing a new runtime version with
the same agent ID and runtime ARN. Rollback is another republish using the prior
template or runtime version. AgentCore Memory data is append-only from this
feature and does not require a ledger migration.
