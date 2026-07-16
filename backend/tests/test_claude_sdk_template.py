"""Claude SDK container template: render, build context, codebuild pipeline."""

import asyncio
import importlib.util
import py_compile
import sys
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace

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


async def collect_async(iterator):
    return [item async for item in iterator]


def test_render_replaces_placeholders():
    code = render_main_py(SPEC)
    assert "__LAUNCHPAD_" not in code
    assert "sdk-test-agent" in code
    assert "MAX_TURNS = 7" in code
    # Bedrock switch is baked into the Dockerfile env, never set in code
    assert 'os.environ["CLAUDE_CODE_USE_BEDROCK"]' not in code
    assert 'MEMORY_SHORT_TERM = "True" == "True"' in code
    assert 'MEMORY_LONG_TERM = "False" == "True"' in code
    assert "__LAUNCHPAD_" not in code


def test_render_memory_flags():
    spec = AgentSpec(
        **{
            **SPEC.model_dump(),
            "memory": {"short_term": False, "long_term": True},
        }
    )
    code = render_main_py(spec)
    assert 'MEMORY_SHORT_TERM = "False" == "True"' in code
    assert 'MEMORY_LONG_TERM = "True" == "True"' in code


def test_raw_memory_placeholders_fail_closed_for_stale_renderer():
    source = Path("app/templates/claude_sdk_agent/main.py.tmpl").read_text()
    assignments = "\n".join(
        line
        for line in source.splitlines()
        if line.startswith(("MEMORY_SHORT_TERM =", "MEMORY_LONG_TERM ="))
    )
    values: dict = {}
    exec(assignments, values)
    assert values["MEMORY_SHORT_TERM"] is False
    assert values["MEMORY_LONG_TERM"] is False


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
    # registry wins
    assert "'docs': {'type': 'http', 'url': 'https://registry.example/mcp'}" in code
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
    # no baked-in subagents: the fact-checker sample was dropped (not SDK-native)
    assert not any(f.startswith(".claude/agents/") for f in files)
    dockerfile = (ctx / "Dockerfile").read_text()
    assert "linux/arm64" in dockerfile
    assert "CLAUDE_CODE_USE_BEDROCK=1" in dockerfile
    assert "@anthropic-ai/claude-code" in dockerfile
    requirements = (ctx / "requirements.txt").read_text()
    assert "bedrock-agentcore==1.17.*" in requirements


@pytest.fixture
def rendered_memory_module(tmp_path: Path, monkeypatch):
    """Import a rendered runtime with tracing replaced by side-effect-free fakes."""
    tracing = ModuleType("tracing")

    @contextmanager
    def traced_invocation(_agent_name, _session_id):
        yield object()

    tracing.traced_invocation = traced_invocation
    tracing.record_tool_call = lambda **_kwargs: None
    tracing.record_llm_usage = lambda **_kwargs: None
    tracing.record_result = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "tracing", tracing)
    monkeypatch.setenv("LAUNCHPAD_MEMORY_ID", "memory-123")
    monkeypatch.setenv("AWS_REGION", "us-west-2")

    spec = AgentSpec(
        **{
            **SPEC.model_dump(),
            "memory": {"short_term": True, "long_term": True},
        }
    )
    target = tmp_path / "rendered_memory_main.py"
    target.write_text(render_main_py(spec), encoding="utf-8")
    module_spec = importlib.util.spec_from_file_location(
        "rendered_claude_memory_main", target
    )
    module = importlib.util.module_from_spec(module_spec)
    monkeypatch.setitem(sys.modules, module_spec.name, module)
    module_spec.loader.exec_module(module)
    return module


class FakeMemorySession:
    def __init__(self):
        self.turns = [
            [
                {"role": "USER", "content": {"text": "new question"}},
                {"role": "ASSISTANT", "content": {"text": "new answer"}},
            ],
            [
                {"role": "USER", "content": {"text": "old question"}},
                {"role": "ASSISTANT", "content": {"text": "old answer"}},
            ],
        ]
        self.search_calls: list[dict] = []
        self.saved: list[list] = []
        self.fail_reads = False
        self.fail_writes = False

    def get_last_k_turns(self, **kwargs):
        if self.fail_reads:
            raise RuntimeError("read failed with secret prompt")
        assert kwargs == {"k": 5}
        return self.turns

    def search_long_term_memories(self, **kwargs):
        if self.fail_reads:
            raise RuntimeError("read failed with secret prompt")
        self.search_calls.append(kwargs)
        namespace = kwargs["namespace"]
        if namespace.startswith("/facts/"):
            return [{"content": {"text": "customer has a standing appointment"}}]
        return [{"content": {"text": "prefers morning meetings"}}]

    def add_turns(self, *, messages):
        if self.fail_writes:
            raise RuntimeError("write failed with secret response")
        self.saved.append(messages)
        return {"eventId": "event-1"}


def _install_fake_memory_manager(module, monkeypatch):
    sessions: list[tuple[str, str, FakeMemorySession]] = []

    class FakeMemoryManager:
        def __init__(self, memory_id, region_name=None):
            assert memory_id == "memory-123"
            assert region_name == "us-west-2"

        def create_memory_session(self, *, actor_id, session_id):
            session = FakeMemorySession()
            sessions.append((actor_id, session_id, session))
            return session

    monkeypatch.setattr(module, "MemorySessionManager", FakeMemoryManager)
    return sessions


def test_memory_context_restores_history_and_long_term_records(
    rendered_memory_module, monkeypatch
):
    module = rendered_memory_module
    sessions = _install_fake_memory_manager(module, monkeypatch)
    memory = module.AgentCoreMemory("memory-123", "agent-a__river", "session-one")

    context = memory.context_for("What do you remember?")

    _, _, session = sessions[0]
    assert context.index("old question") < context.index("new question")
    assert "customer has a standing appointment" in context
    assert "prefers morning meetings" in context
    assert [call["namespace"] for call in session.search_calls] == [
        "/facts/agent-a__river",
        "/preferences/agent-a__river",
    ]
    assert all(call["query"] == "What do you remember?" for call in session.search_calls)
    assert len(context) <= module.MAX_MEMORY_CONTEXT_CHARS


def test_memory_scope_uses_exact_actor_and_session(
    rendered_memory_module, monkeypatch
):
    module = rendered_memory_module
    sessions = _install_fake_memory_manager(module, monkeypatch)

    module.AgentCoreMemory("memory-123", "agent-a__river", "session-one")
    module.AgentCoreMemory("memory-123", "agent-a__river", "session-two")
    module.AgentCoreMemory("memory-123", "agent-b__river", "session-one")

    assert [(actor, session) for actor, session, _ in sessions] == [
        ("agent-a__river", "session-one"),
        ("agent-a__river", "session-two"),
        ("agent-b__river", "session-one"),
    ]


def test_user_prompt_hook_returns_additional_context(rendered_memory_module):
    module = rendered_memory_module
    prompts: list[str] = []
    memory = SimpleNamespace(
        context_for=lambda prompt: prompts.append(prompt) or "remembered context"
    )

    result = asyncio.run(
        module._memory_hook(memory)(
            {"prompt": "original prompt"},
            None,
            {},
        )
    )

    assert prompts == ["original prompt"]
    assert result["hookSpecificOutput"] == {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "remembered context",
    }


def test_run_query_wires_request_local_memory_hook(
    rendered_memory_module, monkeypatch
):
    module = rendered_memory_module
    captured = {}
    memory = SimpleNamespace(context_for=lambda _prompt: "context")

    async def fake_query(*, prompt, options):
        captured["prompt"] = prompt
        captured["options"] = options
        if False:
            yield None

    monkeypatch.setattr(module, "query", fake_query)
    asyncio.run(module.run_query("original prompt", memory))

    assert captured["prompt"] == "original prompt"
    assert captured["options"].include_partial_messages is True
    matcher = captured["options"].hooks["UserPromptSubmit"][0]
    assert len(matcher.hooks) == 1


def test_query_events_stream_text_without_repeating_final_message(
    rendered_memory_module, monkeypatch
):
    module = rendered_memory_module
    captured = {}

    async def fake_query(*, prompt, options):
        captured.update(prompt=prompt, options=options)
        yield module.StreamEvent(
            uuid="message-1",
            session_id="session-one",
            event={
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "hello "},
            },
        )
        yield module.StreamEvent(
            uuid="message-1",
            session_id="session-one",
            event={
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "world"},
            },
        )
        yield module.AssistantMessage(
            content=[module.TextBlock(text="hello world")],
            model="test-model",
            uuid="message-1",
        )
        yield module.ResultMessage(
            subtype="success",
            duration_ms=10,
            duration_api_ms=8,
            is_error=False,
            num_turns=1,
            session_id="session-one",
            result="hello world",
        )

    monkeypatch.setattr(module, "query", fake_query)
    outcome = module.QueryOutcome()

    events = asyncio.run(collect_async(module._query_events("hello", None, outcome)))

    assert events == [
        {"event": "delta", "text": "hello "},
        {"event": "delta", "text": "world"},
    ]
    assert outcome.result == "hello world"
    assert captured["options"].include_partial_messages is True


def test_invoke_persists_completed_turn_once(rendered_memory_module, monkeypatch):
    module = rendered_memory_module
    saved: list[tuple[str, str]] = []
    memory = SimpleNamespace(save_turn=lambda prompt, response: saved.append((prompt, response)))
    monkeypatch.setattr(module, "_create_memory", lambda actor, session: memory)

    async def fake_query_events(prompt, request_memory, outcome):
        assert prompt == "hello"
        assert request_memory is memory
        outcome.result = "hello back"
        outcome.usage = {"input_tokens": 2}
        yield {"event": "delta", "text": "hello back"}

    monkeypatch.setattr(module, "_query_events", fake_query_events)
    events = asyncio.run(
        collect_async(module.invoke(
            {"prompt": "hello", "actor_id": "agent-a__river"},
            SimpleNamespace(session_id="session-one"),
        ))
    )

    assert events == [
        {"event": "delta", "text": "hello back"},
        {
            "event": "complete",
            "result": "hello back",
            "usage": {"input_tokens": 2},
        },
    ]
    assert saved == [("hello", "hello back")]


def test_save_turn_writes_one_user_assistant_event(
    rendered_memory_module, monkeypatch
):
    module = rendered_memory_module
    sessions = _install_fake_memory_manager(module, monkeypatch)
    memory = module.AgentCoreMemory("memory-123", "agent-a__river", "session-one")

    assert memory.save_turn("hello", "hello back") is True

    (messages,) = sessions[0][2].saved
    assert [(message.text, message.role) for message in messages] == [
        ("hello", module.MessageRole.USER),
        ("hello back", module.MessageRole.ASSISTANT),
    ]


def test_query_failure_does_not_persist_turn(rendered_memory_module, monkeypatch):
    module = rendered_memory_module
    saved: list[tuple[str, str]] = []
    memory = SimpleNamespace(save_turn=lambda prompt, response: saved.append((prompt, response)))
    monkeypatch.setattr(module, "_create_memory", lambda actor, session: memory)

    async def failed_query(_prompt, _memory, _outcome):
        raise RuntimeError("claude failed")
        yield

    monkeypatch.setattr(module, "_query_events", failed_query)
    with pytest.raises(RuntimeError, match="claude failed"):
        asyncio.run(
            collect_async(module.invoke(
                {"prompt": "hello", "actor_id": "agent-a__river"},
                SimpleNamespace(session_id="session-one"),
            ))
        )
    assert saved == []


def test_memory_failures_warn_without_leaking_content(
    rendered_memory_module, monkeypatch, caplog
):
    module = rendered_memory_module
    sessions = _install_fake_memory_manager(module, monkeypatch)
    memory = module.AgentCoreMemory("memory-123", "agent-a__river", "session-one")
    session = sessions[0][2]
    session.fail_reads = True

    assert memory.context_for("secret prompt") == ""
    session.fail_writes = True
    assert memory.save_turn("secret prompt", "secret response") is False

    assert "short-term retrieval failed for session session-one" in caplog.text
    assert "long-term retrieval failed for session session-one" in caplog.text
    assert "persistence failed for session session-one" in caplog.text
    assert "secret prompt" not in caplog.text
    assert "secret response" not in caplog.text


def test_memory_disabled_or_missing_actor_skips_manager(
    rendered_memory_module, monkeypatch
):
    module = rendered_memory_module

    class UnexpectedManager:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("memory manager should not be created")

    monkeypatch.setattr(module, "MemorySessionManager", UnexpectedManager)
    monkeypatch.setattr(module, "MEMORY_SHORT_TERM", False)
    monkeypatch.setattr(module, "MEMORY_LONG_TERM", False)
    assert module._create_memory("agent-a__river", "session-one") is None

    monkeypatch.setattr(module, "MEMORY_SHORT_TERM", True)
    assert module._create_memory("", "session-one") is None
    monkeypatch.setattr(module, "MEMORY_ID", "")
    assert module._create_memory("agent-a__river", "session-one") is None


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
