#!/usr/bin/env bash
# M0a spike only (M2.12c promotes the rows into the Rust lane's tests): the determinism and parity
# gate (M0a.9). KILL check: bit-level determinism within a target.
#
#   bash scripts/spike/rust-wgpu/parity.sh [all]        every row below, then the summary
#   bash scripts/spike/rust-wgpu/parity.sh lint|core|pond|x86|linux|cost
#   bash scripts/spike/rust-wgpu/parity.sh compare <golden.json> <candidate.json> [report.json]
#
# Rows (each one JSON line in <evidence>/rows.jsonl; the summary is <evidence>/summary.json):
#   lint   The store-owned native/genex-rust/clippy.toml, applied as the lane applies it to a game
#          crate (CLIPPY_CONF_DIR, `-D warnings -F unsafe_code`): every fixture crate that uses a
#          refused item (std f32 transcendentals, HashMap/HashSet, Instant/SystemTime,
#          thread::spawn, unsafe) must fail with that lint's code, a clean fixture must pass, and
#          the pond (which takes its math from genex::math) must pass.
#   core   genex-core's tests/parity.rs: the orbit demo replays bit for bit from a seed (postcard
#          snapshots), a hash-ordered world is caught, the recorded fields hold within 1e-3, and
#          the record comparator's hostile table.
#   pond   On this Mac (aarch64): the GPU-free parity probe (parity-probe.rs: probes, every body's
#          pose and a postcard snapshot of the whole Rapier world per checkpoint) twice, and
#          `pond --self-test 600` (with Metal captures) twice; each pair must be byte-identical.
#   x86    The same two pairs built for x86_64-apple-darwin and run under Rosetta, when that
#          rust-std is installed: byte-identical within x86, and named-field parity within 1e-3
#          with the aarch64 records (digests and checksums reported, not required).
#   linux  The x86 Linux cross build from M0a.8 needs a Linux x86 host (Vulkan for the self-test).
#          With GENEX_PARITY_LINUX_RECORD=<record from `pond --self-test 600` on Linux> it is
#          compared with the aarch64 self-test record; otherwise the row is not-run with the
#          artifact's sha256 (M0a.13's CI job produces the record).
#   cost   CPU cost of the determinism configuration in the pond scene: the probe's bench mode on
#          the real pond (scalar glam, Rapier enhanced-determinism), then glam-cost.rs built
#          `deterministic` and `simd` in a throwaway package and run with the pond's draw count.
#
# Environment: GENEX_PARITY_TICKS (600), GENEX_PARITY_SEED (1), GENEX_PARITY_DEMO (cast),
# GENEX_PARITY_WORK (<repo>/.studio-dev/parity), GENEX_PARITY_EVIDENCE
# (<repo>/.studio-dev/evidence/rust-parity), GENEX_PARITY_CLIPPY_CONF_DIR (the folder
# holding the store clippy.toml; pointing it at an empty folder is the lint row's red run),
# GENEX_PARITY_LINUX_RECORD.
#
# Every cargo command runs through rust-env.sh (pinned sysroot, vendored crates, offline). A row
# that fails prints one typed line on stderr: genex-parity: {"code":"<code>","detail":"<text>"};
# the script exits 1 when any row failed and 0 otherwise (not-run rows say why in their detail).
# Written for the bash 3.2 macOS ships: no associative arrays, no mapfile.

set -euo pipefail

PARITY_SCRIPTS="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PARITY_REPO="$(cd -P "$PARITY_SCRIPTS/../../.." && pwd -P)"
PARITY_RUST_ENV="$PARITY_SCRIPTS/rust-env.sh"
PARITY_WORKSPACE="$PARITY_REPO/native/genex-rust"
PARITY_WORK="${GENEX_PARITY_WORK:-$PARITY_REPO/.studio-dev/parity}"
PARITY_EVIDENCE="${GENEX_PARITY_EVIDENCE:-$PARITY_REPO/.studio-dev/evidence/rust-parity}"
PARITY_CLIPPY_CONF_DIR="${GENEX_PARITY_CLIPPY_CONF_DIR:-$PARITY_WORKSPACE}"
PARITY_TICKS="${GENEX_PARITY_TICKS:-600}"
PARITY_SEED="${GENEX_PARITY_SEED:-1}"
PARITY_DEMO="${GENEX_PARITY_DEMO:-cast}"
PARITY_ROWS="$PARITY_EVIDENCE/rows.jsonl"
PARITY_X86_TARGET="x86_64-apple-darwin"
PARITY_HOST_TARGET="aarch64-apple-darwin"
PARITY_LINUX_ARTIFACT="$PARITY_REPO/.studio-dev/cross/artifacts/linux/pond"
PARITY_SYSROOT="${GENEX_SPIKE_TOOLCHAIN_DIR:-$PARITY_REPO/.studio-dev/spike-toolchain}/sysroot"
# Crates the probe links by name, from the pond's own build.
PARITY_PROBE_EXTERNS="genex pond_game genex_platform_web genex_core postcard serde_json"
# Free space a heavy build needs, in GB (the run's stop line).
PARITY_MIN_FREE_GB=5
PARITY_BENCH_REPEATS=5
PARITY_FAILED=0

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PARITY_REPO/.studio-dev/cargo-target}"

parity_json_escape() {
  set -e
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

parity_log() { printf 'parity: %s\n' "$*" >&2; }

# row <name> <pass|fail|not-run> <detail> [extra JSON object members, already encoded]
parity_row() {
  set -e
  local name=$1 status=$2 detail=$3 extra=${4:-}
  mkdir -p "$PARITY_EVIDENCE"
  printf '{"row":"%s","status":"%s","detail":"%s"%s}\n' "$name" "$status" "$(parity_json_escape "$detail")" "${extra:+,$extra}" >>"$PARITY_ROWS"
  parity_log "$name: $status — $detail"
  if [ "$status" = fail ]; then
    PARITY_FAILED=1
    printf 'genex-parity: {"code":"%s","detail":"%s"}\n' "$name" "$(parity_json_escape "$detail")" >&2
  fi
  return 0
}

parity_check_disk() {
  set -e
  local free
  free=$(df -g "$PARITY_REPO" | awk 'NR == 2 { print $4 }')
  if [ "${free:-0}" -lt "$PARITY_MIN_FREE_GB" ]; then
    parity_row disk fail "only ${free} GB free (stop line ${PARITY_MIN_FREE_GB} GB)"
    return 1
  fi
}

parity_cargo() { bash "$PARITY_RUST_ENV" cargo "$@"; }

# ---- lint ----------------------------------------------------------------------------------

# Fixture rows: `name<TAB>expected lint code ("-" = must pass)<TAB>lib.rs source` (bash collapses
# consecutive tabs, so no field is ever empty).
parity_lint_fixtures() {
  cat <<'ROWS'
std-sin	clippy::disallowed_methods	pub fn f(x: f32) -> f32 { x.sin() }
std-sin-path	clippy::disallowed_methods	pub fn f(x: f32) -> f32 { f32::sin(x) }
std-sin-cos	clippy::disallowed_methods	pub fn f(x: f32) -> f32 { let (s, c) = x.sin_cos(); s + c }
std-atan2	clippy::disallowed_methods	pub fn f(y: f32, x: f32) -> f32 { y.atan2(x) }
std-exp	clippy::disallowed_methods	pub fn f(x: f32) -> f32 { x.exp() }
std-powf	clippy::disallowed_methods	pub fn f(x: f32) -> f32 { x.powf(2.5) }
std-powi	clippy::disallowed_methods	pub fn f(x: f32) -> f32 { x.powi(3) }
hash-map	clippy::disallowed_types	pub fn f() -> usize { let m: std::collections::HashMap<u32, u32> = Default::default(); m.len() }
hash-set	clippy::disallowed_types	pub fn f() -> usize { let s: std::collections::HashSet<u32> = Default::default(); s.len() }
instant	clippy::disallowed_types	pub fn f() -> u128 { let t: std::time::Instant = std::time::Instant::now(); t.elapsed().as_nanos() }
system-time	clippy::disallowed_types	pub fn f() -> bool { let t: std::time::SystemTime = std::time::SystemTime::now(); t.elapsed().is_ok() }
thread-spawn	clippy::disallowed_methods	pub fn f() -> bool { std::thread::spawn(|| 1).join().is_ok() }
unsafe	unsafe_code	pub fn f(p: *const u8) -> u8 { unsafe { *p } }
clean	-	pub fn f(x: f32) -> f32 { (x * 2.0).sqrt().mul_add(0.5, x.abs().floor()) }
ROWS
}

parity_write_lint_fixtures() {
  set -e
  local dir=$1 members="" name code source
  rm -rf "$dir"
  mkdir -p "$dir"
  while IFS=$'\t' read -r name code source; do
    mkdir -p "$dir/$name/src"
    printf '[package]\nname = "fixture-%s"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n' "$name" >"$dir/$name/Cargo.toml"
    printf '//! M0a.9 lint fixture `%s` (generated by parity.sh).\n\n/// The fixture.\n%s\n' "$name" "$source" >"$dir/$name/src/lib.rs"
    members="$members\"$name\", "
  done < <(parity_lint_fixtures)
  printf '[workspace]\nresolver = "3"\nmembers = [%s]\n' "$members" >"$dir/Cargo.toml"
}

parity_lint() {
  set -e
  local dir="$PARITY_WORK/lint-fixtures" name code source out status
  parity_write_lint_fixtures "$dir"
  while IFS=$'\t' read -r name code source; do
    out="$PARITY_WORK/lint-$name.jsonl"
    status=0
    CLIPPY_CONF_DIR="$PARITY_CLIPPY_CONF_DIR" GENEX_SPIKE_WORKSPACE="$dir" CARGO_TARGET_DIR="$PARITY_WORK/lint-target" \
      parity_cargo clippy -p "fixture-$name" --offline --message-format=json -- -D warnings -F unsafe_code \
      >"$out" 2>"$out.stderr" || status=$?
    if [ "$code" = - ]; then
      if [ "$status" = 0 ]; then parity_row "lint-$name" pass "the clean fixture passes the store clippy.toml"
      else parity_row "lint-$name" fail "the clean fixture was refused (exit $status): see $out"; fi
    elif [ "$status" != 0 ] && grep -qF "\"code\":\"$code\"" "$out"; then
      parity_row "lint-$name" pass "refused with $code"
    else
      parity_row "lint-$name" fail "expected a refusal with $code, got exit $status: see $out"
    fi
  done < <(parity_lint_fixtures)
  # The pond inside the workspace takes the store file by clippy's own lookup (examples/pond has
  # none, so native/genex-rust/clippy.toml applies); CLIPPY_CONF_DIR would also force it on the
  # host crates the pond links, which keep their own files here and are prebuilt in the product.
  out="$PARITY_WORK/lint-pond.jsonl"
  status=0
  if [ -n "${GENEX_PARITY_CLIPPY_CONF_DIR:-}" ]; then export CLIPPY_CONF_DIR="$GENEX_PARITY_CLIPPY_CONF_DIR"; fi
  parity_cargo clippy -p pond --offline --locked --message-format=json \
    -- -D warnings -F unsafe_code >"$out" 2>"$out.stderr" || status=$?
  unset CLIPPY_CONF_DIR
  if [ "$status" = 0 ]; then parity_row lint-pond pass "the pond (genex::math, genex::Map) passes the lane gate"
  else parity_row lint-pond fail "the pond fails the lane gate (exit $status): see $out"; fi
}

# ---- core ----------------------------------------------------------------------------------

parity_core() {
  set -e
  local log="$PARITY_WORK/core.log" status=0
  mkdir -p "$PARITY_WORK"
  parity_cargo test -p genex-core --test parity --offline --locked >"$log" 2>&1 || status=$?
  local summary
  summary=$(grep -E '^test result:' "$log" | tail -1 || true)
  if [ "$status" = 0 ]; then parity_row core pass "genex-core tests/parity.rs: ${summary:-ok}"
  else parity_row core fail "genex-core tests/parity.rs (exit $status): ${summary:-see $log}"; fi
}

# ---- builds --------------------------------------------------------------------------------

# Node over Cargo's JSON messages: `rlibs` prints `--extern=name=path` for PARITY_PROBE_EXTERNS
# and `-Ldependency=<deps>`; `links` prints the build scripts' -L and -l flags; `bin <name>`
# prints the executable. Paths come from compiler-artifact messages, never the target layout.
parity_artifacts() {
  set -e
  node -e '
    const fs = require("fs");
    const [file, mode, arg] = process.argv.slice(1);
    const msgs = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const arts = msgs.filter((m) => m.reason === "compiler-artifact");
    const out = [];
    if (mode === "rlibs") {
      for (const crate of arg.split(" ")) {
        const hit = arts.filter((m) => m.target.name.replaceAll("-", "_") === crate && m.filenames.some((f) => f.endsWith(".rlib")));
        if (hit.length !== 1) { console.error(`expected one rlib for ${crate}, found ${hit.length}`); process.exit(3); }
        out.push(`--extern=${crate}=${hit[0].filenames.find((f) => f.endsWith(".rlib"))}`);
      }
      // Every deps/ folder an artifact landed in: the target folder, and for a cross build the
      // host folder holding the proc macros (workspace members are uplifted out of deps/).
      for (const f of arts.flatMap((m) => m.filenames)) {
        const dir = require("path").dirname(f);
        if (dir.endsWith("/deps")) out.push(`-Ldependency=${dir}`);
      }
    } else if (mode === "links") {
      for (const m of msgs.filter((m) => m.reason === "build-script-executed")) {
        for (const p of m.linked_paths ?? []) out.push(`-L${p}`);
        for (const l of m.linked_libs ?? []) out.push(`-l${l}`);
      }
    } else if (mode === "bin") {
      const hit = arts.find((m) => m.target.name === arg && m.executable);
      if (!hit) { console.error(`no executable ${arg}`); process.exit(3); }
      out.push(hit.executable);
    }
    process.stdout.write([...new Set(out)].join("\n") + (out.length ? "\n" : ""));
  ' "$@"
}

# Build the pond (release) for <target>, then the probe against it. Prints nothing; leaves
# $PARITY_WORK/<target>/{build.jsonl,parity-probe}.
parity_build() {
  set -e
  local target=$1 dir="$PARITY_WORK/$1" args=()
  local line rlibs links
  mkdir -p "$dir"
  # Called in an `||` list, where bash ignores errexit: every step returns on failure itself.
  parity_check_disk || return 1
  parity_log "building the pond for $target"
  # The host build goes without --target so it shares target/release with the other spike rows.
  local target_args=(--target "$target")
  [ "$target" = "$PARITY_HOST_TARGET" ] && target_args=()
  parity_cargo build -p pond --release --offline --locked ${target_args[@]+"${target_args[@]}"} --message-format=json \
    >"$dir/build.jsonl" 2>"$dir/build.stderr" || return 1
  rlibs=$(parity_artifacts "$dir/build.jsonl" rlibs "$PARITY_PROBE_EXTERNS") || return 1
  links=$(parity_artifacts "$dir/build.jsonl" links) || return 1
  while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done <<<"$rlibs
$links"
  parity_log "compiling the parity probe for $target"
  bash "$PARITY_RUST_ENV" rustc --edition=2024 --crate-type=bin --crate-name=parity_probe ${target_args[@]+"${target_args[@]}"} \
    -Copt-level=3 "${args[@]}" -o "$dir/parity-probe" "$PARITY_SCRIPTS/parity-probe.rs" 2>"$dir/probe.stderr" || return 1
}

# run_twice <row> <out prefix> <command…>: run the command twice into <prefix>.{1,2}.json and
# require byte-identical records (the KILL check).
parity_run_twice() {
  set -e
  local row=$1 prefix=$2
  shift 2
  local status=0
  "$@" >"$prefix.1.json" 2>"$prefix.1.stderr" || status=$?
  [ "$status" = 0 ] && { "$@" >"$prefix.2.json" 2>"$prefix.2.stderr" || status=$?; }
  if [ "$status" != 0 ]; then
    parity_row "$row" fail "the run exited $status: $(head -c 400 "$prefix".*.stderr 2>/dev/null | tr '\n' ' ')"
    return 0
  fi
  if cmp -s "$prefix.1.json" "$prefix.2.json"; then
    parity_row "$row" pass "two runs byte-identical ($(wc -c <"$prefix.1.json" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$prefix.1.json" | cut -c1-16))"
  else
    parity_row "$row" fail "two runs of one seed differ: $(cmp "$prefix.1.json" "$prefix.2.json" | head -1)"
  fi
}

# The pond's self-test writes the record to --out; wrap it so run_twice reads stdout.
parity_self_test() {
  set -e
  local runner=$1 bin=$2 out
  out=$(mktemp "$PARITY_WORK/self-test.XXXXXX")
  $runner "$bin" --self-test "$PARITY_TICKS" --seed "$PARITY_SEED" --demo "$PARITY_DEMO" --out "$out" 3<&-
  cat "$out"
  rm -f "$out"
}

parity_probe_args() { printf '%s\n' "$PARITY_TICKS" --seed "$PARITY_SEED" --demo "$PARITY_DEMO"; }

# The pond's self-test record from <dir>, aarch64 or x86 (`runner` is "" or "arch -x86_64").
parity_target_rows() {
  set -e
  local label=$1 target=$2 runner=$3 dir="$PARITY_WORK/$2" pond
  pond=$(parity_artifacts "$dir/build.jsonl" bin pond)
  # shellcheck disable=SC2046
  parity_run_twice "within-$label-probe" "$dir/probe" $runner "$dir/parity-probe" $(parity_probe_args)
  parity_run_twice "within-$label-self-test" "$dir/self-test" parity_self_test "$runner" "$pond"
}

parity_pond() {
  set -e
  parity_build "$PARITY_HOST_TARGET" || { parity_row pond-build fail "the pond or the probe did not build for $PARITY_HOST_TARGET: see $PARITY_WORK/$PARITY_HOST_TARGET"; return 0; }
  parity_target_rows aarch64 "$PARITY_HOST_TARGET" ""
  cp "$PARITY_WORK/$PARITY_HOST_TARGET/probe.1.json" "$PARITY_EVIDENCE/parity-$PARITY_TICKS-seed$PARITY_SEED-$PARITY_DEMO.$PARITY_HOST_TARGET.json" 2>/dev/null || true
  cp "$PARITY_WORK/$PARITY_HOST_TARGET/self-test.1.json" "$PARITY_EVIDENCE/self-test-$PARITY_TICKS-seed$PARITY_SEED-$PARITY_DEMO.$PARITY_HOST_TARGET.json" 2>/dev/null || true
}

# ---- compare ---------------------------------------------------------------------------------

# The absolute path of an existing file.
parity_absolute() {
  set -e
  [ -f "$1" ] || return 1
  printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"
}

# compare <golden> <candidate> <report>: genex-core's comparator over the named fields.
parity_compare() {
  set -e
  local golden candidate report
  # cargo runs the test in the crate's folder: hand it absolute paths.
  golden=$(parity_absolute "$1") || { echo "no record at $1" >"$3.log"; return 1; }
  candidate=$(parity_absolute "$2") || { echo "no record at $2" >"$3.log"; return 1; }
  report="$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")"
  GENEX_PARITY_GOLDEN="$golden" GENEX_PARITY_CANDIDATE="$candidate" GENEX_PARITY_REPORT="$report" \
    parity_cargo test -p genex-core --test parity --offline --locked -- --exact --ignored records_named_in_the_environment_agree \
    >"$report.log" 2>&1
}

# cross_row <row> <golden> <candidate>
parity_cross_row() {
  set -e
  local row=$1 golden=$2 candidate=$3 report="$PARITY_EVIDENCE/$1.report.json" status=0
  [ -s "$golden" ] && [ -s "$candidate" ] || { parity_row "$row" fail "a record is missing ($golden, $candidate)"; return 0; }
  rm -f "$report"
  parity_compare "$golden" "$candidate" "$report" || status=$?
  local facts=""
  [ -s "$report" ] && facts="\"report\":$(cat "$report")"
  if [ "$status" = 0 ]; then
    parity_row "$row" pass "named fields within 1e-3 (bit identity reported in the report)" "$facts"
  else
    parity_row "$row" fail "named fields differ beyond 1e-3: see $report" "$facts"
  fi
}

# ---- x86 -----------------------------------------------------------------------------------

parity_x86() {
  set -e
  if [ ! -d "$PARITY_SYSROOT/lib/rustlib/$PARITY_X86_TARGET/lib" ]; then
    parity_row x86-darwin not-run "rust-std for $PARITY_X86_TARGET is not installed in the spike sysroot"
    return 0
  fi
  if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    parity_row x86-darwin not-run "Rosetta is not available on this Mac"
    return 0
  fi
  parity_build "$PARITY_X86_TARGET" || { parity_row x86-build fail "the pond or the probe did not build for $PARITY_X86_TARGET: see $PARITY_WORK/$PARITY_X86_TARGET"; return 0; }
  parity_target_rows x86 "$PARITY_X86_TARGET" "arch -x86_64"
  local host="$PARITY_WORK/$PARITY_HOST_TARGET" x86="$PARITY_WORK/$PARITY_X86_TARGET"
  cp "$x86/probe.1.json" "$PARITY_EVIDENCE/parity-$PARITY_TICKS-seed$PARITY_SEED-$PARITY_DEMO.$PARITY_X86_TARGET.json" 2>/dev/null || true
  cp "$x86/self-test.1.json" "$PARITY_EVIDENCE/self-test-$PARITY_TICKS-seed$PARITY_SEED-$PARITY_DEMO.$PARITY_X86_TARGET.json" 2>/dev/null || true
  parity_cross_row cross-x86-probe "$host/probe.1.json" "$x86/probe.1.json"
  parity_cross_row cross-x86-self-test "$host/self-test.1.json" "$x86/self-test.1.json"
}

# ---- linux ---------------------------------------------------------------------------------

parity_linux() {
  set -e
  local golden="$PARITY_WORK/$PARITY_HOST_TARGET/self-test.1.json" artifact="no artifact"
  [ -f "$PARITY_LINUX_ARTIFACT" ] && artifact="$PARITY_LINUX_ARTIFACT sha256 $(shasum -a 256 "$PARITY_LINUX_ARTIFACT" | cut -d' ' -f1)"
  if [ -z "${GENEX_PARITY_LINUX_RECORD:-}" ]; then
    parity_row cross-linux-x86 not-run "needs a Linux x86 host with Vulkan to run the M0a.8 build (M0a.13 CI); pass its record as GENEX_PARITY_LINUX_RECORD. Build: $artifact"
    return 0
  fi
  parity_cross_row cross-linux-x86 "$golden" "$GENEX_PARITY_LINUX_RECORD"
}

# ---- cost ----------------------------------------------------------------------------------

parity_write_cost_package() {
  set -e
  local dir=$1
  mkdir -p "$dir"
  cat >"$dir/Cargo.toml" <<EOF
# Generated by scripts/spike/rust-wgpu/parity.sh (M0a.9 cost row); never part of the workspace.
[package]
name = "glam-cost"
version = "0.0.0"
edition = "2024"
publish = false

[[bin]]
name = "glam-cost"
path = "$PARITY_SCRIPTS/glam-cost.rs"

[features]
deterministic = ["rapier3d/enhanced-determinism", "glam/scalar-math", "glam/libm"]

[dependencies]
rapier3d = "=0.36.0"
glam = "=0.33.12"
libm = "=0.2.16"

[profile.release]
codegen-units = 1
lto = "thin"
EOF
  # Start from the workspace's lock so the throwaway package resolves the same versions.
  [ -f "$dir/Cargo.lock" ] || cp "$PARITY_WORKSPACE/Cargo.lock" "$dir/Cargo.lock"
}

parity_cost() {
  set -e
  local host="$PARITY_WORK/$PARITY_HOST_TARGET" dir="$PARITY_WORK/glam-cost" bench draws config bin
  [ -x "$host/parity-probe" ] || { parity_row cost not-run "run the pond row first (no host parity probe)"; return 0; }
  bench="$PARITY_EVIDENCE/pond-bench.$PARITY_HOST_TARGET.json"
  # shellcheck disable=SC2046
  "$host/parity-probe" --bench $(parity_probe_args) >"$bench"
  draws=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).draws))' "$bench")
  parity_write_cost_package "$dir"
  parity_check_disk
  for config in deterministic simd; do
    local features=()
    [ "$config" = deterministic ] && features=(--features deterministic)
    GENEX_SPIKE_WORKSPACE="$dir" CARGO_TARGET_DIR="$PARITY_WORK/cost-target-$config" \
      parity_cargo build --release --offline ${features[@]+"${features[@]}"} --message-format=json \
      >"$dir/$config.jsonl" 2>"$dir/$config.stderr" || { parity_row cost fail "glam-cost did not build ($config): see $dir/$config.stderr"; return 0; }
    bin=$(parity_artifacts "$dir/$config.jsonl" bin glam-cost)
    "$bin" "$PARITY_TICKS" "$draws" "$PARITY_BENCH_REPEATS" >"$PARITY_EVIDENCE/glam-cost.$config.json"
  done
  local facts
  facts="\"pond\":$(cat "$bench"),\"deterministic\":$(cat "$PARITY_EVIDENCE/glam-cost.deterministic.json"),\"simd\":$(cat "$PARITY_EVIDENCE/glam-cost.simd.json")"
  parity_row cost pass "pond scene at $draws draws measured (deterministic vs simd in the facts)" "$facts"
}

# ---- summary -------------------------------------------------------------------------------

parity_summary() {
  set -e
  node -e '
    const fs = require("fs");
    const [rowsFile, out] = process.argv.slice(1);
    const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const within = rows.filter((r) => r.row.startsWith("within-"));
    const kill = within.some((r) => r.status === "fail") ? "hit" : within.length ? "not-hit" : "not-run";
    const count = (s) => rows.filter((r) => r.status === s).length;
    const summary = { format: "genex-parity-summary/1", kill: { criterion: "bit-level determinism fails within a target", verdict: kill },
      pass: count("pass"), fail: count("fail"), notRun: count("not-run"), rows };
    fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
    console.error(`parity: ${summary.pass} pass, ${summary.fail} fail, ${summary.notRun} not-run; KILL ${kill}`);
  ' "$PARITY_ROWS" "$PARITY_EVIDENCE/summary.json"
}

parity_main() {
  local step=${1:-all}
  mkdir -p "$PARITY_WORK" "$PARITY_EVIDENCE"
  case $step in
    compare)
      [ $# -ge 3 ] || { echo "usage: parity.sh compare <golden.json> <candidate.json> [report.json]" >&2; exit 2; }
      local report=${4:-$PARITY_WORK/compare.report.json}
      rm -f "$report"
      parity_compare "$2" "$3" "$report" || { cat "$report" 2>/dev/null || tail -20 "$report.log" >&2; exit 1; }
      cat "$report"
      return 0
      ;;
    all)
      rm -f "$PARITY_ROWS"
      parity_lint
      parity_core
      parity_pond
      parity_x86
      parity_linux
      parity_cost
      parity_summary
      ;;
    lint | core | pond | x86 | linux | cost)
      "parity_$step"
      ;;
    *)
      echo "usage: parity.sh [all|lint|core|pond|x86|linux|cost|compare <golden> <candidate> [report]]" >&2
      exit 2
      ;;
  esac
  [ "$PARITY_FAILED" = 0 ]
}

parity_main "$@"
