"""Harness → runtime conversion: graft anchors, env discovery, requirements
flattening, bundle packaging, and the /convert endpoint contract."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import app.routers.agents as agents_router
import app.services.harness_convert as hc
from app.core.db import SessionLocal
from app.deployer.zip_runtime import write_bundle_files
from app.models.ledger import Agent
from app.schemas.agent import AgentSpec

FIXTURES = Path(__file__).parent / "fixtures"
MAIN_PY = (FIXTURES / "harness_export_main.py").read_text()
PYPROJECT = (FIXTURES / "harness_export_pyproject.toml").read_text()


# ─── graft ───────────────────────────────────────────────────────────────────
def test_graft_inserts_bundle_contract_on_real_export():
    grafted = hc.graft_config_bundle(MAIN_PY)
    assert "def resolve_system_prompt()" in grafted
    assert "system_prompt=resolve_system_prompt()" in grafted
    assert "system_prompt=DEFAULT_SYSTEM_PROMPT" not in grafted
    # the baked default remains the fallback
    assert "DEFAULT_SYSTEM_PROMPT = " in grafted
    # helpers land AFTER the constant, BEFORE its first use
    assert grafted.index("def resolve_system_prompt") < grafted.index(
        "system_prompt=resolve_system_prompt()"
    )
    assert grafted.count("def resolve_system_prompt") == 1


def test_graft_fails_without_anchors():
    with pytest.raises(hc.ConversionError, match="DEFAULT_SYSTEM_PROMPT constant"):
        hc.graft_config_bundle("print('no anchors here')")
    # constant present but construction site missing
    partial = 'DEFAULT_SYSTEM_PROMPT = """x"""\nagent = Agent()'
    with pytest.raises(hc.ConversionError, match="construction site"):
        hc.graft_config_bundle(partial)


# ─── env discovery ───────────────────────────────────────────────────────────
def test_discover_env_wires_memory_not_gateway(monkeypatch):
    monkeypatch.setattr(
        hc, "get_settings",
        lambda: SimpleNamespace(resources={"memory_id": "launchpad_memory-XYZ"}),
    )
    files = {
        "memory/session.py":
            'MEMORY_ID = os.getenv("MEMORY_MEMORY_LAUNCHPAD_MEMORY_HURAGN3ENF_ID")\n'
            'REGION = os.getenv("AWS_REGION")',
        "mcp_client/client.py":
            'url = os.environ.get("GATEWAY_GATEWAY_LAUNCHPAD_KB_GW_PMYQ7MCHUM_URL")',
    }
    env = hc.discover_env(files)
    assert env["MEMORY_MEMORY_LAUNCHPAD_MEMORY_HURAGN3ENF_ID"] == "launchpad_memory-XYZ"
    assert env["GATEWAY_GATEWAY_LAUNCHPAD_KB_GW_PMYQ7MCHUM_URL"] is None
    assert "AWS_REGION" not in env  # runtime-provided


# ─── requirements flattening ────────────────────────────────────────────────
def test_flatten_requirements_dedupes_against_base_pins():
    files = {"pyproject.toml": PYPROJECT}
    base = ["bedrock-agentcore==1.17.*", "strands-agents==1.15.*", "boto3"]
    extras = hc.flatten_requirements(files, base)
    names = {e.split(">=")[0].split("[")[0].strip().lower() for e in extras}
    # base-pinned packages are excluded; export-only ones remain
    assert "bedrock-agentcore" not in names
    assert "strands-agents" not in names
    assert "mcp" in names
    assert "aws-opentelemetry-distro" in names


# ─── spec + packaging ────────────────────────────────────────────────────────
def _source_agent():
    return SimpleNamespace(
        id="src1", name="aurora-support",
        arn="arn:aws:bedrock-agentcore:us-west-2:1:harness/aurora_support-X",
        spec={"system_prompt": "You are the Aurora Deck support assistant.",
              "memory": {"short_term": True, "long_term": False}},
    )


def test_build_conversion_spec_shape(monkeypatch):
    monkeypatch.setattr(
        hc, "get_settings",
        lambda: SimpleNamespace(resources={"memory_id": "mem-1"}),
    )
    files = {"main.py": MAIN_PY, "pyproject.toml": PYPROJECT,
             "mcp_client/client.py":
                 'url = os.environ.get("GATEWAY_GATEWAY_X_URL")'}
    spec = hc.build_conversion_spec(
        _source_agent(), files, ["bedrock-agentcore==1.17.*"], "aurora-support-rt",
    )
    assert spec.method == "zip_runtime"
    assert spec.code_bundle and "main.py" in spec.code_bundle
    assert "pyproject.toml" not in spec.code_bundle  # not runtime source
    assert "resolve_system_prompt()" in spec.code_bundle["main.py"]
    assert spec.source_harness["agent_name"] == "aurora-support"
    assert spec.conversion_notes["system_prompt"].startswith("wired")
    assert spec.conversion_notes["kb_gateway"].startswith("not wired")
    assert "GATEWAY_GATEWAY_X_URL" not in spec.env  # never wired in v1


def test_code_bundle_validation():
    base = {"name": "x-agent", "method": "zip_runtime", "system_prompt": "p"}
    with pytest.raises(ValueError, match="main.py"):
        AgentSpec(**base, code_bundle={"other.py": "x"})
    with pytest.raises(ValueError, match="safe relative"):
        AgentSpec(**base, code_bundle={"main.py": "x", "../evil.py": "x"})
    with pytest.raises(ValueError, match="mutually exclusive"):
        AgentSpec(**base, code="single", code_bundle={"main.py": "x"})
    ok = AgentSpec(**base, code_bundle={"main.py": "x", "pkg/mod.py": "y"})
    assert ok.code_bundle["pkg/mod.py"] == "y"


def test_write_bundle_files_stages_subpackages(tmp_path):
    spec = AgentSpec(
        name="x-agent", method="zip_runtime", system_prompt="p",
        code_bundle={"main.py": "entry", "mcp_client/client.py": "mcp",
                     "memory/session.py": "mem"},
    )
    count = write_bundle_files(spec, tmp_path)
    assert count == 2  # main.py is the deployer's job
    assert (tmp_path / "mcp_client" / "client.py").read_text() == "mcp"
    assert (tmp_path / "memory" / "session.py").read_text() == "mem"
    assert not (tmp_path / "main.py").exists()


# ─── endpoint contract ──────────────────────────────────────────────────────
def _mk_agent(**kw):
    db = SessionLocal()
    agent = Agent(**{"name": "h-src", "method": "harness", "status": "active",
                     "arn": "arn:h", "spec": {"system_prompt": "sp"}, **kw})
    db.add(agent)
    db.commit()
    db.refresh(agent)
    db.close()
    return agent


def test_convert_rejects_non_harness_and_inactive(client):
    runtime_agent = _mk_agent(name="rt-src", method="zip_runtime")
    res = client.post(f"/api/agents/{runtime_agent.id}/convert")
    assert res.status_code == 400
    assert res.json()["code"] == "agent.convert_unsupported"

    inactive = _mk_agent(name="h-off", status="stopped")
    res = client.post(f"/api/agents/{inactive.id}/convert")
    assert res.status_code == 400


def test_convert_happy_path_and_in_flight_guard(client, monkeypatch):
    source = _mk_agent(name="aurora-support")
    monkeypatch.setattr(
        hc, "export_harness",
        lambda arn: {"main.py": MAIN_PY, "pyproject.toml": PYPROJECT},
    )
    monkeypatch.setattr(
        hc, "get_settings",
        lambda: SimpleNamespace(resources={"memory_id": "mem-1"}),
    )
    started: list[str] = []
    monkeypatch.setattr(agents_router, "start_deploy_async",
                        lambda job_id: started.append(job_id))

    res = client.post(f"/api/agents/{source.id}/convert")
    assert res.status_code == 202
    body = res.json()["agent"]
    assert body["name"] == "aurora-support-rt"
    assert body["method"] == "zip_runtime"
    assert body["status"] == "deploying"
    assert body["spec"]["source_harness"]["agent_id"] == source.id
    assert "resolve_system_prompt()" in body["spec"]["code_bundle"]["main.py"]
    assert started, "deploy job must be kicked"

    # same source, conversion still deploying → 409
    res = client.post(f"/api/agents/{source.id}/convert")
    assert res.status_code == 409
    assert res.json()["code"] == "agent.convert_in_flight"


def test_convert_name_dedupe(client, monkeypatch):
    source = _mk_agent(name="hr-assistant")
    _mk_agent(name="hr-assistant-rt", method="zip_runtime")  # name taken (active)
    monkeypatch.setattr(hc, "export_harness",
                        lambda arn: {"main.py": MAIN_PY})
    monkeypatch.setattr(agents_router, "start_deploy_async", lambda job_id: None)
    res = client.post(f"/api/agents/{source.id}/convert")
    assert res.status_code == 202
    assert res.json()["agent"]["name"] == "hr-assistant-rt-2"


def test_convert_graft_failure_is_clean(client, monkeypatch):
    source = _mk_agent(name="h-graftless")
    monkeypatch.setattr(hc, "export_harness",
                        lambda arn: {"main.py": "print('no anchors')"})
    res = client.post(f"/api/agents/{source.id}/convert")
    assert res.status_code == 502
    assert res.json()["code"] == "agent.convert_failed"
    db = SessionLocal()
    leftovers = db.query(Agent).filter(Agent.name.like("h-graftless-rt%")).all()
    db.close()
    assert leftovers == []  # no half-registered row (A2)


def test_flatten_sse_text_joins_deltas_and_raises_on_error():
    from app.services.agentcore.runtime import flatten_sse_text

    sse = (
        'data: {"event": {"messageStart": {"role": "assistant"}}}\n\n'
        'data: {"event": {"contentBlockDelta": {"delta": {"text": "Aurora "}}}}\n\n'
        'data: {"event": {"contentBlockDelta": {"delta": {"text": "Deck"}}}}\n\n'
    )
    assert flatten_sse_text(sse) == "Aurora Deck"
    assert flatten_sse_text('{"result": "plain json"}') is None
    assert flatten_sse_text("") is None
    with pytest.raises(RuntimeError, match="boom"):
        flatten_sse_text('data: {"event": {"runtimeClientError": "boom"}}\n')


def test_last_json_skips_update_notice():
    out = json.dumps({"success": True, "agentPath": "/x"}) + \
        "\n\nUpdate available: 0.21.1 → 0.24.0\n"
    # update notice AFTER the json — reversed scan still finds the object
    assert hc._last_json(out)["success"] is True
