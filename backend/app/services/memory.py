"""AgentCore Memory helpers — session events (short-term) + records (long-term)."""

from datetime import UTC, datetime
from typing import Any

from app.core.config import get_settings
from app.services.agentcore.client import data_client


def _memory_id() -> str:
    memory_id = get_settings().resources.get("memory_id")
    if not memory_id:
        raise RuntimeError("memory_id missing from config — run scripts/bootstrap.py")
    return memory_id


def create_turn_event(
    actor_id: str, session_id: str, prompt: str, answer: str
) -> dict[str, Any]:
    """Persist one conversation turn into short-term memory (feeds extraction)."""
    return data_client().create_event(
        memoryId=_memory_id(),
        actorId=actor_id,
        sessionId=session_id,
        eventTimestamp=datetime.now(UTC),
        payload=[
            {"conversational": {"role": "USER", "content": {"text": prompt}}},
            {"conversational": {"role": "ASSISTANT", "content": {"text": answer}}},
        ],
    )


def list_events(actor_id: str, session_id: str, max_results: int = 20) -> list[dict]:
    return data_client().list_events(
        memoryId=_memory_id(),
        actorId=actor_id,
        sessionId=session_id,
        includePayloads=True,
        maxResults=min(max_results, 100),
    ).get("events", [])


def list_records(namespace_prefix: str, max_results: int = 20) -> list[dict]:
    return data_client().list_memory_records(
        memoryId=_memory_id(),
        namespacePath=namespace_prefix,
        maxResults=min(max_results, 100),
    ).get("memoryRecordSummaries", [])


def retrieve_records(namespace: str, query: str, top_k: int = 3) -> list[dict]:
    return data_client().retrieve_memory_records(
        memoryId=_memory_id(),
        namespace=namespace,
        searchCriteria={"searchQuery": query, "topK": top_k},
    ).get("memoryRecordSummaries", [])


def session_memory_summary(actor_id: str, session_id: str) -> dict[str, Any]:
    """Right-rail panel data: event count + long-term records for the actor."""
    events = list_events(actor_id, session_id)
    records: list[dict[str, Any]] = []
    for namespace in (f"/preferences/{actor_id}", f"/facts/{actor_id}"):
        for record in list_records(namespace, max_results=10):
            content = record.get("content", {})
            records.append(
                {
                    "namespace": namespace,
                    "text": content.get("text", "")[:200],
                    "record_id": record.get("memoryRecordId"),
                }
            )
    return {
        "event_count": len(events),
        "events": [
            {
                "id": e.get("eventId"),
                "at": str(e.get("eventTimestamp", "")),
                "payload": [
                    {
                        "role": p["conversational"].get("role"),
                        "text": p["conversational"].get("content", {}).get("text", "")[:120],
                    }
                    for p in e.get("payload", [])
                    if "conversational" in p
                ],
            }
            for e in events
        ],
        "records": records,
    }
