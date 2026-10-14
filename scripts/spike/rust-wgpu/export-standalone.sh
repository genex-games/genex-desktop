#!/usr/bin/env bash
# M0a spike only (M3.5 and M2.9 promote it into native-export and the web export): the export
# flavour of the pond, a Mac .app and a web folder, each booted standalone with no Studio host
# (exported execution).
#
#   bash scripts/spike/rust-wgpu/export-standalone.sh
#
# Mac:
#  1. cargo builds `pond` (release) twice from the same crate: the dev flavour (default features,
#     `studio`: it serves the studio's verbs over genex-studio) and the export flavour
#     (`--no-default-features`), which never links genex-studio. The check looks for the
#     transport's symbols and strings (cross-lib.sh CROSS_TRANSPORT_MARKERS) with llvm-nm and in
#     the bytes: the dev flavour must carry them (or the checker is blind, or the feature switch
#     does nothing) and the export flavour must not.
#  2. Pond.app: Contents/MacOS/pond + Info.plist, ad hoc signed, `codesign --verify --strict`;
#     thin arm64, no OpenGL framework, no LC_DYLD_ENVIRONMENT.
#  3. Boot: the .app's binary runs its self-test with an empty environment (no GENEX_STUDIO_*,
#     descriptor 3 closed, HOME a private folder) and must exit 0 and write a non-blank capture
#     (at least 16 colours, as the web spike's test). Its stdout record is kept.
# Web:
#  4. web.sh builds the folder; game.js and game_bg.wasm must carry no transport marker.
#  5. `measure.ts web-boot` serves only that folder on 127.0.0.1 to headless Chromium (Playwright,
#     never downloaded) and requires the shell to reach `running` on WebGPU and an async capture
#     with at least 16 colours.
# The record goes to <evidence>/export.json; the app and folder stay under .studio-dev/cross/export.

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=export-standalone

EXPORT_DIR="$CROSS_WORK/export"
APP="$EXPORT_DIR/Pond.app"
WEB_OUT="$EXPORT_DIR/pond-web"
MEASURE="$CROSS_REPO/scripts/spike/rust-wgpu/measure.ts"
BOOT_TICKS=200
NONBLANK_MIN_COLOURS=16
APP_BUNDLE_ID="games.genex.spike.pond"

write_info_plist() {
  cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>pond</string>
  <key>CFBundleIdentifier</key><string>$APP_BUNDLE_ID</string>
  <key>CFBundleName</key><string>Pond</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
}

# The dev-flavour control: the pond built with its default `studio` feature must carry the
# transport. It is copied out before the export build overwrites the same artifact path.
checker_control() {
  set -e
  local log="$CROSS_EVIDENCE/export-dev-control.jsonl" dev hits
  cross_cargo "$log" build -p pond --bin pond --release --offline --locked >/dev/null
  dev=$(cross_artifact "$log" pond pond bin)
  hits=$(cross_transport_hits "$dev")
  [ -n "$hits" ] || cross_fail checker-blind "the transport check finds nothing in the dev-flavour $dev"
  printf '%s\n' "$hits" | cross_json_lines
}

check_mac_binary() {
  set -e
  local file=$1 archs headers
  archs=$(lipo -archs "$file")
  [ "$archs" = arm64 ] || cross_fail not-thin-arm64 "$file architectures: $archs"
  headers=$("$(cross_tool llvm-objdump)" --macho --private-headers "$file")
  if printf '%s\n' "$headers" | grep -q 'LC_DYLD_ENVIRONMENT'; then
    cross_fail dyld-environment "$file carries LC_DYLD_ENVIRONMENT"
  fi
  if "$(cross_tool llvm-objdump)" --macho --dylibs-used "$file" | grep -q 'OpenGL.framework'; then
    cross_fail opengl-linked "$file links OpenGL"
  fi
}

build_app() {
  set -e
  local log="$CROSS_EVIDENCE/export-mac-build.jsonl" ms pond hits
  ms=$(cross_cargo "$log" build -p pond --bin pond --no-default-features --release --offline --locked)
  pond=$(cross_artifact "$log" pond pond bin)
  hits=$(cross_transport_hits "$pond")
  [ -z "$hits" ] || cross_fail transport-in-export "$pond carries $(printf '%s' "$hits" | tr '\n' ' ')"
  check_mac_binary "$pond"
  mkdir -p "$APP/Contents/MacOS"
  cp -f "$pond" "$APP/Contents/MacOS/pond"
  write_info_plist
  codesign --force --sign - --timestamp=none "$APP" 2>/dev/null
  codesign --verify --strict "$APP" || cross_fail codesign-invalid "codesign --verify --strict refused $APP"
  printf '%s\n' "$ms"
}

colours() {
  node -e '
    const bytes = require("node:fs").readFileSync(process.argv[1]);
    const seen = new Set();
    for (let i = 0; i + 3 < bytes.length && seen.size < 4096; i += 4) seen.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
    process.stdout.write(String(seen.size));
  ' "$1"
}

# Run the .app's binary with no Studio around it; prints the boot facts as JSON members.
boot_app() {
  set -e
  local home state record start end status=0 first count
  home=$(mktemp -d "$EXPORT_DIR/boot-home.XXXXXX")
  state="$home/state"
  record="$EXPORT_DIR/boot-record.json"
  start=$(cross_now_ms)
  env -i HOME="$home" PATH=/usr/bin:/bin TMPDIR="$home" "$APP/Contents/MacOS/pond" \
    --self-test "$BOOT_TICKS" --state-dir "$state" --out "$record" 3<&- || status=$?
  end=$(cross_now_ms)
  [ "$status" -eq 0 ] || cross_fail boot-failed "the exported pond exited $status"
  first="$state/captures/1.bgra"
  [ -s "$first" ] || cross_fail no-capture "the exported pond wrote no capture at $first"
  count=$(colours "$first")
  [ "$count" -ge "$NONBLANK_MIN_COLOURS" ] || cross_fail blank-capture "the exported pond's first capture has $count colours"
  printf '"bootMs":%s,"captureColours":%s,"captureBytes":%s,"record":"%s"' \
    $((end - start)) "$count" "$(cross_bytes "$first")" "$(cross_json_escape "$record")"
}

build_web() {
  set -e
  local start end file hits
  start=$(cross_now_ms)
  bash "$CROSS_REPO/scripts/spike/rust-wgpu/web.sh" --out "$WEB_OUT" >&2
  end=$(cross_now_ms)
  for file in "$WEB_OUT/game.js" "$WEB_OUT/game_bg.wasm"; do
    hits=$(cross_transport_hits "$file")
    [ -z "$hits" ] || cross_fail transport-in-export "$file carries $(printf '%s' "$hits" | tr '\n' ' ')"
  done
  printf '%s\n' $((end - start))
}

main() {
  [ $# -eq 0 ] || cross_fail usage "usage: export-standalone.sh"
  cross_require_disk
  cross_require_node
  mkdir -p "$EXPORT_DIR" "$CROSS_EVIDENCE"
  local control mac_ms boot web_ms web_boot
  control=$(checker_control)
  mac_ms=$(build_app)
  boot=$(boot_app)
  web_ms=$(build_web)
  web_boot=$(node "$MEASURE" web-boot "$WEB_OUT") || cross_fail web-boot-failed "measure.ts web-boot refused $WEB_OUT"
  cross_record export.json "$(printf '{"format":"genex-export-standalone/1","devControlMarkers":%s,"mac":{"app":"%s","buildMs":%s,"binaryBytes":%s,"appGzipBytes":%s,%s},"web":{"folder":"%s","buildMs":%s,"size":%s,"boot":%s}}' \
    "$control" "$(cross_json_escape "$APP")" "$mac_ms" "$(cross_bytes "$APP/Contents/MacOS/pond")" \
    "$(tar -C "$EXPORT_DIR" -cf - Pond.app | gzip -9 | wc -c | tr -d ' ')" "$boot" \
    "$(cross_json_escape "$WEB_OUT")" "$web_ms" "$(cat "$WEB_OUT/size.json")" "$web_boot")"
}

main "$@"
