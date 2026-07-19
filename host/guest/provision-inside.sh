#!/usr/bin/env bash
# Runs inside the Ubuntu Tart guest (as admin) to bake bay-golden.
set -euo pipefail

PUBKEY="${1:?public key required}"

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git openssh-server ufw

# Node 22 LTS
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# User bay
if ! id bay >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash bay
  echo "bay ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/bay >/dev/null
fi

sudo mkdir -p /home/bay/.ssh /home/bay/workspace /home/bay/.yep-anywhere /home/bay/bay-agent
echo "${PUBKEY}" | sudo tee /home/bay/.ssh/authorized_keys >/dev/null
sudo chmod 700 /home/bay/.ssh
sudo chmod 600 /home/bay/.ssh/authorized_keys
sudo chown -R bay:bay /home/bay

# Global CLIs — parallel npm fetches inside Tart often corrupt (EINTEGRITY / 0-byte bodies).
sudo npm cache clean --force || true
sudo npm install -g --prefer-online --fetch-retries=5 --maxsockets=1 \
  @anthropic-ai/claude-code @openai/codex yepanywhere
command -v claude >/dev/null
command -v codex >/dev/null
command -v yepanywhere >/dev/null

# Copy agent files (placed at /tmp/bay-agent by build.sh)
if [[ ! -d /tmp/bay-agent ]]; then
  echo "Missing /tmp/bay-agent upload" >&2
  exit 1
fi
# Drop macOS AppleDouble junk from tar
sudo find /tmp/bay-agent -name '._*' -delete || true
sudo mkdir -p /home/bay/bay-agent
sudo cp -a /tmp/bay-agent/. /home/bay/bay-agent/
sudo chmod +x /home/bay/bay-agent/start.sh /home/bay/bay-agent/healthz.js
sudo chown -R bay:bay /home/bay/bay-agent
test -f /home/bay/bay-agent/healthz.js
test -f /home/bay/bay-agent/bay-agent.service
test -f /home/bay/bay-agent/start.sh
ls -la /home/bay/bay-agent

# systemd
sudo cp /home/bay/bay-agent/bay-agent.service /etc/systemd/system/bay-agent.service
sudo systemctl daemon-reload
sudo systemctl enable bay-agent

# SSH
sudo systemctl enable ssh || sudo systemctl enable sshd || true
sudo systemctl start ssh || sudo systemctl start sshd || true

# Allow cockpit + health ports (softnet expose from host)
sudo ufw allow OpenSSH || true
sudo ufw allow 3400/tcp || true
sudo ufw allow 3411/tcp || true
echo "y" | sudo ufw enable || true

# Default job.env for first boot
sudo -u bay tee /home/bay/job.env >/dev/null <<'EOF'
AGENT=claude
ENABLED_PROVIDERS=claude
DEFAULT_MODEL=sonnet
REPO_URL=
YEP_PORT=3400
EOF

sudo -u bay tee /home/bay/workspace/README.md >/dev/null <<'EOF'
# Bay sealed guest

Files here live on this VM disk only. Sign into Claude or Codex in Yep.
EOF

echo "provision-inside: done"
