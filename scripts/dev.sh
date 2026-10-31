#!/usr/bin/env bash
# Usage: EDITOR_MOCK=1 scripts/dev.sh   (EDITOR_MOCK passes through to the loop)
set -euo pipefail
cd "$(dirname "$0")/.."
export EDITOR_MOCK="${EDITOR_MOCK:-}"
exec uv run uvicorn editor.server:app --host 0.0.0.0 --port "${PORT:-8080}" --reload --reload-dir editor
