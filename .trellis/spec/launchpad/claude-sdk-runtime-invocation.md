# Claude Agent SDK Containers - Runtime Invocation

## Scenario: buffered long-running invocations

### 1. Scope / Trigger

Use this contract when changing the shared AgentCore boto3 client factory,
Claude SDK container response behavior, or runtime invocation settings.
Claude SDK containers await the complete `claude-agent-sdk` query and return
one buffered JSON response, so the caller may receive no response bytes while
the agent is working.

### 2. Signatures

```python
# app/core/config.py
Settings.agentcore_read_timeout_s: int = 1000

# app/services/agentcore/client.py
data_client()  # cached boto3 "bedrock-agentcore" client

# app/services/agentcore/runtime.py
invoke_runtime_text(
    client,
    runtime_arn: str,
    prompt: str,
    session_id: str | None = None,
    actor_id: str = "default",
    qualifier: str | None = None,
) -> dict[str, Any]
```

Environment override:

```text
LAUNCHPAD_AGENTCORE_READ_TIMEOUT_S=<positive integer seconds>
```

### 3. Contracts

- `data_client()` passes
  `botocore.config.Config(read_timeout=settings.agentcore_read_timeout_s)` to
  the `bedrock-agentcore` client. Do not rely on botocore's 60-second default.
- The default is 1000 seconds. AgentCore's non-adjustable synchronous request
  limit is 900 seconds; the extra margin allows the service timeout or final
  response to reach the caller first.
- The setting follows normal Launchpad precedence: default <
  `config/launchpad.yaml` < `LAUNCHPAD_` environment < init kwargs.
- `get_settings()` and `data_client()` are cached. Changing the YAML or
  environment value requires a backend restart.
- Do not apply this timeout to `bedrock-agentcore-control`, `bedrock-agent`, or
  `bedrock-agent-runtime` clients. Do not change retry behavior as part of this
  contract.
- Container, zip, studio, harness, evaluation, and canary paths continue to
  share the one `bedrock-agentcore` data client. The response payload and
  buffered Chat mode remain unchanged.
- A configured AWS Region changes the endpoint hostname only; it does not
  change the timeout behavior.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| setting omitted | use 1000 seconds |
| positive integer override | pass that value to `Config.read_timeout` |
| zero, negative, or non-integer value | settings validation fails at startup |
| agent finishes before configured timeout | return the existing buffered response |
| configured timeout is shorter than agent work | botocore may raise `ReadTimeoutError` |
| synchronous work exceeds 15 minutes | AgentCore service limit applies; use asynchronous invocation for longer work |

### 5. Good / Base / Bad Cases

- **Good:** a Claude SDK task takes several minutes but less than 15 minutes;
  the backend keeps reading and returns the final result.
- **Base:** a short task behaves exactly as before; only the socket read
  deadline differs.
- **Bad configuration:** an operator deliberately sets a short positive
  timeout and accepts earlier client-side failure.
- **Bad workload:** work requires more than 15 minutes; increasing this setting
  cannot extend the AgentCore synchronous service limit.

### 6. Tests Required

- Settings tests assert the 1000-second default and environment override.
- Client-factory tests inject settings and assert the boto3 call receives the
  correct service name, Region, and `Config.read_timeout`.
- The backend lint and unit-test suite must pass. Real-AWS validation may invoke
  a container task that runs longer than 60 seconds, but it is not part of the
  hermetic verify gate.

### 7. Wrong vs Correct

```python
# WRONG: botocore silently falls back to a 60-second read timeout.
return boto3.client("bedrock-agentcore", region_name=settings.region)

# CORRECT: allow the full AgentCore synchronous request window.
return boto3.client(
    "bedrock-agentcore",
    region_name=settings.region,
    config=Config(read_timeout=settings.agentcore_read_timeout_s),
)
```
