#!/usr/bin/env bash
# Start backend (:8000) and frontend (:5173) for local development.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

(cd "$ROOT/backend" && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) &
(cd "$ROOT/frontend" && npm run dev -- --host 0.0.0.0 --port 5173) &

wait
