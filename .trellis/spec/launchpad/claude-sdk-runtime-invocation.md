# Claude Agent SDK Containers - Runtime Invocation

## Scenario: read-timeout for long-running invocations

### 1. Scope / Trigger

Use this contract when changing the shared AgentCore boto3 client factory,
Claude SDK container response behavior, or runtime invocation settings. A
Claude SDK container may work for minutes before its stream completes, so the
socket read deadline must span the whole AgentCore synchronous window.

> **Streaming update (2026-07-16):** 方式A containers now **stream** their
> response token-by-token (see the streaming scenario below). The read-timeout
> contract still applies unchanged — it bounds the socket read for both the
> streaming path and the buffered fallback — but the "no response bytes while
> the agent works" framing only holds for the buffered fallback; a streaming
> container emits `data:` frames continuously, which also keeps the socket active.

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

## Scenario: token-level streaming (方式A container)

### 1. Scope / Trigger

Use this contract when changing how a Claude SDK container (`method ==
"container"`) produces its response, or how the platform consumes it for the
Chat playground. The container streams the `claude-agent-sdk` query token-by-token
and surfaces tool calls live, matching the managed-harness playground experience.

### 2. Signatures

```python
# app/templates/claude_sdk_agent/main.py.tmpl (container entrypoint)
@app.entrypoint
async def invoke(payload, context=None):   # ASYNC GENERATOR → text/event-stream
    ...  # build_options() sets include_partial_messages=True

# app/services/agentcore/runtime.py
stream_runtime_events(
    client, runtime_arn, prompt, session_id=None, actor_id="default", qualifier=None
) -> Iterator[dict]      # yields converse-stream INNER frames

# app/services/chat.py
_map_converse_frame(frame: dict) -> dict | None    # shared by harness + container
_container_stream_events(agent, prompt, session_id, actor_id) -> Iterator[dict]
```

### 3. Contracts

- **Wire shape.** The container yields **converse-stream / InvokeHarness-shaped
  frames wrapped as `{"event": {...}}`**. `BedrockAgentCoreApp` serves an
  async-generator entrypoint as `text/event-stream`, encoding each yielded object
  as `data: {json}\n\n`. Frames:
  - text delta — `{"event": {"contentBlockDelta": {"delta": {"text": …}}}}`
  - tool start — `{"event": {"contentBlockStart": {"start": {"toolUse": {"name", "toolUseId"}}}}}`
  - error — `{"event": {"internalServerException": {"message": …}}}`
- **Cross-consumer compatibility (load-bearing).** The frame shape is exactly what
  `flatten_sse_text` already parses, so the buffered consumers that read the
  container through `invoke_runtime_text` — the `/v1` public API, the evaluation
  runner (`simulation.py`, `service.py`), and the canary route — rejoin the full
  text with **no change**. `internalServerException` frames raise in BOTH
  `flatten_sse_text` and `_map_converse_frame`, so error handling is identical on
  buffered and streaming paths. Do not invent a bespoke frame shape for the container.
- **Token vs block.** `include_partial_messages=True` makes the SDK emit
  `StreamEvent` deltas; text is streamed ONLY from `StreamEvent`
  `content_block_delta/text_delta` (never re-emitted from the completed
  `AssistantMessage` `TextBlock`). Tool frames come from the completed
  `ToolUseBlock` (name known, before its result) and double as telemetry input.
- **Buffered fallback.** `stream_runtime_events` branches on the response
  `contentType`: `text/event-stream` → parse `data:` lines and yield each
  unwrapped `event` dict; `application/json` (a pre-streaming container image) →
  read `{"result": …}` and yield ONE `contentBlockDelta` text frame so
  `_container_stream_events` re-chunks it to `CHUNK_CHARS` exactly like the legacy
  buffered playground path.
- **Telemetry + memory unchanged.** The streaming entrypoint still emits the manual
  gen_ai spans (`invoke_agent` → `execute_tool` per call + aggregate `chat` usage)
  and persists exactly one AgentCore Memory turn, after the query loop, inside
  `tracing.traced_invocation`. An unhandled error yields an `internalServerException`
  frame then re-raises so the `invoke_agent` span is marked ERROR and no turn persists.
- **Playground path is direct.** `_container_stream_events` invokes the runtime
  DEFAULT endpoint directly (no canary gateway); production A/B canary stays on the
  buffered `/v1` path. `chat_stream` reports `mode == "stream"` for `container`.
- **Frontend unchanged.** `Chat.tsx` renders `tool`/`delta` events generically and
  the chat router persists them method-agnostically — no frontend change.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| re-published container image | streams token-level text + live tool cards |
| container image predates streaming (not re-published) | `application/json` response → buffered fallback re-chunks to CHUNK_CHARS |
| tool-only turn (no streamed text) | final `ResultMessage.result` emitted once as a delta |
| mid-stream container error | `internalServerException` frame → chat emits one `error` event; buffered readers raise via `flatten_sse_text` |
| `/v1` / evaluation / canary against a streaming container | `invoke_runtime_text` flattens the SSE frames → full text, no change |

### 5. Good / Base / Bad Cases

- **Good:** a re-published 方式A agent with a tool streams text and shows the tool
  call as an ordered card, indistinguishable from a managed-harness agent.
- **Base:** a short answer streams a few deltas then `done`.
- **Bad (must not regress):** emitting a non-converse frame shape that
  `flatten_sse_text` can't parse — it would break `/v1`, evaluation, and canary.

### 6. Tests Required

- `stream_runtime_events`: streaming inner-frame parse, buffered-fallback single
  frame, top-level `{"error"}` raise, buffered `{"error"}` raise.
- `chat_stream` container branch: `meta(mode=="stream") → tool → delta* → done`
  ordering, buffered-fallback re-chunking, `internalServerException` → `error` event.
- Rendered container template compiles; `invoke` streams deltas and persists the
  memory turn exactly once; a query failure streams an error frame and skips persist;
  `_harness_events` mapping is unchanged (regression guard on the shared mapper).

### 7. Wrong vs Correct

```python
# WRONG: a bespoke frame shape flatten_sse_text cannot read — breaks /v1 + eval.
yield {"type": "delta", "text": chunk}

# CORRECT: converse-stream shape, wrapped as BedrockAgentCoreApp serves it.
yield {"event": {"contentBlockDelta": {"delta": {"text": chunk}}}}
```
