# Claude Agent SDK agent streaming + tool calls in playground

## Goal

方式A (Claude Agent SDK → ARM64 container, `method == "container"`) currently returns
**one buffered answer**: the container awaits the whole `claude-agent-sdk` query, returns
`{"result", "usage"}`, and the Chat playground re-chunks that text into fake deltas
(`chat.py::chat_stream` `mode == "buffered"`). Tool calls are invisible in the playground —
they only land in telemetry spans.

Make 方式A stream **token-by-token** and surface **tool calls live** in the playground, so it
matches the managed-harness experience (`mode == "stream"`, real `tool` + `delta` SSE events).

## Scope

- **In scope:** the 方式A `container` method only — the container entrypoint template
  (`backend/app/templates/claude_sdk_agent/main.py.tmpl`), the backend runtime-invoke +
  chat-stream layer, and the runtime-invocation spec.
- **Out of scope:** zip_runtime / studio / A2A methods (stay buffered); the frontend Chat
  playground (it already renders `tool` + `delta` events generically — no change expected);
  the harness path (it already streams — we only reuse/share its frame-mapping).

## Requirements

1. **Token-level streaming.** The container opts into `include_partial_messages=True` and
   emits incremental text deltas so the playground renders text as it is produced (a simple
   Q&A must visibly stream, not appear in one block).
2. **Live tool calls.** Each tool invocation the agent makes is surfaced to the playground as
   a `tool` event (name), in order, splitting the answer bubble exactly like the harness path.
3. **Playground parity.** With a re-published 方式A agent, the Chat console shows streaming
   text + tool cards indistinguishable from a managed-harness agent. No frontend change.
4. **Backward / cross-consumer compatibility (hard constraint).** The container's new
   streamed wire format MUST keep every existing consumer of the container response working
   **without change**:
   - buffered `/v1` public API, evaluation runner, and canary route all go through
     `rt.invoke_runtime_text`, which already flattens an SSE body via `flatten_sse_text`;
   - therefore the container streams **converse-stream / InvokeHarness-shaped frames**
     (`{"event": {"contentBlockDelta": {"delta": {"text": …}}}}` etc.) that `flatten_sse_text`
     already understands, so buffered readers transparently rejoin the full text.
5. **Graceful fallback for un-republished agents.** Existing 方式A runtimes built from the old
   (buffered) image still return `application/json`. The streaming chat path must detect a
   non-streaming response (`contentType`) and fall back to the current re-chunk behavior, so
   already-deployed agents keep working until re-published.
6. **Telemetry + memory preserved.** The streaming entrypoint must still emit the same manual
   gen_ai spans (`invoke_agent` → `execute_tool` per call + aggregate `chat` usage span) and
   persist exactly one AgentCore Memory turn per invocation, unchanged from the buffered path.
7. **Errors surface cleanly.** A mid-stream container error reaches the playground as an
   `error` event and the buffered path as a `RuntimeError`, via a shape both parsers detect.

## Constraints

- `bedrock-agentcore` is a preview SDK pinned to `1.17.*`; keep API volatility inside the
  `agentcore/` wrappers. Streaming entrypoint = async-generator; the SDK serves it as
  `text/event-stream` and encodes each `yield obj` as `data: {json.dumps(obj)}\n\n` (verified
  in the installed SDK: `runtime/app.py::_convert_to_sse`).
- Change invoke behavior in the shared chain (`services/chat.py`, `services/agentcore/runtime.py`),
  never per-router.
- All boto3 clients still come from `services/agentcore/client.py`.
- `make verify` (backend ruff+pytest, infra, frontend eslint+tsc+build, i18n parity) must pass.

## Acceptance Criteria

- [ ] A newly deployed / re-published 方式A agent streams token-level text in the Chat
      playground, and its tool calls appear as ordered tool cards (visually matching harness).
- [ ] `chat.py::chat_stream` reports `mode == "stream"` for `container` agents and yields real
      `tool` / `delta` / `done` events; harness behavior is unchanged.
- [ ] An un-republished (buffered-image) 方式A agent still answers in the playground via the
      re-chunk fallback (no crash, full text delivered).
- [ ] `/v1`, evaluation, and canary buffered paths return the correct full text against a
      streaming container (verified via `flatten_sse_text` unit coverage).
- [ ] The container still emits the manual gen_ai spans and persists exactly one memory turn.
- [ ] New hermetic backend tests cover: streaming-frame parse, buffered fallback, error frame,
      and the container branch of `chat_stream`. `make verify` passes.
- [ ] `claude-sdk-runtime-invocation.md` spec updated to describe the streaming contract.

## Open decisions (resolved)

- **Granularity:** token-level via `include_partial_messages=True` (user-confirmed 2026-07-16).
- **Canary during playground streaming:** the streaming playground path invokes the runtime
  DEFAULT endpoint **directly** (no canary gateway); production A/B canary stays on the
  buffered `/v1` path. Documented as an intentional scope decision (playground is a test surface).
