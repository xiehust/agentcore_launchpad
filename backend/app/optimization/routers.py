"""Experiments API — create, inspect, and drive one stage action at a time."""

from typing import Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.evaluation.models import EvalDataset
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
        "running_action": exp.running_action,
        "progress": exp.progress,
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
    action: str = Field(
        pattern="^(recommend|accept|bundles|gateway|abtest|traffic|verdict"
                "|promote|canary|ramp|cleanup)$"
    )
    accepted_prompt: str | None = None                        # accept
    accepted_tool_descriptions: dict[str, str] | None = None  # accept
    dataset_id: str | None = None                             # traffic
    challenger_agent_id: str | None = None                    # canary


@router.post("/{exp_id}/action")
def experiment_action(
    exp_id: str, req: ActionRequest, response: Response,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise NotFoundError("experiment.not_found", "experiment not found")
    if exp.running_action:
        raise AppError(
            "experiment.action_in_flight",
            f"{exp.running_action} is still running — wait for it to finish",
            status_code=409,
        )
    reason = service.stage_not_ready_reason(exp, req.action)
    if reason:
        raise AppError("experiment.stage_not_ready", reason, status_code=409)

    # sync actions answer inline; async ones 202 into a background thread and
    # the client watches running_action/progress on the experiment itself
    if req.action == "accept":
        rec = exp.artifacts.get("recommend") or {}
        prompt = (req.accepted_prompt or rec.get("recommended_prompt") or "").strip()
        if not prompt:
            raise AppError("experiment.accept_invalid",
                           "accepted prompt is empty", status_code=400)
        service.action_accept(exp, prompt, req.accepted_tool_descriptions)
    elif req.action == "bundles":
        service.action_bundles(exp)
    elif req.action == "promote":
        service.action_promote(exp)
    elif req.action == "ramp":
        service.action_ramp(exp)
    elif req.action == "traffic":
        prompts = None
        dataset_info = None
        if req.dataset_id:
            dataset = db.get(EvalDataset, req.dataset_id)
            if dataset is None:
                raise NotFoundError("dataset.not_found", "dataset not found")
            try:
                prompts = service.resolve_traffic_prompts(dataset)
            except ValueError as exc:
                raise AppError("experiment.dataset_unsupported", str(exc),
                               status_code=422) from exc
            dataset_info = {"dataset_id": dataset.id, "dataset_name": dataset.name}
        service.run_action(
            exp.id, "traffic",
            lambda progress: service.act_traffic(exp_id, prompts, dataset_info,
                                                 progress),
        )
    elif req.action == "canary":
        challenger = db.get(Agent, req.challenger_agent_id or "")
        if challenger is None or challenger.status != "active":
            raise AppError("experiment.challenger_required",
                           "canary needs an active challenger agent", status_code=400)
        if challenger.id == exp.agent_id:
            raise AppError("experiment.challenger_required",
                           "the champion cannot challenge itself", status_code=400)
        snapshot = {"name": challenger.name, "arn": challenger.arn,
                    "resource_id": challenger.resource_id}
        service.run_action(
            exp.id, "canary",
            lambda progress: service.act_canary(exp_id, snapshot, progress),
        )
    else:  # recommend | gateway | abtest | verdict | cleanup
        fn = {
            "recommend": service.act_recommend,
            "gateway": service.act_gateway,
            "abtest": service.act_abtest,
            "verdict": service.act_verdict,
            "cleanup": service.act_cleanup,
        }[req.action]
        service.run_action(exp.id, req.action,
                           lambda progress: fn(exp_id, progress))

    if req.action in service.ASYNC_ACTIONS:
        response.status_code = 202
    db.expire_all()  # the action thread/service wrote via its own session
    exp = db.get(Experiment, exp_id)
    return {"experiment": _out(exp)}
