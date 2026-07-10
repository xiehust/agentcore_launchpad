"""Thin wrappers over the Harness control/data APIs.

Every function takes an explicit client so tests inject stubs that capture
kwargs. Payload shapes follow bedrock-agentcore-control 1.43.x.
"""

import time
import uuid
from typing import Any

TERMINAL_FAILURES = {"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"}


def create_harness(client: Any, params: dict[str, Any]) -> dict[str, Any]:
    """CreateHarness; returns the harness detail dict (harnessId, arn, status…)."""
    return client.create_harness(**params)["harness"]


def update_harness(client: Any, params: dict[str, Any]) -> dict[str, Any]:
    """UpdateHarness — publishes a new harness version in place. Same harnessId
    and ARN; ``params`` carries ``harnessId`` plus the edited config (model,
    systemPrompt, tools, memory…), i.e. the create params minus ``harnessName``."""
    return client.update_harness(**params)["harness"]


def get_harness(client: Any, harness_id: str) -> dict[str, Any]:
    return client.get_harness(harnessId=harness_id)["harness"]


def delete_harness(client: Any, harness_id: str) -> None:
    client.delete_harness(harnessId=harness_id)


def wait_harness_ready(
    client: Any,
    harness_id: str,
    timeout_s: int = 300,
    interval_s: int = 5,
    sleeper: Any = time.sleep,
) -> dict[str, Any]:
    """Poll GetHarness until READY; raise on terminal failure or timeout."""
    deadline = time.monotonic() + timeout_s
    while True:
        harness = get_harness(client, harness_id)
        status = harness["status"]
        if status == "READY":
            return harness
        if status in TERMINAL_FAILURES:
            reason = harness.get("failureReason", "no failureReason provided")
            raise RuntimeError(f"harness {harness_id} entered {status}: {reason}")
        if time.monotonic() > deadline:
            raise TimeoutError(f"harness {harness_id} still {status} after {timeout_s}s")
        sleeper(interval_s)


def new_session_id() -> str:
    # Runtime session ids must be long (≥33 chars); two uuid4 hex = 64.
    return uuid.uuid4().hex + uuid.uuid4().hex


def invoke_harness_text(
    client: Any,
    harness_arn: str,
    prompt: str,
    session_id: str | None = None,
    actor_id: str = "default",
) -> dict[str, Any]:
    """Synchronous invoke: send one user message, drain the event stream,
    return the concatenated assistant text plus session id."""
    session_id = session_id or new_session_id()
    response = client.invoke_harness(
        harnessArn=harness_arn,
        runtimeSessionId=session_id,
        actorId=actor_id,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    text_parts: list[str] = []
    for event in response["stream"]:
        delta = event.get("contentBlockDelta", {}).get("delta", {})
        if "text" in delta:
            text_parts.append(delta["text"])
        if "runtimeClientError" in event:
            raise RuntimeError(f"runtime client error: {event['runtimeClientError']}")
        if "internalServerException" in event:
            raise RuntimeError(f"internal server error: {event['internalServerException']}")
    return {"text": "".join(text_parts), "session_id": session_id}
