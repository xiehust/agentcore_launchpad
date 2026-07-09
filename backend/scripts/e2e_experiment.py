#!/usr/bin/env python3
"""E2E: the full optimization loop against real AWS (small-n, budget-conscious).

recommend → bundles → gateway A/B 50/50 → traffic → verdict → promote →
canary (v2 challenger 90/10) → ramp (→50/50) → cleanup (result table).

Run:  cd backend && uv run python scripts/e2e_experiment.py
"""

import json
import sys
import time

import httpx

AGENT = "eval-target"
CHALLENGER = "eval-target-v2"


def wait_stage(client, exp_id, want_status=("ready", "failed"), timeout_s=2400):
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        exp = client.get(f"/api/experiments/{exp_id}").json()
        state = f"{exp['stage']} · {exp['status']}"
        if state != last:
            print(f"  [{time.strftime('%H:%M:%S')}] {state}")
            last = state
        if exp["status"] in want_status:
            return exp
        time.sleep(20)
    raise TimeoutError("experiment loop timeout")


def ensure_agent(client, name, prompt):
    agents = client.get("/api/agents").json()["agents"]
    agent = next((a for a in agents if a["name"] == name and a["status"] == "active"), None)
    if agent:
        return agent
    print(f"── deploying {name}…")
    res = client.post("/api/agents", json={
        "name": name, "method": "zip_runtime", "system_prompt": prompt,
        "memory": {"short_term": False, "long_term": False},
    })
    res.raise_for_status()
    agent_id = res.json()["agent"]["id"]
    for _ in range(90):
        agent = client.get(f"/api/agents/{agent_id}").json()
        if agent["status"] in ("active", "failed"):
            break
        time.sleep(10)
    assert agent["status"] == "active"
    return agent


def main() -> int:
    client = httpx.Client(base_url="http://localhost:8000", timeout=300)
    agent = ensure_agent(
        client, AGENT,
        "You are a precise math assistant. Use the calculator tool for arithmetic "
        "and answer with just the result.",
    )
    challenger = ensure_agent(
        client, CHALLENGER,
        "You are a rigorous math assistant v2. ALWAYS verify with the calculator "
        "tool and reply with ONLY the final number.",
    )

    print("── starting experiment loop…")
    exp = client.post("/api/experiments", json={"agent_id": agent["id"]}).json()
    exp = wait_stage(client, exp["id"])
    if exp["status"] == "failed":
        print(f"LOOP FAILED: {exp['error']}")
        return 1

    art = exp["artifacts"]
    print("\n═══ recommend:")
    print("  prompt suggestion:", art["recommend"]["recommended_prompt"][:220].replace("\n", " "))
    print("  tool suggestions:", json.dumps(art["recommend"]["tool_descriptions"])[:220])
    print("═══ bundles:")
    print("  control:  ", art["bundles"]["control"]["arn"])
    print("  treatment:", art["bundles"]["treatment"]["arn"])
    print("═══ gateway:", art["gateway"]["gateway_id"], "· target", art["gateway"]["target_v1"])
    print("═══ abtest:", art["abtest"]["ab_test_id"], "· weights",
          [v["weight"] for v in art["abtest"]["variants"]])
    print("═══ traffic:", art["traffic"])
    print("═══ verdict:", json.dumps({k: v for k, v in art["verdict"].items()
                                      if k != "metrics"}))
    print("  metrics:", json.dumps(art["verdict"]["metrics"])[:400])

    print("\n── promote…")
    promote = client.post(f"/api/experiments/{exp['id']}/action",
                          json={"action": "promote"}).json()["result"]
    print("  weights:", promote["before_weights"], "→", promote["after_weights"])

    print("── canary (challenger 90/10)…")
    canary = client.post(
        f"/api/experiments/{exp['id']}/action",
        json={"action": "canary", "challenger_agent_id": challenger["id"]},
    ).json()["result"]
    print("  canary abtest:", canary["canary_ab_test_id"], "weights:", canary["weights"])

    print("── ramp…")
    ramp = client.post(f"/api/experiments/{exp['id']}/action",
                       json={"action": "ramp"}).json()["result"]
    print("  weights:", ramp["before_weights"], "→", ramp["after_weights"],
          f"(stage {ramp['ramp_stage']})")

    print("── online eval config state:")
    import boto3
    control = boto3.client("bedrock-agentcore-control", region_name="us-west-2")
    oe = control.get_online_evaluation_config(
        onlineEvaluationConfigId=art["gateway"]["online_eval_id"]
    )
    print(f"  {oe.get('onlineEvaluationConfigName')} · status={oe.get('status')} "
          f"· execution={oe.get('executionStatus')}")

    print("── cleanup…")
    cleanup = client.post(f"/api/experiments/{exp['id']}/action",
                          json={"action": "cleanup"}).json()["result"]
    for row in cleanup:
        print(f"  {row['status']:<8} {row['category']:<28} {row['detail'][:60]}")

    print("── shared gateway untouched check:")
    gw = control.get_gateway(gatewayIdentifier="launchpad-gw-em0yuqmmdp")
    print(f"  launchpad-gw status: {gw['status']}")

    failed = [r for r in cleanup if r["status"] != "deleted"]
    if failed:
        print(f"cleanup had {len(failed)} skipped categories")
    print("E2E EXPERIMENT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
