"""方式A (Claude SDK container) streaming: runtime SSE parsing + chat dispatch.

Covers ``rt.stream_runtime_events`` (converse-frame streaming vs buffered-image
fallback vs errors) and the ``chat_stream`` ``container`` branch that maps those
frames to the same ``tool``/``delta`` SSE events the harness path emits.
"""

import json

import pytest

import app.services.chat as chat_service
from app.core.db import SessionLocal
from app.models.ledger import Agent
from app.services.agentcore import runtime as rt
from app.services.chat import chat_stream


def _make_agent(method: str, name: str) -> Agent:
    db = SessionLocal()
    agent = Agent(
        name=name, method=method, status="active",
        arn="arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
        spec={"name": name},
    )
    db.add(agent)
    db.commit()
    agent_id = agent.id
    db.close()
    db = SessionLocal()
    agent = db.get(Agent, agent_id)
    db.close()
    return agent


def _sse(frame: dict) -> bytes:
    return ("data: " + json.dumps(frame)).encode("utf-8")


class _StreamBody:
    def __init__(self, lines):
        self._lines = lines

    def iter_lines(self):
        return iter(self._lines)


class _StubStreamClient:
    """invoke_agent_runtime → text/event-stream body."""

    def __init__(self, lines, content_type="text/event-stream"):
        self.lines = lines
        self.content_type = content_type
        self.invoked_with = None

    def invoke_agent_runtime(self, **kwargs):
        self.invoked_with = kwargs
        return {"response": _StreamBody(self.lines), "contentType": self.content_type}


class _BufferedBody:
    def __init__(self, data: bytes):
        self._data = data

    def read(self):
        return self._data


class _StubBufferedClient:
    """invoke_agent_runtime → application/json body (pre-streaming image)."""

    def __init__(self, data: bytes):
        self.data = data

    def invoke_agent_runtime(self, **kwargs):
        return {"response": _BufferedBody(self.data), "contentType": "application/json"}


# ── rt.stream_runtime_events ────────────────────────────────────────────────


def test_stream_runtime_events_yields_inner_frames():
    stub = _StubStreamClient([
        _sse({"event": {"contentBlockDelta": {"delta": {"text": "Hel"}}}}),
        _sse({"event": {"contentBlockStart": {"start": {
            "toolUse": {"name": "search", "toolUseId": "t1"}
        }}}}),
        b"",  # SSE frame separator — skipped
        _sse({"event": {"contentBlockDelta": {"delta": {"text": "lo"}}}}),
        b"garbage-not-data",  # non-data line — skipped
    ])
    frames = list(rt.stream_runtime_events(stub, "arn:rt-1", "hi", session_id="s" * 40))
    assert frames == [
        {"contentBlockDelta": {"delta": {"text": "Hel"}}},
        {"contentBlockStart": {"start": {"toolUse": {"name": "search", "toolUseId": "t1"}}}},
        {"contentBlockDelta": {"delta": {"text": "lo"}}},
    ]
    payload = json.loads(stub.invoked_with["payload"])
    assert payload == {"prompt": "hi", "actor_id": "default"}


def test_stream_runtime_events_raises_on_top_level_error_frame():
    # BedrockAgentCoreApp's own mid-stream error fallback is unwrapped.
    stub = _StubStreamClient([_sse({"error": "boom", "error_type": "RuntimeError"})])
    with pytest.raises(RuntimeError, match="boom"):
        list(rt.stream_runtime_events(stub, "arn:rt-1", "hi"))


def test_stream_runtime_events_buffered_fallback_single_text_frame():
    stub = _StubBufferedClient(b'{"result": "the whole answer"}')
    frames = list(rt.stream_runtime_events(stub, "arn:rt-1", "hi"))
    assert frames == [{"contentBlockDelta": {"delta": {"text": "the whole answer"}}}]


def test_stream_runtime_events_buffered_error_raises():
    stub = _StubBufferedClient(b'{"error": "no prompt"}')
    with pytest.raises(RuntimeError, match="no prompt"):
        list(rt.stream_runtime_events(stub, "arn:rt-1", "hi"))


# ── chat_stream container branch ────────────────────────────────────────────


def test_chat_stream_container_streams_tool_and_delta_in_order(monkeypatch):
    agent = _make_agent("container", "c-stream")
    frames = [
        {"contentBlockDelta": {"delta": {"text": "Hi "}}},
        {"contentBlockStart": {"start": {"toolUse": {"name": "search", "toolUseId": "t1"}}}},
        {"contentBlockDelta": {"delta": {"text": "there"}}},
    ]

    def fake_stream(client, arn, prompt, *, session_id=None, actor_id="default"):
        assert arn == agent.arn
        yield from frames

    monkeypatch.setattr(chat_service, "data_client", lambda: object())
    monkeypatch.setattr(chat_service.rt, "stream_runtime_events", fake_stream)

    events = list(chat_stream(agent, "hello"))
    kinds = [e["event"] for e in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    assert events[0]["data"]["mode"] == "stream"
    tools = [e["data"] for e in events if e["event"] == "tool"]
    assert tools == [{"name": "search", "id": "t1"}]
    assert "".join(e["data"]["text"] for e in events if e["event"] == "delta") == "Hi there"
    # a tool call splits the answer bubble live, just like the harness path
    seq = [e["event"] for e in events if e["event"] in ("tool", "delta")]
    assert seq == ["delta", "tool", "delta"]


def test_chat_stream_container_buffered_fallback_rechunks(monkeypatch):
    """A pre-streaming image answers one big text frame → re-chunked to CHUNK_CHARS."""
    agent = _make_agent("container", "c-buffered")

    def fake_stream(client, arn, prompt, *, session_id=None, actor_id="default"):
        yield {"contentBlockDelta": {"delta": {"text": "y" * 150}}}

    monkeypatch.setattr(chat_service, "data_client", lambda: object())
    monkeypatch.setattr(chat_service.rt, "stream_runtime_events", fake_stream)

    events = list(chat_stream(agent, "hi"))
    assert events[0]["data"]["mode"] == "stream"
    deltas = [e for e in events if e["event"] == "delta"]
    assert len(deltas) == 3  # 150 / 60-char chunks
    assert "".join(d["data"]["text"] for d in deltas) == "y" * 150


def test_chat_stream_container_error_frame_becomes_error_event(monkeypatch):
    agent = _make_agent("container", "c-error")

    def fake_stream(client, arn, prompt, *, session_id=None, actor_id="default"):
        yield {"contentBlockDelta": {"delta": {"text": "partial"}}}
        yield {"internalServerException": {"message": "runtime boom"}}

    monkeypatch.setattr(chat_service, "data_client", lambda: object())
    monkeypatch.setattr(chat_service.rt, "stream_runtime_events", fake_stream)

    events = list(chat_stream(agent, "hi"))
    assert any(e["event"] == "delta" and e["data"]["text"] == "partial" for e in events)
    assert events[-1]["event"] == "error"
    assert "runtime boom" in events[-1]["data"]["message"]


def test_harness_events_still_maps_via_shared_mapper(monkeypatch):
    """Regression: the refactor of _harness_events onto _map_converse_frame keeps
    the harness stream mapping byte-identical."""
    agent = _make_agent("harness", "h-stream")

    class _StubHarness:
        def invoke_harness(self, **kwargs):
            return {"stream": iter([
                {"messageStart": {"role": "assistant"}},
                {"contentBlockStart": {"start": {"toolUse": {"name": "calc", "toolUseId": "t9"}}}},
                {"contentBlockDelta": {"delta": {"text": "4"}}},
                {"messageStop": {"stopReason": "end_turn"}},
            ])}

    monkeypatch.setattr(chat_service, "data_client", lambda: _StubHarness())

    events = list(chat_stream(agent, "2+2"))
    assert events[0]["data"]["mode"] == "stream"
    assert [e["data"] for e in events if e["event"] == "tool"] == [{"name": "calc", "id": "t9"}]
    assert [e["data"]["text"] for e in events if e["event"] == "delta"] == ["4"]
