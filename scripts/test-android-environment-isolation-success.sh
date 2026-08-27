#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
touch "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" "$TMP_DIR/staging-installed"

cat > "$TMP_DIR/aapt" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
environment="$(basename "$3" .apk)"
if [[ "$2" == "badging" ]]; then
  if [[ "$environment" == "production" ]]; then
    echo "package: name='cn.litianc.vibepub' versionCode='2' versionName='test'"
    echo "application-label:'VibePub'"
  else
    echo "package: name='cn.litianc.vibepub.staging' versionCode='2' versionName='test'"
    echo "application-label:'VibePub Staging'"
  fi
elif [[ "$environment" == "production" ]]; then
  echo 'A: android:scheme="vibepub" (Raw: "vibepub")'
  echo 'A: android:name="cn.litianc.vibepub.GIT_COMMIT" (Raw: "cn.litianc.vibepub.GIT_COMMIT")'
  echo 'A: android:value="0123456789ab" (Raw: "0123456789ab")'
  echo 'A: android:name="cn.litianc.vibepub.DEFAULT_API_BASE_URL" (Raw: "cn.litianc.vibepub.DEFAULT_API_BASE_URL")'
  echo 'A: android:value="https://vibepub.litianc.cn" (Raw: "https://vibepub.litianc.cn")'
else
  echo 'A: android:scheme="vibepub-staging" (Raw: "vibepub-staging")'
  echo 'A: android:name="cn.litianc.vibepub.GIT_COMMIT" (Raw: "cn.litianc.vibepub.GIT_COMMIT")'
  echo 'A: android:value="0123456789ab" (Raw: "0123456789ab")'
  echo 'A: android:name="cn.litianc.vibepub.DEFAULT_API_BASE_URL" (Raw: "cn.litianc.vibepub.DEFAULT_API_BASE_URL")'
  echo 'A: android:value="https://staging.example.test" (Raw: "https://staging.example.test")'
fi
EOF

cat > "$TMP_DIR/apksigner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "Signer #1 certificate SHA-256 digest: ${FAKE_CERTIFICATE_FINGERPRINT:?}"
EOF

cat > "$TMP_DIR/adb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_ADB_LOG:?}"
shift 2
case "$1" in
  get-state) echo device ;;
  install)
    [[ "$2" == "--user" && "$3" == "10" ]]
    [[ "${6:-}" == *staging.apk ]] && touch "${FAKE_STATE_DIR:?}/staging-installed"
    rm -f "${FAKE_STATE_DIR:?}/staging-cleared"
    echo Success
    ;;
  shell)
    if [[ "$2" == "cmd" && "$3" == "package" && "$4" == "list" && "$5" == "packages" ]]; then
      [[ "${FAKE_PACKAGE_QUERY_FAIL:-false}" != "true" ]]
      if [[ "$6" == "-U" ]]; then
        [[ "$7" == "--user" && "$8" == "10" ]]
        package="$9"
        [[ "$package" == "cn.litianc.vibepub" ]] && uid=10101 || uid=10102
        echo "package:$package uid:$uid"
      else
        [[ "$6" == "--user" && "$7" == "10" ]]
        package="$8"
        if [[ "$package" == "cn.litianc.vibepub.staging" && ! -e "${FAKE_STATE_DIR:?}/staging-installed" ]]; then
          exit 0
        fi
        echo "package:$package"
      fi
    elif [[ "$2" == "pm" && "$3" == "clear" ]]; then
      [[ "$4" == "--user" && "$5" == "10" && "$6" == "cn.litianc.vibepub.staging" ]]
      touch "${FAKE_STATE_DIR:?}/staging-cleared"
      echo Success
    elif [[ "$2" == "pm" && "$3" == "uninstall" ]]; then
      [[ "$4" == "--user" && "$5" == "10" && "$6" == "cn.litianc.vibepub.staging" ]]
      rm -f "${FAKE_STATE_DIR:?}/staging-installed"
      echo Success
    elif [[ "$2" == "am" && "$3" == "get-current-user" ]]; then
      echo 10
    elif [[ "$2" == "am" && "$3" == "force-stop" ]]; then
      [[ "$4" == "--user" && "$5" == "10" ]]
    elif [[ "$2" == "run-as" ]]; then
      [[ "$3" == "--user" && "$4" == "10" ]]
      command="$8"
      [[ "$command" == *"/data/user/10/"* ]]
      [[ "$command" != *"/data/user/0/"* ]]
    fi
    ;;
  exec-out)
    [[ "$2" == "run-as" && "$3" == "--user" && "$4" == "10" ]]
    package="$5"
    command="$8"
    if [[ "$command" == *"printf 'present"* ]]; then
      if [[ "${FAKE_PREFS_QUERY_FAIL:-false}" == "true" && -e "${FAKE_STATE_DIR:?}/staging-cleared" ]]; then
        exit 71
      fi
      [[ -e "${FAKE_STATE_DIR:?}/staging-cleared" ]] && echo absent || echo present
    elif [[ "$command" == *"read_value api_base_url"* ]]; then
      if [[ "$package" == "cn.litianc.vibepub" ]]; then
        printf '%s\n%s\n%s\n' 'https://vibepub.litianc.cn' 'production-session' 'production-user'
      else
        printf '%s\n%s\n%s\n' 'https://staging.example.test' 'staging-session' 'staging-user'
      fi
    elif [[ "$command" == *"preferences=shared_prefs/vibepub.xml"* ]]; then
      true
    else
      printf '%064d %064d\n' 0 1
    fi
    ;;
esac
EOF

cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
config="$(cat)"
if [[ "$config" == *production-session* && "$config" == *'https://vibepub.litianc.cn/api/me'* ]]; then
  echo production >> "${FAKE_HTTP_LOG:?}"
  printf '%s' '{"user":{"id":"production-user"}}'
elif [[ "$config" == *staging-session* && "$config" == *'https://staging.example.test/api/me'* ]]; then
  echo staging >> "${FAKE_HTTP_LOG:?}"
  printf '%s' '{"user":{"id":"staging-user"}}'
else
  exit 1
fi
EOF
chmod +x "$TMP_DIR/aapt" "$TMP_DIR/apksigner" "$TMP_DIR/adb" "$TMP_DIR/curl"
PINNED_FINGERPRINT="$(tr -d '[:space:]' < "$ROOT_DIR/android/release-certificate.sha256")"

AAPT="$TMP_DIR/aapt" APKSIGNER="$TMP_DIR/apksigner" FAKE_CERTIFICATE_FINGERPRINT="$PINNED_FINGERPRINT" \
ADB="$TMP_DIR/adb" CURL="$TMP_DIR/curl" FAKE_HTTP_LOG="$TMP_DIR/http.log" \
FAKE_ADB_LOG="$TMP_DIR/adb.log" FAKE_STATE_DIR="$TMP_DIR" OUTPUT_ROOT="$TMP_DIR/evidence" \
  "$ROOT_DIR/scripts/verify-android-environment-isolation.sh" \
    "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" \
    --serial synthetic-device --staging-api-url https://staging.example.test >"$TMP_DIR/output.txt"

grep -Fq '/data/user/10/cn.litianc.vibepub.staging/' "$TMP_DIR/adb.log"
grep -Fq '/data/user/10/cn.litianc.vibepub/' "$TMP_DIR/adb.log"
if grep -Eq '/data/user/0/|pm clear( --user [0-9]+)? cn\.litianc\.vibepub$|pm uninstall( --user [0-9]+)? cn\.litianc\.vibepub$' "$TMP_DIR/adb.log"; then
  echo "Isolation verifier used an unsafe package operation." >&2
  exit 1
fi
grep -Fq 'install --user 10' "$TMP_DIR/adb.log"
grep -Fq 'pm clear --user 10 cn.litianc.vibepub.staging' "$TMP_DIR/adb.log"
grep -Fq 'pm uninstall --user 10 cn.litianc.vibepub.staging' "$TMP_DIR/adb.log"
grep -Fq 'run-as --user 10 cn.litianc.vibepub' "$TMP_DIR/adb.log"
grep -Fq 'run-as --user 10 cn.litianc.vibepub.staging' "$TMP_DIR/adb.log"
[[ "$(grep -c '^production$' "$TMP_DIR/http.log")" == 1 ]]
[[ "$(grep -c '^staging$' "$TMP_DIR/http.log")" == 1 ]]
if grep -Eq 'production-session|staging-session|production-user|staging-user' "$TMP_DIR/output.txt" "$TMP_DIR/evidence"/*/* 2>/dev/null; then
  echo "Isolation evidence exposed private session data." >&2
  exit 1
fi

rm -rf "$TMP_DIR/evidence"
rm -f "$TMP_DIR/adb.log" "$TMP_DIR/http.log" "$TMP_DIR/staging-cleared"
touch "$TMP_DIR/staging-installed"
if AAPT="$TMP_DIR/aapt" APKSIGNER="$TMP_DIR/apksigner" FAKE_CERTIFICATE_FINGERPRINT="$PINNED_FINGERPRINT" \
  ADB="$TMP_DIR/adb" CURL="$TMP_DIR/curl" FAKE_HTTP_LOG="$TMP_DIR/http.log" \
  FAKE_ADB_LOG="$TMP_DIR/adb.log" FAKE_STATE_DIR="$TMP_DIR" OUTPUT_ROOT="$TMP_DIR/evidence" \
  FAKE_PREFS_QUERY_FAIL=true \
    "$ROOT_DIR/scripts/verify-android-environment-isolation.sh" \
      "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" \
      --serial synthetic-device --staging-api-url https://staging.example.test >"$TMP_DIR/prefs-failure.txt" 2>&1; then
  echo "Isolation verifier accepted a failed preferences query." >&2
  exit 1
fi
grep -Fq 'Could not verify Staging preferences' "$TMP_DIR/prefs-failure.txt"
if grep -Fq 'pm uninstall' "$TMP_DIR/adb.log"; then
  echo "Isolation verifier continued after a failed preferences query." >&2
  exit 1
fi

rm -f "$TMP_DIR/adb.log"
if AAPT="$TMP_DIR/aapt" APKSIGNER="$TMP_DIR/apksigner" FAKE_CERTIFICATE_FINGERPRINT="$PINNED_FINGERPRINT" \
  ADB="$TMP_DIR/adb" CURL="$TMP_DIR/curl" FAKE_HTTP_LOG="$TMP_DIR/http.log" \
  FAKE_ADB_LOG="$TMP_DIR/adb.log" FAKE_STATE_DIR="$TMP_DIR" OUTPUT_ROOT="$TMP_DIR/evidence" \
  FAKE_PACKAGE_QUERY_FAIL=true \
    "$ROOT_DIR/scripts/verify-android-environment-isolation.sh" \
      "$TMP_DIR/production.apk" "$TMP_DIR/staging.apk" \
      --serial synthetic-device --staging-api-url https://staging.example.test >"$TMP_DIR/package-failure.txt" 2>&1; then
  echo "Isolation verifier accepted a failed package query." >&2
  exit 1
fi
grep -Fq 'Could not query Production' "$TMP_DIR/package-failure.txt"
if grep -Fq 'install --user' "$TMP_DIR/adb.log"; then
  echo "Isolation verifier installed before a successful package query." >&2
  exit 1
fi

echo "Android environment isolation success-path tests passed."
