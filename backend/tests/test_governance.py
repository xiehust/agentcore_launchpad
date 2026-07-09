"""Span normalizer, policy bootstrap builders, decision recorder."""

from unittest.mock import MagicMock

import app.routers.governance as gov
from app.core.db import SessionLocal
from app.models.ledger import PolicyDecision
from app.services import traces
from app.services.policy_bootstrap import (
    POLICIES,
    ensure_policy_engine,
    ensure_transaction_search,
    render_policy_statement,
)


def test_normalize_spans_categories_and_offsets():
    spans = [
        {"name": "chat global.anthropic.claude-sonnet-4-6",
         "startTimeUnixNano": 2_000_000, "endTimeUnixNano": 5_000_000},
        {"name": "mcp tools/call hr-database___get_employee",
         "startTimeUnixNano": 1_000_000, "endTimeUnixNano": 3_000_000},
        {"name": "Bedrock AgentCore.CreateEvent",
         "startTimeUnixNano": 6_000_000, "endTimeUnixNano": 7_000_000},
        {"name": "Bedrock AgentCore.AuthorizeAction",
         "startTimeUnixNano": 500_000, "endTimeUnixNano": 600_000},
    ]
    rows = traces.normalize_spans(spans)
    by_name = {r["name"]: r for r in rows}
    assert by_name["chat global.anthropic.claude-sonnet-4-6"]["category"] == "model"
    assert by_name["mcp tools/call hr-database___get_employee"]["category"] == "tool"
    assert by_name["Bedrock AgentCore.CreateEvent"]["category"] == "memory"
    assert by_name["Bedrock AgentCore.AuthorizeAction"]["category"] == "policy"
    # offsets relative to earliest span
    assert rows[0]["start_ms"] == 0.0
    assert by_name["chat global.anthropic.claude-sonnet-4-6"]["duration_ms"] == 3.0


def test_render_policy_statement_substitutes_arn():
    arn = "arn:aws:bedrock-agentcore:us-west-2:1:gateway/launchpad-gw-x"
    for spec in POLICIES:
        statement = render_policy_statement(spec["file"], arn)
        assert "__GATEWAY_ARN__" not in statement
        assert arn in statement
    payout = render_policy_statement("payout_admin_only.cedar", arn)
    assert 'AgentCore::Action::"hr-database___create_payout"' in payout
    assert "platform-admin" in payout


def test_ensure_policy_engine_idempotent():
    control = MagicMock()
    control.list_policy_engines.return_value = {
        "policyEngines": [{"name": "launchpad_pe", "policyEngineId": "pe-1",
                           "policyEngineArn": "arn:pe-1"}]
    }
    engine, created = ensure_policy_engine(control)
    assert created is False and engine["id"] == "pe-1"
    control.create_policy_engine.assert_not_called()


def test_ensure_transaction_search_noop_when_active():
    xray = MagicMock()
    xray.get_trace_segment_destination.return_value = {
        "Destination": "CloudWatchLogs", "Status": "ACTIVE",
    }
    state = ensure_transaction_search(xray)
    assert state == {"enabled": True, "changed": False, "status": "ACTIVE"}
    xray.update_trace_segment_destination.assert_not_called()


def test_policy_test_records_decision(client, monkeypatch):
    monkeypatch.setattr(
        gov.mcp_client, "tools_call",
        lambda tool, args, username="demo": {"content": [{"text": "ok"}]},
    )
    res = client.post(
        "/api/governance/policy-test",
        json={"username": "river", "tool": "hr-database___create_payout",
              "arguments": {"employee_id": "EMP-1024", "amount": 1}},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "ALLOW" and body["principal"] == "river@platform-admin"

    from app.core.errors import AppError

    def deny(tool, args, username="demo"):
        raise AppError("gateway.rpc_error", "Tool Execution Denied", {"policy": "R-02"})

    monkeypatch.setattr(gov.mcp_client, "tools_call", deny)
    res2 = client.post(
        "/api/governance/policy-test",
        json={"username": "demo", "tool": "hr-database___create_payout",
              "arguments": {}},
    )
    assert res2.json()["outcome"] == "DENY"

    log = client.get("/api/governance/decisions").json()["decisions"]
    assert len(log) == 2
    assert log[0]["outcome"] == "DENY" and log[0]["principal"] == "demo@hr-analyst"

    db = SessionLocal()
    assert db.query(PolicyDecision).count() == 2
    db.close()
