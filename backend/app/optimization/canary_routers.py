"""Runtime Canary API — independent target-routing experiment lifecycle."""

from functools import partial
from typing import Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.evaluation.models import EvalDataset
from app.models.ledger import Agent
from app.optimization import canary_service, service
from app.optimization.models import RUNTIME_CANARY_STAGES, Experiment, RuntimeCanary

router = APIRouter(prefix="/api/runtime-canaries", tags=["runtime-canaries"])


def _out(row: RuntimeCanary) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "champion_agent_id": row.champion_agent_id,
        "champion_agent_name": row.champion_agent_name,
        "challenger_agent_id": row.challenger_agent_id,
        "challenger_agent_name": row.challenger_agent_name,
        "source_experiment_id": row.source_experiment_id,
        "status": row.status,
        "stage": row.stage,
        "stages": RUNTIME_CANARY_STAGES,
        "artifacts": row.artifacts,
        "running_action": row.running_action,
        "progress": row.progress,
        "error": row.error,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("")
def list_runtime_canaries(
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = (
        db.query(RuntimeCanary)
        .order_by(RuntimeCanary.created_at.desc())
        .limit(20)
        .all()
    )
    return {"canaries": [_out(row) for row in rows]}


@router.get("/{canary_id}")
def get_runtime_canary(
    canary_id: str,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = db.get(RuntimeCanary, canary_id)
    if row is None:
        raise NotFoundError("canary.not_found", "runtime canary not found")
    return _out(row)


class RuntimeCanaryCreate(BaseModel):
    champion_agent_id: str
    challenger_agent_id: str
    source_experiment_id: str | None = None


def _eligible_agent(db: Session, agent_id: str, role: str) -> Agent:
    agent = db.get(Agent, agent_id)
    if agent is None or agent.status != "active":
        raise AppError(
            "canary.agent_not_active",
            f"{role} agent must be active",
            {"role": role, "agent_id": agent_id},
            status_code=400,
        )
    capability = service.canary_capability(agent)
    if not capability["eligible"]:
        raise AppError(
            "canary.agent_unsupported",
            capability["reason"],
            {
                "role": role,
                "agent_id": agent_id,
                "canary_capability": capability,
            },
            status_code=400,
        )
    return agent


@router.post("", status_code=201)
def create_runtime_canary(
    req: RuntimeCanaryCreate,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if req.champion_agent_id == req.challenger_agent_id:
        raise AppError(
            "canary.same_agent",
            "champion and challenger must be different agents",
            status_code=400,
        )
    champion = _eligible_agent(db, req.champion_agent_id, "champion")
    challenger = _eligible_agent(db, req.challenger_agent_id, "challenger")
    if req.source_experiment_id:
        source = db.get(Experiment, req.source_experiment_id)
        if source is None or not service.promotion_complete(source.artifacts):
            raise AppError(
                "canary.source_experiment_invalid",
                "source experiment must have a completed production promotion",
                {"source_experiment_id": req.source_experiment_id},
                status_code=400,
            )
        if source.agent_id != champion.id:
            raise AppError(
                "canary.source_champion_mismatch",
                "source experiment agent must be the canary champion",
                {"source_experiment_id": source.id},
                status_code=400,
            )
    row = canary_service.start_canary(
        champion, challenger, req.source_experiment_id
    )
    return _out(row)


class RuntimeCanaryAction(BaseModel):
    action: str = Field(
        pattern="^(setup|traffic|verdict|advance|complete|rollback|cleanup)$"
    )
    dataset_id: str | None = None
    allow_non_significant: bool = False


@router.post("/{canary_id}/action")
def runtime_canary_action(
    canary_id: str,
    req: RuntimeCanaryAction,
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = db.get(RuntimeCanary, canary_id)
    if row is None:
        raise NotFoundError("canary.not_found", "runtime canary not found")
    if row.running_action:
        raise AppError(
            "canary.action_in_flight",
            f"{row.running_action} is still running — wait for it to finish",
            status_code=409,
        )
    reason = canary_service.stage_not_ready_reason(row, req.action)
    if reason:
        raise AppError("canary.stage_not_ready", reason, status_code=409)

    prompts = None
    dataset_info = None
    if req.action == "setup":
        canary_service.assert_setup_available(row.id)
    elif req.action == "traffic" and req.dataset_id:
        dataset = db.get(EvalDataset, req.dataset_id)
        if dataset is None:
            raise NotFoundError("dataset.not_found", "dataset not found")
        try:
            prompts = service.resolve_traffic_prompts(dataset)
        except ValueError as exc:
            raise AppError(
                "canary.dataset_unsupported", str(exc), status_code=422
            ) from exc
        dataset_info = {
            "dataset_id": dataset.id,
            "dataset_name": dataset.name,
        }
    elif req.action in {"advance", "complete"}:
        canary_service.assert_verdict_allows(
            row, allow_non_significant=req.allow_non_significant
        )

    action = req.action
    if action == "setup":
        fn = partial(canary_service.act_setup, canary_id)
    elif action == "traffic":
        fn = partial(
            canary_service.act_traffic, canary_id, prompts, dataset_info
        )
    elif action == "verdict":
        fn = partial(canary_service.act_verdict, canary_id)
    elif action == "advance":
        fn = partial(
            canary_service.act_advance,
            canary_id,
            allow_non_significant=req.allow_non_significant,
        )
    elif action == "complete":
        fn = partial(
            canary_service.act_complete,
            canary_id,
            allow_non_significant=req.allow_non_significant,
        )
    elif action == "rollback":
        fn = partial(canary_service.act_rollback, canary_id)
    else:
        fn = partial(canary_service.act_cleanup, canary_id)

    canary_service.run_action(canary_id, action, fn)
    response.status_code = 202
    db.expire_all()
    row = db.get(RuntimeCanary, canary_id)
    return {"canary": _out(row)}
