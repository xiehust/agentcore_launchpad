"""Stepwise experiment actions — guard matrix, accept/bundles wiring,
traffic dataset resolution, runner lifecycle, old-row compatibility."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import app.optimization.service as svc
from app.core.db import SessionLocal
from app.evaluation.models import EvalDataset
from app.models.ledger import Agent
from app.optimization.models import Experiment


def _mk_exp(**kw):
    db = SessionLocal()
    exp = Experiment(
        name="EXP-t", agent_id=kw.pop("agent_id", "a1"), agent_name="agent", **kw
    )
    db.add(exp)
    db.commit()
    db.refresh(exp)
    db.close()
    return exp


def _reload(exp_id: str) -> Experiment:
    db = SessionLocal()
    try:
        return db.get(Experiment, exp_id)
    finally:
        db.close()


def _inline(monkeypatch):
    """Run action threads synchronously so tests see final state."""
    monkeypatch.setattr(svc, "_spawn", lambda target: target())


# ─── guards ──────────────────────────────────────────────────────────────────
def test_every_action_requires_its_prerequisite(client):
    exp = _mk_exp(artifacts={"agent_meta": {}})
    for action in ["accept", "bundles", "gateway", "abtest", "traffic",
                   "verdict", "promote", "canary", "ramp"]:
        res = client.post(f"/api/experiments/{exp.id}/action",
                          json={"action": action})
        assert res.status_code == 409, action
        assert res.json()["code"] == "experiment.stage_not_ready", action


def test_action_blocked_while_another_runs(client):
    exp = _mk_exp(running_action="recommend")
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "recommend"})
    assert res.status_code == 409
    assert res.json()["code"] == "experiment.action_in_flight"


def test_unknown_action_rejected(client):
    exp = _mk_exp()
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "explode"})
    assert res.status_code == 422


# ─── accept ──────────────────────────────────────────────────────────────────
def test_accept_persists_edited_config_and_unlocks_bundles(client):
    exp = _mk_exp(artifacts={"recommend": {"recommended_prompt": "rec"}})
    res = client.post(
        f"/api/experiments/{exp.id}/action",
        json={"action": "accept", "accepted_prompt": "edited",
              "accepted_tool_descriptions": {"calculator": "d2"}},
    )
    assert res.status_code == 200
    body = res.json()["experiment"]
    assert body["stage"] == "bundles"
    assert body["artifacts"]["recommend"]["accepted_prompt"] == "edited"
    assert body["artifacts"]["recommend"]["accepted_tool_descriptions"] == {
        "calculator": "d2"
    }
    # the original recommendation is retained alongside the edit
    assert body["artifacts"]["recommend"]["recommended_prompt"] == "rec"


def test_accept_defaults_to_recommended_prompt(client):
    exp = _mk_exp(artifacts={"recommend": {"recommended_prompt": "rec"}})
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "accept"})
    assert res.status_code == 200
    assert (res.json()["experiment"]["artifacts"]["recommend"]["accepted_prompt"]
            == "rec")


def test_accept_with_nothing_to_accept_is_400(client):
    exp = _mk_exp(artifacts={"recommend": {}})
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "accept"})
    assert res.status_code == 400
    assert res.json()["code"] == "experiment.accept_invalid"


def test_accept_falls_back_to_current_prompt_for_tool_only_rec(client):
    """A tool-description-only recommendation is acceptable — the treatment
    keeps the production prompt and changes only the descriptions."""
    exp = _mk_exp(artifacts={
        "agent_meta": {"system_prompt": "cur"},
        "recommend": {"tool_status": "COMPLETED",
                      "tool_descriptions": {"shell": "better"}},
    })
    res = client.post(
        f"/api/experiments/{exp.id}/action",
        json={"action": "accept",
              "accepted_tool_descriptions": {"shell": "better"}},
    )
    assert res.status_code == 200
    rec = res.json()["experiment"]["artifacts"]["recommend"]
    assert rec["accepted_prompt"] == "cur"
    assert rec["accepted_tool_descriptions"] == {"shell": "better"}


def test_recommend_rerun_preserves_prior_accept(monkeypatch):
    """Re-running recommend (retry path) must not drop an earlier accept."""
    exp = _mk_exp(artifacts={
        "agent_meta": {"arn": "arn:a", "resource_id": "r", "runtime_name": "n",
                       "system_prompt": "cur"},
        "recommend": {"recommended_prompt": "old-rec", "accepted_prompt": "kept",
                      "accepted_tool_descriptions": {"calculator": "d2"}},
    })
    monkeypatch.setattr(
        svc, "stage_recommend",
        lambda exp_id, agent, progress=svc._noop, **kw: {
            "recommended_prompt": "new-rec"},
    )
    svc.act_recommend(exp.id, svc._noop)
    rec = _reload(exp.id).artifacts["recommend"]
    assert rec["recommended_prompt"] == "new-rec"      # refreshed
    assert rec["accepted_prompt"] == "kept"            # earlier accept retained
    assert rec["accepted_tool_descriptions"] == {"calculator": "d2"}


def test_recommend_partial_rerun_keeps_other_type(monkeypatch):
    """Generating only tool descriptions must not wipe the prompt output —
    and must clear its own stale error keys."""
    exp = _mk_exp(artifacts={
        "agent_meta": {"system_prompt": "cur", "tools": {"shell": "d"}},
        "recommend": {"recommended_prompt": "sp-old", "explanation": "e",
                      "system_prompt_status": "COMPLETED",
                      "tool_status": "error", "tool_error": "Boom",
                      "tool_descriptions": {}},
    })
    monkeypatch.setattr(
        svc, "stage_recommend",
        lambda exp_id, agent, progress=svc._noop, **kw: {
            "tool_status": "COMPLETED",
            "tool_descriptions": {"shell": "better"},
            "analyzed_tools": {"shell": "d"}},
    )
    svc.act_recommend(exp.id, svc._noop, types=["tool_descriptions"])
    rec = _reload(exp.id).artifacts["recommend"]
    assert rec["recommended_prompt"] == "sp-old"       # untouched
    assert rec["tool_descriptions"] == {"shell": "better"}
    assert "tool_error" not in rec                     # stale error cleared


def test_recommend_action_passes_types_and_tools(client, monkeypatch):
    _inline(monkeypatch)
    captured: dict = {}

    def fake_stage(exp_id, agent, progress=svc._noop, types=svc.REC_TYPES,
                   tools=None):
        captured.update(types=types, tools=tools)
        return {"tool_status": "COMPLETED",
                "tool_descriptions": {"shell": "better"},
                "analyzed_tools": {"shell": "run bash"}}

    monkeypatch.setattr(svc, "stage_recommend", fake_stage)
    exp = _mk_exp(artifacts={"agent_meta": {"system_prompt": "cur",
                                            "tools": {}}})
    res = client.post(
        f"/api/experiments/{exp.id}/action",
        json={"action": "recommend",
              "recommend_types": ["tool_descriptions"],
              "recommend_tools": {"shell": "run bash"}},
    )
    assert res.status_code == 202
    assert captured["types"] == ("tool_descriptions",)
    assert captured["tools"] == {"shell": "run bash"}
    rec = _reload(exp.id).artifacts["recommend"]
    assert rec["tool_descriptions"] == {"shell": "better"}
    assert "recommended_prompt" not in rec


def test_recommend_rejects_unknown_or_empty_types(client):
    exp = _mk_exp(artifacts={"agent_meta": {"system_prompt": "cur"}})
    for bad in (["prompt"], []):
        res = client.post(f"/api/experiments/{exp.id}/action",
                          json={"action": "recommend", "recommend_types": bad})
        assert res.status_code == 422, bad


def _rec_agent(tools):
    return {"resource_id": "rid", "runtime_name": "rt", "system_prompt": "cur",
            "tools": tools}


def test_stage_recommend_runs_only_selected_types(monkeypatch):
    monkeypatch.setattr(svc, "data_client", lambda: MagicMock())
    calls: list[str] = []
    monkeypatch.setattr(
        svc.ac, "start_system_prompt_recommendation",
        lambda *a, **k: calls.append("sp") or {"recommendationId": "r1"})
    monkeypatch.setattr(
        svc.ac, "start_tool_description_recommendation",
        lambda *a, **k: calls.append("td") or {"recommendationId": "r2"})
    monkeypatch.setattr(svc.ac, "poll_recommendation", lambda *a, **k: {
        "status": "COMPLETED",
        "recommendationResult": {
            "systemPromptRecommendationResult": {
                "recommendedSystemPrompt": "better", "explanation": "x"},
            "toolDescriptionRecommendationResult": {"tools": [
                {"toolName": "shell", "recommendedToolDescription": "improved"},
                {"toolName": "noop", "recommendedToolDescription": ""}]},
        }})

    out = svc.stage_recommend("e1", _rec_agent({"shell": "old"}),
                              types=("system_prompt",))
    assert calls == ["sp"]
    assert out["recommended_prompt"] == "better"
    assert "tool_status" not in out and "tool_descriptions" not in out

    calls.clear()
    out = svc.stage_recommend("e1", _rec_agent({"shell": "old"}),
                              types=("tool_descriptions",))
    assert calls == ["td"]
    assert out["tool_descriptions"] == {"shell": "improved"}  # empty rec dropped
    assert out["analyzed_tools"] == {"shell": "old"}
    assert out["tool_status"] == "COMPLETED"
    assert "recommended_prompt" not in out


def test_stage_recommend_without_tools_short_circuits(monkeypatch):
    monkeypatch.setattr(svc, "data_client", lambda: MagicMock())

    def boom(*a, **k):
        raise AssertionError("no tools → the TD API must not be called")

    monkeypatch.setattr(svc.ac, "start_tool_description_recommendation", boom)
    out = svc.stage_recommend("e1", _rec_agent({}), types=("tool_descriptions",))
    assert out == {"analyzed_tools": {}, "tool_status": "no-tools",
                   "tool_descriptions": {}}


def test_discover_agent_tools_from_spec_and_code():
    spec = {
        "tools": [{"name": "search", "description": "Search the registry"}],
        "code": ('@tool\ndef calculator(expression: str) -> str:\n'
                 '    """Evaluate a basic arithmetic expression.\n\n'
                 '    Args:\n        expression: the math\n    """\n'
                 '    return ""\n'),
        "code_bundle": {
            "main.py": ('@tool\ndef shell(command: str, timeout: int = 300):\n'
                        '    """Execute a bash command and return the results.\n'
                        '    Args:\n        command: The bash command\n    """\n'),
            "notes.md": "no tools here",
        },
    }
    assert svc.discover_agent_tools(spec) == {
        "search": "Search the registry",
        "calculator": "Evaluate a basic arithmetic expression.",
        "shell": "Execute a bash command and return the results.",
    }
    assert svc.discover_agent_tools({}) == {}


# ─── bundles ─────────────────────────────────────────────────────────────────
def test_bundles_consume_accepted_config(client, monkeypatch):
    captured: dict = {}

    def fake_stage_bundles(exp_id, agent, treatment_prompt, treatment_tds=None):
        captured.update(prompt=treatment_prompt, tds=treatment_tds, agent=agent)
        return {"control": {"bundle_id": "b1", "arn": "arn:c", "version": "1"},
                "treatment": {"bundle_id": "b2", "arn": "arn:t", "version": "1"}}

    monkeypatch.setattr(svc, "stage_bundles", fake_stage_bundles)
    exp = _mk_exp(artifacts={
        "agent_meta": {"arn": "arn:a", "system_prompt": "cur"},
        "recommend": {"recommended_prompt": "rec", "accepted_prompt": "edited",
                      "accepted_tool_descriptions": {"calculator": "d2"}},
    })
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "bundles"})
    assert res.status_code == 200
    assert captured["prompt"] == "edited"
    assert captured["tds"] == {"calculator": "d2"}
    body = res.json()["experiment"]
    assert body["artifacts"]["bundles"]["control"]["arn"] == "arn:c"
    assert body["stage"] == "bundles"


def test_bundles_without_accept_is_blocked(client):
    exp = _mk_exp(artifacts={"recommend": {"recommended_prompt": "rec"}})
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "bundles"})
    assert res.status_code == 409
    assert res.json()["code"] == "experiment.stage_not_ready"


# ─── traffic ─────────────────────────────────────────────────────────────────
def test_resolve_traffic_prompts_kinds():
    legacy = SimpleNamespace(kind="legacy",
                             items=[{"prompt": "p1"}, {"prompt": "  "}])
    assert svc.resolve_traffic_prompts(legacy) == ["p1"]

    predefined = SimpleNamespace(
        kind="predefined",
        items=[{"turns": [{"input": "t1"}, {"input": "later"}]}, {"turns": []}],
    )
    assert svc.resolve_traffic_prompts(predefined) == ["t1"]

    # imported-JSON scenarios carry dict turn inputs — must unwrap, not str()
    dict_input = SimpleNamespace(
        kind="predefined",
        items=[{"turns": [{"input": {"content": "hi there"}}]},
               {"turns": [{"input": {"prompt": "second"}}]}],
    )
    assert svc.resolve_traffic_prompts(dict_input) == ["hi there", "second"]

    with pytest.raises(ValueError):
        svc.resolve_traffic_prompts(SimpleNamespace(kind="simulated", items=[]))
    with pytest.raises(ValueError):
        svc.resolve_traffic_prompts(SimpleNamespace(kind="legacy", items=[]))


def _traffic_ready_artifacts():
    return {"abtest": {"ab_test_id": "ab1"},
            "gateway": {"gateway_url": "https://gw", "target_v1": "t1"}}


def test_traffic_action_uses_dataset_prompts(client, monkeypatch):
    _inline(monkeypatch)
    sent: dict = {}

    def fake_send(gateway_url, target, prompts, poster=None, signer=None,
                  progress=svc._noop):
        sent.update(url=gateway_url, target=target, prompts=list(prompts))
        return {"session_ids": ["s1"], "sent": len(prompts), "failed": 0}

    monkeypatch.setattr(svc, "send_gateway_traffic", fake_send)
    db = SessionLocal()
    ds = EvalDataset(name="traffic-ds", kind="legacy", items=[{"prompt": "p1"}])
    db.add(ds)
    db.commit()
    ds_id = ds.id
    db.close()

    exp = _mk_exp(artifacts=_traffic_ready_artifacts())
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "traffic", "dataset_id": ds_id})
    assert res.status_code == 202
    assert sent["prompts"] == ["p1"]
    row = _reload(exp.id)
    assert row.running_action is None
    assert row.stage == "traffic"
    assert row.artifacts["traffic"]["dataset_name"] == "traffic-ds"
    assert row.artifacts["traffic"]["dataset_id"] == ds_id


def test_traffic_action_defaults_to_builtin_prompts(client, monkeypatch):
    _inline(monkeypatch)
    sent: dict = {}

    def fake_send(gateway_url, target, prompts, poster=None, signer=None,
                  progress=svc._noop):
        sent.update(prompts=list(prompts))
        return {"session_ids": [], "sent": len(prompts), "failed": 0}

    monkeypatch.setattr(svc, "send_gateway_traffic", fake_send)
    exp = _mk_exp(artifacts=_traffic_ready_artifacts())
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "traffic"})
    assert res.status_code == 202
    assert sent["prompts"] == svc.TRAFFIC_PROMPTS * 2
    assert "dataset_id" not in _reload(exp.id).artifacts["traffic"]


def test_traffic_rejects_simulated_and_missing_datasets(client):
    db = SessionLocal()
    ds = EvalDataset(name="sim-ds", kind="simulated",
                     items=[{"actor_profile": {}}])
    db.add(ds)
    db.commit()
    ds_id = ds.id
    db.close()

    exp = _mk_exp(artifacts=_traffic_ready_artifacts())
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "traffic", "dataset_id": ds_id})
    assert res.status_code == 422
    assert res.json()["code"] == "experiment.dataset_unsupported"

    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "traffic", "dataset_id": "nope"})
    assert res.status_code == 404


# ─── runner lifecycle ────────────────────────────────────────────────────────
def test_run_action_failure_keeps_stage_and_stores_error(monkeypatch):
    _inline(monkeypatch)
    exp = _mk_exp(stage="bundles")

    def boom(progress):
        raise RuntimeError("kaput")

    svc.run_action(exp.id, "gateway", boom)
    row = _reload(exp.id)
    assert row.running_action is None
    assert row.progress is None
    assert row.stage == "bundles"  # retry stays possible
    assert row.error.startswith("gateway: ")  # UI pins failures to the button
    assert "RuntimeError: kaput" in row.error


def test_run_action_success_clears_error_and_persists(monkeypatch):
    _inline(monkeypatch)
    exp = _mk_exp(stage="bundles", error="stale failure")
    seen: list[str] = []

    def ok(progress):
        progress("halfway")
        seen.append(_reload(exp.id).progress)
        svc._update(exp.id, stage="gateway",
                    artifact={"gateway": {"gateway_id": "g1"}})

    svc.run_action(exp.id, "gateway", ok)
    row = _reload(exp.id)
    assert seen == ["halfway"]  # progress visible to pollers mid-action
    assert row.running_action is None and row.progress is None
    assert row.error is None
    assert row.stage == "gateway"
    assert row.artifacts["gateway"]["gateway_id"] == "g1"


def test_create_bundle_idempotent_adopts_on_conflict(monkeypatch):
    """A retried bundles action must adopt the bundle a prior run created."""
    class Conflict(Exception):
        pass

    Conflict.__name__ = "ConflictException"

    def raise_conflict(control, **kwargs):
        raise Conflict("name taken")

    monkeypatch.setattr(svc.ac, "create_configuration_bundle", raise_conflict)
    control = MagicMock()
    control.list_configuration_bundles.return_value = {
        "bundles": [{"bundleName": "exp_x_control", "bundleId": "b1",
                     "bundleArn": "arn:b1"}],
    }
    control.get_configuration_bundle.return_value = {"versionId": "3"}
    out = svc.create_bundle_idempotent(
        control, agent_arn="arn:a", bundle_name="exp_x_control",
        system_prompt="p", tool_descriptions={}, commit_message="m",
    )
    assert out == {"bundleId": "b1", "bundleArn": "arn:b1", "versionId": "3"}
    control.get_configuration_bundle.assert_called_once_with(bundleId="b1")

    # unknown name → the original conflict propagates (nothing to adopt)
    control.list_configuration_bundles.return_value = {"bundles": []}
    with pytest.raises(Conflict):
        svc.create_bundle_idempotent(
            control, agent_arn="arn:a", bundle_name="exp_y_control",
            system_prompt="p", tool_descriptions={}, commit_message="m",
        )


def test_startup_sweep_clears_stale_running_actions():
    stuck = _mk_exp(running_action="recommend", progress="polling…")
    idle = _mk_exp(agent_id="a2")
    cleared = svc.clear_stale_running_actions()
    assert cleared == [stuck.id]
    row = _reload(stuck.id)
    assert row.running_action is None and row.progress is None
    assert row.error.startswith("recommend: interrupted by a backend restart")
    assert _reload(idle.id).error is None


# ─── backward compatibility (old auto-pipeline rows) ────────────────────────
def _old_pipeline_artifacts():
    return {
        "recommend": {"recommended_prompt": "rec", "explanation": "",
                      "tool_descriptions": {}},
        "bundles": {"control": {"bundle_id": "b1", "arn": "arn:c", "version": "1"},
                    "treatment": {"bundle_id": "b2", "arn": "arn:t",
                                  "version": "1"}},
        "gateway": {"gateway_id": "g1", "gateway_arn": "arn:g",
                    "gateway_url": "https://gw", "target_v1": "t1",
                    "target_id_v1": "tid1", "online_eval_arn": "arn:oe",
                    "online_eval_id": "oe1"},
        "abtest": {"ab_test_id": "ab1", "variants": []},
        "traffic": {"session_ids": ["s1"], "sent": 12, "failed": 0},
        "verdict": {"metrics": [], "verdict": "insufficient-n", "n": 4},
    }


def test_old_pipeline_row_serializes_with_new_fields(client):
    exp = _mk_exp(status="ready", stage="verdict",
                  artifacts=_old_pipeline_artifacts())
    body = client.get(f"/api/experiments/{exp.id}").json()
    assert body["running_action"] is None
    assert body["progress"] is None
    assert body["artifacts"]["verdict"]["verdict"] == "insufficient-n"


def test_old_pipeline_row_still_promotes_and_rebundles(client, monkeypatch):
    exp = _mk_exp(status="ready", stage="verdict",
                  artifacts=_old_pipeline_artifacts())
    monkeypatch.setattr(svc, "action_promote", lambda exp: {"ok": True})
    res = client.post(f"/api/experiments/{exp.id}/action",
                      json={"action": "promote"})
    assert res.status_code == 200
    # bundles retry stays open even though the row predates accepted_*
    assert svc.stage_not_ready_reason(_reload(exp.id), "bundles") is None


# ─── create defers all stage work ────────────────────────────────────────────
def test_create_defers_all_stage_work(client, monkeypatch):
    db = SessionLocal()
    agent = Agent(name="step-agent", method="zip_runtime", status="active",
                  arn="arn:rt", resource_id="rt-9",
                  spec={"system_prompt": "sys"})
    db.add(agent)
    db.commit()
    agent_id = agent.id
    db.close()

    monkeypatch.setattr(svc, "control_client", lambda: MagicMock())
    monkeypatch.setattr(svc, "rt_name", lambda control, rid: "RTName")
    res = client.post("/api/experiments", json={"agent_id": agent_id})
    assert res.status_code == 201
    body = res.json()
    assert body["stage"] == "recommend"
    assert body["running_action"] is None
    assert set(body["artifacts"]) == {"agent_meta"}
    meta = body["artifacts"]["agent_meta"]
    assert meta["runtime_name"] == "RTName"
    assert meta["system_prompt"] == "sys"
