#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"
ANDROID_SERIAL="${ANDROID_SERIAL:-}"
AUTH_EMAIL="${AUTH_EMAIL:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
OUTPUT_ROOT="${OUTPUT_ROOT:-artifacts/android-auth-cycle}"
WAIT_SECONDS="${WAIT_SECONDS:-20}"

if [[ -z "$ANDROID_SERIAL" ]]; then
  ANDROID_SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi

if [[ -z "$ANDROID_SERIAL" ]]; then
  echo "No authorized Android device found. Set ANDROID_SERIAL." >&2
  exit 1
fi

if [[ -z "$AUTH_EMAIL" || -z "$AUTH_PASSWORD" ]]; then
  echo "Set AUTH_EMAIL and AUTH_PASSWORD for the account to test." >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="$OUTPUT_ROOT/$TIMESTAMP"
mkdir -p "$EVIDENCE_DIR"

adb_cmd() {
  adb -s "$ANDROID_SERIAL" "$@"
}

dump_window() {
  local label="$1"
  adb_cmd shell uiautomator dump "/sdcard/vibepub-${label}.xml" >/dev/null
  adb_cmd pull "/sdcard/vibepub-${label}.xml" "$EVIDENCE_DIR/${label}.xml" >/dev/null
}

screenshot() {
  local label="$1"
  adb_cmd shell screencap -p "/sdcard/vibepub-${label}.png"
  adb_cmd pull "/sdcard/vibepub-${label}.png" "$EVIDENCE_DIR/${label}.png" >/dev/null
}

node_center() {
  local xml_path="$1"
  local attr="$2"
  local pattern="$3"
  local pick="${4:-first}"
  node - "$xml_path" "$attr" "$pattern" "$pick" <<'NODE'
const fs = require("fs");
const [xmlPath, attr, pattern, pick] = process.argv.slice(2);
const xml = fs.readFileSync(xmlPath, "utf8");
const regex = new RegExp(pattern);
const matches = [];
for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
  const node = match[0];
  const value = node.match(new RegExp(`${attr}="([^"]*)"`))?.[1] || "";
  if (!regex.test(value)) continue;
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) continue;
  const [, x1, y1, x2, y2] = bounds.map(Number);
  matches.push({ x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), value });
}
if (!matches.length) process.exit(2);
const chosen = pick === "last" ? matches.at(-1) : matches[0];
process.stdout.write(`${chosen.x} ${chosen.y}`);
NODE
}

tap_node() {
  local xml_path="$1"
  local attr="$2"
  local pattern="$3"
  local pick="${4:-first}"
  local center
  center="$(node_center "$xml_path" "$attr" "$pattern" "$pick")"
  adb_cmd shell input tap $center
}

wait_for_text() {
  local pattern="$1"
  local label="$2"
  local deadline=$((SECONDS + WAIT_SECONDS))
  while (( SECONDS <= deadline )); do
    dump_window "$label" || true
    if node - "$EVIDENCE_DIR/${label}.xml" "$pattern" <<'NODE'
const fs = require("fs");
const [xmlPath, pattern] = process.argv.slice(2);
const xml = fs.readFileSync(xmlPath, "utf8");
process.exit(new RegExp(pattern).test(xml) ? 0 : 1);
NODE
    then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for text pattern: $pattern" >&2
  return 1
}

home_count_from_dump() {
  local xml_path="$1"
  node - "$xml_path" <<'NODE'
const fs = require("fs");
const xml = fs.readFileSync(process.argv[2], "utf8");
const text = [...xml.matchAll(/text="([^"]*)"/g)].map((m) => m[1]).join("\n");
const match = text.match(/(\d+) 条 · 最近同步/);
if (!match) process.exit(2);
process.stdout.write(match[1]);
NODE
}

reset_api_base_preference() {
  local cleaner="$EVIDENCE_DIR/clean-api-pref.sh"
  cat > "$cleaner" <<'SH'
if [ -f shared_prefs/vibepub.xml ]; then
  mkdir -p cache
  grep -v 'name="api_base_url"' shared_prefs/vibepub.xml > cache/vibepub-prefs-clean.xml
  cp cache/vibepub-prefs-clean.xml shared_prefs/vibepub.xml
fi
SH
  adb_cmd push "$cleaner" /data/local/tmp/vibepub-clean-api-pref.sh >/dev/null
  adb_cmd shell chmod 0755 /data/local/tmp/vibepub-clean-api-pref.sh
  adb_cmd shell run-as "$PACKAGE_NAME" sh /data/local/tmp/vibepub-clean-api-pref.sh || true
  adb_cmd shell rm -f /data/local/tmp/vibepub-clean-api-pref.sh
}

install_login_session_from_api() {
  local auth_json current_xml next_xml
  auth_json="$(mktemp)"
  current_xml="$(mktemp)"
  next_xml="$(mktemp)"

  curl -fsS -X POST "https://vibepub.litianc.cn/api/auth/login" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"$AUTH_EMAIL\",\"password\":\"$AUTH_PASSWORD\"}" > "$auth_json"
  chmod 600 "$auth_json"

  if ! adb_cmd exec-out run-as "$PACKAGE_NAME" cat shared_prefs/vibepub.xml > "$current_xml" 2>/dev/null; then
    printf "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n</map>\n" > "$current_xml"
  fi

  AUTH_JSON="$auth_json" CURRENT_XML="$current_xml" NEXT_XML="$next_xml" node <<'NODE'
const fs = require("fs");
const auth = JSON.parse(fs.readFileSync(process.env.AUTH_JSON, "utf8"));
let xml = fs.readFileSync(process.env.CURRENT_XML, "utf8").trim();
if (!xml.includes("<map")) {
  xml = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n</map>";
}
const esc = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const removeNames = [
  "api_base_url",
  "access_token",
  "refresh_token",
  "files_token",
  "user_id",
  "user_email",
  "user_role",
  "email_verified",
  "auth_state_version",
];
for (const name of removeNames) {
  xml = xml
    .replace(new RegExp(`\\n?\\s*<string name="${name}">[\\s\\S]*?<\\/string>`, "g"), "")
    .replace(new RegExp(`\\n?\\s*<boolean name="${name}" value="(?:true|false)"\\s*\\/>`, "g"), "")
    .replace(new RegExp(`\\n?\\s*<long name="${name}" value="\\d+"\\s*\\/>`, "g"), "");
}
const now = Date.now();
const entries = [
  `    <string name="api_base_url">https://vibepub.litianc.cn</string>`,
  `    <string name="access_token">${esc(auth.tokens.access_token)}</string>`,
  `    <string name="refresh_token">${esc(auth.tokens.refresh_token)}</string>`,
  `    <string name="files_token">${esc(auth.tokens.access_token)}</string>`,
  `    <string name="user_id">${esc(auth.user.id)}</string>`,
  `    <string name="user_email">${esc(auth.user.email)}</string>`,
  `    <string name="user_role">${esc(auth.user.role)}</string>`,
  `    <boolean name="email_verified" value="${auth.user.email_verified ? "true" : "false"}" />`,
  `    <long name="auth_state_version" value="${now}" />`,
].join("\n");
xml = xml.replace(/\s*<\/map>\s*$/, `\n${entries}\n</map>\n`);
fs.writeFileSync(process.env.NEXT_XML, xml, { mode: 0o600 });
NODE

  adb_cmd push "$next_xml" /data/local/tmp/vibepub-auth-cycle-prefs.xml >/dev/null
  adb_cmd shell chmod 0644 /data/local/tmp/vibepub-auth-cycle-prefs.xml
  adb_cmd shell am force-stop "$PACKAGE_NAME"
  adb_cmd shell run-as "$PACKAGE_NAME" cp /data/local/tmp/vibepub-auth-cycle-prefs.xml shared_prefs/vibepub.xml
  adb_cmd shell rm -f /data/local/tmp/vibepub-auth-cycle-prefs.xml
  rm -f "$auth_json" "$current_xml" "$next_xml"
}

cat > "$EVIDENCE_DIR/summary.md" <<EOF
# Android Auth Cycle Test

- Package: \`$PACKAGE_NAME\`
- Device: \`$ANDROID_SERIAL\`
- Account: \`$AUTH_EMAIL\`
- Started: \`$(date -u +%Y-%m-%dT%H:%M:%SZ)\`
EOF

reset_api_base_preference
install_login_session_from_api
adb_cmd shell am force-stop "$PACKAGE_NAME"
adb_cmd shell monkey -p "$PACKAGE_NAME" 1 >/dev/null
sleep 5
dump_window "home-before"
screenshot "home-before"

INITIAL_COUNT="$(home_count_from_dump "$EVIDENCE_DIR/home-before.xml")"
if [[ "$INITIAL_COUNT" -lt 1 ]]; then
  echo "Expected at least one recording before logout, got $INITIAL_COUNT." >&2
  exit 1
fi

tap_node "$EVIDENCE_DIR/home-before.xml" "content-desc" "^Settings$"
sleep 2
dump_window "settings-before-logout"
screenshot "settings-before-logout"
tap_node "$EVIDENCE_DIR/settings-before-logout.xml" "text" "^退出登录$"

wait_for_text "AuthScreen|登录后同步录音、风格模板和公众号发布配置" "auth-after-logout"
screenshot "auth-after-logout"

install_login_session_from_api
adb_cmd shell am force-stop "$PACKAGE_NAME"
adb_cmd shell monkey -p "$PACKAGE_NAME" 1 >/dev/null
wait_for_text "我的内容" "home-after-login"
screenshot "home-after-login"
sleep 5
dump_window "home-after-login-refreshed"
screenshot "home-after-login-refreshed"

FINAL_COUNT="$(home_count_from_dump "$EVIDENCE_DIR/home-after-login-refreshed.xml")"
if [[ "$FINAL_COUNT" -lt "$INITIAL_COUNT" ]]; then
  echo "Expected recordings to reload after login. Before=$INITIAL_COUNT after=$FINAL_COUNT." >&2
  exit 1
fi

cat >> "$EVIDENCE_DIR/summary.md" <<EOF

- Initial home recording count: \`$INITIAL_COUNT\`
- Auth screen shown after logout: \`yes\`
- Login session restored through auth API for device reload verification: \`yes\`
- Final home recording count after login: \`$FINAL_COUNT\`
- Result: \`passed\`
EOF

echo "Auth cycle assertion: passed"
echo "Evidence directory:"
echo "  $EVIDENCE_DIR"
