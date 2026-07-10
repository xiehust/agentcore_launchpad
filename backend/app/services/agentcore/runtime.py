"""Thin wrappers over the AgentCore Runtime control/data APIs.

Explicit-client style (tests inject stubs). Shapes per bedrock-agentcore-control
1.43.x: runtime status enum is CREATING → READY (or CREATE_FAILED).
"""

import json
import time
from typing import Any

from app.services.agentcore.harness import new_session_id

TERMINAL_FAILURES = {"CREATE_FAILED", "UPDATE_FAILED"}


def create_code_runtime(
    client: Any,
    *,
    runtime_name: str,
    s3_bucket: str,
    s3_key: str,
    role_arn: str,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """CreateAgentRuntime from a zip on S3, instrumented via ADOT."""
    params: dict[str, Any] = {
        "agentRuntimeName": runtime_name,
        "agentRuntimeArtifact": {
            "codeConfiguration": {
                "code": {"s3": {"bucket": s3_bucket, "prefix": s3_key}},
                "runtime": "PYTHON_3_13",
                "entryPoint": ["opentelemetry-instrument", "main.py"],
            }
        },
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "roleArn": role_arn,
    }
    if environment:
        params["environmentVariables"] = dict(environment)
    return client.create_agent_runtime(**params)


def create_container_runtime(
    client: Any,
    *,
    runtime_name: str,
    container_uri: str,
    role_arn: str,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """CreateAgentRuntime from an ECR image (Claude SDK container path)."""
    params: dict[str, Any] = {
        "agentRuntimeName": runtime_name,
        "agentRuntimeArtifact": {
            "containerConfiguration": {"containerUri": container_uri}
        },
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "roleArn": role_arn,
    }
    if environment:
        params["environmentVariables"] = dict(environment)
    return client.create_agent_runtime(**params)


def _code_artifact(s3_bucket: str, s3_key: str) -> dict[str, Any]:
    return {
        "codeConfiguration": {
            "code": {"s3": {"bucket": s3_bucket, "prefix": s3_key}},
            "runtime": "PYTHON_3_13",
            "entryPoint": ["opentelemetry-instrument", "main.py"],
        }
    }


def update_code_runtime(
    client: Any,
    *,
    runtime_id: str,
    s3_bucket: str,
    s3_key: str,
    role_arn: str,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """UpdateAgentRuntime with a new zip artifact — publishes a new version in
    place (same agentRuntimeId/ARN; the DEFAULT endpoint auto-rolls to it)."""
    params: dict[str, Any] = {
        "agentRuntimeId": runtime_id,
        "agentRuntimeArtifact": _code_artifact(s3_bucket, s3_key),
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "roleArn": role_arn,
    }
    if environment:
        params["environmentVariables"] = dict(environment)
    return client.update_agent_runtime(**params)


def update_container_runtime(
    client: Any,
    *,
    runtime_id: str,
    container_uri: str,
    role_arn: str,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """UpdateAgentRuntime with a new container image — new version, same ARN."""
    params: dict[str, Any] = {
        "agentRuntimeId": runtime_id,
        "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": container_uri}},
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "roleArn": role_arn,
    }
    if environment:
        params["environmentVariables"] = dict(environment)
    return client.update_agent_runtime(**params)


def get_runtime(client: Any, runtime_id: str) -> dict[str, Any]:
    return client.get_agent_runtime(agentRuntimeId=runtime_id)


def delete_runtime(client: Any, runtime_id: str) -> None:
    client.delete_agent_runtime(agentRuntimeId=runtime_id)


def wait_runtime_ready(
    client: Any,
    runtime_id: str,
    timeout_s: int = 1200,
    interval_s: int = 10,
    sleeper: Any = time.sleep,
    on_status: Any = None,
) -> dict[str, Any]:
    """Poll GetAgentRuntime until READY; runtimes can take 5–15 minutes."""
    deadline = time.monotonic() + timeout_s
    last_status = None
    while True:
        detail = get_runtime(client, runtime_id)
        status = detail["status"]
        if status != last_status and on_status:
            on_status(status)
        last_status = status
        if status == "READY":
            return detail
        if status in TERMINAL_FAILURES:
            reason = detail.get("failureReason", "no failureReason provided")
            raise RuntimeError(f"runtime {runtime_id} entered {status}: {reason}")
        if time.monotonic() > deadline:
            raise TimeoutError(f"runtime {runtime_id} still {status} after {timeout_s}s")
        sleeper(interval_s)


def invoke_runtime_text(
    client: Any,
    runtime_arn: str,
    prompt: str,
    session_id: str | None = None,
    actor_id: str = "default",
) -> dict[str, Any]:
    """Synchronous InvokeAgentRuntime with the template's {prompt} payload."""
    session_id = session_id or new_session_id()
    response = client.invoke_agent_runtime(
        agentRuntimeArn=runtime_arn,
        runtimeSessionId=session_id,
        payload=json.dumps({"prompt": prompt, "actor_id": actor_id}).encode("utf-8"),
    )
    raw = response["response"].read()
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        body = {"result": raw.decode("utf-8", errors="replace") if raw else ""}
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"runtime returned error: {body['error']}")
    text = body.get("result", "") if isinstance(body, dict) else str(body)
    return {"text": str(text), "session_id": session_id}
