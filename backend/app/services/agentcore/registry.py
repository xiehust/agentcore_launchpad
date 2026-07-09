"""AgentCore Registry wrappers — records CRUD, approval workflow, search.

Status model (API enum has no PUBLISHED): the platform maps
    submit  → PENDING_APPROVAL   (UI chip: SUBMITTED)
    approve → APPROVED           (UI chip: PUBLISHED — live/consumable)
    disable → DEPRECATED         (UI chip: DISABLED)
Explicit-client style; payload builders are pure for unit testing.
"""

import json
import time
from typing import Any

A2A_SCHEMA_VERSION = "0.3.0"
MCP_SERVER_SCHEMA_VERSION = "2025-07-09"  # MCP registry server.json schema date
MCP_PROTOCOL_VERSION = "2025-06-18"
SKILL_SCHEMA_VERSION = "0.1.0"


# ---------- payload builders (pure) ----------

def build_a2a_card(
    *, name: str, description: str, arn: str, version: str, method: str
) -> dict[str, Any]:
    return {
        "protocolVersion": A2A_SCHEMA_VERSION,
        "name": name,
        "description": description,
        "url": arn,
        "preferredTransport": "JSONRPC",
        "version": version or "1",
        "capabilities": {"streaming": True},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [],
        "metadata": {"launchpad.method": method, "launchpad.invoke": "platform /v1 API"},
    }


def build_a2a_descriptors(card: dict[str, Any]) -> dict[str, Any]:
    return {
        "a2a": {
            "agentCard": {
                "schemaVersion": A2A_SCHEMA_VERSION,
                "inlineContent": json.dumps(card),
            }
        }
    }


def build_mcp_descriptors(
    *, target: str, description: str, gateway_url: str, tools: list[dict[str, Any]]
) -> dict[str, Any]:
    server_json = {
        "name": f"io.launchpad/{target}",
        "description": description or f"launchpad gateway target {target}",
        "version": "1.0.0",
        "remotes": [{"type": "streamable-http", "url": gateway_url}],
    }
    return {
        "mcp": {
            "server": {
                "schemaVersion": MCP_SERVER_SCHEMA_VERSION,
                "inlineContent": json.dumps(server_json),
            },
            "tools": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "inlineContent": json.dumps({"tools": tools}),
            },
        }
    }


def build_skills_descriptors(
    *, skill_md: str, definition: dict[str, Any]
) -> dict[str, Any]:
    return {
        "agentSkills": {
            "skillMd": {"inlineContent": skill_md},
            "skillDefinition": {
                "schemaVersion": SKILL_SCHEMA_VERSION,
                "inlineContent": json.dumps(definition),
            },
        }
    }


# ---------- record operations ----------

def find_record(
    client: Any, registry_id: str, name: str, descriptor_type: str | None = None
) -> dict[str, Any] | None:
    kwargs: dict[str, Any] = {"registryId": registry_id, "name": name, "maxResults": 20}
    if descriptor_type:
        kwargs["descriptorType"] = descriptor_type
    for record in client.list_registry_records(**kwargs).get("registryRecords", []):
        if record.get("name") == name:
            return record
    return None


def upsert_record(
    client: Any,
    registry_id: str,
    *,
    name: str,
    description: str,
    descriptor_type: str,
    descriptors: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Create the record or refresh its descriptors. Returns (record, created)."""
    existing = find_record(client, registry_id, name, descriptor_type)
    if existing is None:
        created = client.create_registry_record(
            registryId=registry_id,
            name=name,
            description=description,
            descriptorType=descriptor_type,
            descriptors=descriptors,
            recordVersion="1.0.0",
        )
        # CreateRegistryRecord returns only {recordArn, status}
        record_id = created["recordArn"].split("/")[-1]
        return {**created, "recordId": record_id}, True
    updated = client.update_registry_record(
        registryId=registry_id,
        recordId=existing["recordId"],
        description={"optionalValue": description},
        descriptors=wrap_descriptors_for_update(descriptors),
    )
    return updated, False


def wrap_descriptors_for_update(descriptors: dict[str, Any]) -> dict[str, Any]:
    """UpdateRegistryRecord wraps every optional level in {"optionalValue": …}.

    Create-style → update-style: mcp/agentSkills wrap their inner members too;
    a2a/custom only wrap the kind itself.
    """
    wrapped: dict[str, Any] = {}
    for kind, content in descriptors.items():
        if kind in ("mcp", "agentSkills"):
            wrapped[kind] = {
                "optionalValue": {k: {"optionalValue": v} for k, v in content.items()}
            }
        else:  # a2a, custom
            wrapped[kind] = {"optionalValue": content}
    return {"optionalValue": wrapped}


def get_record(client: Any, registry_id: str, record_id: str) -> dict[str, Any]:
    return client.get_registry_record(registryId=registry_id, recordId=record_id)


def wait_record_settled(
    client: Any,
    registry_id: str,
    record_id: str,
    timeout_s: int = 60,
    sleeper: Any = time.sleep,
) -> dict[str, Any]:
    """Records transition CREATING/UPDATING → DRAFT asynchronously; wait it out."""
    deadline = time.monotonic() + timeout_s
    while True:
        record = get_record(client, registry_id, record_id)
        if record["status"] not in ("CREATING", "UPDATING"):
            return record
        if time.monotonic() > deadline:
            raise TimeoutError(f"record {record_id} still {record['status']}")
        sleeper(2)


def list_records(
    client: Any,
    registry_id: str,
    descriptor_type: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    kwargs: dict[str, Any] = {"registryId": registry_id, "maxResults": 100}
    if descriptor_type:
        kwargs["descriptorType"] = descriptor_type
    if status:
        kwargs["status"] = status
    records: list[dict[str, Any]] = []
    while True:
        page = client.list_registry_records(**kwargs)
        records.extend(page.get("registryRecords", []))
        token = page.get("nextToken")
        if not token:
            break
        kwargs["nextToken"] = token
    return records


def submit_record(client: Any, registry_id: str, record_id: str) -> dict[str, Any]:
    return client.submit_registry_record_for_approval(
        registryId=registry_id, recordId=record_id
    )


def set_record_status(
    client: Any, registry_id: str, record_id: str, status: str, reason: str
) -> dict[str, Any]:
    return client.update_registry_record_status(
        registryId=registry_id, recordId=record_id, status=status, statusReason=reason
    )


def approve_record(client: Any, registry_id: str, record_id: str) -> dict[str, Any]:
    return set_record_status(
        client, registry_id, record_id, "APPROVED", "approved via launchpad console"
    )


def disable_record(client: Any, registry_id: str, record_id: str) -> dict[str, Any]:
    return set_record_status(
        client, registry_id, record_id, "DEPRECATED", "disabled via launchpad console"
    )


def search_records(
    data_client: Any, registry_ids: list[str], query: str, max_results: int = 20
) -> list[dict[str, Any]]:
    return data_client.search_registry_records(
        registryIds=registry_ids, searchQuery=query, maxResults=max_results
    ).get("registryRecords", [])
