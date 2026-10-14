#!/usr/bin/env bash
# M0a.16 spike only (M5.1 replaces it with the iOS lane): package the pond on the iOS shell
# (genex-platform-ios, `examples/pond_ios.rs`) as a Simulator .app and a device .app.
#
#   bash scripts/spike/rust-wgpu/ios-app.sh --simulator --no-boot     # ad hoc signed Simulator .app
#   bash scripts/spike/rust-wgpu/ios-app.sh --device --no-boot        # unsigned device .app
#   bash scripts/spike/rust-wgpu/ios-app.sh --check-plist <Info.plist>
#   bash scripts/spike/rust-wgpu/ios-app.sh --check-app <Pond.app> (--simulator | --device)
#
# - The host-written Info.plist (scripts/spike/rust-wgpu/ios/Info.plist, or --plist <file>) is
#   checked before anything is built: every required key present, MinimumOSVersion 16.0.
# - The executable is built through rust-env.sh (pinned sysroot, vendored crates, offline, locked)
#   for aarch64-apple-ios-sim or aarch64-apple-ios, and checked: arm64 Mach-O, LC_BUILD_VERSION
#   platform IOSSIMULATOR or IOS, minos 16.0.
# - The Simulator .app is signed ad hoc (`codesign --sign -`, no identity) and must pass
#   `codesign --verify --strict`. The device .app stays unsigned: the owner signs it with their
#   team and profile (M0a.11). No identity, keychain or provisioning profile is ever read here.
# - Nothing is booted, installed or launched: the Simulator and the iPhone are the person's
#   (containment stage 1). `--no-boot` states that; `--boot` is refused.
#
# Outputs go to GENEX_MOBILE_OUT (default <repo>/.studio-dev/spike-mobile/out)/ios/<platform>/,
# the evidence record to <repo>/.studio-dev/evidence/m0a/m0a.16/ios-<platform>.json.
# A refusal prints one typed line on stderr and exits 1:
#   genex-mobile: {"code":"<code>","detail":"<text>"}
# Written for the bash 3.2 macOS ships; bash 3.2 clears errexit inside $(...), so functions
# start with `set -e` again.

set -euo pipefail

MOBILE_REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
MOBILE_SPIKE="$MOBILE_REPO/scripts/spike/rust-wgpu"
MOBILE_OUT="${GENEX_MOBILE_OUT:-$MOBILE_REPO/.studio-dev/spike-mobile/out}"
MOBILE_EVIDENCE="${GENEX_MOBILE_EVIDENCE:-$MOBILE_REPO/.studio-dev/evidence/m0a/m0a.16}"
MOBILE_FAIL_EXIT=1
MOBILE_MIN_FREE_GB=5

IOS_MINOS="16.0"
IOS_TEMPLATE="$MOBILE_SPIKE/ios/Info.plist"
IOS_APP_NAME="Pond.app"
IOS_EXECUTABLE="pond"
IOS_PACKAGE="genex-platform-ios"
IOS_EXAMPLE="pond_ios"
# Keys the Simulator and the device refuse to install or launch without (plus the spike's own).
IOS_REQUIRED_KEYS="CFBundleIdentifier CFBundleExecutable CFBundlePackageType CFBundleShortVersionString CFBundleVersion MinimumOSVersion UISupportedInterfaceOrientations UILaunchScreen UIDeviceFamily"

mobile_json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

# Print the typed refusal line and exit 1.
mobile_fail() {
  printf 'genex-mobile: {"code":"%s","detail":"%s"}\n' "$1" "$(mobile_json_escape "$2")" >&2
  exit "$MOBILE_FAIL_EXIT"
}

mobile_log() {
  printf 'ios-app: %s\n' "$*" >&2
}

usage() {
  mobile_fail usage "usage: ios-app.sh (--simulator | --device)... --no-boot [--plist <file>] | --check-plist <file> | --check-app <app> (--simulator | --device)"
}

# The plist's value for a key as XML (any type), or nothing when the key is missing.
plist_value() {
  set -e
  plutil -extract "$2" xml1 -o - "$1" 2>/dev/null || true
}

check_plist() {
  set -e
  local plist=$1 key minos
  [ -f "$plist" ] || mobile_fail plist-missing "no Info.plist at $plist"
  plutil -lint -s "$plist" >/dev/null 2>&1 || mobile_fail plist-invalid "$plist is not a valid property list"
  for key in $IOS_REQUIRED_KEYS; do
    [ -n "$(plist_value "$plist" "$key")" ] || mobile_fail plist-key-missing "$plist has no $key"
  done
  minos=$(plutil -extract MinimumOSVersion raw -o - "$plist" 2>/dev/null || true)
  [ "$minos" = "$IOS_MINOS" ] || mobile_fail plist-minimum-os "$plist: MinimumOSVersion $minos, not $IOS_MINOS"
}

# platform and minos of a Mach-O's LC_BUILD_VERSION, as "<platform> <minos>".
build_version() {
  set -e
  xcrun vtool -show-build "$1" 2>/dev/null | awk '
    $1 == "platform" { platform = $2 }
    $1 == "minos" { minos = $2 }
    END { print platform, minos }'
}

check_executable() {
  set -e
  local exe=$1 want=$2 facts platform minos
  [ -f "$exe" ] || mobile_fail executable-missing "no executable at $exe"
  [ "$(lipo -archs "$exe" 2>/dev/null || true)" = arm64 ] || mobile_fail executable-not-arm64 "$exe is not a thin arm64 Mach-O"
  facts=$(build_version "$exe")
  platform=${facts%% *}
  minos=${facts##* }
  [ "$platform" = "$want" ] || mobile_fail executable-platform "$exe: platform $platform, not $want"
  [ "$minos" = "$IOS_MINOS" ] || mobile_fail executable-minos "$exe: minos $minos, not $IOS_MINOS"
}

# check_app <app> <simulator|device>: the plist, the executable and (Simulator) the signature.
check_app() {
  set -e
  local app=$1 platform=$2 exe
  [ -d "$app" ] || mobile_fail app-missing "no .app at $app"
  check_plist "$app/Info.plist"
  exe="$app/$(plutil -extract CFBundleExecutable raw -o - "$app/Info.plist")"
  case $platform in
    simulator)
      check_executable "$exe" IOSSIMULATOR
      codesign --verify --strict --verbose=2 "$app" >/dev/null 2>&1 ||
        mobile_fail app-unsigned "$app does not pass codesign --verify --strict"
      ;;
    device) check_executable "$exe" IOS ;;
    *) usage ;;
  esac
}

require_disk() {
  set -e
  local free
  free=$(df -g "$MOBILE_REPO" | awk 'NR == 2 { print $4 }')
  [ "$free" -ge "$MOBILE_MIN_FREE_GB" ] ||
    mobile_fail disk "$free GB free, an iOS build needs $MOBILE_MIN_FREE_GB GB (cargo clean the shared target first)"
}

# build_app <simulator|device> <plist>: build, assemble, sign (Simulator) and check one .app.
build_app() {
  set -e
  local platform=$1 plist=$2 target supported dir app log ms exe
  case $platform in
    simulator) target=aarch64-apple-ios-sim supported=iPhoneSimulator ;;
    device) target=aarch64-apple-ios supported=iPhoneOS ;;
  esac
  require_disk
  # shellcheck source=cross-lib.sh
  . "$MOBILE_SPIKE/cross-lib.sh"
  CROSS_NAME=ios-app
  log="$MOBILE_EVIDENCE/ios-$platform-build.jsonl"
  mobile_log "building $IOS_EXAMPLE for $target"
  ms=$(cross_cargo "$log" build -p "$IOS_PACKAGE" --example "$IOS_EXAMPLE" --release --target "$target" --offline --locked)
  exe=$(cross_artifact "$log" "$IOS_PACKAGE" "$IOS_EXAMPLE" example)
  dir="$MOBILE_OUT/ios/$platform"
  app="$dir/$IOS_APP_NAME"
  rm -rf "$app"
  mkdir -p "$app"
  cp -f "$exe" "$app/$IOS_EXECUTABLE"
  cp -f "$plist" "$app/Info.plist"
  plutil -replace CFBundleSupportedPlatforms -json "[\"$supported\"]" "$app/Info.plist"
  plutil -convert binary1 "$app/Info.plist"
  printf 'APPL????' >"$app/PkgInfo"
  if [ "$platform" = simulator ]; then
    # Ad hoc: no identity, no keychain, no provisioning profile.
    codesign --force --sign - --timestamp=none "$app" >/dev/null 2>&1 || mobile_fail sign-failed "ad hoc codesign of $app failed"
  fi
  check_app "$app" "$platform"
  write_record "$platform" "$target" "$app" "$ms"
}

write_record() {
  set -e
  local platform=$1 target=$2 app=$3 ms=$4 signed=false next
  [ "$platform" = simulator ] && signed=true
  next="person: xcrun simctl install booted $app (M0a.11)"
  [ "$platform" = device ] &&
    next="owner: sign with their team (codesign --sign <Apple Development identity> --entitlements <profile entitlements>, embedded.mobileprovision), then install (M0a.11)"
  mkdir -p "$MOBILE_EVIDENCE"
  printf '{"format":"genex-mobile/1","destination":"ios","platform":"%s","target":"%s","app":"%s","executableBytes":%s,"sha256":"%s","minos":"%s","adHocSigned":%s,"codesignVerified":%s,"buildMs":%s,"booted":false,"next":"%s"}\n' \
    "$platform" "$target" "$(mobile_json_escape "$app")" "$(wc -c <"$app/$IOS_EXECUTABLE" | tr -d ' ')" \
    "$(shasum -a 256 "$app/$IOS_EXECUTABLE" | awk '{ print $1 }')" "$IOS_MINOS" "$signed" "$signed" "$ms" \
    "$(mobile_json_escape "$next")" >"$MOBILE_EVIDENCE/ios-$platform.json"
  mobile_log "ready: $app (record $MOBILE_EVIDENCE/ios-$platform.json)"
}

main() {
  local platforms="" plist="$IOS_TEMPLATE" check_plist_file="" check_app_dir="" platform
  [ $# -gt 0 ] || usage
  while [ $# -gt 0 ]; do
    case $1 in
      --simulator) platforms="$platforms simulator" ;;
      --device) platforms="$platforms device" ;;
      --no-boot) ;;
      --boot | --install | --launch) mobile_fail boot-not-allowed "$1: the Simulator and the iPhone are started by the person, never by this script" ;;
      --plist)
        [ $# -ge 2 ] || usage
        plist=$2
        shift
        ;;
      --check-plist)
        [ $# -ge 2 ] || usage
        check_plist_file=$2
        shift
        ;;
      --check-app)
        [ $# -ge 2 ] || usage
        check_app_dir=$2
        shift
        ;;
      *) usage ;;
    esac
    shift
  done
  if [ -n "$check_plist_file" ]; then
    check_plist "$check_plist_file"
    return 0
  fi
  [ -n "$platforms" ] || usage
  if [ -n "$check_app_dir" ]; then
    for platform in $platforms; do check_app "$check_app_dir" "$platform"; done
    return 0
  fi
  # Every check that needs no build runs before any build.
  check_plist "$plist"
  command -v xcrun >/dev/null 2>&1 || mobile_fail tool-missing "xcrun (Xcode) is not installed"
  for platform in $platforms; do build_app "$platform" "$plist"; done
}

main "$@"
