#!/usr/bin/env bash
# Initial setup script for a Proxmox LXC (Debian/Ubuntu).
# Safe to re-run — every step is idempotent.
#
# Usage (as root):
#   bash setup.sh
#
# Environment variables (optional):
#   REPO_URL        Git repo URL to clone (default: the GitHub repo)
#   RUNNER_TOKEN    GitHub Actions runner registration token
#                   Get it from: GitHub repo → Settings → Actions → Runners → New self-hosted runner
#   RUNNER_LABEL    Unique label for this host's runner (default: hostname)
#                   Add this label to the RUNNER_LABELS repo variable on GitHub.
set -euo pipefail

INSTALL_DIR="/opt/version-monitor"
VENV_DIR="${INSTALL_DIR}/venv"
RUNNER_DIR="/opt/version-monitor-runner"
SERVICE_NAME="version-monitor"
SERVICE_USER="vmonitor"
REPO_URL="${REPO_URL:-https://github.com/ylei0910/version-monitor.git}"
RUNNER_TOKEN="${RUNNER_TOKEN:-}"
RUNNER_LABEL="${RUNNER_LABEL:-$(hostname)}"
GITHUB_REPO="ylei0910/version-monitor"

# ── 1. System dependencies ────────────────────────────────────────────────────
echo "==> Installing system dependencies..."
apt-get update -qq
apt-get install -y python3 python3-pip python3-venv git curl

# ── 2. Dedicated user ────────────────────────────────────────────────────────
echo "==> Ensuring user '${SERVICE_USER}' exists..."
if ! id -u "${SERVICE_USER}" &>/dev/null; then
    useradd --system --create-home --shell /bin/bash "${SERVICE_USER}"
    echo "    Created user ${SERVICE_USER}."
else
    echo "    User ${SERVICE_USER} already exists, skipping."
fi

# ── 3. Application directory ─────────────────────────────────────────────────
echo "==> Setting up application directory..."
if [ -n "${REPO_URL}" ]; then
    if [ -d "${INSTALL_DIR}/.git" ]; then
        echo "    Repository already cloned — pulling latest..."
        runuser -u "${SERVICE_USER}" -- git -C "${INSTALL_DIR}" pull --ff-only
    else
        git clone "${REPO_URL}" "${INSTALL_DIR}"
    fi
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── 4. Python virtual environment ────────────────────────────────────────────
echo "==> Setting up Python virtual environment..."
# python3 -m venv is safe to re-run on an existing venv
runuser -u "${SERVICE_USER}" -- python3 -m venv "${VENV_DIR}"
runuser -u "${SERVICE_USER}" -- "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
runuser -u "${SERVICE_USER}" -- "${VENV_DIR}/bin/pip" install --quiet -r "${INSTALL_DIR}/requirements.txt"

# ── 5. Data directory ────────────────────────────────────────────────────────
echo "==> Ensuring data directory exists..."
mkdir -p "${INSTALL_DIR}/data"
chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/data"

# ── 6. Configuration files ───────────────────────────────────────────────────
echo "==> Setting up configuration files..."
if [ ! -f "${INSTALL_DIR}/.env" ]; then
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
    chmod 600 "${INSTALL_DIR}/.env"
    echo ""
    echo "  *** Created ${INSTALL_DIR}/.env — edit it before starting the service! ***"
    echo "  Required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
else
    echo "    .env already exists, skipping."
fi

if [ ! -f "${INSTALL_DIR}/services.yaml" ]; then
    cp "${INSTALL_DIR}/services.yaml.example" "${INSTALL_DIR}/services.yaml"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/services.yaml"
    echo ""
    echo "  *** Created ${INSTALL_DIR}/services.yaml — edit it to configure your services! ***"
else
    echo "    services.yaml already exists, skipping."
fi

# ── 7. Sudoers rule (idempotent — always written, content is deterministic) ──
echo "==> Configuring sudoers for service management..."
mkdir -p /etc/sudoers.d
SUDOERS_FILE="/etc/sudoers.d/vmonitor-service"
cat > "${SUDOERS_FILE}" <<EOF
# Allow vmonitor to restart/status the version-monitor service (for CI/CD runner)
vmonitor ALL=(ALL) NOPASSWD: /bin/systemctl restart version-monitor
vmonitor ALL=(ALL) NOPASSWD: /bin/systemctl status version-monitor
EOF
chmod 440 "${SUDOERS_FILE}"

# ── 8. Systemd app service ───────────────────────────────────────────────────
echo "==> Installing systemd service..."
cp "${INSTALL_DIR}/version-monitor.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

if grep -q "your_bot_token_here" "${INSTALL_DIR}/.env" 2>/dev/null; then
    echo ""
    echo "  Skipping service start — .env still contains placeholder values."
    echo "  Edit ${INSTALL_DIR}/.env, then run: systemctl start ${SERVICE_NAME}"
else
    systemctl restart "${SERVICE_NAME}"
    echo ""
    echo "  Service started. Status:"
    systemctl status "${SERVICE_NAME}" --no-pager --lines=5
fi

# ── 9. GitHub Actions runner ─────────────────────────────────────────────────
echo "==> Setting up GitHub Actions runner..."
mkdir -p "${RUNNER_DIR}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${RUNNER_DIR}"

# Download runner binaries only if not already present
if [ ! -f "${RUNNER_DIR}/run.sh" ]; then
    echo "    Downloading runner binaries..."
    RUNNER_LATEST=$(curl -sL https://api.github.com/repos/actions/runner/releases/latest \
        | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//')
    RUNNER_ARCH="x64"
    case "$(uname -m)" in arm64|aarch64) RUNNER_ARCH="arm64" ;; esac
    RUNNER_PKG="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_LATEST}.tar.gz"
    runuser -u "${SERVICE_USER}" -- curl -sL \
        "https://github.com/actions/runner/releases/download/v${RUNNER_LATEST}/${RUNNER_PKG}" \
        -o "/tmp/${RUNNER_PKG}"
    runuser -u "${SERVICE_USER}" -- tar xzf "/tmp/${RUNNER_PKG}" -C "${RUNNER_DIR}"
    rm "/tmp/${RUNNER_PKG}"
else
    echo "    Runner binaries already present, skipping download."
fi

# Determine runner service name (set by svc.sh install)
RUNNER_SVC_NAME=$(ls /etc/systemd/system/actions.runner.*.service 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "")

if [ -n "${RUNNER_TOKEN}" ]; then
    echo "    Registering runner with label '${RUNNER_LABEL}'..."
    # --replace safely handles re-registration over an existing runner
    runuser -u "${SERVICE_USER}" -- "${RUNNER_DIR}/config.sh" \
        --url "https://github.com/${GITHUB_REPO}" \
        --token "${RUNNER_TOKEN}" \
        --name "$(hostname)" \
        --labels "self-hosted,version-monitor,${RUNNER_LABEL}" \
        --work "${RUNNER_DIR}/_work" \
        --unattended \
        --replace

    if [ -n "${RUNNER_SVC_NAME}" ]; then
        echo "    Runner service already installed — restarting..."
        systemctl restart "${RUNNER_SVC_NAME}"
    else
        echo "    Installing runner as systemd service..."
        # svc.sh must be run from within the runner directory
        pushd "${RUNNER_DIR}" > /dev/null
        ./svc.sh install "${SERVICE_USER}"
        ./svc.sh start
        popd > /dev/null
    fi
else
    echo ""
    echo "  *** RUNNER_TOKEN not set — skipping runner registration. ***"
    echo "  To register, re-run with a token:"
    echo ""
    echo "    curl -sL https://raw.githubusercontent.com/${GITHUB_REPO}/main/setup.sh | RUNNER_TOKEN=<token> RUNNER_LABEL=${RUNNER_LABEL} bash"
    echo ""
    echo "  Get a token from:"
    echo "    https://github.com/${GITHUB_REPO}/settings/actions/runners/new"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo "  Setup complete!"
echo "  App URL:      http://$(hostname -I | awk '{print $1}'):8080"
echo "  Runner label: ${RUNNER_LABEL}"
echo ""
echo "  Next steps:"
echo "  1. Edit ${INSTALL_DIR}/.env with your Telegram credentials"
echo "  2. Edit ${INSTALL_DIR}/services.yaml with your services"
echo "     (or use the web UI Settings panel)"
echo "  3. On GitHub, add/update the RUNNER_LABELS repo variable:"
echo "     Settings → Variables → RUNNER_LABELS"
echo "     Add \"${RUNNER_LABEL}\" to the JSON array."
echo "  4. View app logs:    journalctl -u version-monitor -f"
echo "  5. View runner logs: journalctl -u actions.runner.* -f"
echo "========================================="
