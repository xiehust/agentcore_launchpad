"""Weights ramp + cleanup fan-out — adapted from agentcore_eva_opt
tests/test_weights_pause_resume.py and cleanup shapes."""

from unittest.mock import MagicMock

from app.evaluation import agentcore_eval as ac
from app.optimization.service import RAMP_STEPS, compute_verdict


def test_update_weights_payload():
    client = MagicMock()
    variants = ac.target_variants("v1", "v2", control_weight=50, treatment_weight=50)
    ac.update_ab_test_weights(client, ab_test_id="ab-1", variants=variants)
    kwargs = client.update_ab_test.call_args.kwargs
    assert kwargs["abTestId"] == "ab-1"
    assert [v["weight"] for v in kwargs["variants"]] == [50, 50]


def test_ramp_steps_progression():
    assert RAMP_STEPS == [(90, 10), (50, 50), (1, 99)]  # service weight floor is 1


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
