"""Governance bootstrap: Transaction Search + policy engine + Cedar policies.

Same idempotent ensure_* contract as the earlier bootstrap layers.
Cedar sources live in samples/policies/ (committed for customers);
__GATEWAY_ARN__ is substituted at bootstrap time.
"""

import time
from typing import Any

from app.core.config import REPO_ROOT

POLICY_ENGINE_NAME = "launchpad_pe"
POLICIES_DIR = REPO_ROOT / "samples" / "policies"

POLICIES = [
    {
        "name": "launchpad_baseline_allow",
        "file": "allow_gateway_tools.cedar",
        # Intentional broad baseline permit — triggers an ALLOW_ALL finding by
        # design (Cedar is default-deny; restrictions layer on with forbids).
        "validation_mode": "IGNORE_ALL_FINDINGS",
    },
    {
        "name": "launchpad_payout_admin_only",
        "file": "payout_admin_only.cedar",
        "validation_mode": "IGNORE_ALL_FINDINGS",
    },
]


def ensure_transaction_search(xray: Any) -> dict[str, Any]:
    """CloudWatch Transaction Search = X-Ray segments destined to CW Logs."""
    state = xray.get_trace_segment_destination()
    if state.get("Destination") == "CloudWatchLogs" and state.get("Status") == "ACTIVE":
        return {"enabled": True, "changed": False, "status": state["Status"]}
    xray.update_trace_segment_destination(Destination="CloudWatchLogs")
    for _ in range(30):
        state = xray.get_trace_segment_destination()
        if state.get("Status") == "ACTIVE":
            break
        time.sleep(5)
    return {"enabled": state.get("Status") == "ACTIVE", "changed": True,
            "status": state.get("Status")}


def ensure_policy_engine(control: Any, name: str = POLICY_ENGINE_NAME) -> tuple[dict, bool]:
    engines = control.list_policy_engines(maxResults=20).get("policyEngines", [])
    for engine in engines:
        if engine.get("name") == name:
            return (
                {"id": engine["policyEngineId"], "arn": engine["policyEngineArn"]},
                False,
            )
    created = control.create_policy_engine(
        name=name, description="AgentCore Launchpad governance — Cedar tool authorization"
    )
    engine_id = created["policyEngineId"]
    _wait_engine_active(control, engine_id)
    return {"id": engine_id, "arn": created["policyEngineArn"]}, True


def _wait_engine_active(control: Any, engine_id: str, timeout_s: int = 120) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        status = control.get_policy_engine(policyEngineId=engine_id)["status"]
        if status == "ACTIVE":
            return
        if "FAILED" in status:
            raise RuntimeError(f"policy engine {engine_id} entered {status}")
        time.sleep(3)
    raise TimeoutError(f"policy engine {engine_id} not ACTIVE after {timeout_s}s")


def render_policy_statement(filename: str, gateway_arn: str) -> str:
    source = (POLICIES_DIR / filename).read_text(encoding="utf-8")
    return source.replace("__GATEWAY_ARN__", gateway_arn)


def ensure_policies(
    control: Any, engine_id: str, gateway_arn: str
) -> list[dict[str, Any]]:
    existing = {
        p["name"]: p
        for p in control.list_policies(policyEngineId=engine_id, maxResults=20).get(
            "policies", []
        )
    }
    results = []
    for spec in POLICIES:
        if spec["name"] in existing:
            results.append({"name": spec["name"], "id": existing[spec["name"]]["policyId"],
                            "created": False})
            continue
        statement = render_policy_statement(spec["file"], gateway_arn)
        created = control.create_policy(
            policyEngineId=engine_id,
            name=spec["name"],
            definition={"cedar": {"statement": statement}},
            validationMode=spec["validation_mode"],
        )
        _wait_policy_settled(control, engine_id, created["policyId"])
        results.append({"name": spec["name"], "id": created["policyId"], "created": True})
    return results


def _wait_policy_settled(
    control: Any, engine_id: str, policy_id: str, timeout_s: int = 120
) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        detail = control.get_policy(policyEngineId=engine_id, policyId=policy_id)
        status = detail["status"]
        if status == "ACTIVE":
            return
        if "FAILED" in status:
            raise RuntimeError(
                f"policy {policy_id} entered {status}: {detail.get('statusReasons')}"
            )
        time.sleep(3)
    raise TimeoutError(f"policy {policy_id} not ACTIVE after {timeout_s}s")


def attach_engine_to_gateway(
    control: Any, gateway_id: str, engine_arn: str, mode: str = "ENFORCE"
) -> bool:
    """Attach (or confirm) the policy engine on the gateway. Returns changed."""
    gateway = control.get_gateway(gatewayIdentifier=gateway_id)
    current = gateway.get("policyEngineConfiguration") or {}
    if current.get("arn") == engine_arn and current.get("mode") == mode:
        return False
    control.update_gateway(
        gatewayIdentifier=gateway_id,
        name=gateway["name"],
        roleArn=gateway["roleArn"],
        protocolType=gateway.get("protocolType", "MCP"),
        authorizerType=gateway["authorizerType"],
        authorizerConfiguration=gateway["authorizerConfiguration"],
        policyEngineConfiguration={"arn": engine_arn, "mode": mode},
    )
    deadline = time.time() + 180
    while time.time() < deadline:
        if control.get_gateway(gatewayIdentifier=gateway_id)["status"] == "READY":
            return True
        time.sleep(5)
    raise TimeoutError("gateway not READY after policy engine attach")


def run_policy_bootstrap(control: Any, xray: Any, config: dict[str, Any]) -> dict[str, Any]:
    resources = config.get("resources", {})
    tx = ensure_transaction_search(xray)
    engine, engine_created = ensure_policy_engine(control)
    policies = ensure_policies(control, engine["id"], resources["gateway_arn"])
    attached = attach_engine_to_gateway(control, resources["gateway_id"], engine["arn"])
    return {
        "transaction_search": tx,
        "policy_engine": {**engine, "created": engine_created},
        "policies": policies,
        "gateway_attached": attached,
    }
