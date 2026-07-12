"""Claude SDK container template: render, build context, codebuild pipeline."""

import py_compile
from pathlib import Path

import pytest

from app.schemas.agent import AgentSpec
from app.services.agentcore import codebuild as cb
from app.services.agentcore import runtime as rt
from app.templates.claude_sdk_agent import assemble_build_context, render_main_py

SPEC = AgentSpec(
    name="sdk-test-agent",
    method="container",
    system_prompt="You are a container test agent.",
    max_iterations=7,
)


def test_render_replaces_placeholders():
    code = render_main_py(SPEC)
    assert "__LAUNCHPAD_" not in code
    assert "sdk-test-agent" in code
    assert "MAX_TURNS = 7" in code
    # Bedrock switch is baked into the Dockerfile env, never set in code
    assert 'os.environ["CLAUDE_CODE_USE_BEDROCK"]' not in code


def test_render_parses_mcp_servers_from_env():
    spec = SPEC.model_copy(
        update={"env": {"LAUNCHPAD_MCP_SERVERS": '{"docs": {"command": "uvx", "args": ["x"]}}'}}
    )
    code = render_main_py(spec)
    assert "'docs'" in code and "'uvx'" in code
    # every configured server is allow-listed with Claude Code's mcp__ prefix
    assert "'mcp__docs'" in code


def test_render_default_allowed_tools():
    code = render_main_py(SPEC)
    assert "ALLOWED_TOOLS: list[str] = ['Task']" in code


def test_render_skills_enable_skill_tool():
    spec = SPEC.model_copy(update={"skills": ["s3://bkt/skills/web-analyzer/"]})
    code = render_main_py(spec)
    assert "ALLOWED_TOOLS: list[str] = ['Task', 'Skill']" in code


def test_render_merges_registry_mcp_over_free_text():
    """Registry-selected servers (spec.tools mcp refs) merge into MCP_SERVERS and
    win over a same-named free-text entry; both get mcp__ allow-list entries."""
    spec = AgentSpec(
        **{
            **SPEC.model_dump(),
            "tools": [
                {"type": "mcp", "name": "deepwiki", "config": {"url": "https://mcp.deepwiki.com/mcp"}},
                {"type": "mcp", "name": "docs", "config": {"url": "https://registry.example/mcp"}},
            ],
            "env": {"LAUNCHPAD_MCP_SERVERS": '{"docs": {"command": "uvx", "args": ["x"]}}'},
        }
    )
    code = render_main_py(spec)
    assert "'deepwiki': {'type': 'http', 'url': 'https://mcp.deepwiki.com/mcp'}" in code
    assert "'docs': {'type': 'http', 'url': 'https://registry.example/mcp'}" in code  # registry wins
    assert "'mcp__deepwiki'" in code and "'mcp__docs'" in code
    assert "'uvx'" not in code  # the shadowed free-text entry is gone


def test_render_tolerates_bad_mcp_json():
    spec = SPEC.model_copy(update={"env": {"LAUNCHPAD_MCP_SERVERS": "{not json"}})
    code = render_main_py(spec)
    assert "MCP_SERVERS: dict[str, Any] = {}" in code
    assert "ALLOWED_TOOLS: list[str] = ['Task']" in code


def test_rendered_main_compiles(tmp_path: Path):
    target = tmp_path / "main.py"
    target.write_text(render_main_py(SPEC), encoding="utf-8")
    py_compile.compile(str(target), doraise=True)


def test_rendered_main_emits_manual_telemetry():
    """The SDK's LLM/tool work happens in the claude CLI subprocess, invisible
    to ADOT — the generated agent must emit the gen_ai telemetry itself."""
    code = render_main_py(SPEC)
    assert "tracing.traced_invocation" in code
    assert "tracing.record_tool_call" in code
    assert "tracing.record_llm_usage" in code
    assert "tracing.record_result" in code


def test_tracing_module_compiles_and_uses_eval_scope(tmp_path: Path):
    src = Path("app/templates/claude_sdk_agent/tracing.py")
    py_compile.compile(str(src), cfile=str(tmp_path / "tracing.pyc"), doraise=True)
    text = src.read_text(encoding="utf-8")
    # Evaluations only parse spans/events from supported instrumentation scopes.
    assert 'EVAL_SCOPE = "strands.telemetry.tracer"' in text
    # cache token attr names follow the aws/spans convention the console sums
    assert "gen_ai.usage.cache_write_input_tokens" in text


def test_assemble_build_context(tmp_path: Path):
    ctx = assemble_build_context(SPEC, tmp_path / "ctx")
    files = {str(p.relative_to(ctx)) for p in ctx.rglob("*") if p.is_file()}
    assert {"Dockerfile", "requirements.txt", "buildspec.yml", "main.py",
            "tracing.py"} <= files
    assert ".claude/agents/fact-checker.md" in files
    dockerfile = (ctx / "Dockerfile").read_text()
    assert "linux/arm64" in dockerfile
    assert "CLAUDE_CODE_USE_BEDROCK=1" in dockerfile
    assert "@anthropic-ai/claude-code" in dockerfile


class StubCodeBuild:
    def __init__(self, phases_then_status):
        self.script = list(phases_then_status)
        self.started_with = None

    def start_build(self, **kwargs):
        self.started_with = kwargs
        return {"build": {"id": "launchpad-agent-builder:abc123"}}

    def batch_get_builds(self, ids):
        phase, status = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        return {
            "builds": [
                {
                    "id": ids[0],
                    "currentPhase": phase,
                    "buildStatus": status,
                    "phases": [
                        {
                            "phaseType": "BUILD",
                            "phaseStatus": "FAILED" if status == "FAILED" else "SUCCEEDED",
                            "contexts": [{"message": "docker build exited 1"}],
                        }
                    ],
                }
            ]
        }


def test_start_image_build_payload():
    stub = StubCodeBuild([("SUBMITTED", "IN_PROGRESS")])
    build_id = cb.start_image_build(
        stub,
        project="launchpad-agent-builder",
        s3_bucket="bkt",
        s3_key="builds/a/source.zip",
        region="us-west-2",
        ecr_registry="111.dkr.ecr.us-west-2.amazonaws.com",
        ecr_repo="launchpad-agents",
        image_tag="a-v1",
    )
    assert build_id == "launchpad-agent-builder:abc123"
    assert stub.started_with["sourceLocationOverride"] == "bkt/builds/a/source.zip"
    env = {e["name"]: e["value"] for e in stub.started_with["environmentVariablesOverride"]}
    assert env["IMAGE_TAG"] == "a-v1"
    assert env["ECR_REPO"] == "launchpad-agents"


def test_wait_build_streams_phases_to_succeeded():
    stub = StubCodeBuild(
        [
            ("SUBMITTED", "IN_PROGRESS"),
            ("PRE_BUILD", "IN_PROGRESS"),
            ("BUILD", "IN_PROGRESS"),
            ("COMPLETED", "SUCCEEDED"),
        ]
    )
    phases: list[str] = []
    build = cb.wait_build(stub, "b-1", sleeper=lambda _: None, on_phase=phases.append)
    assert build["buildStatus"] == "SUCCEEDED"
    assert phases == ["SUBMITTED", "PRE_BUILD", "BUILD", "COMPLETED"]


def test_wait_build_raises_on_failed_with_context():
    stub = StubCodeBuild([("BUILD", "IN_PROGRESS"), ("COMPLETED", "FAILED")])
    with pytest.raises(RuntimeError, match="docker build exited 1"):
        cb.wait_build(stub, "b-1", sleeper=lambda _: None)


class StubControl:
    def __init__(self):
        self.created_with = None

    def create_agent_runtime(self, **kwargs):
        self.created_with = kwargs
        return {"agentRuntimeId": "rt-c1", "agentRuntimeArn": "arn:rt-c1", "status": "CREATING"}


def test_create_container_runtime_payload():
    stub = StubControl()
    rt.create_container_runtime(
        stub,
        runtime_name="sdk_test_abc123",
        container_uri="111.dkr.ecr.us-west-2.amazonaws.com/launchpad-agents:a-v1",
        role_arn="arn:role",
    )
    artifact = stub.created_with["agentRuntimeArtifact"]
    assert artifact == {
        "containerConfiguration": {
            "containerUri": "111.dkr.ecr.us-west-2.amazonaws.com/launchpad-agents:a-v1"
        }
    }
