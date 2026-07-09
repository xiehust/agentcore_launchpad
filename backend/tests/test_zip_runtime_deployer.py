"""Zip builder + runtime deployer with mocked pip / boto3."""

import zipfile
from pathlib import Path

import pytest

from app.deployer.zip_runtime import build_zip, sanitize_runtime_name
from app.services.agentcore import runtime as rt


class FakePipResult:
    returncode = 0
    stderr = ""


def fake_pip_ok(cmd, **kwargs):
    # simulate pip by dropping a fake dependency tree into the target dir
    target = Path(cmd[cmd.index("-t") + 1])
    (target / "strands").mkdir(parents=True, exist_ok=True)
    (target / "strands" / "__init__.py").write_text("")
    (target / "aws_opentelemetry_distro").mkdir(exist_ok=True)
    (target / "aws_opentelemetry_distro" / "__init__.py").write_text("")
    fake_pip_ok.last_cmd = cmd
    return FakePipResult()


def test_build_zip_contains_expected_files(tmp_path: Path):
    zip_path = build_zip(
        "print('agent')",
        ["strands-agents[otel]>=1.0,<2", "aws-opentelemetry-distro>=0.10,<1"],
        tmp_path / "build",
        pip_runner=fake_pip_ok,
    )
    names = zipfile.ZipFile(zip_path).namelist()
    assert "main.py" in names
    assert "requirements.txt" in names
    assert any(n.startswith("strands/") for n in names)
    assert any(n.startswith("aws_opentelemetry_distro/") for n in names)
    # ARM64 reproducibility flags
    cmd = fake_pip_ok.last_cmd
    assert "--platform" in cmd and "manylinux2014_aarch64" in cmd
    assert "--only-binary=:all:" in cmd


def test_build_zip_raises_with_pip_stderr(tmp_path: Path):
    class Failed:
        returncode = 1
        stderr = "ERROR: no matching distribution for nonexistent-package-xyz"

    with pytest.raises(RuntimeError, match="nonexistent-package-xyz"):
        build_zip(
            "code",
            ["nonexistent-package-xyz"],
            tmp_path / "b",
            pip_runner=lambda *a, **k: Failed(),
        )


def test_sanitize_runtime_name():
    name = sanitize_runtime_name("hr-assistant v2!")
    assert name.startswith("hr_assistant_v2")
    assert len(name.rsplit("_", 1)[-1]) == 6  # uniqueness suffix


class StubRuntimeControl:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.created_with = None
        self.deleted = []

    def create_agent_runtime(self, **kwargs):
        self.created_with = kwargs
        return {
            "agentRuntimeId": "rt-1",
            "agentRuntimeArn": "arn:rt-1",
            "agentRuntimeVersion": "1",
            "status": "CREATING",
        }

    def get_agent_runtime(self, agentRuntimeId):
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return {
            "agentRuntimeId": agentRuntimeId,
            "agentRuntimeArn": "arn:rt-1",
            "agentRuntimeVersion": "1",
            "status": status,
            "failureReason": "image pull failure" if "FAILED" in status else None,
        }


def test_create_code_runtime_payload():
    stub = StubRuntimeControl(["READY"])
    rt.create_code_runtime(
        stub,
        runtime_name="agent_abc123",
        s3_bucket="bkt",
        s3_key="agents/a/pkg.zip",
        role_arn="arn:role",
        environment={"FOO": "1"},
    )
    cfg = stub.created_with["agentRuntimeArtifact"]["codeConfiguration"]
    assert cfg["code"]["s3"] == {"bucket": "bkt", "prefix": "agents/a/pkg.zip"}
    assert cfg["runtime"] == "PYTHON_3_13"
    assert cfg["entryPoint"] == ["opentelemetry-instrument", "main.py"]
    assert stub.created_with["environmentVariables"] == {"FOO": "1"}
    assert stub.created_with["networkConfiguration"] == {"networkMode": "PUBLIC"}


def test_wait_runtime_ready_and_failure():
    ok = StubRuntimeControl(["CREATING", "CREATING", "READY"])
    statuses: list[str] = []
    detail = rt.wait_runtime_ready(ok, "rt-1", sleeper=lambda _: None, on_status=statuses.append)
    assert detail["status"] == "READY"
    assert statuses == ["CREATING", "READY"]

    bad = StubRuntimeControl(["CREATE_FAILED"])
    with pytest.raises(RuntimeError, match="image pull failure"):
        rt.wait_runtime_ready(bad, "rt-1", sleeper=lambda _: None)


class StubDataPlane:
    def __init__(self, body: bytes):
        self.body = body
        self.invoked_with = None

    def invoke_agent_runtime(self, **kwargs):
        self.invoked_with = kwargs

        class Reader:
            def __init__(self, data):
                self._data = data

            def read(self):
                return self._data

        return {"response": Reader(self.body), "contentType": "application/json"}


def test_invoke_runtime_text_parses_result():
    stub = StubDataPlane(b'{"result": "the answer is 4"}')
    out = rt.invoke_runtime_text(stub, "arn:rt-1", "2+2?")
    assert out["text"] == "the answer is 4"
    assert len(out["session_id"]) >= 33
    import json

    payload = json.loads(stub.invoked_with["payload"])
    assert payload["prompt"] == "2+2?"


def test_invoke_runtime_text_surfaces_error():
    stub = StubDataPlane(b'{"error": "payload must include a non-empty prompt"}')
    with pytest.raises(RuntimeError, match="non-empty"):
        rt.invoke_runtime_text(stub, "arn:rt-1", "x")
