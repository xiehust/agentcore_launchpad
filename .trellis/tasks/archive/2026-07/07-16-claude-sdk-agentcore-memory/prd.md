# Claude Agent SDK AgentCore Memory

## Goal

Add Amazon Bedrock AgentCore Memory support to agents created through the
Claude Agent SDK container method, so repeated invocations can restore and
persist conversation context under the same platform memory isolation model as
the other runtime methods.

## Background

- The platform uses one shared AgentCore Memory resource and scopes actors as
  `<agent>__<human>` so memory cannot bleed between agents.
- Console chat and public API invocations share the backend invoke chain; the
  generated Claude Agent SDK runtime already receives the scoped `actor_id` in
  its payload and the stable platform session as AgentCore Runtime
  `context.session_id`.
- The implementation should follow the AgentCore Memory integration described
  in `xiehust/edu_bot_demo/docs/agentcore_memory_guide.md`, adapting its
  automatic hook pattern to this runtime's existing result collection.
- The Claude Agent SDK method builds an ARM64 container from generated template
  files, so runtime dependencies and generated source may both need changes.
- The container deployer currently forwards only user environment variables;
  unlike the zip deployer, it does not inject the platform's
  `LAUNCHPAD_MEMORY_ID`.
- `bedrock-agentcore==1.17.*` provides a general `MemorySessionManager` for
  listing short-term turns, retrieving long-term records, and adding completed
  conversation turns. The Strands-specific session manager cannot be attached
  to a Claude Agent SDK query.

## Requirements

- Generated Claude Agent SDK agents automatically restore AgentCore Memory
  context before answering a request; no new user-selectable hook/tool mode is
  introduced.
- `memory.short_term=true` restores bounded recent turns for the same scoped
  actor and runtime session.
- `memory.long_term=true` retrieves relevant semantic facts and user
  preferences from `/facts/<actor>` and `/preferences/<actor>`.
- Generated Claude Agent SDK agents persist the completed interaction back to
  AgentCore Memory exactly once after answering when either memory mode is
  enabled, feeding both short-term history and asynchronous long-term
  extraction.
- Memory uses the platform-provided actor and session identifiers without
  introducing a second scoping scheme.
- The container deployer injects the shared memory resource ID when either
  memory flag is enabled, with the platform value taking precedence over
  same-named user environment input.
- Existing buffered responses, tool execution, tracing, and deployments without
  a configured memory resource remain compatible.
- Memory reads and writes are best-effort: failures are logged as warnings and
  the primary agent invocation continues. A failed write must never be reported
  as successfully persisted.
- AgentCore SDK volatility stays contained in the generated runtime/template
  boundary or existing AgentCore service wrappers.
- Automated tests cover generated source, deploy environment behavior, memory
  restore/persist behavior, actor/session isolation, and failure handling.

## Acceptance Criteria

- [x] A newly generated Claude Agent SDK container includes the required
  AgentCore Memory integration and runtime dependency.
- [x] Two invocations with the same actor/session can use prior short-term
  conversation context; a different scoped actor or session cannot see it.
- [x] Long-term-enabled agents automatically inject relevant facts and
  preferences without exposing a new memory tool.
- [x] The runtime persists both the user input and final assistant response in
  one event in the shared AgentCore Memory resource.
- [x] Memory-disabled agents do not receive `LAUNCHPAD_MEMORY_ID` from the
  platform and do not call AgentCore Memory.
- [x] Memory service failures have an explicit, tested behavior and do not
  corrupt or fail the primary response stream.
- [x] Existing Claude Agent SDK tool execution and observability behavior
  remains covered by tests.
- [x] `make verify` passes.

## Out of Scope

- A new frontend memory mode selector or agent-invoked memory MCP tool.
- Creating a second AgentCore Memory resource or changing bootstrap strategies.
- Backfilling memory into already-built container images; existing agents gain
  the feature when they are republished.
- Real-AWS end-to-end execution as part of the hermetic `make verify` gate.
