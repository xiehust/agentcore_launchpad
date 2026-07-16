# Implementation Plan

## Steps

- [x] Extract the existing zip-runtime memory environment injection into a
  shared deployer helper and use it from both zip and container runtime
  create/update paths.
- [x] Render short-term and long-term memory flags into the Claude Agent SDK
  container template.
- [x] Add a request-local Claude memory adapter using the AgentCore general
  `MemorySessionManager` API.
- [x] Wire bounded short-term history and long-term facts/preferences into a
  `UserPromptSubmit` hook.
- [x] Persist the successful user/assistant turn exactly once after the Claude
  query and implement warning-only read/write failure handling.
- [x] Extend Claude template and deployer tests for retrieval, persistence,
  isolation, disabled behavior, failures, environment precedence, and existing
  telemetry/tool behavior.
- [x] Update the Launchpad container specification and architecture Memory
  mapping.
- [x] Run focused backend lint/tests, then the canonical `make verify` gate.

## Validation

```bash
cd backend
uv run ruff check app/deployer/container.py app/deployer/zip_runtime.py \
  app/templates/claude_sdk_agent tests/test_claude_sdk_template.py \
  tests/test_zip_runtime_deployer.py
uv run pytest tests/test_claude_sdk_template.py \
  tests/test_zip_runtime_deployer.py -q
cd ..
make verify
```

Real-AWS validation is optional and remains outside the hermetic gate:

```bash
cd backend
uv run python scripts/e2e_claude_sdk.py --keep
```

After deployment, two calls using one Chat session should recall a random value;
a new Chat session or different agent must not receive it.

## Risk Points

- The AgentCore memory manager is not thread-safe; instantiate it per
  invocation.
- AgentCore short-term event order and wrapper shapes must be normalized before
  formatting.
- Long-term namespaces must use the already-scoped actor exactly once.
- The hook must add context without modifying the traced/persisted user prompt.
- Saving in both a Stop hook and after `QueryOutcome` would duplicate turns;
  only the latter is allowed.
- Memory exceptions must not mask Claude query results.
- The platform memory ID must override same-named user environment input.

## Rollback

Revert the template, shared environment helper, tests, and documentation, then
republish affected container agents. No schema or data migration rollback is
required.
