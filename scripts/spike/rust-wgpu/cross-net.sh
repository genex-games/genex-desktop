#!/usr/bin/env bash
# MP-1b net link rows: the vendored relay client's `driver` example (genex-multiplayer, which links
# libcolyseus) cross-linked for every native destination from the Mac, against the folders
# `setup-toolchain.sh --with colyseus` laid out in tools/colyseus/<triple>.
#
#   bash scripts/spike/rust-wgpu/cross-net.sh
#
# Rows: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-pc-windows-gnullvm (crt-static; libcolyseus
# also calls winpthreads' mutexes, linked statically, and BCryptGenRandom, so both are named),
# x86_64-unknown-linux-gnu.2.28 (cargo-zigbuild) and aarch64-linux-android (the NDK rust-env.sh
# names, r30 when installed, with the empty libpthread.a shim: bionic folds pthread into libc).
# Upstream ships no Android prebuilt: its folder is the store's offline source build,
#   node scripts/toolchains/colyseus-android.ts <downloads> <component> <ndk> tools/colyseus <work>
# Nothing is run: these rows prove the link only. Writes <evidence>/net-links.json and exits 1
# when a row failed.

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=cross-net

COLYSEUS_TOOLS="$CROSS_SPIKE_DIR/tools/colyseus"
# Static winpthreads and bcrypt: what the MinGW libcolyseus needs beyond the crate's own link names.
WINDOWS_NET_RUSTFLAGS="-C target-feature=+crt-static -C link-arg=-Wl,-Bstatic -C link-arg=-lwinpthread -C link-arg=-Wl,-Bdynamic -C link-arg=-lbcrypt"
# The shim folder for -lpthread, which the relay client's build script names and bionic has no
# archive for (rust-build-mobile.ts ANDROID_LINK_SHIMS: one empty `ar` archive).
ANDROID_SHIMS="$CROSS_WORK/android-link-shims"

# net_row <triple> <cargo subcommand> <target>: one link row's JSON, or a failure the caller records.
net_row() {
  set -e
  local triple=$1 subcommand=$2 target=$3 log="$CROSS_EVIDENCE/net-$1.jsonl" ms
  [ -f "$COLYSEUS_TOOLS/$triple/libcolyseus.a" ] ||
    cross_fail colyseus-missing "no $COLYSEUS_TOOLS/$triple/libcolyseus.a (setup-toolchain.sh --with colyseus)"
  ms=$(GENEX_COLYSEUS_LIB_DIR="$COLYSEUS_TOOLS/$triple" cross_cargo "$log" "$subcommand" -p genex-multiplayer \
    --example driver --target "$target" --offline --locked)
  printf '{"triple":"%s","ms":%s,"linked":true}' "$triple" "$ms"
}

main() {
  [ $# -eq 0 ] || cross_fail usage "usage: cross-net.sh"
  cross_require_disk
  mkdir -p "$CROSS_EVIDENCE"
  local rows="" failed=0 row status
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_RUSTFLAGS="$WINDOWS_NET_RUSTFLAGS"
  mkdir -p "$ANDROID_SHIMS"
  [ -f "$ANDROID_SHIMS/libpthread.a" ] || printf '!<arch>\n' >"$ANDROID_SHIMS/libpthread.a"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-L native=$ANDROID_SHIMS"
  for spec in "aarch64-apple-ios build aarch64-apple-ios" "aarch64-apple-ios-sim build aarch64-apple-ios-sim" \
    "x86_64-pc-windows-gnullvm build x86_64-pc-windows-gnullvm" \
    "x86_64-unknown-linux-gnu zigbuild x86_64-unknown-linux-gnu.2.28" \
    "aarch64-linux-android build aarch64-linux-android"; do
    # shellcheck disable=SC2086 # a spec is three words
    set -- $spec
    status=0
    row=$( (net_row "$1" "$2" "$3") 2>"$CROSS_EVIDENCE/net-$1.stderr") || status=$?
    if [ "$status" -ne 0 ]; then
      failed=1
      row=$(printf '{"triple":"%s","linked":false,"exit":%s}' "$1" "$status")
    fi
    rows="${rows:+$rows,}$row"
  done
  cross_record net-links.json "$(printf '{"format":"genex-cross-net/1","rows":[%s],"ok":%s}' "$rows" \
    "$([ "$failed" -eq 0 ] && echo true || echo false)")"
  [ "$failed" -eq 0 ] || cross_fail rows-failed "a net link row failed (see $CROSS_EVIDENCE/net-links.json)"
}

main "$@"
