#!/usr/bin/env bash
# M0a spike only (M4.1, M4.2, M5.1 and M5.2 promote these rows into the Rust lane): helpers the
# cross-*.sh scripts and export-standalone.sh source. Sourcing runs nothing.
#
# - Every cargo command runs through rust-env.sh (pinned sysroot, vendored crates, offline,
#   locked) with `--message-format=json-render-diagnostics`; artifact paths come from Cargo's
#   `compiler-artifact` messages, never from the target-dir layout (plan: Cargo 1.100 changes it).
# - Each script writes one JSON record into the evidence folder (GENEX_CROSS_EVIDENCE, default
#   <repo>/.studio-dev/evidence/m0a/cross) that measure.ts reads.
# - A failed check prints one typed line on stderr and exits 1:
#     genex-cross: {"code":"<code>","detail":"<text>"}
# - Below CROSS_MIN_FREE_GB of free disk a heavy build refuses with the code `disk`.
#
# Written for the bash 3.2 macOS ships: no associative arrays, no mapfile.
# bash 3.2 clears errexit inside $(...), so every function starts with `set -e` again.

set -euo pipefail

CROSS_REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
CROSS_RUST_ENV="$CROSS_REPO/scripts/spike/rust-wgpu/rust-env.sh"
CROSS_TARGET_DIR="${CARGO_TARGET_DIR:-$CROSS_REPO/.studio-dev/cargo-target}"
CROSS_EVIDENCE="${GENEX_CROSS_EVIDENCE:-$CROSS_REPO/.studio-dev/evidence/m0a/cross}"
CROSS_SPIKE_DIR="${GENEX_SPIKE_TOOLCHAIN_DIR:-$CROSS_REPO/.studio-dev/spike-toolchain}"
CROSS_LLVM_BIN="$CROSS_SPIKE_DIR/sysroot/lib/rustlib/aarch64-apple-darwin/bin"
# Generated cross inputs (the Linux sysroot, zig caches) live beside the spike folder, never in ~.
CROSS_WORK="${GENEX_CROSS_WORK:-$CROSS_REPO/.studio-dev/cross}"
# Free space a heavy build needs, in GB (the run's stop line).
CROSS_MIN_FREE_GB=5
CROSS_FAIL_EXIT=1

export CARGO_TARGET_DIR="$CROSS_TARGET_DIR"
# zig and cargo-zigbuild cache into ~/.cache and ~/Library/Caches by default: keep them project-local.
export ZIG_GLOBAL_CACHE_DIR="$CROSS_WORK/zig-cache/global"
export ZIG_LOCAL_CACHE_DIR="$CROSS_WORK/zig-cache/local"
export CARGO_ZIGBUILD_CACHE_DIR="$CROSS_WORK/zigbuild-cache"

cross_json_escape() {
  set -e
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

# Print the typed failure line and exit 1.
cross_fail() {
  set -e
  printf 'genex-cross: {"code":"%s","detail":"%s"}\n' "$1" "$(cross_json_escape "$2")" >&2
  exit "$CROSS_FAIL_EXIT"
}

cross_log() {
  set -e
  printf '%s: %s\n' "${CROSS_NAME:-cross}" "$*" >&2
}

# Milliseconds since the epoch (macOS `date` has no %N).
cross_now_ms() {
  set -e
  perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'
}

# Free GB on the volume holding the repository.
cross_free_gb() {
  set -e
  df -g "$CROSS_REPO" | awk 'NR == 2 { print $4 }'
}

cross_require_disk() {
  set -e
  local free
  free=$(cross_free_gb)
  [ "$free" -ge "$CROSS_MIN_FREE_GB" ] ||
    cross_fail disk "$free GB free, a cross build needs $CROSS_MIN_FREE_GB GB (cargo clean the shared target first)"
}

cross_require_node() {
  set -e
  command -v node >/dev/null 2>&1 || cross_fail tool-missing "node is not on PATH (nvm use 24)"
}

cross_tool() {
  set -e
  local tool="$CROSS_LLVM_BIN/$1"
  [ -x "$tool" ] || cross_fail tool-missing "$1 is not in the spike sysroot's llvm-tools ($CROSS_LLVM_BIN)"
  printf '%s\n' "$tool"
}

# cross_cargo <log> <cargo args…>: run cargo through rust-env.sh with JSON messages into <log>;
# prints the elapsed milliseconds. Diagnostics go to stderr as cargo renders them.
cross_cargo() {
  set -e
  local log=$1 start end status=0
  shift
  mkdir -p "$(dirname "$log")"
  start=$(cross_now_ms)
  bash "$CROSS_RUST_ENV" cargo "$@" --message-format=json-render-diagnostics >"$log" || status=$?
  end=$(cross_now_ms)
  [ "$status" -eq 0 ] || cross_fail build-failed "cargo $* exited $status (messages: $log)"
  printf '%s\n' $((end - start))
}

# cross_artifact <log> <package> <target name> <kind: bin|cdylib|example>: the artifact file Cargo
# reported for that target in <log>.
cross_artifact() {
  set -e
  cross_require_node
  local found
  found=$(node -e '
    const [log, pkg, name, kind] = process.argv.slice(1);
    const lines = require("node:fs").readFileSync(log, "utf8").split("\n");
    let hit = "";
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      const m = JSON.parse(line);
      if (m.reason !== "compiler-artifact" || m.target.name !== name) continue;
      if (!m.package_id.includes(pkg)) continue;
      if (!m.target.kind.includes(kind)) continue;
      if (kind === "cdylib") hit = m.filenames.find((f) => /\.(so|dylib|dll)$/.test(f)) ?? "";
      else hit = m.executable ?? "";
    }
    process.stdout.write(hit);
  ' "$1" "$2" "$3" "$4")
  [ -n "$found" ] && [ -f "$found" ] || cross_fail no-artifact "cargo reported no $4 artifact $3 of $2 in $1"
  printf '%s\n' "$found"
}

cross_bytes() {
  set -e
  wc -c <"$1" | tr -d ' '
}

cross_gzip_bytes() {
  set -e
  gzip -9 -c "$1" | wc -c | tr -d ' '
}

cross_sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

# JSON array of the non-empty lines of stdin, each a string.
cross_json_lines() {
  set -e
  local out="" line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    out="${out:+$out,}\"$(cross_json_escape "$line")\""
  done
  printf '[%s]' "$out"
}

# cross_record <file name> <json>: write one evidence record.
cross_record() {
  set -e
  mkdir -p "$CROSS_EVIDENCE"
  printf '%s\n' "$2" >"$CROSS_EVIDENCE/$1"
  cross_log "wrote $CROSS_EVIDENCE/$1"
}

# The facts every artifact record carries: path, bytes, gzip -9 bytes, sha256, build ms.
cross_artifact_json() {
  set -e
  local file=$1 build_ms=$2
  printf '"path":"%s","bytes":%s,"gzipBytes":%s,"sha256":"%s","buildMs":%s' \
    "$(cross_json_escape "$file")" "$(cross_bytes "$file")" "$(cross_gzip_bytes "$file")" "$(cross_sha256 "$file")" "$build_ms"
}

# Symbols and strings only the dev flavour's transport (genex-studio's fd 3 and named-pipe code)
# carries; the export flavour must contain none of them (plan review D10). The same set as the
# product's admission scan (TRANSPORT_MARKERS in src/substrate/native-cross-admission.ts):
# genex-studio's verbs (linked by the web and phone shells) and genex-core's `GENEX_STUDIO_FD`
# check are in every build, so neither `genex_studio` nor `GENEX_STUDIO_FD` alone is a marker.
CROSS_TRANSPORT_MARKERS="genex_studio::transport genex_studio9transport GENEX_STUDIO_NONCE GENEX_STUDIO_PIPE genex-game-"

# cross_transport_hits <binary>: the transport markers found in the symbol table or the bytes,
# one per line (nothing when the binary carries no transport).
cross_transport_hits() {
  set -e
  local file=$1 nm marker symbols
  nm=$(cross_tool llvm-nm)
  symbols=$("$nm" --demangle "$file" 2>/dev/null || true)
  for marker in $CROSS_TRANSPORT_MARKERS; do
    if printf '%s\n' "$symbols" | grep -F -q -- "$marker" || LC_ALL=C grep -a -F -q -- "$marker" "$file"; then
      printf '%s\n' "$marker"
    fi
  done
}

# cross_keep <file> <destination>: copy an artifact out of the shared target dir (which a low-disk
# `cargo clean` may empty) into <work>/artifacts/<destination>/ and print the copy's path.
cross_keep() {
  set -e
  local dir="$CROSS_WORK/artifacts/$2"
  mkdir -p "$dir"
  cp -f "$1" "$dir/"
  printf '%s\n' "$dir/$(basename "$1")"
}
