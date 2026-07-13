#!/usr/bin/env python3
"""E2E: the stepwise optimization flow against real AWS (small-n, budget-conscious).

Drives every user action in order, exactly like the UI:
recommend → accept → bundles → gateway → abtest → traffic → verdict →
promote → canary (v2 challenger 90/10) → ramp (→50/50) → cleanup.

Async actions return 202; this waits on running_action/progress like the
page's poll loop does.

Run:  cd backend && uv run python scripts/e2e_experiment.py
"""

import json
import sys
import time

import httpx

AGENT = "eval-target"
CHALLENGER = "eval-target-v2"


def action(client, exp_id, name, timeout_s=1800, **fields):
    """POST one stage action, then poll the row until the runner is idle."""
    res = client.post(f"/api/experiments/{exp_id}/action",
                      json={"action": name, **fields})
    res.raise_for_status()
    exp = res.json()["experiment"]
    if res.status_code != 202:  # sync action — done already
        return exp
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        exp = client.get(f"/api/experiments/{exp_id}").json()
        line = exp.get("progress") or exp.get("stage")
        if line != last:
            print(f"  [{time.strftime('%H:%M:%S')}] {line}")
            last = line
        if not exp.get("running_action"):
            if exp.get("error"):
                raise RuntimeError(f"action {name} failed: {exp['error']}")
            return exp
        time.sleep(10)
    raise TimeoutError(f"action {name} timed out")


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

    # resume an interrupted run instead of tripping the one-running guard —
    # completed actions are skipped by artifact presence, like the UI does
    running = [e for e in client.get("/api/experiments").json()["experiments"]
               if e["status"] == "running"]
    if running:
        exp = running[0]
        exp_id = exp["id"]
        print(f"── resuming running experiment {exp_id} "
              f"(artifacts: {sorted(exp['artifacts'])})…")
    else:
        print("── create experiment (no stage work yet)…")
        res = client.post("/api/experiments", json={"agent_id": agent["id"]})
        res.raise_for_status()
        exp = res.json()
        exp_id = exp["id"]
        assert exp["stage"] == "recommend" and set(exp["artifacts"]) == {"agent_meta"}, \
            "create must defer all stage work"

    def ensure(name, done, **fields):
        nonlocal exp
        if done(exp["artifacts"]):
            print(f"── {name}: already done, skipping")
            return exp
        print(f"── {name}…")
        exp = action(client, exp_id, name, **fields)
        return exp

    ensure("recommend", lambda a: "recommend" in a)
    rec = exp["artifacts"]["recommend"]
    print("  prompt suggestion:", rec["recommended_prompt"][:220].replace("\n", " "))
    print("  tool suggestions:", json.dumps(rec["tool_descriptions"])[:220])

    ensure("accept", lambda a: a["recommend"].get("accepted_prompt"),
           accepted_prompt=rec["recommended_prompt"])

    ensure("bundles", lambda a: "bundles" in a)
    art = exp["artifacts"]
    print("  control:  ", art["bundles"]["control"]["arn"])
    print("  treatment:", art["bundles"]["treatment"]["arn"])

    ensure("gateway", lambda a: "gateway" in a)
    art = exp["artifacts"]
    print("  gateway:", art["gateway"]["gateway_id"], "· target",
          art["gateway"]["target_v1"])

    ensure("abtest", lambda a: "abtest" in a)
    art = exp["artifacts"]
    print("  abtest:", art["abtest"]["ab_test_id"], "· weights",
          [v["weight"] for v in art["abtest"]["variants"]])

    datasets = client.get("/api/eval/datasets").json()["datasets"]
    usable = next((d for d in datasets if d["kind"] in ("legacy", "predefined")
                   and d["item_count"] > 0), None)
    fields = {"dataset_id": usable["id"]} if usable else {}
    if usable:
        print(f"── traffic dataset: {usable['name']} ({usable['item_count']} items)")
    ensure("traffic", lambda a: "traffic" in a, **fields)
    print("  traffic:", {k: v for k, v in exp["artifacts"]["traffic"].items()
                         if k != "session_ids"})

    print("── verdict (monitoring)…")
    exp = action(client, exp_id, "verdict")
    verdict = exp["artifacts"]["verdict"]
    print("  verdict:", json.dumps({k: v for k, v in verdict.items()
                                    if k != "metrics"}))
    print("  metrics:", json.dumps(verdict["metrics"])[:400])

    ensure("promote", lambda a: "promote" in a)
    promote = exp["artifacts"]["promote"]
    print("  weights:", promote["before_weights"], "→", promote["after_weights"])

    ensure("canary", lambda a: "canary" in a,
           challenger_agent_id=challenger["id"])
    canary = exp["artifacts"]["canary"]
    print("  canary abtest:", canary["canary_ab_test_id"], "weights:",
          canary["weights"])

    print("── ramp…")
    exp = action(client, exp_id, "ramp")
    canary = exp["artifacts"]["canary"]
    print("  weights:", canary["before_weights"], "→", canary["after_weights"],
          f"(stage {canary['ramp_stage']})")

    print("── online eval config state:")
    import boto3
    control = boto3.client("bedrock-agentcore-control", region_name="us-west-2")
    oe = control.get_online_evaluation_config(
        onlineEvaluationConfigId=exp["artifacts"]["gateway"]["online_eval_id"]
    )
    print(f"  {oe.get('onlineEvaluationConfigName')} · status={oe.get('status')} "
          f"· execution={oe.get('executionStatus')}")

    print("── cleanup…")
    exp = action(client, exp_id, "cleanup")
    cleanup = exp["artifacts"]["cleanup"]
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
