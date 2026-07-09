"""Registry console API — records per type, actions, search, defaults sync."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.errors import AppError
from app.services import registry_console as console

router = APIRouter(prefix="/api/registry", tags=["registry"])


def _record_out(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_id": record.get("recordId"),
        "name": record.get("name"),
        "description": record.get("description", ""),
        "type": record.get("descriptorType"),
        "status": record.get("status"),
        "status_reason": record.get("statusReason"),
        "version": record.get("recordVersion"),
        "descriptors": record.get("descriptors"),
        "created_at": str(record.get("createdAt", "")) or None,
        "updated_at": str(record.get("updatedAt", "")) or None,
    }


@router.get("/records")
def list_records(type: str | None = None, status: str | None = None) -> dict[str, Any]:
    records = console.console_list(type, status)
    return {"records": [_record_out(r) for r in records]}


@router.get("/records/search")
def search(q: str) -> dict[str, Any]:
    return {"records": [_record_out(r) for r in console.console_search(q)]}


@router.get("/records/{record_id}")
def get_record(record_id: str) -> dict[str, Any]:
    return _record_out(console.console_get(record_id))


class ActionRequest(BaseModel):
    action: str  # submit | approve | publish | disable


@router.post("/records/{record_id}/action")
def record_action(record_id: str, req: ActionRequest) -> dict[str, Any]:
    try:
        console.console_action(record_id, req.action)
    except ValueError as exc:
        raise AppError("registry.unknown_action", str(exc), status_code=400) from exc
    return _record_out(console.console_get(record_id))


@router.post("/sync-defaults")
def sync_defaults() -> dict[str, Any]:
    """Register gateway targets (MCP) + the sample skill bundle (AGENT_SKILLS)."""
    return {"results": console.ensure_default_records()}
