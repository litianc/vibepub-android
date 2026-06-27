#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="$ROOT_DIR/secrets"
mkdir -p "$SECRETS_DIR"

TOKEN="$(openssl rand -base64 48)"
printf 'FILES_TOKEN=%s\n' "$TOKEN" > "$SECRETS_DIR/worker.env"
printf '%s' "$TOKEN" > "$SECRETS_DIR/files-token.txt"

echo "Generated FILES_TOKEN in $SECRETS_DIR/worker.env"
