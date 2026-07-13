"""Harness → runtime conversion: export via the agentcore CLI, graft the
launchpad config-bundle contract, and materialize an AgentSpec code_bundle.

Why the graft is mandatory: the exported main.py bakes DEFAULT_SYSTEM_PROMPT
as a constant and never reads get_config_bundle() — deployed as-is, config-
bundle A/B experiments would no-op exactly as they do against the managed
harness (the trap this feature exists to remove). A conversion whose graft
anchors are missing FAILS instead of shipping a silently non-A/B-able agent.

KB/gateway MCP env is deliberately NOT wired in v1: the exported client
crashes at import when the gateway URL is set but the M2M token fetch fails,
and the new runtime's access to the identity provider is unverified. The
exported code no-ops cleanly when the URL env is absent.
"""

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR, get_settings
from app.core.errors import AppError
from app.schemas.agent import AgentSpec, MemoryConfig

EXPORT_TIMEOUT_S = 120
SCRATCH_PROJECT = "harnessexport"
_SCRATCH_DIR = DATA_DIR / "harness-export"

# deterministic codegen anchors of the pinned CLI (0.21.x)
_PROMPT_CONST_RE = re.compile(
    r'^DEFAULT_SYSTEM_PROMPT\s*=\s*(?:"""|\'\'\')', re.MULTILINE
)
_PROMPT_USE = "system_prompt=DEFAULT_SYSTEM_PROMPT"
_ENV_KEY_RE = re.compile(r'os\.(?:environ\.get|getenv)\(\s*["\']([A-Z0-9_]+)["\']')

BUNDLE_GRAFT = '''

# ─── Launchpad platform contract: config bundles (A/B experiments) ───────────
from bedrock_agentcore.runtime.context import BedrockAgentCoreContext as _LPContext


def _launchpad_config_bundle():
    """Active Launchpad config bundle for this request ({} when none routed)."""
    try:
        return _LPContext.get_config_bundle() or {}
    except Exception:
        return {}


def resolve_system_prompt() -> str:
    """Bundle-provided system prompt wins; the exported default is the fallback."""
    return str(_launchpad_config_bundle().get("system_prompt") or DEFAULT_SYSTEM_PROMPT)
# ──────────────────────────────────────────────────────────────────────────────
'''


class ConversionError(Exception):
    pass


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=EXPORT_TIMEOUT_S
    )


def _last_json(stdout: str) -> dict[str, Any]:
    """The CLI prints the result object on one line, sometimes followed by
    update notices — take the last parseable JSON line."""
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            return json.loads(line)
        except ValueError:
            continue
    raise ConversionError(f"agentcore CLI returned no JSON: {stdout[-300:]}")


def ensure_scratch_project() -> Path:
    """One reusable agentcore project dir — the CLI refuses to export
    outside a project cwd."""
    project = _SCRATCH_DIR / SCRATCH_PROJECT
    if (project / "agentcore").exists() or (project / "agentcore.json").exists() \
            or project.exists():
        return project
    _SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    try:
        proc = _run(
            ["agentcore", "create", "--project-name", SCRATCH_PROJECT,
             "--no-agent", "--json"],
            cwd=_SCRATCH_DIR,
        )
    except FileNotFoundError as exc:
        raise AppError(
            "agent.convert_cli_missing",
            "the `agentcore` CLI is not installed on the backend host",
            status_code=502,
        ) from exc
    body = _last_json(proc.stdout)
    if not body.get("success"):
        raise ConversionError(f"scratch project creation failed: {body.get('error')}")
    return Path(body["projectPath"])


def export_harness(harness_arn: str) -> dict[str, str]:
    """Run the CLI export; return {relpath: content} for the generated project."""
    project = ensure_scratch_project()
    try:
        proc = _run(
            ["agentcore", "export", "harness", "--arn", harness_arn,
             "--build", "CodeZip", "--json"],
            cwd=project,
        )
    except FileNotFoundError as exc:
        raise AppError(
            "agent.convert_cli_missing",
            "the `agentcore` CLI is not installed on the backend host",
            status_code=502,
        ) from exc
    body = _last_json(proc.stdout)
    if not body.get("success"):
        raise ConversionError(f"harness export failed: {body.get('error')}")
    agent_path = Path(body["agentPath"])
    files: dict[str, str] = {}
    for path in agent_path.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(agent_path).as_posix()
        if rel.startswith(".") or rel.endswith((".md", ".gitignore")):
            continue  # docs/git housekeeping — not runtime source
        files[rel] = path.read_text(encoding="utf-8")
    if "main.py" not in files:
        raise ConversionError("export produced no main.py")
    return files


def graft_config_bundle(main_py: str) -> str:
    """Make the exported entrypoint consume launchpad config bundles."""
    match = _PROMPT_CONST_RE.search(main_py)
    if match is None:
        raise ConversionError(
            "graft anchor missing: DEFAULT_SYSTEM_PROMPT constant not found "
            "(agentcore CLI codegen changed?)"
        )
    if _PROMPT_USE not in main_py:
        raise ConversionError(
            "graft anchor missing: system_prompt=DEFAULT_SYSTEM_PROMPT "
            "construction site not found (agentcore CLI codegen changed?)"
        )
    # insert the helpers right after the (triple-quoted) prompt constant ends
    quote = main_py[match.end() - 3:match.end()]
    const_end = main_py.index(quote, match.end()) + 3
    grafted = main_py[:const_end] + BUNDLE_GRAFT + main_py[const_end:]
    return grafted.replace(_PROMPT_USE, "system_prompt=resolve_system_prompt()")


def discover_env(files: dict[str, str]) -> dict[str, str | None]:
    """Env keys the exported code reads → wired value or None (degrades).

    Only the launchpad memory id is wired in v1; GATEWAY_*_URL stays unset —
    the exported MCP client skips the gateway with a warning when the URL is
    absent, but crashes at import when it's set and the M2M token fails.
    """
    settings = get_settings()
    keys: set[str] = set()
    for content in files.values():
        keys.update(_ENV_KEY_RE.findall(content))
    env: dict[str, str | None] = {}
    for key in sorted(keys):
        if key in ("AWS_REGION", "AWS_DEFAULT_REGION"):
            continue  # runtime-provided
        if key.startswith("MEMORY_MEMORY_") and settings.resources.get("memory_id"):
            env[key] = settings.resources["memory_id"]
        else:
            env[key] = None
    return env


def flatten_requirements(files: dict[str, str], base: list[str]) -> list[str]:
    """pyproject [project].dependencies → extras not already satisfied by the
    template base pins (base wins on package-name conflicts)."""
    pyproject = files.get("pyproject.toml", "")
    deps: list[str] = []
    in_deps = False
    for line in pyproject.splitlines():
        stripped = line.strip()
        if stripped.startswith("dependencies"):
            in_deps = True
            continue
        if in_deps:
            if stripped.startswith("]"):
                break
            entry = stripped.strip('",').strip("',")
            if entry:
                deps.append(entry)
    base_names = {re.split(r"[<>=!\[ ]", req, maxsplit=1)[0].lower() for req in base}
    return [d for d in deps
            if re.split(r"[<>=!\[ ]", d, maxsplit=1)[0].lower() not in base_names]


def build_conversion_spec(
    source_agent: Any, files: dict[str, str], base_requirements: list[str],
    new_name: str,
) -> AgentSpec:
    grafted = dict(files)
    grafted["main.py"] = graft_config_bundle(files["main.py"])
    env_contract = discover_env(grafted)
    wired = {k: v for k, v in env_contract.items() if v is not None}
    notes = {"system_prompt": "wired (config-bundle override grafted)",
             "inline_tools": "carried verbatim"}
    for key, value in env_contract.items():
        label = "memory" if key.startswith("MEMORY_") else (
            "kb_gateway" if key.startswith("GATEWAY_") else key.lower())
        notes[label] = (
            f"wired ({key})" if value is not None
            else f"not wired — {key} unset; exported code degrades gracefully"
        )
    source_spec = source_agent.spec or {}
    return AgentSpec(
        name=new_name,
        method="zip_runtime",
        model_id=source_spec.get("model_id") or AgentSpec.model_fields["model_id"].default,
        system_prompt=source_spec.get("system_prompt") or "(baked into exported code)",
        requirements=flatten_requirements(grafted, base_requirements),
        code_bundle={k: v for k, v in grafted.items() if k != "pyproject.toml"},
        source_harness={
            "agent_id": source_agent.id,
            "agent_name": source_agent.name,
            "harness_arn": source_agent.arn or "",
        },
        conversion_notes=notes,
        env=wired,
        memory=MemoryConfig(**(source_spec.get("memory") or {})),
    )
