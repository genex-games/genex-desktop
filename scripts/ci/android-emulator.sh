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
#
# The emulator is pinned: build 16428233 (37.2.12), the last one the rust-android smoke passed on.
# GitHub's runners moved to 37.2.13 (build 16740729) by 10-29, and there the smoke's app stalled
# before its first resume with an empty logcat (#539, both attempts). A runner whose SDK holds
# another build gets the pinned archive, held to its sha256 before it replaces
# `$ANDROID_HOME/emulator`; a mismatch fails and leaves the runner's emulator as it was.
# GENEX_EMULATOR_URL and GENEX_EMULATOR_SHA256 replace the archive and its pin (the tests' stubs).
set -euo pipefail

AVD_NAME="genex-ci"
BOOT_SECONDS="${GENEX_EMULATOR_BOOT_SECONDS:-600}"
RAM_MB="${GENEX_EMULATOR_RAM_MB:-4096}"
POLL_SECONDS=2
LOG_TAIL_LINES=40
EMULATOR_BUILD="16428233"
EMULATOR_URL="${GENEX_EMULATOR_URL:-https://dl.google.com/android/repository/emulator-linux_x64-$EMULATOR_BUILD.zip}"
EMULATOR_SHA256="${GENEX_EMULATOR_SHA256:-b08fc43d8608d2955f607f1b287beb525041e730086bdca3af152accac3af9c1}"

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

# The SDK's emulator, replaced by the pinned build when it is another one.
pin_emulator() {
  local properties="$ANDROID_HOME/emulator/source.properties"
  if grep -qx "Pkg.BuildId=$EMULATOR_BUILD" "$properties" 2> /dev/null; then return 0; fi
  local work="${RUNNER_TEMP:?RUNNER_TEMP is not set}/emulator-$EMULATOR_BUILD"
  rm -rf "$work"
  mkdir -p "$work"
  curl -fsSL --retry 3 -o "$work/emulator.zip" "$EMULATOR_URL" || fail "could not download the pinned emulator ($EMULATOR_URL)"
  local sum
  sum="$( (sha256sum "$work/emulator.zip" 2> /dev/null || shasum -a 256 "$work/emulator.zip") | cut -d' ' -f1)"
  [ "$sum" = "$EMULATOR_SHA256" ] || fail "the downloaded archive is not the pinned emulator (sha256 $sum, pinned $EMULATOR_SHA256)"
  unzip -q "$work/emulator.zip" -d "$work/unzipped"
  grep -qx "Pkg.BuildId=$EMULATOR_BUILD" "$work/unzipped/emulator/source.properties" ||
    fail "the pinned archive holds no emulator build $EMULATOR_BUILD"
  rm -rf "$ANDROID_HOME/emulator"
  mv "$work/unzipped/emulator" "$ANDROID_HOME/emulator"
  rm -rf "$work"
}

pin_emulator
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
