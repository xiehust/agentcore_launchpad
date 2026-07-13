"""Method-aware invoke + undeploy dispatch.

Chat playground (phase 8) and the public API share this single entry point,
so both consumption paths behave identically.
"""

from typing import Any

from app.core.errors import AppError
from app.models.ledger import Agent
from app.services.agentcore import harness as hc
from app.services.agentcore import runtime as rt
from app.services.agentcore.client import data_client


def invoke_agent_text(
    agent: Agent, prompt: str, session_id: str | None = None, actor_id: str = "default"
) -> dict[str, Any]:
    if agent.method == "harness":
        return hc.invoke_harness_text(
            data_client(), agent.arn, prompt, session_id=session_id, actor_id=actor_id
        )
    if agent.method in ("zip_runtime", "studio", "container"):
        # A2A-protocol runtimes speak JSON-RPC; the A2A server owns
        # conversation state (no actor_id/memory envelope)
        if (agent.spec or {}).get("protocol") == "a2a":
            return rt.invoke_a2a_text(
                data_client(), agent.arn, prompt, session_id=session_id
            )
        return rt.invoke_runtime_text(
            data_client(), agent.arn, prompt, session_id=session_id, actor_id=actor_id
        )
    raise AppError(
        "agent.method_not_available",
        f"no invoke path for method '{agent.method}'",
        status_code=400,
    )
