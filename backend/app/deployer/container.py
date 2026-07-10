"""Claude Agent SDK container path (方式A).

    generate  → assemble the ARM64 build context (Dockerfile + rendered main.py
                + .claude scaffold) from the AgentSpec
    package   → zip context → S3 → CodeBuild (docker build+push, phases streamed
                into the job log) → ECR image
    provision → reuse the shared execution role
    deploy    → CreateAgentRuntime(containerConfiguration) + poll READY
    register  → create/refresh the A2A registry record (auto-submit)
"""

import shutil
import time
from pathlib import Path

import boto3

from app.core.config import get_settings
from app.deployer.pipeline import StageContext, StageResult, register_method
from app.models.ledger import Agent
from app.schemas.agent import AgentSpec
from app.services.agentcore import codebuild as cb
from app.services.agentcore import runtime as rt
from app.services.agentcore.client import control_client
from app.templates.claude_sdk_agent import assemble_build_context

from .zip_runtime import sanitize_runtime_name


def _image_ref(settings, agent: Agent) -> tuple[str, str, str]:
    registry = f"{settings.account_id}.dkr.ecr.{settings.region}.amazonaws.com"
    repo = settings.resources.get("ecr_repo", "launchpad-agents")
    tag = f"{agent.name}-v{agent.version or '1'}"
    return registry, repo, tag


def _stage_generate(ctx: StageContext, agent: Agent) -> StageResult:
    spec = AgentSpec(**agent.spec)
    context_dir = assemble_build_context(spec, Path(f"/tmp/launchpad_ctx_{agent.name}"))
    files = sorted(str(p.relative_to(context_dir)) for p in context_dir.rglob("*") if p.is_file())
    ctx.scratch["context_dir"] = str(context_dir)
    ctx.log(f"build context assembled: {', '.join(files)}")
    return StageResult(detail=f"container context · {len(files)} files")


def _stage_package(ctx: StageContext, agent: Agent) -> StageResult:
    settings = get_settings()
    bucket = settings.resources.get("artifacts_bucket")
    project = settings.resources.get("codebuild_project")
    if not bucket or not project:
        raise RuntimeError("artifacts_bucket/codebuild_project missing — run scripts/bootstrap.py")

    spec = AgentSpec(**agent.spec)
    context_dir = Path(
        ctx.scratch.get("context_dir")
        or assemble_build_context(spec, Path(f"/tmp/launchpad_ctx_{agent.name}"))
    )
    archive = shutil.make_archive(str(context_dir) + "_src", "zip", context_dir)
    s3_key = f"builds/{agent.name}/source.zip"
    boto3.client("s3", region_name=settings.region).upload_file(archive, bucket, s3_key)
    ctx.log(f"source zip uploaded → s3://{bucket}/{s3_key}")

    registry, repo, tag = _image_ref(settings, agent)
    codebuild = boto3.client("codebuild", region_name=settings.region)
    t0 = time.monotonic()
    build_id = cb.start_image_build(
        codebuild,
        project=project,
        s3_bucket=bucket,
        s3_key=s3_key,
        region=settings.region,
        ecr_registry=registry,
        ecr_repo=repo,
        image_tag=tag,
    )
    ctx.log(f"codebuild started · {build_id}")
    cb.wait_build(codebuild, build_id, on_phase=lambda p: ctx.log(f"codebuild phase: {p}"))
    mins = (time.monotonic() - t0) / 60
    image_uri = f"{registry}/{repo}:{tag}"
    ctx.scratch["image_uri"] = image_uri
    ctx.log(f"image pushed · {image_uri}")
    return StageResult(detail=f"codebuild · arm64 · {mins:.1f}m → :{tag}")


def _stage_provision(ctx: StageContext, agent: Agent) -> StageResult:
    role_arn = get_settings().resources.get("execution_role_arn")
    if not role_arn:
        raise RuntimeError("execution_role_arn missing — run scripts/bootstrap.py")
    ctx.scratch["execution_role_arn"] = role_arn
    return StageResult(detail="iam role reused · launchpad-base")


def _stage_deploy(ctx: StageContext, agent: Agent) -> StageResult:
    settings = get_settings()
    client = control_client()
    mode = ctx.scratch.get("mode", "create")
    db = ctx.session()
    try:
        row = db.get(Agent, agent.id)

        def _kwargs() -> dict:
            registry, repo, tag = _image_ref(settings, row)
            spec = AgentSpec(**row.spec)
            return {
                "container_uri": ctx.scratch.get("image_uri") or f"{registry}/{repo}:{tag}",
                "role_arn": ctx.scratch.get("execution_role_arn")
                or settings.resources.get("execution_role_arn", ""),
                "environment": spec.env or None,
            }

        if mode == "update" and row.resource_id:  # re-publish → UpdateAgentRuntime (new version)
            runtime_id = row.resource_id
            updated = rt.update_container_runtime(client, runtime_id=runtime_id, **_kwargs())
            row.version = str(updated.get("agentRuntimeVersion", row.version or "1"))
            db.commit()
            ctx.log(
                f"UpdateAgentRuntime accepted · runtimeId {runtime_id} · "
                f"new version {row.version}"
            )
        elif row.resource_id:
            runtime_id = row.resource_id
            ctx.log(f"resuming — runtime {runtime_id} already created, polling status")
        else:
            created = rt.create_container_runtime(
                client, runtime_name=sanitize_runtime_name(row.name), **_kwargs()
            )
            runtime_id = created["agentRuntimeId"]
            row.resource_id = runtime_id
            row.arn = created["agentRuntimeArn"]
            row.version = str(created.get("agentRuntimeVersion", "1"))
            db.commit()
            ctx.log(f"CreateAgentRuntime accepted · runtimeId {runtime_id}")

        ready = rt.wait_runtime_ready(
            client, runtime_id, on_status=lambda s: ctx.log(f"runtime status: {s}")
        )
        row.arn = ready["agentRuntimeArn"]
        db.commit()
        return StageResult(detail=f"READY · {ready['agentRuntimeArn']}")
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

register_method("container", STAGES)


def delete_agent_resources(agent: Agent) -> None:
    if not agent.resource_id:
        return
    client = control_client()
    try:
        rt.delete_runtime(client, agent.resource_id)
    except client.exceptions.ResourceNotFoundException:
        pass
