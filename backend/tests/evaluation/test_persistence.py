"""Run history persistence — adapted from agentcore_eva_opt tests/test_persistence.py.

A "restart" is simulated by reading through a brand-new session/app instance:
completed runs must still be there (SQLite is the source of truth).
"""

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.evaluation.models import EvalRun
from app.main import create_app


def test_runs_survive_restart():
    db = SessionLocal()
    run = EvalRun(
        agent_id="a1", agent_name="persist-agent", dataset_name="ds",
        evaluators=["Builtin.Correctness"], status="completed",
        scores=[{"evaluatorId": "Builtin.Correctness", "score": 0.9}],
    )
    db.add(run)
    db.commit()
    run_id = run.id
    db.close()

    # "restart": a fresh app instance over the same database
    fresh_client = TestClient(create_app())
    runs = fresh_client.get("/api/eval/runs").json()["runs"]
    match = next((r for r in runs if r["id"] == run_id), None)
    assert match is not None
    assert match["status"] == "completed"
    assert match["scores"][0]["score"] == 0.9


def test_queue_second_run_queues_not_fails(client, monkeypatch):
    """Account lock: while run A executes, run B reports QUEUED (position ≥ 1)."""
    import threading

    from app.evaluation.queue import AccountLockQueue

    lock_queue = AccountLockQueue()
    release = threading.Event()
    started = threading.Event()

    def slow_job():
        started.set()
        release.wait(timeout=5)

    lock_queue.submit("run-A", slow_job)
    assert started.wait(timeout=2)
    position_b = lock_queue.submit("run-B", lambda: None)
    state = lock_queue.state()
    assert state["running"] == "run-A"
    assert "run-B" in state["queued"] and position_b >= 1
    assert lock_queue.position("run-B") == 1  # visible queue position
    release.set()
    import time
    for _ in range(50):
        if lock_queue.state()["running"] is None and not lock_queue.state()["queued"]:
            break
        time.sleep(0.05)
    assert lock_queue.state()["locked"] is False
