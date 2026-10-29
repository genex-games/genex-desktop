/**
 * The `rust-game` and `rust-mobile-game` fixtures: a Rust · wgpu game scaffolded through the real
 * path from the shipped Rust template, over a pre-seeded, disposable Rust store in the product's
 * layout (receipts, `current-lock.rust-wgpu.json`, the lock folder's sysroot, CARGO_HOME, base and
 * per-destination prewarm records) whose tools are small stub scripts. The Rust lane runs them
 * under its own sandbox like the real tools; no compiler runs and nothing is fetched.
 *
 * - `cargo generate-lockfile` writes a lock naming the game and the vendored `genex` only.
 * - `cargo clippy` / `cargo build`, when the staged `src/main.rs` holds
 *   {@link FIXTURE_RUST_FORCE_ERROR}, print one rustc diagnostic as Cargo's JSON message (its span
 *   on that line) among non-JSON noise and exit 101.
 * - `cargo build --target wasm32-unknown-unknown` reports the committed `game_bg.wasm`
 *   (`tests/fixtures/rust-wasm/`) as the game's artifact. Any other target's artifact is, when the
 *   staged manifest asks for the facade's `studio` feature (the dev flavour), the fd-3 stub game
 *   (`tests/fixtures/rust-fd3-stub-game.mjs` under this Node, speaking contract v2), and otherwise a
 *   script that prints one line. Artifacts are named through Cargo's `compiler-artifact` message.
 * - `wasm-bindgen --out-dir <dir> --out-name <name> <wasm>` writes the committed `game.js` and
 *   `game_bg.wasm` there; `wasm-opt <in> -o <out>` copies; `rustc -vV` answers
 *   {@link FIXTURE_RUSTC_IDENTITY}.
 *
 * The mobile variant adds the iOS and Android standard libraries to the base record and prewarms
 * both, so their builders (M2.10) locate a store once they register. The store shares the C++
 * fixture's marker, so either fixture reseeds a store the other made and neither touches one it
 * did not. Nothing here runs outside a fixture profile and a test.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gitOrNull } from "../../substrate/snapshots.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import { ToolchainHost, ToolchainId, type ToolchainLock, toolchainHostOf } from "../../shared/toolchain.ts";
import { shellQuote } from "../../substrate/spawn.ts";
import { treeDigest } from "../../substrate/toolchain-store/archive.ts";
import { ReceiptSource, type ToolchainReceipt } from "../../substrate/toolchain-store/install.ts";
import {
  lockFolder,
  MOBILE_COMPONENT_LAYOUT,
  RECEIPT_FILE,
  RUST_COMPONENT_LAYOUT,
} from "../../substrate/toolchain-store/locate.ts";
import { lockOf, writeCurrentLock } from "../../substrate/toolchain-store/lock.ts";
import {
  RUST_BASE_FILE,
  RUST_DEV_PROFILE_SETTINGS,
  RUST_HOST_TRIPLE,
  RUST_PREWARM_FILE,
  RUST_TRIPLE,
  RUST_VENDOR_LAYOUT,
  RUST_WARM_LOCK_FILE,
  type RustBaseRecord,
  type RustPrewarmRecord,
  rustCargoConfig,
  rustCargoHome,
  rustPrewarmedTargetDir,
  rustSysroot,
  rustTargetFolder,
} from "../../substrate/toolchain-store/rust-locate.ts";
import type { StudioCore } from "../studio-core.ts";
import { seedFixtureCrateRequests } from "./fixture-crates.ts";
import { FIXTURE_RUST_GAME, FIXTURE_STORE_MARKER, fixtureCheckoutRoot, seedRustGame } from "./fixture-toolchains.ts";

/** Which Rust fixture a profile launched: the desktop game, or the one made for phones too. */
export const RustFixtureKind = { Game: "game", Mobile: "mobile" } as const;
export type RustFixtureKind = (typeof RustFixtureKind)[keyof typeof RustFixtureKind];

/** The `rust-mobile-game` fixture's game: a Rust · wgpu game for the browser, iPhone and Android. */
export const FIXTURE_RUST_MOBILE_GAME = {
  name: "ferris-pocket",
  title: "Ferris Pocket",
  targets: [BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android],
} as const;

/** The word in a game's `src/main.rs` that makes the stub cargo fail as rustc would. */
export const FIXTURE_RUST_FORCE_ERROR = "GENEX_FORCE_ERROR";

/** The diagnostic the stub cargo reports for {@link FIXTURE_RUST_FORCE_ERROR}: rustc's own wording. */
export const FIXTURE_RUST_FORCED_ERROR = {
  code: "E0425",
  message: `cannot find value \`${FIXTURE_RUST_FORCE_ERROR}\` in this scope`,
  file: "src/main.rs",
} as const;

/** What the stub `rustc -vV` names: a release no real compiler has, so a receipt shows the stub ran. */
export const FIXTURE_RUSTC_IDENTITY = {
  release: "1.99.0",
  commitHash: "genex-fixture-stub",
  llvm: "21.1.2",
} as const;

/** The genex release the fixture's vendored tree and lock hold. */
export const FIXTURE_GENEX_VERSION = "0.1.0";

/** The committed wasm-bindgen output's files, as the stub tools serve them. */
export const FIXTURE_RUST_WEB_FILES = { module: "game.js", wasm: "game_bg.wasm", page: "index.html" } as const;

/** In the wasm-bindgen component's folder: where the stub tools keep the committed web output. */
const WEB_OUTPUT_DIR = "share/genex-fixture-web";
/** In the sysroot: the dev-flavour game the stub cargo admits (a script starting the fd-3 stub). */
const STUDIO_GAME_FILE = "share/genex-fixture/studio-game";
/**
 * What the stub cargo looks for in the staged manifest: the facade's `studio` feature
 * (`cargoManifest`), always the first named, alone or before the system switches a game keeps.
 */
const STUDIO_FEATURE_START = 'features = ["studio"';
/** The compiler flags the lane builds every game with, recorded in each prewarm as the store does. */
const FIXTURE_RUSTFLAGS = ["-F", "unsafe_code"];
/** In each prewarmed target folder: the one output the record names, so a locate finds it present. */
const PREWARM_OUTPUT = ".genex-fixture-prewarm";
/** Written into each seeded file that only has to exist. */
const PLACEHOLDER = "genex fixture: never run\n";
const WHEN = "2026-10-01T00:00:00.000Z";
const RECORD_SCHEMA = 1;
/** The span numbers the forced error's JSON carries before the stub fills in the line and column. */
const LINE_SLOT = 909_101;
const COLUMN_SLOT = 909_102;

/** One component the fake Rust store holds: its folder's files and which of them are stub scripts. */
interface FakeRustComponent {
  id: ToolchainId;
  version: string;
  /** The component's own host, or null for a target library or the vendored tree. */
  hosted: boolean;
  /** The destination a standard library is for; absent for a tool or the vendored tree. */
  target?: BuildTarget;
  files: Readonly<Record<string, string>>;
}

/** The phones' standard libraries the mobile fixture's lock names, as `STACK_REQUIRED_COMPONENTS` asks. */
const PHONE_STDS = [
  [ToolchainId.RustStdIos, BuildTarget.Ios],
  [ToolchainId.RustStdIosSim, BuildTarget.Ios],
  [ToolchainId.RustStdAndroid, BuildTarget.Android],
] as const;

/** The lock the stub's `generate-lockfile` writes: the game and the vendored genex, nothing else. */
export function fixtureRustLock(): string {
  return [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    "version = 4",
    "",
    "[[package]]",
    'name = "genex"',
    `version = "${FIXTURE_GENEX_VERSION}"`,
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    `checksum = "${createHash("sha256").update(`genex-fixture:genex@${FIXTURE_GENEX_VERSION}`).digest("hex")}"`,
    "",
    "[[package]]",
    'name = "genex-game"',
    'version = "0.1.0"',
    'dependencies = ["genex"]',
    "",
  ].join("\n");
}

/** The forced error as Cargo prints it, a `printf` format whose four `%s` are line, column, line, column. */
function forcedErrorFormat(): string {
  const { code, message, file } = FIXTURE_RUST_FORCED_ERROR;
  const at = `${file}:${LINE_SLOT}:${COLUMN_SLOT}`;
  const span = { file_name: file, line_start: LINE_SLOT, column_start: COLUMN_SLOT, is_primary: true };
  const json = JSON.stringify({
    reason: "compiler-message",
    package_id: "genex-game 0.1.0 (path+file:///stage)",
    message: {
      message,
      code: { code, explanation: null },
      level: "error",
      spans: [span],
      children: [],
      rendered: `error[${code}]: ${message}\n --> ${at}\n`,
    },
  });
  return json
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "%%")
    .replaceAll(String(LINE_SLOT), "%s")
    .replaceAll(String(COLUMN_SLOT), "%s");
}

/** How long the stub cargo's clippy and build take, in ms, for the browser and for a desktop triple (PW's Play timings). */
export interface FixtureRustDelays {
  web: { clippy: number; build: number };
  desktop: { clippy: number; build: number };
}

/** A stub that answers at once: every fixture launch but one that asks for delays. */
export const NO_RUST_DELAYS: FixtureRustDelays = { web: { clippy: 0, build: 0 }, desktop: { clippy: 0, build: 0 } };

/** The longest a stub step may be asked to take: a contended Play is minutes, never more. */
const STUB_DELAY_MAX_MS = 10 * 60 * 1000;

/**
 * The delays a fixture launch asks for: `STUDIO_FIXTURE_RUST_WEB_MS` and `STUDIO_FIXTURE_RUST_MAC_MS`,
 * each `<clippy ms>,<build ms>` (a Mac build's receipt was clippy 19 s, build 43 s; the web's 0.7 s and
 * 1.4 s). Anything else, or a number out of range, is no delay.
 */
export function fixtureRustDelays(env: NodeJS.ProcessEnv): FixtureRustDelays {
  const pair = (value: string | undefined) => {
    const [clippy, build] = (value ?? "").split(",").map((part) => Number(part.trim()));
    const fits = (ms: number | undefined): ms is number =>
      typeof ms === "number" && Number.isInteger(ms) && ms >= 0 && ms <= STUB_DELAY_MAX_MS;
    return fits(clippy) && fits(build) ? { clippy, build } : { clippy: 0, build: 0 };
  };
  return { web: pair(env.STUDIO_FIXTURE_RUST_WEB_MS), desktop: pair(env.STUDIO_FIXTURE_RUST_MAC_MS) };
}

/** `ms` as `sleep`'s seconds, or nothing for no delay. */
function stubSleep(ms: number): string {
  return ms > 0 ? `/bin/sleep ${(ms / 1000).toFixed(3)}` : ":";
}

/** The stub `cargo`: a lock, the forced error, or the artifact a destination's build would name. */
export function stubRustCargo(
  webOutput: string,
  studioGame: string,
  delays: FixtureRustDelays = NO_RUST_DELAYS,
): string {
  const wasm = shellQuote(path.join(webOutput, FIXTURE_RUST_WEB_FILES.wasm));
  const studio = shellQuote(studioGame);
  return `#!/bin/sh
# Genex fixture stand-in for cargo (the rust-game fixture): no compiler runs and nothing is fetched.
sub=\${1:-}
[ $# -gt 0 ] && shift
case "$sub" in --version|-V) echo "cargo ${FIXTURE_RUSTC_IDENTITY.release} (genex fixture stub)"; exit 0 ;; esac
json() { printf '%s' "$1" | /usr/bin/sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }
manifest=""; triple=""; profile=debug; prev=""
for a in "$@"; do
  [ "$prev" = --manifest-path ] && manifest=$a
  [ "$prev" = --target ] && triple=$a
  [ "$a" = --release ] && profile=release
  prev=$a
done
[ -n "$manifest" ] || { echo "error: genex fixture cargo: no --manifest-path" >&2; exit 101; }
stage=$(/usr/bin/dirname "$manifest")
case "$sub" in
  generate-lockfile) printf '%s' ${shellQuote(fixtureRustLock())} > "$stage/Cargo.lock" || exit 101; exit 0 ;;
  clippy|build) ;;
  *) echo "error: genex fixture cargo: no subcommand $sub" >&2; exit 101 ;;
esac
echo "   Compiling genex-game v0.1.0 ($stage)" >&2
if /usr/bin/grep -q ${FIXTURE_RUST_FORCE_ERROR} "$stage/src/main.rs" 2>/dev/null; then
  line=$(/usr/bin/grep -n ${FIXTURE_RUST_FORCE_ERROR} "$stage/src/main.rs" | /usr/bin/head -n 1 | /usr/bin/cut -d: -f1)
  text=$(/usr/bin/sed -n "\${line}p" "$stage/src/main.rs")
  before=\${text%%${FIXTURE_RUST_FORCE_ERROR}*}
  column=$((\${#before} + 1))
  echo "genex fixture: a build script's chatter, which is not JSON"
  printf ${shellQuote(`${forcedErrorFormat()}\\n`)} "$line" "$column" "$line" "$column"
  echo '{"reason":"build-finished","success":false}'
  echo "error: could not compile \\\`genex-game\\\` (bin \\"game\\") due to 1 previous error" >&2
  exit 101
fi
case "$sub:$triple" in
  clippy:wasm32-*) ${stubSleep(delays.web.clippy)} ;;
  build:wasm32-*) ${stubSleep(delays.web.build)} ;;
  clippy:*) ${stubSleep(delays.desktop.clippy)} ;;
  build:*) ${stubSleep(delays.desktop.build)} ;;
esac
if [ "$sub" = clippy ]; then echo '{"reason":"build-finished","success":true}'; exit 0; fi
out="$CARGO_TARGET_DIR/$triple/$profile"
/bin/mkdir -p "$out" || exit 101
case "$triple" in
  wasm32-*) exe="$out/game.wasm"; /bin/cp ${wasm} "$exe" || exit 101 ;;
  *) exe="$out/game"
     if /usr/bin/grep -qF ${shellQuote(STUDIO_FEATURE_START)} "$manifest"; then
       /bin/cp ${studio} "$exe" && /bin/chmod 755 "$exe" || exit 101
     else
       printf '#!/bin/sh\\necho "genex fixture game: built by the stub cargo; it draws nothing"\\n' > "$exe" || exit 101
       /bin/chmod 755 "$exe" || exit 101
     fi ;;
esac
printf '{"reason":"compiler-artifact","package_id":"path+file://%s#genex-game@0.1.0","manifest_path":"%s","target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["%s"],"executable":"%s","fresh":false}\\n' \\
  "$(json "$stage")" "$(json "$manifest")" "$(json "$exe")" "$(json "$exe")"
echo '{"reason":"build-finished","success":true}'
`;
}

/** The dev-flavour game the stub cargo admits: this Node running the checkout's fd-3 stub, with the game's arguments. */
export function stubStudioGame(): string {
  const script = path.join(fixtureCheckoutRoot(), "tests", "fixtures", "rust-fd3-stub-game.mjs");
  return `#!/bin/sh
# Genex fixture: a dev-flavour Rust game's stand-in, serving contract v2 on fd 3.
exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"
`;
}

/** The stub `rustc`: answers its identity (`-vV`) and compiles nothing. */
export function stubRustc(hostTriple: string): string {
  const { release, commitHash, llvm } = FIXTURE_RUSTC_IDENTITY;
  const lines = [
    `rustc ${release} (genex fixture stub)`,
    "binary: rustc",
    `commit-hash: ${commitHash}`,
    "commit-date: 2026-10-01",
    `host: ${hostTriple}`,
    `release: ${release}`,
    `LLVM version: ${llvm}`,
  ];
  return `#!/bin/sh
# Genex fixture stand-in for rustc (the rust-game fixture).
case "\${1:-}" in
  -vV) printf '%s\\n' ${lines.map(shellQuote).join(" ")}; exit 0 ;;
  -V|--version) echo ${shellQuote(lines[0] ?? "")}; exit 0 ;;
esac
echo "error: genex fixture rustc compiles nothing" >&2
exit 1
`;
}

/** The stub `wasm-bindgen`: writes the committed `game.js` and `game_bg.wasm` under the asked name. */
export function stubWasmBindgen(webOutput: string): string {
  const module = shellQuote(path.join(webOutput, FIXTURE_RUST_WEB_FILES.module));
  const wasm = shellQuote(path.join(webOutput, FIXTURE_RUST_WEB_FILES.wasm));
  return `#!/bin/sh
# Genex fixture stand-in for wasm-bindgen (the rust-game fixture): it serves the committed output.
case "\${1:-}" in --version|-V) echo "wasm-bindgen 0.2.129"; exit 0 ;; esac
out=""; name=game; input=""; prev=""
for a in "$@"; do
  if [ "$prev" = --out-dir ]; then out=$a
  elif [ "$prev" = --out-name ]; then name=$a
  else case "$a" in *.wasm) input=$a ;; esac
  fi
  prev=$a
done
[ -n "$out" ] && [ -n "$input" ] || { echo "error: expected --out-dir <dir> and an input .wasm" >&2; exit 1; }
[ -f "$input" ] || { echo "error: $input is not a file" >&2; exit 1; }
/bin/mkdir -p "$out" || exit 1
/bin/cp ${module} "$out/$name.js" && /bin/cp ${wasm} "$out/\${name}_bg.wasm"
`;
}

/** The stub `wasm-opt`: `<in> -o <out>` copies; every flag is accepted and ignored. */
const STUB_WASM_OPT = `#!/bin/sh
# Genex fixture stand-in for wasm-opt (the rust-game fixture).
case "\${1:-}" in --version) echo "wasm-opt version 133 (genex fixture stub)"; exit 0 ;; esac
out=""; input=""; prev=""
for a in "$@"; do
  if [ "$prev" = -o ]; then out=$a
  else case "$a" in -*) ;; *) input=$a ;; esac
  fi
  prev=$a
done
[ -n "$out" ] && [ -n "$input" ] || { echo "error: expected <in.wasm> -o <out.wasm>" >&2; exit 1; }
[ "$input" = "$out" ] || /bin/cp "$input" "$out"
`;

/** The stub `cargo-clippy`: the lane runs clippy through `cargo clippy`, never this directly. */
const STUB_CLIPPY = `#!/bin/sh
echo "error: genex fixture: run clippy through cargo clippy" >&2
exit 1
`;

/**
 * The fake components, with their stub scripts at the paths the store's layout names. The stub
 * wasm-bindgen serves the copy of the committed output inside its own component folder: a build's
 * sandbox reads the store, never the checkout (the core denies the home folder it sits in).
 */
function fakeRustComponents(store: string, kind: RustFixtureKind): FakeRustComponent[] {
  const vendored = `${RUST_VENDOR_LAYOUT}/genex-${FIXTURE_GENEX_VERSION}`;
  const bindgen = { id: ToolchainId.WasmBindgen, version: "0.2.129" };
  const webOutput = path.join(fakeComponentFolder(store, bindgen), ...WEB_OUTPUT_DIR.split("/"));
  return [
    {
      id: ToolchainId.Rust,
      version: FIXTURE_RUSTC_IDENTITY.release,
      hosted: true,
      files: {
        [RUST_COMPONENT_LAYOUT.rustc]: PLACEHOLDER,
        [RUST_COMPONENT_LAYOUT.cargo]: PLACEHOLDER,
        [RUST_COMPONENT_LAYOUT.clippy]: PLACEHOLDER,
      },
    },
    {
      id: ToolchainId.RustStdWasm,
      version: FIXTURE_RUSTC_IDENTITY.release,
      hosted: false,
      target: BuildTarget.Web,
      files: { [`${RUST_COMPONENT_LAYOUT.wasmStd}/libstd.rlib`]: PLACEHOLDER },
    },
    ...(kind === RustFixtureKind.Mobile ? PHONE_STDS : []).map(([id, target]) => ({
      id,
      version: FIXTURE_RUSTC_IDENTITY.release,
      hosted: false,
      target,
      files: { [`${MOBILE_COMPONENT_LAYOUT.std[id]}/libstd.rlib`]: PLACEHOLDER },
    })),
    {
      ...bindgen,
      hosted: true,
      files: { [RUST_COMPONENT_LAYOUT.wasmBindgen]: stubWasmBindgen(webOutput) },
    },
    {
      id: ToolchainId.Binaryen,
      version: "133",
      hosted: true,
      files: { [RUST_COMPONENT_LAYOUT.wasmOpt]: STUB_WASM_OPT },
    },
    {
      id: ToolchainId.RustVendor,
      version: "0.0.0-fixture",
      hosted: false,
      files: {
        [`${vendored}/Cargo.toml`]: `[package]\nname = "genex"\nversion = "${FIXTURE_GENEX_VERSION}"\nedition = "2024"\n`,
        [`${vendored}/src/lib.rs`]: "//! genex fixture: never compiled\n",
        [`${vendored}/.cargo-checksum.json`]: '{"files":{},"package":null}\n',
      },
    },
  ];
}

/** A stable digest per fake component, as an install folder is named. */
function fakeSha256(component: Pick<FakeRustComponent, "id" | "version">): string {
  return createHash("sha256").update(`genex-fixture:${component.id}@${component.version}`).digest("hex");
}

/** A fake component's install folder in `store`, named as the store names one: `<id>/<version>-<sha12>`. */
function fakeComponentFolder(store: string, component: Pick<FakeRustComponent, "id" | "version">): string {
  return path.join(store, component.id, `${component.version}-${fakeSha256(component).slice(0, 12)}`);
}

/** Whether a seeded file is a script the store runs (everything starting with `#!`). */
function modeOf(text: string): number {
  return text.startsWith("#!") ? 0o755 : 0o644;
}

/** Writes `files` (relative, `/`-separated) under `folder`; answers their bytes. */
async function writeTree(folder: string, files: Readonly<Record<string, string>>): Promise<number> {
  let bytes = 0;
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(folder, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode: modeOf(text) });
    bytes += Buffer.byteLength(text);
  }
  return bytes;
}

/** Copies the committed web output (`game.js`, `game_bg.wasm`, `index.html`) into `to`; answers its bytes. */
async function copyWebOutput(from: string, to: string): Promise<number> {
  await mkdir(to, { recursive: true });
  const wanted: ReadonlySet<string> = new Set(Object.values(FIXTURE_RUST_WEB_FILES));
  const names = (await readdir(from).catch(() => [] as string[])).filter((name) => wanted.has(name));
  let bytes = 0;
  for (const name of names) {
    await copyFile(path.join(from, name), path.join(to, name));
    bytes += (await stat(path.join(to, name))).size;
  }
  return bytes;
}

/** One component's install folder and receipt. */
async function seedRustComponent(
  store: string,
  component: FakeRustComponent,
  place: { host: ToolchainHost; webOutput: string },
): Promise<ToolchainReceipt> {
  const sha256 = fakeSha256(component);
  const sha12 = sha256.slice(0, 12);
  const folder = fakeComponentFolder(store, component);
  let bytes = await writeTree(folder, component.files);
  if (component.id === ToolchainId.WasmBindgen)
    bytes += await copyWebOutput(place.webOutput, path.join(folder, ...WEB_OUTPUT_DIR.split("/")));
  const receipt: ToolchainReceipt = {
    id: component.id,
    version: component.version,
    sha256,
    sha12,
    bytes,
    host: component.hosted ? place.host : null,
    target: component.target ?? null,
    source: ReceiptSource.Archive,
    installedAt: WHEN,
  };
  await writeFile(path.join(folder, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** The destinations a fixture kind prewarms: the host's and the browser, and the phones for the mobile one. */
export function fixtureRustTargets(kind: RustFixtureKind): BuildTarget[] {
  const desktop = [BuildTarget.Mac, BuildTarget.Web];
  return kind === RustFixtureKind.Mobile ? [...desktop, BuildTarget.Ios, BuildTarget.Android] : desktop;
}

/** The lock folder: the assembled sysroot of stubs, CARGO_HOME, the base record and each destination's prewarm. */
async function seedRustLockFolder(
  store: string,
  lock: ToolchainLock,
  place: {
    host: ToolchainHost;
    webOutput: string;
    vendor: string;
    targets: readonly BuildTarget[];
    delays: FixtureRustDelays;
  },
): Promise<void> {
  const hostTriple = RUST_HOST_TRIPLE[place.host];
  const sysroot = rustSysroot(store, lock);
  const webOutput = path.join(componentDir(store, lock, ToolchainId.WasmBindgen), WEB_OUTPUT_DIR);
  await writeTree(sysroot, {
    "bin/cargo": stubRustCargo(webOutput, path.join(sysroot, ...STUDIO_GAME_FILE.split("/")), place.delays),
    [STUDIO_GAME_FILE]: stubStudioGame(),
    "bin/rustc": stubRustc(hostTriple),
    "bin/cargo-clippy": STUB_CLIPPY,
    "bin/clippy-driver": STUB_CLIPPY,
  });
  await writeTree(rustCargoHome(store, lock), {
    "config.toml": rustCargoConfig(place.vendor),
    "clippy.toml": "# genex fixture: the stub cargo reads no clippy configuration\n",
  });
  const triples = [hostTriple, ...place.targets.filter((t) => t !== BuildTarget.Mac).map((t) => RUST_TRIPLE[t])];
  const base: RustBaseRecord = {
    schema: RECORD_SCHEMA,
    lock: lock.digest,
    triples: [...new Set(triples)],
    vendor: await treeDigest(place.vendor),
    at: WHEN,
  };
  await writeTree(lockFolder(store, lock), { [RUST_BASE_FILE]: `${JSON.stringify(base, null, 2)}\n` });
  for (const target of place.targets) await seedRustPrewarm(store, lock, target);
}

/** One destination's prewarm: a target folder holding the one output its record names, and the warm lock. */
async function seedRustPrewarm(store: string, lock: ToolchainLock, target: BuildTarget): Promise<void> {
  const triple = RUST_TRIPLE[target];
  const output = `${triple}/debug/${PREWARM_OUTPUT}`;
  const bytes = await writeTree(rustPrewarmedTargetDir(store, lock, target), { [output]: PLACEHOLDER });
  const record: RustPrewarmRecord = {
    schema: RECORD_SCHEMA,
    lock: lock.digest,
    target,
    triple,
    rustflags: FIXTURE_RUSTFLAGS,
    profile: [...RUST_DEV_PROFILE_SETTINGS],
    steps: [],
    outputs: [output],
    units: 0,
    bytes,
    at: WHEN,
  };
  await writeTree(rustTargetFolder(store, lock, target), {
    [RUST_PREWARM_FILE]: `${JSON.stringify(record, null, 2)}\n`,
    [RUST_WARM_LOCK_FILE]: fixtureRustLock(),
  });
}

/** The install folder of `id` at `lock`'s pin. */
function componentDir(store: string, lock: ToolchainLock, id: ToolchainId): string {
  const pin = lock.entries[id];
  return path.join(store, id, `${pin?.version}-${pin?.sha12}`);
}

/** Whether `store` may be seeded: absent, empty, or one a fixture seeded (its marker). */
async function isFixtureStore(store: string): Promise<boolean> {
  const names = await readdir(store).catch((error: NodeJS.ErrnoException): string[] | null =>
    error.code === "ENOENT" ? [] : null,
  );
  return names !== null && (names.length === 0 || names.includes(FIXTURE_STORE_MARKER));
}

/**
 * Seeds the fake Rust store into `store` (a fixture profile's `layout.toolchains`, or a test's
 * folder) and makes its lock the Rust stack's current one; answers the lock. Null, and nothing
 * written, when `store` holds something no fixture seeded, or is a link.
 */
export async function seedFixtureRustStore(
  store: string,
  options: { webOutput: string; kind?: RustFixtureKind; platform?: NodeJS.Platform; delays?: FixtureRustDelays },
): Promise<ToolchainLock | null> {
  const linked = await lstat(store).catch(() => null);
  if (linked?.isSymbolicLink() || !(await isFixtureStore(store))) return null;
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, FIXTURE_STORE_MARKER), "A Genex fixture's disposable toolchain store.\n");
  const host = toolchainHostOf(options.platform ?? process.platform, process.arch) ?? ToolchainHost.MacArm64;
  const entries: ToolchainLock["entries"] = {};
  const kind = options.kind ?? RustFixtureKind.Game;
  for (const component of fakeRustComponents(store, kind)) {
    const receipt = await seedRustComponent(store, component, { host, webOutput: options.webOutput });
    entries[component.id] = { version: receipt.version, sha12: receipt.sha12 };
  }
  const lock = lockOf(entries);
  const vendor = path.join(componentDir(store, lock, ToolchainId.RustVendor), RUST_VENDOR_LAYOUT);
  const targets = fixtureRustTargets(kind);
  const delays = options.delays ?? NO_RUST_DELAYS;
  await seedRustLockFolder(store, lock, { host, webOutput: options.webOutput, vendor, targets, delays });
  await writeCurrentLock(store, lock, GameStack.RustWgpu);
  return lock;
}

/** The committed wasm-bindgen output the stub tools serve (`tests/fixtures/rust-wasm/`). */
export function fixtureRustWebOutput(): string {
  return path.join(fixtureCheckoutRoot(), "tests", "fixtures", "rust-wasm");
}

/** The mobile fixture's game, scaffolded once through the library with its chat. */
async function seedRustMobileGame(core: StudioCore): Promise<void> {
  const { name, title, targets } = FIXTURE_RUST_MOBILE_GAME;
  if ((await core.games.list()).some((game) => game.name === name)) return;
  await core.games.scaffold(name, { title, stack: GameStack.RustWgpu, targets: [...targets] });
  await core.threadForGame(name);
}

/**
 * A Rust fixture's seed: its game (`ferris-rust`, and `ferris-pocket` for the mobile kind), then
 * the stub Rust store and its crate requests (`fixture-crates.ts`). It runs on every launch, so a reused profile gets the store this checkout's
 * stubs describe. The core's Rust lane (`core/rust-lane.ts`) builds over this store; its Mac build
 * is the fd-3 stub script, not a Mach-O, so the wgpu admission refuses a Native run of it
 * (`not-an-executable`): Live's Native view needs a real Rust dev store.
 */
export async function seedRustFixture(core: StudioCore, kind: RustFixtureKind): Promise<void> {
  await seedRustGame(core);
  if (kind === RustFixtureKind.Mobile) await seedRustMobileGame(core);
  const delays = fixtureRustDelays(process.env);
  await seedFixtureRustStore(core.layout.toolchains, { webOutput: fixtureRustWebOutput(), kind, delays });
  startFixtureContention(core, process.env);
  startFixtureOffer(core, process.env);
  // The person's crate card in Settings → Toolchains: one request in each state it shows.
  await seedFixtureCrateRequests(core.layout.toolchains, FIXTURE_RUST_GAME.name);
}

/** How many copies the contention may build at most, and how long each holds its window once loaded. */
const CONTEND_COPIES_MAX = 12;
const CONTEND_HOLD_MS = 2 * 60 * 1000;
/** Where the contention's copies of the game live, under the app's scratch. */
const CONTEND_FOLDER = "fixture-contend";

/**
 * A fake run's checks while the person presses Play (lane PW): `STUDIO_FIXTURE_RUST_CONTEND=<n>[,<after ms>]`
 * makes `n` copies of the fixture's game, each with a file of its own (so no two share a build), and
 * `after ms` after the launch starts an agent's judged look at each one's Mac build: native leases and
 * build slots, held {@link CONTEND_HOLD_MS} once loaded. Nothing without the variable; never fails the seed.
 */
export function startFixtureContention(core: StudioCore, env: NodeJS.ProcessEnv): void {
  const [count, after] = (env.STUDIO_FIXTURE_RUST_CONTEND ?? "").split(",").map((part) => Number(part.trim()));
  if (!Number.isInteger(count) || !count || count < 1 || count > CONTEND_COPIES_MAX) return;
  const delayMs = Number.isInteger(after) && after !== undefined && after >= 0 ? after : 0;
  void contend(core, count, delayMs).catch(() => {});
}

async function contend(core: StudioCore, count: number, delayMs: number): Promise<void> {
  await sleep(delayMs);
  const project = FIXTURE_RUST_GAME.name;
  const gameDir = core.games.dirFor(project);
  const head = (await gitOrNull(gameDir, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return;
  core.snapshots.register({ name: project, dir: gameDir });
  const looks: Array<Promise<void>> = [];
  for (let i = 0; i < count; i++) {
    const dir = path.join(core.layout.scratch, CONTEND_FOLDER, `${project}-${i}-${Date.now()}`);
    await mkdir(path.dirname(dir), { recursive: true });
    await core.snapshots.worktreeAt(project, head, dir);
    await writeFile(path.join(dir, "assets", `contend-${i}.txt`), `copy ${i}\n`);
    looks.push(core.fixtureAgentLook(project, dir, BuildTarget.Mac, CONTEND_HOLD_MS));
  }
  await Promise.all(looks);
}

/** How long the offered build waits for Live to show the fixture's game, and how often it looks. */
const OFFER_WAIT_MS = 15 * 60 * 1000;
const OFFER_POLL_MS = 1000;
/** The canvas Live's Native view asks for in the fixture's timed Plays. */
const PLAY_SURFACE = { width: 1280, height: 720, dpr: 2 } as const;

/**
 * A build for the person to Play (lane PW). `STUDIO_FIXTURE_RUST_OFFER=1` commits a change of the
 * fixture's game in a copy of its own (the game folder's HEAD stays) and offers that commit to Live
 * once Live shows the game, so the stage's Update plays it as Play latest does.
 * `STUDIO_FIXTURE_RUST_HEALTHY=1` first records that commit integrated healthy (Play's background
 * build of it starts). `STUDIO_FIXTURE_RUST_PLAY=<after ms>[,<plays>]` instead presses Play on that commit itself, `after ms`
 * after the launch, through the same `showBuild` the Play buttons call, then starts Live's Native
 * view on the copy Live shows; `plays` times (default 2: the second Play of the same commit). Each
 * Play is a `[play]` line in the Studio log. A fresh commit each launch: no earlier build of it exists.
 */
export function startFixtureOffer(core: StudioCore, env: NodeJS.ProcessEnv): void {
  const [after, plays] = (env.STUDIO_FIXTURE_RUST_PLAY ?? "").split(",").map((part) => Number(part.trim()));
  const playing = Number.isInteger(after) && after !== undefined && after >= 0;
  if (env.STUDIO_FIXTURE_RUST_OFFER !== "1" && !playing) return;
  const times = Number.isInteger(plays) && plays !== undefined && plays > 0 && plays <= 5 ? plays : 2;
  const healthy = env.STUDIO_FIXTURE_RUST_HEALTHY === "1";
  void fixtureCommit(core)
    .then(async (commit) => {
      if (!commit) return;
      if (healthy) await integratedHealthy(core, commit);
      return playing ? playTimes(core, commit, after, times) : offerBuild(core, commit);
    })
    .catch(() => {});
}

/** The commit integrated healthy, as a run's lead records it: what starts Play's background build of it. */
async function integratedHealthy(core: StudioCore, commit: string): Promise<void> {
  const project = FIXTURE_RUST_GAME.name;
  const thread = await core.threadForGame(project);
  const health = customEventData(CustomEvent.IntegrationHealth, { head: commit, ok: true, problems: [] });
  await core.append([health], thread);
}

/** A commit of the fixture's game made in a copy of its own, with a file the game folder lacks; null when git cannot. */
async function fixtureCommit(core: StudioCore): Promise<string | null> {
  const project = FIXTURE_RUST_GAME.name;
  const gameDir = core.games.dirFor(project);
  const head = (await gitOrNull(gameDir, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return null;
  core.snapshots.register({ name: project, dir: gameDir });
  const dir = path.join(core.layout.scratch, CONTEND_FOLDER, `${project}-offer-${Date.now()}`);
  await mkdir(path.dirname(dir), { recursive: true });
  await core.snapshots.worktreeAt(project, head, dir);
  await writeFile(path.join(dir, "assets", "offered.txt"), `offered ${new Date().toISOString()}\n`);
  const identity = ["-c", "user.name=Genex fixture", "-c", "user.email=fixture@genex.invalid"];
  await gitOrNull(dir, ["add", "-A"]);
  await gitOrNull(dir, [...identity, "commit", "-q", "-m", "fixture: a build to play"]);
  const commit = (await gitOrNull(dir, ["rev-parse", "HEAD"]))?.trim();
  return commit && commit !== head ? commit : null;
}

async function offerBuild(core: StudioCore, commit: string): Promise<void> {
  const project = FIXTURE_RUST_GAME.name;
  const until = Date.now() + OFFER_WAIT_MS;
  while (Date.now() < until) {
    await core.offerBuild(project, commit).catch(() => null);
    if (core.liveState(project).commit === commit) return;
    await sleep(OFFER_POLL_MS);
  }
}

/** Play on `commit`, `times` times one after another, each with Live's Native view on the copy Live then shows. */
async function playTimes(core: StudioCore, commit: string, afterMs: number, times: number): Promise<void> {
  const project = FIXTURE_RUST_GAME.name;
  await sleep(afterMs);
  for (let i = 0; i < times; i++) {
    const shown = await core.showBuild(project, commit).catch(() => null);
    const root = shown?.dir;
    await core.nativeRuns
      .embed({ project, target: BuildTarget.Mac, surface: { ...PLAY_SURFACE }, ...(root ? { root } : {}) })
      .catch(() => null);
  }
}
