#!/bin/sh
# Builds tests/fixtures/rust-wasm/ (index.html, game.js, game_bg.wasm and README.md): real
# wasm-bindgen 0.2.129 output of the small crate in tests/fixtures/rust-wasm/crate (no wgpu; it
# answers the Rust web shell's page contract with a frame counter), beside the Rust template's
# `web/shell.html` as index.html: the Rust web lane's output shape. The rust-game fixture's stub
# toolchain serves these files for a web build (src/main/dev/fixture-rust.ts).
#
#   scripts/toolchains/make-rust-wasm-fixture.sh          build twice from fresh target folders,
#                                                         write the fixture and record whether the
#                                                         two builds were identical
#   scripts/toolchains/make-rust-wasm-fixture.sh --check  fail when the template shell changed since
#                                                         the fixture was built; otherwise rebuild
#                                                         into a scratch folder and compare digests
#
# Inputs, never actions: the pinned Rust sysroot, the vendored crates and wasm-bindgen under
# $GENEX_RUST_TOOLCHAIN_DIR (default .studio-dev/spike-toolchain). Nothing here downloads: cargo
# runs offline and --locked against the vendored tree with a private CARGO_HOME and an empty
# environment (env -i). On a Mac every build runs under sandbox-exec with the network and every
# write into the toolchain denied. Target folders go under $CARGO_TARGET_DIR (default
# .studio-dev/cargo-target) and are removed when the run ends, as is the run's work folder under
# $GENEX_WASM_FIXTURE_WORK (default .studio-dev/evidence/rust-wasm-fixture).
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
TOOLCHAIN=${GENEX_RUST_TOOLCHAIN_DIR:-$REPO/.studio-dev/spike-toolchain}
SYSROOT="$TOOLCHAIN/sysroot"
VENDOR="$TOOLCHAIN/vendor"
BINDGEN="$TOOLCHAIN/tools/bin/wasm-bindgen"
TARGET_ROOT=${CARGO_TARGET_DIR:-$REPO/.studio-dev/cargo-target}
WORK=${GENEX_WASM_FIXTURE_WORK:-$REPO/.studio-dev/evidence/rust-wasm-fixture}
FIXTURE="$REPO/tests/fixtures/rust-wasm"
CRATE="$FIXTURE/crate"
TEMPLATE_SHELL="$REPO/src/game-template-rust/web/shell.html"
WASM_TARGET=wasm32-unknown-unknown
EXPECTED_BINDGEN="wasm-bindgen 0.2.129"
FILES="index.html game.js game_bg.wasm"

fail() {
  echo "make-rust-wasm-fixture: $*" >&2
  exit 1
}

case "${1:-}" in
  "") MODE=write ;;
  --check) MODE=check ;;
  *) fail "usage: make-rust-wasm-fixture.sh [--check]" ;;
esac

for tool in "$SYSROOT/bin/cargo" "$SYSROOT/bin/rustc" "$BINDGEN" "$VENDOR"; do
  [ -e "$tool" ] || fail "not run: $tool absent (run scripts/spike/rust-wgpu/setup-toolchain.sh first)"
done
[ -f "$TEMPLATE_SHELL" ] || fail "not run: $TEMPLATE_SHELL absent (the Rust template's shell)"
[ -f "$CRATE/Cargo.toml" ] || fail "not run: $CRATE/Cargo.toml absent"
STORE=$(cd "$TOOLCHAIN" && pwd -P) || fail "cannot resolve $TOOLCHAIN"
VENDOR=$(cd "$VENDOR" && pwd -P)
BINDGEN_VERSION=$("$BINDGEN" --version)
[ "$BINDGEN_VERSION" = "$EXPECTED_BINDGEN" ] || fail "expected $EXPECTED_BINDGEN, found: $BINDGEN_VERSION"

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

digests() {
  for file in $FILES; do printf '%s  %s\n' "$(sha256 "$1/$file")" "$file"; done
}

mkdir -p "$WORK" "$TARGET_ROOT"
RUN=$(mktemp -d "$WORK/run.XXXXXX")
case "$RUN" in "$WORK"/run.*) ;; *) fail "unexpected work folder $RUN" ;; esac
TARGETS=$(mktemp -d "$TARGET_ROOT/rust-wasm-fixture.XXXXXX")
case "$TARGETS" in "$TARGET_ROOT"/rust-wasm-fixture.*) ;; *) fail "unexpected target folder $TARGETS" ;; esac
trap 'rm -rf -- "$RUN" "$TARGETS"' EXIT

SHELL_SHA=$(sha256 "$TEMPLATE_SHELL")

if [ "$MODE" = check ]; then
  RECORDED_SHELL=$(sed -n 's/^- Template shell sha256: `\([0-9a-f]*\)`.*/\1/p' "$FIXTURE/README.md")
  [ "$RECORDED_SHELL" = "$SHELL_SHA" ] ||
    fail "--check: src/game-template-rust/web/shell.html changed since the fixture was built (recorded ${RECORDED_SHELL:-nothing}, now $SHELL_SHA): run make-rust-wasm-fixture.sh"
  [ -f "$CRATE/Cargo.lock" ] || fail "--check: $CRATE/Cargo.lock absent: run make-rust-wasm-fixture.sh"
fi

# cargo with nothing of the caller's environment: the sysroot first on PATH, a private CARGO_HOME
# naming the vendored tree as the only source, an empty HOME, the run's own target folder, and the
# vendored and crate paths remapped so no host path reaches the wasm.
cargo_in() {
  dir=$1
  shift
  set -- /usr/bin/env -i "PATH=$SYSROOT/bin:/usr/bin:/bin" "HOME=$dir/home" "CARGO_HOME=$dir/cargo-home" \
    "CARGO_TARGET_DIR=$dir/target" "CARGO_TERM_COLOR=never" "SOURCE_DATE_EPOCH=0" \
    "RUSTFLAGS=--remap-path-prefix=$VENDOR=/vendor --remap-path-prefix=$CRATE=/crate" \
    "$SYSROOT/bin/cargo" "$@" --manifest-path "$CRATE/Cargo.toml"
  if [ -x /usr/bin/sandbox-exec ]; then
    set -- /usr/bin/sandbox-exec -p "(version 1)(allow default)(deny network*)(deny file-write* (subpath \"$STORE\"))" "$@"
  fi
  "$@"
}

prepare() {
  dir=$1
  mkdir -p "$dir/home" "$dir/cargo-home" "$dir/out"
  ln -s "$TARGETS/$(basename "$dir")" "$dir/target"
  mkdir -p "$TARGETS/$(basename "$dir")"
  printf '[source.crates-io]\nreplace-with = "genex-vendored"\n\n[source.genex-vendored]\ndirectory = "%s"\n\n[net]\noffline = true\n' \
    "$VENDOR" >"$dir/cargo-home/config.toml"
}

# One build from scratch into `$1/out`: cargo (offline, locked, release), wasm-bindgen, the shell.
build() {
  dir=$1
  prepare "$dir"
  cargo_in "$dir" build --release --offline --locked --target "$WASM_TARGET" --lib
  wasm="$dir/target/$WASM_TARGET/release/genex_fixture_web.wasm"
  [ -f "$wasm" ] || fail "cargo wrote no $wasm"
  "$BINDGEN" --target web --no-typescript --out-dir "$dir/out" --out-name game "$wasm"
  cp "$TEMPLATE_SHELL" "$dir/out/index.html"
  for file in $FILES; do [ -f "$dir/out/$file" ] || fail "the build wrote no $file"; done
}

if [ "$MODE" = write ] && [ ! -f "$CRATE/Cargo.lock" ]; then
  prepare "$RUN/lock"
  cargo_in "$RUN/lock" generate-lockfile --offline
fi

build "$RUN/a"
RUSTC_VERSION=$("$SYSROOT/bin/rustc" --version)
digests "$RUN/a/out" >"$RUN/build-digests.txt"

if [ "$MODE" = check ]; then
  digests "$FIXTURE" >"$RUN/fixture-digests.txt"
  if cmp -s "$RUN/build-digests.txt" "$RUN/fixture-digests.txt"; then
    echo "make-rust-wasm-fixture --check: byte-reproducible; every digest matches tests/fixtures/rust-wasm"
    exit 0
  fi
  diff "$RUN/fixture-digests.txt" "$RUN/build-digests.txt" >&2 || true
  fail "--check: the rebuilt output differs from tests/fixtures/rust-wasm (digests above)"
fi

# A second build from its own fresh target folder: are two builds of the same inputs byte-identical?
build "$RUN/b"
digests "$RUN/b/out" >"$RUN/second-build-digests.txt"
if cmp -s "$RUN/build-digests.txt" "$RUN/second-build-digests.txt"; then
  REPRODUCIBLE="yes: two builds, each from its own fresh target folder, gave the same bytes for every file"
else
  REPRODUCIBLE="no: two builds from fresh target folders differed in $(diff "$RUN/build-digests.txt" "$RUN/second-build-digests.txt" | sed -n 's/^> [0-9a-f]*  //p' | tr '\n' ' ')"
fi

for file in $FILES; do
  cp "$RUN/a/out/$file" "$FIXTURE/$file"
  chmod 644 "$FIXTURE/$file"
done
{
  echo "# rust-wasm fixture"
  echo
  echo "Real wasm-bindgen output, generated by \`scripts/toolchains/make-rust-wasm-fixture.sh\`; do not"
  echo "edit by hand. It is the Rust web lane's output shape (\`index.html\`, \`game.js\`,"
  echo "\`game_bg.wasm\`) for the small crate in \`crate/\`: no wgpu, it answers the Rust web shell's"
  echo "page contract (\`studio_boot\`, \`studio_call\`, \`studio_frame\`) with a frame counter. The"
  echo "\`rust-game\` fixture's stub toolchain serves these bytes for a web build"
  echo "(\`src/main/dev/fixture-rust.ts\`)."
  echo
  echo "- Compiler: \`$RUSTC_VERSION\`, target \`$WASM_TARGET\`, release, offline and locked"
  echo "  against the vendored crates (\`crate/Cargo.lock\`)."
  echo "- Bindings: \`$BINDGEN_VERSION --target web --no-typescript --out-name game\`."
  echo "- Shell: \`src/game-template-rust/web/shell.html\`, the Rust template's, as \`index.html\`."
  echo "- Template shell sha256: \`$SHELL_SHA\` (\`--check\` refuses a fixture built from another)."
  echo "- Byte-reproducible: $REPRODUCIBLE."
  echo "- Check: \`scripts/toolchains/make-rust-wasm-fixture.sh --check\` compares the shell above,"
  echo "  then rebuilds into a scratch folder and compares these digests."
  echo
  echo "| File | SHA-256 |"
  echo "| --- | --- |"
  for file in $FILES; do echo "| \`$file\` | \`$(sha256 "$FIXTURE/$file")\` |"; done
} >"$FIXTURE/README.md"
echo "make-rust-wasm-fixture: wrote tests/fixtures/rust-wasm ($RUSTC_VERSION, $BINDGEN_VERSION); byte-reproducible: $REPRODUCIBLE"
