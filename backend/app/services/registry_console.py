"""Platform-level registry orchestration.

The ledger stays the operational source of truth; the registry is the catalog.
Sync direction is platform → registry, and ledger rows record their
registryRecordId.
"""

import json
from dataclasses import asdict, replace
from datetime import UTC, datetime
from typing import Any

import boto3

from app.core.config import REPO_ROOT, get_settings
from app.core.errors import AppError
from app.models.ledger import Agent
from app.services import mcp_client
from app.services.agentcore import registry as reg
from app.services.agentcore.client import control_client, data_client
from app.services.skill_ingest import (
    SKILL_MD_MAX_BYTES,
    SKILL_NAME_RE,
    SkillBundle,
    SkillValidationError,
    bundle_from_inline,
    bundle_from_source,
    parse_frontmatter,
    validate_bundle,
)

# Shared frontmatter parser lives in skill_ingest now; kept as a module-level
# name for the existing callers (upload_skill_bundle) and tests.
_parse_frontmatter = parse_frontmatter

SKILLS_DIR = REPO_ROOT / "samples" / "skills"
SKILL_NAME = "expense-report-writer"


def _registry_id() -> str:
    registry_id = get_settings().resources.get("registry_id")
    if not registry_id:
        raise RuntimeError("registry_id missing from config — run scripts/bootstrap.py")
    return registry_id


def register_agent_record(agent: Agent, auto_submit: bool = True) -> dict[str, Any]:
    """Create/refresh the A2A record for a deployed agent; auto-submit new records."""
    client = control_client()
    registry_id = _registry_id()
    spec = agent.spec or {}
    # A2A-protocol runtimes serve real JSON-RPC at the data-plane URL — their
    # card is directly consumable; HTTP agents keep the platform-invoke card
    is_a2a = spec.get("protocol") == "a2a"
    card = reg.build_a2a_card(
        name=agent.name,
        description=(spec.get("system_prompt") or "")[:180] or f"Launchpad agent {agent.name}",
        arn=agent.arn or "",
        version=agent.version or "1",
        method=agent.method,
        url=(
            reg.data_plane_invocations_url(agent.arn, get_settings().region)
            if is_a2a and agent.arn else None
        ),
        skills=spec.get("a2a_skills") or None,
        transport="a2a-jsonrpc" if is_a2a else "agentcore-http",
    )
    record, created = reg.upsert_record(
        client,
        registry_id,
        name=agent.name,
        description=f"Launchpad agent · method {agent.method}",
        descriptor_type="A2A",
        descriptors=reg.build_a2a_descriptors(card),
    )
    record_id = record["recordId"]
    if created and auto_submit:
        reg.wait_record_settled(client, registry_id, record_id)
        reg.submit_record(client, registry_id, record_id)
    return {"record_id": record_id, "created": created}


def upload_skill_bundle(skill_name: str = SKILL_NAME) -> dict[str, Any]:
    """Upload the sample skill bundle to S3; return definition metadata."""
    settings = get_settings()
    bucket = settings.resources.get("artifacts_bucket")
    if not bucket:
        raise RuntimeError("artifacts_bucket missing — run scripts/bootstrap.py")
    skill_dir = SKILLS_DIR / skill_name
    s3 = boto3.client("s3", region_name=settings.region)
    files: list[str] = []
    for path in sorted(skill_dir.rglob("*")):
        if path.is_file():
            rel = path.relative_to(skill_dir)
            s3.upload_file(str(path), bucket, f"skills/{skill_name}/{rel}")
            files.append(str(rel))
    skill_md = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    meta = _parse_frontmatter(skill_md)
    return {
        "skill_md": skill_md,
        "definition": {
            "name": skill_name,
            "description": meta.get("description", ""),
            "version": meta.get("version", "1.0.0"),
            "path": f"s3://{bucket}/skills/{skill_name}/",
            "files": files,
        },
    }


def ensure_default_records() -> list[dict[str, Any]]:
    """Register the gateway targets (MCP) + sample skill bundle (AGENT_SKILLS)."""
    client = control_client()
    registry_id = _registry_id()
    settings = get_settings()
    results: list[dict[str, Any]] = []

    gateway_url = settings.resources.get("gateway_url", "")
    tools = mcp_client.tools_list()
    by_target: dict[str, list[dict[str, Any]]] = {}
    for tool in tools:
        if "___" in tool["name"]:
            target, short = tool["name"].split("___", 1)
            by_target.setdefault(target, []).append(
                {
                    "name": short,
                    "description": tool.get("description", ""),
                    "inputSchema": tool.get("inputSchema", {}),
                }
            )
    for target, target_tools in sorted(by_target.items()):
        description = f"Gateway target {target} · {len(target_tools)} MCP tool(s)"
        record, created = reg.upsert_record(
            client,
            registry_id,
            name=target,
            description=description,
            descriptor_type="MCP",
            descriptors=reg.build_mcp_descriptors(
                target=target,
                description=description,
                gateway_url=gateway_url,
                tools=target_tools,
            ),
        )
        if created:
            reg.wait_record_settled(client, registry_id, record["recordId"])
            reg.submit_record(client, registry_id, record["recordId"])
        results.append({"name": target, "type": "MCP", "record_id": record["recordId"],
                        "created": created})

    bundle = upload_skill_bundle()
    record, created = reg.upsert_record(
        client,
        registry_id,
        name=SKILL_NAME,
        description=bundle["definition"]["description"][:200],
        descriptor_type="AGENT_SKILLS",
        descriptors=reg.build_skills_descriptors(
            skill_md=bundle["skill_md"], definition=bundle["definition"]
        ),
    )
    if created:
        reg.wait_record_settled(client, registry_id, record["recordId"])
        reg.submit_record(client, registry_id, record["recordId"])
    results.append({"name": SKILL_NAME, "type": "AGENT_SKILLS",
                    "record_id": record["recordId"], "created": created})
    return results


def skill_attach_path(skill_name: str = SKILL_NAME) -> str:
    """The skills[{path}] value a harness spec uses to attach the bundle."""
    bucket = get_settings().resources.get("artifacts_bucket", "")
    return f"s3://{bucket}/skills/{skill_name}/"


def console_list(descriptor_type: str | None = None, status: str | None = None) -> list[dict]:
    return reg.list_records(control_client(), _registry_id(), descriptor_type, status)


def console_get(record_id: str) -> dict[str, Any]:
    return reg.get_record(control_client(), _registry_id(), record_id)


def console_search(query: str) -> list[dict[str, Any]]:
    return reg.search_records(data_client(), [_registry_id()], query)


def console_action(record_id: str, action: str) -> dict[str, Any]:
    client = control_client()
    registry_id = _registry_id()
    if action == "submit":
        return reg.submit_record(client, registry_id, record_id)
    if action in ("approve", "publish"):
        return reg.approve_record(client, registry_id, record_id)
    if action == "reject":
        return reg.reject_record(client, registry_id, record_id)
    if action == "disable":
        return reg.disable_record(client, registry_id, record_id)
    raise ValueError(f"unknown action '{action}'")


def console_delete(record_id: str) -> None:
    reg.delete_record(control_client(), _registry_id(), record_id)


def attachable_records() -> dict[str, Any]:
    """Catalog entries an agent can mount, sourced ONLY from APPROVED records —
    the registry lifecycle is the availability gate. MCP records split on the
    remote URL: the shared gateway attaches as agentcore_gateway (OAuth), any
    other URL attaches as remote_mcp. Skills carry the s3 path a harness
    mounts via skills[{path}]."""
    client = control_client()
    registry_id = _registry_id()
    gateway_url = get_settings().resources.get("gateway_url", "")
    mcp_servers: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []
    for summary in reg.list_records(client, registry_id, None, "APPROVED"):
        kind = summary.get("descriptorType")
        if kind not in ("MCP", "AGENT_SKILLS"):
            continue
        record = reg.get_record(client, registry_id, summary["recordId"])
        try:
            if kind == "MCP":
                server = json.loads(
                    record["descriptors"]["mcp"]["server"]["inlineContent"]
                )
                url = (server.get("remotes") or [{}])[0].get("url", "")
                if not url:
                    continue
                mcp_servers.append(
                    {
                        "name": record["name"],
                        "description": record.get("description", ""),
                        "url": url,
                        "gateway": bool(gateway_url) and url == gateway_url,
                        "record_id": record["recordId"],
                    }
                )
            else:
                definition = json.loads(
                    record["descriptors"]["agentSkills"]["skillDefinition"]["inlineContent"]
                )
                path = definition.get("path") or ""
                if not path:
                    continue
                skills.append(
                    {
                        "name": record["name"],
                        "description": definition.get("description", ""),
                        "path": path,
                        "record_id": record["recordId"],
                    }
                )
        except (KeyError, ValueError, TypeError):
            continue  # malformed descriptor — skip, never break the catalog
    return {"mcp_servers": mcp_servers, "skills": skills}


def _require_new_name(client: Any, registry_id: str, name: str, kind: str) -> None:
    if reg.find_record(client, registry_id, name, kind):
        raise AppError(
            "registry.name_exists",
            f"a {kind} record named '{name}' already exists",
            status_code=409,
        )


def register_mcp_server(name: str, description: str, url: str) -> dict[str, Any]:
    """Register an external remote MCP server (streamable-http URL) as an MCP
    record. Starts in DRAFT — the console lifecycle (submit → approve) gates
    when it becomes attachable to agents."""
    client = control_client()
    registry_id = _registry_id()
    _require_new_name(client, registry_id, name, "MCP")
    record, _ = reg.upsert_record(
        client,
        registry_id,
        name=name,
        description=description or f"remote MCP server · {url}",
        descriptor_type="MCP",
        descriptors=reg.build_mcp_descriptors(
            target=name, description=description, gateway_url=url, tools=None
        ),
    )
    return reg.wait_record_settled(client, registry_id, record["recordId"])


def _utcnow_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def register_skill_bundle(
    bundle: SkillBundle,
    *,
    name_override: str | None = None,
    description_override: str | None = None,
) -> dict[str, Any]:
    """Register any acquired skill bundle: validate → reserve the name → upload
    every file under ``bundle.root`` to ``skills/{name}/{rel}`` → create the
    AGENT_SKILLS record with the real file list + provenance. Starts in DRAFT.

    The single funnel every source (inline/zip and later git/url) converges on.
    Best-effort: if record creation fails after upload, the uploaded objects are
    deleted so no orphan S3 prefix is left behind.
    """
    name = (name_override or bundle.name or "").strip()
    if not SKILL_NAME_RE.match(name):
        raise SkillValidationError(
            f"skill name '{name}' must match ^[a-z][a-z0-9-]{{2,63}}$ "
            "(set it in SKILL.md frontmatter or provide an override)"
        )
    validate_bundle(bundle)

    client = control_client()
    registry_id = _registry_id()
    _require_new_name(client, registry_id, name, "AGENT_SKILLS")

    settings = get_settings()
    bucket = settings.resources.get("artifacts_bucket")
    if not bucket:
        raise RuntimeError("artifacts_bucket missing — run scripts/bootstrap.py")

    prefix = f"skills/{name}/"
    description = (description_override or bundle.description or "").strip()
    source = replace(bundle.source, imported_at=_utcnow_iso())
    definition = {
        "name": name,
        "description": description,
        "version": bundle.version,
        "path": f"s3://{bucket}/{prefix}",
        "files": bundle.files,
        "source": asdict(source),
    }
    # skillDefinition.inlineContent has the same 102,400-byte AWS cap as skillMd;
    # a large file list (many/long paths) could overflow it. Fail cleanly at the
    # Launchpad layer *before* uploading, so no S3 objects are created (AC4/AC5).
    definition_bytes = len(json.dumps(definition).encode("utf-8"))
    if definition_bytes > SKILL_MD_MAX_BYTES:
        raise SkillValidationError(
            f"skill descriptor is {definition_bytes} bytes — exceeds the "
            f"{SKILL_MD_MAX_BYTES} byte limit (too many files or paths too long)"
        )

    s3 = boto3.client("s3", region_name=settings.region)
    uploaded: list[str] = []
    try:
        upload_bundle_files(bundle, bucket, prefix, s3, uploaded=uploaded)

        record, _ = reg.upsert_record(
            client,
            registry_id,
            name=name,
            description=(description or name)[:200],
            descriptor_type="AGENT_SKILLS",
            descriptors=reg.build_skills_descriptors(
                skill_md=bundle.skill_md, definition=definition
            ),
        )
        return reg.wait_record_settled(client, registry_id, record["recordId"])
    except Exception:
        _delete_keys(s3, bucket, uploaded)  # best-effort orphan cleanup
        raise


def upload_bundle_files(
    bundle: SkillBundle,
    bucket: str,
    prefix: str,
    s3: Any,
    *,
    uploaded: list[str] | None = None,
) -> list[str]:
    """Upload every file under ``bundle.root`` to ``{prefix}{rel}``. Keys are
    appended to ``uploaded`` AS they land so a mid-batch failure leaves the
    caller an exact cleanup list. Shared by the registry funnel and the
    attach-without-record path (/api/agent-skills)."""
    keys = uploaded if uploaded is not None else []
    for rel in bundle.files:
        key = f"{prefix}{rel}"
        s3.upload_file(str(bundle.root / rel), bucket, key)
        keys.append(key)
    return keys


def _delete_keys(s3: Any, bucket: str, keys: list[str]) -> None:
    for key in keys:
        try:
            s3.delete_object(Bucket=bucket, Key=key)
        except Exception:  # cleanup must never mask the original failure
            pass


def register_skill(name: str, description: str, skill_md: str) -> dict[str, Any]:
    """Register a skill from raw SKILL.md content (the console paste path). Thin
    wrapper over ``register_skill_bundle`` via the inline acquirer — behaviour is
    unchanged bar the additive ``source`` field in the descriptor."""
    bundle = bundle_from_inline(skill_md)
    try:
        return register_skill_bundle(
            bundle, name_override=name, description_override=description or None
        )
    finally:
        bundle.close()


def _bump_minor(version: str) -> str:
    """Bump the minor component of a dotted version (``1.0.0`` → ``1.1.0``). A
    version whose major/minor don't parse resets to a clean bumped baseline
    rather than failing the reimport."""
    parts = (version or "").split(".")
    try:
        major = int(parts[0])
    except (ValueError, IndexError):
        return "1.1.0"
    try:
        minor = int(parts[1])
    except (ValueError, IndexError):
        minor = 0
    return f"{major}.{minor + 1}.0"


def _delete_prefix(s3: Any, bucket: str, prefix: str) -> None:
    """Delete every object under ``prefix`` (paginated list, not a single call —
    a bundle can exceed one list page). Used before a reimport re-upload so files
    removed at the source don't linger in S3."""
    keys: list[str] = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        keys.extend(obj["Key"] for obj in page.get("Contents", []))
    _delete_keys(s3, bucket, keys)


def reimport_skill(record_id: str) -> dict[str, Any]:
    """Re-run the ingestion pipeline for a git/url-sourced skill record: re-acquire
    from the stored provenance, replace the whole S3 prefix, and update the record
    with a bumped ``recordVersion`` and a refreshed ``imported_at``.

    Only git/url records carry a retrievable origin — inline/zip records raise
    ``registry.not_reimportable`` (400), as do DEPRECATED records (terminal). The
    record's registered name is kept even if the source's frontmatter name
    changed, since the S3 prefix and record identity are keyed by name. Private
    git repos have no persisted token, so a private reimport surfaces the (token-
    redacted) clone/download error — accepted by design.
    """
    client = control_client()
    registry_id = _registry_id()
    record = reg.get_record(client, registry_id, record_id)
    if record.get("status") == "DEPRECATED":
        raise AppError(
            "registry.not_reimportable",
            "a DEPRECATED record is terminal and cannot be reimported",
            status_code=400,
        )
    name = (record.get("name") or "").strip()
    try:
        old_definition = json.loads(
            record["descriptors"]["agentSkills"]["skillDefinition"]["inlineContent"]
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise AppError(
            "registry.not_reimportable",
            "record has no readable skill descriptor to reimport",
            status_code=400,
        ) from exc
    source = old_definition.get("source") or {}
    kind = source.get("kind")
    if kind not in ("git", "url"):
        raise AppError(
            "registry.not_reimportable",
            f"only git/url-sourced skills can be reimported (source kind: {kind or 'none'})",
            status_code=400,
        )

    bundle = bundle_from_source(source)
    try:
        return _reupload_and_update(client, registry_id, record, name, bundle)
    finally:
        bundle.close()


def _reupload_and_update(
    client: Any,
    registry_id: str,
    record: dict[str, Any],
    name: str,
    bundle: SkillBundle,
    *,
    description: str | None = None,
) -> dict[str, Any]:
    """Validate the re-acquired bundle, clear the old S3 prefix, upload the fresh
    files, and update the record (bumped recordVersion, refreshed provenance).

    ``description`` overrides the record's current description (the edit sub-page
    passes a new one alongside the bundle); ``None`` keeps the existing one, which
    is what reimport wants.
    """
    if not SKILL_NAME_RE.match(name):
        raise SkillValidationError(f"record name '{name}' is not a valid skill name")
    validate_bundle(bundle)

    settings = get_settings()
    bucket = settings.resources.get("artifacts_bucket")
    if not bucket:
        raise RuntimeError("artifacts_bucket missing — run scripts/bootstrap.py")

    prefix = f"skills/{name}/"
    if description is None:
        description = record.get("description") or bundle.description
    description = (description or "").strip()
    source = replace(bundle.source, imported_at=_utcnow_iso())
    new_version = _bump_minor(record.get("recordVersion") or "1.0.0")
    definition = {
        "name": name,
        "description": description,
        "version": bundle.version,
        "path": f"s3://{bucket}/{prefix}",
        "files": bundle.files,
        "source": asdict(source),
    }
    definition_bytes = len(json.dumps(definition).encode("utf-8"))
    if definition_bytes > SKILL_MD_MAX_BYTES:
        raise SkillValidationError(
            f"skill descriptor is {definition_bytes} bytes — exceeds the "
            f"{SKILL_MD_MAX_BYTES} byte limit (too many files or paths too long)"
        )

    s3 = boto3.client("s3", region_name=settings.region)
    # Clear the old prefix FIRST so files dropped at the source don't linger, then
    # upload the fresh set. Unlike the create path we deliberately do NOT roll back
    # the upload if the record update later fails: the record already exists and
    # points at this prefix, so the freshly uploaded files are the correct contents
    # to leave behind (the consumer downloads the whole prefix, not the descriptor's
    # file list). Rolling them back would strand the live record over an empty
    # prefix — strictly worse. A failed update leaves only stale descriptor
    # metadata (version/files/imported_at), corrected on the next reimport.
    _delete_prefix(s3, bucket, prefix)
    for rel in bundle.files:
        key = f"{prefix}{rel}"
        s3.upload_file(str(bundle.root / rel), bucket, key)
    reg.upsert_record(
        client,
        registry_id,
        name=name,
        description=(description or name)[:200],
        descriptor_type="AGENT_SKILLS",
        descriptors=reg.build_skills_descriptors(
            skill_md=bundle.skill_md, definition=definition
        ),
        record_version=new_version,
    )
    return reg.wait_record_settled(client, registry_id, record["recordId"])


def update_record(
    record_id: str,
    *,
    description: str | None = None,
    url: str | None = None,
    skill_md: str | None = None,
    bundle: SkillBundle | None = None,
) -> dict[str, Any]:
    """Edit an existing MCP/AGENT_SKILLS record from the console edit sub-page.

    Partial update: a description-only change resends the current descriptors
    WITHOUT bumping ``recordVersion``; any content change rebuilds the descriptors
    and bumps the minor version (``1.0.0``→``1.1.0``). A new ``description`` given
    alongside a content change lands in the same update call. Content branches:

    - ``url`` (MCP only): rebuild the server descriptor for the new endpoint.
    - ``skill_md`` (AGENT_SKILLS only): overwrite just ``skills/{name}/SKILL.md``,
      keeping every supporting file and the recorded provenance (only
      ``imported_at`` refreshes); the descriptor's ``files``/``source`` are kept.
    - ``bundle`` (AGENT_SKILLS only): whole-bundle replace — clear the prefix,
      upload the new files, and write a fresh descriptor (reuses the reimport
      re-upload path); the record's registered name is always preserved.

    The record's registered name is never editable (the S3 prefix and record
    identity are keyed by it). DEPRECATED records are terminal and A2A records are
    owned by agent deploys — both refuse editing (400 ``registry.not_editable``).
    """
    client = control_client()
    registry_id = _registry_id()
    record = reg.get_record(client, registry_id, record_id)
    if record.get("status") == "DEPRECATED":
        raise AppError(
            "registry.not_editable",
            "a DEPRECATED record is terminal and cannot be edited",
            status_code=400,
        )
    rtype = record.get("descriptorType")
    if rtype == "A2A":
        raise AppError(
            "registry.not_editable",
            "A2A records are managed by agent deploys and cannot be edited here",
            status_code=400,
        )

    name = (record.get("name") or "").strip()
    new_desc = description if description is not None else (record.get("description") or "")

    if url is not None:
        return _update_mcp_url(client, registry_id, record, name, url, new_desc)
    if skill_md is not None:
        return _update_skill_md(client, registry_id, record, name, skill_md, new_desc)
    if bundle is not None:
        return _reupload_and_update(
            client, registry_id, record, name, bundle, description=description
        )
    # description-only: resend the current descriptors unchanged (AWS update
    # always requires descriptors) with the new description, no version bump.
    reg.upsert_record(
        client,
        registry_id,
        name=name,
        description=(new_desc or name)[:200],
        descriptor_type=rtype,
        descriptors=record.get("descriptors") or {},
    )
    return reg.wait_record_settled(client, registry_id, record["recordId"])


def _update_mcp_url(
    client: Any,
    registry_id: str,
    record: dict[str, Any],
    name: str,
    url: str,
    description: str,
) -> dict[str, Any]:
    """Rebuild an MCP record's server descriptor for a new endpoint URL and bump
    the minor version."""
    new_version = _bump_minor(record.get("recordVersion") or "1.0.0")
    reg.upsert_record(
        client,
        registry_id,
        name=name,
        description=(description or name)[:200],
        descriptor_type="MCP",
        descriptors=reg.build_mcp_descriptors(
            target=name, description=description, gateway_url=url, tools=None
        ),
        record_version=new_version,
    )
    return reg.wait_record_settled(client, registry_id, record["recordId"])


def _update_skill_md(
    client: Any,
    registry_id: str,
    record: dict[str, Any],
    name: str,
    skill_md: str,
    description: str,
) -> dict[str, Any]:
    """Overwrite ONLY ``skills/{name}/SKILL.md`` and refresh the descriptor,
    leaving every supporting file in the prefix untouched (no prefix clear). The
    definition keeps its ``files``/``source`` list; ``version`` follows the new
    frontmatter (falling back to the old value) and ``source.imported_at`` is
    refreshed. Minor version bump."""
    md_bytes = len(skill_md.encode("utf-8"))
    if md_bytes > SKILL_MD_MAX_BYTES:
        raise SkillValidationError(
            f"SKILL.md is {md_bytes} bytes — exceeds the {SKILL_MD_MAX_BYTES} byte limit"
        )

    settings = get_settings()
    bucket = settings.resources.get("artifacts_bucket")
    if not bucket:
        raise RuntimeError("artifacts_bucket missing — run scripts/bootstrap.py")

    try:
        old = json.loads(
            record["descriptors"]["agentSkills"]["skillDefinition"]["inlineContent"]
        )
        if not isinstance(old, dict):
            old = {}
    except (KeyError, ValueError, TypeError):
        old = {}  # malformed/absent descriptor — rebuild from scratch below

    prefix = f"skills/{name}/"
    meta = parse_frontmatter(skill_md)
    source = old.get("source")
    source = dict(source) if isinstance(source, dict) else {"kind": "inline"}
    source["imported_at"] = _utcnow_iso()
    definition = {
        "name": name,
        "description": (description or old.get("description") or name),
        "version": str(meta.get("version") or old.get("version") or "1.0.0").strip(),
        "path": f"s3://{bucket}/{prefix}",
        "files": old.get("files") or ["SKILL.md"],
        "source": source,
    }
    definition_bytes = len(json.dumps(definition).encode("utf-8"))
    if definition_bytes > SKILL_MD_MAX_BYTES:
        raise SkillValidationError(
            f"skill descriptor is {definition_bytes} bytes — exceeds the "
            f"{SKILL_MD_MAX_BYTES} byte limit (too many files or paths too long)"
        )

    s3 = boto3.client("s3", region_name=settings.region)
    # Only SKILL.md changed — overwrite exactly that object; do NOT clear the
    # prefix (that would strand the supporting files the deploy-time consumer
    # downloads alongside it).
    s3.put_object(Bucket=bucket, Key=f"{prefix}SKILL.md", Body=skill_md.encode("utf-8"))

    new_version = _bump_minor(record.get("recordVersion") or "1.0.0")
    reg.upsert_record(
        client,
        registry_id,
        name=name,
        description=(definition["description"] or name)[:200],
        descriptor_type="AGENT_SKILLS",
        descriptors=reg.build_skills_descriptors(skill_md=skill_md, definition=definition),
        record_version=new_version,
    )
    return reg.wait_record_settled(client, registry_id, record["recordId"])
