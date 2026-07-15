"""Weights ramp + cleanup fan-out — adapted from agentcore_eva_opt
tests/test_weights_pause_resume.py and cleanup shapes."""

from unittest.mock import MagicMock

from app.evaluation import agentcore_eval as ac
from app.optimization.canary_service import RAMP_WEIGHTS
from app.optimization.service import compute_verdict


def test_update_weights_payload():
    client = MagicMock()
    variants = ac.target_variants("v1", "v2", control_weight=50, treatment_weight=50)
    ac.update_ab_test_weights(client, ab_test_id="ab-1", variants=variants)
    kwargs = client.update_ab_test.call_args.kwargs
    assert kwargs["abTestId"] == "ab-1"
    assert [v["weight"] for v in kwargs["variants"]] == [50, 50]


def test_ramp_steps_progression():
    assert RAMP_WEIGHTS == ((90, 10), (50, 50), (1, 99))


def test_cleanup_resources_tolerates_failures():
    control, data = MagicMock(), MagicMock()
    control.delete_configuration_bundle.side_effect = [None, RuntimeError("gone")]
    results = ac.cleanup_resources(
        control, data,
        ab_test_ids=["ab-1"],
        online_eval_ids=["oe-1"],
        bundle_ids=["b-1", "b-2"],
    )
    by_cat = {r["category"]: r["status"] for r in results}
    assert by_cat["abtest:ab-1"] == "deleted"
    assert by_cat["online-eval:oe-1"] == "deleted"
    assert by_cat["bundle:b-1"] == "deleted"
    assert by_cat["bundle:b-2"] == "skipped"  # per-category tolerance


def test_cleanup_retries_transient_dependency_delete(monkeypatch):
    """An online-eval / gateway delete rejected while the async A/B-test delete
    is still propagating must be RETRIED, not leaked (real-AWS e2e finding)."""
    monkeypatch.setattr(ac, "_sleep", lambda *_a, **_k: None)
    control, data = MagicMock(), MagicMock()
    control.delete_online_evaluation_config.side_effect = [
        RuntimeError("still referenced by ab test"),
        RuntimeError("still referenced by ab test"),
        None,
    ]
    control.list_gateway_targets.return_value = {"items": []}
    control.get_gateway.return_value = {"gatewayArn": "arn:gw"}
    data.list_ab_tests.return_value = {"abTests": []}  # drained
    control.delete_gateway.side_effect = [RuntimeError("gateway busy"), None]
    results = ac.cleanup_resources(
        control, data,
        online_eval_ids=["oe-1"], gateway_id="gw-1", delete_gateway=True,
    )
    by_cat = {r["category"]: r["status"] for r in results}
    assert by_cat["online-eval:oe-1"] == "deleted"
    assert control.delete_online_evaluation_config.call_count == 3
    assert by_cat["gateway"] == "deleted"
    assert control.delete_gateway.call_count == 2


def test_cleanup_treats_not_found_as_deleted(monkeypatch):
    """A resource already gone (NotFound) is success, not a skipped leak."""
    monkeypatch.setattr(ac, "_sleep", lambda *_a, **_k: None)
    control, data = MagicMock(), MagicMock()

    class ResourceNotFoundException(Exception):
        pass

    control.delete_online_evaluation_config.side_effect = ResourceNotFoundException("gone")
    results = ac.cleanup_resources(control, data, online_eval_ids=["oe-1"])
    by_cat = {r["category"]: r["status"] for r in results}
    assert by_cat["online-eval:oe-1"] == "deleted"
    assert control.delete_online_evaluation_config.call_count == 1  # no wasted retries


def test_cleanup_can_keep_shared_gateway_while_deleting_targets():
    control, data = MagicMock(), MagicMock()
    ac.cleanup_resources(
        control,
        data,
        gateway_id="gw-shared",
        target_ids=["t1", "t2"],
        delete_gateway=False,
    )
    assert control.delete_gateway_target.call_count == 2
    control.delete_gateway.assert_not_called()


def test_verdict_honest_about_small_n():
    assert compute_verdict([])["verdict"] == "insufficient-data"
    tiny = [{
        "control": {"mean": 0.8, "sampleSize": 1},
        "variants": [{"mean": 0.9, "sampleSize": 1}],
    }]
    assert compute_verdict(tiny)["verdict"] == "insufficient-n"
    enough = [{
        "control": {"mean": 0.8, "sampleSize": 6},
        "variants": [{"mean": 0.9, "sampleSize": 6, "isSignificant": True}],
    }]
    verdict = compute_verdict(enough)
    assert verdict["verdict"] == "treatment-wins" and verdict["significant"] is True
