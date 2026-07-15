# Add memory to front-desk and A2A agents

## Goal

Make Launchpad runtime agents reliably retain same-session conversation history,
including the deployed `front-desk` routing agent and generated A2A agents, while
preserving per-agent and per-session isolation.

## Background

- The Chat console already sends a stable `session_id` and the backend scopes
  `actor_id` per agent.
- The zip deployer already injects `LAUNCHPAD_MEMORY_ID` whenever an agent enables
  short- or long-term memory.
- The generated HTTP Strands template writes events and retrieves long-term
  records, but does not restore short-term turns before model invocation.
- The deployed `front-desk` creates a fresh Strands `Agent` for every request
  without a session manager.
- A2A servers isolate state by A2A `contextId`; `runtimeSessionId` is a separate
  transport-level identifier. Launchpad currently omits `contextId` from
  `message/send`.

## Requirements

- R1. Generated HTTP zip agents with `LAUNCHPAD_MEMORY_ID` must use
  `AgentCoreMemorySessionManager` keyed by the request's scoped actor and runtime
  session, so a fresh agent restores and persists short-term conversation turns.
- R2. The `front-desk` sample must use the same session manager and must not share
  request-local routing/session state across concurrent invocations.
- R3. Every Launchpad-generated A2A `message/send` request must include a stable
  `contextId` derived from the platform session. Front-desk-to-specialist A2A
  requests must follow the same contract.
- R4. Generated A2A agents must attach an `AgentCoreMemorySessionManager` in
  `agent_factory(context_id)` when memory is configured, preserving a context
  across process eviction or restart. A2A context identifiers are conversation
  keys, not authentication identities.
- R5. Existing API request and response shapes remain compatible. Chat and `/v1`
  continue to share the existing invoke chain.
- R6. The front-desk deployment script must support in-place redeploy by name so
  the current agent ID and ARN can be preserved.
- R7. Unit tests must cover session-manager wiring, stable A2A context propagation,
  front-desk request isolation primitives, and existing response parsing.
- R8. The deployed agent
  `64b838412ba848f08029746195ce5f36` must be redeployed in place and browser-tested
  with a same-session recall prompt.

## Constraints

- AgentCore Memory remains the conversation source of truth. Do not prepend the
  SQLite chat transcript to prompts.
- All boto3 client construction remains inside existing AgentCore wrappers except
  runtime-local agent code, which runs inside the deployed artifact.
- Memory partitions must remain scoped by agent and actor for HTTP runtimes.
- A2A short-term memory is scoped by agent name plus A2A context because the
  current A2A transport has no authenticated human actor envelope.
- Memory-disabled or bootstrap-free generated agents must remain importable and
  invokable without a memory ID.
- No frontend API contract or user-facing string changes are required.

## Acceptance Criteria

- [x] AC1: Two calls to an HTTP zip/front-desk runtime with the same actor and
  session restore the first turn; a different session does not receive it.
- [x] AC2: `invoke_a2a_text` and front-desk specialist dispatch send the same stable
  value as `runtimeSessionId` and A2A `message.contextId`.
- [x] AC3: The A2A template creates one memory-backed agent per `context_id` and
  still compiles when rendered.
- [x] AC4: Missing `LAUNCHPAD_MEMORY_ID` leaves generated HTTP and A2A agents
  stateless without import-time failure.
- [x] AC5: Existing Task artifact parsing, Message parsing, JSON-RPC errors, and
  Registry routing behavior remain unchanged.
- [x] AC6: Focused backend tests and the full `make verify` gate pass.
- [x] AC7: The current front-desk keeps its agent ID after redeploy and recalls a
  random value on a follow-up turn in the browser.
