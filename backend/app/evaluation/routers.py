"""Evaluation API — datasets, evaluators, runs, insights, queue state.

Adapted from agentcore_eva_opt routers (datasets/evaluators/runs/insights).
"""

import json
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.evaluation import agentcore_eval as ac
from app.evaluation import service
from app.evaluation.models import EvalDataset, EvalRun
from app.evaluation.queue import account_lock
from app.models.ledger import Agent
from app.services.agentcore.client import control_client

router = APIRouter(prefix="/api/eval", tags=["evaluation"])


# ─── datasets ────────────────────────────────────────────────────────────────
class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    locale: str = "en"
    items: list[dict[str, Any]] = Field(min_length=1)


def _dataset_out(dataset: EvalDataset) -> dict[str, Any]:
    return {
        "id": dataset.id,
        "name": dataset.name,
        "locale": dataset.locale,
        "item_count": len(dataset.items),
        "items": dataset.items,
        "created_at": dataset.created_at.isoformat() if dataset.created_at else None,
    }


@router.get("/datasets")
def list_datasets(db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.query(EvalDataset).order_by(EvalDataset.created_at.desc()).all()
    return {"datasets": [_dataset_out(d) for d in rows]}


@router.post("/datasets", status_code=201)
def create_dataset(req: DatasetCreate, db: Session = Depends(get_db)) -> dict[str, Any]:
    for item in req.items:
        if not str(item.get("prompt", "")).strip():
            raise AppError("dataset.invalid_item", "every item needs a prompt", status_code=422)
    dataset = EvalDataset(name=req.name, locale=req.locale, items=req.items)
    db.add(dataset)
    db.commit()
    return _dataset_out(dataset)


class DatasetUpload(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    locale: str = "en"
    jsonl: str = Field(min_length=1)


@router.post("/datasets/upload", status_code=201)
def upload_dataset(req: DatasetUpload, db: Session = Depends(get_db)) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for line_no, line in enumerate(req.jsonl.splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except ValueError as exc:
            raise AppError(
                "dataset.invalid_jsonl", f"line {line_no}: {exc}", status_code=422
            ) from exc
        if not str(item.get("prompt", "")).strip():
            raise AppError(
                "dataset.invalid_item", f"line {line_no}: missing prompt", status_code=422
            )
        items.append(item)
    if not items:
        raise AppError("dataset.empty", "no items in upload", status_code=422)
    dataset = EvalDataset(name=req.name, locale=req.locale, items=items)
    db.add(dataset)
    db.commit()
    return _dataset_out(dataset)


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    dataset = db.get(EvalDataset, dataset_id)
    if dataset is None:
        raise NotFoundError("dataset.not_found", "dataset not found")
    db.delete(dataset)
    db.commit()
    return {"deleted": True}


# ─── evaluators ──────────────────────────────────────────────────────────────
@router.get("/evaluators")
def list_evaluators() -> dict[str, Any]:
    builtin = [
        {"id": name, "level": level, "source": "builtin"}
        for name, level in ac.ALL_BUILTIN_EVALUATORS.items()
    ]
    custom: list[dict[str, Any]] = []
    try:
        for ev in ac.list_evaluators(control_client()):
            evaluator_id = ev.get("evaluatorId", "")
            if not evaluator_id.startswith("Builtin."):
                custom.append(
                    {
                        "id": evaluator_id,
                        "name": ev.get("evaluatorName"),
                        "level": ev.get("level"),
                        "source": "custom",
                    }
                )
    except Exception:
        pass  # account listing unavailable — builtins still render
    return {"evaluators": builtin + custom, "builtin_count": len(builtin)}


class JudgeCreate(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,47}$")
    instructions: str = Field(min_length=10, max_length=4000)
    model_id: str = "global.anthropic.claude-sonnet-4-6"


@router.post("/evaluators", status_code=201)
def create_judge(req: JudgeCreate) -> dict[str, Any]:
    created = ac.create_llm_judge_evaluator(
        control_client(),
        name=req.name,
        instructions=req.instructions,
        rating_scale=[
            {"value": 1.0, "label": "pass", "definition": "meets the instruction"},
            {"value": 0.0, "label": "fail", "definition": "does not meet the instruction"},
        ],
        model_id=req.model_id,
    )
    return {"evaluator_id": created.get("evaluatorId"), "arn": created.get("evaluatorArn")}


@router.delete("/evaluators/{evaluator_id}")
def delete_evaluator(evaluator_id: str) -> dict[str, Any]:
    ac.delete_evaluator(control_client(), evaluator_id=evaluator_id)
    return {"deleted": True}


# ─── runs ────────────────────────────────────────────────────────────────────
class RunCreate(BaseModel):
    agent_id: str
    dataset_id: str | None = None
    evaluators: list[str] = Field(default_factory=lambda: list(ac.BUILTIN_EVALUATORS))
    mode: str = Field(default="evaluators", pattern="^(evaluators|insights)$")
    wait_seconds: int = Field(default=90, ge=0, le=600)
    session_ids: list[str] | None = None  # insights/passive over past sessions


def _run_out(run: EvalRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "agent_id": run.agent_id,
        "agent_name": run.agent_name,
        "dataset_id": run.dataset_id,
        "dataset_name": run.dataset_name,
        "mode": run.mode,
        "evaluators": run.evaluators,
        "status": run.status,
        "queue_position": account_lock.position(run.id),
        "session_ids": run.session_ids,
        "batch_eval_id": run.batch_eval_id,
        "scores": run.scores,
        "insights": run.insights,
        "error": run.error,
        "created_at": run.created_at.isoformat() if run.created_at else None,
    }


@router.get("/runs")
def list_runs(db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.query(EvalRun).order_by(EvalRun.created_at.desc()).limit(50).all()
    return {"runs": [_run_out(r) for r in rows]}


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = db.get(EvalRun, run_id)
    if run is None:
        raise NotFoundError("run.not_found", "run not found")
    return _run_out(run)


@router.post("/runs", status_code=201)
def create_run(req: RunCreate, db: Session = Depends(get_db)) -> dict[str, Any]:
    agent = db.get(Agent, req.agent_id)
    if agent is None or agent.status != "active":
        raise AppError("agent.not_active", "agent must be active", status_code=400)

    items: list[dict[str, Any]] = []
    dataset_name = None
    if req.session_ids:
        pass  # passive/insights over existing sessions — no dataset traffic
    else:
        if not req.dataset_id:
            raise AppError("run.scope_required", "dataset_id or session_ids required",
                           status_code=422)
        dataset = db.get(EvalDataset, req.dataset_id)
        if dataset is None:
            raise NotFoundError("dataset.not_found", "dataset not found")
        items = dataset.items
        dataset_name = dataset.name

    run = service.submit_run(
        agent=agent,
        dataset_items=items,
        dataset_id=req.dataset_id,
        dataset_name=dataset_name,
        evaluators=req.evaluators,
        mode=req.mode,
        wait_seconds=req.wait_seconds,
        session_ids=req.session_ids,
    )
    return _run_out(run)


@router.get("/queue")
def queue_state() -> dict[str, Any]:
    return account_lock.state()
