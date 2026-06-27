#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="$ROOT_DIR/secrets"
KEYSTORE_PATH="$SECRETS_DIR/vibepub-release.keystore"
ALIAS="${VIBEPUB_RELEASE_KEY_ALIAS:-vibepub}"
STORE_PASSWORD="${VIBEPUB_RELEASE_STORE_PASSWORD:-$(openssl rand -base64 32)}"
KEY_PASSWORD="${VIBEPUB_RELEASE_KEY_PASSWORD:-$STORE_PASSWORD}"

mkdir -p "$SECRETS_DIR"

if [[ -f "$KEYSTORE_PATH" ]]; then
  echo "Keystore already exists: $KEYSTORE_PATH" >&2
  exit 1
fi

keytool -genkeypair \
  -v \
  -keystore "$KEYSTORE_PATH" \
  -storepass "$STORE_PASSWORD" \
  -keypass "$KEY_PASSWORD" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=VibePub, OU=Internal, O=Litianc, L=Shanghai, ST=Shanghai, C=CN"

base64 < "$KEYSTORE_PATH" | tr -d '\n' > "$SECRETS_DIR/android-keystore-base64.txt"

cat > "$SECRETS_DIR/android-release-secrets.env" <<EOF
ANDROID_KEYSTORE_BASE64=$(cat "$SECRETS_DIR/android-keystore-base64.txt")
ANDROID_KEYSTORE_PASSWORD=$STORE_PASSWORD
ANDROID_KEY_ALIAS=$ALIAS
ANDROID_KEY_PASSWORD=$KEY_PASSWORD
EOF

echo "Generated release keystore under $SECRETS_DIR"
echo "Keep these files private and backed up."
