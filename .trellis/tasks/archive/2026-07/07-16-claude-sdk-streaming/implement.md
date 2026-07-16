# Implementation plan — Claude Agent SDK streaming + tool calls

Ordered, each step independently verifiable. Backend-first so the wire contract is locked before
the (non-hermetic) container template is written to match it.

## Step 1 — Backend: runtime streaming primitive
- [ ] `runtime.py`: add `stream_runtime_events(client, runtime_arn, prompt, *, session_id=None, actor_id="default", qualifier=None) -> Iterator[dict]`.
  - `invoke_agent_runtime` with the same `{"prompt","actor_id"}` payload as `invoke_runtime_text`.
  - Branch on `response.get("contentType","")`:
    - `text/event-stream` → iterate `response["response"].iter_lines()`, decode, keep `data:` lines,
      `json.loads`, `inner = frame.get("event")`, `yield inner` when a dict.
    - else → `raw = response["response"].read()`; reuse existing json / `flatten_sse_text` parse;
      raise on `{"error"}`; `yield {"contentBlockDelta": {"delta": {"text": full_text}}}`.
  - Defensive parsing (skip bad lines) mirroring `flatten_sse_text`.
- **Validate:** `cd backend && uv run pytest tests/ -q` (new tests in Step 4 will exercise it).

## Step 2 — Backend: shared frame mapper + chat dispatch
- [ ] `chat.py`: add `_map_converse_frame(frame) -> dict | None` (tool / delta / raise-on-error).
- [ ] Refactor `_harness_events` to iterate `response["stream"]` through `_map_converse_frame`
      (behavior byte-identical to today).
- [ ] Add `_container_stream_events(agent, prompt, session_id, actor_id)` consuming
      `rt.stream_runtime_events(...)`; map frames; re-chunk oversized delta text to `CHUNK_CHARS`.
- [ ] `chat_stream`: `mode = "stream" if agent.method in ("harness","container") else "buffered"`;
      dispatch `container → _container_stream_events`.
- **Review gate:** confirm no behavior change for harness/zip/studio/A2A.

## Step 3 — Container template: streaming entrypoint
- [ ] `claude_sdk_agent/main.py.tmpl`:
  - `build_options()`: `include_partial_messages=True`.
  - Import `StreamEvent`; make `invoke` an async generator (see design.md pseudocode).
  - Stream text from `StreamEvent` `content_block_delta/text_delta`; emit tool frames from
    `AssistantMessage.ToolUseBlock`; pair `ToolResultBlock` for telemetry only.
  - Accumulate `result`; fall back to `ResultMessage.result` when no deltas.
  - Keep `tracing.*` + `memory.save_turn` calls after the loop, inside `traced_invocation`.
  - On exception: `yield {"event": {"internalServerException": {"message": …}}}` then re-raise.
  - Drop now-unused imports (`TextBlock`?) to satisfy ruff.
- **Validate:** `cd backend && uv run ruff check app/templates/claude_sdk_agent/` (template is
  Python-lintable even with placeholders? — if placeholders break ruff, lint a rendered copy or
  rely on existing exclusion; check how the current `.tmpl` is handled by `make verify`).

## Step 4 — Tests (hermetic)
- [ ] `tests/` for `stream_runtime_events`:
  - streaming: stub client → response `{"contentType":"text/event-stream","response":<fake body with iter_lines>}`
    yielding `data: {"event":{"contentBlockDelta":…}}` + a `contentBlockStart` toolUse → assert inner frames.
  - buffered fallback: `{"contentType":"application/json","response":<body .read()→ {"result":"hi"}>}` → one text frame.
  - error: an `internalServerException` / `{"error"}` → raises.
- [ ] `tests/` for `chat_stream` container branch: monkeypatch `rt.stream_runtime_events` to yield
      frames → assert `meta(mode=stream) → tool → delta* → done`; assert buffered-fallback frame re-chunks.
- [ ] Assert `_harness_events` output unchanged (regression guard on the refactor).
- [ ] Confirm existing `flatten_sse_text` tests (if any) still cover the container frame shape; add one if missing.
- **Validate:** `cd backend && uv run ruff check . && uv run pytest -q`.

## Step 5 — Full gate + spec
- [ ] `make verify` (backend + infra + frontend eslint/tsc/build + i18n parity).
- [ ] Update `.trellis/spec/launchpad/claude-sdk-runtime-invocation.md`: add the streaming
      scenario (converse-frame contract, `include_partial_messages`, buffered fallback,
      re-publish requirement, direct-runtime playground path). Do in Phase 3.3 via `trellis-update-spec`.

## Step 6 — Real-AWS validation (NOT in verify gate; needs `make bootstrap` + creds)
- [ ] Re-publish a 方式A agent with a tool (e.g. registry MCP / a skill), open Chat playground,
      confirm token streaming + live tool cards matching harness.
- [ ] Confirm an un-republished 方式A agent still answers (buffered fallback).
- [ ] Spot-check `/v1` and one evaluation run against the streaming agent return full text.

## Validation commands
- Backend: `cd backend && uv run ruff check . && uv run pytest -q`
- Single test: `cd backend && uv run pytest tests/test_chat.py::<name> -q`
- Full gate: `make verify`

## Rollback points
- After Step 2 (backend only): revert `chat.py` + `runtime.py` — buffered path fully restored.
- After Step 3: revert the template; backend `flatten_sse_text` still reads any already-built
  streaming image correctly, so no runtime is stranded.
