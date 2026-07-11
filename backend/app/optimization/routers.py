"""Experiments API — start the loop, inspect stages, promote/canary/ramp/cleanup."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.models.ledger import Agent
from app.optimization import service
from app.optimization.models import STAGES, Experiment

router = APIRouter(prefix="/api/experiments", tags=["experiments"])


def _out(exp: Experiment) -> dict[str, Any]:
    return {
        "id": exp.id,
        "name": exp.name,
        "agent_id": exp.agent_id,
        "agent_name": exp.agent_name,
        "status": exp.status,
        "stage": exp.stage,
        "stages": STAGES,
        "artifacts": exp.artifacts,
        "error": exp.error,
        "created_at": exp.created_at.isoformat() if exp.created_at else None,
    }


@router.get("")
def list_experiments(db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.query(Experiment).order_by(Experiment.created_at.desc()).limit(20).all()
    return {"experiments": [_out(e) for e in rows]}


@router.get("/{exp_id}")
def get_experiment(exp_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise NotFoundError("experiment.not_found", "experiment not found")
    return _out(exp)


class ExperimentCreate(BaseModel):
    agent_id: str


@router.post("", status_code=201)
def create_experiment(req: ExperimentCreate, db: Session = Depends(get_db)) -> dict[str, Any]:
    # experiments share one gateway (EXP_GATEWAY_NAME) and the AB service
    # allows a single active test per gateway — a concurrent loop would fail
    # at the abtest stage, so reject up front.
    running = db.query(Experiment).filter(Experiment.status == "running").first()
    if running is not None:
        raise AppError(
            "experiment.already_running",
            f"experiment {running.name} is still running — "
            "wait for its verdict or clean it up first",
            status_code=409,
        )
    agent = db.get(Agent, req.agent_id)
    if agent is None or agent.status != "active":
        raise AppError("agent.not_active", "agent must be active", status_code=400)
    if agent.method not in ("zip_runtime", "studio", "container"):
        raise AppError(
            "experiment.method_unsupported",
            "experiments target runtime-backed agents",
            status_code=400,
        )
    exp = service.start_experiment(agent)
    return _out(exp)


class ActionRequest(BaseModel):
    action: str = Field(pattern="^(promote|canary|ramp|cleanup)$")
    challenger_agent_id: str | None = None  # canary only


@router.post("/{exp_id}/action")
def experiment_action(
    exp_id: str, req: ActionRequest, db: Session = Depends(get_db)
) -> dict[str, Any]:
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise NotFoundError("experiment.not_found", "experiment not found")
    if req.action == "promote":
        return {"result": service.action_promote(exp)}
    if req.action == "canary":
        challenger = db.get(Agent, req.challenger_agent_id or "")
        if challenger is None or challenger.status != "active":
            raise AppError("experiment.challenger_required",
                           "canary needs an active challenger agent", status_code=400)
        return {"result": service.action_canary(exp, challenger)}
    if req.action == "ramp":
        return {"result": service.action_ramp(exp)}
    return {"result": service.action_cleanup(exp)}
