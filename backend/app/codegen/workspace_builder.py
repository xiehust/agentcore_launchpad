"""Temporary workspace construction for the AI-fix coding agent.

Ported from strands_studio_ui ``backend/codegen/workspace_builder.py``
(origin/main), keeping only the fix path. ``canonicalize_flow`` is lifted in
here (upstream imported it from ``cache.py``, which the launchpad port drops
along with the generation cache). The golden-example ``build_workspace`` /
``select_examples`` helpers were dropped with the generate pipeline.

Fix layout (build_fix_workspace):
  workspace/
    CLAUDE.md            # FIX_CLAUDE.md renamed (fix task + diagnosis rules)
    contract_spec.md / flow_semantics.md / flow.json
    generated_agent.py   # the failing code (agent edits in place)
    error.txt            # execution error, tail-truncated to 8KB
    (no examples — the current code is the strongest context)
"""

import copy
import json
import logging
import shutil
import tempfile
from collections.abc import Sequence
from pathlib import Path

from app.codegen import config

logger = logging.getLogger(__name__)

# Node fields that do not affect generated code (stripped from the canonical flow)
LAYOUT_FIELDS = (
    "position",
    "width",
    "height",
    "selected",
    "dragging",
    "measured",
    "positionAbsolute",
)

# (source filename in guidance dir, target filename in workspace)
FIX_GUIDANCE_FILES: Sequence[tuple[str, str]] = (
    ("FIX_CLAUDE.md", "CLAUDE.md"),
    ("contract_spec.md", "contract_spec.md"),
    ("flow_semantics.md", "flow_semantics.md"),
)

ERROR_TAIL_BYTES = 8 * 1024


def canonicalize_flow(flow_data: dict, graph_mode: bool) -> dict:
    """Deep-copy flow_data, strip layout-only fields, include graph_mode."""
    canonical = copy.deepcopy(flow_data)
    for node in canonical.get("nodes", []):
        if isinstance(node, dict):
            for field in LAYOUT_FIELDS:
                node.pop(field, None)
    return {
        "nodes": canonical.get("nodes", []),
        "edges": canonical.get("edges", []),
        "graph_mode": graph_mode,
    }


def _copy_guidance(workspace: Path, file_pairs: Sequence[tuple[str, str]]) -> None:
    """Copy guidance documents into the workspace (warn-skip if missing)."""
    for source_name, target_name in file_pairs:
        source = config.GUIDANCE_DIR / source_name
        if source.exists():
            shutil.copy2(source, workspace / target_name)
        else:
            logger.warning(f"Guidance file missing, skipped: {source}")


def _write_flow_json(workspace: Path, flow_data: dict, graph_mode: bool) -> None:
    """Write the canonical flow (layout fields stripped, graph_mode included)."""
    flow_json = json.dumps(
        canonicalize_flow(flow_data, graph_mode),
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    (workspace / "flow.json").write_text(flow_json, encoding="utf-8")


def _truncate_error_tail(error: str) -> str:
    """Keep the last ERROR_TAIL_BYTES of the error (the root cause lives at the end)."""
    encoded = error.encode("utf-8")
    if len(encoded) <= ERROR_TAIL_BYTES:
        return error
    tail = encoded[-ERROR_TAIL_BYTES:].decode("utf-8", errors="ignore")
    return "[... error output truncated; showing only the last 8KB ...]\n" + tail


def build_fix_workspace(
    code: str,
    error: str,
    flow_data: dict,
    graph_mode: bool,
    input_data: str | None = None,
) -> Path:
    """Create a temp workspace for the AI-fix flow (no golden examples).

    FIX_CLAUDE.md is copied in as CLAUDE.md; the failing code is written to
    generated_agent.py for in-place editing; the error is tail-truncated to
    8KB and written to error.txt (optionally prefixed with the user input
    that triggered the failed run).
    """
    workspace = Path(tempfile.mkdtemp(prefix="codefix_"))

    _copy_guidance(workspace, FIX_GUIDANCE_FILES)
    _write_flow_json(workspace, flow_data, graph_mode)

    # The failing code, edited in place by the agent
    (workspace / config.GENERATED_FILENAME).write_text(code, encoding="utf-8")

    # Error output (tail matters most); truncation happens before the header
    # so the input context is never dropped.
    sections = []
    if input_data and input_data.strip():
        sections.append(
            "# User input of the failed execution:\n"
            f"# {input_data.strip()[:500]}\n"
        )
    sections.append(_truncate_error_tail(error))
    (workspace / "error.txt").write_text("\n".join(sections), encoding="utf-8")

    return workspace


def cleanup_workspace(workspace: Path) -> None:
    """Remove the temp workspace, ignoring errors."""
    shutil.rmtree(workspace, ignore_errors=True)
