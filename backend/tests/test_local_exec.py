"""Studio local-debug execution: SSE framing, env builder, execute endpoint
(stub interpreter), timeout kill, missing-interpreter guard."""

import asyncio
import os
import sys
import tempfile

# Isolate tests from data/launchpad.db BEFORE any app import binds the engine.
_TEST_DB = os.path.join(tempfile.mkdtemp(prefix="launchpad-test-"), "test.db")
os.environ["LAUNCHPAD_DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services import local_exec  # noqa: E402


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture
def exec_python(monkeypatch):
    """Point the exec interpreter at this test's own python (no strands needed
    for the print-only scripts these tests run)."""
    settings = get_settings()
    monkeypatch.setattr(settings, "studio_exec_python", sys.executable)
    return sys.executable


# --- chunk_to_sse framing -------------------------------------------------

def test_chunk_to_sse_single_line():
    assert local_exec.chunk_to_sse("hello") == "data: hello\n\n"


def test_chunk_to_sse_multiline_each_newline_is_empty_data_line():
    # "a\nb" -> segment a, newline (empty data), segment b
    assert local_exec.chunk_to_sse("a\nb") == "data: a\ndata: \ndata: b\n\n"


def test_chunk_to_sse_trailing_newline():
    # a chunk that ends on a newline (e.g. a read() boundary split a line)
    assert local_exec.chunk_to_sse("a\n") == "data: a\ndata: \n\n"


def test_chunk_to_sse_lone_newline():
    assert local_exec.chunk_to_sse("\n") == "data: \n\n"


def test_chunk_to_sse_empty_is_empty():
    assert local_exec.chunk_to_sse("") == ""


def test_chunk_to_sse_roundtrip_preserves_text():
    # Decode the SSE the way the frontend does (empty `data: ` line = newline)
    # and confirm the original chunk survives regardless of embedded newlines.
    chunk = "line one\nline two\n\nline four"
    sse = local_exec.chunk_to_sse(chunk)
    event = sse[: -len("\n\n")]  # strip the event terminator
    decoded = "".join(
        "\n" if line == "data: " else line[len("data: "):]
        for line in event.split("\n")
    )
    assert decoded == chunk


# --- build_execution_env --------------------------------------------------

def test_build_execution_env_sets_consent_and_region():
    env = local_exec.build_execution_env()
    assert env["BYPASS_TOOL_CONSENT"] == "true"
    assert env["STRANDS_NON_INTERACTIVE"] == "true"
    assert env["AWS_REGION"]  # region always present
    assert env["AWS_DEFAULT_REGION"] == env["AWS_REGION"]


def test_build_execution_env_injects_keys_when_given():
    env = local_exec.build_execution_env(openai_api_key="sk-x", bedrock_api_key="bk-y")
    assert env["OPENAI_API_KEY"] == "sk-x"
    assert env["BEDROCK_API_KEY"] == "bk-y"


def test_build_execution_env_omits_keys_when_absent(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("BEDROCK_API_KEY", raising=False)
    env = local_exec.build_execution_env()
    assert "OPENAI_API_KEY" not in env
    assert "BEDROCK_API_KEY" not in env


# --- /api/execute (stub interpreter) --------------------------------------

def test_execute_runs_via_configured_interpreter(client, exec_python):
    resp = client.post("/api/execute", json={"code": "print(1 + 1)"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["output"].strip() == "2"
    assert body["execution_time_ms"] >= 0


def test_execute_reports_nonzero_exit_as_failure(client, exec_python):
    resp = client.post("/api/execute", json={"code": "raise SystemExit(3)"})
    assert resp.status_code == 200
    assert resp.json()["success"] is False


def test_execute_passes_user_input(client, exec_python):
    code = (
        "import argparse\n"
        "p = argparse.ArgumentParser()\n"
        "p.add_argument('--user-input')\n"
        "a = p.parse_args()\n"
        "print('got:', a.user_input)\n"
    )
    resp = client.post("/api/execute", json={"code": code, "input_data": "hi there"})
    assert resp.json()["output"].strip() == "got: hi there"


def test_execute_stream_frames_multiline_output(client, exec_python):
    code = "print('alpha')\nprint('beta')\n"
    resp = client.post("/api/execute/stream", json={"code": code})
    assert resp.status_code == 200
    text = resp.text
    assert "data: alpha" in text
    assert "data: beta" in text
    assert "[STREAM_COMPLETE:" in text


# --- timeout + missing interpreter ---------------------------------------

def test_execute_times_out_and_kills(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "studio_exec_python", sys.executable)
    monkeypatch.setattr(settings, "execute_timeout_s", 0.5)
    with pytest.raises(RuntimeError, match="timed out"):
        asyncio.run(local_exec.execute_strands_code("import time; time.sleep(5)"))


def test_missing_interpreter_returns_503(client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "studio_exec_python", "/no/such/python-xyz")
    resp = client.post("/api/execute", json={"code": "print(1)"})
    assert resp.status_code == 503
    body = resp.json()
    assert body["code"] == "studio.exec.interpreter_unavailable"
    assert "setup_exec_env.sh" in body["message"]


def test_spawn_raises_when_interpreter_missing(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "studio_exec_python", "/no/such/python-xyz")
    with pytest.raises(local_exec.ExecInterpreterUnavailable, match="setup_exec_env.sh"):
        asyncio.run(local_exec.spawn_execution_subprocess("print(1)", None))
