"""Independent Runtime Canary records, guards, actions, and resource ownership."""

from unittest.mock import MagicMock

import pytest

import app.optimization.canary_service as canary_svc
import app.optimization.service as exp_svc
from app.core.db import SessionLocal
from app.core.errors import AppError
from app.models.ledger import Agent
from app.optimization.models import Experiment, RuntimeCanary

RUNTIME_ARN = (
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
    "runtime/runtime_agent-abcdefghij"
)


def _agent(
    name: str,
    *,
    method: str = "zip_runtime",
    status: str = "active",
    spec: dict | None = None,
    arn: str | None = RUNTIME_ARN,
) -> Agent:
    return Agent(
        name=name,
        method=method,
        status=status,
        arn=arn,
        resource_id=f"{name}-abcdefghij",
        spec=spec or {"protocol": "http"},
    )


def _persist_agents(*agents: Agent) -> list[str]:
    db = SessionLocal()
    try:
        db.add_all(agents)
        db.commit()
        return [agent.id for agent in agents]
    finally:
        db.close()


def _mk_canary(
    *,
    status: str = "running",
    stage: str = "setup",
    artifacts: dict | None = None,
) -> RuntimeCanary:
    db = SessionLocal()
    try:
        row = RuntimeCanary(
            name="CANARY-a-b",
            champion_agent_id="a1",
            champion_agent_name="a",
            challenger_agent_id="a2",
            challenger_agent_name="b",
            status=status,
            stage=stage,
            artifacts=artifacts or {
                "champion_meta": {},
                "challenger_meta": {},
                "rounds": [],
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    finally:
        db.close()


def _reload(canary_id: str) -> RuntimeCanary:
    db = SessionLocal()
    try:
        return db.get(RuntimeCanary, canary_id)
    finally:
        db.close()


def _setup_artifact(ramp_stage: int = 0) -> dict:
    control_weight, treatment_weight = canary_svc.RAMP_WEIGHTS[ramp_stage]
    return {
        "gateway_id": "gw-1",
        "gateway_arn": "arn:gateway",
        "gateway_url": "https://gateway.example",
        "test_name": "can_test_target",
        "ab_test_id": "ab-1",
        "champion": {
            "target_name": "cancontrol",
            "target_id": "target-c",
            "online_eval_id": "oe-c",
            "online_eval_arn": "arn:oe-c",
        },
        "challenger": {
            "target_name": "cantreatment",
            "target_id": "target-t",
            "online_eval_id": "oe-t",
            "online_eval_arn": "arn:oe-t",
        },
        "ramp_stage": ramp_stage,
        "weights": {"C": control_weight, "T1": treatment_weight},
    }


def _round(
    ramp_stage: int,
    *,
    verdict: dict | None = None,
    baseline_n: int = 0,
) -> dict:
    result = {
        "ramp_stage": ramp_stage,
        "weights": {},
        "traffic_attempts": [{"baseline_n": baseline_n, "sent": 12, "failed": 0}],
    }
    if verdict is not None:
        result["verdict"] = verdict
    return result


def test_create_runtime_canary_persists_separate_record(client, monkeypatch):
    champion_id, challenger_id = _persist_agents(
        _agent("champion"), _agent("challenger", method="container")
    )
    control = MagicMock()
    control.get_agent_runtime.side_effect = lambda agentRuntimeId: {
        "agentRuntimeName": f"runtime-{agentRuntimeId}"
    }
    monkeypatch.setattr(canary_svc, "control_client", lambda: control)

    res = client.post(
        "/api/runtime-canaries",
        json={
            "champion_agent_id": champion_id,
            "challenger_agent_id": challenger_id,
        },
    )

    assert res.status_code == 201
    body = res.json()
    assert body["champion_agent_id"] == champion_id
    assert body["challenger_agent_id"] == challenger_id
    assert body["stage"] == "setup"
    assert body["artifacts"]["rounds"] == []
    assert client.get("/api/runtime-canaries").json()["canaries"][0]["id"] == body["id"]
    db = SessionLocal()
    try:
        assert db.query(Experiment).count() == 0
        assert db.query(RuntimeCanary).count() == 1
    finally:
        db.close()


@pytest.mark.parametrize(
    ("champion", "challenger", "code"),
    [
        (_agent("inactive", status="failed"), _agent("good"), "canary.agent_not_active"),
        (
            _agent("harness", method="harness", arn="arn:harness/x"),
            _agent("good"),
            "canary.agent_unsupported",
        ),
        (
            _agent("a2a", spec={"protocol": "a2a"}),
            _agent("good"),
            "canary.agent_unsupported",
        ),
    ],
)
def test_create_rejects_incompatible_agents(client, champion, challenger, code):
    champion_id, challenger_id = _persist_agents(champion, challenger)
    res = client.post(
        "/api/runtime-canaries",
        json={
            "champion_agent_id": champion_id,
            "challenger_agent_id": challenger_id,
        },
    )
    assert res.status_code == 400
    assert res.json()["code"] == code


def test_create_rejects_same_agent(client):
    (agent_id,) = _persist_agents(_agent("same"))
    res = client.post(
        "/api/runtime-canaries",
        json={"champion_agent_id": agent_id, "challenger_agent_id": agent_id},
    )
    assert res.status_code == 400
    assert res.json()["code"] == "canary.same_agent"


def test_source_experiment_must_match_promoted_champion(client, monkeypatch):
    champion_id, challenger_id = _persist_agents(
        _agent("champion"), _agent("challenger")
    )
    db = SessionLocal()
    try:
        source = Experiment(
            name="EXP-source",
            agent_id="someone-else",
            agent_name="other",
            status="promoted",
            stage="promote",
            artifacts={
                "promote": {
                    "deployment_id": "d1",
                    "ab_test_status": "STOPPED",
                }
            },
        )
        db.add(source)
        db.commit()
        source_id = source.id
    finally:
        db.close()
    monkeypatch.setattr(canary_svc, "control_client", MagicMock)

    res = client.post(
        "/api/runtime-canaries",
        json={
            "champion_agent_id": champion_id,
            "challenger_agent_id": challenger_id,
            "source_experiment_id": source_id,
        },
    )
    assert res.status_code == 400
    assert res.json()["code"] == "canary.source_champion_mismatch"


def test_promoted_experiment_can_handoff_to_separate_canary(client, monkeypatch):
    champion_id, challenger_id = _persist_agents(
        _agent("champion"), _agent("challenger")
    )
    db = SessionLocal()
    try:
        source = Experiment(
            name="EXP-source",
            agent_id=champion_id,
            agent_name="champion",
            status="promoted",
            stage="promote",
            artifacts={
                "promote": {
                    "deployment_id": "d1",
                    "ab_test_status": "STOPPED",
                }
            },
        )
        db.add(source)
        db.commit()
        source_id = source.id
    finally:
        db.close()
    control = MagicMock()
    control.get_agent_runtime.side_effect = lambda agentRuntimeId: {
        "agentRuntimeName": f"runtime-{agentRuntimeId}"
    }
    monkeypatch.setattr(canary_svc, "control_client", lambda: control)

    res = client.post(
        "/api/runtime-canaries",
        json={
            "champion_agent_id": champion_id,
            "challenger_agent_id": challenger_id,
            "source_experiment_id": source_id,
        },
    )

    assert res.status_code == 201
    body = res.json()
    assert body["source_experiment_id"] == source_id
    assert body["champion_agent_id"] == champion_id
    assert body["artifacts"]["champion_meta"]["id"] == champion_id


def test_setup_rejects_foreign_active_gateway_test_before_dispatch(
    client, monkeypatch,
):
    row = _mk_canary()
    control = MagicMock()
    control.list_gateways.return_value = {
        "items": [{"name": exp_svc.EXP_GATEWAY_NAME, "gatewayId": "gw-1"}]
    }
    control.get_gateway.return_value = {
        "gatewayId": "gw-1",
        "gatewayArn": "arn:gateway",
        "gatewayUrl": "https://gateway.example",
        "status": "READY",
    }
    data = MagicMock()
    data.list_ab_tests.return_value = {
        "abTests": [
            {
                "abTestId": "foreign",
                "name": "other-test",
                "gatewayArn": "arn:gateway",
                "executionStatus": "RUNNING",
            }
        ]
    }
    monkeypatch.setattr(exp_svc, "control_client", lambda: control)
    monkeypatch.setattr(exp_svc, "data_client", lambda: data)
    dispatched: list[str] = []
    monkeypatch.setattr(
        canary_svc,
        "run_action",
        lambda canary_id, action, fn: dispatched.append(action),
    )

    res = client.post(
        f"/api/runtime-canaries/{row.id}/action",
        json={"action": "setup"},
    )
    assert res.status_code == 409
    assert res.json()["code"] == "experiment.gateway_busy"
    assert dispatched == []


def test_setup_action_dispatches_after_read_only_preflight(client, monkeypatch):
    row = _mk_canary()
    monkeypatch.setattr(canary_svc, "assert_setup_available", lambda canary_id: None)
    dispatched: list[str] = []
    monkeypatch.setattr(
        canary_svc,
        "run_action",
        lambda canary_id, action, fn: dispatched.append(action),
    )
    res = client.post(
        f"/api/runtime-canaries/{row.id}/action",
        json={"action": "setup"},
    )
    assert res.status_code == 202
    assert dispatched == ["setup"]


def test_setup_creates_two_targets_evaluators_and_own_ab_test(monkeypatch):
    row = _mk_canary(
        artifacts={
            "champion_meta": {
                "arn": "arn:champion",
                "resource_id": "champion-id",
                "runtime_name": "ChampionRuntime",
            },
            "challenger_meta": {
                "arn": "arn:challenger",
                "resource_id": "challenger-id",
                "runtime_name": "ChallengerRuntime",
            },
            "rounds": [],
        }
    )
    monkeypatch.setattr(
        exp_svc,
        "ensure_experiment_gateway",
        lambda progress, control: {
            "gateway_id": "gw-1",
            "gateway_arn": "arn:gateway",
            "gateway_url": "https://gateway.example",
        },
    )
    checks: list[str] = []
    monkeypatch.setattr(
        exp_svc,
        "assert_gateway_available",
        lambda gateway_arn, **kwargs: checks.append(gateway_arn),
    )
    monkeypatch.setattr(
        exp_svc,
        "create_runtime_target_idempotent",
        lambda control, gateway_id, name, arn: f"id-{name}",
    )
    monkeypatch.setattr(
        exp_svc,
        "create_online_eval_idempotent",
        lambda control, **kwargs: {
            "onlineEvaluationConfigId": f"id-{kwargs['name']}",
            "onlineEvaluationConfigArn": f"arn:{kwargs['name']}",
        },
    )
    data = MagicMock()
    data.create_ab_test.return_value = {"abTestId": "ab-canary"}
    monkeypatch.setattr(canary_svc, "data_client", lambda: data)
    monkeypatch.setattr(canary_svc, "control_client", MagicMock)

    result = canary_svc.act_setup(row.id, lambda message: None)

    assert result["ab_test_id"] == "ab-canary"
    assert result["weights"] == {"C": 90, "T1": 10}
    assert result["champion"]["target_id"].startswith("id-can")
    assert result["challenger"]["target_id"].startswith("id-can")
    assert checks == ["arn:gateway", "arn:gateway"]
    stored = _reload(row.id)
    assert stored.artifacts["setup"]["ramp_stage"] == 0


def test_setup_retry_adopts_its_own_ab_test_after_conflict(monkeypatch):
    row = _mk_canary(
        artifacts={
            "champion_meta": {
                "arn": "arn:champion",
                "resource_id": "champion-id",
                "runtime_name": "ChampionRuntime",
            },
            "challenger_meta": {
                "arn": "arn:challenger",
                "resource_id": "challenger-id",
                "runtime_name": "ChallengerRuntime",
            },
            "rounds": [],
        }
    )
    monkeypatch.setattr(
        exp_svc,
        "ensure_experiment_gateway",
        lambda progress, control: {
            "gateway_id": "gw-1",
            "gateway_arn": "arn:gateway",
            "gateway_url": "https://gateway.example",
        },
    )
    monkeypatch.setattr(
        exp_svc,
        "assert_gateway_available",
        lambda gateway_arn, **kwargs: None,
    )
    monkeypatch.setattr(
        exp_svc,
        "create_runtime_target_idempotent",
        lambda control, gateway_id, name, arn: f"id-{name}",
    )
    monkeypatch.setattr(
        exp_svc,
        "create_online_eval_idempotent",
        lambda control, **kwargs: {
            "onlineEvaluationConfigId": f"id-{kwargs['name']}",
            "onlineEvaluationConfigArn": f"arn:{kwargs['name']}",
        },
    )

    class ConflictException(Exception):
        pass

    data = MagicMock()
    data.create_ab_test.side_effect = ConflictException("already exists")
    data.list_ab_tests.return_value = {
        "abTests": [
            {
                "abTestId": "ab-adopted",
                "name": f"can_{row.id[:8]}_target",
                "gatewayArn": "arn:gateway",
                "executionStatus": "RUNNING",
            }
        ]
    }
    monkeypatch.setattr(canary_svc, "data_client", lambda: data)
    monkeypatch.setattr(canary_svc, "control_client", MagicMock)

    result = canary_svc.act_setup(row.id, lambda message: None)

    assert result["ab_test_id"] == "ab-adopted"
    assert _reload(row.id).artifacts["setup"]["test_name"] == (
        f"can_{row.id[:8]}_target"
    )


@pytest.mark.parametrize(
    ("verdict", "allow_override", "error_code"),
    [
        ({"verdict": "treatment-wins", "significant": True}, False, None),
        (
            {"verdict": "treatment-wins", "significant": False},
            False,
            "canary.override_required",
        ),
        ({"verdict": "tie", "significant": False}, False, "canary.override_required"),
        (
            {"verdict": "control-wins", "significant": False},
            True,
            "canary.verdict_blocked",
        ),
        ({"verdict": "insufficient-n"}, True, "canary.verdict_blocked"),
    ],
)
def test_verdict_gate(verdict, allow_override, error_code):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(),
            "rounds": [_round(0, verdict=verdict)],
        }
    )
    if error_code is None:
        canary_svc.assert_verdict_allows(
            row, allow_non_significant=allow_override
        )
        return
    with pytest.raises(AppError) as exc:
        canary_svc.assert_verdict_allows(
            row, allow_non_significant=allow_override
        )
    assert exc.value.code == error_code


def test_non_significant_verdict_allows_explicit_override():
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(),
            "rounds": [
                _round(
                    0,
                    verdict={
                        "verdict": "treatment-wins",
                        "significant": False,
                    },
                )
            ],
        }
    )
    canary_svc.assert_verdict_allows(row, allow_non_significant=True)


def test_advance_requires_current_stage_traffic_and_verdict():
    row = _mk_canary(artifacts={"setup": _setup_artifact(), "rounds": []})
    assert canary_svc.stage_not_ready_reason(row, "verdict") == (
        "send traffic at the current weights first"
    )
    assert canary_svc.stage_not_ready_reason(row, "advance") == (
        "record a verdict at the current weights first"
    )


def test_new_ramp_stage_cannot_reuse_prior_round_evidence():
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(ramp_stage=1),
            "rounds": [
                _round(
                    0,
                    verdict={"verdict": "treatment-wins", "significant": True},
                )
            ],
        }
    )

    assert canary_svc.stage_not_ready_reason(row, "verdict") == (
        "send traffic at the current weights first"
    )
    assert canary_svc.stage_not_ready_reason(row, "advance") == (
        "record a verdict at the current weights first"
    )


def test_final_stage_must_complete_instead_of_advance(client):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(ramp_stage=2),
            "rounds": [
                _round(
                    2,
                    verdict={"verdict": "treatment-wins", "significant": True},
                )
            ],
        }
    )

    res = client.post(
        f"/api/runtime-canaries/{row.id}/action",
        json={"action": "advance"},
    )

    assert res.status_code == 409
    assert res.json()["code"] == "canary.stage_not_ready"


def test_complete_requires_final_stage(client):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(ramp_stage=1),
            "rounds": [
                _round(
                    1,
                    verdict={"verdict": "treatment-wins", "significant": True},
                )
            ],
        }
    )

    res = client.post(
        f"/api/runtime-canaries/{row.id}/action",
        json={"action": "complete"},
    )

    assert res.status_code == 409
    assert res.json()["code"] == "canary.stage_not_ready"


def test_traffic_records_metric_baseline_and_clears_prior_verdict(monkeypatch):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(),
            "rounds": [
                _round(
                    0,
                    verdict={"verdict": "treatment-wins", "significant": True},
                )
            ],
        }
    )
    data = MagicMock()
    data.get_ab_test.return_value = {
        "results": {
            "evaluatorMetrics": [
                {
                    "evaluatorArn": "arn:evaluator",
                    "controlStats": {"mean": 0.5, "sampleSize": 2},
                    "variantResults": [
                        {"name": "T1", "mean": 0.7, "sampleSize": 3}
                    ],
                }
            ]
        }
    }
    monkeypatch.setattr(canary_svc, "data_client", lambda: data)
    monkeypatch.setattr(
        exp_svc,
        "send_gateway_traffic",
        lambda *args, **kwargs: {
            "session_ids": ["s1"],
            "sent": 1,
            "failed": 0,
        },
    )

    result = canary_svc.act_traffic(
        row.id, ["prompt"], {"dataset_id": "d1"}, lambda message: None
    )

    assert result["baseline_n"] == 5
    stored_round = _reload(row.id).artifacts["rounds"][0]
    assert "verdict" not in stored_round
    assert stored_round["traffic_attempts"][-1]["dataset_id"] == "d1"


def test_verdict_waits_for_sample_growth_and_persists_current_round(monkeypatch):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(),
            "rounds": [_round(0, baseline_n=5)],
        }
    )
    data = MagicMock()
    data.get_ab_test.return_value = {
        "executionStatus": "RUNNING",
        "results": {
            "evaluatorMetrics": [
                {
                    "evaluatorArn": "arn:evaluator",
                    "controlStats": {"mean": 0.5, "sampleSize": 3},
                    "variantResults": [
                        {
                            "name": "T1",
                            "mean": 0.8,
                            "sampleSize": 4,
                            "isSignificant": True,
                        }
                    ],
                }
            ]
        },
    }
    monkeypatch.setattr(canary_svc, "data_client", lambda: data)

    verdict = canary_svc.act_verdict(row.id, lambda message: None)

    assert verdict["verdict"] == "treatment-wins"
    assert verdict["n"] == 7
    assert verdict["baseline_n"] == 5
    assert _reload(row.id).artifacts["rounds"][0]["verdict"]["n"] == 7


def test_advance_updates_only_canary_ab_weights(monkeypatch):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(),
            "rounds": [
                _round(
                    0,
                    verdict={"verdict": "treatment-wins", "significant": True},
                )
            ],
        }
    )
    captured: dict = {}
    monkeypatch.setattr(canary_svc, "data_client", MagicMock)
    monkeypatch.setattr(
        exp_svc,
        "update_weights_with_pause",
        lambda data, ab_test_id, variants: captured.update(
            ab_test_id=ab_test_id, variants=variants
        ),
    )

    result = canary_svc.act_advance(
        row.id, lambda message: None, allow_non_significant=False
    )

    assert result == {"ramp_stage": 1, "weights": {"C": 50, "T1": 50}}
    assert captured["ab_test_id"] == "ab-1"
    assert [variant["weight"] for variant in captured["variants"]] == [50, 50]


def test_complete_stops_canary_ab_test_and_records_experimental_result(monkeypatch):
    row = _mk_canary(
        artifacts={
            "setup": _setup_artifact(ramp_stage=2),
            "rounds": [
                _round(
                    2,
                    verdict={"verdict": "treatment-wins", "significant": True},
                )
            ],
        }
    )
    captured: dict = {}
    monkeypatch.setattr(canary_svc, "data_client", MagicMock)
    monkeypatch.setattr(
        exp_svc,
        "_stop_ab_test",
        lambda data, ab_test_id, progress, **kwargs: (
            captured.update(ab_test_id=ab_test_id, **kwargs)
            or {"executionStatus": "STOPPED"}
        ),
    )

    result = canary_svc.act_complete(
        row.id, lambda message: None, allow_non_significant=False
    )

    assert captured == {
        "ab_test_id": "ab-1",
        "label": "Runtime canary A/B test",
    }
    assert result["experimental_only"] is True
    stored = _reload(row.id)
    assert stored.status == "completed"
    assert stored.artifacts["complete"]["ab_test_status"] == "STOPPED"


def test_rollback_stops_canary_ab_test_and_keeps_champion(monkeypatch):
    row = _mk_canary(
        artifacts={"setup": _setup_artifact(), "rounds": []}
    )
    captured: dict = {}
    monkeypatch.setattr(canary_svc, "data_client", MagicMock)
    monkeypatch.setattr(
        exp_svc,
        "_stop_ab_test",
        lambda data, ab_test_id, progress, **kwargs: (
            captured.update(ab_test_id=ab_test_id, **kwargs)
            or {"executionStatus": "STOPPED"}
        ),
    )

    result = canary_svc.act_rollback(row.id, lambda message: None)

    assert captured["ab_test_id"] == "ab-1"
    assert result["winner"] == "champion"
    assert result["experimental_only"] is True
    assert _reload(row.id).status == "rolled_back"


def test_cleanup_never_deletes_shared_gateway(monkeypatch):
    row = _mk_canary(artifacts={"setup": _setup_artifact(), "rounds": []})
    monkeypatch.setattr(
        canary_svc,
        "_owned_resources",
        lambda row, control, data: (
            "gw-1",
            ["target-c", "target-t"],
            ["oe-c", "oe-t"],
            ["ab-1"],
        ),
    )
    monkeypatch.setattr(exp_svc, "_stop_ab_test", lambda *args, **kwargs: {})
    captured: dict = {}

    def fake_cleanup(control, data, **kwargs):
        captured.update(kwargs)
        return [{"category": "abtest:ab-1", "status": "deleted", "detail": ""}]

    monkeypatch.setattr(canary_svc.ac, "cleanup_resources", fake_cleanup)
    monkeypatch.setattr(canary_svc, "control_client", MagicMock)
    monkeypatch.setattr(canary_svc, "data_client", MagicMock)

    canary_svc.act_cleanup(row.id, lambda message: None)

    assert captured["delete_gateway"] is False
    assert captured["gateway_id"] == "gw-1"
    assert _reload(row.id).status == "cleaned"


def test_clear_stale_canary_actions_is_retryable():
    row = _mk_canary()
    db = SessionLocal()
    try:
        stored = db.get(RuntimeCanary, row.id)
        stored.running_action = "traffic"
        stored.progress = "sending"
        db.commit()
    finally:
        db.close()

    assert canary_svc.clear_stale_running_actions() == [row.id]
    stored = _reload(row.id)
    assert stored.running_action is None
    assert stored.progress is None
    assert stored.error.startswith("traffic: interrupted")
