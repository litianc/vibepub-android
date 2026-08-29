#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_ADB="$TMP_DIR/adb"
cat > "$FAKE_ADB" <<EOF
#!/usr/bin/env bash
touch "$TMP_DIR/adb-was-called"
exit 99
EOF
chmod +x "$FAKE_ADB"

output="$TMP_DIR/output.txt"
if ADB="$FAKE_ADB" \
  "$ROOT_DIR/scripts/verify-android-environment-isolation.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" > "$output" 2>&1; then
  echo "Isolation verifier passed without --serial." >&2
  exit 1
fi

grep -Fq -- '--serial is required' "$output" || {
  echo "Isolation verifier did not explain the required --serial." >&2
  exit 1
}
[[ ! -e "$TMP_DIR/adb-was-called" ]] || {
  echo "Isolation verifier called ADB before requiring --serial." >&2
  exit 1
}

for production_alias in \
  https://vibepub.litianc.cn. \
  https://vibepub.litianc.cn.:443 \
  https://VIBEPUB.LITIANC.CN./; do
  rm -f "$TMP_DIR/adb-was-called"
  if ADB="$FAKE_ADB" \
    "$ROOT_DIR/scripts/verify-android-environment-isolation.sh" \
      "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" \
      --serial synthetic-device --staging-api-url "$production_alias" > "$output" 2>&1; then
    echo "Isolation verifier accepted a trailing-dot Production API alias." >&2
    exit 1
  fi
  grep -Fq 'real isolated Staging HTTPS API URL' "$output"
  [[ ! -e "$TMP_DIR/adb-was-called" ]]
done

touch "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk"

FAKE_AAPT="$TMP_DIR/aapt"
cat > "$FAKE_AAPT" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

apk="$3"
environment="$(basename "$apk" .apk)"
if [[ "$2" == "badging" ]]; then
  if [[ "$environment" == "production" ]]; then
    echo "package: name='cn.litianc.vibepub' versionCode='${FAKE_PRODUCTION_VERSION_CODE:-2}' versionName='${FAKE_PRODUCTION_VERSION_NAME:-test}'"
    echo "application-label:'VibePub'"
  else
    echo "package: name='${FAKE_STAGING_PACKAGE:-cn.litianc.vibepub.staging}' versionCode='${FAKE_STAGING_VERSION_CODE:-2}' versionName='${FAKE_STAGING_VERSION_NAME:-test}'"
    echo "application-label:'VibePub Staging'"
  fi
else
  if [[ "$environment" == "production" ]]; then
    echo 'A: android:scheme="vibepub" (Raw: "vibepub")'
    echo 'A: android:name="cn.litianc.vibepub.GIT_COMMIT" (Raw: "cn.litianc.vibepub.GIT_COMMIT")'
    commit="${FAKE_PRODUCTION_GIT_COMMIT:-0123456789ab}"
    echo "A: android:value=\"$commit\" (Raw: \"$commit\")"
    echo 'A: android:name="cn.litianc.vibepub.DEFAULT_API_BASE_URL" (Raw: "cn.litianc.vibepub.DEFAULT_API_BASE_URL")'
    echo 'A: android:value="https://vibepub.litianc.cn" (Raw: "https://vibepub.litianc.cn")'
  else
    echo 'A: android:scheme="vibepub-staging" (Raw: "vibepub-staging")'
    echo 'A: android:name="cn.litianc.vibepub.GIT_COMMIT" (Raw: "cn.litianc.vibepub.GIT_COMMIT")'
    commit="${FAKE_STAGING_GIT_COMMIT:-0123456789ab}"
    echo "A: android:value=\"$commit\" (Raw: \"$commit\")"
    echo 'A: android:name="cn.litianc.vibepub.DEFAULT_API_BASE_URL" (Raw: "cn.litianc.vibepub.DEFAULT_API_BASE_URL")'
    staging_api_base_url="${FAKE_STAGING_API_BASE_URL:-https://staging.example.test}"
    echo "A: android:value=\"$staging_api_base_url\" (Raw: \"$staging_api_base_url\")"
  fi
fi
EOF

FAKE_APKSIGNER="$TMP_DIR/apksigner"
cat > "$FAKE_APKSIGNER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
environment="$(basename "${@: -1}" .apk)"
if [[ "$environment" == "production" ]]; then
  fingerprint="${FAKE_PRODUCTION_CERTIFICATE_FINGERPRINT:?}"
else
  fingerprint="${FAKE_STAGING_CERTIFICATE_FINGERPRINT:-${FAKE_PRODUCTION_CERTIFICATE_FINGERPRINT:?}}"
fi
echo "Signer #1 certificate SHA-256 digest: $fingerprint"
EOF
chmod +x "$FAKE_AAPT" "$FAKE_APKSIGNER"
PINNED_FINGERPRINT="$(tr -d '[:space:]' < "$ROOT_DIR/android/release-certificate.sha256")"

for production_alias in \
  https://vibepub.litianc.cn. \
  https://vibepub.litianc.cn.:443 \
  https://VIBEPUB.LITIANC.CN./; do
  if AAPT="$FAKE_AAPT" \
    "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
      "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" "$production_alias" \
      --skip-release-certificate > "$output" 2>&1; then
    echo "APK verifier accepted a trailing-dot Production API alias." >&2
    exit 1
  fi
  grep -Fq 'must not be Production' "$output"
done

for exact_invalid in https://invalid https://invalid.; do
  if ALLOW_SYNTHETIC_STAGING_API_URL=true \
    FAKE_STAGING_API_BASE_URL="$exact_invalid" AAPT="$FAKE_AAPT" \
    "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
      "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" "$exact_invalid" \
      --skip-release-certificate > "$output" 2>&1; then
    echo "APK verifier accepted the exact invalid hostname." >&2
    exit 1
  fi
  grep -Fq 'must not use the exact invalid hostname' "$output"
done

ALLOW_SYNTHETIC_STAGING_API_URL=true \
  FAKE_STAGING_API_BASE_URL=https://staging.vibepub.invalid \
  FAKE_PRODUCTION_CERTIFICATE_FINGERPRINT="$PINNED_FINGERPRINT" \
  AAPT="$FAKE_AAPT" APKSIGNER="$FAKE_APKSIGNER" \
  "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" \
    https://staging.vibepub.invalid > "$output"

if FAKE_STAGING_VERSION_CODE=3 \
  AAPT="$FAKE_AAPT" \
  "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" https://staging.example.test \
    --skip-release-certificate > "$output" 2>&1; then
  echo "APK verifier accepted mixed Android versions." >&2
  exit 1
fi
grep -Fq 'same Android version' "$output"

if FAKE_STAGING_GIT_COMMIT=fedcba987654 \
  AAPT="$FAKE_AAPT" \
  "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" https://staging.example.test \
    --skip-release-certificate > "$output" 2>&1; then
  echo "APK verifier accepted mixed Git commits." >&2
  exit 1
fi
grep -Fq 'same Git commit' "$output"

if FAKE_STAGING_PACKAGE=cn.litianc.vibepub \
  AAPT="$FAKE_AAPT" \
  "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" https://staging.example.test \
    --skip-release-certificate > "$output" 2>&1; then
  echo "Debug APK verifier accepted an unsafe Staging package." >&2
  exit 1
fi
grep -Fq 'Unexpected Staging package' "$output"

if FAKE_PRODUCTION_CERTIFICATE_FINGERPRINT="$PINNED_FINGERPRINT" \
  FAKE_STAGING_CERTIFICATE_FINGERPRINT="$(printf 'b%.0s' {1..64})" \
  AAPT="$FAKE_AAPT" APKSIGNER="$FAKE_APKSIGNER" \
  "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" https://staging.example.test > "$output" 2>&1; then
  echo "APK verifier accepted a wrong Staging signing certificate." >&2
  exit 1
fi
grep -Fq 'pinned release certificate' "$output"

FAKE_PRODUCTION_CERTIFICATE_FINGERPRINT="$(printf 'b%.0s' {1..64})" \
  AAPT="$FAKE_AAPT" APKSIGNER="$FAKE_APKSIGNER" \
  "$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" https://staging.example.test \
    --skip-release-certificate > "$output"

FAKE_ADB_LOG="$TMP_DIR/adb.log"
cat > "$FAKE_ADB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${FAKE_ADB_LOG:?}"
shift 2

case "$1" in
  get-state)
    echo device
    ;;
  install)
    [[ "$2" == "--user" && "$3" == "10" ]]
    echo Success
    ;;
  shell)
    if [[ "$2" == "cmd" && "$3" == "package" && "$4" == "list" && "$5" == "packages" ]]; then
      if [[ "$6" == "-U" ]]; then
        package="$9"
        if [[ "$package" == "cn.litianc.vibepub" ]]; then
          echo "package:$package uid:10101"
        else
          echo "package:$package uid:10102"
        fi
      else
        package="$8"
        echo "package:$package"
      fi
    elif [[ "$2" == "am" && "$3" == "get-current-user" ]]; then
      echo 10
    elif [[ "$2" == "pm" && "$3" == "clear" ]]; then
      echo Success
    fi
    ;;
  exec-out)
    [[ "$2" == "run-as" ]]
    package="$3"
    [[ "$4" == "--user" && "$5" == "10" && "$6" == "sh" && "$7" == "-c" ]]
    remote_command="$8"
    if [[ "$remote_command" == *"preferences=shared_prefs/vibepub.xml"* ]]; then
      if [[ "$package" == "cn.litianc.vibepub" ]]; then
        echo authenticated
      elif [[ "${FAKE_STAGING_LOGIN_MODE:-missing}" == "adb-error" ]]; then
        echo "run-as: synthetic error"
      else
        exit 1
      fi
    else
      printf '%064d %064d\n' 0 1
    fi
    ;;
  uninstall)
    echo Success
    ;;
esac
EOF
chmod +x "$FAKE_ADB"

for staging_login_mode in missing adb-error; do
  login_output="$TMP_DIR/login-output-$staging_login_mode.txt"
  : > "$FAKE_ADB_LOG"
  if AAPT="$FAKE_AAPT" APKSIGNER="$FAKE_APKSIGNER" \
    FAKE_PRODUCTION_CERTIFICATE_FINGERPRINT="$PINNED_FINGERPRINT" \
    ADB="$FAKE_ADB" \
    FAKE_ADB_LOG="$FAKE_ADB_LOG" \
    FAKE_STAGING_LOGIN_MODE="$staging_login_mode" \
      "$ROOT_DIR/scripts/verify-android-environment-isolation.sh" \
        "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" \
        --serial synthetic-device \
        --staging-api-url https://staging.example.test > "$login_output" 2>&1; then
    echo "Isolation verifier passed while Staging login was invalid: $staging_login_mode." >&2
    exit 1
  fi

  grep -Fq 'Log into both Production and Staging' "$login_output" || {
    echo "Isolation verifier did not give safe login instructions." >&2
    exit 1
  }
  if grep -Eq 'pm clear|uninstall' "$FAKE_ADB_LOG"; then
    echo "Isolation verifier changed Staging before both apps were logged in." >&2
    exit 1
  fi
  if grep -Eq 'access_token|private-test-token|shared_prefs/' "$login_output"; then
    echo "Isolation verifier exposed private login data." >&2
    exit 1
  fi
  grep -Fq 'run-as cn.litianc.vibepub --user 10' "$FAKE_ADB_LOG"
  grep -Fq 'run-as cn.litianc.vibepub.staging --user 10' "$FAKE_ADB_LOG"
done

echo "Android environment isolation safety tests passed."
