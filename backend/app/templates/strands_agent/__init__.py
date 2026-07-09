"""Strands agent template renderer.

Placeholders use ``__LAUNCHPAD_*__`` markers instead of str.format so the
template stays brace-safe Python. Rendered output must always compile.
"""

from pathlib import Path

from app.schemas.agent import AgentSpec

TEMPLATE_DIR = Path(__file__).parent


def render_main_py(spec: AgentSpec) -> str:
    source = (TEMPLATE_DIR / "main.py.tmpl").read_text(encoding="utf-8")
    return (
        source.replace("__LAUNCHPAD_AGENT_NAME__", spec.name)
        .replace("__LAUNCHPAD_MODEL_ID__", spec.model_id)
        .replace("__LAUNCHPAD_SYSTEM_PROMPT__", repr(spec.system_prompt))
    )


def base_requirements() -> list[str]:
    lines = (TEMPLATE_DIR / "requirements.txt").read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]
