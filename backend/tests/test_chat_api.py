"""SSE chat generator, api-key auth (401/200/disabled), session persistence."""

import app.routers.agents as agents_router  # noqa: F401 (ensures methods registered)
import app.services.chat as chat_service
from app.core.db import SessionLocal
from app.models.ledger import Agent
from app.services.chat import chat_stream, sse_encode


def make_active_agent(method="zip_runtime", name="chat-agent") -> str:
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
    return agent_id


def test_chat_stream_buffered_chunks(monkeypatch):
    db = SessionLocal()
    agent = db.get(Agent, make_active_agent())
    db.close()
    monkeypatch.setattr(
        chat_service,
        "invoke_agent_text",
        lambda a, p, session_id=None, actor_id="river": {
            "text": "x" * 150,
            "session_id": "s" * 40,
        },
    )
    events = list(chat_stream(agent, "hello"))
    kinds = [e["event"] for e in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    assert events[0]["data"]["mode"] == "buffered"
    deltas = [e for e in events if e["event"] == "delta"]
    assert len(deltas) == 3  # 150 chars / 60-char chunks
    assert "".join(d["data"]["text"] for d in deltas) == "x" * 150


def test_chat_stream_error_event(monkeypatch):
    db = SessionLocal()
    agent = db.get(Agent, make_active_agent(name="chat-agent-err"))
    db.close()

    def boom(*a, **k):
        raise RuntimeError("runtime unavailable")

    monkeypatch.setattr(chat_service, "invoke_agent_text", boom)
    events = list(chat_stream(agent, "hello"))
    assert events[-1]["event"] == "error"
    assert "runtime unavailable" in events[-1]["data"]["message"]


def test_sse_encode_format():
    line = sse_encode({"event": "delta", "data": {"text": "hi"}})
    assert line == 'event: delta\ndata: {"text": "hi"}\n\n'


def test_api_key_auth_matrix(client):
    # no key → 401
    res = client.get("/v1/agents")
    assert res.status_code == 401 and res.json()["code"] == "auth.missing_api_key"

    # create a key → 200
    created = client.post("/api/apikeys", json={"name": "test"}).json()
    raw = created["key"]
    assert raw.startswith("lp_live_")
    ok = client.get("/v1/agents", headers={"X-Api-Key": raw})
    assert ok.status_code == 200

    # bogus key → 401
    bad = client.get("/v1/agents", headers={"X-Api-Key": "lp_live_wrong"})
    assert bad.status_code == 401 and bad.json()["code"] == "auth.invalid_api_key"

    # disabled key → 401
    client.post(f"/api/apikeys/{created['id']}/disable")
    disabled = client.get("/v1/agents", headers={"X-Api-Key": raw})
    assert disabled.status_code == 401


def test_api_keys_hashed_at_rest(client):
    created = client.post("/api/apikeys", json={"name": "hashcheck"}).json()
    raw = created["key"]
    db = SessionLocal()
    from app.models.ledger import ApiKey

    row = db.get(ApiKey, created["id"])
    assert raw not in (row.key_hash or "")
    assert len(row.key_hash) == 64  # sha256 hex
    assert row.prefix.endswith("…") and len(row.prefix) <= 16
    db.close()
    listed = client.get("/api/apikeys").json()["keys"]
    assert all("key" not in k for k in listed)  # full key never listed


def test_chat_endpoint_tracks_session(client, monkeypatch):
    agent_id = make_active_agent(name="chat-sess-agent")
    monkeypatch.setattr(
        chat_service,
        "invoke_agent_text",
        lambda a, p, session_id=None, actor_id="river": {"text": "ok", "session_id": "s" * 40},
    )
    res = client.post(f"/api/chat/{agent_id}", json={"prompt": "hi"})
    assert res.status_code == 200
    body = res.text
    assert "event: meta" in body and "event: delta" in body and "event: done" in body
    sessions = client.get(f"/api/chat/{agent_id}/sessions").json()["sessions"]
    assert len(sessions) == 1 and sessions[0]["turns"] == 1


def test_chat_history_persists_and_replays(client, monkeypatch):
    """Thread items are stored in event order and replayed by /history; the
    sessions list carries a first-prompt preview."""
    agent_id = make_active_agent(name="chat-hist-agent")
    monkeypatch.setattr(
        chat_service,
        "invoke_agent_text",
        # real runtimes answer under the session id they were invoked with
        lambda a, p, session_id=None, actor_id="river": {
            "text": f"echo: {p}", "session_id": session_id,
        },
    )
    client.post(f"/api/chat/{agent_id}", json={"prompt": "first question"})
    sid = client.get(f"/api/chat/{agent_id}/sessions").json()["sessions"][0]["session_id"]
    client.post(f"/api/chat/{agent_id}",
                json={"prompt": "second question", "session_id": sid})

    history = client.get(
        f"/api/chat/{agent_id}/history", params={"session_id": sid}
    ).json()["messages"]
    assert [(m["role"], m["text"]) for m in history] == [
        ("user", "first question"), ("agent", "echo: first question"),
        ("user", "second question"), ("agent", "echo: second question"),
    ]

    sessions = client.get(f"/api/chat/{agent_id}/sessions").json()["sessions"]
    assert sessions[0]["preview"] == "first question"
    assert sessions[0]["turns"] == 2


def test_sessions_without_transcript_hidden(client, monkeypatch):
    """Sessions that predate the ChatMessage ledger have nothing to replay —
    the sessions list must not offer them (they opened as empty threads)."""
    from app.models.ledger import ChatSession

    agent_id = make_active_agent(name="chat-legacy-agent")
    db = SessionLocal()
    db.add(ChatSession(agent_id=agent_id, session_id="legacy" + "x" * 40, turns=3))
    db.commit()
    db.close()
    assert client.get(f"/api/chat/{agent_id}/sessions").json()["sessions"] == []

    monkeypatch.setattr(
        chat_service,
        "invoke_agent_text",
        lambda a, p, session_id=None, actor_id="river": {"text": "ok", "session_id": "s" * 40},
    )
    client.post(f"/api/chat/{agent_id}", json={"prompt": "hi"})
    sessions = client.get(f"/api/chat/{agent_id}/sessions").json()["sessions"]
    assert len(sessions) == 1  # the legacy row stays hidden
    assert not sessions[0]["session_id"].startswith("legacy")
    assert sessions[0]["preview"] == "hi"


def test_chat_history_records_errors(client, monkeypatch):
    """A failed turn keeps the user prompt and stores the error row."""
    agent_id = make_active_agent(name="chat-hist-err")

    def boom(*a, **k):
        raise RuntimeError("runtime exploded")

    monkeypatch.setattr(chat_service, "invoke_agent_text", boom)
    client.post(f"/api/chat/{agent_id}", json={"prompt": "doomed", "session_id": "e" * 40})
    history = client.get(
        f"/api/chat/{agent_id}/history", params={"session_id": "e" * 40}
    ).json()["messages"]
    assert [m["role"] for m in history] == ["user", "error"]
    assert "runtime exploded" in history[1]["text"]


def test_v1_and_console_share_invoke_chain():
    """Code-level proof: both surfaces call the same chain functions."""
    import inspect

    import app.routers.chat as chat_router
    import app.routers.public_api as public_api

    chat_src = inspect.getsource(chat_router)
    v1_src = inspect.getsource(public_api)
    assert "chat_stream" in chat_src and "chat_stream" in v1_src
    assert "invoke_agent_text" in v1_src  # sync path shared with agents router
