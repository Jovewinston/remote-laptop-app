#!/usr/bin/env bash
set -euo pipefail
HOME_DIR="${HOME:-/home/bay}"
AGENT_DIR="${HOME_DIR}/bay-agent"
PID_FILE="${HOME_DIR}/bay-agent.pid"
LOG_FILE="${HOME_DIR}/bay-agent.log"

mkdir -p "${HOME_DIR}/workspace" "${HOME_DIR}/.yep-anywhere"

if [[ -f "${PID_FILE}" ]]; then
  old="$(cat "${PID_FILE}" || true)"
  if [[ -n "${old}" ]] && kill -0 "${old}" 2>/dev/null; then
    # Already running
    exit 0
  fi
fi

nohup node "${AGENT_DIR}/healthz.js" >>"${LOG_FILE}" 2>&1 &
echo $! >"${PID_FILE}"
