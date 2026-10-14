#!/usr/bin/env bash
# M0a spike only (M5.1 promotes it into the iOS lane): cross-build the pond for
# aarch64-apple-ios and aarch64-apple-ios-sim with IPHONEOS_DEPLOYMENT_TARGET=16.0 (rust-env.sh
# exports it) and Xcode's SDKs.
#
#   bash scripts/spike/rust-wgpu/cross-ios.sh
#
# Checks on each Mach-O: arm64, LC_BUILD_VERSION platform IOS (device) or IOSSIMULATOR (sim)
# with minos 16.0 (rustc's 10.0 default is refused), no LC_DYLD_ENVIRONMENT, only system
# libraries and frameworks linked, and no transport symbol (the pond is the export flavour).
# Nothing is launched: the Simulator and the iPhone are person-only (containment stage 1).

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=cross-ios

IOS_MINOS="16.0"

# platform and minos of LC_BUILD_VERSION, as "<platform> <minos>".
build_version() {
  set -e
  "$(cross_tool llvm-objdump)" --macho --private-headers "$1" | awk '
    /cmd LC_BUILD_VERSION/ { found = 1; next }
    found && $1 == "platform" { platform = $2 }
    found && $1 == "minos" { print platform, $2; exit }'
}

check_macho() {
  set -e
  local file=$1 platform=$2 facts got_platform got_minos libs lib hits
  "$(cross_tool llvm-objdump)" --macho --private-headers "$file" | grep -q 'cputype' ||
    cross_fail not-macho "$file is not a Mach-O file"
  facts=$(build_version "$file")
  got_platform=${facts%% *}
  got_minos=${facts##* }
  # llvm-objdump names the platform in lower case (ios, iossim) or by number (2, 7).
  case "$platform:$(printf '%s' "$got_platform" | tr '[:upper:]' '[:lower:]')" in
    IOS:ios | IOS:2 | IOSSIMULATOR:iossim | IOSSIMULATOR:iossimulator | IOSSIMULATOR:7) ;;
    *) cross_fail wrong-platform "$file: LC_BUILD_VERSION platform $got_platform, not $platform" ;;
  esac
  [ "$got_minos" = "$IOS_MINOS" ] || cross_fail wrong-minos "$file: minos $got_minos, not $IOS_MINOS"
  if "$(cross_tool llvm-objdump)" --macho --private-headers "$file" | grep -q 'LC_DYLD_ENVIRONMENT'; then
    cross_fail dyld-environment "$file carries LC_DYLD_ENVIRONMENT"
  fi
  libs=$("$(cross_tool llvm-objdump)" --macho --dylibs-used "$file" | awk 'NR > 1 { print $1 }')
  for lib in $libs; do
    case $lib in
      /System/Library/Frameworks/* | /usr/lib/*) ;;
      *) cross_fail dylib-not-allowed "$file links $lib" ;;
    esac
  done
  hits=$(cross_transport_hits "$file")
  [ -z "$hits" ] || cross_fail transport-in-export "$file carries $(printf '%s' "$hits" | tr '\n' ' ')"
  printf '"platform":"%s","minos":"%s","dylibs":%s' "$got_platform" "$got_minos" "$(printf '%s\n' "$libs" | cross_json_lines)"
}

# build_one <target> <platform> <record name>
build_one() {
  set -e
  local target=$1 platform=$2 name=$3 log ms pond facts
  log="$CROSS_EVIDENCE/$name-build.jsonl"
  ms=$(cross_cargo "$log" build -p pond --bin pond --no-default-features --release --target "$target" --offline --locked)
  pond=$(cross_artifact "$log" pond pond bin)
  pond=$(cross_keep "$pond" "$name")
  facts=$(check_macho "$pond" "$platform")
  printf '{"name":"pond","target":"%s",%s,%s}' "$target" "$(cross_artifact_json "$pond" "$ms")" "$facts"
}

main() {
  set -e
  [ $# -eq 0 ] || cross_fail usage "usage: cross-ios.sh"
  cross_require_disk
  local device sim xcode
  device=$(build_one aarch64-apple-ios IOS ios-device)
  sim=$(build_one aarch64-apple-ios-sim IOSSIMULATOR ios-sim)
  xcode=$(xcodebuild -version 2>/dev/null | tr '\n' ' ' || true)
  cross_record ios.json "$(printf '{"format":"genex-cross/1","destination":"ios","deploymentTarget":"%s","xcode":"%s","artifacts":[%s,%s]}' \
    "$IOS_MINOS" "$(cross_json_escape "$xcode")" "$device" "$sim")"
}

main "$@"
