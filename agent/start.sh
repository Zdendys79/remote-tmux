#!/usr/bin/env bash
# Startup wrapper: auto-update agent.js from relay before starting.
# Falls back to current version if relay is unreachable.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_JS="${INSTALL_DIR}/agent.js"

# Read RELAY_URL from .env to derive the base URL
RELAY_BASE=$(grep '^RELAY_URL=' "${INSTALL_DIR}/.env" 2>/dev/null \
  | sed 's|^RELAY_URL=||;s|/ws$||;s|^wss://|https://|;s|^ws://|http://|' \
  | sed 's|:[0-9]*$||')   # strip agent port (7902) — frontend is on standard HTTPS

UPDATE_URL="${RELAY_BASE}/agent/agent.js"

echo "[INFO] Checking for updates from ${UPDATE_URL}..."
TMP=$(mktemp)
if curl -fsSL --max-time 10 "$UPDATE_URL" -o "$TMP" 2>/dev/null; then
  OLD_HASH=$(sha256sum "$AGENT_JS" 2>/dev/null | cut -d' ' -f1 || echo "none")
  NEW_HASH=$(sha256sum "$TMP"      | cut -d' ' -f1)
  if [[ "$OLD_HASH" != "$NEW_HASH" ]]; then
    if cp "$TMP" "$AGENT_JS" 2>/dev/null; then
      echo "[INFO] agent.js updated (${OLD_HASH:0:12} -> ${NEW_HASH:0:12})"
    else
      echo "[WARN] Update downloaded but could not replace agent.js (permission denied), using existing"
    fi
  else
    echo "[INFO] agent.js is up to date"
  fi
else
  echo "[WARN] Could not reach relay for update, using existing agent.js"
fi
rm -f "$TMP"

# Use NODE_BIN from .env if set (handles NVM/non-standard paths)
NODE="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
exec "$NODE" "$AGENT_JS"
