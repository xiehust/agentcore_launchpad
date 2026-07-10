"""Registry registration + lifecycle management endpoints (console mocked —
the real transitions were probed live: DEPRECATED is terminal, REJECTED can
still be approved, delete works from any settled state)."""

import json

import app.routers.registry as registry_router
from app.services.agentcore import registry as reg

RECORD = {
    "recordId": "r-new1", "name": "external-search", "descriptorType": "MCP",
    "status": "DRAFT", "recordVersion": "1.0.0", "descriptors": {},
}


def test_register_mcp_record(client, monkeypatch):
    calls = {}

    def fake_register(name, description, url):
        calls.update(name=name, url=url)
        return RECORD

    monkeypatch.setattr(registry_router.console, "register_mcp_server", fake_register)
    res = client.post("/api/registry/records", json={
        "type": "MCP", "name": "external-search",
        "description": "team search service", "url": "https://mcp.internal/sse",
    })
    assert res.status_code == 201
    assert res.json()["record_id"] == "r-new1"
    assert calls == {"name": "external-search", "url": "https://mcp.internal/sse"}


def test_register_mcp_requires_url(client):
    res = client.post("/api/registry/records",
                      json={"type": "MCP", "name": "no-url-server"})
    assert res.status_code == 400
    assert res.json()["code"] == "registry.invalid_url"


def test_register_skill_requires_md(client):
    res = client.post("/api/registry/records",
                      json={"type": "AGENT_SKILLS", "name": "empty-skill"})
    assert res.status_code == 400
    assert res.json()["code"] == "registry.skill_md_required"


def test_register_rejects_bad_name(client):
    res = client.post("/api/registry/records",
                      json={"type": "MCP", "name": "Bad Name!", "url": "https://x"})
    assert res.status_code == 422  # pydantic pattern → validation envelope


def test_register_skill_routes_to_console(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(
        registry_router.console, "register_skill",
        lambda name, description, skill_md: seen.update(name=name, md=skill_md)
        or {**RECORD, "descriptorType": "AGENT_SKILLS", "name": name},
    )
    res = client.post("/api/registry/records", json={
        "type": "AGENT_SKILLS", "name": "report-writer",
        "skill_md": "---\nname: report-writer\n---\n# Report writer",
    })
    assert res.status_code == 201
    assert seen["name"] == "report-writer" and "# Report writer" in seen["md"]


def test_delete_record_endpoint(client, monkeypatch):
    deleted = []
    monkeypatch.setattr(registry_router.console, "console_delete", deleted.append)
    res = client.delete("/api/registry/records/r-gone")
    assert res.status_code == 200 and res.json()["deleted"] is True
    assert deleted == ["r-gone"]


def test_reject_action_routes(client, monkeypatch):
    actions = []
    monkeypatch.setattr(
        registry_router.console, "console_action",
        lambda rid, act: actions.append((rid, act)),
    )
    monkeypatch.setattr(registry_router.console, "console_get", lambda rid: RECORD)
    res = client.post("/api/registry/records/r-1/action", json={"action": "reject"})
    assert res.status_code == 200
    assert actions == [("r-1", "reject")]


def test_mcp_descriptors_without_tools():
    """External servers register without a tool listing — the tools descriptor
    must be omitted entirely, not sent as an empty list."""
    desc = reg.build_mcp_descriptors(
        target="external-search", description="d",
        gateway_url="https://mcp.internal/sse", tools=None,
    )
    assert "tools" not in desc["mcp"]
    server = json.loads(desc["mcp"]["server"]["inlineContent"])
    assert server["remotes"][0]["url"] == "https://mcp.internal/sse"
