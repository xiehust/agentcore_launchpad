"""Claude Agent SDK container template renderer + build-context assembly."""

import json
import shutil
from pathlib import Path
from typing import Any

from app.schemas.agent import AgentSpec

TEMPLATE_DIR = Path(__file__).parent

# Claude Code tool names the platform allows agents to request.
DEFAULT_ALLOWED_TOOLS = ["Task"]  # Task = subagent dispatch; Bash/Edit stay off by default


def skill_name_from_path(path: str) -> str:
    """s3://…/skills/web-analyzer/ → web-analyzer (registry and custom prefixes)."""
    return path.rstrip("/").rsplit("/", 1)[-1]


def _mcp_servers(spec: AgentSpec) -> dict[str, Any]:
    """Free-text LAUNCHPAD_MCP_SERVERS JSON ∪ registry-selected remote servers.

    Registry chips are explicit UI selections — they win on key collision."""
    raw = spec.env.get("LAUNCHPAD_MCP_SERVERS", "")
    try:
        free = json.loads(raw) if raw else {}
    except ValueError:
        free = {}
    if not isinstance(free, dict):
        free = {}
    registry = {
        t.name: {"type": "http", "url": t.config["url"]}
        for t in spec.tools
        if t.type == "mcp" and t.config.get("url")
    }
    return {**free, **registry}


def render_main_py(spec: AgentSpec) -> str:
    mcp_config = _mcp_servers(spec)
    allowed = list(DEFAULT_ALLOWED_TOOLS)
    if spec.skills:
        allowed.append("Skill")  # the tool Claude Code invokes agent skills through
    allowed += [f"mcp__{name}" for name in mcp_config]
    source = (TEMPLATE_DIR / "main.py.tmpl").read_text(encoding="utf-8")
    return (
        source.replace("__LAUNCHPAD_AGENT_NAME__", spec.name)
        .replace("__LAUNCHPAD_MODEL_ID__", spec.model_id)
        .replace("__LAUNCHPAD_SYSTEM_PROMPT__", repr(spec.system_prompt))
        .replace("__LAUNCHPAD_MAX_TURNS__", str(spec.max_iterations))
        .replace("__LAUNCHPAD_ALLOWED_TOOLS__", repr(allowed))
        .replace("__LAUNCHPAD_MCP_SERVERS__", repr(mcp_config))
    )


def assemble_build_context(spec: AgentSpec, target_dir: Path) -> Path:
    """Copy the static template files + rendered main.py into target_dir.

    Pure filesystem work — spec.skills S3 download happens in the deployer
    (bundle_skill_paths_into) so this stays testable without AWS."""
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)
    for name in ("Dockerfile", "requirements.txt", "buildspec.yml", "README.md",
                 "tracing.py"):
        shutil.copy2(TEMPLATE_DIR / name, target_dir / name)
    # .claude scaffold ships empty since the fact-checker sample was dropped —
    # git can't track empty dirs, so copy only if a future scaffold reappears;
    # the skill bundler creates .claude/skills/ on demand.
    scaffold = TEMPLATE_DIR / ".claude"
    if scaffold.exists():
        shutil.copytree(scaffold, target_dir / ".claude")
    (target_dir / "main.py").write_text(render_main_py(spec), encoding="utf-8")
    return target_dir
