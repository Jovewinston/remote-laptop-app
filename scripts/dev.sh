#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm --filter @bay/shared build
pnpm db:seed >/dev/null 2>&1 || true

echo "Starting Bay API :8788 and Web :3200"
echo "Invite codes: BAY-FRIENDS / BAY-DEMO"
echo "Lender Host UI: pnpm --filter @bay/host start  → http://127.0.0.1:3410"

pnpm --filter @bay/api dev &
API_PID=$!
pnpm --filter @bay/web dev &
WEB_PID=$!

cleanup() {
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait
