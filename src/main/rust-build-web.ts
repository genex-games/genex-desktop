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
 * 3. `wasm-opt -Oz` (binaryen {@link BINARYEN_VERSION}) for an optimized build;
 * 4. a check that the folder holds only regular files the tools wrote (a link they left is refused);
 * 5. `index.html` from the shell with the game's title HTML-escaped, and `size.json`;
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
import { isSafeAssetPath } from "../substrate/asset-import/safe-asset.ts";
import { atomicWriteText, readRegularFile } from "../substrate/fsx.ts";
import { fnv1a64Hex } from "../substrate/native-game-port.ts";
import { shellQuote } from "../substrate/shell-quote.ts";
import type { RustTargetBuilder } from "./rust-build.ts";

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

/** The asset map's format (genex-platform-web's `ASSET_MAP_VERSION`). */
export const WEB_ASSET_MAP_VERSION = 1;
/** The module's caps (genex-platform-web's `assets`): one file, all files, and how many. */
export const WEB_ASSET_LIMITS = {
  /** The desktop's own cap on one asset (genex-assets' `MAX_ASSET_BYTES`). */
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFiles: 4096,
} as const;
/** The caps {@link webAssetMap} applies. */
export type WebAssetLimits = { [K in keyof typeof WEB_ASSET_LIMITS]: number };

/** One staged file the page may fetch: its `/`-separated path under `assets/`, length and FNV-1a 64. */
export interface WebAssetEntry {
  path: string;
  bytes: number;
  fnv1a64: string;
}

/** `assets.json`: every staged file the page fetches before the game's first frame. */
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
  /** Run wasm-opt (an export or any release build). */
  optimize: boolean;
  /** The game's own budget in MB of gzip (`[web] wasm_budget_mb`); absent: {@link WEB_WASM_BUDGET_DEFAULT_MB}. */
  budgetMb?: number;
  tools: WebTools;
  run: WebRun;
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
  return [{ code: receipt.warning, gzipBytes: receipt.gzipBytes, budgetBytes: receipt.gzipBudgetBytes }];
}

/** The shell with the game's title in place of every placeholder, HTML-escaped. */
export function webShellPage(shell: string, title: string): string {
  const escaped = title.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
  return shell.replaceAll(TITLE_PLACEHOLDER, escaped);
}

/** `wasm-bindgen --target web` of `wasm` into `out` as `game.js` + `game_bg.wasm`. */
export function bindgenCommand(tool: string, wasm: string, out: string): string {
  const args = ["--target", "web", "--no-typescript", "--out-dir", shellQuote(out), "--out-name", OUT_NAME];
  return [shellQuote(tool), ...args, shellQuote(wasm)].join(" ");
}

/** `wasm-opt -Oz` of the bound module into its sibling. */
export function wasmOptCommand(tool: string, out: string): string {
  const from = shellQuote(path.join(out, WEB_FILES.wasm));
  const to = shellQuote(path.join(out, WEB_FILES.optimizing));
  return [shellQuote(tool), "-Oz", ...WASM_OPT_FEATURES, from, "-o", to].join(" ");
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
  const run = await input.run(wasmOptCommand(tool, input.out), RustWebStep.WasmOpt);
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
  };
}

/**
 * Package the module cargo built into the served folder `input.out`: wasm-bindgen, wasm-opt, the
 * shell as `index.html`, `size.json` and the receipt; or the typed refusal. Throws only on an I/O
 * failure of the host's own folders.
 */
export async function packageWeb(input: WebPackageInput): Promise<WebPackageResult> {
  const version = await input.run(`${shellQuote(input.tools.wasmBindgen)} --version`, RustWebStep.BindgenVersion);
  const found = BINDGEN_VERSION_LINE.exec(version.stdout)?.[1] ?? "";
  if (version.code !== 0 || found !== WASM_BINDGEN_VERSION) {
    return refused(RustWebRefusal.BindgenVersion, MESSAGE.bindgenVersion(found));
  }
  if (!(await freshOutput(input.out))) return refused(RustWebRefusal.OutputRefused, MESSAGE.outputLinked);
  const bound = await input.run(bindgenCommand(input.tools.wasmBindgen, input.wasm, input.out), RustWebStep.Bindgen);
  if (bound.code !== 0) {
    return refused(
      RustWebRefusal.BindgenFailed,
      `${MESSAGE.failed(RustWebStep.Bindgen, bound.code)}\n${firstLines(bound)}`,
    );
  }
  const wasmOpt = input.optimize ? input.tools.wasmOpt : null;
  const optimizeRefusal = wasmOpt ? await optimize(input, wasmOpt) : null;
  if (optimizeRefusal) return optimizeRefusal;
  const odd = await outputRefusal(input.out);
  if (odd) return refused(RustWebRefusal.OutputRefused, odd);
  await atomicWriteText(path.join(input.out, WEB_FILES.page), webShellPage(input.shell, input.title));
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

/** One file's map entry, or null when it breaks the asset-path rule, the per-file cap or is not a regular file. */
async function assetEntry(assets: string, rel: string, maxFileBytes: number): Promise<WebAssetEntry | null> {
  if (!isSafeAssetPath(rel)) return null;
  const bytes = await readRegularFile(path.join(assets, ...rel.split("/")), maxFileBytes).catch(() => null);
  return bytes ? { path: rel, bytes: bytes.length, fnv1a64: fnv1a64Hex(bytes) } : null;
}

/**
 * The asset map of a staged `assets/` folder: each regular file (never a link, never through a
 * linked folder) whose path passes the asset-path rule and fits the per-file cap, sorted by path,
 * until the file count or total byte cap is reached. A missing folder is an empty map.
 */
export async function webAssetMap(assets: string, limits: WebAssetLimits = WEB_ASSET_LIMITS): Promise<WebAssetMap> {
  const files: WebAssetEntry[] = [];
  let total = 0;
  for (const rel of (await regularFiles(assets)).sort()) {
    if (files.length >= limits.maxFiles) break;
    const entry = await assetEntry(assets, rel, limits.maxFileBytes);
    if (!entry || total + entry.bytes > limits.maxTotalBytes) continue;
    total += entry.bytes;
    files.push(entry);
  }
  return { version: WEB_ASSET_MAP_VERSION, files };
}

/** Writes `out`'s {@link WEB_FILES.assetMap} for the assets staged in `out/assets`. */
export async function writeWebAssetMap(out: string): Promise<void> {
  const map = await webAssetMap(path.join(out, WEB_FILES.assets));
  await atomicWriteText(path.join(out, WEB_FILES.assetMap), `${JSON.stringify(map)}\n`);
}
