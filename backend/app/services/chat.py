"""The single chat/invoke chain shared by the Chat playground and the public /v1 API.

Harness and Claude SDK container agents stream real deltas, including tool-use
events. Other runtime methods keep the buffered compatibility path.
"""

import json
import time
from collections.abc import Iterator
from typing import Any

from app.models.ledger import Agent
from app.services.agentcore.client import data_client
from app.services.agentcore.harness import new_session_id
from app.services.invoke import invoke_agent_events


def chat_stream(
    agent: Agent, prompt: str, session_id: str | None = None, actor_id: str = "river"
) -> Iterator[dict[str, Any]]:
    """Yield SSE-ready events: meta → (heartbeat|tool|delta)* → done.

    Never raises mid-stream; errors surface as an `error` event.
    """
    session_id = session_id or new_session_id()
    mode = "stream" if agent.method in {"harness", "container"} else "buffered"
    yield {
        "event": "meta",
        "data": {"session_id": session_id, "agent": agent.name, "mode": mode},
    }
    started = time.monotonic()
    try:
        if agent.method == "harness":
            yield from _harness_events(agent, prompt, session_id, actor_id)
        else:
            yield from invoke_agent_events(
                agent,
                prompt,
                session_id=session_id,
                actor_id=actor_id,
            )
    except Exception as exc:
        yield {"event": "error", "data": {"message": f"{type(exc).__name__}: {exc}"}}
        return
    yield {
        "event": "done",
        "data": {"latency_ms": int((time.monotonic() - started) * 1000)},
    }


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
        if "contentBlockStart" in event:
            tool_use = event["contentBlockStart"].get("start", {}).get("toolUse")
            if tool_use:
                yield {
                    "event": "tool",
                    "data": {"name": tool_use.get("name", ""), "id": tool_use.get("toolUseId")},
                }
        elif "contentBlockDelta" in event:
            delta = event["contentBlockDelta"].get("delta", {})
            if delta.get("text"):
                yield {"event": "delta", "data": {"text": delta["text"]}}
        elif "runtimeClientError" in event or "internalServerException" in event:
            detail = event.get("runtimeClientError") or event.get("internalServerException")
            raise RuntimeError(str(detail))


def sse_encode(event: dict[str, Any]) -> str:
    if event["event"] == "heartbeat":
        return ": keep-alive\n\n"
    return f"event: {event['event']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"
