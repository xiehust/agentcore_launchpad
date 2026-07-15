# Implementation Plan

## Steps

- [x] Update the generated HTTP Strands template to construct a memory session
  manager per actor/session and remove duplicate manual event persistence.
- [x] Refactor the front-desk sample to use per-invocation routing state and a
  memory session manager.
- [x] Add stable `contextId` to platform and front-desk A2A `message/send`
  envelopes.
- [x] Add memory-backed `agent_factory(context_id)` behavior to the generated A2A
  template.
- [x] Make the front-desk deployment script redeploy an existing name in place.
- [x] Extend focused template, A2A, and front-desk unit tests.
- [x] Update the A2A Launchpad specification with the conversation contract.
- [x] Run focused lint/tests, then `make verify`.
- [x] Redeploy agent `64b838412ba848f08029746195ce5f36` and verify same-session
  recall through `http://localhost:5173/chat?agent=...`.

## Validation

```bash
cd backend
uv run ruff check app/services/agentcore/runtime.py \
  app/templates/strands_agent app/templates/strands_a2a_agent \
  samples/frontdesk_agent scripts/deploy_frontdesk_agent.py \
  tests/test_strands_template.py tests/test_a2a_agent.py tests/test_a2a_demo.py
uv run pytest tests/test_strands_template.py tests/test_a2a_agent.py \
  tests/test_a2a_demo.py -q
cd ..
make verify
```

Live AWS scripts are not part of `make verify`. The in-place front-desk redeploy
and browser conversation are a separate final validation.

## Risk points

- A2A field spelling must remain wire-format `contextId`.
- The session manager must be created per conversation, never as one process-wide
  mutable agent.
- The HTTP template must not keep manual `create_event` after session-manager
  persistence is enabled.
- The front-desk Registry record may return to approval flow after redeploy; the
  routing runtime itself remains invokable by its stable ARN.
