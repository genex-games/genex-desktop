#!/usr/bin/env bash
# M0a spike only (M5.2 promotes it into the Android lane): cross-build the pond library for
# aarch64-linux-android (API 29) with the installed NDK and 16 KB page alignment.
#
#   bash scripts/spike/rust-wgpu/cross-android.sh
#
# The link args `-z max-page-size=16384 -z common-page-size=16384` go in through the
# target-scoped CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS (the lane puts them in its
# store-owned config). The pond library has no Android entry yet (the activity shells are M0a.16),
# so LTO keeps almost nothing in it; the pond executable built beside it carries the whole game and
# stands in for the APK payload's size (`sizeProxy`). Checks on both: AArch64, every PT_LOAD aligned to 16 KB, and
# DT_NEEDED within the plan's Android allow-list (no libc++_shared.so or other bundled .so).
# The plan pins NDK r30; this run uses the installed r27 without new licences (recorded deviation).
# Nothing is installed on a device or emulator (containment stage 1).

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=cross-android

ANDROID_TARGET="aarch64-linux-android"
ANDROID_PAGE_BYTES=16384
ANDROID_LINK_ARGS="-C link-arg=-Wl,-z,max-page-size=$ANDROID_PAGE_BYTES -C link-arg=-Wl,-z,common-page-size=$ANDROID_PAGE_BYTES"
# Plan "Sandbox, admission and export per destination", Android row.
ANDROID_NEEDED_ALLOWED=" libandroid.so liblog.so libvulkan.so libaaudio.so libc.so libm.so libdl.so "

load_alignments() {
  set -e
  "$(cross_tool llvm-readobj)" --program-headers "$1" | awk '
    /Type: PT_LOAD/ { load = 1; next }
    load && /Alignment:/ { print $2; load = 0 }'
}

check_so() {
  set -e
  local file=$1 header aligns align needed lib
  header=$("$(cross_tool llvm-readobj)" --file-headers "$file")
  printf '%s\n' "$header" | grep -q 'Machine: EM_AARCH64' || cross_fail wrong-machine "$file is not an AArch64 ELF"
  aligns=$(load_alignments "$file")
  [ -n "$aligns" ] || cross_fail no-load-segments "$file has no PT_LOAD segment"
  for align in $aligns; do
    [ "$align" -ge "$ANDROID_PAGE_BYTES" ] || cross_fail load-not-16k "$file has a PT_LOAD aligned to $align bytes"
  done
  needed=$("$(cross_tool llvm-readobj)" --needed-libs "$file" | awk '/^  [^ ]/ { gsub(/^ +| +$/, ""); print }')
  for lib in $needed; do
    case $ANDROID_NEEDED_ALLOWED in *" $lib "*) ;; *) cross_fail needed-not-allowed "$file needs $lib" ;; esac
  done
  printf '"loadAlign":%s,"needed":%s' "$(printf '%s\n' "$aligns" | sort -u | head -1)" "$(printf '%s\n' "$needed" | cross_json_lines)"
}

main() {
  set -e
  [ $# -eq 0 ] || cross_fail usage "usage: cross-android.sh"
  cross_require_disk
  local log="$CROSS_EVIDENCE/android-build.jsonl" ms so bin ndk so_facts bin_facts
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$ANDROID_LINK_ARGS"
  ms=$(cross_cargo "$log" build -p pond --lib --bin pond --no-default-features --release --target "$ANDROID_TARGET" --offline --locked)
  so=$(cross_artifact "$log" pond pond_game cdylib)
  so=$(cross_keep "$so" android)
  bin=$(cross_artifact "$log" pond pond bin)
  bin=$(cross_keep "$bin" android)
  so_facts=$(check_so "$so")
  bin_facts=$(check_so "$bin")
  ndk=$(bash "$CROSS_RUST_ENV" --print-env | awk -F= '/^export ANDROID_NDK_HOME=/ { print $2 }')
  cross_record android.json "$(printf '{"format":"genex-cross/1","destination":"android","target":"%s","api":29,"ndk":"%s","rustflags":"%s","artifacts":[{"name":"libpond_game.so",%s,%s},{"name":"pond","sizeProxy":true,%s,%s}]}' \
    "$ANDROID_TARGET" "$(cross_json_escape "$(basename "$ndk")")" "$ANDROID_LINK_ARGS" \
    "$(cross_artifact_json "$so" "$ms")" "$so_facts" "$(cross_artifact_json "$bin" "$ms")" "$bin_facts")"
}

main "$@"
