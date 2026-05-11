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
        git -C "${INSTALL_DIR}" pull --ff-only
    else
        git clone "${REPO_URL}" "${INSTALL_DIR}"
    fi
fi
# Repo owned by root; directory writable by vmonitor so the app can write
# services.yaml and its temp file without root privileges
chown -R root:root "${INSTALL_DIR}"
chown root:"${SERVICE_USER}" "${INSTALL_DIR}"
chmod 775 "${INSTALL_DIR}"

# ── 4. Python virtual environment ────────────────────────────────────────────
echo "==> Setting up Python virtual environment..."
# python3 -m venv is safe to re-run on an existing venv
python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet -r "${INSTALL_DIR}/requirements.txt"

# ── 5. Data directory ────────────────────────────────────────────────────────
echo "==> Ensuring data directory exists..."
mkdir -p "${INSTALL_DIR}/data"
# data/ must be writable by the app user (vmonitor) for SQLite
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/data"

# ── 6. Configuration files ───────────────────────────────────────────────────
echo "==> Setting up configuration files..."
if [ ! -f "${INSTALL_DIR}/.env" ]; then
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    echo ""
    echo "  *** Created ${INSTALL_DIR}/.env — edit it before starting the service! ***"
    echo "  Required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
else
    echo "    .env already exists, skipping."
fi
# root owns, vmonitor can read — secrets not world-readable
chown root:"${SERVICE_USER}" "${INSTALL_DIR}/.env"
chmod 640 "${INSTALL_DIR}/.env"

if [ ! -f "${INSTALL_DIR}/services.yaml" ]; then
    cp "${INSTALL_DIR}/services.yaml.example" "${INSTALL_DIR}/services.yaml"
    echo ""
    echo "  *** Created ${INSTALL_DIR}/services.yaml — edit it to configure your services! ***"
else
    echo "    services.yaml already exists, skipping."
fi
# vmonitor needs read+write access (UI can edit services.yaml via API)
chown root:"${SERVICE_USER}" "${INSTALL_DIR}/services.yaml"
chmod 660 "${INSTALL_DIR}/services.yaml"

# ── 7. (no sudoers needed — runner runs as root with RUNNER_ALLOW_RUNASROOT=1) ──

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
        # Ensure RUNNER_ALLOW_RUNASROOT is set (idempotent)
        if ! grep -q "RUNNER_ALLOW_RUNASROOT" "/etc/systemd/system/${RUNNER_SVC_NAME}" 2>/dev/null; then
            sed -i '/\[Service\]/a Environment=RUNNER_ALLOW_RUNASROOT=1' "/etc/systemd/system/${RUNNER_SVC_NAME}"
            systemctl daemon-reload
        fi
        systemctl restart "${RUNNER_SVC_NAME}"
    else
        echo "    Installing runner as systemd service (runs as root)..."
        # svc.sh must be run from within the runner directory
        pushd "${RUNNER_DIR}" > /dev/null
        ./svc.sh install root
        # Allow runner to run as root
        RUNNER_SVC_NEW=$(ls /etc/systemd/system/actions.runner.*.service | head -1)
        sed -i '/\[Service\]/a Environment=RUNNER_ALLOW_RUNASROOT=1' "${RUNNER_SVC_NEW}"
        systemctl daemon-reload
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
