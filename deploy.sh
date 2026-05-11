#!/usr/bin/env bash
# Deploy script — called by the self-hosted GitHub Actions runner on each LXC.
# The runner runs as the 'vmonitor' user; systemctl requires sudo (see setup.sh).
set -euo pipefail

INSTALL_DIR="/opt/version-monitor"

echo "==> Pulling latest code..."
cd "${INSTALL_DIR}"
git pull --ff-only

echo "==> Installing/updating Python dependencies..."
./venv/bin/pip install -q -r requirements.txt

echo "==> Restarting service..."
systemctl restart version-monitor

echo "==> Done on $(hostname). Service status:"
systemctl status version-monitor --no-pager --lines=0
