#!/usr/bin/env bash
# Start the full local stack:
#   platform backend  :8000    platform frontend :5173 (auto-shifts if taken)
#   studio backend    :8100    studio frontend   :5273
# Ports are overridable: PLATFORM_API_PORT / PLATFORM_UI_PORT / STUDIO_API_PORT / STUDIO_UI_PORT
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM_API_PORT="${PLATFORM_API_PORT:-8000}"
PLATFORM_UI_PORT="${PLATFORM_UI_PORT:-5173}"
STUDIO_API_PORT="${STUDIO_API_PORT:-8100}"
STUDIO_UI_PORT="${STUDIO_UI_PORT:-5273}"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

(cd "$ROOT/backend" && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port "$PLATFORM_API_PORT") &
(cd "$ROOT/frontend" && npm run dev -- --host 0.0.0.0 --port "$PLATFORM_UI_PORT") &

if [ -d "$ROOT/apps/studio" ]; then
  (cd "$ROOT/apps/studio/backend" && uv run uvicorn main:app --host 0.0.0.0 --port "$STUDIO_API_PORT") &
  (cd "$ROOT/apps/studio" && npm run dev -- --host 0.0.0.0 --port "$STUDIO_UI_PORT") &
fi

wait
