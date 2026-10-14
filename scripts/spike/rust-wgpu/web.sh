#!/usr/bin/env bash
# M0a spike only (M2.9 promotes it into the Rust lane): build the pond for the web.
#
#   bash scripts/spike/rust-wgpu/web.sh [--debug] [--out <dir>]
#
# 1. cargo builds the pond library for wasm32-unknown-unknown (release unless --debug) through
#    rust-env.sh: the pinned sysroot, the vendored crates, offline and locked.
# 2. wasm-bindgen 0.2.129 (spike folder) writes the ES module: <out>/game.js + game_bg.wasm.
# 3. wasm-opt (binaryen version_133, spike folder) shrinks game_bg.wasm with -Oz (release only).
# 4. native/genex-rust/web/shell.html becomes <out>/index.html.
# 5. <out>/size.json records the wasm bytes, their gzip -9 size and the 4 MB default gzip budget;
#    past the budget the script warns (as the lane's export does), and it exits 3 only past the
#    32 MB ceiling (src/shared/game-export-contract.ts; the folder is still written).
#
# <out> defaults to <cargo target dir>/genex-web/pond. Written for the bash 3.2 macOS ships.

set -euo pipefail

WASM_TARGET="wasm32-unknown-unknown"
WASM_GZIP_BUDGET_BYTES=$((4 * 1024 * 1024))
WASM_GZIP_CEILING_BYTES=$((32 * 1024 * 1024))
EXIT_OVER_BUDGET=3
# The features the pinned Rust's wasm32 target emits; wasm-opt must accept and keep them.
WASM_OPT_FEATURES="--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-reference-types --enable-multivalue"

REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
RUST_ENV="$REPO/scripts/spike/rust-wgpu/rust-env.sh"
SHELL_HTML="$REPO/native/genex-rust/web/shell.html"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/.studio-dev/cargo-target}"

profile=release
out=""
while [ $# -gt 0 ]; do
  case $1 in
    --debug) profile=debug ;;
    --out)
      [ $# -ge 2 ] || { echo "web.sh: --out needs a folder" >&2; exit 2; }
      out=$2
      shift
      ;;
    *) echo "web.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$out" ] || out="$TARGET_DIR/genex-web/pond"

cargo_args=(build -p pond --lib --target "$WASM_TARGET" --offline --locked)
[ "$profile" = release ] && cargo_args+=(--release)
CARGO_TARGET_DIR="$TARGET_DIR" bash "$RUST_ENV" cargo "${cargo_args[@]}"

wasm="$TARGET_DIR/$WASM_TARGET/$profile/pond_game.wasm"
[ -f "$wasm" ] || { echo "web.sh: cargo produced no $wasm" >&2; exit 1; }

mkdir -p "$out"
rm -f "$out/game.js" "$out/game_bg.wasm" "$out/index.html" "$out/size.json"
bash "$RUST_ENV" wasm-bindgen --target web --no-typescript --out-dir "$out" --out-name game "$wasm"
if [ "$profile" = release ]; then
  # shellcheck disable=SC2086 # the feature flags are separate words on purpose
  bash "$RUST_ENV" wasm-opt -Oz $WASM_OPT_FEATURES "$out/game_bg.wasm" -o "$out/game_bg.opt.wasm"
  mv "$out/game_bg.opt.wasm" "$out/game_bg.wasm"
fi
cp "$SHELL_HTML" "$out/index.html"

wasm_bytes=$(wc -c <"$out/game_bg.wasm" | tr -d ' ')
gzip_bytes=$(gzip -9 -c "$out/game_bg.wasm" | wc -c | tr -d ' ')
printf '{"profile":"%s","wasmBytes":%s,"gzipBytes":%s,"gzipBudgetBytes":%s}\n' \
  "$profile" "$wasm_bytes" "$gzip_bytes" "$WASM_GZIP_BUDGET_BYTES" >"$out/size.json"
echo "web.sh: $out (wasm $wasm_bytes bytes, gzip -9 $gzip_bytes bytes, budget $WASM_GZIP_BUDGET_BYTES)"
if [ "$profile" = release ] && [ "$gzip_bytes" -gt "$WASM_GZIP_CEILING_BYTES" ]; then
  echo "web.sh: gzip size $gzip_bytes is past the $WASM_GZIP_CEILING_BYTES ceiling" >&2
  exit "$EXIT_OVER_BUDGET"
fi
if [ "$profile" = release ] && [ "$gzip_bytes" -gt "$WASM_GZIP_BUDGET_BYTES" ]; then
  echo "web.sh: warning: gzip size $gzip_bytes is past the $WASM_GZIP_BUDGET_BYTES budget (slower first load)" >&2
fi
