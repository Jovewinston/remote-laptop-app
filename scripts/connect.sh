#!/usr/bin/env bash
# Bay Connect wrapper — used by renters after Reserve → Start
# Usage: ./scripts/connect.sh <reservationId> <connectToken>
# Defaults to hosted API; override with BAY_API_URL=http://127.0.0.1:8788 for local.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export BAY_API_URL="${BAY_API_URL:-https://bay-api-production.up.railway.app}"
exec pnpm --filter @bay/connect start -- "$@"
