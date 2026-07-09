"""Governance API — policy card, test-evaluate, decision log, traces, generation."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import AppError
from app.models.ledger import PolicyDecision
from app.services import mcp_client
from app.services import traces as trace_service
from app.services.agentcore.client import control_client

router = APIRouter(prefix="/api", tags=["governance"])

ROLE_BY_USER = {"river": "platform-admin", "demo": "hr-analyst"}


@router.get("/governance/policies")
def get_policies() -> dict[str, Any]:
    settings = get_settings()
    engine_id = settings.resources.get("policy_engine_id")
    if not engine_id:
        raise AppError("policy.not_bootstrapped", "policy engine missing — run bootstrap",
                       status_code=503)
    control = control_client()
    engine = control.get_policy_engine(policyEngineId=engine_id)
    gateway = control.get_gateway(
        gatewayIdentifier=settings.resources.get("gateway_id")
    )
    policies = []
    for summary in control.list_policies(policyEngineId=engine_id, maxResults=20).get(
        "policies", []
    ):
        detail = control.get_policy(
            policyEngineId=engine_id, policyId=summary["policyId"]
        )
        policies.append(
            {
                "id": detail["policyId"],
                "name": detail["name"],
                "status": detail["status"],
                "statement": detail.get("definition", {}).get("cedar", {}).get("statement", ""),
            }
        )
    attach = gateway.get("policyEngineConfiguration") or {}
    return {
        "engine": {
            "id": engine["policyEngineId"],
            "name": engine["name"],
            "status": engine["status"],
            "attached_mode": attach.get("mode"),
            "attached": attach.get("arn") == engine["policyEngineArn"],
        },
        "policies": policies,
    }


class PolicyTestRequest(BaseModel):
    tool: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)
    username: str = Field(default="demo", pattern="^(river|demo)$")


@router.post("/governance/policy-test")
def policy_test(req: PolicyTestRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Evaluate a real tools/call as the chosen principal and record the decision."""
    principal = f"{req.username}@{ROLE_BY_USER.get(req.username, 'user')}"
    outcome, reason = "ALLOW", None
    try:
        result = mcp_client.tools_call(req.tool, req.arguments, username=req.username)
        excerpt = str(result)[:300]
    except AppError as exc:
        outcome = "DENY"
        reason = str(exc.detail or exc.message)[:300]
        excerpt = reason
    decision = PolicyDecision(
        principal=principal, tool=req.tool, outcome=outcome, reason=reason
    )
    db.add(decision)
    db.commit()
    return {
        "principal": principal,
        "tool": req.tool,
        "outcome": outcome,
        "detail": excerpt,
        "decision_id": decision.id,
    }


@router.get("/governance/decisions")
def decision_log(db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = (
        db.query(PolicyDecision).order_by(PolicyDecision.created_at.desc()).limit(30).all()
    )
    return {
        "decisions": [
            {
                "at": r.created_at.isoformat() if r.created_at else None,
                "principal": r.principal,
                "tool": r.tool,
                "outcome": r.outcome,
                "reason": (r.reason or "")[:160],
            }
            for r in rows
        ]
    }


@router.get("/traces/{session_id}")
def get_trace(session_id: str, lookback_hours: int = 3) -> dict[str, Any]:
    return trace_service.session_trace(session_id, lookback_hours=lookback_hours)


class GenerationRequest(BaseModel):
    text: str = Field(min_length=10, max_length=2000)
    name: str = Field(default="launchpad_generated", pattern=r"^[A-Za-z][A-Za-z0-9_]*$")


@router.post("/governance/policy-generation")
def start_generation(req: GenerationRequest) -> dict[str, Any]:
    """AI policy generation from natural language (preview API — surfaced honestly)."""
    settings = get_settings()
    engine_id = settings.resources.get("policy_engine_id")
    gateway_arn = settings.resources.get("gateway_arn")
    if not engine_id or not gateway_arn:
        raise AppError("policy.not_bootstrapped", "run bootstrap first", status_code=503)
    control = control_client()
    try:
        generation = control.start_policy_generation(
            policyEngineId=engine_id,
            name=req.name,
            content={"rawText": req.text},
            resource={"arn": gateway_arn},
        )
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
    return {
        "available": True,
        "generation_id": generation.get("policyGenerationId"),
        "status": generation.get("status"),
    }


@router.get("/governance/policy-generation/{generation_id}")
def get_generation(generation_id: str) -> dict[str, Any]:
    settings = get_settings()
    engine_id = settings.resources.get("policy_engine_id")
    control = control_client()
    generation = control.get_policy_generation(
        policyEngineId=engine_id, policyGenerationId=generation_id
    )
    assets: list[dict[str, Any]] = []
    if generation.get("status") == "GENERATED":
        assets = control.list_policy_generation_assets(
            policyEngineId=engine_id, policyGenerationId=generation_id, maxResults=10
        ).get("policyGenerationAssets", [])
    return {
        "status": generation.get("status"),
        "assets": [
            {
                "id": a.get("policyGenerationAssetId") or a.get("assetId"),
                "statement": (
                    a.get("definition", {}).get("cedar", {}).get("statement", "")
                    or str(a.get("finding", ""))
                )[:800],
            }
            for a in assets
        ],
    }
