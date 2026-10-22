#!/usr/bin/env bash
# PROF-9: the forced-crash rows of the crash-lab example on this host (devices are the owner's
# manual checklist: no Simulator, emulator or phone is started here).
#
#   bash scripts/spike/rust-wgpu/crash-rows.sh [--out <dir>] [--no-gpu] [--cross]
#
# Rows, each one line of <out>/rows.tsv (row, status, detail):
#   host-records   cargo test -p crash-lab --test crashes: the tick-300 panic (one fatal unhandled
#                  `panic` record naming seed, tick and src/lab.rs), the journal-tail replay (same
#                  kind, location and tick), the job panic (handled, not fatal), the hook budget
#                  (median <= 5 ms) and the profile row (scopes, counters, equal checksums).
#   host-gpu       the same file's `metal` rows (--ignored): one `gpu-validation` record (fatal)
#                  and one `device-lost` record (not fatal). Skipped with --no-gpu or off macOS.
#   replay-field   the ignored RED row: the record's own `replay` (needs the facade to register a
#                  ReplaySource over the input journal). Recorded red or green, never fails the run.
#   web-build      crash-lab's library for wasm32-unknown-unknown builds. The page rows (a Rust
#                  panic and a `wasm-trap` through `window.__studio.crashes()`) need a browser and
#                  are not run here.
#   linux-check / windows-check (--cross only)  `cargo check` of the example for
#                  x86_64-unknown-linux-gnu and x86_64-pc-windows-gnullvm: compile only; the
#                  forced rows need a Linux or Windows box. The Linux check uses cross-linux.sh's
#                  sysroot under GENEX_CROSS_WORK (default .studio-dev/cross) for pkg-config.
#
# Every cargo command runs through scripts/toolchains/rust-env.ts (offline, the pinned toolchain,
# the shared CARGO_TARGET_DIR the caller sets). Each test file runs on its own. Evidence (record
# JSON, the replay track, the hook timings, the profile summary) lands in <out>/evidence. Exits 1
# when a required row is red, 2 on a bad argument, 3 when the disk is too full to build.
#
# Written for the bash 3.2 macOS ships.

set -euo pipefail

MIN_FREE_GB=4
EXIT_RED=1
EXIT_USAGE=2
EXIT_DISK=3

REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
WORKSPACE="$REPO/native/genex-rust"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/.studio-dev/cargo-target}"
# cross-linux.sh's extended sysroot (its pkg-config and .pc files), as cross-lib.sh finds it.
LINUX_SYSROOT="${GENEX_CROSS_WORK:-$REPO/.studio-dev/cross}/linux-sysroot-2.28"

out=""
gpu=1
cross=0
while [ $# -gt 0 ]; do
  case $1 in
    --out)
      [ $# -ge 2 ] || { echo "crash-rows.sh: --out needs a folder" >&2; exit $EXIT_USAGE; }
      out=$2
      shift
      ;;
    --no-gpu) gpu=0 ;;
    --cross) cross=1 ;;
    *) echo "crash-rows.sh: unknown argument $1" >&2; exit $EXIT_USAGE ;;
  esac
  shift
done
[ -n "$out" ] || out="$TARGET_DIR/crash-rows"
mkdir -p "$out/evidence"
ROWS="$out/rows.tsv"
printf 'row\tstatus\tdetail\n' >"$ROWS"
red=0

free_gb() {
  df -g "$REPO" | awk 'NR == 2 { print $4 }'
}

require_disk() {
  local free
  free=$(free_gb)
  if [ "$free" -lt "$MIN_FREE_GB" ]; then
    echo "crash-rows.sh: disk: $free GB free, a build needs $MIN_FREE_GB GB" >&2
    exit $EXIT_DISK
  fi
}

cargo_env() {
  (cd "$WORKSPACE" && CARGO_TARGET_DIR="$TARGET_DIR" GENEX_CRASH_LAB_EVIDENCE="$out/evidence" node "$REPO/scripts/toolchains/rust-env.ts" -- cargo "$@")
}

# row <name> <required 1|0> <log> -- <cargo args...>
row() {
  local name=$1 required=$2 log=$3
  shift 4
  require_disk
  if cargo_env "$@" >"$out/$log" 2>&1; then
    printf '%s\tgreen\t%s\n' "$name" "$(grep -E '^test result|Finished' "$out/$log" | tail -1 | sed 's/^ *//')" >>"$ROWS"
    return 0
  fi
  printf '%s\tred\tsee %s\n' "$name" "$log" >>"$ROWS"
  if [ "$required" = 1 ]; then
    red=1
  fi
}

row host-records 1 host-records.log -- test -p crash-lab --offline --test crashes
if [ "$gpu" = 1 ] && [ "$(uname -s)" = Darwin ]; then
  GENEX_REQUIRE_METAL=1 row host-gpu 1 host-gpu.log -- test -p crash-lab --offline --test crashes -- --ignored metal
else
  printf 'host-gpu\tnot-run\t%s\n' "--no-gpu or not macOS" >>"$ROWS"
fi
row replay-field 0 replay-field.log -- test -p crash-lab --offline --test crashes -- --ignored the_tick_300_record_carries_the_journal_tail_as_its_replay
row web-build 1 web-build.log -- build -p crash-lab --offline --lib --target wasm32-unknown-unknown
printf 'web-page\tnot-run\t%s\n' "a Rust panic and a wasm-trap through window.__studio.crashes() need a browser" >>"$ROWS"
if [ "$cross" = 1 ]; then
  # cpal and gilrs find libasound and libudev through pkg-config: use cross-linux.sh's sysroot.
  if [ -x "$LINUX_SYSROOT/bin/pkg-config" ]; then
    export "PKG_CONFIG_x86_64_unknown_linux_gnu=$LINUX_SYSROOT/bin/pkg-config"
    export "PKG_CONFIG_PATH_x86_64_unknown_linux_gnu=$LINUX_SYSROOT/usr/lib64/pkgconfig"
    export "PKG_CONFIG_SYSROOT_DIR_x86_64_unknown_linux_gnu=$LINUX_SYSROOT"
    export "PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_gnu=1"
  fi
  row linux-check 0 linux-check.log -- check -p crash-lab --offline --tests --target x86_64-unknown-linux-gnu
  row windows-check 0 windows-check.log -- check -p crash-lab --offline --tests --target x86_64-pc-windows-gnullvm
fi
printf 'devices\tmanual\t%s\n' "iPhone and Android forced panic and native fault: the owner's device checklist" >>"$ROWS"

cat "$ROWS"
exit $(( red == 1 ? EXIT_RED : 0 ))
