"""Harness method: payload mapping, deploy/poll happy + failure paths, invoke."""

import pytest

from app.deployer.harness import build_create_params
from app.schemas.agent import AgentSpec
from app.services.agentcore import harness as hc

MEM_ARN = "arn:aws:bedrock-agentcore:us-west-2:111:memory/launchpad_memory-x"
ROLE_ARN = "arn:aws:iam::111:role/launchpad-agent-execution-role"


def spec(**over):
    base = {
        "name": "hr-assistant-v3",
        "method": "harness",
        "system_prompt": "You are an HR assistant.",
    }
    base.update(over)
    return AgentSpec(**base)


def test_build_params_basics():
    params = build_create_params(spec(), ROLE_ARN, MEM_ARN)
    assert params["harnessName"] == "hr_assistant_v3"  # hyphens not allowed
    assert params["executionRoleArn"] == ROLE_ARN
    assert params["model"]["bedrockModelConfig"]["modelId"] == "global.anthropic.claude-sonnet-4-6"
    assert params["systemPrompt"] == [{"text": "You are an HR assistant."}]
    assert params["memory"] == {"agentCoreMemoryConfiguration": {"arn": MEM_ARN}}


def test_build_params_tools_skills_env_no_memory():
    s = spec(
        tools=[
            {"type": "builtin", "name": "code-interpreter"},
            {"type": "builtin", "name": "browser"},
            {"type": "gateway", "name": "hr-database"},  # ignored until phase 6
        ],
        skills=["skills/expense-report-writer"],
        env={"FOO": "bar"},
        memory={"short_term": False, "long_term": False},
    )
    params = build_create_params(s, ROLE_ARN, MEM_ARN)
    assert params["tools"] == [
        {"type": "agentcore_code_interpreter", "name": "code-interpreter"},
        {"type": "agentcore_browser", "name": "browser"},
    ]
    assert params["skills"] == [{"path": "skills/expense-report-writer"}]
    assert params["environmentVariables"] == {"FOO": "bar"}
    assert "memory" not in params


class StubControl:
    """Captures create kwargs; walks a scripted status sequence on get."""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.created_with = None
        self.deleted = []

    def create_harness(self, **kwargs):
        self.created_with = kwargs
        return {"harness": {"harnessId": "h-123", "arn": "arn:h-123", "status": "CREATING"}}

    def get_harness(self, harnessId):
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return {
            "harness": {
                "harnessId": harnessId,
                "arn": "arn:h-123",
                "status": status,
                "harnessVersion": "1",
                "failureReason": "role cannot be assumed" if "FAILED" in status else None,
            }
        }


def test_wait_ready_polls_to_ready():
    stub = StubControl(["CREATING", "CREATING", "READY"])
    sleeps = []
    harness = hc.wait_harness_ready(stub, "h-123", sleeper=sleeps.append)
    assert harness["status"] == "READY"
    assert len(sleeps) == 2


def test_wait_ready_raises_on_create_failed():
    stub = StubControl(["CREATING", "CREATE_FAILED"])
    with pytest.raises(RuntimeError, match="CREATE_FAILED.*role cannot be assumed"):
        hc.wait_harness_ready(stub, "h-123", sleeper=lambda _: None)


def test_wait_ready_times_out():
    stub = StubControl(["CREATING"])
    with pytest.raises(TimeoutError):
        hc.wait_harness_ready(stub, "h-123", timeout_s=0, sleeper=lambda _: None)


class StubData:
    def __init__(self, events):
        self.events = events
        self.invoked_with = None

    def invoke_harness(self, **kwargs):
        self.invoked_with = kwargs
        return {"stream": iter(self.events)}


def test_invoke_harness_text_concatenates_stream():
    stub = StubData(
        [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"delta": {"text": "2+2 "}}},
            {"contentBlockDelta": {"delta": {"text": "= 4"}}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )
    result = hc.invoke_harness_text(stub, "arn:h-123", "what is 2+2?")
    assert result["text"] == "2+2 = 4"
    assert len(result["session_id"]) >= 33
    assert stub.invoked_with["messages"] == [
        {"role": "user", "content": [{"text": "what is 2+2?"}]}
    ]


def test_invoke_harness_text_surfaces_runtime_error():
    stub = StubData([{"runtimeClientError": {"message": "boom"}}])
    with pytest.raises(RuntimeError, match="runtime client error"):
        hc.invoke_harness_text(stub, "arn:h-123", "hi")
