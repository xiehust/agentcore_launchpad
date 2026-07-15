# Design: Memory-enabled front-desk and A2A agents

## Data flow

### HTTP Runtime

`Chat or /v1 -> invoke_agent_text -> invoke_runtime_text`

The platform already sends:

```json
{"prompt": "...", "actor_id": "<agent-id>__<human>"}
```

and supplies the stable platform session as `runtimeSessionId`. The runtime reads
`context.session_id`, creates an `AgentCoreMemoryConfig`, and gives its per-request
Strands agent an `AgentCoreMemorySessionManager`. The manager restores prior turns
and persists the new turn.

The existing long-term semantic retrieval remains separate. Manual
`create_event` is removed from the generated template to avoid writing the same
turn twice after the session manager owns persistence.

### Front-desk Runtime

The front-desk uses the same actor/session inputs as an HTTP runtime. Routing
state (`trace`, discovered cards, and current session) becomes invocation-local
instead of module-global so concurrent requests cannot influence each other.

For downstream specialists, the existing deterministic SHA-256 session remains
the transport session. A2A specialists also receive that value as
`message.contextId`.

### Direct A2A Runtime

`invoke_a2a_text` uses the platform session for both:

- AgentCore `runtimeSessionId`
- A2A `message.contextId`

The A2A server's existing `agent_factory(context_id)` boundary then selects the
same conversation agent on later calls. The generated factory adds an
AgentCore-backed session manager so history survives LRU eviction and runtime
restart.

Because A2A requests currently have no trusted human actor, the memory actor key
is derived from agent name and context ID. This provides short-term isolation but
does not claim cross-session user identity.

## Compatibility

- No FastAPI or frontend schema changes.
- Existing `session_id` remains the public conversation handle.
- A2A result parsing remains based only on Message parts or Task artifacts.
- Runtimes without `LAUNCHPAD_MEMORY_ID` omit the session manager.
- The deployment script chooses create when no live name exists and redeploy when
  the name already exists, preserving resource identity.

## Failure behavior

- Invalid/missing prompts retain current errors.
- A memory service failure is surfaced by the Strands session manager instead of
  silently producing a stateless answer. This avoids telling callers a turn was
  remembered when persistence failed.
- A2A JSON-RPC errors retain the current RuntimeError mapping.

## Rollout and rollback

1. Ship templates, invoke changes, sample, tests, and spec update.
2. Run the hermetic verification gate.
3. Redeploy the current front-desk in place through `/redeploy`.
4. Verify same-session recall in the Chat console.

Rollback is an in-place redeploy of the previous code bundle/runtime version.
The agent ID, ARN, and Chat URL remain stable.
