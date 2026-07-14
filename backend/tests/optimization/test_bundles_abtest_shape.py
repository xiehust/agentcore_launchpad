"""Bundle + A/B payload shapes — adapted from agentcore_eva_opt
tests/test_eval_recommend_shape.py and test_target_ab_setup.py."""

from unittest.mock import MagicMock

from app.evaluation import agentcore_eval as ac


def test_configuration_bundle_payload():
    client = MagicMock()
    ac.create_configuration_bundle(
        client,
        agent_arn="arn:rt-1",
        bundle_name="exp_x_control",
        system_prompt="be terse",
        tool_descriptions={"calculator": "does math"},
        commit_message="control",
    )
    kwargs = client.create_configuration_bundle.call_args.kwargs
    assert kwargs["bundleName"] == "exp_x_control"
    config = kwargs["components"]["arn:rt-1"]["configuration"]
    assert config["system_prompt"] == "be terse"
    assert config["tools"] == {"calculator": {"description": "does math"}}
    assert "tool_descriptions" not in config
    assert len(kwargs["clientToken"]) >= 33


def test_config_bundle_variants_50_50():
    variants = ac.config_bundle_variants("arn:c", "1", "arn:t", "1")
    assert [v["weight"] for v in variants] == [50, 50]
    assert variants[0]["variantConfiguration"]["configurationBundle"]["bundleArn"] == "arn:c"
    assert variants[1]["name"] == "T1"


def test_target_variants_canary_90_10():
    variants = ac.target_variants("v1", "v2")
    assert [v["weight"] for v in variants] == [90, 10]
    assert variants[0]["variantConfiguration"]["target"]["name"] == "v1"
    assert variants[1]["variantConfiguration"]["target"]["name"] == "v2"


def test_normalize_ab_results_shape():
    result = {
        "results": {
            "evaluatorMetrics": [
                {
                    "evaluatorArn": "arn:aws:bedrock-agentcore:::evaluator/Builtin.Helpfulness",
                    "controlStats": {"name": "C", "mean": 0.82, "sampleSize": 6},
                    "variantResults": [
                        {"name": "T1", "mean": 0.91, "sampleSize": 6,
                         "pValue": 0.03, "isSignificant": True}
                    ],
                }
            ]
        }
    }
    metrics = ac.normalize_ab_results(result)
    assert metrics[0]["label"] == "Builtin.Helpfulness"
    assert metrics[0]["control"]["mean"] == 0.82
    assert metrics[0]["variants"][0]["isSignificant"] is True
