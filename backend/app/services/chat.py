"""The single chat/invoke chain shared by the Chat playground and the public /v1 API.

Harness AND Claude SDK container (方式A) agents stream real deltas (including
tool-use events) — the harness via the InvokeHarness event stream, the container
via a streaming InvokeAgentRuntime SSE body in the same converse-stream frame
shape (mapped by ``_map_converse_frame``). The remaining runtime agents
(zip/studio/A2A) return one buffered answer which the platform re-chunks — the
SSE `meta` event marks which mode is active.
"""

import json
import time
from collections.abc import Iterator
from typing import Any

from app.models.ledger import Agent
from app.services.agentcore import runtime as rt
from app.services.agentcore.client import data_client
from app.services.agentcore.harness import new_session_id
from app.services.invoke import invoke_agent_text

CHUNK_CHARS = 60


def chat_stream(
    agent: Agent, prompt: str, session_id: str | None = None, actor_id: str = "river"
) -> Iterator[dict[str, Any]]:
    """Yield SSE-ready events: meta → (tool|delta)* → done. Never raises mid-stream;
    errors surface as an `error` event."""
    session_id = session_id or new_session_id()
    mode = "stream" if agent.method in ("harness", "container") else "buffered"
    yield {
        "event": "meta",
        "data": {"session_id": session_id, "agent": agent.name, "mode": mode},
    }
    started = time.monotonic()
    try:
        if agent.method == "harness":
            yield from _harness_events(agent, prompt, session_id, actor_id)
        elif agent.method == "container":
            yield from _container_stream_events(agent, prompt, session_id, actor_id)
        else:
            result = invoke_agent_text(agent, prompt, session_id=session_id, actor_id=actor_id)
            text = result["text"]
            for i in range(0, len(text), CHUNK_CHARS):
                yield {"event": "delta", "data": {"text": text[i : i + CHUNK_CHARS]}}
    except Exception as exc:
        yield {"event": "error", "data": {"message": f"{type(exc).__name__}: {exc}"}}
        return
    yield {
        "event": "done",
        "data": {"latency_ms": int((time.monotonic() - started) * 1000)},
    }


def _map_converse_frame(frame: dict[str, Any]) -> dict[str, Any] | None:
    """Map one converse-stream / InvokeHarness frame to an SSE event.

    Shared by the harness stream and the Claude SDK container stream — both speak
    the same ``contentBlockStart`` (toolUse) / ``contentBlockDelta`` (text) shape.
    Error frames raise so the caller emits one ``error`` event and stops. Frames
    that carry nothing renderable (e.g. a non-tool contentBlockStart) return None.
    """
    if "contentBlockStart" in frame:
        tool_use = frame["contentBlockStart"].get("start", {}).get("toolUse")
        if tool_use:
            return {
                "event": "tool",
                "data": {"name": tool_use.get("name", ""), "id": tool_use.get("toolUseId")},
            }
    elif "contentBlockDelta" in frame:
        delta = frame["contentBlockDelta"].get("delta", {})
        if delta.get("text"):
            return {"event": "delta", "data": {"text": delta["text"]}}
    elif "runtimeClientError" in frame or "internalServerException" in frame:
        detail = frame.get("runtimeClientError") or frame.get("internalServerException")
        raise RuntimeError(str(detail))
    return None


def _harness_events(
    agent: Agent, prompt: str, session_id: str, actor_id: str
) -> Iterator[dict[str, Any]]:
    response = data_client().invoke_harness(
        harnessArn=agent.arn,
        runtimeSessionId=session_id,
        actorId=actor_id,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    for event in response["stream"]:
        mapped = _map_converse_frame(event)
        if mapped:
            yield mapped


def _container_stream_events(
    agent: Agent, prompt: str, session_id: str, actor_id: str
) -> Iterator[dict[str, Any]]:
    """Stream a Claude SDK container (方式A) as tool/delta events.

    The container emits the same converse-stream frames as the harness, so the
    mapping is shared. A pre-streaming container image (not yet re-published)
    answers one buffered text frame from ``rt.stream_runtime_events``; its
    ``delta`` is re-chunked to ``CHUNK_CHARS`` so the fallback renders like the
    legacy buffered path. Token-level deltas are already ≤ CHUNK_CHARS, so the
    same re-chunk pass yields them one-to-one.
    """
    for frame in rt.stream_runtime_events(
        data_client(), agent.arn, prompt, session_id=session_id, actor_id=actor_id
    ):
        mapped = _map_converse_frame(frame)
        if mapped is None:
            continue
        if mapped["event"] == "delta":
            text = mapped["data"].get("text", "")
            for i in range(0, len(text), CHUNK_CHARS):
                yield {"event": "delta", "data": {"text": text[i : i + CHUNK_CHARS]}}
        else:
            yield mapped


def sse_encode(event: dict[str, Any]) -> str:
    return f"event: {event['event']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"
