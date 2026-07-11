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
    card = reg.build_a2a_card(
        name=agent.name,
        description=(spec.get("system_prompt") or "")[:180] or f"Launchpad agent {agent.name}",
        arn=agent.arn or "",
        version=agent.version or "1",
        method=agent.method,
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
        for rel in bundle.files:
            key = f"{prefix}{rel}"
            s3.upload_file(str(bundle.root / rel), bucket, key)
            uploaded.append(key)

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
