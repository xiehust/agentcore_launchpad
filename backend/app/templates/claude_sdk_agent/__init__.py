"""Claude Agent SDK container template renderer + build-context assembly."""

import json
import shutil
from pathlib import Path

from app.schemas.agent import AgentSpec

TEMPLATE_DIR = Path(__file__).parent

# Claude Code tool names the platform allows agents to request.
DEFAULT_ALLOWED_TOOLS = ["Task"]  # Task = subagent dispatch; Bash/Edit stay off by default


def render_main_py(spec: AgentSpec) -> str:
    mcp_servers = spec.env.get("LAUNCHPAD_MCP_SERVERS", "")
    try:
        mcp_config = json.loads(mcp_servers) if mcp_servers else {}
    except ValueError:
        mcp_config = {}
    allowed = [t.name for t in spec.tools if t.type == "mcp"] or DEFAULT_ALLOWED_TOOLS
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
    """Copy the static template files + rendered main.py into target_dir."""
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)
    for name in ("Dockerfile", "requirements.txt", "buildspec.yml", "README.md"):
        shutil.copy2(TEMPLATE_DIR / name, target_dir / name)
    shutil.copytree(TEMPLATE_DIR / ".claude", target_dir / ".claude")
    (target_dir / "main.py").write_text(render_main_py(spec), encoding="utf-8")
    return target_dir
