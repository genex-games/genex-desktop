/**
 * The Rust lane's web branch (M2.9): what turns the `wasm32-unknown-unknown` module cargo built
 * into the folder a browser opens, `index.html` (the template's WebGPU-only shell) beside the
 * wasm-bindgen ES module `game.js` and `game_bg.wasm`.
 *
 * {@link RUST_WEB_BUILDER} is the web row of `RUST_TARGET_BUILDERS` (`rust-build.ts`): cargo builds
 * the game's binary for wasm32, and the module it names is the lane's artifact. {@link packageWeb}
 * then runs, through the build's own sandbox (the `run` the lane hands it):
 *
 * 1. `wasm-bindgen --version`, refused unless it is the pinned {@link WASM_BINDGEN_VERSION} (the
 *    CLI must match the `wasm-bindgen` crate in the lock byte for byte, or the glue is wrong);
 * 2. `wasm-bindgen --target web` into a fresh output folder (a link there is refused, nothing is
 *    written through one);
 * 3. `wasm-opt -Oz` (binaryen {@link BINARYEN_VERSION}) for an optimized build, with
 *    `--symbolmap` into the export's debug folder outside the served one (CRASH-7a,
 *    `substrate/rust-debug-files.ts`): `-Oz` drops the name section from the module players get,
 *    and the map names each `wasm-function[N]` of a crash record's frames;
 * 4. a check that the folder holds only regular files the tools wrote (a link they left is refused);
 * 5. `index.html` from the shell with the game's title HTML-escaped and its loading screen styled
 *    by `[render.loading]` (`shared/loading-style.ts`), and `size.json`;
 * 6. the receipt: tool versions, the module's bytes, their `gzip -9` size against the game's own
 *    budget (`genex.toml` `[web] wasm_budget_mb`, default {@link WEB_WASM_BUDGET_DEFAULT_MB} MB) and
 *    the {@link WEB_WASM_CEILING_MB} MB ceiling, and every served file's sha256. An optimized module
 *    past its game's budget is served with the `wasm-over-target` warning (a slower first load on
 *    phones and weak devices, owner decision 2026-10-11); only one past the ceiling is refused
 *    `wasm-over-budget`, its receipt still written. An unoptimized (Live) one is always served
 *    without a warning, its sizes recorded.
 *
 * An export's cargo build uses {@link RUST_WEB_EXPORT_PROFILE_SETTINGS}, a size profile for the
 * module players download; Live and the other destinations keep cargo's own profiles.
 *
 * The lane then copies the staged `assets/` beside the page and writes {@link webAssetMap}'s
 * `assets.json` (`writeOutput` in `rust-build.ts`): a browser cannot list a folder, so the shell
 * fetches the files the map names and the module admits each only when it is exactly the length
 * and FNV-1a 64 recorded (genex-platform-web's `assets`), under the same asset-path rule and caps.
 * Map v2 tags a texture's family files (`<stem>.<family>.ktx2`, C-16) with their `family` and the
 * texture they are `of`, so the module plans only the one the adapter samples; the image is tagged
 * `source`, and left out beside a family file, only when the runtime never falls back to it.
 *
 * A `[net]` game's build ({@link WebPackageInput.net}, MP-5a) also serves the relay client's JS
 * bridge: the pinned `bridge.global.js` ({@link MULTIPLAYER_BRIDGE_PIN}) and the build's ESM shim
 * under {@link WEB_NET_FILES}, with the import map and classic script tag the page carries only
 * then ({@link webShellPage}). The bridge is checked (a regular file, never a link, exactly the
 * pinned size and sha256) before anything is written, and refused `mp-bridge-refused` otherwise;
 * the receipt records `mpBridgeBytes` and `mpBridgeGzip`. Every other build is unchanged.
 *
 * The refusal of a web build for a game that declares native-enhanced features
 * (`native-features-web`) is the stage's (`rust-stage.ts`), before cargo runs.
 *
 * The core registers {@link RUST_WEB_BUILDER} over the lane's table (`rustTargetBuilders` in
 * `core/internals.ts`), and the lane calls {@link packageWeb} at admission (`#packageWeb` in
 * `rust-build.ts`): the `executables` row names the module cargo built, the served folder is
 * `packageWeb`'s `out`, the tools are the store's wasm-bindgen and wasm-opt, the shell the app's
 * own, and the receipt sits under the build receipt's `web`.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { MINUTE_MS } from "../shared/duration.ts";
import {
  type ExportWarning,
  ExportWarningCode,
  WEB_BUDGET_MB_BYTES,
  WEB_WASM_BUDGET_DEFAULT_MB,
  WEB_WASM_CEILING_BYTES,
  WEB_WASM_CEILING_MB,
} from "../shared/game-export-contract.ts";
import { assetFormat } from "../shared/game-assets.ts";
import { LOADING_DEFAULTS, type LoadingStyle, loadingStyleProblem } from "../shared/loading-style.ts";
import { MULTIPLAYER_BRIDGE_PIN } from "../shared/toolchain.ts";
import {
  CELL_PACK_FORMAT,
  CELL_PACK_WORLD_FILE,
  TERRAIN_TILES_DIR,
  TERRAIN_TILES_FILE,
} from "../shared/world-cells.ts";
import { readKtx2Header } from "../substrate/asset-import/ktx2.ts";
import { isSafeAssetPath } from "../substrate/asset-import/safe-asset.ts";
import { ktx2LevelFacts } from "../substrate/asset-import/stream-facts.ts";
import { TextureCompression } from "../substrate/asset-import/texture-table.ts";
import { atomicWriteFile, atomicWriteText, readRegularFile } from "../substrate/fsx.ts";
import { fnv1a64Hex } from "../substrate/native-game-port.ts";
import { shellQuote } from "../substrate/shell-quote.ts";
import type { RustTargetBuilder } from "./rust-build.ts";
import { ASSET_INDEX_FILE } from "./rust-package-assets.ts";

/** The wasm-bindgen CLI the lane runs: the same version as the `wasm-bindgen` crate in the lock. */
export const WASM_BINDGEN_VERSION = "0.2.129";
/** The binaryen release whose `wasm-opt` shrinks an optimized build. */
export const BINARYEN_VERSION = "version_133";
/**
 * The release profile of a web export's cargo build, as `--config` settings: optimized for size
 * with whole-program LTO in one codegen unit (the template's module: 4.22 MB gzip on cargo's
 * defaults, 3.35 MB with these, after `wasm-opt -Oz` either way). `s` rather than `z` keeps loop
 * vectorization for the renderer's CPU work in the browser (`z` saved another 0.13 MB).
 */
export const RUST_WEB_EXPORT_PROFILE_SETTINGS: readonly string[] = Object.freeze([
  'profile.release.opt-level="s"',
  'profile.release.lto="fat"',
  "profile.release.codegen-units=1",
]);
/** How long one packaging tool may run: wasm-opt -Oz over a release module takes the longest. */
export const RUST_WEB_STEP_TIMEOUT_MS = 5 * MINUTE_MS;
/** The biggest module the branch reads back. */
const WASM_MAX_BYTES = 256 * 1024 * 1024;
/** The biggest glue module or page the branch hashes. */
const TEXT_MAX_BYTES = 16 * 1024 * 1024;
/** How many lines of a failed tool's output a refusal keeps. */
const DETAIL_LINES = 6;
/** The rustc target a web build compiles for. */
const WEB_TRIPLE = "wasm32-unknown-unknown";
/** The placeholder the template shell carries for the game's title. */
const TITLE_PLACEHOLDER = "__GAME_TITLE__";
/** The loading screen's placeholders in the template shell (`[render.loading]`, `shared/loading-style.ts`). */
const LoadingPlaceholder = {
  Title: "__LOADING_TITLE__",
  Background: "__LOADING_BACKGROUND__",
  Accent: "__LOADING_ACCENT__",
  Text: "__LOADING_TEXT__",
  Logo: "<!--__LOADING_LOGO__-->",
} as const;
/** The folder a logo path is under, beside the page. */
const LOGO_FOLDER = "assets/";
/**
 * The template shell's place for a `[net]` build's bridge tags, at the end of a line of its head:
 * every other build's page drops it and is the page it was before MP-5a, byte for byte.
 */
const NET_PLACEHOLDER = "<!--__NET_BRIDGE__-->";
/** The bare specifier the genex-multiplayer crate's web backend imports (its `#[wasm_bindgen(module)]`). */
export const MP_BRIDGE_SPECIFIER = "@genex-ai/multiplayer/bridge";
/** The wasm features the pinned Rust emits for wasm32; wasm-opt must accept and keep them. */
const WASM_OPT_FEATURES = [
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--enable-reference-types",
  "--enable-multivalue",
] as const;
/** wasm-bindgen's `--version` line. */
const BINDGEN_VERSION_LINE = /^wasm-bindgen (\S+)/m;
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** The files a web build serves, and the ones it writes on the way. */
export const WEB_FILES = {
  page: "index.html",
  module: "game.js",
  wasm: "game_bg.wasm",
  size: "size.json",
  /** wasm-opt's output, renamed over {@link WEB_FILES.wasm} once whole. */
  optimizing: "game_bg.opt.wasm",
  /** The staged assets the page fetches, by {@link WEB_FILES.assetMap}. */
  assets: "assets",
  /** {@link webAssetMap}: what the shell fetches from {@link WEB_FILES.assets} and the module checks. */
  assetMap: "assets.json",
} as const;

/**
 * The files a `[net]` game's web build serves besides {@link WEB_FILES} (MP-5a): the pinned bridge,
 * which a classic script loads before any module, and the ESM shim the import map resolves
 * {@link MP_BRIDGE_SPECIFIER} to.
 */
export const WEB_NET_FILES = {
  bridge: "mp/bridge.global.js",
  shim: "mp/bridge.mjs",
} as const;

/** The asset map's format (genex-platform-web's `ASSET_MAP_VERSION`): v2 adds a texture's `family` and `of`. */
export const WEB_ASSET_MAP_VERSION = 2;
/**
 * The side of genex-render's smallest family size class (`layout::TEXTURE_SIZE_CLASSES[1]`): the
 * runtime loads a texture's image in place of a family file under it.
 */
const FAMILY_MIN_SIDE_PX = 512;
/** The most of a family file read to find its side: the KTX2 header and its data format descriptor. */
const KTX2_HEAD_BYTES = 1024;
/** A family file's suffix (the runtime's `family_file` rule: `<stem>.<family>.ktx2`). */
const KTX2_SUFFIX = ".ktx2";
/** The family tags a family file's name may carry (`texture-table.ts`' families, exactly as spelled). */
const FAMILY_TAGS: ReadonlySet<string> = new Set(Object.values(TextureCompression));
/** A cell pack's bodies (`cells/<x>_<z>.cell`, `substrate/asset-import/world-cells.ts`), each fetched while playing. */
const CELL_BODIES_DIR = "cells";
const CELL_BODY_SUFFIX = ".cell";
/** A pack's terrain tiles (`terrain/<x>_<z>.r16`), each fetched while playing. */
const TERRAIN_TILE_SUFFIX = ".r16";
/** The most of a pack's `world.json` read to tell it is one (its `format` comes first). */
const PACK_WORLD_HEAD_BYTES = 256;
/** The largest asset index read for its named groups (the package step writes it; a bigger one names none). */
const ASSET_INDEX_MAX_BYTES = 16 * 1024 * 1024;
/**
 * The web's streaming budgets (game systems STR-14b, owner call S9): the boot and sim groups the page
 * fetches before the first frame, and the most one fetch made while playing carries (the shell
 * refuses a bigger one), which bounds the module's memory high-water at the pool plus one asset.
 */
export const WEB_STREAM_LIMITS = {
  /** The boot and sim groups together. */
  preloadBytes: 64 * 1024 * 1024,
  /** One streamed fetch: a whole streamed file, or one of its ranges. */
  fetchBytes: 64 * 1024 * 1024,
} as const;
/** The module's caps (genex-platform-web's `assets`): one file, all files, and how many. */
export const WEB_ASSET_LIMITS = {
  /** The desktop's own cap on one asset (genex-assets' `MAX_ASSET_BYTES`). */
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFiles: 4096,
} as const;
/** The caps {@link webAssetMap} applies. */
export type WebAssetLimits = { [K in keyof typeof WEB_ASSET_LIMITS]: number };

/**
 * A map entry's `family` (genex-platform-web's map v2): one GPU family file of a texture
 * (`<stem>.<family>.ktx2`) or the texture's `source` image. Wire values; never rename one.
 */
export const WebAssetFamily = { ...TextureCompression, Source: "source" } as const;
export type WebAssetFamily = (typeof WebAssetFamily)[keyof typeof WebAssetFamily];

/**
 * A map entry's `group` (genex-platform-web's map v2, genex's `AssetGroup`): `boot` and `sim` files
 * are fetched before the first reset, `stream` and `named` ones while playing, when the game wants
 * them. An entry without one is `sim`. Wire values; never rename one.
 */
export const WebAssetGroup = { Boot: "boot", Sim: "sim", Stream: "stream", Named: "named" } as const;
export type WebAssetGroup = (typeof WebAssetGroup)[keyof typeof WebAssetGroup];

/** One piece of a streamed file the page fetches by a `Range` request: where it starts, its length and FNV-1a 64. */
export interface WebAssetRange {
  offset: number;
  bytes: number;
  fnv1a64: string;
}

/** One staged file the page may fetch: its `/`-separated path under `assets/`, length and FNV-1a 64. */
export interface WebAssetEntry {
  path: string;
  bytes: number;
  fnv1a64: string;
  /** For one of a texture's files: which (the module plans one per texture for the adapter). */
  family?: WebAssetFamily;
  /** The texture the file is one of: its image's path, or the family files' stem when it has none. */
  of?: string;
  /** Its group when it is not the default `sim`, or a cell pack's index (written `sim`). */
  group?: WebAssetGroup;
  /** The `genex.toml` group of a `named` entry. */
  name?: string;
  /** A streamed KTX2's pieces: its head, then its levels smallest first (STR-14b). */
  ranges?: WebAssetRange[];
}

/** `assets.json`: every staged file the page fetches, before the game's first frame or while playing. */
export interface WebAssetMap {
  version: typeof WEB_ASSET_MAP_VERSION;
  files: WebAssetEntry[];
}
/** wasm-bindgen's `--out-name`: the module is `<name>.js`, the wasm `<name>_bg.wasm`. */
const OUT_NAME = "game";

/** The web row of the lane's builder table: cargo builds the game's binary for wasm32. */
export const RUST_WEB_BUILDER = {
  ready: true,
  triple: WEB_TRIPLE,
  macSdk: false,
  executables: [`${OUT_NAME}.wasm`],
  assets: true,
} as const satisfies RustTargetBuilder;

/** The packaging steps, in order. Wire values: receipts and logs name them. */
export const RustWebStep = {
  BindgenVersion: "bindgen-version",
  Bindgen: "bindgen",
  WasmOpt: "wasm-opt",
} as const;
export type RustWebStep = (typeof RustWebStep)[keyof typeof RustWebStep];

/** Why a web build was refused after cargo. Wire values; never rename one. */
export const RustWebRefusal = {
  /** The wasm-bindgen CLI is not the pinned version. */
  BindgenVersion: "bindgen-version",
  BindgenFailed: "bindgen-failed",
  WasmOptFailed: "wasm-opt-failed",
  /** The output folder is a link or not a folder, or the tools left a link, a folder or no module in it. */
  OutputRefused: "output-refused",
  /** An optimized `game_bg.wasm` compresses past the {@link WEB_WASM_CEILING_MB} MB ceiling, whatever its game's budget. */
  WasmOverBudget: "wasm-over-budget",
  /** A `[net]` build's bridge is missing, a link, not a regular file, or not the pinned size and sha256. */
  MpBridgeRefused: "mp-bridge-refused",
} as const;
export type RustWebRefusal = (typeof RustWebRefusal)[keyof typeof RustWebRefusal];

const MESSAGE = {
  bindgenVersion: (found: string) => `wasm-bindgen ${found || "(no version line)"} is not ${WASM_BINDGEN_VERSION}`,
  outputLinked: "the output folder is a link or not a folder",
  outputEntry: (name: string) => `${name} in the output is not a regular file the tools wrote`,
  outputMissing: (name: string) => `the tools wrote no ${name}`,
  overCeiling: (gzip: number, budgetMb: number) =>
    `game_bg.wasm is ${gzip} bytes gzipped, past the ${WEB_WASM_CEILING_MB} MB ceiling (this game's budget is ${budgetMb} MB)`,
  failed: (step: string, code: number | null) => `${step} exited ${code ?? "on a signal"}`,
  bridgeUnreadable: (file: string, pinned: number) =>
    `the multiplayer bridge ${file} is missing, a link, not a regular file or larger than the pinned ${pinned} bytes`,
  bridgeMismatch: (bytes: number, pin: WebBridgePin) =>
    `the multiplayer bridge is not @genex-ai/multiplayer ${pin.version}'s (${bytes} bytes; the pin is ${pin.bytes} bytes, sha256 ${pin.sha256})`,
} as const;

/** What one tool answered. */
export interface WebRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one quoted command line in the build's sandbox (the lane's), labelled by its step. */
export type WebRun = (command: string, step: RustWebStep) => Promise<WebRunResult>;

/** The packaging tools, as the store installed them; `wasmOpt` null when the build is not optimized. */
export interface WebTools {
  wasmBindgen: string;
  wasmOpt: string | null;
}

/** What {@link packageWeb} packages. */
export interface WebPackageInput {
  /** The module cargo built (its JSON messages named it). */
  wasm: string;
  /** The folder the browser is served from: made afresh, never through a link. */
  out: string;
  /** The template shell's text (`src/game-template-rust/web/shell.html`). */
  shell: string;
  /** The game's title (`genex.toml`), escaped into the page. */
  title: string;
  /** The game's `[render.loading]`, checked; absent: the defaults. */
  loading?: LoadingStyle;
  /** Run wasm-opt (an export or any release build). */
  optimize: boolean;
  /**
   * Where an optimized build's `wasm-opt --symbolmap` writes the function-index-to-name map
   * (CRASH-7a): outside {@link WebPackageInput.out}, never served; absent: no map.
   */
  symbolMap?: string;
  /** The game's own budget in MB of gzip (`[web] wasm_budget_mb`); absent: {@link WEB_WASM_BUDGET_DEFAULT_MB}. */
  budgetMb?: number;
  /** A `[net]` game's relay bridge (MP-5a); absent for every other game, whose build is unchanged. */
  net?: WebNetBridge;
  tools: WebTools;
  run: WebRun;
}

/** What a `[net]` game's web build serves for its relay client (MP-5a). */
export interface WebNetBridge {
  /** The store's `bridge.global.js` ({@link MULTIPLAYER_BRIDGE_PIN}`.file` in its component folder). */
  bridge: string;
  /** The ESM shim's text (`MP_BRIDGE_SHIM` in `src/main/mp-bridge-shim.ts`). */
  shim: string;
  /** The pin the bridge is held to; absent: {@link MULTIPLAYER_BRIDGE_PIN} (tests hand their own). */
  pin?: WebBridgePin;
}

/** A bridge's pin: its release, size and sha256. */
export interface WebBridgePin {
  version: string;
  bytes: number;
  sha256: string;
}

/** A web build's part of the receipt: the tools, the sizes against the budget, the served files. */
export interface WebReceipt {
  version: 1;
  wasmBindgen: string;
  binaryen: string | null;
  optimized: boolean;
  wasmBytes: number;
  gzipBytes: number;
  /** The game's own budget: past it an export warns. */
  gzipBudgetBytes: number;
  /** The hard ceiling: past it an export is refused. */
  gzipCeilingBytes: number;
  /** Measured against the game's budget for every build. */
  withinBudget: boolean;
  /** An optimized build past its game's budget; null for one within it and for every Live build. */
  warning: ExportWarningCode | null;
  /** Served file name → sha256. */
  files: Record<string, string>;
  /** A `[net]` build's {@link WEB_NET_FILES}: their bytes together (absent for every other build). */
  mpBridgeBytes?: number;
  /** The same files' `gzip -9` sizes added up. */
  mpBridgeGzip?: number;
}

export type WebPackageResult =
  | { ok: true; receipt: WebReceipt }
  | { ok: false; refusal: RustWebRefusal; detail: string; receipt: WebReceipt | null };

const refused = (refusal: RustWebRefusal, detail: string, receipt: WebReceipt | null = null): WebPackageResult => ({
  ok: false,
  refusal,
  detail,
  receipt,
});

/** The warnings a web export carries from its receipt: the code past its game's budget, or none. */
export function webExportWarnings(receipt: WebReceipt | null | undefined): ExportWarning[] {
  if (!receipt?.warning) return [];
  return [
    { code: ExportWarningCode.WasmOverTarget, gzipBytes: receipt.gzipBytes, budgetBytes: receipt.gzipBudgetBytes },
  ];
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

/**
 * The import map and classic script a `[net]` build's page carries in its head: the bridge loads
 * first and sets its global, then the map resolves the game's bare import to the shim, both inside
 * the page's own folder.
 */
const NET_BRIDGE_TAGS = [
  "",
  `    <script type="importmap">${JSON.stringify({ imports: { [MP_BRIDGE_SPECIFIER]: `./${WEB_NET_FILES.shim}` } })}</script>`,
  `    <script src="${WEB_NET_FILES.bridge}"></script>`,
].join("\n");

/**
 * The shell with the game's title in place of every placeholder, HTML-escaped, and its loading
 * screen styled by `loading` (`[render.loading]`; a key left out takes the default, the title the
 * game's). A `net` page also carries the bridge's import map and script tag (MP-5a); any other
 * page drops their placeholder. Throws `loading-style: <key>` for a value the manifest's check
 * would have refused, so nothing of it reaches the page.
 */
export function webShellPage(shell: string, title: string, loading: LoadingStyle = {}, net = false): string {
  const problem = loadingStyleProblem(loading);
  if (problem !== null) throw new Error(`loading-style: ${problem}`);
  const logo = loading.logo
    ? `<img id="loading-logo" alt="" src="${LOGO_FOLDER}${loading.logo.split("/").map(encodeURIComponent).join("/")}" />`
    : "";
  return shell
    .replaceAll(TITLE_PLACEHOLDER, escapeHtml(title))
    .replaceAll(LoadingPlaceholder.Title, escapeHtml(loading.title ?? title))
    .replaceAll(LoadingPlaceholder.Background, loading.background ?? LOADING_DEFAULTS.background)
    .replaceAll(LoadingPlaceholder.Accent, loading.accent ?? LOADING_DEFAULTS.accent)
    .replaceAll(LoadingPlaceholder.Text, loading.text ?? LOADING_DEFAULTS.text)
    .replaceAll(LoadingPlaceholder.Logo, logo)
    .replaceAll(NET_PLACEHOLDER, net ? NET_BRIDGE_TAGS : "");
}

/** `wasm-bindgen --target web` of `wasm` into `out` as `game.js` + `game_bg.wasm`. */
export function bindgenCommand(tool: string, wasm: string, out: string): string {
  const args = ["--target", "web", "--no-typescript", "--out-dir", shellQuote(out), "--out-name", OUT_NAME];
  return [shellQuote(tool), ...args, shellQuote(wasm)].join(" ");
}

/** `wasm-opt -Oz` of the bound module into its sibling, and its symbol map into `symbolMap` when one is named. */
export function wasmOptCommand(tool: string, out: string, symbolMap?: string): string {
  const from = shellQuote(path.join(out, WEB_FILES.wasm));
  const to = shellQuote(path.join(out, WEB_FILES.optimizing));
  // After -Oz on the line: binaryen runs passes in order, so the map names the optimized module's indices.
  const map = symbolMap === undefined ? [] : [shellQuote(`--symbolmap=${symbolMap}`)];
  return [shellQuote(tool), "-Oz", ...WASM_OPT_FEATURES, from, "-o", to, ...map].join(" ");
}

function firstLines(result: WebRunResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split("\n").filter((line) => line.trim() !== "");
  return lines.slice(0, DETAIL_LINES).join("\n");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A fresh, real output folder: false when `out` is a link or something other than a folder. */
async function freshOutput(out: string): Promise<boolean> {
  const found = await lstat(out).catch(() => null);
  if (found && (found.isSymbolicLink() || !found.isDirectory())) return false;
  if (found) await rm(out, { recursive: true });
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out);
  return true;
}

/** Every entry the tools left is a regular file, and the module and its glue are there. */
async function outputRefusal(out: string): Promise<string | null> {
  const entries = await readdir(out, { withFileTypes: true });
  const odd = entries.find((entry) => !entry.isFile());
  if (odd) return MESSAGE.outputEntry(odd.name);
  const names = new Set(entries.map((entry) => entry.name));
  const missing = [WEB_FILES.module, WEB_FILES.wasm].find((name) => !names.has(name));
  return missing ? MESSAGE.outputMissing(missing) : null;
}

/** wasm-opt over the bound module, renamed into place once whole; the refusal or null. */
async function optimize(input: WebPackageInput, tool: string): Promise<WebPackageResult | null> {
  // An earlier build's map never stands in for this one's.
  if (input.symbolMap !== undefined) {
    await rm(input.symbolMap, { recursive: true, force: true });
    await mkdir(path.dirname(input.symbolMap), { recursive: true });
  }
  const run = await input.run(wasmOptCommand(tool, input.out, input.symbolMap), RustWebStep.WasmOpt);
  if (run.code !== 0) {
    return refused(
      RustWebRefusal.WasmOptFailed,
      `${MESSAGE.failed(RustWebStep.WasmOpt, run.code)}\n${firstLines(run)}`,
    );
  }
  const optimized = path.join(input.out, WEB_FILES.optimizing);
  const made = await lstat(optimized).catch(() => null);
  if (!made?.isFile()) return refused(RustWebRefusal.OutputRefused, MESSAGE.outputMissing(WEB_FILES.optimizing));
  await rename(optimized, path.join(input.out, WEB_FILES.wasm));
  return null;
}

/** The receipt of a packaged folder: sizes against the budget and every served file's digest. */
async function receiptOf(input: WebPackageInput, optimized: boolean): Promise<WebReceipt> {
  const wasm = await readRegularFile(path.join(input.out, WEB_FILES.wasm), WASM_MAX_BYTES);
  const gzipBytes = gzipSync(wasm, { level: 9 }).length;
  const budgetBytes = (input.budgetMb ?? WEB_WASM_BUDGET_DEFAULT_MB) * WEB_BUDGET_MB_BYTES;
  const withinBudget = gzipBytes <= budgetBytes;
  const files: Record<string, string> = { [WEB_FILES.wasm]: sha256(wasm) };
  for (const name of [WEB_FILES.module, WEB_FILES.page]) {
    files[name] = sha256(await readRegularFile(path.join(input.out, name), TEXT_MAX_BYTES));
  }
  const net = input.net ? await netReceipt(input.out, files) : {};
  return {
    version: 1,
    wasmBindgen: WASM_BINDGEN_VERSION,
    binaryen: optimized ? BINARYEN_VERSION : null,
    optimized,
    wasmBytes: wasm.length,
    gzipBytes,
    gzipBudgetBytes: budgetBytes,
    gzipCeilingBytes: WEB_WASM_CEILING_BYTES,
    withinBudget,
    // The budget is a release promise: a Live (cargo dev, no wasm-opt) module is several times bigger.
    warning: optimized && !withinBudget ? ExportWarningCode.WasmOverTarget : null,
    files,
    ...net,
  };
}

/** A `[net]` build's bridge files in the receipt: each one's sha256 into `files`, and their sizes. */
async function netReceipt(
  out: string,
  files: Record<string, string>,
): Promise<Pick<WebReceipt, "mpBridgeBytes" | "mpBridgeGzip">> {
  let mpBridgeBytes = 0;
  let mpBridgeGzip = 0;
  for (const name of Object.values(WEB_NET_FILES)) {
    const bytes = await readRegularFile(path.join(out, name), TEXT_MAX_BYTES);
    files[name] = sha256(bytes);
    mpBridgeBytes += bytes.length;
    mpBridgeGzip += gzipSync(bytes, { level: 9 }).length;
  }
  return { mpBridgeBytes, mpBridgeGzip };
}

/** The pinned bridge's bytes, or the refusal: never a link, exactly the pinned size and sha256. */
async function pinnedBridge(net: WebNetBridge): Promise<Uint8Array | WebPackageResult> {
  const pin = net.pin ?? MULTIPLAYER_BRIDGE_PIN;
  const bytes = await readRegularFile(net.bridge, pin.bytes).catch(() => null);
  if (!bytes) return refused(RustWebRefusal.MpBridgeRefused, MESSAGE.bridgeUnreadable(net.bridge, pin.bytes));
  const pinned = bytes.length === pin.bytes && sha256(bytes) === pin.sha256;
  return pinned ? bytes : refused(RustWebRefusal.MpBridgeRefused, MESSAGE.bridgeMismatch(bytes.length, pin));
}

/** Writes a `[net]` build's {@link WEB_NET_FILES} into the fresh output folder. */
async function writeNetFiles(out: string, bridge: Uint8Array, shim: string): Promise<void> {
  await mkdir(path.join(out, path.posix.dirname(WEB_NET_FILES.bridge)));
  await atomicWriteFile(path.join(out, WEB_NET_FILES.bridge), bridge);
  await atomicWriteText(path.join(out, WEB_NET_FILES.shim), shim);
}

/** The pinned wasm-bindgen, a fresh output folder and the bound module in it; the refusal or null. */
async function bindModule(input: WebPackageInput): Promise<WebPackageResult | null> {
  const version = await input.run(`${shellQuote(input.tools.wasmBindgen)} --version`, RustWebStep.BindgenVersion);
  const found = BINDGEN_VERSION_LINE.exec(version.stdout)?.[1] ?? "";
  if (version.code !== 0 || found !== WASM_BINDGEN_VERSION) {
    return refused(RustWebRefusal.BindgenVersion, MESSAGE.bindgenVersion(found));
  }
  if (!(await freshOutput(input.out))) return refused(RustWebRefusal.OutputRefused, MESSAGE.outputLinked);
  const bound = await input.run(bindgenCommand(input.tools.wasmBindgen, input.wasm, input.out), RustWebStep.Bindgen);
  if (bound.code === 0) return null;
  return refused(
    RustWebRefusal.BindgenFailed,
    `${MESSAGE.failed(RustWebStep.Bindgen, bound.code)}\n${firstLines(bound)}`,
  );
}

/**
 * Package the module cargo built into the served folder `input.out`: wasm-bindgen, wasm-opt, the
 * shell as `index.html`, a `[net]` build's bridge files, `size.json` and the receipt; or the typed
 * refusal. Throws only on an I/O failure of the host's own folders.
 */
export async function packageWeb(input: WebPackageInput): Promise<WebPackageResult> {
  // A [net] build's bridge is checked before anything runs or is written.
  const bridge = input.net ? await pinnedBridge(input.net) : null;
  if (bridge && !(bridge instanceof Uint8Array)) return bridge;
  const bindRefusal = await bindModule(input);
  if (bindRefusal) return bindRefusal;
  const wasmOpt = input.optimize ? input.tools.wasmOpt : null;
  const optimizeRefusal = wasmOpt ? await optimize(input, wasmOpt) : null;
  if (optimizeRefusal) return optimizeRefusal;
  const odd = await outputRefusal(input.out);
  if (odd) return refused(RustWebRefusal.OutputRefused, odd);
  if (bridge && input.net) await writeNetFiles(input.out, bridge, input.net.shim);
  const page = webShellPage(input.shell, input.title, input.loading, input.net !== undefined);
  await atomicWriteText(path.join(input.out, WEB_FILES.page), page);
  const receipt = await receiptOf(input, wasmOpt !== null);
  const size = {
    optimized: receipt.optimized,
    wasmBytes: receipt.wasmBytes,
    gzipBytes: receipt.gzipBytes,
    gzipBudgetBytes: receipt.gzipBudgetBytes,
    gzipCeilingBytes: receipt.gzipCeilingBytes,
    withinBudget: receipt.withinBudget,
    warning: receipt.warning,
  };
  await atomicWriteText(path.join(input.out, WEB_FILES.size), `${JSON.stringify(size)}\n`);
  // Only the ceiling refuses, and only an export: a Live module is served whatever its size.
  if (receipt.optimized && receipt.gzipBytes > receipt.gzipCeilingBytes) {
    const detail = MESSAGE.overCeiling(receipt.gzipBytes, input.budgetMb ?? WEB_WASM_BUDGET_DEFAULT_MB);
    return refused(RustWebRefusal.WasmOverBudget, detail, receipt);
  }
  return { ok: true, receipt };
}

/** The regular files under `dir` by `/`-separated path, never through a link (a linked file or folder is left out). */
async function regularFiles(dir: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await regularFiles(dir, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/** One file's map entry, its family and its KTX2 side; null when it breaks the asset-path rule, the per-file cap or is not a regular file. */
async function assetEntry(assets: string, rel: string, maxFileBytes: number): Promise<Staged | null> {
  if (!isSafeAssetPath(rel)) return null;
  const bytes = await readRegularFile(path.join(assets, ...rel.split("/")), maxFileBytes).catch(() => null);
  if (!bytes) return null;
  const header = rel.endsWith(KTX2_SUFFIX) ? readKtx2Header(bytes.subarray(0, KTX2_HEAD_BYTES)) : null;
  const side = header ? Math.min(header.width, header.height) : null;
  const entry = { path: rel, bytes: bytes.length, fnv1a64: fnv1a64Hex(bytes) };
  return {
    entry,
    side,
    family: familyFile(rel),
    ranges: header ? ktx2Ranges(bytes) : null,
    pack: isPackWorld(rel, bytes),
  };
}

/**
 * A KTX2's pieces for a fetch by ranges: the head (header, level index and descriptors, up to its
 * first level's data), then each level smallest first; null when its level index does not read.
 */
function ktx2Ranges(bytes: Uint8Array): WebAssetRange[] | null {
  const levels = ktx2LevelFacts(bytes, bytes.length);
  if (!levels) return null;
  const pieces = levels.filter((level) => level.bytes > 0);
  const headBytes = Math.min(...pieces.map((level) => level.offset));
  if (!(headBytes > 0) || overlapping(pieces)) return null;
  const range = (offset: number, length: number): WebAssetRange => ({
    offset,
    bytes: length,
    fnv1a64: fnv1a64Hex(bytes.subarray(offset, offset + length)),
  });
  return [range(0, headBytes), ...pieces.map((level) => range(level.offset, level.bytes))];
}

/** Whether any two of `ranges` share a byte (the module refuses such an entry `asset-range-invalid`). */
function overlapping(ranges: ReadonlyArray<{ offset: number; bytes: number }>): boolean {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  return sorted.some((range, i) => i > 0 && sorted[i - 1].offset + sorted[i - 1].bytes > range.offset);
}

/** Whether `rel` is a cell pack's `world.json` (its `format` is genex-stream's), so its folder is a pack. */
function isPackWorld(rel: string, bytes: Uint8Array): boolean {
  if (path.posix.basename(rel) !== CELL_PACK_WORLD_FILE) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, PACK_WORLD_HEAD_BYTES));
  return /^\{\s*"format"\s*:\s*"([^"]*)"/.exec(head)?.[1] === CELL_PACK_FORMAT;
}

/** A file the map lists: its entry, the side of its KTX2 header (null when not a readable KTX2) and, for a family file, its stem and family. */
interface Staged {
  entry: WebAssetEntry;
  side: number | null;
  family: FamilyFile | null;
  /** A readable KTX2's pieces, used only when the file is streamed. */
  ranges: WebAssetRange[] | null;
  /** Whether it is a cell pack's `world.json`. */
  pack: boolean;
}

/** A family file's texture stem and family. */
interface FamilyFile {
  stem: string;
  family: TextureCompression;
}

/** `rel`'s stem and family by the runtime's `family_file` rule (`textures/rock.bc.ktx2` → `textures/rock`, bc); null for any other file. */
function familyFile(rel: string): FamilyFile | null {
  if (!rel.endsWith(KTX2_SUFFIX)) return null;
  const stem = rel.slice(0, -KTX2_SUFFIX.length);
  const dot = stem.lastIndexOf(".");
  const tag = stem.slice(dot + 1);
  if (dot <= stem.lastIndexOf("/") || !FAMILY_TAGS.has(tag)) return null;
  return { stem: stem.slice(0, dot), family: tag as TextureCompression };
}

/** `rel`'s stem when it is an image a game names as a texture (never a model, a family file or an environment map). */
function imageStem(rel: string): string | null {
  const format = assetFormat(rel);
  if (format?.kind !== "image" || format.environment === true || familyFile(rel) !== null) return null;
  const dot = rel.lastIndexOf(".");
  return dot > rel.lastIndexOf("/") ? rel.slice(0, dot) : null;
}

/** One texture's files in the map: its family files and the images of its stem. */
interface TextureFiles {
  families: Array<Staged & { family: FamilyFile }>;
  images: Staged[];
}

const isFamilyFile = (file: Staged): file is Staged & { family: FamilyFile } => file.family !== null;

/** The textures with family files, by stem. */
function texturesOf(staged: readonly Staged[]): Map<string, TextureFiles> {
  const textures = new Map<string, TextureFiles>();
  for (const file of staged.filter(isFamilyFile)) {
    const found = textures.get(file.family.stem) ?? { families: [], images: [] };
    found.families.push(file);
    textures.set(file.family.stem, found);
  }
  for (const file of staged) {
    const stem = imageStem(file.entry.path);
    if (stem !== null) textures.get(stem)?.images.push(file);
  }
  return textures;
}

/**
 * Whether the runtime never loads `texture`'s image while the map holds its family files, so the
 * module may leave the image out: it is the texture's one image, its family files cover every
 * compressed family any texture ships (`shipped`; the renderer stores one family for all), none is
 * RGBA8 (the runtime reads the image, never that file) and each is a KTX2 at least
 * {@link FAMILY_MIN_SIDE_PX} a side.
 */
function imageReplaceable(texture: TextureFiles, shipped: ReadonlySet<TextureCompression>): boolean {
  if (texture.images.length !== 1) return false;
  const families = new Set(texture.families.map((file) => file.family.family));
  if (families.has(TextureCompression.Rgba8)) return false;
  const sized = texture.families.every((file) => file.side !== null && file.side >= FAMILY_MIN_SIDE_PX);
  return sized && [...shipped].every((family) => families.has(family));
}

/**
 * Tags each texture's files for the module's per-adapter plan (C-16): every family file with its
 * `family` and the texture it is `of` (its one image's path, else the stem), and the image
 * `source` only when {@link imageReplaceable}; an image the runtime may still load stays a plain
 * entry, always fetched.
 */
function tagTextures(staged: readonly Staged[]): void {
  const textures = texturesOf(staged);
  const compressed = staged.filter(isFamilyFile).map((file) => file.family.family);
  const shipped = new Set(compressed.filter((family) => family !== TextureCompression.Rgba8));
  for (const [stem, texture] of textures) {
    const image = texture.images.length === 1 ? texture.images[0] : undefined;
    const of = image ? image.entry.path : stem;
    for (const file of texture.families) Object.assign(file.entry, { family: file.family.family, of });
    if (image && imageReplaceable(texture, shipped)) Object.assign(image.entry, { family: WebAssetFamily.Source, of });
  }
}

/**
 * Each shipped file of the asset index's named groups (C-30), with its group's name: every file of
 * every asset a group lists (a texture's family files too). A file in several groups takes the
 * first by name (the index sorts them). An index that is missing, a link, too big or not the
 * package step's shape names none.
 */
async function namedGroupFiles(assets: string): Promise<Map<string, string>> {
  const named = new Map<string, string>();
  const bytes = await readRegularFile(path.join(assets, ASSET_INDEX_FILE), ASSET_INDEX_MAX_BYTES).catch(() => null);
  const index = bytes ? parsedIndex(bytes) : null;
  if (!index) return named;
  const filesOf = new Map(index.assets.map((asset) => [asset.path, asset.files.map((file) => file.path)]));
  for (const group of index.groups) {
    for (const asset of group.assets) {
      for (const file of filesOf.get(asset) ?? []) if (!named.has(file)) named.set(file, group.name);
    }
  }
  return named;
}

/** The part of the asset index the map reads: each asset's shipped files, and the named groups. */
interface IndexGroups {
  assets: Array<{ path: string; files: Array<{ path: string }> }>;
  groups: Array<{ name: string; assets: string[] }>;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The index's assets and groups, or null when it is not the package step's shape. */
function parsedIndex(bytes: Uint8Array): IndexGroups | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.assets) || !Array.isArray(value.groups)) return null;
  const assets = value.assets.filter(isRecord).map((asset) => ({
    path: String(asset.path),
    files: (Array.isArray(asset.files) ? asset.files : [])
      .filter(isRecord)
      .map((file) => ({ path: String(file.path) })),
  }));
  const groups = value.groups
    .filter((group): group is Record<string, unknown> => isRecord(group) && isString(group.name) && group.name !== "")
    .map((group) => ({
      name: String(group.name),
      assets: (Array.isArray(group.assets) ? group.assets : []).filter(isString),
    }));
  return { assets, groups };
}

/** Whether `rel` is a cell body or terrain tile of a pack (a folder holding a pack's `world.json`). */
function streamedPackFile(rel: string, packs: ReadonlySet<string>): boolean {
  const parts = rel.split("/");
  const file = parts.at(-1) ?? "";
  const folder = parts.at(-2);
  const pack = parts.slice(0, -2).join("/");
  if (!packs.has(pack)) return false;
  const body = folder === CELL_BODIES_DIR && file.endsWith(CELL_BODY_SUFFIX);
  const tile = folder === TERRAIN_TILES_DIR && file.endsWith(TERRAIN_TILE_SUFFIX);
  return body || tile;
}

/** Whether `rel` is a pack's index the simulation reads at reset: its `world.json` or `terrain/terrain.json`. */
function packIndexFile(rel: string, packs: ReadonlySet<string>): boolean {
  const dir = path.posix.dirname(rel);
  const own = dir === "." ? "" : dir;
  if (path.posix.basename(rel) === CELL_PACK_WORLD_FILE) return packs.has(own);
  const terrain = path.posix.basename(own) === TERRAIN_TILES_DIR && path.posix.basename(rel) === TERRAIN_TILES_FILE;
  const pack = path.posix.dirname(own);
  return terrain && packs.has(pack === "." ? "" : pack);
}

/** Whether `entry` is fetched while playing rather than before the first frame. */
const isStreamed = (entry: WebAssetEntry) =>
  entry.group === WebAssetGroup.Stream || entry.group === WebAssetGroup.Named;

/**
 * Puts each file in its fetch group (STR-14b): a cell pack's `world.json` and terrain index in
 * `sim` (a reset reads them); each named group's files in `named` with the group's name; a pack's
 * cell bodies and terrain tiles in `stream`. A streamed or named KTX2 is fetched by ranges (its
 * head, then its levels smallest first); every other file is fetched whole. A file in no group is
 * left as the v1 map wrote it (`sim`).
 */
function groupFiles(staged: readonly Staged[], named: ReadonlyMap<string, string>): void {
  const packs = new Set(
    staged
      .filter((file) => file.pack)
      .map((file) => {
        const dir = path.posix.dirname(file.entry.path);
        return dir === "." ? "" : dir;
      }),
  );
  for (const file of staged) {
    const rel = file.entry.path;
    const name = named.get(rel);
    if (packIndexFile(rel, packs)) Object.assign(file.entry, { group: WebAssetGroup.Sim });
    else if (name !== undefined) Object.assign(file.entry, { group: WebAssetGroup.Named, name });
    else if (streamedPackFile(rel, packs)) Object.assign(file.entry, { group: WebAssetGroup.Stream });
    if (isStreamed(file.entry) && file.ranges) file.entry.ranges = file.ranges;
  }
}

/**
 * The asset map of a staged `assets/` folder: each regular file (never a link, never through a
 * linked folder) whose path passes the asset-path rule and fits the per-file cap, sorted by path,
 * until the file count or total byte cap is reached. A texture's files are tagged for the
 * adapter's pick ({@link tagTextures}) and each file is put in its fetch group ({@link groupFiles});
 * a game with neither family files, cell packs nor named groups gets the v1 map's entries. A
 * missing folder is an empty map.
 */
export async function webAssetMap(assets: string, limits: WebAssetLimits = WEB_ASSET_LIMITS): Promise<WebAssetMap> {
  const staged: Staged[] = [];
  let total = 0;
  for (const rel of (await regularFiles(assets)).sort()) {
    if (staged.length >= limits.maxFiles) break;
    const file = await assetEntry(assets, rel, limits.maxFileBytes);
    if (!file || total + file.entry.bytes > limits.maxTotalBytes) continue;
    total += file.entry.bytes;
    staged.push(file);
  }
  tagTextures(staged);
  groupFiles(staged, await namedGroupFiles(assets));
  return { version: WEB_ASSET_MAP_VERSION, files: staged.map((file) => file.entry) };
}

/** What a map fetches when (STR-14b): the boot and sim bytes before the first frame, and the largest single fetch while playing. */
export interface WebAssetMapLoad {
  preloadBytes: number;
  streamedBytes: number;
  largestFetchBytes: number;
  /** Whether both fit {@link WEB_STREAM_LIMITS}. */
  withinLimits: boolean;
}

/**
 * {@link WebAssetMapLoad} of `map`, for the adapter that fetches the most: of a texture's per-family
 * files (the module plans one) the largest counts.
 */
export function webAssetMapLoad(map: WebAssetMap): WebAssetMapLoad {
  const preloadOf = new Map<string, number>();
  let streamedBytes = 0;
  let largestFetchBytes = 0;
  for (const entry of map.files) {
    if (!isStreamed(entry)) {
      const key = entry.of === undefined ? `file:${entry.path}` : `texture:${entry.of}`;
      preloadOf.set(key, Math.max(preloadOf.get(key) ?? 0, entry.bytes));
      continue;
    }
    streamedBytes += entry.bytes;
    const pieces = entry.ranges?.map((range) => range.bytes) ?? [entry.bytes];
    largestFetchBytes = Math.max(largestFetchBytes, ...pieces);
  }
  const preloadBytes = [...preloadOf.values()].reduce((sum, bytes) => sum + bytes, 0);
  const fits = preloadBytes <= WEB_STREAM_LIMITS.preloadBytes;
  return {
    preloadBytes,
    streamedBytes,
    largestFetchBytes,
    withinLimits: fits && largestFetchBytes <= WEB_STREAM_LIMITS.fetchBytes,
  };
}

/** Writes `out`'s {@link WEB_FILES.assetMap} for the assets staged in `out/assets`. */
export async function writeWebAssetMap(out: string): Promise<void> {
  const map = await webAssetMap(path.join(out, WEB_FILES.assets));
  await atomicWriteText(path.join(out, WEB_FILES.assetMap), `${JSON.stringify(map)}\n`);
}
