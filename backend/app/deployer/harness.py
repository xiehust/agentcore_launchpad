"""Managed Harness deploy method (方式B) — no build, live in seconds.

Stage mapping:
    generate  → build the CreateHarness request from the AgentSpec
    package   → skipped (no artifact for a managed harness)
    provision → reuse the shared execution role provisioned by CDK
    deploy    → CreateHarness + poll READY (idempotent on resume)
    register  → placeholder until phase 7
"""

from typing import Any

from app.core.config import get_settings
from app.deployer.pipeline import StageContext, StageResult, register_method
from app.models.ledger import Agent
from app.schemas.agent import AgentSpec
from app.services.agentcore import harness as hc
from app.services.agentcore.client import control_client

BUILTIN_TOOL_TYPES = {
    "code-interpreter": "agentcore_code_interpreter",
    "browser": "agentcore_browser",
}
GATEWAY_SCOPE = "launchpad-gw/invoke"


def build_create_params(
    spec: AgentSpec,
    execution_role_arn: str,
    memory_arn: str | None,
    gateway: dict[str, str] | None = None,
) -> dict:
    """AgentSpec → CreateHarness kwargs. Harness names disallow hyphens.

    ``gateway`` carries {arn, oauth_provider_arn} — any spec tool of type
    "gateway" attaches the shared gateway with CLIENT_CREDENTIALS outbound auth
    (the harness fetches Cognito M2M tokens itself via AgentCore Identity).
    """
    params: dict[str, Any] = {
        "harnessName": spec.name.replace("-", "_"),
        "executionRoleArn": execution_role_arn,
        "model": {"bedrockModelConfig": {"modelId": spec.model_id}},
        "systemPrompt": [{"text": spec.system_prompt}],
        "maxIterations": spec.max_iterations,
        "timeoutSeconds": spec.timeout_seconds,
    }
    tools = []
    for tool in spec.tools:
        if tool.type == "builtin" and tool.name in BUILTIN_TOOL_TYPES:
            tools.append({"type": BUILTIN_TOOL_TYPES[tool.name], "name": tool.name})
    if gateway and any(t.type == "gateway" for t in spec.tools):
        tools.append(
            {
                "type": "agentcore_gateway",
                "name": "launchpad_gw",
                "config": {
                    "agentCoreGateway": {
                        "gatewayArn": gateway["arn"],
                        "outboundAuth": {
                            "oauth": {
                                "providerArn": gateway["oauth_provider_arn"],
                                "grantType": "CLIENT_CREDENTIALS",
                                "scopes": [GATEWAY_SCOPE],
                            }
                        },
                    }
                },
            }
        )
    if tools:
        params["tools"] = tools
    if spec.skills:
        params["skills"] = [{"path": path} for path in spec.skills]
    if spec.env:
        params["environmentVariables"] = dict(spec.env)
    if (spec.memory.short_term or spec.memory.long_term) and memory_arn:
        params["memory"] = {"agentCoreMemoryConfiguration": {"arn": memory_arn}}
    return params


def _gateway_config(resources: dict[str, Any]) -> dict[str, str] | None:
    if resources.get("gateway_arn") and resources.get("oauth_provider_arn"):
        return {
            "arn": resources["gateway_arn"],
            "oauth_provider_arn": resources["oauth_provider_arn"],
        }
    return None


def _stage_generate(ctx: StageContext, agent: Agent) -> StageResult:
    settings = get_settings()
    spec = AgentSpec(**agent.spec)
    role_arn = settings.resources.get("execution_role_arn", "")
    memory_arn = settings.resources.get("memory_arn")
    params = build_create_params(
        spec, role_arn, memory_arn, gateway=_gateway_config(settings.resources)
    )
    ctx.scratch["create_params"] = params
    ctx.log(f"harness request generated for {params['harnessName']} · model {spec.model_id}")
    return StageResult(detail=f"harnessName: {params['harnessName']}")


def _stage_package(ctx: StageContext, agent: Agent) -> StageResult:
    return StageResult(skipped=True, detail="skipped · harness — no build required")


def _stage_provision(ctx: StageContext, agent: Agent) -> StageResult:
    role_arn = get_settings().resources.get("execution_role_arn")
    if not role_arn:
        raise RuntimeError(
            "execution_role_arn missing from config/launchpad.yaml — run scripts/bootstrap.py"
        )
    ctx.scratch["execution_role_arn"] = role_arn
    ctx.log(f"reusing shared execution role {role_arn}")
    return StageResult(detail="iam role reused · launchpad-base")


def _stage_deploy(ctx: StageContext, agent: Agent) -> StageResult:
    client = control_client()
    db = ctx.session()
    try:
        row = db.get(Agent, agent.id)
        if row.resource_id:  # resumed job — harness already created, just poll
            harness_id = row.resource_id
            ctx.log(f"resuming — harness {harness_id} already created, polling status")
        else:
            params = ctx.scratch.get("create_params")
            if params is None:  # resume path without scratch — regenerate
                spec = AgentSpec(**row.spec)
                settings = get_settings()
                params = build_create_params(
                    spec,
                    settings.resources.get("execution_role_arn", ""),
                    settings.resources.get("memory_arn"),
                    gateway=_gateway_config(settings.resources),
                )
            harness = hc.create_harness(client, params)
            harness_id = harness["harnessId"]
            row.resource_id = harness_id
            row.arn = harness.get("arn")
            row.version = str(harness.get("harnessVersion", "1"))
            db.commit()
            ctx.log(f"CreateHarness accepted · harnessId {harness_id}")

        ready = hc.wait_harness_ready(client, harness_id)
        row.arn = ready["arn"]
        row.version = str(ready.get("harnessVersion", row.version or "1"))
        db.commit()
        ctx.log(f"harness READY · {ready['arn']}")
        return StageResult(detail=f"READY · {ready['arn']}")
    finally:
        db.close()


def _stage_register(ctx: StageContext, agent: Agent) -> StageResult:
    return StageResult(skipped=True, detail="registry auto-registration arrives in phase 7")


STAGES = {
    "generate": _stage_generate,
    "package": _stage_package,
    "provision": _stage_provision,
    "deploy": _stage_deploy,
    "register": _stage_register,
}

register_method("harness", STAGES)


def delete_agent_resources(agent: Agent) -> None:
    """Remove the AWS-side harness for a ledger row (idempotent)."""
    if not agent.resource_id:
        return
    client = control_client()
    try:
        hc.delete_harness(client, agent.resource_id)
    except client.exceptions.ResourceNotFoundException:
        pass
