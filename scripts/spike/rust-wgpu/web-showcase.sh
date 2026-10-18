#!/usr/bin/env bash
# Renderer follow-up (RQ0.3): build the lakeside showcase for the web, packaged as the lane serves
# a web build, so Lakeside's six custom GPU passes run in a browser (Web Live parity).
#
#   bash scripts/spike/rust-wgpu/web-showcase.sh [--debug] [--out <dir>] [--print-cargo]
#
# 1. cargo builds `showcase-web` (examples/showcase-web: the showcase's game/src/main.rs with
#    `genex` = genex-platform-web, as the host-written web manifest names it) for
#    wasm32-unknown-unknown, release unless --debug, in the repo's rust env helper's environment
#    (the pinned toolchain, the vendored crates, offline and locked). A release build takes the
#    lane's export size profile (`RUST_WEB_EXPORT_PROFILE_SETTINGS` in src/main/rust-build-web.ts,
#    as `--config` settings, which the helper itself refuses), so the gzip size it reports is the
#    size a web export of the showcase ships (renderer pass 2, A.12). `--print-cargo` prints the
#    cargo arguments one per line and exits without building.
# 2. The lane's own packaging (`packageWeb` in src/main/rust-build-web.ts) runs the pinned
#    wasm-bindgen and, for a release build, wasm-opt, and writes the template shell as index.html
#    with its receipt (size.json).
# 3. The showcase's game/assets/ is copied to <out>/assets/ and `webAssetMap` writes
#    <out>/assets.json, which the shell fetches before studio_boot.
#
# <out> defaults to <cargo target dir>/genex-web/showcase and is made afresh (packageWeb refuses a
# link). Serve it with any static server and open index.html in a WebGPU browser. A release build
# past the 4 MB gzip budget is written with a warning; one past the 32 MB ceiling is still written,
# and the script says so and exits 3.
# Written for the bash 3.2 macOS ships.

set -euo pipefail

WASM_TARGET="wasm32-unknown-unknown"

REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
RUST_ENV="$REPO/scripts/toolchains/rust-env.ts"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/.studio-dev/cargo-target}"
TOOLCHAIN="${GENEX_RUST_TOOLCHAIN_DIR:-$REPO/.studio-dev/spike-toolchain}"
GAME="$REPO/native/genex-rust/examples/showcase/game"

profile=release
out=""
print_cargo=0
while [ $# -gt 0 ]; do
  case $1 in
    --debug) profile=debug ;;
    --print-cargo) print_cargo=1 ;;
    --out)
      [ $# -ge 2 ] || { echo "web-showcase.sh: --out needs a folder" >&2; exit 2; }
      out=$2
      shift
      ;;
    *) echo "web-showcase.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$out" ] || out="$TARGET_DIR/genex-web/showcase"

cargo_args=(build --manifest-path "$REPO/native/genex-rust/Cargo.toml" -p showcase-web --bin showcase-web --target "$WASM_TARGET" --offline --locked)
if [ "$profile" = release ]; then
  cargo_args+=(--release)
  # The lane's export size profile, read from the lane's own module (one setting per line).
  while IFS= read -r setting; do
    cargo_args+=(--config "$setting")
  done < <(node --input-type=module -e "
    const web = await import(process.argv[1]);
    for (const setting of web.RUST_WEB_EXPORT_PROFILE_SETTINGS) console.log(setting);
  " "$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$REPO/src/main/rust-build-web.ts")")
fi
if [ "$print_cargo" = 1 ]; then
  printf '%s\n' "${cargo_args[@]}"
  exit 0
fi
# The game's [[wgsl]] rows, compiled in as the lane compiles them (GENEX_WGSL_TOML), so the web
# build admits its Level-2 materials at the api each row declares.
wgsl_toml="$(awk '/^\[\[wgsl\]\]/ { keep = 1 } /^\[[^[]/ { keep = 0 } keep' "$GAME/genex.toml")"
(
  eval "$(CARGO_TARGET_DIR="$TARGET_DIR" node "$RUST_ENV" --print-env)"
  GENEX_WGSL_TOML="$wgsl_toml" cargo "${cargo_args[@]}"
)

wasm="$TARGET_DIR/$WASM_TARGET/$profile/showcase-web.wasm"
[ -f "$wasm" ] || { echo "web-showcase.sh: cargo produced no $wasm" >&2; exit 1; }

# The lane's packaging and asset map, run by Node 24 over the repository's TypeScript.
node --input-type=module - "$REPO" "$wasm" "$out" "$profile" "$TOOLCHAIN" "$GAME" <<'NODE'
import { execFile } from "node:child_process";
import { cp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const [repo, wasm, out, profile, toolchain, game] = process.argv.slice(2);
const web = await import(pathToFileURL(path.join(repo, "src/main/rust-build-web.ts")).href);
const exec = promisify(execFile);
const run = async (command) => {
  try {
    const { stdout, stderr } = await exec("bash", ["-c", command], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};
const release = profile === "release";
const result = await web.packageWeb({
  wasm,
  out,
  shell: await readFile(path.join(repo, "src/game-template-rust/web/shell.html"), "utf8"),
  title: "Lakeside",
  optimize: release,
  tools: {
    wasmBindgen: path.join(toolchain, "tools/bin/wasm-bindgen"),
    wasmOpt: release ? path.join(toolchain, "tools/binaryen/bin/wasm-opt") : null,
  },
  run,
});
const overBudget = !result.ok && result.refusal === web.RustWebRefusal.WasmOverBudget;
if (!result.ok && !overBudget) {
  console.error(`web-showcase.sh: packaging refused ${result.refusal}: ${result.detail}`);
  process.exit(1);
}
const assets = path.join(out, web.WEB_FILES.assets);
await cp(path.join(game, "assets"), assets, { recursive: true });
const map = await web.webAssetMap(assets);
await writeFile(path.join(out, web.WEB_FILES.assetMap), `${JSON.stringify(map)}\n`);
const receipt = result.receipt;
console.log(
  `web-showcase.sh: ${out} (wasm ${receipt.wasmBytes} bytes, gzip -9 ${receipt.gzipBytes} bytes, ` +
    `${map.files.length} assets)`,
);
if (receipt.warning) console.error(`web-showcase.sh: warning ${receipt.warning}: gzip size ${receipt.gzipBytes} is past the ${receipt.gzipBudgetBytes}-byte budget`);
if (overBudget) {
  console.error(`web-showcase.sh: ${result.detail}`);
  process.exit(3);
}
NODE
