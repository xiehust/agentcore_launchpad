"""Insights flow — adapted from agentcore_eva_opt tests/test_insights_flow.py.

Insights reuse StartBatchEvaluation with `insights` INSTEAD of `evaluators`
(mutually exclusive) over an earlier run's sessions.
"""

import time

from app.core.db import SessionLocal
from app.evaluation import agentcore_eval as ac
from tests.evaluation.test_runs_flow import make_agent, stub_environment


def test_insights_run_over_sessions(client, monkeypatch):
    db = SessionLocal()
    agent = make_agent(db, name="insights-agent")
    db.close()
    data, _ = stub_environment(monkeypatch)

    res = client.post("/api/eval/runs", json={
        "agent_id": agent.id,
        "mode": "insights",
        "session_ids": ["s1" + "x" * 32, "s2" + "x" * 32],
        "wait_seconds": 0,
    })
    assert res.status_code == 201
    run_id = res.json()["id"]
    for _ in range(50):
        run = client.get(f"/api/eval/runs/{run_id}").json()
        if run["status"] in ("completed", "failed"):
            break
        time.sleep(0.1)
    assert run["status"] == "completed", run.get("error")
    assert run["insights"]["failures"][0]["category"] == "Tool misuse"

    kwargs = data.start_batch_evaluation.call_args.kwargs
    assert "insights" in kwargs and "evaluators" not in kwargs  # mutually exclusive
    assert kwargs["insights"] == [{"insightId": i} for i in ac.INSIGHT_TYPES]


def test_parse_insights_shapes():
    result = {
        "failureAnalysisResult": {"failures": [{"category": "A"}]},
        "userIntentResult": {"userIntents": [{"intent": "B"}]},
        "executionSummaryResult": {"executionSummaries": [{"approachTaken": "C"}]},
    }
    parsed = ac.parse_insights(result)
    assert parsed["failures"] == [{"category": "A"}]
    assert parsed["userIntents"] == [{"intent": "B"}]
    assert parsed["executionSummaries"] == [{"approachTaken": "C"}]
