/**
 * Where a Rust · wgpu lock's store outputs live, and how cargo is pointed at them. A Rust lock's
 * folder (`locks/<digest12>/`, as raylib's) holds:
 *
 * - `sysroot/`: one sysroot assembled from the lock's `rust` parts and its standard libraries
 *   (`rust-install.ts`), and `rust-base.json`, the record that it was probed;
 * - `cargo-home/config.toml`: the vendored tree as the only crate source, offline;
 * - `targets/<destination>/`: one prewarmed dependency build per destination (`target/`, the
 *   folder every build and worktree clones), its `rust-prewarm.json` and the warm project's
 *   `Cargo.lock`, swapped in one destination at a time so a lazy one never disturbs another;
 * - `tools/`: host tools the prewarm builds from the vendored tree (the naga validator);
 * - `rust-sizes.json`: the size receipt.
 *
 * Everything here is under the store, which every sandboxed process is denied writing
 * (`studioBaseDenyWrites`). Artifact paths come from Cargo's JSON messages, never from the target
 * folder's layout (Cargo 1.100 changes it).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import {
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import { isJsonObject } from "../fsx.ts";
import { isInside } from "../paths.ts";
import type { TreeDigest } from "./archive.ts";
import { locateComponents, lockFolder, RUST_COMPONENT_LAYOUT, requiredFor } from "./locate.ts";
import { isToolchainLock } from "./lock.ts";
import { RUST_PARTS } from "./manifest.ts";

const MESSAGE = {
  Outside: (file: string, root: string) => `Cargo reported ${file}, outside the target folder ${root}.`,
} as const;

/** The Rust target triple each destination builds for. Wire values: rustc spells them so. */
export const RUST_TRIPLE = {
  [BuildTarget.Mac]: "aarch64-apple-darwin",
  [BuildTarget.Web]: "wasm32-unknown-unknown",
  [BuildTarget.Windows]: "x86_64-pc-windows-gnullvm",
  [BuildTarget.Linux]: "x86_64-unknown-linux-gnu",
  [BuildTarget.Ios]: "aarch64-apple-ios",
  [BuildTarget.Android]: "aarch64-linux-android",
} as const satisfies Record<BuildTarget, string>;

/** The iOS Simulator's triple on Apple silicon: an iPhone game's second standard library (the Simulator export's build). */
export const RUST_IOS_SIMULATOR_TRIPLE = "aarch64-apple-ios-sim";

/** The triple of the sysroot each store host runs (its standard library comes with the `rust` component). */
export const RUST_HOST_TRIPLE = {
  [ToolchainHost.MacArm64]: "aarch64-apple-darwin",
  [ToolchainHost.LinuxX64]: "x86_64-unknown-linux-gnu",
  [ToolchainHost.WindowsX64]: "x86_64-pc-windows-msvc",
} as const satisfies Record<ToolchainHost, string>;

/** The folders of a Rust lock folder. */
export const RustStoreFolder = {
  Sysroot: "sysroot",
  CargoHome: "cargo-home",
  Targets: "targets",
  Tools: "tools",
} as const;
export type RustStoreFolder = (typeof RustStoreFolder)[keyof typeof RustStoreFolder];

/** The record that the sysroot and CARGO_HOME were assembled and probed. */
export const RUST_BASE_FILE = "rust-base.json";
/** In a destination's folder: the record of its prewarmed dependency build. */
export const RUST_PREWARM_FILE = "rust-prewarm.json";
/** The size receipt, in the lock folder. */
export const RUST_SIZES_FILE = "rust-sizes.json";
/** In a destination's folder: the target folder builds clone. */
export const RUST_TARGET_DIR = "target";
/**
 * The dev profile's settings over cargo's defaults, as `--config` values, for every Rust build that
 * is not an export and for every prewarm (K6 rebuild speed, OPT run speed): the engine and every
 * other dependency compile once, in the prewarm, at opt-level 3, so Live, judging and playtests run
 * wgpu, Rapier, glam and skinning near release speed; the game crate compiles at opt-level 1, which
 * makes its own loops and the generic engine code it instantiates fast while its rebuild stays
 * incremental and about as quick as unoptimized. Neither level changes a float result: rustc never
 * contracts or reorders float operations at any opt-level, so the determinism rows hold. A prewarm
 * built without these is another dependency build: a game's build cloning it would rebuild every
 * dependency, so a prewarm records them and one made with others is stale. Debug info is line
 * tables only (R-7), which backtraces and the symbolicator read.
 *
 * The dependencies run without debug assertions or overflow checks, as in an export (lane MK):
 * kept, they cost a Live build of a 10,000-ghoul horde more than half its CPU frame (objc2 checks the
 * signature of every Metal message, and wgpu, Rapier and the mixer check as they go), and the
 * engine's own debug assertions are a handful of index checks. The game crate keeps cargo's dev
 * defaults for both, so an agent's own arithmetic still traps in Live.
 */
export const RUST_DEV_PROFILE_SETTINGS: readonly string[] = Object.freeze([
  "profile.dev.opt-level=1",
  'profile.dev.package."*".opt-level=3',
  'profile.dev.debug="line-tables-only"',
  'profile.dev.package."*".debug-assertions=false',
  'profile.dev.package."*".overflow-checks=false',
]);
/** In a destination's folder: the warm project's lock, as it was resolved offline. */
export const RUST_WARM_LOCK_FILE = "Cargo.lock";
/** The host-made naga validator (`rust-prewarm.ts`), in the tools folder. */
export const NAGA_CHECK_TOOL = "genex-naga-check";
/** The host-made crash symbolicator (`rust-prewarm.ts`), in the tools folder. */
export const SYMBOLICATE_TOOL = "genex-symbolicate";
const RECORD_SCHEMA = 1;

/** `rust-base.json`. */
export interface RustBaseRecord {
  schema: typeof RECORD_SCHEMA;
  lock: string;
  /** The triples whose standard library the sysroot holds, the host's first. */
  triples: string[];
  /** The vendored tree the CARGO_HOME names, as it was re-checked. */
  vendor: TreeDigest;
  at: string;
}

/** One timed prewarm step. */
export interface RustPrewarmStepRecord {
  label: string;
  ms: number;
}

/** `rust-prewarm.json`: one destination's dependency build. */
export interface RustPrewarmRecord {
  schema: typeof RECORD_SCHEMA;
  lock: string;
  target: BuildTarget;
  triple: string;
  /** The compiler flags every build cloning this folder must pass too, or it rebuilds every dependency. */
  rustflags: string[];
  /** The cargo profile it was built with ({@link RUST_DEV_PROFILE_SETTINGS} when it was made); another is stale. */
  profile: string[];
  steps: RustPrewarmStepRecord[];
  /** Target-folder-relative artifacts and build-script out dirs, from Cargo's JSON messages. */
  outputs: string[];
  /** Dependency units built (the warm package's own excluded). */
  units: number;
  /** Bytes of the target folder. */
  bytes: number;
  at: string;
}

/** The sysroot of a Rust lock. */
export function rustSysroot(store: string, lock: ToolchainLock): string {
  return path.join(lockFolder(store, lock), RustStoreFolder.Sysroot);
}

/** The store's CARGO_HOME for a Rust lock: read by builds, written by the host only. */
export function rustCargoHome(store: string, lock: ToolchainLock): string {
  return path.join(lockFolder(store, lock), RustStoreFolder.CargoHome);
}

/** The host tools a Rust lock's prewarm built. */
export function rustToolsFolder(store: string, lock: ToolchainLock): string {
  return path.join(lockFolder(store, lock), RustStoreFolder.Tools);
}

/** A destination's prewarm folder. */
export function rustTargetFolder(store: string, lock: ToolchainLock, target: BuildTarget): string {
  return path.join(lockFolder(store, lock), RustStoreFolder.Targets, target);
}

/** A destination's prewarmed target folder, the one builds clone. */
export function rustPrewarmedTargetDir(store: string, lock: ToolchainLock, target: BuildTarget): string {
  return path.join(rustTargetFolder(store, lock, target), RUST_TARGET_DIR);
}

/** The CARGO_HOME `config.toml` naming the vendored tree as the only crate source, offline. */
export function rustCargoConfig(vendorDir: string): string {
  return [
    "# Written by Genex: crates.io is replaced by the vendored tree, and cargo never opens the network.",
    "[source.crates-io]",
    'replace-with = "genex-vendored"',
    "",
    "[source.genex-vendored]",
    `directory = ${JSON.stringify(vendorDir)}`,
    "",
    "[net]",
    "offline = true",
    "",
  ].join("\n");
}

// ---------- Cargo's JSON messages ----------

/** The Cargo message reasons the store reads. Wire values: cargo spells them so. */
export const CargoReason = {
  CompilerArtifact: "compiler-artifact",
  BuildScriptExecuted: "build-script-executed",
  CompilerMessage: "compiler-message",
  BuildFinished: "build-finished",
} as const;
export type CargoReason = (typeof CargoReason)[keyof typeof CargoReason];

/** One message of `cargo … --message-format=json`, as the store reads it. */
export type CargoMessage =
  | {
      reason: typeof CargoReason.CompilerArtifact;
      packageId: string;
      kinds: string[];
      filenames: string[];
      executable: string | null;
      fresh: boolean;
    }
  | { reason: typeof CargoReason.BuildScriptExecuted; packageId: string; outDir: string }
  | { reason: typeof CargoReason.CompilerMessage; packageId: string; rendered: string | null; level: string | null }
  | { reason: typeof CargoReason.BuildFinished; success: boolean };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** One parsed line as a message, or null when it is none the store reads. */
function messageOf(value: Record<string, unknown>): CargoMessage | null {
  const packageId = text(value.package_id);
  if (value.reason === CargoReason.CompilerArtifact) {
    const target = isJsonObject(value.target) ? value.target : {};
    return {
      reason: CargoReason.CompilerArtifact,
      packageId,
      kinds: strings(target.kind),
      filenames: strings(value.filenames),
      executable: typeof value.executable === "string" ? value.executable : null,
      fresh: value.fresh === true,
    };
  }
  if (value.reason === CargoReason.BuildScriptExecuted)
    return { reason: CargoReason.BuildScriptExecuted, packageId, outDir: text(value.out_dir) };
  if (value.reason === CargoReason.CompilerMessage) {
    const message = isJsonObject(value.message) ? value.message : {};
    const rendered = typeof message.rendered === "string" ? message.rendered : null;
    const level = typeof message.level === "string" ? message.level : null;
    return { reason: CargoReason.CompilerMessage, packageId, rendered, level };
  }
  if (value.reason === CargoReason.BuildFinished)
    return { reason: CargoReason.BuildFinished, success: value.success === true };
  return null;
}

/** The messages in cargo's stdout; a line that is not a JSON object, or names another reason, is skipped. */
export function parseCargoMessages(stdout: string): CargoMessage[] {
  const messages: CargoMessage[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const message = isJsonObject(value) ? messageOf(value) : null;
    if (message) messages.push(message);
  }
  return messages;
}

/** `file` relative to `root`, `/`-separated; refused when it lies outside. */
function underRoot(root: string, file: string): string {
  if (!path.isAbsolute(file) || !isInside(root, file) || path.resolve(file) === path.resolve(root))
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.Outside(file, root));
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * The target-folder-relative artifacts and build-script out dirs `messages` name, sorted and
 * deduplicated, and how many units built them. Anything outside `targetDir` refuses: a prewarm
 * whose outputs a clone of the folder would not carry is no prewarm.
 */
export function cargoOutputs(
  messages: readonly CargoMessage[],
  targetDir: string,
  exclude: (packageId: string) => boolean = () => false,
): { outputs: string[]; units: number } {
  const outputs = new Set<string>();
  const units = new Set<string>();
  for (const message of messages) {
    if (message.reason === CargoReason.CompilerArtifact) {
      for (const file of message.filenames) outputs.add(underRoot(targetDir, file));
      if (!exclude(message.packageId)) units.add(`${message.packageId} ${message.kinds.join(",")}`);
    } else if (message.reason === CargoReason.BuildScriptExecuted) {
      outputs.add(underRoot(targetDir, message.outDir));
      if (!exclude(message.packageId)) units.add(`${message.packageId} build-script`);
    }
  }
  return { outputs: [...outputs].sort(), units: units.size };
}

// ---------- locate ----------

/** What a Rust build of one destination runs with, all inside the store. */
export interface LocatedRust {
  lock: ToolchainLock;
  target: BuildTarget;
  triple: string;
  sysroot: string;
  cargo: string;
  rustc: string;
  cargoHome: string;
  /** The vendored crate tree. */
  vendor: string;
  /** The prewarmed target folder to clone, or null before this destination is prewarmed. */
  targetDir: string | null;
  record: RustPrewarmRecord | null;
  /** The naga validator, or null when this lock's prewarm built none. */
  nagaCheck: string | null;
  /** The crash symbolicator, or null when this lock's prewarm built none. */
  symbolicate: string | null;
  /** The web branch's tools (wasm-bindgen, binaryen's wasm-opt) when the destination required them; else null. */
  webTools: { wasmBindgen: string; wasmOpt: string } | null;
}

/** Options of {@link locateRust}. */
export interface LocateRustOptions {
  /** The flags the caller builds with: a prewarm made with others is stale. Absent: any. */
  rustflags?: readonly string[];
  /** Locate the components and the base even without a prewarmed target folder (default: required). */
  prewarm?: boolean;
  /** The components to require (default: everything a build of the destination needs, `STACK_REQUIRED_COMPONENTS`). */
  components?: readonly ToolchainId[];
}

/** A missing part of a Rust store, beside the component ids. */
export const RustMissing = {
  Base: "rust-base",
  Prewarm: "rust-prewarm",
} as const;
export type RustMissing = (typeof RustMissing)[keyof typeof RustMissing];

export type LocateRustResult =
  | { ok: true; located: LocatedRust }
  | { ok: false; missing: Array<ToolchainId | RustMissing> };

async function readRecord(file: string): Promise<Record<string, unknown> | null> {
  const value = await readFile(file, "utf8")
    .then((body) => JSON.parse(body) as unknown)
    .catch(() => null);
  return isJsonObject(value) && value.schema === RECORD_SCHEMA ? value : null;
}

/** Every triple a record may name: a destination's (the iOS Simulator's too), or a store host's own. */
const KNOWN_TRIPLES: ReadonlySet<string> = new Set([
  ...Object.values(RUST_TRIPLE),
  RUST_IOS_SIMULATOR_TRIPLE,
  ...Object.values(RUST_HOST_TRIPLE),
]);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isTreeDigest(value: unknown): value is TreeDigest {
  return isJsonObject(value) && typeof value.sha256 === "string" && isCount(value.files) && isCount(value.bytes);
}

function isPrewarmStep(value: unknown): value is RustPrewarmStepRecord {
  return (
    isJsonObject(value) && typeof value.label === "string" && typeof value.ms === "number" && Number.isFinite(value.ms)
  );
}

/** Whether a parsed `rust-base.json` has every field of its shape, each triple a known one. */
function isRustBaseRecord(record: Record<string, unknown>): record is Record<string, unknown> & RustBaseRecord {
  const triples = record.triples;
  const knownTriples = isStringList(triples) && triples.every((triple) => KNOWN_TRIPLES.has(triple));
  return (
    typeof record.lock === "string" && knownTriples && isTreeDigest(record.vendor) && typeof record.at === "string"
  );
}

/** Whether a parsed `rust-prewarm.json` has every field of its shape, its triple its destination's. */
function isRustPrewarmRecord(
  record: Record<string, unknown>,
  target: BuildTarget,
): record is Record<string, unknown> & RustPrewarmRecord {
  const lists = isStringList(record.rustflags) && isStringList(record.outputs) && isStringList(record.profile);
  const steps = Array.isArray(record.steps) && record.steps.every(isPrewarmStep);
  const sizes = isCount(record.units) && isCount(record.bytes);
  const named = typeof record.lock === "string" && record.target === target && record.triple === RUST_TRIPLE[target];
  return named && lists && steps && sizes && typeof record.at === "string";
}

/** The base record of `lock` in `root`, when it is this lock's and whole. */
export async function readRustBase(root: string, lock: ToolchainLock): Promise<RustBaseRecord | null> {
  const record = await readRecord(path.join(lockFolder(root, lock), RUST_BASE_FILE));
  if (!record || record.lock !== lock.digest || !isRustBaseRecord(record)) return null;
  return record;
}

/**
 * A destination's prewarm record, when it is this lock's, this destination's and made with
 * `rustflags` and this checkout's {@link RUST_DEV_PROFILE_SETTINGS}.
 */
export async function readRustPrewarm(
  root: string,
  lock: ToolchainLock,
  target: BuildTarget,
  rustflags?: readonly string[],
): Promise<RustPrewarmRecord | null> {
  const record = await readRecord(path.join(rustTargetFolder(root, lock, target), RUST_PREWARM_FILE));
  if (!record || record.lock !== lock.digest || !isRustPrewarmRecord(record, target)) return null;
  const sameFlags = rustflags === undefined || record.rustflags.join("\u0000") === rustflags.join("\u0000");
  const sameProfile = record.profile.join("\u0000") === RUST_DEV_PROFILE_SETTINGS.join("\u0000");
  return sameFlags && sameProfile ? record : null;
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** The executable name of a tool on the store's host. */
function exe(name: string, platform: NodeJS.Platform): string {
  return platform === StudioPlatform.Windows ? `${name}.exe` : name;
}

/** A located Rust store for `target`, the prewarm parts filled once they are found. */
/** Where the located wasm-bindgen and binaryen components hold their programs, when both were located. */
function webToolsOf(components: ReadonlyMap<ToolchainId, { folder: string }>): LocatedRust["webTools"] {
  const bindgen = components.get(ToolchainId.WasmBindgen)?.folder;
  const binaryen = components.get(ToolchainId.Binaryen)?.folder;
  if (!bindgen || !binaryen) return null;
  return {
    wasmBindgen: path.join(bindgen, ...RUST_COMPONENT_LAYOUT.wasmBindgen.split("/")),
    wasmOpt: path.join(binaryen, ...RUST_COMPONENT_LAYOUT.wasmOpt.split("/")),
  };
}

async function locatedParts(
  root: string,
  lock: ToolchainLock,
  target: BuildTarget,
  vendor: string,
  webTools: LocatedRust["webTools"],
) {
  const sysroot = rustSysroot(root, lock);
  const bin = path.join(sysroot, "bin");
  const naga = path.join(rustToolsFolder(root, lock), exe(NAGA_CHECK_TOOL, process.platform));
  const symbolicate = path.join(rustToolsFolder(root, lock), exe(SYMBOLICATE_TOOL, process.platform));
  const located: LocatedRust = {
    lock,
    target,
    triple: RUST_TRIPLE[target],
    sysroot,
    cargo: path.join(bin, exe("cargo", process.platform)),
    rustc: path.join(bin, exe("rustc", process.platform)),
    cargoHome: rustCargoHome(root, lock),
    vendor,
    targetDir: null,
    record: null,
    nagaCheck: (await exists(naga)) ? naga : null,
    symbolicate: (await exists(symbolicate)) ? symbolicate : null,
    webTools,
  };
  return located;
}

/**
 * What a build of `target` under `lock` runs with: the installed components the destination needs
 * (`STACK_REQUIRED_COMPONENTS`), the probed base, and (unless `prewarm: false`) the destination's
 * current prewarm with every output Cargo reported still present. Never throws: a malformed lock
 * or an absent store locates nothing.
 */
export async function locateRust(
  store: string,
  lock: ToolchainLock,
  target: BuildTarget,
  options: LocateRustOptions = {},
): Promise<LocateRustResult> {
  const required = [...(options.components ?? requiredFor([target], GameStack.RustWgpu))];
  const root = await realpath(store).catch(() => null);
  if (!root || !isToolchainLock(lock)) return { ok: false, missing: required };
  const found = await locateComponents(root, lock, required);
  if (!found.ok) return { ok: false, missing: found.missing };
  const base = await readRustBase(root, lock);
  if (!base?.triples.includes(RUST_TRIPLE[target])) return { ok: false, missing: [RustMissing.Base] };
  const vendorFolder = found.components.get(ToolchainId.RustVendor)?.folder ?? "";
  const vendor = path.join(vendorFolder, RUST_VENDOR_LAYOUT);
  const located = await locatedParts(root, lock, target, vendor, webToolsOf(found.components));
  if (options.prewarm === false) return { ok: true, located };
  const record = await readRustPrewarm(root, lock, target, options.rustflags);
  const targetDir = rustPrewarmedTargetDir(root, lock, target);
  if (!record) return { ok: false, missing: [RustMissing.Prewarm] };
  const present = await Promise.all(record.outputs.map((rel) => exists(path.join(targetDir, ...rel.split("/")))));
  if (!present.every(Boolean)) return { ok: false, missing: [RustMissing.Prewarm] };
  return { ok: true, located: { ...located, targetDir, record } };
}

/** The vendored tree inside the `rust-vendor` component. */
export const RUST_VENDOR_LAYOUT = "vendor";

/** Variables a caller's environment may carry that would pick another toolchain, wrapper or flags. */
const CLEARED_VARIABLES = [
  "RUSTUP_TOOLCHAIN",
  "RUSTUP_HOME",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC",
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "RUSTC_BOOTSTRAP",
] as const;

/**
 * The environment a cargo run over `located` needs: the sysroot's `bin` first on PATH, the store's
 * CARGO_HOME, its rustc, offline, and every inherited toolchain selector, wrapper and flag cleared
 * (set empty, so a sandbox that merges the caller's environment cannot bring one back).
 * `CARGO_TARGET_DIR` and the compiler flags (`CARGO_ENCODED_RUSTFLAGS`) are the caller's.
 */
export function rustEnv(located: LocatedRust, basePath = "/usr/bin:/bin:/usr/sbin:/sbin"): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [path.join(located.sysroot, "bin"), basePath].join(path.delimiter),
    CARGO_HOME: located.cargoHome,
    CARGO: located.cargo,
    RUSTC: located.rustc,
    RUSTDOC: path.join(located.sysroot, "bin", exe("rustdoc", process.platform)),
    CARGO_NET_OFFLINE: "true",
    CARGO_TERM_COLOR: "never",
  };
  for (const name of CLEARED_VARIABLES) env[name] = "";
  return env;
}

/** The part folders the `rust` component's archives unpack into (`RUST_PARTS`), under its install `folder`. */
export function rustPartFolders(folder: string): string[] {
  return RUST_PARTS.map((part) => path.join(folder, part));
}
