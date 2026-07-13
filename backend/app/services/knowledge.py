"""Knowledge Base service — CRUD, S3 data sources, ingestion, and the
retrieval Playground.

The list/detail/query/sync/documents READ surface covers every KB type in the
account (MANAGED, VECTOR, KENDRA, SQL) so console-created KBs show up for
unified management. All MUTATIONS stay ``type == "MANAGED"``-only — non-managed
KBs are external resources Launchpad did not create, and the AgentCore gateway
connector can only serve managed KBs anyway (so only those are attachable).
List summaries omit the type — GetKnowledgeBase carries it. Style mirrors
registry_console: thin service over the bedrock-agent / bedrock-agent-runtime
wrappers, with the Agent ledger scanned for attachment relationships.
"""

import json
import re
import time
from typing import Any

import boto3

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.errors import AppError, NotFoundError
from app.models.ledger import Agent
from app.services import kb_gateway
from app.services.agentcore.client import (
    agent_client,
    agent_runtime_client,
    control_client,
)

KB_ROLE_NAME = "launchpad-kb-role"


class KBAttachedError(AppError):
    """A KB with agents mounted was deleted without ``force`` — 409 carrying the
    blocking agent names in ``detail.agents`` (same envelope shape as agents.py)."""

    def __init__(self, kb_id: str, agents: list[str]):
        super().__init__(
            "kb.has_attached_agents",
            f"knowledge base is attached to {len(agents)} agent(s); "
            "pass force=true to delete anyway",
            detail={"agents": agents},
            status_code=409,
        )
        self.agents = agents


# ── helpers ────────────────────────────────────────────────────────────────


def _slug(text: str, max_len: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:max_len].rstrip("-")


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _kb_type(detail: dict[str, Any]) -> str:
    return (detail.get("knowledgeBaseConfiguration") or {}).get("type", "")


def _get_kb(client: Any, kb_id: str) -> dict[str, Any]:
    try:
        return client.get_knowledge_base(knowledgeBaseId=kb_id)["knowledgeBase"]
    except client.exceptions.ResourceNotFoundException as exc:
        raise NotFoundError("kb.not_found", "knowledge base not found") from exc


def _require_managed(detail: dict[str, Any]) -> dict[str, Any]:
    # non-MANAGED KBs are out of scope and must never be addressable here
    if _kb_type(detail) != "MANAGED":
        raise NotFoundError("kb.not_found", "knowledge base not found")
    return detail


def _paginate(fn, key: str, **kwargs) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    token = None
    while True:
        page = fn(**(kwargs | ({"nextToken": token} if token else {})))
        items.extend(page.get(key, []))
        token = page.get("nextToken")
        if not token:
            break
    return items


def _list_data_sources(client: Any, kb_id: str) -> list[dict[str, Any]]:
    return _paginate(
        client.list_data_sources, "dataSourceSummaries", knowledgeBaseId=kb_id, maxResults=100
    )


def _parse_ds_location(detail: dict[str, Any]) -> tuple[str | None, str | None]:
    """Best-effort (bucket, prefix) from an S3-backed data source.

    Managed connector: ``connectorParameters`` is a document member —
    GetDataSource returns it as a JSON *string*, while our create path sends a
    dict; accept both. Classic (VECTOR-KB) sources use ``s3Configuration`` whose
    bucket field is a **bucketArn**."""
    config = detail.get("dataSourceConfiguration") or {}
    try:
        params = config["managedKnowledgeBaseConnectorConfiguration"]["connectorParameters"]
        if isinstance(params, str):
            params = json.loads(params)
        bucket = (params.get("connectionConfiguration") or {}).get("bucketName")
        prefixes = (params.get("filterConfiguration") or {}).get("inclusionPrefixes") or []
        return bucket, (prefixes[0] if prefixes else None)
    except (KeyError, TypeError, IndexError, ValueError):
        pass
    s3_config = config.get("s3Configuration") or {}
    if s3_config.get("bucketArn"):
        bucket = s3_config["bucketArn"].rpartition(":::")[2] or None
        prefixes = s3_config.get("inclusionPrefixes") or []
        return bucket, (prefixes[0] if prefixes else None)
    return None, None


def _ds_source_label(detail: dict[str, Any]) -> str | None:
    """Human label for non-S3 classic sources (web crawl / SaaS connectors)."""
    config = detail.get("dataSourceConfiguration") or {}
    web = config.get("webConfiguration") or {}
    seeds = (
        ((web.get("sourceConfiguration") or {}).get("urlConfiguration") or {}).get("seedUrls")
        or []
    )
    if seeds:
        return seeds[0].get("url")
    for key in ("confluenceConfiguration", "sharePointConfiguration", "salesforceConfiguration"):
        source = (config.get(key) or {}).get("sourceConfiguration") or {}
        host = source.get("hostUrl") or (source.get("siteUrls") or [None])[0]
        if host:
            return host
    return None


def _job_out(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job.get("ingestionJobId"),
        "status": job.get("status"),
        "started_at": _iso(job.get("startedAt")),
        "updated_at": _iso(job.get("updatedAt")),
        "statistics": job.get("statistics") or {},
        "failure_reasons": job.get("failureReasons") or [],
    }


def _recent_ingestion_jobs(
    client: Any, kb_id: str, ds_id: str, cap: int = 10
) -> list[dict[str, Any]]:
    jobs = _paginate(
        client.list_ingestion_jobs,
        "ingestionJobSummaries",
        knowledgeBaseId=kb_id,
        dataSourceId=ds_id,
        maxResults=100,
    )
    jobs.sort(key=lambda j: str(j.get("startedAt") or ""), reverse=True)  # newest first
    return [_job_out(j) for j in jobs[:cap]]


# ── attachment (Agent ledger) ────────────────────────────────────────────────


def _attached_map() -> dict[str, list[str]]:
    """kb_id → [agent name] over non-deleted agents' spec['knowledge_bases']."""
    db = SessionLocal()
    try:
        out: dict[str, list[str]] = {}
        for agent in db.query(Agent).filter(Agent.status != "deleted").all():
            for ref in (agent.spec or {}).get("knowledge_bases") or []:
                if isinstance(ref, dict) and ref.get("kb_id"):
                    out.setdefault(ref["kb_id"], []).append(agent.name)
        return out
    finally:
        db.close()


def attached_agents(kb_id: str) -> list[str]:
    return _attached_map().get(kb_id, [])


def _strip_kb_from_agents(kb_id: str) -> list[str]:
    """Force-delete follow-through: drop the KB from every mounted agent's spec
    and re-sync their per-agent agentic targets so retrieval doesn't dangle on a
    deleted KB id (and later re-publishes don't try to recreate its target).
    The deployed harness keeps its stale prompt section until the next
    re-publish — harmless, the tool itself no longer routes to the dead KB."""
    gateway_id = get_settings().resources.get("kb_gateway_id")
    control = control_client() if gateway_id else None
    stripped: list[str] = []
    db = SessionLocal()
    try:
        for agent in db.query(Agent).filter(Agent.status != "deleted").all():
            refs = (agent.spec or {}).get("knowledge_bases") or []
            remaining = [r for r in refs if isinstance(r, dict) and r.get("kb_id") != kb_id]
            if len(remaining) == len(refs):
                continue
            spec = dict(agent.spec)
            spec["knowledge_bases"] = remaining
            agent.spec = spec
            stripped.append(agent.name)
            if control and gateway_id:
                try:
                    kb_gateway.sync_agentic_target(
                        control,
                        gateway_id,
                        agent.name,
                        [
                            {"kb_id": r["kb_id"], "description": r.get("description", "")}
                            for r in remaining
                        ],
                    )
                except Exception:  # target resync is best-effort during delete
                    pass
        db.commit()
    finally:
        db.close()
    return stripped


# ── IAM: per-KB inline read policy for external buckets ───────────────────────


def _kb_policy_name(kb_id: str) -> str:
    return f"launchpad-kb-{kb_id}"


def _kb_policy_document(bucket: str, prefix: str) -> dict[str, Any]:
    list_stmt: dict[str, Any] = {
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": f"arn:aws:s3:::{bucket}",
    }
    if prefix:
        list_stmt["Condition"] = {"StringLike": {"s3:prefix": [f"{prefix}*"]}}
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["s3:GetObject"],
                "Resource": f"arn:aws:s3:::{bucket}/{prefix}*",
            },
            list_stmt,
        ],
    }


def _sync_kb_policy(kb_id: str, bucket: str, prefix: str) -> None:
    iam = boto3.client("iam", region_name=get_settings().region)
    iam.put_role_policy(
        RoleName=KB_ROLE_NAME,
        PolicyName=_kb_policy_name(kb_id),
        PolicyDocument=json.dumps(_kb_policy_document(bucket, prefix)),
    )


def _delete_kb_policy(kb_id: str) -> None:
    iam = boto3.client("iam", region_name=get_settings().region)
    try:
        iam.delete_role_policy(RoleName=KB_ROLE_NAME, PolicyName=_kb_policy_name(kb_id))
    except Exception:  # NoSuchEntity / role absent — nothing to clean
        pass


# ── data-source construction ─────────────────────────────────────────────────


# S3 general-purpose bucket naming. Beyond matching AWS's own rules, this blocks
# wildcards ('*') and path separators ('/') that would otherwise widen the per-KB
# inline read policy (_kb_policy_document interpolates the name straight into the
# grant ARNs) from one bucket to the whole account.
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


def _validate_external_source(bucket: str, prefix: str) -> None:
    if not _BUCKET_RE.match(bucket):
        raise AppError(
            "kb.invalid_bucket",
            "invalid S3 bucket name — 3–63 chars, lowercase letters, digits, "
            "dots or hyphens only",
            status_code=400,
        )
    if "*" in prefix:  # the prefix is a literal path, not an IAM/S3 wildcard
        raise AppError(
            "kb.invalid_prefix", "S3 prefix must be a literal path, not a wildcard", status_code=400
        )


def _resolve_source(kb_id: str, source: dict[str, Any]) -> tuple[str, str]:
    """(bucket, prefix) for a source descriptor. ``upload`` targets the artifacts
    bucket under ``kb/{kb_id}/``; ``existing`` uses the caller's bucket/prefix."""
    settings = get_settings()
    artifacts = settings.resources.get("artifacts_bucket")
    mode = (source or {}).get("mode") or "upload"
    if mode == "upload":
        if not artifacts:
            raise RuntimeError("artifacts_bucket missing — run scripts/bootstrap.py")
        return artifacts, f"kb/{kb_id}/"
    if mode == "existing":
        bucket = (source.get("bucket") or "").strip()
        if not bucket:
            raise AppError(
                "kb.bucket_required", "an existing S3 source needs a bucket", status_code=400
            )
        prefix = (source.get("prefix") or "").strip().lstrip("/")
        _validate_external_source(bucket, prefix)
        return bucket, prefix
    raise AppError("kb.invalid_source", f"unsupported source mode '{mode}'", status_code=400)


def _ds_name(bucket: str, prefix: str) -> str:
    base = _slug(bucket, 40) or "s3"
    if prefix:
        base = f"{base}-{_slug(prefix, 20)}"
    return base[:60] or "s3-source"


def _data_source_configuration(bucket: str, prefix: str, account_id: str) -> dict[str, Any]:
    conn: dict[str, Any] = {
        "type": "S3",
        "version": "1",
        "connectionConfiguration": {
            "bucketName": bucket,
            "bucketOwnerAccountId": account_id,
        },
    }
    if prefix:
        conn["filterConfiguration"] = {"inclusionPrefixes": [prefix]}
    return {
        "type": "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
        "managedKnowledgeBaseConnectorConfiguration": {"connectorParameters": conn},
    }


def _create_data_source(client: Any, kb_id: str, source: dict[str, Any]) -> str:
    settings = get_settings()
    bucket, prefix = _resolve_source(kb_id, source)
    if bucket != settings.resources.get("artifacts_bucket"):
        _sync_kb_policy(kb_id, bucket, prefix)  # dynamic S3 read grant for BYO buckets
    created = client.create_data_source(
        knowledgeBaseId=kb_id,
        name=_ds_name(bucket, prefix),
        dataSourceConfiguration=_data_source_configuration(bucket, prefix, settings.account_id),
        vectorIngestionConfiguration={"parsingConfiguration": {"parsingStrategy": "SMART_PARSING"}},
    )
    return created["dataSource"]["dataSourceId"]


def _has_artifacts_data_source(client: Any, kb_id: str, artifacts: str) -> bool:
    prefix = f"kb/{kb_id}/"
    for ds in _list_data_sources(client, kb_id):
        detail = client.get_data_source(knowledgeBaseId=kb_id, dataSourceId=ds["dataSourceId"])[
            "dataSource"
        ]
        bucket, ds_prefix = _parse_ds_location(detail)
        if bucket == artifacts and (ds_prefix or "").startswith(prefix):
            return True
    return False


def _safe_filename(filename: str) -> str:
    name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    return name if name not in ("", ".", "..") else "file"


# ── public API ────────────────────────────────────────────────────────────────


def list_kbs(kb_type: str | None = None) -> list[dict[str, Any]]:
    """Every KB in the account, any type; ``kb_type`` filters (the Create-Agent
    picker asks for MANAGED — the only type the gateway connector can serve)."""
    client = agent_client()
    attached = _attached_map()
    items: list[dict[str, Any]] = []
    for summary in _paginate(
        client.list_knowledge_bases, "knowledgeBaseSummaries", maxResults=100
    ):
        kb_id = summary["knowledgeBaseId"]
        detail = client.get_knowledge_base(knowledgeBaseId=kb_id)["knowledgeBase"]
        type_ = _kb_type(detail)
        if kb_type and type_ != kb_type:
            continue
        items.append(
            {
                "kb_id": kb_id,
                "name": detail.get("name"),
                "description": detail.get("description", ""),
                "status": detail.get("status"),
                "type": type_,
                "attachable": type_ == "MANAGED",
                "updated_at": _iso(detail.get("updatedAt")),
                "data_source_count": len(_list_data_sources(client, kb_id)),
                "attached_agents": attached.get(kb_id, []),
            }
        )
    return items


def get_kb_detail(kb_id: str) -> dict[str, Any]:
    client = agent_client()
    detail = _get_kb(client, kb_id)
    type_ = _kb_type(detail)
    data_sources: list[dict[str, Any]] = []
    for ds in _list_data_sources(client, kb_id):
        ds_id = ds["dataSourceId"]
        full = client.get_data_source(knowledgeBaseId=kb_id, dataSourceId=ds_id)["dataSource"]
        bucket, prefix = _parse_ds_location(full)
        data_sources.append(
            {
                "ds_id": ds_id,
                "name": full.get("name"),
                "status": full.get("status"),
                "bucket": bucket,
                "prefix": prefix,
                "location_label": _ds_source_label(full) if bucket is None else None,
                "failure_reasons": full.get("failureReasons") or [],
                "ingestion_jobs": _recent_ingestion_jobs(client, kb_id, ds_id),
            }
        )
    return {
        "kb_id": kb_id,
        "name": detail.get("name"),
        "description": detail.get("description", ""),
        "status": detail.get("status"),
        "type": type_,
        # external (non-managed) KBs are browse/query/sync-only in Launchpad
        "read_only": type_ != "MANAGED",
        "attachable": type_ == "MANAGED",
        "arn": detail.get("knowledgeBaseArn"),
        "created_at": _iso(detail.get("createdAt")),
        "updated_at": _iso(detail.get("updatedAt")),
        "failure_reasons": detail.get("failureReasons") or [],
        "data_sources": data_sources,
        "attached_agents": attached_agents(kb_id),
    }


def _s3_object_meta(bucket: str, prefix: str | None) -> dict[str, tuple[int, str | None]]:
    """key → (size, last_modified ISO) over the source location. Best-effort
    upload-time/size enrichment — external buckets may deny the backend, and
    huge buckets are capped (enrichment, not the source of truth)."""
    s3 = boto3.client("s3", region_name=get_settings().region)
    out: dict[str, tuple[int, str | None]] = {}
    kwargs: dict[str, Any] = {"Bucket": bucket}
    if prefix:
        kwargs["Prefix"] = prefix
    for _ in range(5):  # ≤5k objects
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            out[obj["Key"]] = (obj.get("Size", 0), _iso(obj.get("LastModified")))
        if not resp.get("IsTruncated"):
            break
        kwargs["ContinuationToken"] = resp["NextContinuationToken"]
    return out


def list_documents(
    kb_id: str, ds_id: str, *, page_size: int = 50, token: str | None = None
) -> dict[str, Any]:
    """One page of a data source's documents (ListKnowledgeBaseDocuments,
    token-paginated) with the KB-side index status plus S3-side size and
    upload time joined in by object key."""
    client = agent_client()
    _get_kb(client, kb_id)  # 404 unknown ids; documents are readable for any type
    kwargs: dict[str, Any] = {
        "knowledgeBaseId": kb_id,
        "dataSourceId": ds_id,
        "maxResults": page_size,
    }
    if token:
        kwargs["nextToken"] = token
    try:
        resp = client.list_knowledge_base_documents(**kwargs)
        full = client.get_data_source(knowledgeBaseId=kb_id, dataSourceId=ds_id)["dataSource"]
    except client.exceptions.ResourceNotFoundException as exc:
        raise NotFoundError("kb.ds_not_found", "data source not found") from exc
    bucket, prefix = _parse_ds_location(full)
    meta: dict[str, tuple[int, str | None]] = {}
    if bucket:
        try:
            meta = _s3_object_meta(bucket, prefix)
        except Exception:
            meta = {}
    documents: list[dict[str, Any]] = []
    for doc in resp.get("documentDetails", []):
        uri = ((doc.get("identifier") or {}).get("s3") or {}).get("uri") or ""
        key = uri.removeprefix(f"s3://{bucket}/") if bucket else ""
        size, uploaded = meta.get(key, (None, None)) if key != uri else (None, None)
        documents.append(
            {
                "name": uri.rsplit("/", 1)[-1] or uri or "—",
                "uri": uri,
                "status": doc.get("status"),
                "status_reason": doc.get("statusReason"),
                "indexed_at": _iso(doc.get("updatedAt")),
                "size_bytes": size,
                "uploaded_at": uploaded,
            }
        )
    return {
        "documents": documents,
        "next_token": resp.get("nextToken"),
        "page_size": page_size,
    }


def _wait_kb_active(client: Any, kb_id: str, timeout_s: int = 60, interval_s: int = 3) -> str:
    """Poll until the KB leaves CREATING (or the fast-path window closes).
    Returns the last observed status; only FAILED raises. KB creation was
    observed to take 1.5–3 min — callers must treat a lingering CREATING as
    normal and let the client finish the source setup once ACTIVE."""
    deadline = time.time() + timeout_s
    while True:
        detail = client.get_knowledge_base(knowledgeBaseId=kb_id)["knowledgeBase"]
        status = detail.get("status")
        if status == "FAILED":
            raise AppError(
                "kb.create_failed",
                f"knowledge base creation FAILED: {detail.get('failureReasons')}",
                status_code=502,
            )
        if status != "CREATING" or time.time() >= deadline:
            return status
        time.sleep(interval_s)


def create_kb(name: str, description: str, source: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    role_arn = settings.resources.get("kb_role_arn")
    if not role_arn:
        raise RuntimeError("kb_role_arn missing — run scripts/bootstrap.py")
    client = agent_client()
    kwargs: dict[str, Any] = {
        "name": name,
        "roleArn": role_arn,
        "knowledgeBaseConfiguration": {
            "type": "MANAGED",
            "managedKnowledgeBaseConfiguration": {"embeddingModelType": "MANAGED"},
        },
    }
    if description:
        kwargs["description"] = description
    created = client.create_knowledge_base(**kwargs)
    kb_id = created["knowledgeBase"]["knowledgeBaseId"]
    status = _wait_kb_active(client, kb_id)
    if status == "ACTIVE":  # fast path — finish the source setup in one shot
        _create_data_source(client, kb_id, source)
        return get_kb_detail(kb_id)
    # still CREATING: return immediately; the client polls the detail and
    # replays the echoed source via POST /data-sources once ACTIVE
    detail = get_kb_detail(kb_id)
    detail["source_pending"] = source
    return detail


def upload_files(kb_id: str, files: list[tuple[str, bytes]]) -> list[str]:
    settings = get_settings()
    artifacts = settings.resources.get("artifacts_bucket")
    if not artifacts:
        raise RuntimeError("artifacts_bucket missing — run scripts/bootstrap.py")
    client = agent_client()
    _require_managed(_get_kb(client, kb_id))
    # zero data sources = an upload-mode KB whose source setup is still pending
    # (client replays it once the KB is ACTIVE) — files may land ahead of it
    if _list_data_sources(client, kb_id) and not _has_artifacts_data_source(
        client, kb_id, artifacts
    ):
        raise AppError(
            "kb.no_upload_target",
            "this KB has no data source on the uploads bucket — uploads are only "
            "available for KBs created in upload mode",
            status_code=409,
        )
    s3 = boto3.client("s3", region_name=settings.region)
    keys: list[str] = []
    for filename, data in files:
        key = f"kb/{kb_id}/{_safe_filename(filename)}"
        s3.put_object(Bucket=artifacts, Key=key, Body=data)
        keys.append(key)
    return keys


def add_data_source(kb_id: str, source: dict[str, Any]) -> dict[str, Any]:
    client = agent_client()
    _require_managed(_get_kb(client, kb_id))
    _create_data_source(client, kb_id, source)
    return get_kb_detail(kb_id)


def delete_data_source(kb_id: str, ds_id: str) -> dict[str, Any]:
    client = agent_client()
    _require_managed(_get_kb(client, kb_id))
    client.delete_data_source(knowledgeBaseId=kb_id, dataSourceId=ds_id)
    return {"deleted": True, "ds_id": ds_id}


def start_sync(kb_id: str, ds_id: str) -> dict[str, Any]:
    client = agent_client()
    try:
        job = client.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)
    except (
        client.exceptions.ValidationException,
        client.exceptions.ConflictException,
    ) as exc:
        raise AppError(
            "kb.sync_not_ready",
            "cannot start ingestion — the data source may still be provisioning, "
            "or another sync is already running",
            status_code=409,
        ) from exc
    return _job_out(job["ingestionJob"])


def list_ingestion_jobs(kb_id: str, ds_id: str) -> list[dict[str, Any]]:
    return _recent_ingestion_jobs(agent_client(), kb_id, ds_id, cap=50)


def update_description(kb_id: str, description: str) -> dict[str, Any]:
    client = agent_client()
    detail = _require_managed(_get_kb(client, kb_id))
    client.update_knowledge_base(
        knowledgeBaseId=kb_id,
        name=detail["name"],
        description=description or detail["name"],
        roleArn=detail["roleArn"],
        knowledgeBaseConfiguration=detail["knowledgeBaseConfiguration"],
    )
    return get_kb_detail(kb_id)


def _location_uri(location: dict[str, Any]) -> str | None:
    for sub in location.values():
        if isinstance(sub, dict):
            uri = sub.get("uri") or sub.get("url")
            if uri:
                return uri
    return None


def _result_out(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "text": (result.get("content") or {}).get("text", ""),
        "score": result.get("score"),
        "location_uri": _location_uri(result.get("location") or {}),
        "metadata": result.get("metadata") or {},
    }


def query(kb_id: str, text: str, number_of_results: int = 8) -> list[dict[str, Any]]:
    kb_type = _kb_type(_get_kb(agent_client(), kb_id))
    if kb_type == "SQL":
        raise AppError(
            "kb.query_unsupported",
            "SQL knowledge bases answer via query generation, not Retrieve — "
            "the playground cannot search them",
            status_code=400,
        )
    config_key = (
        "managedSearchConfiguration" if kb_type == "MANAGED" else "vectorSearchConfiguration"
    )
    runtime = agent_runtime_client()
    try:
        resp = runtime.retrieve(
            knowledgeBaseId=kb_id,
            retrievalQuery={"text": text},
            retrievalConfiguration={config_key: {"numberOfResults": number_of_results}},
        )
    except (
        runtime.exceptions.ValidationException,
        runtime.exceptions.AccessDeniedException,
    ) as exc:
        # external KBs can be broken for ANY caller (e.g. a classic KB whose
        # OpenSearch Serverless data-access policy no longer admits its own
        # service role → "[security_exception] 403") — surface it readably
        raise AppError(
            "kb.query_failed",
            f"retrieval failed on the knowledge base side: {exc}",
            status_code=502,
        ) from exc
    return [_result_out(r) for r in resp.get("retrievalResults", [])]


def delete_kb(kb_id: str, force: bool = False) -> dict[str, Any]:
    client = agent_client()
    _require_managed(_get_kb(client, kb_id))
    agents = attached_agents(kb_id)
    if agents and not force:
        raise KBAttachedError(kb_id, agents)
    if agents:  # force path — unmount from every agent before tearing down
        _strip_kb_from_agents(kb_id)

    for ds in _list_data_sources(client, kb_id):
        try:  # async deletion — best-effort; DeleteKnowledgeBase cascades the rest
            client.delete_data_source(knowledgeBaseId=kb_id, dataSourceId=ds["dataSourceId"])
        except Exception:
            pass

    # only touch the gateway target if the gateway already exists — never
    # provision the KB gateway during a delete
    gateway_id = get_settings().resources.get("kb_gateway_id")
    if gateway_id:
        kb_gateway.delete_retrieve_target(control_client(), gateway_id, kb_id)

    _delete_kb_policy(kb_id)

    try:
        client.delete_knowledge_base(knowledgeBaseId=kb_id)
    except client.exceptions.ConflictException as exc:
        raise AppError(
            "kb.delete_conflict",
            "the KB is still being created — wait for it to become ACTIVE before deleting",
            status_code=409,
        ) from exc
    return {"deleted": True, "kb_id": kb_id}
