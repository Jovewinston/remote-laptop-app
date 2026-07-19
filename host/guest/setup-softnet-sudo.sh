#!/usr/bin/env bash
# One-time: allow Tart softnet networking without a password prompt.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SOFTNET="$(brew --prefix softnet 2>/dev/null)/bin/softnet"
if [[ ! -x "${SOFTNET}" ]]; then
  echo "softnet not found. Install Tart first: brew install cirruslabs/cli/tart" >&2
  exit 1
fi

USER_NAME="$(whoami)"
LINE="${USER_NAME} ALL=(root) NOPASSWD: ${SOFTNET}"

if [[ -f /etc/sudoers.d/tart-softnet ]] && grep -qF "${SOFTNET}" /etc/sudoers.d/tart-softnet 2>/dev/null; then
  echo "Already configured: /etc/sudoers.d/tart-softnet"
  exit 0
fi

echo "Will write: ${LINE}"
osascript <<EOF
do shell script "printf '%s\\n' '${LINE}' > /etc/sudoers.d/tart-softnet && chmod 440 /etc/sudoers.d/tart-softnet && visudo -cf /etc/sudoers.d/tart-softnet" with administrator privileges
EOF

echo "Done. Softnet passwordless sudo is ready."
