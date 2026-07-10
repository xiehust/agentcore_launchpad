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


def test_attachables_endpoint_caches_and_returns(client, monkeypatch):
    calls = []

    def fake_attachables():
        calls.append(1)
        return {"mcp_servers": [{"name": "deepwiki", "url": "https://mcp.deepwiki.com/mcp",
                                 "gateway": False, "description": "", "record_id": "r1"}],
                "skills": [{"name": "meeting-summarizer", "path": "s3://b/skills/meeting-summarizer/",
                            "description": "", "record_id": "r2"}]}

    monkeypatch.setattr(registry_router.console, "attachable_records", fake_attachables)
    registry_router._attachables_cache.update(data=None, at=0.0)
    first = client.get("/api/registry/attachables").json()
    second = client.get("/api/registry/attachables").json()
    assert first == second
    assert first["mcp_servers"][0]["gateway"] is False
    assert first["skills"][0]["path"].startswith("s3://")
    assert calls == [1]  # second hit served from the 60s cache
    registry_router._attachables_cache.update(data=None, at=0.0)


def test_attachables_parsing_splits_gateway_and_remote(monkeypatch):
    """APPROVED-only sourcing + gateway/remote split on the server URL."""
    import app.services.registry_console as console_mod

    gw_url = "https://gw.example/mcp"
    records = {
        "g1": {"recordId": "g1", "name": "hr-database", "description": "gw target",
               "descriptors": {"mcp": {"server": {"inlineContent":
                   json.dumps({"remotes": [{"url": gw_url}]})}}}},
        "x1": {"recordId": "x1", "name": "deepwiki", "description": "public docs",
               "descriptors": {"mcp": {"server": {"inlineContent":
                   json.dumps({"remotes": [{"url": "https://mcp.deepwiki.com/mcp"}]})}}}},
        "s1": {"recordId": "s1", "name": "meeting-summarizer", "description": "",
               "descriptors": {"agentSkills": {"skillDefinition": {"inlineContent":
                   json.dumps({"path": "s3://b/skills/meeting-summarizer/",
                               "description": "summarize"})}}}},
        "bad": {"recordId": "bad", "name": "broken", "descriptors": {}},
    }
    summaries = [
        {"recordId": rid, "descriptorType": "AGENT_SKILLS" if rid == "s1" else "MCP"}
        for rid in records
    ]
    monkeypatch.setattr(console_mod, "control_client", lambda: object())
    monkeypatch.setattr(console_mod, "_registry_id", lambda: "reg")
    monkeypatch.setattr(
        console_mod, "get_settings",
        lambda: type("S", (), {"resources": {"gateway_url": gw_url}})(),
    )
    monkeypatch.setattr(console_mod.reg, "list_records",
                        lambda c, r, t, s: summaries if s == "APPROVED" else [])
    monkeypatch.setattr(console_mod.reg, "get_record",
                        lambda c, r, rid: records[rid])

    out = console_mod.attachable_records()
    by_name = {m["name"]: m for m in out["mcp_servers"]}
    assert by_name["hr-database"]["gateway"] is True
    assert by_name["deepwiki"]["gateway"] is False
    assert out["skills"][0]["name"] == "meeting-summarizer"
    assert "broken" not in by_name  # malformed descriptor skipped


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
