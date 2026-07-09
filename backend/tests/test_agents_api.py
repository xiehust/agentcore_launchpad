"""API contract tests — no AWS calls (deploy launch is stubbed)."""

import pytest

import app.routers.agents as agents_router
from app.core.db import SessionLocal
from app.models.ledger import Agent

SPEC = {
    "name": "api-test-agent",
    "method": "harness",
    "system_prompt": "Answer concisely.",
}


@pytest.fixture(autouse=True)
def no_real_deploy(monkeypatch):
    launched: list[str] = []
    monkeypatch.setattr(agents_router, "start_deploy_async", lambda jid: launched.append(jid))
    yield launched


def test_create_agent_returns_job_and_stages(client, no_real_deploy):
    res = client.post("/api/agents", json=SPEC)
    assert res.status_code == 202
    body = res.json()
    assert body["agent"]["status"] == "deploying"
    assert body["job_id"] and body["deployment_id"]
    assert no_real_deploy == [body["job_id"]]

    detail = client.get(f"/api/agents/{body['agent']['id']}").json()
    stages = detail["deployments"][0]["stages"]
    assert [s["name"] for s in stages] == [
        "generate", "package", "provision", "deploy", "register",
    ]
    assert all(s["status"] == "pending" for s in stages)


def test_duplicate_name_conflict(client):
    assert client.post("/api/agents", json=SPEC).status_code == 202
    res = client.post("/api/agents", json=SPEC)
    assert res.status_code == 409
    assert res.json()["code"] == "agent.name_exists"


def test_unsupported_method_rejected(client):
    res = client.post("/api/agents", json={**SPEC, "method": "container"})
    assert res.status_code == 400
    assert res.json()["code"] == "agent.method_not_available"


def test_invalid_spec_envelope(client):
    res = client.post("/api/agents", json={**SPEC, "name": "Bad Name!"})
    assert res.status_code == 422
    assert res.json()["code"] == "validation.invalid_request"


def test_invoke_requires_active(client):
    agent_id = client.post("/api/agents", json=SPEC).json()["agent"]["id"]
    res = client.post(f"/api/agents/{agent_id}/invoke", json={"prompt": "hi"})
    assert res.status_code == 409
    assert res.json()["code"] == "agent.not_active"


def test_invoke_active_agent(client, monkeypatch):
    agent_id = client.post("/api/agents", json=SPEC).json()["agent"]["id"]
    db = SessionLocal()
    agent = db.get(Agent, agent_id)
    agent.status = "active"
    agent.arn = "arn:aws:bedrock-agentcore:us-west-2:111:harness/x"
    db.commit()
    db.close()

    monkeypatch.setattr(agents_router, "data_client", lambda: object())
    monkeypatch.setattr(
        agents_router.hc,
        "invoke_harness_text",
        lambda client, arn, prompt, session_id=None, actor_id="default": {
            "text": "4",
            "session_id": "s" * 40,
        },
    )
    res = client.post(f"/api/agents/{agent_id}/invoke", json={"prompt": "2+2?"})
    assert res.status_code == 200
    body = res.json()
    assert body["text"] == "4" and body["session_id"] == "s" * 40


def test_delete_marks_ledger(client, monkeypatch):
    deleted: list[str] = []
    monkeypatch.setattr(
        agents_router.harness_method,
        "delete_agent_resources",
        lambda agent: deleted.append(agent.name),
    )
    agent_id = client.post("/api/agents", json=SPEC).json()["agent"]["id"]
    res = client.delete(f"/api/agents/{agent_id}")
    assert res.status_code == 200 and res.json()["deleted"] is True
    assert deleted == ["api-test-agent"]
    assert client.get("/api/agents").json()["agents"] == []  # deleted rows hidden


def test_job_not_found_envelope(client):
    res = client.get("/api/jobs/nope")
    assert res.status_code == 404
    assert res.json()["code"] == "job.not_found"
