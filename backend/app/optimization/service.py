"""Optimization loop orchestration (adapted from agentcore_eva_opt
routers/abtest.py + recommend.py + bundles.py — github.com/xiehust/agentcore_eva_opt).

Stepwise actions, each user-triggered (stage = furthest point completed):
    recommend → accept → bundles → gateway → abtest → traffic → verdict
    → promote | canary → ramp → cleanup
Long actions run on a daemon thread via run_action, streaming a progress
line onto the experiment row (running_action/progress) so the UI can poll
and a reload resumes mid-action. Short actions run inline in the request.

The experiment gateway is separate from launchpad-gw: AWS_IAM auth, no
protocolType, targets of type http→agentcoreRuntime so A/B routing happens
at {gatewayUrl}/{target}/invocations.
"""

import json
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.evaluation import agentcore_eval as ac
from app.evaluation.scenarios import scenario_prompts
from app.optimization.models import Experiment
from app.services.agentcore.client import control_client, data_client

EXP_GATEWAY_NAME = "launchpad-exp-gw"
TRAFFIC_PROMPTS = [
    "What is 12*9? Use the calculator tool and answer with just the number.",
    "What is 45+55? Use the calculator tool and answer with just the number.",
    "What is 144/12? Use the calculator tool and answer with just the number.",
    "What is 7*8-6? Use the calculator tool and answer with just the number.",
    "What is 15*4? Use the calculator tool and answer with just the number.",
    "What is 90/9? Use the calculator tool and answer with just the number.",
]

_sleep = time.sleep  # injectable


def _is_conflict(exc: Exception) -> bool:
    return type(exc).__name__ == "ConflictException"


def _update(exp_id: str, **fields: Any) -> None:
    db = SessionLocal()
    try:
        exp = db.get(Experiment, exp_id)
        artifacts = fields.pop("artifact", None)
        if artifacts:
            merged = dict(exp.artifacts)
            merged.update(artifacts)
            exp.artifacts = merged
        for key, value in fields.items():
            setattr(exp, key, value)
        db.commit()
    finally:
        db.close()


def _get(exp_id: str) -> Experiment:
    db = SessionLocal()
    try:
        return db.get(Experiment, exp_id)
    finally:
        db.close()


Progress = Callable[[str], None]


def _spawn(target: Callable[[], None]) -> None:  # injectable for tests
    threading.Thread(target=target, daemon=True).start()


def run_action(exp_id: str, action: str, fn: Callable[[Progress], Any]) -> None:
    """Run a stage action on a daemon thread with row-level progress.

    The wrapped fn persists its own artifact + stage on success; this runner
    only owns the running_action/progress/error lifecycle. A failure keeps
    the stage so re-POSTing the same action retries it (AWS creates are
    idempotent — conflict-adopt by name).
    """
    def progress(msg: str) -> None:
        _update(exp_id, progress=msg[:300])

    def runner() -> None:
        try:
            fn(progress)
            _update(exp_id, running_action=None, progress=None)
        except Exception as exc:
            # the action prefix lets the UI pin the failure to its button
            _update(exp_id, running_action=None, progress=None,
                    error=f"{action}: {type(exc).__name__}: {exc}"[:500])

    _update(exp_id, running_action=action, error=None)
    _spawn(runner)


def clear_stale_running_actions() -> list[str]:
    """Startup sweep: a restarted worker can't still be running an action.

    Action threads are daemons of the previous process — after a restart a
    non-null running_action is stale and would 409 every retry forever. Clear
    it and leave a retryable error so the UI shows what happened.
    """
    db = SessionLocal()
    try:
        rows = db.query(Experiment).filter(
            Experiment.running_action.isnot(None)
        ).all()
        cleared: list[str] = []
        for exp in rows:
            exp.error = (f"{exp.running_action}: interrupted by a backend "
                         "restart — retry the action")
            exp.running_action = None
            exp.progress = None
            cleared.append(exp.id)
        db.commit()
        return cleared
    finally:
        db.close()


def _agent_meta(exp: Experiment) -> dict[str, Any]:
    """Runtime facts captured at create time; rebuilt lazily for old rows."""
    meta = exp.artifacts.get("agent_meta")
    if meta:
        return meta
    from app.models.ledger import Agent  # local import — avoids cycle at module load

    db = SessionLocal()
    try:
        agent_row = db.get(Agent, exp.agent_id)
    finally:
        db.close()
    if agent_row is None:
        raise RuntimeError("agent behind this experiment no longer exists")
    control = control_client()
    meta = {
        "id": agent_row.id,
        "name": agent_row.name,
        "arn": agent_row.arn,
        "resource_id": agent_row.resource_id,
        "runtime_name": rt_name(control, agent_row.resource_id),
        "system_prompt": (agent_row.spec or {}).get("system_prompt", ""),
    }
    _update(exp.id, artifact={"agent_meta": meta})
    return meta


def _noop(_msg: str) -> None:
    pass


# ─── stage implementations ───────────────────────────────────────────────────
def stage_recommend(
    exp_id: str, agent: dict[str, Any], progress: Progress = _noop
) -> dict[str, Any]:
    settings = get_settings()
    data = data_client()
    log_group = f"/aws/bedrock-agentcore/runtimes/{agent['resource_id']}-DEFAULT"
    log_group_arns = [
        ac.to_log_group_arn(log_group, settings.region, settings.account_id),
        ac.to_log_group_arn("aws/spans", settings.region, settings.account_id),
    ]
    service_names = [f"{agent['runtime_name']}.DEFAULT"]
    current_prompt = agent["system_prompt"]

    progress("generating system-prompt recommendation from recent traces…")
    sp = ac.start_system_prompt_recommendation(
        data,
        name=f"exp_{exp_id[:8]}_sp",
        system_prompt=current_prompt,
        log_group_arns=log_group_arns,
        service_names=service_names,
    )
    sp_result = ac.poll_recommendation(
        data, recommendation_id=sp["recommendationId"], max_polls=45
    )
    sp_payload = sp_result.get("recommendationResult", {}).get(
        "systemPromptRecommendationResult", {}
    )
    sp_out = sp_payload.get("recommendedSystemPrompt", "") or _fallback_treatment_prompt(
        current_prompt
    )
    sp_explanation = sp_payload.get("explanation", "")[:600]

    tool_suggestion = {}
    try:
        progress("generating tool-description recommendation…")
        td = ac.start_tool_description_recommendation(
            data,
            name=f"exp_{exp_id[:8]}_td",
            tools=[{
                "toolName": "calculator",
                "description": "Evaluate a basic arithmetic expression",
            }],
            log_group_arns=log_group_arns,
            service_names=service_names,
        )
        td_result = ac.poll_recommendation(
            data, recommendation_id=td["recommendationId"], max_polls=30
        )
        for tool in (
            td_result.get("recommendationResult", {})
            .get("toolDescriptionRecommendationResult", {})
            .get("tools", [])
        ):
            tool_suggestion[tool.get("toolName", "calculator")] = tool.get(
                "recommendedToolDescription", ""
            )
    except Exception as exc:
        tool_suggestion = {"_error": f"{type(exc).__name__}: {exc}"[:200]}

    return {
        "system_prompt_status": sp_result.get("status"),
        "recommended_prompt": sp_out[:4000],
        "explanation": sp_explanation,
        "tool_descriptions": tool_suggestion,
    }


def _fallback_treatment_prompt(current: str) -> str:
    return (
        current
        + "\nAlways use the calculator tool for any arithmetic before answering; "
        "verify the result and reply with ONLY the final number, no punctuation."
    )


DEFAULT_TOOL_DESCS = {"calculator": "Evaluate a basic arithmetic expression"}


def create_bundle_idempotent(control: Any, **kwargs: Any) -> dict[str, Any]:
    """create_configuration_bundle with conflict-adopt — a retried bundles
    action after a partial failure must re-use the bundle it already made."""
    try:
        return ac.create_configuration_bundle(control, **kwargs)
    except Exception as exc:
        if not _is_conflict(exc):
            raise
        name = kwargs["bundle_name"]
        match = None
        token: str | None = None
        while match is None:
            page = control.list_configuration_bundles(
                **({"nextToken": token} if token else {})
            )
            match = next((b for b in page.get("bundles", [])
                          if b.get("bundleName") == name), None)
            token = page.get("nextToken")
            if match is None and not token:
                raise
        detail = control.get_configuration_bundle(bundleId=match["bundleId"])
        return {"bundleId": match["bundleId"],
                "bundleArn": match.get("bundleArn"),
                "versionId": detail.get("versionId")}


def stage_bundles(
    exp_id: str, agent: dict[str, Any], treatment_prompt: str,
    treatment_tool_descs: dict[str, str] | None = None,
) -> dict:
    control = control_client()
    current_prompt = agent["system_prompt"]
    control_bundle = create_bundle_idempotent(
        control,
        agent_arn=agent["arn"],
        bundle_name=f"exp_{exp_id[:8]}_control",
        system_prompt=current_prompt,
        tool_descriptions=DEFAULT_TOOL_DESCS,
        commit_message="control — current production config",
    )
    treatment_bundle = create_bundle_idempotent(
        control,
        agent_arn=agent["arn"],
        bundle_name=f"exp_{exp_id[:8]}_treatment",
        system_prompt=treatment_prompt,
        tool_descriptions=treatment_tool_descs or DEFAULT_TOOL_DESCS,
        commit_message="treatment — accepted recommendation",
    )
    return {
        "control": {
            "bundle_id": control_bundle.get("bundleId"),
            "arn": control_bundle.get("bundleArn"),
            "version": control_bundle.get("versionId") or "1",
        },
        "treatment": {
            "bundle_id": treatment_bundle.get("bundleId"),
            "arn": treatment_bundle.get("bundleArn"),
            "version": treatment_bundle.get("versionId") or "1",
        },
    }


def create_runtime_target_idempotent(
    control: Any, gateway_id: str, name: str, agent_arn: str
) -> str:
    try:
        target = control.create_gateway_target(
            gatewayIdentifier=gateway_id,
            name=name,
            targetConfiguration={
                "http": {"agentcoreRuntime": {"arn": agent_arn, "qualifier": "DEFAULT"}}
            },
            credentialProviderConfigurations=[{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
            clientToken=str(uuid.uuid4()),
        )
        target_id = target["targetId"]
    except Exception as exc:
        if not _is_conflict(exc):
            raise
        items = control.list_gateway_targets(gatewayIdentifier=gateway_id).get("items", [])
        target_id = next(t["targetId"] for t in items if t.get("name") == name)
    for _ in range(30):
        detail = control.get_gateway_target(gatewayIdentifier=gateway_id, targetId=target_id)
        if detail.get("status") == "READY":
            return target_id
        _sleep(5)
    raise TimeoutError(f"target {name} not READY")


def create_online_eval_idempotent(
    control: Any, *, name: str, log_group: str, service_name: str, role_arn: str
) -> dict[str, Any]:
    try:
        return control.create_online_evaluation_config(
            onlineEvaluationConfigName=name,
            description=f"Launchpad experiment online eval · {name}",
            dataSourceConfig={
                "cloudWatchLogs": {
                    "logGroupNames": [log_group],
                    "serviceNames": [service_name],
                }
            },
            evaluators=[
                {"evaluatorId": "Builtin.GoalSuccessRate"},
                {"evaluatorId": "Builtin.Helpfulness"},
            ],
            rule={
                "samplingConfig": {"samplingPercentage": 100.0},
                "sessionConfig": {"sessionTimeoutMinutes": 2},
            },
            evaluationExecutionRoleArn=role_arn,
            enableOnCreate=True,
            clientToken=str(uuid.uuid4()),
        )
    except Exception as exc:
        if not _is_conflict(exc):
            raise
        configs = control.list_online_evaluation_configs().get("onlineEvaluationConfigs", [])
        return next(
            c for c in configs if c.get("onlineEvaluationConfigName") == name
        )


def stage_gateway(
    exp_id: str, agent: dict[str, Any], progress: Progress = _noop
) -> dict[str, Any]:
    settings = get_settings()
    control = control_client()
    role_arn = settings.resources["gateway_role_arn"]
    progress("creating experiment gateway…")
    try:
        gateway = control.create_gateway(
            name=EXP_GATEWAY_NAME,
            description="Launchpad experiment gateway (A/B routing)",
            authorizerType="AWS_IAM",
            roleArn=role_arn,
            clientToken=str(uuid.uuid4()),
        )
        gateway_id = gateway["gatewayId"]
    except Exception as exc:
        if not _is_conflict(exc):
            raise
        items = control.list_gateways(maxResults=100).get("items", [])
        gateway_id = next(
            g["gatewayId"] for g in items if g.get("name") == EXP_GATEWAY_NAME
        )
    gateway_arn = gateway_url = ""
    progress("waiting for gateway READY…")
    for _ in range(30):
        detail = control.get_gateway(gatewayIdentifier=gateway_id)
        if detail.get("status") == "READY":
            gateway_arn = detail["gatewayArn"]
            gateway_url = detail["gatewayUrl"]
            break
        _sleep(5)

    target_v1 = f"exp{exp_id[:6]}v1"
    progress("creating v1 runtime target…")
    target_id = create_runtime_target_idempotent(control, gateway_id, target_v1, agent["arn"])
    log_group = f"/aws/bedrock-agentcore/runtimes/{agent['resource_id']}-DEFAULT"
    progress("creating online evaluation config…")
    online_eval = create_online_eval_idempotent(
        control,
        name=f"exp_{exp_id[:8]}_oe1",
        log_group=log_group,
        service_name=f"{agent['runtime_name']}.DEFAULT",
        role_arn=settings.resources["execution_role_arn"],
    )
    return {
        "gateway_id": gateway_id,
        "gateway_arn": gateway_arn,
        "gateway_url": gateway_url,
        "target_v1": target_v1,
        "target_id_v1": target_id,
        "online_eval_arn": online_eval.get("onlineEvaluationConfigArn"),
        "online_eval_id": online_eval.get("onlineEvaluationConfigId"),
    }


def stage_abtest(exp_id: str, gateway_art: dict, bundle_art: dict) -> dict[str, Any]:
    settings = get_settings()
    data = data_client()
    variants = ac.config_bundle_variants(
        bundle_art["control"]["arn"],
        bundle_art["control"]["version"],
        bundle_art["treatment"]["arn"],
        bundle_art["treatment"]["version"],
    )
    try:
        response = ac.create_ab_test(
            data,
            name=f"exp_{exp_id[:8]}_bundle",
            gatewayArn=gateway_art["gateway_arn"],
            roleArn=settings.resources["execution_role_arn"],
            enableOnCreate=True,
            evaluationConfig={"onlineEvaluationConfigArn": gateway_art["online_eval_arn"]},
            variants=variants,
        )
    except Exception as exc:
        if not _is_conflict(exc):
            raise
        tests = data.list_ab_tests().get("abTests", [])
        response = next(
            t for t in tests
            if t.get("name", "").lower() == f"exp_{exp_id[:8]}_bundle".lower()
        )
    return {"ab_test_id": response.get("abTestId"), "variants": variants}


def send_gateway_traffic(
    gateway_url: str, target: str, prompts: list[str],
    poster: Any = None, signer: Any = None, progress: Progress = _noop,
) -> dict[str, Any]:
    """SigV4 POST each prompt through the experiment gateway (A/B routes them)."""
    settings = get_settings()
    session = boto3.Session(region_name=settings.region)
    credentials = session.get_credentials().get_frozen_credentials()

    def default_signer(creds, region, aws_request):
        SigV4Auth(creds, "bedrock-agentcore", region).add_auth(aws_request)

    signer = signer or default_signer
    url = f"{gateway_url.rstrip('/')}/{target}/invocations"
    session_ids: list[str] = []
    failed = 0
    with httpx.Client(timeout=120) as client:
        post = poster or (lambda u, content, headers: client.post(u, content=content,
                                                                  headers=headers))
        for prompt in prompts:
            session_id = str(uuid.uuid4())
            body = json.dumps({"prompt": prompt, "sessionId": session_id})
            aws_request = AWSRequest(
                method="POST", url=url, data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id,
                },
            )
            signer(credentials, settings.region, aws_request)
            response = post(url, content=body, headers=dict(aws_request.headers))
            if response.status_code == 200:
                session_ids.append(session_id)
            else:
                failed += 1
            progress(f"sent {len(session_ids)}/{len(prompts)} ({failed} failed)")
    return {"session_ids": session_ids, "sent": len(session_ids), "failed": failed}


def compute_verdict(metrics: list[dict[str, Any]], min_n: int = 3) -> dict[str, Any]:
    """Honest small-n verdict from normalized A/B metrics."""
    if not metrics:
        return {"verdict": "insufficient-data", "reason": "no evaluator metrics yet"}
    deltas = []
    total_n = 0
    significant = False
    for metric in metrics:
        control = metric.get("control", {})
        for variant in metric.get("variants", []):
            c_mean, t_mean = control.get("mean"), variant.get("mean")
            n = (control.get("sampleSize") or 0) + (variant.get("sampleSize") or 0)
            total_n += n
            if c_mean is not None and t_mean is not None:
                deltas.append(t_mean - c_mean)
            if variant.get("isSignificant"):
                significant = True
    if not deltas:
        return {"verdict": "insufficient-data", "reason": "arms have no means yet"}
    avg_delta = sum(deltas) / len(deltas)
    if total_n < min_n * 2:
        return {"verdict": "insufficient-n", "avg_delta": round(avg_delta, 4),
                "n": total_n}
    winner = "treatment" if avg_delta > 0 else ("control" if avg_delta < 0 else "tie")
    return {
        "verdict": f"{winner}-wins" if winner != "tie" else "tie",
        "avg_delta": round(avg_delta, 4),
        "n": total_n,
        "significant": significant,
    }


# ─── stepwise actions ────────────────────────────────────────────────────────
ASYNC_ACTIONS = frozenset(
    {"recommend", "gateway", "abtest", "traffic", "verdict", "canary", "cleanup"}
)

_ACTION_PREREQS: dict[str, tuple[str, str]] = {
    # action → (artifact that must exist, reason returned on 409)
    "accept": ("recommend", "run recommend first"),
    "gateway": ("bundles", "create the bundles first"),
    "abtest": ("gateway", "create the gateway first"),
    "traffic": ("abtest", "create the A/B test first"),
    "verdict": ("traffic", "send traffic first"),
    "promote": ("verdict", "wait for the verdict first"),
    "canary": ("verdict", "wait for the verdict first"),
    "ramp": ("canary", "start the canary first"),
}


def stage_not_ready_reason(exp: Experiment, action: str) -> str | None:
    """None when the action's prerequisite artifact exists, else the reason."""
    if action == "bundles":
        rec = exp.artifacts.get("recommend") or {}
        # old auto-pipeline rows never wrote accepted_* — an existing bundles
        # artifact keeps their retry path open
        if rec.get("accepted_prompt") or "bundles" in exp.artifacts:
            return None
        return "accept a recommendation first"
    rule = _ACTION_PREREQS.get(action)
    if rule and rule[0] not in exp.artifacts:
        return rule[1]
    return None


def act_recommend(exp_id: str, progress: Progress) -> None:
    exp = _get(exp_id)
    rec = stage_recommend(exp_id, _agent_meta(exp), progress)
    prior = exp.artifacts.get("recommend") or {}
    for key in ("accepted_prompt", "accepted_tool_descriptions"):
        if key in prior:  # a re-run must not drop an earlier accept
            rec.setdefault(key, prior[key])
    _update(exp_id, stage="recommend", artifact={"recommend": rec})


def action_accept(
    exp: Experiment, prompt: str, tool_descriptions: dict[str, str] | None
) -> dict[str, Any]:
    """Persist the (possibly user-edited) recommendation; unlocks bundles."""
    rec = dict(exp.artifacts.get("recommend") or {})
    rec["accepted_prompt"] = prompt[:4000]
    if tool_descriptions:
        rec["accepted_tool_descriptions"] = {
            str(k): str(v) for k, v in tool_descriptions.items()
        }
    _update(exp.id, stage="bundles", artifact={"recommend": rec})
    return rec


def action_bundles(exp: Experiment) -> dict[str, Any]:
    rec = exp.artifacts.get("recommend") or {}
    treatment_prompt = rec.get("accepted_prompt") or rec.get("recommended_prompt") or ""
    result = stage_bundles(
        exp.id, _agent_meta(exp), treatment_prompt,
        rec.get("accepted_tool_descriptions"),
    )
    _update(exp.id, stage="bundles", artifact={"bundles": result})
    return result


def act_gateway(exp_id: str, progress: Progress) -> None:
    exp = _get(exp_id)
    result = stage_gateway(exp_id, _agent_meta(exp), progress)
    _update(exp_id, stage="gateway", artifact={"gateway": result})


def act_abtest(exp_id: str, progress: Progress) -> None:
    exp = _get(exp_id)
    progress("creating config-bundle A/B test (50/50)…")
    result = stage_abtest(exp_id, exp.artifacts["gateway"], exp.artifacts["bundles"])
    _update(exp_id, stage="abtest", artifact={"abtest": result})


def resolve_traffic_prompts(dataset: Any) -> list[str]:
    """Extract sendable prompts from an EvalDataset (legacy/predefined only)."""
    if dataset.kind == "simulated":
        raise ValueError("simulated datasets need an actor loop — pick a "
                         "predefined or legacy prompt dataset")
    prompts: list[str] = []
    for item in dataset.items or []:
        if dataset.kind == "predefined":
            # a scenario's first user turn — reuse the eval replay extractor so
            # dict inputs ({"content"|"prompt": …}, imported JSON) unwrap the
            # same way here as when the dataset is replayed for evaluation
            turn_prompts = [p for p in scenario_prompts(item) if p.strip()]
            text = turn_prompts[0] if turn_prompts else ""
        else:
            text = str(item.get("prompt") or "")
        if text.strip():
            prompts.append(text.strip())
    if not prompts:
        raise ValueError("dataset has no usable prompts")
    return prompts


def act_traffic(
    exp_id: str, prompts: list[str] | None, dataset_info: dict[str, str] | None,
    progress: Progress,
) -> None:
    exp = _get(exp_id)
    gateway = exp.artifacts["gateway"]
    result = send_gateway_traffic(
        gateway["gateway_url"], gateway["target_v1"],
        prompts if prompts is not None else TRAFFIC_PROMPTS * 2,
        progress=progress,
    )
    if dataset_info:
        result.update(dataset_info)
    _update(exp_id, stage="traffic", artifact={"traffic": result})


def act_verdict(exp_id: str, progress: Progress) -> None:
    exp = _get(exp_id)
    ab_test_id = exp.artifacts["abtest"]["ab_test_id"]
    data = data_client()
    deadline = time.time() + 900
    metrics: list[dict[str, Any]] = []
    while True:
        result = ac.get_ab_test(data, ab_test_id=ab_test_id)
        metrics = ac.normalize_ab_results(result)
        if compute_verdict(metrics)["verdict"] not in ("insufficient-data",):
            break
        if time.time() >= deadline:
            break
        progress(f"aggregating · status {result.get('executionStatus', '?')} — "
                 "results take ~10–15 min after the last session")
        _sleep(45)
    verdict = compute_verdict(metrics)
    _update(exp_id, status="ready", stage="verdict",
            artifact={"verdict": {"metrics": metrics, **verdict}})


def start_experiment(agent_row: Any) -> Experiment:
    """Create the experiment row only — every stage waits for its action."""
    control = control_client()
    agent_meta = {
        "id": agent_row.id,
        "name": agent_row.name,
        "arn": agent_row.arn,
        "resource_id": agent_row.resource_id,
        "runtime_name": rt_name(control, agent_row.resource_id),
        "system_prompt": (agent_row.spec or {}).get("system_prompt", ""),
    }
    db = SessionLocal()
    try:
        exp = Experiment(
            name=f"EXP-{agent_row.name[:20]}", agent_id=agent_row.id,
            agent_name=agent_row.name, artifacts={"agent_meta": agent_meta},
        )
        db.add(exp)
        db.commit()
        exp_id = exp.id
    finally:
        db.close()
    return _get(exp_id)


def rt_name(control: Any, runtime_id: str) -> str:
    return control.get_agent_runtime(agentRuntimeId=runtime_id)["agentRuntimeName"]


# ─── explicit actions ────────────────────────────────────────────────────────
def update_weights_with_pause(data: Any, ab_test_id: str, variants: list[dict]) -> None:
    """Weights can only change while PAUSED/NOT_STARTED — pause, update, resume.

    The pause transition is asynchronous; wait for the status to actually flip
    before touching the variants.
    """
    ab = ac.get_ab_test(data, ab_test_id=ab_test_id)
    was_running = ab.get("executionStatus") == "RUNNING"
    if was_running:
        data.update_ab_test(abTestId=ab_test_id, executionStatus="PAUSED")
        for _ in range(30):
            if ac.get_ab_test(data, ab_test_id=ab_test_id).get(
                "executionStatus"
            ) == "PAUSED":
                break
            _sleep(3)
    ac.update_ab_test_weights(data, ab_test_id=ab_test_id, variants=variants)
    if was_running:
        data.update_ab_test(abTestId=ab_test_id, executionStatus="RUNNING")


def action_promote(exp: Experiment) -> dict[str, Any]:
    """Treatment becomes the default: route 100% of traffic to it."""
    data = data_client()
    ab_test_id = exp.artifacts["abtest"]["ab_test_id"]
    before = ac.get_ab_test(data, ab_test_id=ab_test_id)
    bundles = exp.artifacts["bundles"]
    # UpdateABTest weights have a floor of 1 — "promoted" = treatment at 99%.
    variants = ac.config_bundle_variants(
        bundles["control"]["arn"], bundles["control"]["version"],
        bundles["treatment"]["arn"], bundles["treatment"]["version"],
        control_weight=1, treatment_weight=99,
    )
    update_weights_with_pause(data, ab_test_id, variants)
    after = ac.get_ab_test(data, ab_test_id=ab_test_id)
    result = {
        "before_weights": {v["name"]: v["weight"] for v in before.get("variants", [])},
        "after_weights": {v["name"]: v["weight"] for v in after.get("variants", [])},
    }
    _update(exp.id, status="promoted", stage="promote", artifact={"promote": result})
    return result


def act_canary(
    exp_id: str, challenger: dict[str, str], progress: Progress = _noop
) -> dict[str, Any]:
    """Target-based canary: add the v2 agent as a 10% challenger target.

    challenger is a plain snapshot {name, arn, resource_id} — the ORM row
    must not cross into this thread.
    """
    exp = _get(exp_id)
    settings = get_settings()
    control = control_client()
    data = data_client()
    gateway = exp.artifacts["gateway"]
    target_v2 = f"exp{exp.id[:6]}v2"
    progress("creating challenger target + waiting READY…")
    target_id_v2 = create_runtime_target_idempotent(
        control, gateway["gateway_id"], target_v2, challenger["arn"]
    )
    log_group_v2 = f"/aws/bedrock-agentcore/runtimes/{challenger['resource_id']}-DEFAULT"
    progress("creating challenger online evaluation config…")
    online_eval_v2 = create_online_eval_idempotent(
        control,
        name=f"exp_{exp.id[:8]}_oe2",
        log_group=log_group_v2,
        service_name=f"{rt_name(control, challenger['resource_id'])}.DEFAULT",
        role_arn=settings.resources["execution_role_arn"],
    )
    # only one A/B test runs per gateway — stop the bundle test first
    progress("stopping the bundle A/B test (one test per gateway)…")
    try:
        data.update_ab_test(
            abTestId=exp.artifacts["abtest"]["ab_test_id"], executionStatus="STOPPED"
        )
    except Exception:
        pass
    variants = ac.target_variants(gateway["target_v1"], target_v2)  # 90/10
    progress("creating target-routing canary A/B test (90/10)…")
    try:
        response = ac.create_ab_test(
            data,
            name=f"exp_{exp.id[:8]}_canary",
            gatewayArn=gateway["gateway_arn"],
            roleArn=settings.resources["execution_role_arn"],
            enableOnCreate=True,
            evaluationConfig={
                "perVariantOnlineEvaluationConfig": [
                    {"name": "C", "onlineEvaluationConfigArn": gateway["online_eval_arn"]},
                    {"name": "T1",
                     "onlineEvaluationConfigArn":
                         online_eval_v2.get("onlineEvaluationConfigArn")},
                ]
            },
            gatewayFilter={"targetPaths": [f"/{gateway['target_v1']}/*"]},
            variants=variants,
        )
    except Exception as exc:
        if not _is_conflict(exc):
            raise
        tests = data.list_ab_tests().get("abTests", [])
        response = next(
            t for t in tests
            if t.get("name", "").lower() == f"exp_{exp.id[:8]}_canary".lower()
        )
    result = {
        "canary_ab_test_id": response.get("abTestId"),
        "target_v2": target_v2,
        "target_id_v2": target_id_v2,
        "online_eval_id_v2": online_eval_v2.get("onlineEvaluationConfigId"),
        "challenger_agent": challenger["name"],
        "weights": {v["name"]: v["weight"] for v in variants},
        "ramp_stage": 0,
    }
    _update(exp.id, stage="canary", artifact={"canary": result})
    return result


RAMP_STEPS = [(90, 10), (50, 50), (1, 99)]  # weight floor is 1


def action_ramp(exp: Experiment) -> dict[str, Any]:
    data = data_client()
    canary = exp.artifacts["canary"]
    ab_test_id = canary["canary_ab_test_id"]
    before = ac.get_ab_test(data, ab_test_id=ab_test_id)
    next_stage = min(canary.get("ramp_stage", 0) + 1, len(RAMP_STEPS) - 1)
    weights = RAMP_STEPS[next_stage]
    variants = ac.target_variants(
        exp.artifacts["gateway"]["target_v1"],
        canary["target_v2"],
        control_weight=weights[0], treatment_weight=weights[1],
    )
    update_weights_with_pause(data, ab_test_id, variants)
    after = ac.get_ab_test(data, ab_test_id=ab_test_id)
    result = {
        **canary,
        "ramp_stage": next_stage,
        "before_weights": {v["name"]: v["weight"] for v in before.get("variants", [])},
        "after_weights": {v["name"]: v["weight"] for v in after.get("variants", [])},
    }
    _update(exp.id, stage="ramp", artifact={"canary": result})
    return result


def act_cleanup(exp_id: str, progress: Progress = _noop) -> list[dict[str, str]]:
    """Tear down experiment resources; the shared launchpad-gw is untouched."""
    exp = _get(exp_id)
    control = control_client()
    data = data_client()
    artifacts = exp.artifacts
    progress("tearing down A/B tests, online evals, bundles, gateway targets…")
    ab_ids = [a for a in [
        (artifacts.get("abtest") or {}).get("ab_test_id"),
        (artifacts.get("canary") or {}).get("canary_ab_test_id"),
    ] if a]
    # resolve online-eval ids from the live listing by name prefix — the
    # artifact id can be stale after an idempotent adopt
    prefix = f"exp_{exp.id[:8]}_"
    online_evals = [
        c["onlineEvaluationConfigId"]
        for c in control.list_online_evaluation_configs().get(
            "onlineEvaluationConfigs", []
        )
        if str(c.get("onlineEvaluationConfigName", "")).startswith(prefix)
    ]
    bundles = [b for b in [
        ((artifacts.get("bundles") or {}).get("control") or {}).get("bundle_id"),
        ((artifacts.get("bundles") or {}).get("treatment") or {}).get("bundle_id"),
    ] if b]
    gateway = artifacts.get("gateway") or {}
    targets = [t for t in [gateway.get("target_id_v1"),
                           (artifacts.get("canary") or {}).get("target_id_v2")] if t]
    results = ac.cleanup_resources(
        control, data,
        ab_test_ids=ab_ids,
        online_eval_ids=online_evals,
        bundle_ids=bundles,
        gateway_id=gateway.get("gateway_id"),
        target_ids=targets,
    )
    _update(exp.id, status="cleaned", stage="cleanup",
            artifact={"cleanup": results})
    return results
