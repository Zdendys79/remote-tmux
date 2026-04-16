#!/usr/bin/env bash
# Issue a client certificate for one agent.
# Usage: ./issue-cert.sh <agent-name>
# Example: ./issue-cert.sh botka
#
# Output (copy both files to the agent machine):
#   certs/<name>.key
#   certs/<name>.crt

set -euo pipefail

AGENT="${1:-}"
if [[ -z "$AGENT" ]]; then
  echo "Usage: $0 <agent-name>"
  exit 1
fi

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERTS_DIR="$BASE_DIR/certs"
CA_KEY="$CERTS_DIR/ca.key"
CA_CRT="$CERTS_DIR/ca.crt"
AGENT_KEY="$CERTS_DIR/${AGENT}.key"
AGENT_CSR="$CERTS_DIR/${AGENT}.csr"
AGENT_CRT="$CERTS_DIR/${AGENT}.crt"

if [[ ! -f "$CA_KEY" ]]; then
  echo "[ERROR] CA not found. Run scripts/setup-ca.sh first."
  exit 1
fi

if [[ -f "$AGENT_CRT" ]]; then
  echo "[ERROR] Certificate for '$AGENT' already exists: $AGENT_CRT"
  echo "        Delete it first if you want to reissue."
  exit 1
fi

echo "[INFO] Generating key for agent '$AGENT'..."
openssl genrsa -out "$AGENT_KEY" 2048
chmod 600 "$AGENT_KEY"

echo "[INFO] Generating certificate signing request..."
openssl req -new \
  -key "$AGENT_KEY" \
  -out "$AGENT_CSR" \
  -subj "/CN=${AGENT}/O=remote-tmux-agent"

echo "[INFO] Signing with CA (2 years)..."
openssl x509 -req -days 730 \
  -in "$AGENT_CSR" \
  -CA "$CA_CRT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$AGENT_CRT"

rm -f "$AGENT_CSR"
chmod 644 "$AGENT_CRT"

echo ""
echo "[OK] Certificate issued for '$AGENT':"
echo "  Key  : $AGENT_KEY"
echo "  Cert : $AGENT_CRT"
echo ""
echo "Copy both files to the agent machine and set in agent/.env:"
echo "  AGENT_KEY=/path/to/${AGENT}.key"
echo "  AGENT_CERT=/path/to/${AGENT}.crt"
echo "  CA_CERT=/path/to/ca.crt"
