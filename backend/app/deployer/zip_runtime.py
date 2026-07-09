"""Runtime zip fast path (Strands / Studio agents).

    generate  → render the Strands template from the AgentSpec
    package   → pip install (ARM64 wheels) → zip → S3 artifacts bucket
    provision → reuse the shared execution role
    deploy    → CreateAgentRuntime + poll READY (5–15 min tolerated)
    register  → create/refresh the A2A registry record (auto-submit)

Package/deploy internals adapted from agentcore_eva_opt backend/app/deployer.py
(github.com/xiehust/agentcore_eva_opt); reworked to use the shared CDK bucket
and role instead of per-agent resources.
"""

import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import boto3

from app.core.config import get_settings
from app.deployer.pipeline import StageContext, StageResult, register_method
from app.models.ledger import Agent
from app.schemas.agent import AgentSpec
from app.services.agentcore import runtime as rt
from app.services.agentcore.client import control_client
from app.templates.strands_agent import base_requirements, render_main_py


def sanitize_runtime_name(name: str) -> str:
    """Runtime names must be alphanumeric/underscore; suffix keeps them unique."""
    base = re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_")[:40] or "agent"
    return f"{base}_{uuid.uuid4().hex[:6]}"


def build_zip(
    code: str,
    requirements: list[str],
    build_dir: Path,
    pip_runner: Callable[..., Any] = subprocess.run,
) -> Path:
    """pip-install ARM64 wheels + template code into a deployment zip."""
    if build_dir.exists():
        shutil.rmtree(build_dir)
    pkg_dir = build_dir / "pkg"
    pkg_dir.mkdir(parents=True)

    proc = pip_runner(
        [
            sys.executable, "-m", "pip", "install",
            *requirements,
            "-t", str(pkg_dir),
            "--platform", "manylinux2014_aarch64",
            "--only-binary=:all:",
            "--python-version", "3.13",
            "--quiet",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()[-2000:]
        raise RuntimeError(f"pip install failed for {requirements}: {stderr}")

    (pkg_dir / "main.py").write_text(code, encoding="utf-8")
    (pkg_dir / "requirements.txt").write_text("\n".join(requirements) + "\n", encoding="utf-8")

    zip_path = build_dir / "deployment_package.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(pkg_dir):
            for name in files:
                if name.endswith(".pyc") or "__pycache__" in root:
                    continue
                full = Path(root) / name
                zf.write(full, full.relative_to(pkg_dir))
    return zip_path


def _generate_code(spec: AgentSpec) -> tuple[str, str]:
    """(code, source label) — studio artifacts arrive pre-generated."""
    if spec.method == "studio" and spec.code:
        from app.templates.studio_agent import adapt_studio_code

        return adapt_studio_code(spec.code), "studio artifact (adapted)"
    return render_main_py(spec), "strands template"


STUDIO_EXTRA_REQUIREMENTS = [
    # studio's generator imports the strands_tools catalog (incl. mem0_memory)
    "strands-agents-tools[mem0_memory]",
]


def _method_requirements(spec: AgentSpec) -> list[str]:
    extra = STUDIO_EXTRA_REQUIREMENTS if spec.method == "studio" else []
    return base_requirements() + extra + spec.requirements


def _stage_generate(ctx: StageContext, agent: Agent) -> StageResult:
    spec = AgentSpec(**agent.spec)
    code, source = _generate_code(spec)
    requirements = _method_requirements(spec)
    ctx.scratch["code"] = code
    ctx.scratch["requirements"] = requirements
    ctx.log(f"{source} · {len(code)} bytes · model {spec.model_id}")
    return StageResult(detail=f"{source} · {len(code)} bytes")


def _stage_package(ctx: StageContext, agent: Agent) -> StageResult:
    settings = get_settings()
    bucket = settings.resources.get("artifacts_bucket")
    if not bucket:
        raise RuntimeError("artifacts_bucket missing from config — run scripts/bootstrap.py")
    spec = AgentSpec(**agent.spec)
    code = ctx.scratch.get("code") or _generate_code(spec)[0]
    requirements = ctx.scratch.get("requirements") or _method_requirements(spec)

    build_dir = Path(f"/tmp/launchpad_build_{agent.name}")
    t0 = time.monotonic()
    zip_path = build_zip(code, requirements, build_dir)
    pip_secs = time.monotonic() - t0
    size_mb = zip_path.stat().st_size / 1e6

    s3_key = f"agents/{agent.name}/deployment_package.zip"
    boto3.client("s3", region_name=settings.region).upload_file(str(zip_path), bucket, s3_key)
    ctx.scratch["s3_bucket"], ctx.scratch["s3_key"] = bucket, s3_key
    ctx.log(f"pip+zip {pip_secs:.1f}s · {size_mb:.1f}MB → s3://{bucket}/{s3_key}")
    return StageResult(detail=f"pip+zip {pip_secs:.1f}s · {size_mb:.1f}MB · s3 ✓")


def _stage_provision(ctx: StageContext, agent: Agent) -> StageResult:
    role_arn = get_settings().resources.get("execution_role_arn")
    if not role_arn:
        raise RuntimeError("execution_role_arn missing from config — run scripts/bootstrap.py")
    ctx.scratch["execution_role_arn"] = role_arn
    return StageResult(detail="iam role reused · launchpad-base")


def _stage_deploy(ctx: StageContext, agent: Agent) -> StageResult:
    settings = get_settings()
    client = control_client()
    db = ctx.session()
    try:
        row = db.get(Agent, agent.id)
        if row.resource_id:
            runtime_id = row.resource_id
            ctx.log(f"resuming — runtime {runtime_id} already created, polling status")
        else:
            spec = AgentSpec(**row.spec)
            environment = dict(spec.env)
            if (spec.memory.short_term or spec.memory.long_term) and settings.resources.get(
                "memory_id"
            ):
                environment.setdefault("LAUNCHPAD_MEMORY_ID", settings.resources["memory_id"])
            created = rt.create_code_runtime(
                client,
                runtime_name=sanitize_runtime_name(row.name),
                s3_bucket=ctx.scratch.get("s3_bucket")
                or settings.resources.get("artifacts_bucket", ""),
                s3_key=ctx.scratch.get("s3_key")
                or f"agents/{row.name}/deployment_package.zip",
                role_arn=ctx.scratch.get("execution_role_arn")
                or settings.resources.get("execution_role_arn", ""),
                environment=environment or None,
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
        row.version = str(ready.get("agentRuntimeVersion", row.version or "1"))
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

register_method("zip_runtime", STAGES)
register_method("studio", STAGES)  # studio agents ride the same zip fast path


def delete_agent_resources(agent: Agent) -> None:
    if not agent.resource_id:
        return
    client = control_client()
    try:
        rt.delete_runtime(client, agent.resource_id)
    except client.exceptions.ResourceNotFoundException:
        pass
