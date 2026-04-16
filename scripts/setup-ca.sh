#!/usr/bin/env bash
# Run once on base7 to create the Certificate Authority.
# Output: /home/remotes/remote-tmux/certs/ca.key  (private - NEVER share)
#         /home/remotes/remote-tmux/certs/ca.crt   (public  - copy to agents)

set -euo pipefail

CERTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
CA_KEY="$CERTS_DIR/ca.key"
CA_CRT="$CERTS_DIR/ca.crt"

if [[ -f "$CA_KEY" ]]; then
  echo "[ERROR] CA already exists at $CA_KEY - aborting to prevent overwrite."
  exit 1
fi

mkdir -p "$CERTS_DIR"
chmod 700 "$CERTS_DIR"

echo "[INFO] Generating CA private key..."
openssl genrsa -out "$CA_KEY" 4096
chmod 600 "$CA_KEY"

echo "[INFO] Generating CA certificate (10 years)..."
openssl req -new -x509 -days 3650 \
  -key "$CA_KEY" \
  -out "$CA_CRT" \
  -subj "/CN=remote-tmux-CA/O=remote-tmux"

chmod 644 "$CA_CRT"

echo ""
echo "[OK] CA created:"
echo "  Private key : $CA_KEY  (keep secret!)"
echo "  Certificate : $CA_CRT  (copy to each agent)"
