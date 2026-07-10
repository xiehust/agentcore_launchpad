"""Agents API — create/deploy, list, invoke, delete; jobs polling."""

import json
import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.deployer import container as container_method
from app.deployer import harness as harness_method
from app.deployer import zip_runtime as zip_method
from app.deployer.pipeline import create_deployment, start_deploy_async
from app.models.ledger import Agent, Deployment, Job
from app.schemas.agent import AgentSpec, InvokeRequest, InvokeResponse
from app.services.invoke import invoke_agent_text
from app.services.memory import scoped_actor

router = APIRouter(prefix="/api", tags=["agents"])

SUPPORTED_METHODS = {"harness", "zip_runtime", "container", "studio"}


def _agent_out(agent: Agent, deployment: Deployment | None = None) -> dict[str, Any]:
    out = {
        "id": agent.id,
        "name": agent.name,
        "method": agent.method,
        "status": agent.status,
        "arn": agent.arn,
        "resource_id": agent.resource_id,
        "registry_record_id": agent.registry_record_id,
        "version": agent.version,
        "owner": agent.owner,
        "error": agent.error,
        "spec": agent.spec,
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
        "updated_at": agent.updated_at.isoformat() if agent.updated_at else None,
    }
    if deployment is not None:
        out["deployment"] = _deployment_out(deployment)
    return out


def _deployment_out(dep: Deployment) -> dict[str, Any]:
    return {
        "id": dep.id,
        "agent_id": dep.agent_id,
        "job_id": dep.job_id,
        "status": dep.status,
        "stages": dep.stages,
        "started_at": dep.started_at.isoformat() if dep.started_at else None,
        "ended_at": dep.ended_at.isoformat() if dep.ended_at else None,
    }


def _latest_deployment(db: Session, agent_id: str) -> Deployment | None:
    return (
        db.query(Deployment)
        .filter(Deployment.agent_id == agent_id)
        .order_by(Deployment.started_at.desc())
        .first()
    )


def _delete_agent_resources(agent: Agent) -> None:
    """Tear down the method-specific AWS resource for an agent (idempotent)."""
    if agent.method == "harness":
        harness_method.delete_agent_resources(agent)
    elif agent.method in ("zip_runtime", "studio"):
        zip_method.delete_agent_resources(agent)
    elif agent.method == "container":
        container_method.delete_agent_resources(agent)


@router.post("/agents", status_code=202)
def create_agent(spec: AgentSpec, db: Session = Depends(get_db)) -> dict[str, Any]:
    if spec.method not in SUPPORTED_METHODS:
        raise AppError(
            "agent.method_not_available",
            f"method '{spec.method}' ships in a later phase",
            {"supported": sorted(SUPPORTED_METHODS)},
            status_code=400,
        )
    existing = db.query(Agent).filter(Agent.name == spec.name, Agent.status != "deleted").first()
    if existing:
        raise AppError(
            "agent.name_exists",
            f"an agent named '{spec.name}' already exists",
            {"agent_id": existing.id},
            status_code=409,
        )
    agent = Agent(name=spec.name, method=spec.method, status="deploying", spec=spec.model_dump())
    db.add(agent)
    db.flush()
    deployment, job = create_deployment(db, agent)
    start_deploy_async(job.id)
    return {"agent": _agent_out(agent), "job_id": job.id, "deployment_id": deployment.id}


@router.get("/agents")
def list_agents(db: Session = Depends(get_db)) -> dict[str, Any]:
    agents = (
        db.query(Agent)
        .filter(Agent.status != "deleted")
        .order_by(Agent.created_at.desc())
        .all()
    )
    out = []
    for a in agents:
        row = _agent_out(a, _latest_deployment(db, a.id))
        # each (re)publish is one Deployment row — the count is the revision no.
        row["revision"] = (
            db.query(Deployment).filter(Deployment.agent_id == a.id).count()
        )
        out.append(row)
    return {"agents": out}


@router.get("/agents/{agent_id}")
def get_agent(agent_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise NotFoundError("agent.not_found", "agent not found")
    deployments = (
        db.query(Deployment)
        .filter(Deployment.agent_id == agent_id)
        .order_by(Deployment.started_at.desc())
        .all()
    )
    out = _agent_out(agent)
    out["deployments"] = [_deployment_out(d) for d in deployments]
    return out


@router.post("/agents/{agent_id}/redeploy", status_code=202)
def redeploy_agent(
    agent_id: str, spec: AgentSpec, db: Session = Depends(get_db)
) -> dict[str, Any]:
    """Re-publish an agent in place with an edited spec.

    Runs the pipeline in "update" mode: the deploy stage calls UpdateHarness /
    UpdateAgentRuntime instead of Create, so AgentCore publishes a NEW VERSION
    on the SAME resource — the agentRuntimeId/harnessId and ARN are unchanged
    and the DEFAULT endpoint auto-rolls to the new version (near-zero downtime,
    versioned + rollback-able). package/provision still rebuild the artifact so
    edited code/requirements ship. If the agent has no live resource yet (e.g. a
    failed first deploy), the deploy stage falls back to Create.

    Name and method are immutable — changing either would be a different agent.
    """
    agent = db.get(Agent, agent_id)
    if agent is None or agent.status == "deleted":
        raise NotFoundError("agent.not_found", "agent not found")
    if agent.status == "deploying":
        raise AppError(
            "agent.deploy_in_progress",
            "a deployment is already in progress for this agent",
            status_code=409,
        )
    if spec.name != agent.name or spec.method != agent.method:
        raise AppError(
            "agent.redeploy_immutable",
            "name and method cannot change on re-publish — clone to a new agent instead",
            {"name": agent.name, "method": agent.method},
            status_code=400,
        )

    agent.spec = spec.model_dump()
    agent.status = "deploying"
    agent.error = None
    agent.updated_at = datetime.now(UTC)
    db.flush()
    deployment, job = create_deployment(db, agent, mode="update")
    start_deploy_async(job.id)
    return {"agent": _agent_out(agent), "job_id": job.id, "deployment_id": deployment.id}


@router.post("/agents/{agent_id}/invoke", response_model=InvokeResponse)
def invoke_agent(
    agent_id: str, req: InvokeRequest, db: Session = Depends(get_db)
) -> InvokeResponse:
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise NotFoundError("agent.not_found", "agent not found")
    if agent.status != "active" or not agent.arn:
        raise AppError(
            "agent.not_active",
            "agent is not active",
            {"status": agent.status},
            status_code=409,
        )
    started = time.monotonic()
    result = invoke_agent_text(
        agent, req.prompt, session_id=req.session_id,
        actor_id=scoped_actor(agent.id, req.actor_id),
    )
    return InvokeResponse(
        text=result["text"],
        session_id=result["session_id"],
        latency_ms=int((time.monotonic() - started) * 1000),
    )


@router.delete("/agents/{agent_id}")
def delete_agent(agent_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise NotFoundError("agent.not_found", "agent not found")
    _delete_agent_resources(agent)
    agent.status = "deleted"
    agent.updated_at = datetime.now(UTC)
    db.commit()
    return {"deleted": True, "agent_id": agent_id}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    job = db.get(Job, job_id)
    if job is None:
        raise NotFoundError("job.not_found", "job not found")
    events = [json.loads(line) for line in job.log.splitlines() if line.strip()]
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "payload": job.payload,
        "error": job.error,
        "events": events,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
    }
