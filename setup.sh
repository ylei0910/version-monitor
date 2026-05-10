#!/usr/bin/env bash
# Initial setup script for a Proxmox LXC (Debian/Ubuntu).
# Run once as root: bash setup.sh
set -euo pipefail

INSTALL_DIR="/opt/version-monitor"
VENV_DIR="${INSTALL_DIR}/venv"
SERVICE_NAME="version-monitor"
SERVICE_USER="vmonitor"
REPO_URL="${REPO_URL:-}"  # set externally or leave empty to copy from CWD

echo "==> Installing system dependencies..."
apt-get update -qq
apt-get install -y python3 python3-pip python3-venv git

echo "==> Creating user '${SERVICE_USER}'..."
if ! id -u "${SERVICE_USER}" &>/dev/null; then
    useradd --system --create-home --shell /bin/bash "${SERVICE_USER}"
fi

echo "==> Setting up application directory..."
if [ -n "${REPO_URL}" ]; then
    if [ -d "${INSTALL_DIR}/.git" ]; then
        echo "    Repository already cloned, skipping."
    else
        git clone "${REPO_URL}" "${INSTALL_DIR}"
    fi
else
    # Copy from current directory (local install)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ "${SCRIPT_DIR}" != "${INSTALL_DIR}" ]; then
        mkdir -p "${INSTALL_DIR}"
        cp -r "${SCRIPT_DIR}/." "${INSTALL_DIR}/"
    fi
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

echo "==> Creating Python virtual environment..."
sudo -u "${SERVICE_USER}" python3 -m venv "${VENV_DIR}"
sudo -u "${SERVICE_USER}" "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
sudo -u "${SERVICE_USER}" "${VENV_DIR}/bin/pip" install --quiet -r "${INSTALL_DIR}/requirements.txt"

echo "==> Creating data directory..."
mkdir -p "${INSTALL_DIR}/data"
chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/data"

echo "==> Setting up configuration files..."
if [ ! -f "${INSTALL_DIR}/.env" ]; then
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
    chmod 600 "${INSTALL_DIR}/.env"
    echo ""
    echo "  *** Created ${INSTALL_DIR}/.env — edit it before starting the service! ***"
    echo "  Required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
fi

if [ ! -f "${INSTALL_DIR}/services.yaml" ]; then
    cp "${INSTALL_DIR}/services.yaml.example" "${INSTALL_DIR}/services.yaml"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/services.yaml"
    echo ""
    echo "  *** Created ${INSTALL_DIR}/services.yaml — edit it to configure your services! ***"
fi

echo "==> Generating SSH keypair for deployments..."
SSH_DIR="/home/${SERVICE_USER}/.ssh"
KEY_FILE="${SSH_DIR}/id_ed25519"
mkdir -p "${SSH_DIR}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${SSH_DIR}"
chmod 700 "${SSH_DIR}"

if [ ! -f "${KEY_FILE}" ]; then
    sudo -u "${SERVICE_USER}" ssh-keygen -t ed25519 -f "${KEY_FILE}" -N "" -C "${SERVICE_USER}@$(hostname)"
    cat "${KEY_FILE}.pub" >> "${SSH_DIR}/authorized_keys"
    chmod 600 "${SSH_DIR}/authorized_keys"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${SSH_DIR}/authorized_keys"
fi

echo ""
echo "  *** SSH public key (add to GitHub → Settings → Secrets → DEPLOY_SSH_KEY): ***"
echo ""
cat "${KEY_FILE}"
echo ""

echo "==> Installing systemd service..."
cp "${INSTALL_DIR}/version-monitor.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

if [ -f "${INSTALL_DIR}/.env" ] && grep -q "your_bot_token_here" "${INSTALL_DIR}/.env"; then
    echo ""
    echo "  Skipping service start — .env still contains placeholder values."
    echo "  Edit ${INSTALL_DIR}/.env, then run: systemctl start ${SERVICE_NAME}"
else
    systemctl restart "${SERVICE_NAME}"
    echo ""
    echo "  Service started. Status:"
    systemctl status "${SERVICE_NAME}" --no-pager --lines=5
fi

echo ""
echo "========================================="
echo "  Setup complete!"
echo "  App URL: http://$(hostname -I | awk '{print $1}'):8080"
echo ""
echo "  Next steps:"
echo "  1. Edit ${INSTALL_DIR}/.env with your Telegram credentials"
echo "  2. Edit ${INSTALL_DIR}/services.yaml with your services"
echo "     (or use the web UI Settings panel)"
echo "  3. Add the SSH public key above to GitHub Secrets as DEPLOY_SSH_KEY"
echo "  4. Add this host to GitHub Secrets DEPLOY_HOSTS:"
echo "     [\"${SERVICE_USER}@$(hostname -I | awk '{print $1}'):22\"]"
echo "  5. Run: systemctl start ${SERVICE_NAME}"
echo "  6. View logs: journalctl -u ${SERVICE_NAME} -f"
echo "========================================="
