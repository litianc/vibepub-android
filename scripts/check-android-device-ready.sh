#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"
APK_PATH="${1:-}"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-device-readiness/$RUN_ID}"
REQUIRE_TAP="${REQUIRE_TAP:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
CHECK_APK_INSTALL="${CHECK_APK_INSTALL:-true}"
REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-false}"
AUTO_CONFIRM_USB_INSTALL_PROMPT="${AUTO_CONFIRM_USB_INSTALL_PROMPT:-true}"
AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK="${AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK:-true}"
USB_INSTALL_PROMPT_TIMEOUT_SECONDS="${USB_INSTALL_PROMPT_TIMEOUT_SECONDS:-20}"
ADB_INSTALL_TIMEOUT_SECONDS="${ADB_INSTALL_TIMEOUT_SECONDS:-120}"
ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH="${ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH:-false}"
AUTO_CONNECT_WIRELESS_ADB="${AUTO_CONNECT_WIRELESS_ADB:-true}"
WIRELESS_ADB_CONNECT_TARGETS="${WIRELESS_ADB_CONNECT_TARGETS:-}"

usage() {
  cat <<EOF
Usage:
  scripts/check-android-device-ready.sh [path/to/app-debug.apk]

Environment:
  PACKAGE_NAME  Android package. Default: cn.litianc.vibepub.
  OUT_DIR       Readiness report directory.
  REQUIRE_TAP   Also require adb input tap support. Default: false.
  SKIP_INSTALL  Skip install check and inspect installed package. Default: false.
  CHECK_APK_INSTALL
                Check APK installation/readiness. Set false for a fast
                device-only preflight. Default: true.
  REQUIRE_UNLOCKED
                Fail if the device appears locked. Default: false.
  AUTO_CONFIRM_USB_INSTALL_PROMPT
                Tap HyperOS/MIUI "继续安装" USB install prompts while adb
                install is waiting. Default: true.
  AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK
                Repeatedly tap the expected "继续安装" dialog coordinate while
                waiting, because HyperOS can auto-reject before UI dumps
                observe the prompt. Default: true.
  USB_INSTALL_PROMPT_TIMEOUT_SECONDS
                Prompt watcher timeout. Default: 20.
  ADB_INSTALL_TIMEOUT_SECONDS
                Maximum seconds to wait for each adb install attempt before
                failing with diagnostics instead of hanging forever.
                Default: 120.
  ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH
                If adb install reports INSTALL_FAILED_UPDATE_INCOMPATIBLE,
                uninstall the existing package and retry. This clears app data.
                Default: false.
  AUTO_CONNECT_WIRELESS_ADB
                Try adb connect for mDNS-discovered wireless debugging
                endpoints before failing the device preflight. Default: true.
  WIRELESS_ADB_CONNECT_TARGETS
                Optional space/comma-separated host:port targets to try in
                addition to mDNS-discovered _adb-tls-connect endpoints.

Checks whether a USB-connected Android phone is ready for the VibePub
real-device smoke lane.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

truthy() {
  [[ "${1:-}" == "true" || "${1:-}" == "1" || "${1:-}" == "yes" ]]
}

adb_cmd() {
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    adb -s "$ANDROID_SERIAL" "$@"
  else
    adb "$@"
  fi
}

adb_shell() {
  adb_cmd shell "$@"
}

current_display_size() {
  local display_size

  display_size="$(adb_shell dumpsys window displays 2>/dev/null \
    | sed -n 's/.*cur=\([0-9][0-9]*\)x\([0-9][0-9]*\).*/\1x\2/p' \
    | head -n 1)"
  if [[ -z "$display_size" ]]; then
    display_size="$(adb_shell dumpsys display 2>/dev/null \
      | sed -n 's/.*mOverrideDisplayInfo=.*real \([0-9][0-9]*\) x \([0-9][0-9]*\).*/\1x\2/p' \
      | head -n 1)"
  fi
  if [[ -z "$display_size" ]]; then
    display_size="$(adb_shell wm size 2>/dev/null | awk -F': ' '/Physical size/ { print $2; exit }')"
  fi

  echo "$display_size"
}

tap_usb_install_prompt_until() {
  local label="$1"
  local watched_pid="$2"

  if ! truthy "$AUTO_CONFIRM_USB_INSTALL_PROMPT"; then
    return 0
  fi

  local deadline=$((SECONDS + USB_INSTALL_PROMPT_TIMEOUT_SECONDS))
  local tap_file="$OUT_DIR/${label}-usb-install-prompt-tap.txt"
  local screen_size width height fallback_x fallback_y

  screen_size="$(current_display_size)"
  width="${screen_size%x*}"
  height="${screen_size#*x}"
  if [[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]]; then
    fallback_x="${USB_INSTALL_PROMPT_TAP_X:-$((width * 42 / 100))}"
    fallback_y="${USB_INSTALL_PROMPT_TAP_Y:-$((height * 64 / 100))}"
  else
    fallback_x="${USB_INSTALL_PROMPT_TAP_X:-1266}"
    fallback_y="${USB_INSTALL_PROMPT_TAP_Y:-1203}"
  fi

  while kill -0 "$watched_pid" >/dev/null 2>&1 && (( SECONDS < deadline )); do
    if truthy "$AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK"; then
      adb_shell input tap "$fallback_x" "$fallback_y" >> "$tap_file" 2>&1 || true
      echo "Fallback-tapped expected HyperOS USB install prompt at $fallback_x,$fallback_y" >> "$tap_file"
    fi
    sleep 0.15
  done
}

run_with_usb_install_prompt_taps() {
  local label="$1"
  local output_file="$2"
  shift 2

  "$@" > "$output_file" 2>&1 &
  local install_pid=$!
  tap_usb_install_prompt_until "$label" "$install_pid" &
  local tap_pid=$!
  local deadline=$((SECONDS + ADB_INSTALL_TIMEOUT_SECONDS))
  local status=0

  while kill -0 "$install_pid" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      {
        echo
        echo "Timed out after ${ADB_INSTALL_TIMEOUT_SECONDS}s waiting for adb install to finish."
        echo "This usually means HyperOS/MIUI is holding the install flow behind a device-side prompt or wireless ADB install restriction."
      } >> "$output_file"
      kill "$install_pid" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "$install_pid" >/dev/null 2>&1 || true
      wait "$install_pid" >/dev/null 2>&1 || true
      wait "$tap_pid" >/dev/null 2>&1 || true
      echo "adb install timed out after ${ADB_INSTALL_TIMEOUT_SECONDS}s" > "$OUT_DIR/${label}-timeout.txt"
      return 124
    fi
    sleep 0.2
  done

  wait "$install_pid" || status=$?
  wait "$tap_pid" >/dev/null 2>&1 || true
  return "$status"
}

install_apk() {
  local apk_path="$1"

  adb_cmd devices -l > "$OUT_DIR/adb-devices-before-install.txt" || true

  adb_shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
  sleep 0.3

  install_from_device_tmp() {
    local label="$1"

    adb_cmd push "$apk_path" /data/local/tmp/vibepub-app-debug.apk \
      > "$OUT_DIR/${label}-push.txt" 2>&1
    run_with_usb_install_prompt_taps \
      "$label-pm" \
      "$OUT_DIR/${label}-pm.txt" \
      adb_cmd shell pm install -r -t -g /data/local/tmp/vibepub-app-debug.apk
  }

  maybe_handle_signature_mismatch() {
    local install_output="$1"
    local retry_label="$2"

    if ! grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE" "$install_output"; then
      return 1
    fi

    if ! truthy "$ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH"; then
      {
        echo "Existing $PACKAGE_NAME install has a different signing key."
        echo "Refusing to uninstall automatically because that clears app data."
        echo "Set ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH=true to allow a clean reinstall."
      } > "$OUT_DIR/install-signature-mismatch.txt"
      return 2
    fi

    adb_cmd uninstall "$PACKAGE_NAME" > "$OUT_DIR/install-uninstall-incompatible.txt" 2>&1 || true
    if install_from_device_tmp "$retry_label"; then
      return 0
    fi
    return 2
  }

  if run_with_usb_install_prompt_taps \
    "install" \
    "$OUT_DIR/install.txt" \
    adb_cmd install -r -t -g "$apk_path"; then
    return 0
  fi

  local mismatch_status=0
  maybe_handle_signature_mismatch "$OUT_DIR/install.txt" "install-after-uninstall" || mismatch_status=$?
  if [[ "$mismatch_status" -eq 0 ]]; then
    return 0
  fi
  if [[ "$mismatch_status" -ne 1 ]]; then
    return 1
  fi

  if ! grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt" &&
    [[ ! -f "$OUT_DIR/install-timeout.txt" ]]; then
    return 1
  fi

  if install_from_device_tmp "install-fallback"; then
    return 0
  fi

  mismatch_status=0
  maybe_handle_signature_mismatch "$OUT_DIR/install-fallback-pm.txt" "install-fallback-after-uninstall" || mismatch_status=$?
  if [[ "$mismatch_status" -eq 0 ]]; then
    return 0
  fi
  if [[ "$mismatch_status" -ne 1 ]]; then
    return 1
  fi

  return 1
}

mkdir -p "$OUT_DIR"

failures=0
device_locked=false
report="$OUT_DIR/readiness.md"

{
  echo "# Android Device Readiness"
  echo
  echo "- Package: \`$PACKAGE_NAME\`"
  echo "- APK: \`${APK_PATH:-not provided}\`"
  echo
} > "$report"

check_pass() {
  echo "- [x] $1" >> "$report"
}

check_fail() {
  echo "- [ ] $1" >> "$report"
  failures=$((failures + 1))
}

capture_macos_usb_snapshot() {
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v system_profiler >/dev/null 2>&1; then
    return 0
  fi

  system_profiler SPUSBDataType > "$OUT_DIR/macos-usb.txt" 2>&1 || true
  if command -v rg >/dev/null 2>&1; then
    rg -i "redmi|xiaomi|android|mtp|adb|portable|tablet|phone|usb" \
      -C 2 "$OUT_DIR/macos-usb.txt" > "$OUT_DIR/macos-usb-android-filter.txt" || true
  else
    grep -Ei -C 2 "redmi|xiaomi|android|mtp|adb|portable|tablet|phone|usb" \
      "$OUT_DIR/macos-usb.txt" > "$OUT_DIR/macos-usb-android-filter.txt" || true
  fi
}

capture_wireless_adb_snapshot() {
  adb mdns services > "$OUT_DIR/adb-mdns-services.txt" 2>&1 || true
  awk '
    $0 ~ /_adb-tls-connect\._tcp/ {
      for (i = NF; i >= 1; i--) {
        if ($i ~ /^[0-9A-Za-z_.:-]+:[0-9]+$/) {
          print $i
          next
        }
      }
    }
  ' "$OUT_DIR/adb-mdns-services.txt" | sort -u > "$OUT_DIR/adb-mdns-connect-targets.txt"
}

wireless_connect_targets() {
  {
    if [[ -n "$WIRELESS_ADB_CONNECT_TARGETS" ]]; then
      printf '%s\n' "$WIRELESS_ADB_CONNECT_TARGETS" | tr ', ' '\n'
    fi
    if [[ -f "$OUT_DIR/adb-mdns-connect-targets.txt" ]]; then
      cat "$OUT_DIR/adb-mdns-connect-targets.txt"
    fi
  } | awk 'NF > 0' | sort -u
}

try_wireless_adb_connects() {
  if ! truthy "$AUTO_CONNECT_WIRELESS_ADB"; then
    return 0
  fi

  wireless_connect_targets > "$OUT_DIR/adb-wireless-connect-targets.txt"
  if [[ ! -s "$OUT_DIR/adb-wireless-connect-targets.txt" ]]; then
    return 0
  fi

  : > "$OUT_DIR/adb-wireless-connect.txt"
  while IFS= read -r target; do
    {
      echo "## adb connect $target"
      adb connect "$target" || true
      echo
    } >> "$OUT_DIR/adb-wireless-connect.txt" 2>&1
  done < "$OUT_DIR/adb-wireless-connect-targets.txt"
}

append_connection_hints() {
  local visible_count="$1"
  local authorized_count="$2"
  local unauthorized_count="$3"
  local offline_count="$4"

  capture_macos_usb_snapshot

  cat >> "$report" <<EOF

## ADB Connection Diagnosis

- Visible adb rows: \`$visible_count\`
- Authorized devices: \`$authorized_count\`
- Unauthorized devices: \`$unauthorized_count\`
- Offline devices: \`$offline_count\`
- Raw adb list: \`$OUT_DIR/adb-devices.txt\`
EOF

  if [[ -f "$OUT_DIR/adb-mdns-services.txt" ]]; then
    echo "- Wireless debugging mDNS services: \`$OUT_DIR/adb-mdns-services.txt\`" >> "$report"
  fi
  if [[ -s "$OUT_DIR/adb-wireless-connect-targets.txt" ]]; then
    echo "- Wireless connect targets tried: \`$OUT_DIR/adb-wireless-connect-targets.txt\`" >> "$report"
  fi
  if [[ -f "$OUT_DIR/adb-wireless-connect.txt" ]]; then
    echo "- Wireless connect output: \`$OUT_DIR/adb-wireless-connect.txt\`" >> "$report"
  fi

  if [[ -f "$OUT_DIR/macos-usb-android-filter.txt" ]]; then
    echo "- macOS USB snapshot: \`$OUT_DIR/macos-usb-android-filter.txt\`" >> "$report"
  fi

  if [[ "$visible_count" -eq 0 ]]; then
    cat >> "$report" <<EOF

No Android device is visible to adb yet. Fix the physical/data connection first:

1. Use a data-capable USB cable and connect directly to the Mac, not through a hub.
2. Keep the phone/tablet unlocked and screen awake.
3. On the device USB notification, choose File transfer / MTP / 传输文件.
4. In Developer options, enable USB debugging. If already enabled, toggle it off and on.
5. If no RSA prompt appears, revoke USB debugging authorizations, unplug, replug, then allow the prompt.

If the macOS USB snapshot has no Android/Xiaomi/Redmi/MTP row, macOS is not
enumerating the device at the USB layer; try another cable, port, or adapter
before changing app or APK settings.
EOF

    if [[ -s "$OUT_DIR/adb-mdns-connect-targets.txt" ]]; then
      cat >> "$report" <<EOF

Wireless debugging is advertising a connect endpoint, but adb still has no
authorized device row after the automatic connect attempt. This usually means
the wireless debugging port expired, pairing is missing, or the tablet rejected
the TCP connection. Open the device's Wireless debugging screen, keep it awake,
then either:

1. Pair again with \`adb pair <pair-ip>:<pair-port>\` using the fresh pairing
   code, then rerun this preflight.
2. Or copy the fresh connect address shown on that screen and rerun with
   \`WIRELESS_ADB_CONNECT_TARGETS=<connect-ip>:<connect-port>\`.

If \`ANDROID_SERIAL\` is set to an old wireless address, unset it or update it
to the new connected serial.
EOF
    fi
  fi

  if [[ "$unauthorized_count" -gt 0 ]]; then
    cat >> "$report" <<EOF

At least one device is visible but unauthorized. Unlock it, accept the RSA
fingerprint prompt, and choose always allow. If the prompt is missing, use
Developer options -> Revoke USB debugging authorizations, then reconnect.
EOF
  fi

  if [[ "$offline_count" -gt 0 ]]; then
    cat >> "$report" <<EOF

At least one device is offline. Run \`adb reconnect offline\`, unplug/replug the
device, and toggle USB debugging if it stays offline.
EOF
  fi

  if [[ "$authorized_count" -gt 1 && -z "${ANDROID_SERIAL:-}" ]]; then
    cat >> "$report" <<EOF

Multiple authorized devices are connected. Rerun with
\`ANDROID_SERIAL=<device-id>\` or \`--serial <device-id>\` on wrapper scripts.
EOF
  fi

  cat >> "$report" <<EOF

For wireless debugging, pair/connect only after the Mac and Android device are
on the same reachable network. Pairing codes and ports expire, so use fresh
values from the current Wireless debugging screen.
EOF
}

if ! command -v adb >/dev/null 2>&1; then
  check_fail "adb is installed"
  echo "Missing adb. Install with: brew install --cask android-platform-tools" >&2
  exit 1
fi
check_pass "adb is installed"

count_adb_rows() {
  local serial="$1"
  local target_state="$2"

  awk -v serial="$serial" -v target_state="$target_state" '
    function adb_state(line) {
      if (line ~ /[[:space:]]unauthorized([[:space:]]|$)/) return "unauthorized"
      if (line ~ /[[:space:]]offline([[:space:]]|$)/) return "offline"
      if (line ~ /[[:space:]]device([[:space:]]|$)/) return "device"
      return ""
    }
    NR > 1 && $0 !~ /^[[:space:]]*$/ {
      if (serial != "" && index($0, serial) != 1) next
      if (target_state == "visible" || adb_state($0) == target_state) count++
    }
    END { print count + 0 }
  ' "$OUT_DIR/adb-devices.txt"
}

adb start-server >/dev/null
adb devices -l > "$OUT_DIR/adb-devices-initial.txt"
cp "$OUT_DIR/adb-devices-initial.txt" "$OUT_DIR/adb-devices.txt"
capture_wireless_adb_snapshot
try_wireless_adb_connects
adb devices -l > "$OUT_DIR/adb-devices.txt"
visible_count="$(count_adb_rows "${ANDROID_SERIAL:-}" "visible")"
device_count="$(count_adb_rows "${ANDROID_SERIAL:-}" "device")"
unauthorized_count="$(count_adb_rows "${ANDROID_SERIAL:-}" "unauthorized")"
offline_count="$(count_adb_rows "${ANDROID_SERIAL:-}" "offline")"

if [[ "$device_count" -eq 1 ]]; then
  check_pass "exactly one authorized Android device is connected"
else
  check_fail "exactly one authorized Android device is connected"
  append_connection_hints "$visible_count" "$device_count" "$unauthorized_count" "$offline_count"
  cat "$report"
  echo
  echo "Device readiness failed before device-dependent checks. Report: $report" >&2
  exit 1
fi

if [[ "$device_count" -ge 1 ]]; then
  adb_shell getprop ro.product.model > "$OUT_DIR/device-model.txt" || true
  adb_shell getprop ro.build.version.release > "$OUT_DIR/android-version.txt" || true
  check_pass "device properties captured"

  adb_shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  adb_shell dumpsys power > "$OUT_DIR/power.txt" 2>&1 || true
  adb_shell dumpsys window > "$OUT_DIR/window.txt" 2>&1 || true
  if grep -Eq 'mDreamingLockscreen=true|mShowingLockscreen=true|mInputRestricted=true|isStatusBarKeyguard=true' \
    "$OUT_DIR/power.txt" "$OUT_DIR/window.txt"; then
    device_locked=true
    if truthy "$REQUIRE_UNLOCKED"; then
      check_fail "device is awake and unlocked"
    else
      echo "- [~] device appears locked; unlock it before install/smoke runs" >> "$report"
    fi
  else
    check_pass "device is awake and unlocked"
  fi
fi

if adb_shell input tap 1 1 > "$OUT_DIR/input-tap.txt" 2>&1; then
  check_pass "adb input tap is allowed"
else
  if truthy "$REQUIRE_TAP"; then
    check_fail "adb input tap is allowed"
  else
    echo "- [~] adb input tap is blocked, but default debug-broadcast mode does not require it" >> "$report"
  fi
fi

if ! truthy "$CHECK_APK_INSTALL"; then
  echo "- [~] APK install/run-as checks skipped by CHECK_APK_INSTALL=false" >> "$report"
elif [[ -n "$APK_PATH" ]]; then
  if [[ ! -f "$APK_PATH" ]]; then
    check_fail "APK file exists"
  else
    check_pass "APK file exists"

    if truthy "$device_locked"; then
      check_fail "device is unlocked before APK install/run-as checks"
      echo "  - Unlock the phone/tablet, keep the screen awake, then rerun." >> "$report"
      echo "  - APK install and run-as checks were skipped to avoid HyperOS/MIUI install restrictions while locked." >> "$report"
    elif truthy "$SKIP_INSTALL"; then
      if adb_shell dumpsys package "$PACKAGE_NAME" > "$OUT_DIR/installed-package.txt" 2>&1; then
        check_pass "package is already installed on the phone"
      else
        check_fail "package is already installed on the phone"
      fi
      if adb_shell run-as "$PACKAGE_NAME" id > "$OUT_DIR/run-as.txt" 2>&1; then
        check_pass "run-as works for debug preference injection"
      else
        check_fail "run-as works for debug preference injection"
      fi
    else
      if install_apk "$APK_PATH"; then
        check_pass "ADB can install the APK"
      else
        check_fail "ADB can install the APK"
        if [[ -f "$OUT_DIR/install-timeout.txt" ]]; then
          echo "  - adb install timed out; see install.txt and install-timeout.txt." >> "$report"
          echo "  - On HyperOS/MIUI, prefer a USB data connection for APK installation, or install the APK manually and rerun with SKIP_INSTALL=true RESET_APP_DATA=false." >> "$report"
        fi
        if grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
          echo "  - Enable USB 安装 / Install via USB on the phone." >> "$report"
          if grep -Eq '^[^[:space:]]+:[0-9]+[[:space:]]+device|_adb-tls-connect\._tcp[[:space:]]+device' \
            "$OUT_DIR/adb-devices-before-install.txt" 2>/dev/null; then
            echo "  - This device is connected through wireless debugging; HyperOS can still reject APK installs over wireless ADB even when USB 安装 is enabled." >> "$report"
            echo "  - Connect the tablet by USB for installation, or install the APK manually first and rerun with SKIP_INSTALL=true RESET_APP_DATA=false." >> "$report"
          fi
          echo "  - Fallback pm install also failed; see install-fallback-pm.txt if present." >> "$report"
        fi
        if grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE" "$OUT_DIR/install.txt"; then
          echo "  - Existing package signature differs from this APK." >> "$report"
          echo "  - Uninstall the old app manually, or rerun with ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH=true if clearing app data is acceptable." >> "$report"
          echo "  - See install-signature-mismatch.txt if present." >> "$report"
        fi
      fi

      if adb_shell run-as "$PACKAGE_NAME" id > "$OUT_DIR/run-as.txt" 2>&1; then
        check_pass "run-as works for debug preference injection"
      else
        check_fail "run-as works for debug preference injection"
      fi
    fi
  fi
else
  echo "- [~] APK install/run-as checks skipped because no APK path was provided" >> "$report"
fi

cat >> "$report" <<EOF

## Xiaomi / HyperOS Hints

If install or reset is blocked, enable these Developer options:

- USB 安装 / Install via USB
- USB 调试（安全设置） / USB debugging (Security settings)
- 允许通过 USB 调试修改权限或模拟点击

On HyperOS/MIUI, wireless debugging can still return
\`INSTALL_FAILED_USER_RESTRICTED\` for APK installs even when those switches are
enabled. If that happens, use a USB data connection for installation, or install
the APK manually and rerun smoke tests with \`SKIP_INSTALL=true RESET_APP_DATA=false\`.

If \`INSTALL_FAILED_UPDATE_INCOMPATIBLE\` appears, the package already installed
on the device was signed with a different key. ADB cannot update it in place.
Uninstall the old app manually, or rerun with
\`ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH=true\` when clearing app data is OK.

Default VibePub automation uses \`AUTOMATION_MODE=debug-broadcast\`, so tap
injection is optional. ADB install and debug \`run-as\` are still required for
deterministic automated tests.
EOF

cat "$report"

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "Device readiness failed. Report: $report" >&2
  exit 1
fi

echo
echo "Device readiness passed. Report: $report"
