#!/usr/bin/env bash
# M0a spike only: every cross row of M0a.8 in one run, from the Mac.
#
#   bash scripts/spike/rust-wgpu/cross-all.sh [--skip-offline]
#
# Runs cross-offline.sh (two cold builds with no network) first, then cross-windows.sh
# (x86_64-pc-windows-gnullvm, FXC), cross-linux.sh (its red row without the sysroot, then
# x86_64-unknown-linux-gnu.2.28 with zig + cargo-zigbuild), cross-android.sh (aarch64-linux-android,
# 16 KB pages) and cross-ios.sh (aarch64-apple-ios and -sim, minos 16.0), each in its own process,
# and keeps going after a failure. It writes <evidence>/summary.json naming each row's exit code
# and exits 1 when any row failed. The cross artifacts are copied to .studio-dev/cross/artifacts/.
# Between rows it stops with the code `disk` when free space falls under the run's line.

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=cross-all

HERE="$CROSS_REPO/scripts/spike/rust-wgpu"

main() {
  # The offline row first: it cleans its private target dir before the cross rows fill the shared one.
  local rows=()
  case "${1:-}" in
    --skip-offline) ;;
    "") rows+=("cross-offline.sh") ;;
    *) cross_fail usage "usage: cross-all.sh [--skip-offline]" ;;
  esac
  rows+=("cross-windows.sh" "cross-linux.sh --no-sysroot" "cross-linux.sh" "cross-android.sh" "cross-ios.sh")
  local row status results="" failed=0 started=$(cross_now_ms)
  for row in "${rows[@]}"; do
    cross_require_disk
    status=0
    cross_log "running $row"
    # shellcheck disable=SC2086 # a row is a script name and its flags
    bash "$HERE"/$row || status=$?
    [ "$status" -eq 0 ] || failed=1
    results="${results:+$results,}{\"row\":\"$(cross_json_escape "$row")\",\"exit\":$status}"
  done
  cross_record summary.json "$(printf '{"format":"genex-cross-summary/1","ms":%s,"rows":[%s],"ok":%s}' \
    $(($(cross_now_ms) - started)) "$results" "$([ "$failed" -eq 0 ] && echo true || echo false)")"
  [ "$failed" -eq 0 ] || cross_fail rows-failed "one or more cross rows failed (see $CROSS_EVIDENCE/summary.json)"
}

main "$@"
