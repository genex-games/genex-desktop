#!/usr/bin/env bash
# M0a spike only (M2.3 promotes it into the store's prewarm and the lane's no-domain sandbox):
# build the pond twice from a cold target dir with every network socket denied, then time warm
# rebuilds and a cold web build.
#
#   bash scripts/spike/rust-wgpu/cross-offline.sh
#
# 1. Control: under the no-network Seatbelt profile a TCP connect to a listener on 127.0.0.1 must
#    fail, and the same connect outside it must succeed (the profile really denies sockets).
# 2. Two cold release builds of the pond for the Mac (`cargo clean` of a private target dir
#    before each) under the profile, offline and locked against the vendored crates: both must
#    succeed; their times and the binaries' sha256 are recorded (repeatability).
# 3. Warm rebuilds (pond's source touched, dependencies built): release and dev profiles.
# 4. A cold web build (web.sh: cargo, wasm-bindgen, wasm-opt) under the profile, for the plan's
#    time-to-first-frame budget (measure.ts adds the browser boot).
# The record goes to <evidence>/offline.json; the private target dir is cleaned at the end.

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=cross-offline

OFFLINE_TARGET="$CROSS_WORK/offline-target"
OFFLINE_WEB="$CROSS_WORK/offline-web"
# Everything allowed except network sockets (Seatbelt; the lane's own box comes in M2.1).
NETLESS_PROFILE='(version 1)(allow default)(deny network*)'
POND_SOURCE="$CROSS_REPO/native/genex-rust/examples/pond/src/pond.rs"
WEB_SH="$CROSS_REPO/scripts/spike/rust-wgpu/web.sh"

netless() {
  sandbox-exec -p "$NETLESS_PROFILE" "$@"
}

# A connect to a fresh 127.0.0.1 listener: blocked under the profile, open outside it.
network_control() {
  set -e
  cross_require_node
  local node port_file server inside=0 outside=0
  node=$(command -v node)
  port_file="$CROSS_WORK/offline-control.port"
  rm -f "$port_file"
  "$node" -e '
    const server = require("node:net").createServer((s) => s.end()).listen(0, "127.0.0.1", () => {
      require("node:fs").writeFileSync(process.argv[1], String(server.address().port));
    });
    setTimeout(() => server.close(), 20000);
  ' "$port_file" &
  server=$!
  while [ ! -s "$port_file" ]; do perl -e 'select(undef, undef, undef, 0.05)'; done
  local connect='const s = require("node:net").connect(+process.argv[1], "127.0.0.1", () => { s.end(); process.exit(0); }); s.on("error", () => process.exit(1));'
  netless "$node" -e "$connect" "$(cat "$port_file")" 2>/dev/null || inside=$?
  "$node" -e "$connect" "$(cat "$port_file")" || outside=$?
  kill "$server" 2>/dev/null || true
  [ "$inside" -ne 0 ] || cross_fail sandbox-allows-network "a connect inside the no-network profile succeeded"
  [ "$outside" -eq 0 ] || cross_fail control-failed "the control connect outside the profile failed"
  printf '"networkDenied":true'
}

# cold_build <log>: clean the private target, build the pond release under the profile; prints
# "<ms> <sha256> <path>".
cold_build() {
  set -e
  local log=$1 ms pond
  CARGO_TARGET_DIR="$OFFLINE_TARGET" bash "$CROSS_RUST_ENV" cargo clean >/dev/null 2>&1 || true
  ms=$(CARGO_TARGET_DIR="$OFFLINE_TARGET" cross_netless_cargo "$log" build -p pond --bin pond --release --offline --locked)
  pond=$(cross_artifact "$log" pond pond bin)
  printf '%s %s %s\n' "$ms" "$(cross_sha256 "$pond")" "$pond"
}

# cross_cargo under the no-network profile.
cross_netless_cargo() {
  set -e
  local log=$1 start end status=0
  shift
  mkdir -p "$(dirname "$log")"
  start=$(cross_now_ms)
  netless bash "$CROSS_RUST_ENV" cargo "$@" --message-format=json-render-diagnostics >"$log" || status=$?
  end=$(cross_now_ms)
  [ "$status" -eq 0 ] || cross_fail offline-build-failed "cargo $* under the no-network profile exited $status ($log)"
  printf '%s\n' $((end - start))
}

# warm_build <profile flag or ""> <log>: touch the pond's source, rebuild, print the ms.
warm_build() {
  set -e
  local flag=$1 log=$2 args=(build -p pond --bin pond --offline --locked)
  [ -z "$flag" ] || args+=("$flag")
  CARGO_TARGET_DIR="$OFFLINE_TARGET" cross_netless_cargo "$log.prime" "${args[@]}" >/dev/null
  touch "$POND_SOURCE"
  CARGO_TARGET_DIR="$OFFLINE_TARGET" cross_netless_cargo "$log" "${args[@]}"
}

target_bytes() {
  du -sk "$OFFLINE_TARGET" | awk '{ print $1 * 1024 }'
}

main() {
  [ $# -eq 0 ] || cross_fail usage "usage: cross-offline.sh"
  cross_require_disk
  command -v sandbox-exec >/dev/null 2>&1 || cross_fail tool-missing "sandbox-exec is not available"
  mkdir -p "$CROSS_WORK" "$CROSS_EVIDENCE"
  local control first second first_ms first_sha second_ms second_sha release_warm dev_warm dev_cold
  local cold_bytes web_bytes web_start web_end web_ms web_status=0
  control=$(network_control)
  first=$(cold_build "$CROSS_EVIDENCE/offline-cold-1.jsonl")
  first_ms=${first%% *}
  first_sha=$(printf '%s' "$first" | awk '{ print $2 }')
  cross_log "cold build 1: $first_ms ms"
  second=$(cold_build "$CROSS_EVIDENCE/offline-cold-2.jsonl")
  second_ms=${second%% *}
  second_sha=$(printf '%s' "$second" | awk '{ print $2 }')
  cross_log "cold build 2: $second_ms ms"
  release_warm=$(warm_build --release "$CROSS_EVIDENCE/offline-warm-release.jsonl")
  dev_cold=$(CARGO_TARGET_DIR="$OFFLINE_TARGET" cross_netless_cargo "$CROSS_EVIDENCE/offline-cold-dev.jsonl" build -p pond --bin pond --offline --locked)
  dev_warm=$(warm_build "" "$CROSS_EVIDENCE/offline-warm-dev.jsonl")
  cold_bytes=$(target_bytes)
  CARGO_TARGET_DIR="$OFFLINE_TARGET" bash "$CROSS_RUST_ENV" cargo clean >/dev/null 2>&1 || true
  web_start=$(cross_now_ms)
  CARGO_TARGET_DIR="$OFFLINE_TARGET" netless bash "$WEB_SH" --out "$OFFLINE_WEB" >"$CROSS_EVIDENCE/offline-web.log" 2>&1 || web_status=$?
  web_end=$(cross_now_ms)
  [ "$web_status" -eq 0 ] || cross_fail offline-build-failed "web.sh under the no-network profile exited $web_status"
  web_ms=$((web_end - web_start))
  web_bytes=$(target_bytes)
  CARGO_TARGET_DIR="$OFFLINE_TARGET" bash "$CROSS_RUST_ENV" cargo clean >/dev/null 2>&1 || true
  cross_record offline.json "$(printf '{"format":"genex-offline/1","profile":"%s",%s,"coldRelease":[{"ms":%s,"sha256":"%s"},{"ms":%s,"sha256":"%s"}],"identical":%s,"warmReleaseMs":%s,"coldDevMs":%s,"warmDevMs":%s,"coldTargetBytes":%s,"coldWebTargetBytes":%s,"coldWebMs":%s,"webFolder":"%s"}' \
    "$(cross_json_escape "$NETLESS_PROFILE")" "$control" "$first_ms" "$first_sha" "$second_ms" "$second_sha" \
    "$([ "$first_sha" = "$second_sha" ] && echo true || echo false)" "$release_warm" "$dev_cold" "$dev_warm" \
    "$cold_bytes" "$web_bytes" "$web_ms" "$(cross_json_escape "$OFFLINE_WEB")")"
}

main "$@"
