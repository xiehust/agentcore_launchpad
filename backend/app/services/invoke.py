"""Method-aware invoke + undeploy dispatch.

Chat playground (phase 8) and the public API share this single entry point,
so both consumption paths behave identically.
"""

import json
import logging
from typing import Any

from app.core.errors import AppError
from app.models.ledger import Agent
from app.optimization import canary_service
from app.services.agentcore import gateway
from app.services.agentcore import harness as hc
from app.services.agentcore import runtime as rt
from app.services.agentcore.client import data_client

logger = logging.getLogger(__name__)


def _parse_gateway_text(raw_text: str, session_id: str) -> dict[str, Any]:
    """Parse a gateway HTTP response body the SAME way ``rt.invoke_runtime_text``
    parses ``invoke_agent_runtime``: JSON ``{"result": ...}`` or an SSE stream via
    ``rt.flatten_sse_text``."""
    try:
        body = json.loads(raw_text)
    except (ValueError, TypeError):
        body = {"result": rt.flatten_sse_text(raw_text) or raw_text}
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"runtime returned error: {body['error']}")
    text = body.get("result", "") if isinstance(body, dict) else str(body)
    return {"text": str(text), "session_id": session_id}


def _invoke_via_stable_endpoint(
    route: dict[str, Any],
    prompt: str,
    session_id: str | None,
    actor_id: str,
) -> dict[str, Any]:
    """Direct-invoke the runtime pinned to the stable endpoint (= v_current).

    Used both as the fail-safe for a gateway error and as the primary path while a
    canary is still provisioning (stable endpoint stood up, gateway A/B not live
    yet) — either way production serves the tested control version, never DEFAULT
    (which the candidate mint already rolled to the untested candidate)."""
    return rt.invoke_runtime_text(
        data_client(),
        route["arn"],
        prompt,
        session_id=session_id,
        actor_id=actor_id,
        qualifier=route["stable_endpoint"],
    )


def _invoke_via_canary(
    route: dict[str, Any],
    prompt: str,
    session_id: str | None,
    actor_id: str,
) -> dict[str, Any]:
    """Route a real invocation for an active canary.

    Two forms (see ``canary_service.active_canary_route``):

    - **live gateway** (``gateway_url`` + ``control_target`` present) — POST
      through the canary gateway, which assigns a variant by sticky session id and
      splits by weight. A gateway error is control-safe: fall back to the stable
      endpoint (v_current), NOT DEFAULT (the untested candidate).
    - **provisioning** (stable endpoint only, no live gateway yet) — direct-invoke
      the stable endpoint so production stays on v_current during setup.
    """
    if not (route.get("gateway_url") and route.get("control_target")):
        return _invoke_via_stable_endpoint(route, prompt, session_id, actor_id)
    # Runtime session ids must be ≥33 chars (spike); mint one when absent/short.
    sticky = session_id if (session_id and len(session_id) >= 33) else rt.new_session_id()
    url = f"{route['gateway_url'].rstrip('/')}/{route['control_target']}/invocations"
    try:
        # Same body shape service.send_gateway_traffic posts to the gateway.
        response = gateway.sigv4_post(
            url, {"prompt": prompt, "sessionId": sticky}, session_id=sticky
        )
        if response.status_code != 200:
            raise RuntimeError(f"gateway route returned HTTP {response.status_code}")
        return _parse_gateway_text(response.text, sticky)
    except Exception as exc:
        logger.warning(
            "canary gateway route failed (%s); falling back to stable endpoint %s",
            exc,
            route.get("stable_endpoint"),
        )
        return _invoke_via_stable_endpoint(route, prompt, session_id, actor_id)


def invoke_agent_text(
    agent: Agent, prompt: str, session_id: str | None = None, actor_id: str = "default"
) -> dict[str, Any]:
    if agent.method == "harness":
        return hc.invoke_harness_text(
            data_client(), agent.arn, prompt, session_id=session_id, actor_id=actor_id
        )
    if agent.method in ("zip_runtime", "studio", "container"):
        # A2A-protocol runtimes speak JSON-RPC; the A2A server owns
        # conversation state (no actor_id/memory envelope) and can't be canaried
        if (agent.spec or {}).get("protocol") == "a2a":
            return rt.invoke_a2a_text(
                data_client(), agent.arn, prompt, session_id=session_id
            )
        # During an active canary, real production traffic for this agent flows
        # through the canary's gateway; otherwise the path below is unchanged.
        route = canary_service.active_canary_route(agent.id)
        if route is not None:
            return _invoke_via_canary(route, prompt, session_id, actor_id)
        return rt.invoke_runtime_text(
            data_client(), agent.arn, prompt, session_id=session_id, actor_id=actor_id
        )
    raise AppError(
        "agent.method_not_available",
        f"no invoke path for method '{agent.method}'",
        status_code=400,
    )
