#!/usr/bin/env bash
# Remote deploy script — run on each LXC after setup.sh has been run once.
# GitHub Actions SSHes in and calls: bash /opt/version-monitor/deploy.sh
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
