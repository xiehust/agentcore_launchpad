# Design — Claude Agent SDK streaming + tool calls

## Current data flow (buffered)

```
Chat.tsx ──POST /api/chat/{id}──► chat.py::chat()               [router persists messages]
                                    └► chat_stream(agent,…)      services/chat.py
                                        method=="harness"  → _harness_events()  → real tool/delta  (mode=stream)
                                        else (container/…) → invoke_agent_text() → 1 buffered text  (mode=buffered)
                                                              └► invoke.py → rt.invoke_runtime_text()
                                                                              └► client.invoke_agent_runtime() → {"result","usage"}
container main.py.tmpl:  @app.entrypoint async def invoke(payload) → run_query() collects ALL → return {"result","usage"}
```

The frontend already renders `tool` and `delta` events generically (`Chat.tsx:231-248`); the
router persistence in `chat.py::chat()` is already method-agnostic (handles `tool`/`delta`/`done`).
**So the entire change is server-side: the container template + the invoke/chat layer.**

## Target data flow (streaming)

```
container main.py.tmpl:  @app.entrypoint async def invoke(payload)  → ASYNC GENERATOR
    include_partial_messages=True
    yields converse-stream frames wrapped as {"event": {...}}:
        text delta : {"event": {"contentBlockDelta": {"delta": {"text": "…"}}}}
        tool start : {"event": {"contentBlockStart": {"start": {"toolUse": {"name":…, "toolUseId":…}}}}}
        error      : {"event": {"internalServerException": {"message": "…"}}}
    (SDK serves as text/event-stream; each yield → `data: {json}\n\n`)

chat_stream(agent,…)  method=="harness"  → _harness_events()          ┐ share
                      method=="container"→ _container_stream_events()  ┘ _map_converse_frame()
                                              └► rt.stream_runtime_events()
                                                    client.invoke_agent_runtime()
                                                    ├ contentType=text/event-stream → iter_lines → parse → inner frames
                                                    └ contentType=application/json  → read {"result"} → ONE text frame (fallback)
```

## Why converse-stream-shaped frames (the load-bearing decision)

The container response is consumed by four callers. Only the playground streams; the other three
read it buffered through `rt.invoke_runtime_text`, which already has an SSE fallback:

- `runtime.py::flatten_sse_text` joins `data: {"event": {"contentBlockDelta": {"delta": {"text"}}}}`
  lines (built originally for harness-export zip agents).

By emitting **exactly that frame shape**, a streaming container is read correctly by
`invoke_runtime_text` with **zero backend change** on the `/v1`, evaluation (`simulation.py:64`,
`service.py:151` both call `invoke_runtime_text`), and canary paths. `flatten_sse_text` ignores any
frame that isn't a text delta, so extra frames (tool starts) are safely skipped there.

Errors use `internalServerException`, which BOTH `flatten_sse_text` and `_harness_events` already
raise on — so error propagation is identical on buffered and streaming paths.

## Component changes

### 1. `backend/app/templates/claude_sdk_agent/main.py.tmpl`  (方式A container entrypoint)

- `build_options()`: add `include_partial_messages=True`.
- Replace `run_query()` + buffered `invoke()` with a **streaming generator**:

```python
@app.entrypoint
async def invoke(payload, context=None):
    ... parse prompt / session_id / actor_id / memory ...
    with tracing.traced_invocation(AGENT_NAME, session_id) as span:
        chunks, calls, usage = [], {}, {}
        try:
            async for message in query(prompt=prompt, options=build_options(memory)):
                if isinstance(message, StreamEvent):
                    ev = message.event or {}
                    if ev.get("type") == "content_block_delta":
                        d = ev.get("delta", {})
                        if d.get("type") == "text_delta" and d.get("text"):
                            chunks.append(d["text"])
                            yield {"event": {"contentBlockDelta": {"delta": {"text": d["text"]}}}}
                elif isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, ToolUseBlock):
                            name = block.name.split("__")[-1]
                            calls[block.id] = ToolCall(call_id=block.id, name=name, input=dict(block.input or {}))
                            yield {"event": {"contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": block.id}}}}}
                        # NOTE: do NOT re-emit TextBlock text — deltas already streamed it
                elif isinstance(message, UserMessage):
                    ... pair ToolResultBlock into calls[...] (for telemetry only) ...
                elif isinstance(message, ResultMessage):
                    if message.is_error: raise RuntimeError(...)
                    usage = {**(message.usage or {}), "duration_ms":…, "num_turns":…, "total_cost_usd":…}
                    if message.result and not chunks: chunks.append(str(message.result))
        except Exception as exc:
            yield {"event": {"internalServerException": {"message": f"{type(exc).__name__}: {exc}"}}}
            raise                              # still mark the span ERROR
        result = "\n".join(chunks).strip()
        for call in calls.values(): tracing.record_tool_call(...)   # unchanged helpers
        tracing.record_llm_usage(...); tracing.record_result(span, …)
        if memory: await asyncio.to_thread(memory.save_turn, prompt, result)
```

- Keep `ToolCall`, `_result_text`, memory classes, tracing calls unchanged.
- Rationale for tool source: `ToolUseBlock` (complete block) is captured for BOTH the live
  `tool` frame and telemetry — it arrives after the tool_use block finishes but before the
  result, matching harness ordering. Text is streamed only from `StreamEvent` text_delta to
  avoid double emission.
- `StreamEvent` import added; `TextBlock` import may become unused (only tool blocks read from
  AssistantMessage) — keep or drop to satisfy ruff.

### 2. `backend/app/services/agentcore/runtime.py`

Add a streaming sibling to `invoke_runtime_text` (do NOT change `invoke_runtime_text`):

```python
def stream_runtime_events(client, runtime_arn, prompt, *, session_id=None,
                          actor_id="default", qualifier=None) -> Iterator[dict]:
    """Yield converse-stream INNER frames from a container runtime invocation.

    Streaming image  (contentType text/event-stream): parse each `data:` line,
        unwrap `.get("event")`, yield the inner frame dict.
    Buffered image   (application/json): read {"result": …}, yield ONE
        {"contentBlockDelta": {"delta": {"text": <full text>}}} frame so the caller
        re-chunks identically to the legacy buffered playground path.
    """
```

- Detect via `response.get("contentType", "")`.
- Streaming branch: `for raw in response["response"].iter_lines(): line=raw.decode(); if line.startswith("data:"): frame=json.loads(...); inner=frame.get("event"); if inner: yield inner`.
- Buffered branch: reuse the same parse as `invoke_runtime_text` (json / `flatten_sse_text`) and
  yield one text frame; raise on `{"error": …}`.
- New session-id minting identical to `invoke_runtime_text`.

### 3. `backend/app/services/chat.py`

- Add shared frame mapper and reuse it in `_harness_events`:

```python
def _map_converse_frame(frame: dict) -> dict | None:
    if "contentBlockStart" in frame:
        tu = frame["contentBlockStart"].get("start", {}).get("toolUse")
        if tu: return {"event": "tool", "data": {"name": tu.get("name",""), "id": tu.get("toolUseId")}}
    elif "contentBlockDelta" in frame:
        d = frame["contentBlockDelta"].get("delta", {})
        if d.get("text"): return {"event": "delta", "data": {"text": d["text"]}}
    elif "runtimeClientError" in frame or "internalServerException" in frame:
        raise RuntimeError(str(frame.get("runtimeClientError") or frame.get("internalServerException")))
    return None
```

- `_harness_events`: iterate `response["stream"]` → `_map_converse_frame(event)`; yields identical.
- New `_container_stream_events(agent, prompt, session_id, actor_id)`:
  iterate `rt.stream_runtime_events(data_client(), agent.arn, prompt, session_id=…, actor_id=…)`,
  map each inner frame via `_map_converse_frame`. For a `delta` whose text is large (buffered
  fallback = whole answer in one frame), re-chunk into `CHUNK_CHARS` so the fallback still renders
  smoothly (token deltas are already small — chunking a small string is a no-op-ish pass).
- `chat_stream`: `mode = "stream" if agent.method in ("harness", "container") else "buffered"`;
  dispatch `harness → _harness_events`, `container → _container_stream_events`, else buffered.

### 4. Frontend / router / i18n

- **No change.** `Chat.tsx` renders `tool`/`delta` generically; `chat.py::chat()` persists them
  method-agnostically; no new user-facing strings.

## Compatibility & rollout

- **Re-publish required for streaming.** The template change only reaches a runtime when its
  image is rebuilt — i.e. re-publish (`mode=="update"` → `UpdateAgentRuntime`). Existing agents
  fall back to buffered re-chunk until then. Surface this in the spec + wrap-up notes.
- **No DB / schema / API-shape change.** SSE event contract to the browser is unchanged
  (`meta`/`tool`/`delta`/`error`/`done`).
- **Rollback:** revert the two backend files + the template; already-deployed streaming images
  keep streaming but the buffered `invoke_runtime_text` path still flattens them correctly, so a
  backend-only rollback is safe.

## Risks

- `StreamEvent.event` raw shape from the Bedrock-backed claude CLI: keyed by Anthropic streaming
  event `type` (`content_block_delta` / `text_delta`). If a field name differs at runtime, text
  won't stream (falls back to `ResultMessage.result` → single frame). Validate with a real-AWS
  e2e invoke; unit tests cover the parser with synthetic frames.
- The container template is not hermetically unit-testable (needs claude CLI + Bedrock). Coverage
  = backend parser/chat tests (synthetic frames) + a manual/e2e playground check (not in verify gate).
- `iter_lines()` splitting on SSE blank-line framing: parse defensively (skip non-`data:` lines,
  ignore JSON errors) exactly like `flatten_sse_text`.
