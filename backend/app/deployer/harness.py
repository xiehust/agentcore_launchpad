"""Managed Harness deploy method (方式B) — no build, live in seconds.

Stage mapping:
    generate  → build the CreateHarness request from the AgentSpec
    package   → skipped (no artifact for a managed harness)
    provision → reuse the shared execution role provisioned by CDK
    deploy    → CreateHarness + poll READY (idempotent on resume)
    register  → create/refresh the A2A registry record (auto-submit)
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
        elif tool.type == "mcp" and tool.config.get("url"):
            # External remote MCP server (streamable-http), typically picked
            # from an APPROVED registry MCP record. Unauthenticated for now —
            # header/Identity-based auth is a follow-up.
            tools.append(
                {
                    "type": "remote_mcp",
                    "name": tool.name,
                    "config": {"remoteMcp": {"url": tool.config["url"]}},
                }
            )
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
    mode = ctx.scratch.get("mode", "create")
    db = ctx.session()
    try:
        row = db.get(Agent, agent.id)

        def _params() -> dict[str, Any]:
            params = ctx.scratch.get("create_params")
            if params is None:  # resume/update path without scratch — regenerate
                settings = get_settings()
                params = build_create_params(
                    AgentSpec(**row.spec),
                    settings.resources.get("execution_role_arn", ""),
                    settings.resources.get("memory_arn"),
                    gateway=_gateway_config(settings.resources),
                )
            return params

        if mode == "update" and row.resource_id:  # in-place re-publish → UpdateHarness
            harness_id = row.resource_id
            update_params = {k: v for k, v in _params().items() if k != "harnessName"}
            update_params["harnessId"] = harness_id
            harness = hc.update_harness(client, update_params)
            row.version = str(harness.get("harnessVersion", row.version or "1"))
            db.commit()
            ctx.log(
                f"UpdateHarness accepted · harnessId {harness_id} · new version {row.version}"
            )
        elif row.resource_id:  # resumed create — harness already made, just poll
            harness_id = row.resource_id
            ctx.log(f"resuming — harness {harness_id} already created, polling status")
        else:  # first create
            harness = hc.create_harness(client, _params())
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
    from app.deployer.registration import register_stage

    return register_stage(ctx, agent)


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
