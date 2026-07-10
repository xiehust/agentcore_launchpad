"""Chat playground endpoints — SSE streaming over the shared invoke chain."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import SessionLocal, get_db
from app.core.errors import AppError, NotFoundError
from app.models.ledger import Agent, ChatSession
from app.services import memory as memory_service
from app.services.chat import chat_stream, sse_encode

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100000)
    session_id: str | None = None
    actor_id: str = "river"


def _get_active_agent(db: Session, agent_id: str) -> Agent:
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise NotFoundError("agent.not_found", "agent not found")
    if agent.status != "active" or not agent.arn:
        raise AppError("agent.not_active", "agent is not active", status_code=409)
    return agent


def _track_session(agent_id: str, session_id: str, actor_id: str) -> None:
    db = SessionLocal()
    try:
        row = (
            db.query(ChatSession)
            .filter(ChatSession.agent_id == agent_id, ChatSession.session_id == session_id)
            .first()
        )
        if row is None:
            row = ChatSession(agent_id=agent_id, session_id=session_id, actor_id=actor_id)
            db.add(row)
        row.turns = (row.turns or 0) + 1
        row.last_at = datetime.now(UTC)
        db.commit()
    finally:
        db.close()


@router.post("/chat/{agent_id}")
def chat(agent_id: str, req: ChatRequest, db: Session = Depends(get_db)) -> StreamingResponse:
    agent = _get_active_agent(db, agent_id)

    # Memory partitions per agent: the runtime writes short-term events and the
    # extractor lands long-term records under this compound actor. The ledger
    # still records the human actor (req.actor_id) so the sessions list shows it.
    mem_actor = memory_service.scoped_actor(agent.id, req.actor_id)

    def generate():
        session_id = req.session_id
        for event in chat_stream(agent, req.prompt, session_id=session_id, actor_id=mem_actor):
            if event["event"] == "meta":
                session_id = event["data"]["session_id"]
                _track_session(agent.id, session_id, req.actor_id)
            yield sse_encode(event)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/chat/{agent_id}/sessions")
def list_sessions(agent_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = (
        db.query(ChatSession)
        .filter(ChatSession.agent_id == agent_id)
        .order_by(ChatSession.last_at.desc())
        .limit(20)
        .all()
    )
    return {
        "sessions": [
            {
                "session_id": r.session_id,
                "actor_id": r.actor_id,
                "turns": r.turns,
                "last_at": r.last_at.isoformat() if r.last_at else None,
            }
            for r in rows
        ]
    }


@router.get("/chat/{agent_id}/memory")
def session_memory(agent_id: str, session_id: str, actor_id: str = "river") -> dict[str, Any]:
    try:
        # Read back the same agent-scoped partition the chat write path uses.
        mem_actor = memory_service.scoped_actor(agent_id, actor_id)
        return memory_service.session_memory_summary(mem_actor, session_id)
    except Exception as exc:
        raise AppError(
            "memory.unavailable", f"memory lookup failed: {exc}", status_code=502
        ) from exc
