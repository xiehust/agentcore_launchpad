# Studio Agent SSE heartbeat for long silent operations

| | |
|---|---|
| **Status** | Open - deferred |
| **Severity** | Medium (long-running Studio agents can lose the browser stream) |
| **Component** | Studio / zip runtime streaming and Chat playground |
| **Affected area in Launchpad** | Create Agent method C -> deployed Studio agent -> Chat |
| **Date recorded** | 2026-07-16 |

## Summary

Claude SDK container agents emit an application heartbeat while their SDK
iterator is silent, and the shared Chat encoder forwards it as an SSE
keep-alive comment. Studio/zip agents do not yet have an equivalent runtime
heartbeat source.

This work is intentionally deferred. The current change must remain scoped to
Claude SDK container agents and must not alter the Studio vendored application
or generated Strands runtime templates.

## Proposed work

- Trace the Studio deploy path and identify every generated HTTP runtime
  template that can stream through the Launchpad Chat endpoint.
- Emit an internal heartbeat during long model/tool waits without cancelling
  or restarting the active agent iterator.
- Reuse the platform Runtime normalization and shared SSE comment encoder
  instead of defining a second browser event contract.
- Keep A2A behavior out of scope unless its streaming transport is implemented
  at the same time.

## Acceptance criteria

- A republished Studio agent can remain silent for more than 120 seconds and
  then continue the same Chat response through CloudFront.
- Heartbeats are not rendered or persisted as transcript messages.
- Existing Studio text/tool event ordering and synchronous consumers remain
  unchanged.
- The full `make verify` gate and one real CloudFront browser invocation pass.

## Related

- `.trellis/spec/launchpad/claude-sdk-runtime-invocation.md`
- `backend/app/services/agentcore/runtime.py`
- `backend/app/services/chat.py`
