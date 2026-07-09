"""Shared register stage — every deploy method lands its A2A record here."""

from app.deployer.pipeline import StageContext, StageResult
from app.models.ledger import Agent
from app.services.registry_console import register_agent_record


def register_stage(ctx: StageContext, agent: Agent) -> StageResult:
    db = ctx.session()
    try:
        row = db.get(Agent, agent.id)
        result = register_agent_record(row)
        row.registry_record_id = result["record_id"]
        db.commit()
        verb = "created" if result["created"] else "refreshed"
        ctx.log(f"a2a record {verb} · {result['record_id']} · auto-submitted")
        return StageResult(detail=f"registry (A2A) {verb} · {result['record_id']}")
    finally:
        db.close()
