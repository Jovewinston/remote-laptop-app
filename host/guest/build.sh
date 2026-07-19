#!/usr/bin/env bash
# Build local Tart golden image `bay-golden` for sealed-guest sessions.
# Uses `tart exec` (guest agent) — no SSH/network required on the host.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
VMS_ROOT="${HOME}/.bay/vms"
SSH_DIR="${VMS_ROOT}/ssh"
GOLDEN="${BAY_GOLDEN_NAME:-bay-golden}"
BUILD_VM="${GOLDEN}-build"
BASE_IMAGE="${BAY_BASE_IMAGE:-ghcr.io/cirruslabs/ubuntu:latest}"

mkdir -p "${SSH_DIR}" "${VMS_ROOT}/logs"

if ! command -v tart >/dev/null 2>&1; then
  echo "Tart not found. Install: brew install cirruslabs/cli/tart" >&2
  exit 1
fi

if [[ ! -f "${SSH_DIR}/id_ed25519" ]]; then
  ssh-keygen -t ed25519 -N "" -f "${SSH_DIR}/id_ed25519" -C "bay-host@lender"
fi
PUBKEY="$(cat "${SSH_DIR}/id_ed25519.pub")"

guest_exec() {
  tart exec "${BUILD_VM}" "$@"
}

guest_exec_stdin() {
  # -i attaches host stdin (for tar pipes)
  tart exec -i "${BUILD_VM}" "$@"
}

wait_guest_agent() {
  local i
  echo "==> Waiting for Tart guest agent…"
  for i in $(seq 1 90); do
    if guest_exec true >/dev/null 2>&1; then
      echo "Guest agent ready."
      return 0
    fi
    sleep 2
  done
  echo "Guest agent did not become ready. See ${VMS_ROOT}/logs/golden-build.log" >&2
  return 1
}

echo "==> Cleaning previous build VM (${BUILD_VM})"
tart stop "${BUILD_VM}" 2>/dev/null || true
tart delete "${BUILD_VM}" 2>/dev/null || true

# Exact name match — do not treat bay-golden-build as bay-golden.
golden_exists=0
while IFS= read -r name; do
  [[ "${name}" == "${GOLDEN}" ]] && golden_exists=1 && break
done < <(tart list --quiet 2>/dev/null || true)
if [[ "${golden_exists}" -eq 0 ]]; then
  while IFS= read -r line; do
    n="$(echo "${line}" | awk '{print $2}')"
    [[ "${n}" == "${GOLDEN}" ]] && golden_exists=1 && break
  done < <(tart list 2>/dev/null | tail -n +2 || true)
fi

if [[ "${golden_exists}" -eq 1 ]]; then
  if [[ "${BAY_GOLDEN_FORCE:-}" != "1" ]]; then
    echo "Golden image '${GOLDEN}' already exists."
    echo "Re-run with BAY_GOLDEN_FORCE=1 to rebuild, or: tart delete ${GOLDEN}"
    exit 0
  fi
  echo "==> Removing existing ${GOLDEN}"
  tart stop "${GOLDEN}" 2>/dev/null || true
  tart delete "${GOLDEN}" 2>/dev/null || true
fi

echo "==> Cloning base ${BASE_IMAGE} → ${BUILD_VM}"
tart clone "${BASE_IMAGE}" "${BUILD_VM}"
tart set "${BUILD_VM}" --cpu 4 --memory 8192 2>/dev/null || true
tart set "${BUILD_VM}" --disk-size 40 2>/dev/null || true

echo "==> Starting ${BUILD_VM}"
nohup tart run --no-graphics "${BUILD_VM}" >"${VMS_ROOT}/logs/golden-build.log" 2>&1 &
BUILD_PID=$!

cleanup() {
  tart stop "${BUILD_VM}" 2>/dev/null || true
}
trap cleanup EXIT

sleep 2
if ! kill -0 "${BUILD_PID}" 2>/dev/null; then
  echo "VM failed to stay up. Log:" >&2
  tail -40 "${VMS_ROOT}/logs/golden-build.log" >&2 || true
  exit 1
fi

wait_guest_agent

echo "==> Uploading bay-agent + provision script"
# COPYFILE_DISABLE avoids macOS xattr noise in tar
COPYFILE_DISABLE=1 tar czf - -C "${GUEST_DIR}" bay-agent provision-inside.sh \
  | guest_exec_stdin bash -lc 'rm -rf /tmp/bay-agent /tmp/provision-inside.sh && mkdir -p /tmp && cd /tmp && tar xzf -'

echo "==> Provisioning inside guest (Node, Claude, Codex, Yep, bay-agent)…"
guest_exec bash -lc "chmod +x /tmp/provision-inside.sh && /tmp/provision-inside.sh $(printf %q "${PUBKEY}")"

echo "==> Syncing guest disk before snapshot…"
guest_exec bash -lc 'ls -la /home/bay/bay-agent; test -s /home/bay/bay-agent/healthz.js; test -f /etc/systemd/system/bay-agent.service; command -v claude; command -v yepanywhere; sync; sudo sync; sleep 1'

echo "==> Clean shutdown of build VM (needed for disk persistence)…"
guest_exec bash -lc 'sudo poweroff' >/dev/null 2>&1 || true
for i in $(seq 1 60); do
  state="$(tart list 2>/dev/null | awk -v n="${BUILD_VM}" '$2==n{print $NF; exit}')"
  [[ "${state}" == "stopped" ]] && break
  sleep 2
done
trap - EXIT
if tart list 2>/dev/null | awk -v n="${BUILD_VM}" '$2==n{print $NF; exit}' | grep -q running; then
  tart stop "${BUILD_VM}"
fi
sleep 2

echo "==> Promoting to ${GOLDEN}"
tart delete "${GOLDEN}" 2>/dev/null || true
tart clone "${BUILD_VM}" "${GOLDEN}"
tart delete "${BUILD_VM}" 2>/dev/null || true
kill "${BUILD_PID}" 2>/dev/null || true

echo ""
echo "Golden image ready: ${GOLDEN}"
echo "Enable VM sandbox: export BAY_SANDBOX_BACKEND=vm"
echo "Then start Host: pnpm --filter @bay/host start"
echo ""
echo "Note: renters sign into Claude/Codex inside Yep — lender Keychain is not used."
