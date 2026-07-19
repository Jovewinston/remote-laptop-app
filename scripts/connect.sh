#!/usr/bin/env bash
# Bay Connect wrapper — used by renters after Reserve → Start
# Usage: ./scripts/connect.sh <reservationId> <connectToken>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec pnpm --filter @bay/connect start -- "$@"
