#!/usr/bin/env bash
# Provision the studio local-debug execution interpreter.
#
# The launchpad control-plane backend is deliberately lean (no strands, no
# openai). Locally running un-deployed studio flows needs a separate
# interpreter that has the Strands runtime deps installed. This script creates
# an isolated uv venv at data/exec-venv and installs those deps into it. It is
# idempotent — re-running upgrades in place.
#
# Point the backend at a different interpreter with LAUNCHPAD_STUDIO_EXEC_PYTHON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${REPO_ROOT}/data/exec-venv"
PY_BIN="${VENV_DIR}/bin/python"

echo "==> exec venv: ${VENV_DIR}"
uv venv "${VENV_DIR}" --python 3.12

echo "==> installing strands runtime deps"
uv pip install --python "${PY_BIN}" \
  'strands-agents[openai]>=1.46,<2' \
  'strands-agents-tools[mem0_memory]' \
  'mcp' \
  'bedrock-agentcore'

echo "==> verifying imports"
"${PY_BIN}" -c "import strands, strands_tools, mcp; from strands_tools import mem0_memory; from importlib.metadata import version; print('strands-agents', version('strands-agents'))"

echo "==> done. studio_exec_python = ${PY_BIN}"
