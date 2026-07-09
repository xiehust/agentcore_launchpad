"""Evaluation run orchestration (adapted from agentcore_eva_opt routers/runs.py
and routers/insights.py — github.com/xiehust/agentcore_eva_opt).

Pipeline per run (behind the account lock):
    invoking   — one runtime session per dataset item
    waiting    — traces land in CloudWatch (aws/spans)
    evaluating — StartBatchEvaluation scoped to exactly those sessions
    completed  — per-evaluator average scores (or insight trees)

Batch evaluation reads CloudWatch traces, so it targets runtime-backed agents
(zip_runtime / studio / container). Managed-harness agents don't expose a
service name for span scoping — they're excluded from batch eval and the UI
says so (documented limitation).
"""

import time
from typing import Any

from app.core.db import SessionLocal
from app.core.errors import AppError
from app.evaluation import agentcore_eval as ac
from app.evaluation.models import EvalRun
from app.evaluation.queue import account_lock
from app.models.ledger import Agent
from app.services.agentcore import runtime as rt
from app.services.agentcore.client import control_client, data_client

_sleep = time.sleep  # injectable for tests

EVAL_SUPPORTED_METHODS = {"zip_runtime", "studio", "container"}


def resolve_telemetry(agent: Agent) -> tuple[str, str]:
    """(service_name, log_group) for a runtime-backed platform agent."""
    if agent.method not in EVAL_SUPPORTED_METHODS:
        raise AppError(
            "eval.method_unsupported",
            "batch evaluation targets runtime-backed agents "
            "(harness agents are excluded — no span service name)",
            status_code=400,
        )
    if not agent.resource_id:
        raise AppError("eval.agent_not_deployed", "agent has no runtime", status_code=400)
    detail = rt.get_runtime(control_client(), agent.resource_id)
    runtime_name = detail["agentRuntimeName"]
    return f"{runtime_name}.DEFAULT", (
        f"/aws/bedrock-agentcore/runtimes/{agent.resource_id}-DEFAULT"
    )


def _update(run_id: str, **fields: Any) -> None:
    db = SessionLocal()
    try:
        run = db.get(EvalRun, run_id)
        for key, value in fields.items():
            setattr(run, key, value)
        db.commit()
    finally:
        db.close()


def execute_run(
    run_id: str,
    *,
    agent_arn: str,
    service_name: str,
    log_group: str,
    items: list[dict[str, Any]],
    evaluators: list[str],
    mode: str,
    wait_seconds: int,
    existing_session_ids: list[str] | None = None,
) -> None:
    """Drive one evaluation run to completion (runs inside the account lock)."""
    try:
        data = data_client()
        session_ids = list(existing_session_ids or [])
        if not session_ids:
            _update(run_id, status="invoking")
            for item in items:
                result = rt.invoke_runtime_text(data, agent_arn, item["prompt"])
                session_ids.append(result["session_id"])
                _update(run_id, session_ids=list(session_ids))
            _update(run_id, status="waiting")
            _sleep(wait_seconds)

        _update(run_id, status="evaluating", session_ids=session_ids)
        if mode == "insights":
            response = ac.start_insights_evaluation(
                data,
                name=f"run_{run_id[:8]}",
                service_name=service_name,
                log_groups=["aws/spans", log_group],
                session_ids=session_ids,
            )
        else:
            response = ac.start_batch_evaluation(
                data,
                name=f"run_{run_id[:8]}",
                service_name=service_name,
                log_groups=["aws/spans", log_group],
                session_ids=session_ids,
                evaluators=evaluators,
            )
        batch_id = response["batchEvaluationId"]
        _update(run_id, batch_eval_id=batch_id)
        result = ac.poll_batch_evaluation(data, batch_id=batch_id, max_polls=60)
        status = result.get("status")
        if status not in ("COMPLETED", "COMPLETED_WITH_ERRORS"):
            raise RuntimeError(f"batch evaluation ended {status}")
        if mode == "insights":
            _update(run_id, status="completed", insights=ac.parse_insights(result))
        else:
            _update(run_id, status="completed", scores=ac.parse_eval_scores(result))
    except Exception as exc:
        _update(run_id, status="failed", error=f"{type(exc).__name__}: {exc}"[:500])


def submit_run(
    *,
    agent: Agent,
    dataset_items: list[dict[str, Any]],
    dataset_id: str | None,
    dataset_name: str | None,
    evaluators: list[str],
    mode: str = "evaluators",
    wait_seconds: int = 90,
    session_ids: list[str] | None = None,
) -> EvalRun:
    service_name, log_group = resolve_telemetry(agent)
    db = SessionLocal()
    try:
        run = EvalRun(
            agent_id=agent.id,
            agent_name=agent.name,
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            mode=mode,
            evaluators=evaluators,
            status="queued",
            session_ids=session_ids or [],
        )
        db.add(run)
        db.commit()
        run_id = run.id
        agent_arn = agent.arn
    finally:
        db.close()

    position = account_lock.submit(
        run_id,
        lambda: execute_run(
            run_id,
            agent_arn=agent_arn,
            service_name=service_name,
            log_group=log_group,
            items=dataset_items,
            evaluators=evaluators,
            mode=mode,
            wait_seconds=wait_seconds,
            existing_session_ids=session_ids,
        ),
    )
    _update(run_id, queue_position=position)
    db = SessionLocal()
    try:
        return db.get(EvalRun, run_id)
    finally:
        db.close()
