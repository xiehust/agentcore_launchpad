#!/usr/bin/env bash
# Start the platform backend and frontend:
#   platform backend  :8000    platform frontend :5173 (auto-shifts if taken)
# Ports are overridable: PLATFORM_API_PORT / PLATFORM_UI_PORT
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM_API_PORT="${PLATFORM_API_PORT:-8000}"
PLATFORM_UI_PORT="${PLATFORM_UI_PORT:-5173}"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

(cd "$ROOT/backend" && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port "$PLATFORM_API_PORT") &
(cd "$ROOT/frontend" && npm run dev -- --host 0.0.0.0 --port "$PLATFORM_UI_PORT") &

wait
