#!/usr/bin/env bash
# Remote TMux Agent - Install script
# Usage: curl https://tmux.zdendys79.website/setup | bash
set -euo pipefail

RELAY_HOST="tmux.zdendys79.website"
RELAY_AGENT_PORT="7902"
INSTALL_DIR="/opt/remote-tmux-agent"
CONFIG_DIR="/etc/remote-tmux"
SERVICE_NAME="remote-tmux-agent"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
ask()     { echo -e "${YELLOW}[?]${NC}    $*"; }

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     Remote TMux Agent - Setup        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Checks ──────────────────────────────────────────────────────────────────

[[ $EUID -ne 0 ]] && err "Run as root: curl https://${RELAY_HOST}/setup | sudo bash"

# Detect the real user who invoked sudo (tmux sessions belong to them)
REAL_USER="${SUDO_USER:-}"
if [[ -z "$REAL_USER" ]]; then
  # Not via sudo — ask
  ask "Username whose tmux sessions should be exposed: "
  read -r REAL_USER </dev/tty
fi
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
REAL_UID=$(id -u "$REAL_USER")
info "Running agent as user: ${REAL_USER} (uid=${REAL_UID})"

for cmd in tmux openssl curl conspy; do
  if ! command -v "$cmd" &>/dev/null; then
    warn "$cmd not found, installing..."
    apt-get install -y "$cmd" 2>/dev/null || warn "Could not install $cmd (TTY console access will not work)."
  fi
done

# Ensure real user is in tty group (needed for conspy to access /dev/ttyN)
if ! id -nG "$REAL_USER" 2>/dev/null | grep -qw tty; then
  usermod -aG tty "$REAL_USER"
  info "Added ${REAL_USER} to group 'tty' (conspy access). Re-login required for shell, but service uses new group immediately."
fi

# Node.js: ensure 18+
if ! command -v node &>/dev/null || \
   [[ $(node -e "process.stdout.write(process.version.split('.')[0].slice(1))") -lt 18 ]]; then
  warn "Node.js 18+ not found, installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    || err "Could not install Node.js. Install it manually (https://nodejs.org/) and retry."
  ok "Node.js $(node --version) installed"
fi

# ── Agent name ───────────────────────────────────────────────────────────────

DEFAULT_NAME=$(hostname -s)
ask "Agent name (identifies this machine on relay) [${DEFAULT_NAME}]: "
read -r AGENT_NAME </dev/tty
AGENT_NAME="${AGENT_NAME:-$DEFAULT_NAME}"

# Sanitize: alphanumeric + hyphen only
AGENT_NAME=$(echo "$AGENT_NAME" | tr -cs 'a-zA-Z0-9-' '-' | sed 's/^-//;s/-$//')
info "Using agent name: ${AGENT_NAME}"

# ── Certificate setup ────────────────────────────────────────────────────────

echo ""
info "Certificate setup"
echo ""
echo "  This agent authenticates to the relay using a TLS client certificate."
echo "  You need:"
echo "    1. ${AGENT_NAME}.key  - private key"
echo "    2. ${AGENT_NAME}.crt  - certificate (issued by relay CA)"
echo "    3. ca.crt             - relay CA certificate"
echo ""
echo "  On base7, run:"
echo "    scripts/issue-cert.sh ${AGENT_NAME}"
echo "  Then copy the 3 files to this machine."
echo ""
ask "Path to directory containing the 3 cert files [/tmp]: "
read -r CERT_SRC </dev/tty
CERT_SRC="${CERT_SRC:-/tmp}"

KEY_SRC="${CERT_SRC}/${AGENT_NAME}.key"
CRT_SRC="${CERT_SRC}/${AGENT_NAME}.crt"
CA_SRC="${CERT_SRC}/ca.crt"

for f in "$KEY_SRC" "$CRT_SRC" "$CA_SRC"; do
  [[ -f "$f" ]] || err "File not found: $f"
done

# Verify cert is signed by our CA
openssl verify -CAfile "$CA_SRC" "$CRT_SRC" > /dev/null 2>&1 || err "Certificate $CRT_SRC is not signed by $CA_SRC"
# Verify CN matches agent name
CERT_CN=$(openssl x509 -noout -subject -in "$CRT_SRC" | sed 's/.*CN\s*=\s*//' | cut -d',' -f1 | tr -d ' ')
[[ "$CERT_CN" == "$AGENT_NAME" ]] || err "Certificate CN='${CERT_CN}' does not match agent name '${AGENT_NAME}'"
ok "Certificate verified (CN=${CERT_CN})"

# ── TMux sessions ────────────────────────────────────────────────────────────

echo ""
ask "TMux sessions to expose (comma-separated, empty = auto-detect all): "
read -r TMUX_SESSIONS </dev/tty

ask "TTY consoles to expose (e.g. tty1, empty = none): "
read -r TTY_SESSIONS </dev/tty

# ── Install ──────────────────────────────────────────────────────────────────

echo ""
info "Installing agent to ${INSTALL_DIR}..."

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# Copy certs — owned by real user (key is private, dir accessible only to owner)
install -m 600 "$KEY_SRC" "${CONFIG_DIR}/${AGENT_NAME}.key"
install -m 644 "$CRT_SRC" "${CONFIG_DIR}/${AGENT_NAME}.crt"
install -m 644 "$CA_SRC"  "${CONFIG_DIR}/ca.crt"
chown -R "${REAL_USER}:${REAL_USER}" "$CONFIG_DIR"
ok "Certificates installed to ${CONFIG_DIR}"

# Download agent files
info "Downloading agent..."
curl -fsSL "https://${RELAY_HOST}/agent/agent.js"    -o "${INSTALL_DIR}/agent.js"
curl -fsSL "https://${RELAY_HOST}/agent/package.json" -o "${INSTALL_DIR}/package.json"
curl -fsSL "https://${RELAY_HOST}/agent/start.sh"    -o "${INSTALL_DIR}/start.sh"
chmod +x "${INSTALL_DIR}/start.sh"
chown -R "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR"

# Write .env
cat > "${INSTALL_DIR}/.env" <<ENV
RELAY_URL=wss://${RELAY_HOST}:${RELAY_AGENT_PORT}/ws
AGENT_NAME=${AGENT_NAME}
AGENT_KEY=${CONFIG_DIR}/${AGENT_NAME}.key
AGENT_CERT=${CONFIG_DIR}/${AGENT_NAME}.crt
CA_CERT=${CONFIG_DIR}/ca.crt
TMUX_SESSIONS=${TMUX_SESSIONS}
TTY_SESSIONS=${TTY_SESSIONS}
ENV
chmod 600 "${INSTALL_DIR}/.env"
chown "${REAL_USER}:${REAL_USER}" "${INSTALL_DIR}/.env"

# npm install (as real user so node_modules are accessible)
info "Installing Node.js dependencies..."
cd "$INSTALL_DIR"
sudo -u "$REAL_USER" npm install --omit=dev --silent
ok "Dependencies installed"

# ── PM2 or systemd ───────────────────────────────────────────────────────────

if command -v pm2 &>/dev/null; then
  info "Setting up PM2 service..."
  sudo -u "$REAL_USER" pm2 start "${INSTALL_DIR}/agent.js" --name "$SERVICE_NAME" --cwd "$INSTALL_DIR"
  sudo -u "$REAL_USER" pm2 save
  ok "Agent running via PM2 (pm2 logs ${SERVICE_NAME})"
else
  info "PM2 not found, setting up systemd service..."
  NODE_BIN=$(command -v node)
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Remote TMux Agent
After=network.target

[Service]
Type=simple
User=${REAL_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/bin/bash ${INSTALL_DIR}/start.sh
Restart=always
RestartSec=5
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  ok "Agent running via systemd (journalctl -u ${SERVICE_NAME} -f)"
fi

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║           Setup complete!            ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
ok "Agent '${AGENT_NAME}' is running and connecting to ${RELAY_HOST}"
info "View in browser: https://${RELAY_HOST}"
echo ""
