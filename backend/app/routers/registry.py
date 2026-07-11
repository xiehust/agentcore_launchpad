"""Registry console API — records per type, register, lifecycle actions,
attachables catalog, search, defaults sync, multi-source skill ingestion."""

import secrets
import time
from dataclasses import asdict
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from starlette.datastructures import UploadFile

from app.core.errors import AppError
from app.services import registry_console as console
from app.services import skill_ingest as si
from app.services.skill_ingest import (
    SKILL_BUNDLE_MAX_BYTES,
    SkillBundle,
    bundle_errors,
    bundle_from_zip,
)

router = APIRouter(prefix="/api/registry", tags=["registry"])

_attachables_cache: dict[str, Any] = {"data": None, "at": 0.0}

# Skill inspect→import staging. inspect() acquires + validates bundles into a
# server-side temp dir and parks them here under a random id; import() consumes
# by id. Single-process uvicorn (this project's deploy shape) → an in-process
# dict is sufficient; no Redis. TTL keeps abandoned uploads/clones from leaking.
_STAGING_TTL_S = 600  # 10 minutes
_staging: dict[str, dict[str, Any]] = {}  # id → {"bundles": [SkillBundle], "expires": float}


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
    action: str  # submit | approve | publish | reject | disable


@router.post("/records/{record_id}/action")
def record_action(record_id: str, req: ActionRequest) -> dict[str, Any]:
    try:
        console.console_action(record_id, req.action)
    except ValueError as exc:
        raise AppError("registry.unknown_action", str(exc), status_code=400) from exc
    return _record_out(console.console_get(record_id))


class RegisterRequest(BaseModel):
    """Console-side registration: external MCP servers and skills. A2A records
    are never registered by hand — deploys create and refresh them."""

    type: Literal["MCP", "AGENT_SKILLS"]
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{2,63}$")
    description: str = Field(default="", max_length=500)
    url: str | None = None  # MCP: streamable-http endpoint
    skill_md: str | None = Field(default=None, max_length=102400)  # AGENT_SKILLS (AWS cap)


@router.post("/records", status_code=201)
def register_record(req: RegisterRequest) -> dict[str, Any]:
    if req.type == "MCP":
        if not req.url or not req.url.startswith(("https://", "http://")):
            raise AppError(
                "registry.invalid_url",
                "MCP registration needs a http(s) streamable-http server URL",
                status_code=400,
            )
        return _record_out(console.register_mcp_server(req.name, req.description, req.url))
    if not req.skill_md or not req.skill_md.strip():
        raise AppError(
            "registry.skill_md_required",
            "skill registration needs SKILL.md content",
            status_code=400,
        )
    return _record_out(console.register_skill(req.name, req.description, req.skill_md))


def _sweep_staging() -> None:
    now = time.time()
    for sid, entry in list(_staging.items()):
        if entry["expires"] <= now:
            _staging.pop(sid, None)
            for bundle in entry["bundles"]:
                bundle.close()


def _stage(bundles: list[SkillBundle]) -> str:
    _sweep_staging()
    sid = secrets.token_urlsafe(16)
    _staging[sid] = {"bundles": bundles, "expires": time.time() + _STAGING_TTL_S}
    return sid


def _drop_staging(sid: str) -> None:
    entry = _staging.pop(sid, None)
    if entry:
        for bundle in entry["bundles"]:
            bundle.close()


def _skill_out(bundle: SkillBundle, errors: list[str], index: int) -> dict[str, Any]:
    return {
        "index": index,
        "name": bundle.name,
        "description": bundle.description,
        "version": bundle.version,
        "files": bundle.files,
        "skill_md_excerpt": bundle.skill_md[:4000],
        "source": asdict(bundle.source),
        "valid": not errors,
        "errors": errors,
    }


@router.post("/skills/inspect")
async def inspect_skill(request: Request) -> dict[str, Any]:
    """Acquire + validate skill bundles from a source without touching S3, park
    them in staging, and return the parsed skills for preview. Accepts either a
    multipart ``.zip`` upload or a JSON ``{"source": {...}}`` body (git for now);
    a monorepo git source yields multiple skills. The whole request is refused
    (4xx) when no skill is importable."""
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        bundles = await _acquire_zip(request)
    elif content_type.startswith("application/json"):
        try:
            body = await request.json()
        except ValueError:  # malformed JSON body → clean 400, not an unhandled 500
            raise AppError(
                "registry.invalid_upload", "malformed JSON body", status_code=400
            ) from None
        if not isinstance(body, dict):
            raise AppError(
                "registry.invalid_upload", "expected a JSON object body", status_code=400
            )
        bundles = _acquire_source(body.get("source") or {})
    else:
        raise AppError(
            "registry.invalid_upload",
            "expected a multipart .zip upload or a JSON source",
            status_code=400,
        )
    return _stage_and_respond(bundles)


async def _acquire_zip(request: Request) -> list[SkillBundle]:
    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise AppError("registry.invalid_upload", "expected a .zip file", status_code=400)
    if not (upload.filename or "").lower().endswith(".zip"):
        raise AppError("registry.invalid_upload", "expected a .zip file", status_code=400)
    data = await upload.read()
    if len(data) > SKILL_BUNDLE_MAX_BYTES:
        raise AppError(
            "registry.upload_too_large",
            f"upload exceeds the {SKILL_BUNDLE_MAX_BYTES} byte limit",
            status_code=413,
        )
    return [bundle_from_zip(data)]  # archive-safety violations raise here (422)


def _acquire_source(source: dict[str, Any]) -> list[SkillBundle]:
    """Dispatch a JSON source descriptor to its acquirer. The token (git private
    repos) is used transiently here and never stored on the bundle or logged."""
    kind = source.get("kind")
    if kind == "git":
        return si.bundles_from_git(
            url=source.get("url") or "",
            ref=source.get("ref") or None,
            subdir=source.get("subdir") or None,
            token=source.get("token") or None,
        )
    raise AppError(
        "registry.invalid_source",
        f"unsupported skill source '{kind}'",
        status_code=400,
    )


def _stage_and_respond(bundles: list[SkillBundle]) -> dict[str, Any]:
    staged = [(b, bundle_errors(b)) for b in bundles]
    if not any(not errs for _, errs in staged):
        for bundle, _ in staged:
            bundle.close()
        first_errors = staged[0][1] if staged else ["no SKILL.md found in source"]
        raise AppError(
            "registry.skill_invalid",
            "; ".join(first_errors),
            detail=first_errors,
            status_code=422,
        )
    sid = _stage([b for b, _ in staged])
    return {
        "staging_id": sid,
        "skills": [_skill_out(b, errs, i) for i, (b, errs) in enumerate(staged)],
    }


class ImportSelection(BaseModel):
    """Pick a staged skill by ``index`` (preferred, unambiguous) or by ``name``;
    ``name_override`` / ``description_override`` edit the registered record."""

    index: int | None = None
    name: str = ""
    name_override: str | None = Field(default=None, max_length=64)
    description_override: str | None = Field(default=None, max_length=500)


class ImportRequest(BaseModel):
    staging_id: str
    selections: list[ImportSelection]


def _match_bundle(bundles: list[SkillBundle], sel: ImportSelection) -> SkillBundle | None:
    if sel.index is not None:
        return bundles[sel.index] if 0 <= sel.index < len(bundles) else None
    for bundle in bundles:
        if bundle.name == sel.name:
            return bundle
    return None


@router.post("/skills/import")
def import_skills(req: ImportRequest) -> dict[str, Any]:
    """Register each selected staged bundle via the shared pipeline. A per-item
    failure (name conflict, validation) is reported inline and never aborts the
    other selections. Staging is consumed once the batch completes."""
    _sweep_staging()
    entry = _staging.get(req.staging_id)
    if entry is None:
        raise AppError(
            "registry.staging_expired",
            "staging session expired or unknown — re-inspect the source",
            status_code=410,
        )
    bundles: list[SkillBundle] = entry["bundles"]
    records: list[dict[str, Any]] = []
    for sel in req.selections:
        label = sel.name_override or sel.name or f"#{sel.index}"
        bundle = _match_bundle(bundles, sel)
        if bundle is None:
            records.append(
                {"name": label, "ok": False,
                 "error": "no staged skill matches this selection",
                 "error_code": "registry.skill_not_staged"}
            )
            continue
        try:
            record = console.register_skill_bundle(
                bundle,
                name_override=sel.name_override,
                description_override=sel.description_override,
            )
            records.append({"name": record.get("name", label), "ok": True,
                            "record": _record_out(record)})
        except AppError as exc:
            # error is a plain string for inline display; error_code kept for i18n.
            records.append({"name": label, "ok": False,
                            "error": exc.message, "error_code": exc.code})
        except Exception as exc:  # never let one bad skill abort the batch
            records.append({"name": label, "ok": False,
                            "error": str(exc), "error_code": "registry.import_failed"})
    # keep staging on any failure so the user can fix (e.g. rename) and retry
    # without re-uploading; the TTL sweep reclaims abandoned sessions
    if all(r["ok"] for r in records):
        _drop_staging(req.staging_id)
    return {"records": records}


@router.get("/skills/capabilities")
def skill_capabilities() -> dict[str, Any]:
    """Report git-import capability so the frontend's git branch can warn and
    offer auto-install when the ``git`` CLI is missing."""
    return {"git": si.git_capabilities()}


@router.post("/skills/capabilities/git-install")
def install_git() -> dict[str, Any]:
    """Explicit, user-triggered best-effort install of the ``git`` CLI (changes
    server state — only called from the capabilities UI button). No-ops with a
    hint when the server lacks the privilege to install."""
    return si.install_git()


@router.delete("/records/{record_id}")
def delete_record(record_id: str) -> dict[str, Any]:
    console.console_delete(record_id)
    return {"deleted": True, "record_id": record_id}


@router.get("/attachables")
def attachables(refresh: bool = False) -> dict[str, Any]:
    """APPROVED MCP servers + skills the create wizard offers for mounting.
    Cached 60s — each call walks GetRegistryRecord per record."""
    if (
        not refresh
        and _attachables_cache["data"] is not None
        and time.time() - _attachables_cache["at"] < 60
    ):
        return _attachables_cache["data"]
    data = console.attachable_records()
    _attachables_cache.update(data=data, at=time.time())
    return data


@router.post("/sync-defaults")
def sync_defaults() -> dict[str, Any]:
    """Register gateway targets (MCP) + the sample skill bundle (AGENT_SKILLS)."""
    return {"results": console.ensure_default_records()}
