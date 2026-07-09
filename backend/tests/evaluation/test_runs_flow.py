"""Runs flow — adapted from agentcore_eva_opt tests/test_runs_flow.py.

Stubbed clients drive the full pipeline: invoking → waiting → evaluating →
completed with parsed scores.
"""

from unittest.mock import MagicMock

import app.evaluation.service as svc
from app.core.db import SessionLocal
from app.evaluation.models import EvalDataset
from app.models.ledger import Agent


def make_agent(db, name="eval-agent", method="zip_runtime") -> Agent:
    agent = Agent(
        name=name, method=method, status="active",
        arn="arn:aws:bedrock-agentcore:us-west-2:1:runtime/rt-1",
        resource_id="rt-1", spec={"name": name},
    )
    db.add(agent)
    db.commit()
    return agent


def stub_environment(monkeypatch, batch_status="COMPLETED"):
    data = MagicMock()
    call_count = {"n": 0}

    def invoke_runtime_text(client, arn, prompt, session_id=None, actor_id="default"):
        call_count["n"] += 1
        return {"text": "42", "session_id": f"sess-{call_count['n']:03d}" + "x" * 30}

    monkeypatch.setattr(svc.rt, "invoke_runtime_text", invoke_runtime_text)
    monkeypatch.setattr(
        svc.rt, "get_runtime",
        lambda client, rid: {"agentRuntimeName": "eval_agent_abc123"},
    )
    monkeypatch.setattr(svc, "control_client", lambda: MagicMock())
    monkeypatch.setattr(svc, "data_client", lambda: data)
    monkeypatch.setattr(svc, "_sleep", lambda s: None)
    data.start_batch_evaluation.return_value = {"batchEvaluationId": "be-123"}
    data.get_batch_evaluation.return_value = {
        "status": batch_status,
        "evaluationResults": {
            "evaluatorSummaries": [
                {"evaluatorId": "Builtin.Correctness",
                 "statistics": {"averageScore": 0.91}},
                {"evaluatorId": "Builtin.Helpfulness",
                 "statistics": {"averageScore": 0.83}},
            ]
        },
        "failureAnalysisResult": {"failures": [
            {"category": "Tool misuse", "percentage": 42,
             "subCategories": []},
        ]},
    }
    return data, call_count


def test_active_run_completes_with_scores(client, monkeypatch):
    db = SessionLocal()
    agent = make_agent(db)
    dataset = EvalDataset(name="mini", items=[{"prompt": "2+2?"}, {"prompt": "3+3?"},
                                              {"prompt": "4+4?"}])
    db.add(dataset)
    db.commit()
    data, calls = stub_environment(monkeypatch)

    res = client.post("/api/eval/runs", json={
        "agent_id": agent.id, "dataset_id": dataset.id,
        "evaluators": ["Builtin.Correctness", "Builtin.Helpfulness"],
        "wait_seconds": 0,
    })
    assert res.status_code == 201
    run_id = res.json()["id"]

    import time
    for _ in range(50):
        run = client.get(f"/api/eval/runs/{run_id}").json()
        if run["status"] in ("completed", "failed"):
            break
        time.sleep(0.1)
    assert run["status"] == "completed", run.get("error")
    assert calls["n"] == 3  # one session per dataset item
    assert len(run["session_ids"]) == 3
    assert run["batch_eval_id"] == "be-123"
    assert {s["evaluatorId"]: s["score"] for s in run["scores"]} == {
        "Builtin.Correctness": 0.91, "Builtin.Helpfulness": 0.83,
    }
    # batch eval scoped to exactly this run's sessions
    kwargs = data.start_batch_evaluation.call_args.kwargs
    assert kwargs["dataSourceConfig"]["cloudWatchLogs"]["filterConfig"]["sessionIds"] == run[
        "session_ids"
    ]
    assert kwargs["dataSourceConfig"]["cloudWatchLogs"]["serviceNames"] == [
        "eval_agent_abc123.DEFAULT"
    ]
    db.close()


def test_run_failure_recorded(client, monkeypatch):
    db = SessionLocal()
    agent = make_agent(db, name="eval-agent-fail")
    dataset = EvalDataset(name="mini2", items=[{"prompt": "x"}])
    db.add(dataset)
    db.commit()
    stub_environment(monkeypatch, batch_status="FAILED")

    res = client.post("/api/eval/runs", json={
        "agent_id": agent.id, "dataset_id": dataset.id, "wait_seconds": 0,
    })
    run_id = res.json()["id"]
    import time
    for _ in range(50):
        run = client.get(f"/api/eval/runs/{run_id}").json()
        if run["status"] in ("completed", "failed"):
            break
        time.sleep(0.1)
    assert run["status"] == "failed"
    assert "FAILED" in run["error"]
    db.close()


def test_harness_agents_excluded(client, monkeypatch):
    db = SessionLocal()
    agent = make_agent(db, name="harness-agent", method="harness")
    dataset = EvalDataset(name="mini3", items=[{"prompt": "x"}])
    db.add(dataset)
    db.commit()
    res = client.post("/api/eval/runs", json={
        "agent_id": agent.id, "dataset_id": dataset.id,
    })
    assert res.status_code == 400
    assert res.json()["code"] == "eval.method_unsupported"
    db.close()
