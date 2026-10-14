#!/usr/bin/env bash
# Creates the CI's Android Virtual Device and boots it headless, or fails within a deadline with the
# emulator's own log. The emulator keeps running after this script (the jobs' later steps use it).
#
#   bash scripts/ci/android-emulator.sh <evidence-dir>
#
# Reads ANDROID_HOME and AVD_IMAGE (the system image), and ANDROID_AVD_HOME when set (otherwise a
# folder under RUNNER_TEMP). The AVD folder is named explicitly for both avdmanager and the
# emulator: on GitHub's runners avdmanager follows XDG_CONFIG_HOME while the emulator reads
# ~/.android/avd, so an implicit folder left the emulator answering "Unknown AVD name" and an
# unbounded `adb wait-for-device` waiting until the job's timeout.
#
# GENEX_EMULATOR_BOOT_SECONDS bounds the boot (default 600). GENEX_EMULATOR_RAM_MB is the guest's
# memory (default 4096): at the emulator's own 2560 MB a google_apis image's first-boot services ran
# the guest out of memory while the smoke's app (arm64, translated) started, and the low-memory
# killer was ending processes for minutes (pass-1 gate round 3, no outcome).
set -euo pipefail

AVD_NAME="genex-ci"
BOOT_SECONDS="${GENEX_EMULATOR_BOOT_SECONDS:-600}"
RAM_MB="${GENEX_EMULATOR_RAM_MB:-4096}"
POLL_SECONDS=2
LOG_TAIL_LINES=40

evidence="${1:?usage: android-emulator.sh <evidence-dir>}"
: "${ANDROID_HOME:?ANDROID_HOME is not set}"
: "${AVD_IMAGE:?AVD_IMAGE is not set}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-${RUNNER_TEMP:?RUNNER_TEMP is not set}/android-avd}"
mkdir -p "$evidence" "$ANDROID_AVD_HOME"

avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
emulator="$ANDROID_HOME/emulator/emulator"
adb="$ANDROID_HOME/platform-tools/adb"
log="$evidence/emulator.log"

fail() {
  echo "::error::$1"
  if [ -f "$log" ]; then
    echo "--- the last $LOG_TAIL_LINES lines of $log"
    tail -n "$LOG_TAIL_LINES" "$log"
  fi
  exit 1
}

echo no | "$avdmanager" create avd --force -n "$AVD_NAME" -k "$AVD_IMAGE"
[ -f "$ANDROID_AVD_HOME/$AVD_NAME.ini" ] ||
  fail "avdmanager made no $AVD_NAME.ini in ANDROID_AVD_HOME ($ANDROID_AVD_HOME)"
"$emulator" -version | head -1 | tee "$evidence/emulator.txt"

args=(-avd "$AVD_NAME" -memory "$RAM_MB" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -feature Vulkan -no-metrics)
if command -v setsid > /dev/null; then
  nohup setsid "$emulator" "${args[@]}" > "$log" 2>&1 &
else
  nohup "$emulator" "${args[@]}" > "$log" 2>&1 &
fi
pid=$!
echo "$pid" > "$evidence/emulator.pid"

deadline=$((SECONDS + BOOT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  kill -0 "$pid" 2> /dev/null || fail "the emulator exited before it booted"
  booted="$("$adb" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r' || true)"
  if [ "$booted" = "1" ]; then
    echo "the emulator booted ($AVD_NAME, $AVD_IMAGE)"
    exit 0
  fi
  sleep "$POLL_SECONDS"
done
fail "the emulator did not finish booting within ${BOOT_SECONDS}s"
