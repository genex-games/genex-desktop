/**
 * The host-staged copy a Rust · wgpu game builds from (plan "Lane rules"). Cargo never reads the
 * game folder: the host copies `src/`, `assets/` and the WGSL sources `genex.toml` names into a
 * stage of its own, writes the cargo manifest and lock there (`rust-manifest.ts`), and the lane
 * builds from it. The stage is link-free by construction and read for every way Rust source can
 * reach a file at compile time, so a build reads nothing of the machine through the game's code:
 *
 * - a link anywhere under `src/` or `assets/` (a symlinked facet, folder or asset) is refused, as
 *   is a hard link (it may name a file outside the game) and anything that is not a file or
 *   folder; the names an export leaves out (`excludedFromExport`: dotfiles, keys, env files,
 *   notes, `tests/` and `docs/` folders) are never staged;
 * - `include!`, `include_str!` and `include_bytes!` take one string literal naming a staged file
 *   (relative to the file that holds it; `include!` only a `.rs` one); a path built by a macro, an
 *   absolute one, one climbing out of the stage and a renamed include (`use … as`) are refused;
 * - `#[path = "…"]`, plain or under `cfg_attr`, stays inside the stage;
 * - inside a `macro_rules!` body, where the including file is the caller's, those paths may not
 *   climb at all, and no macro is invoked by a metavariable (`$m!(…)`, `$($m)::+!(…)`): the stage
 *   could not tell an include or `env!` passed in as a fragment from any other macro;
 * - `path = "…"` anywhere (an attribute, or tokens a macro forwards whole as a `meta` fragment)
 *   stays inside the stage, and inside a macro body a `path` value or attribute key may not be a
 *   metavariable;
 * - `env!` and `option_env!` read only the package variables cargo sets from the host-written
 *   manifest (`RUST_ENV_MACRO_NAMES`), never a host variable such as `HOME`.
 *
 * An ejected game (extension ladder level 5, `genex.toml` `[engine]`) also stages its fork: each
 * crate of `RUST_ENGINE_CRATES` under `engine/` is copied and scanned like `src/` (its sources may
 * also read the facade's own build variables, `RUST_ENGINE_ENV_NAMES`), except its `Cargo.toml`,
 * which the host writes from the store's vendored crate of the ejected release, so no game edit
 * reaches cargo's configuration through the fork either; a game that is not ejected never stages
 * `engine/`. Ejected means the person ejected it: the `[engine]` row must name the release the host
 * recorded for the game (`StageInput.ejectedFrom`, the profile's record, never a game file); a row
 * without that record, or a record whose row is gone or changed, is refused `engine-unrecorded`.
 *
 * Everything is checked in the copy, never the game folder, so a file changed after it was read
 * cannot slip through. The walk starts from the game folder's real path and pins every folder it
 * reads by its identity (device and inode, never a link): a folder swapped for a link or another
 * folder while the walk is in it is refused `source-changed` once its files are copied. A refused game leaves nothing staged: the copy is made beside the stage
 * (`<stage>.genex-part-*`) and renamed into place only once whole, and a refusal removes any
 * previous stage too, so a lane never builds a stale one.
 */
import { constants as FS, createWriteStream, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { BuildTarget } from "../shared/game-project.ts";
import { NATIVE_WGSL_MAX_BYTES, NativeRefusal } from "../shared/native-contract.ts";
import { openNoFollow, readRegularFile } from "../substrate/fsx.ts";
import { excludedFromExport } from "../substrate/game-export.ts";
import { GENEX_MANIFEST } from "../substrate/project-shape.ts";
import {
  checkTargetFeatures,
  checkWgslFiles,
  type GenexToml,
  GenexTomlCode,
  readGenexToml,
} from "../substrate/genex-toml.ts";
import {
  cargoManifest,
  type EngineFork,
  gameCargoLock,
  facadePackageFor,
  RUST_ENGINE_CRATES,
  RUST_ENGINE_ENV_NAMES,
  RUST_ENGINE_FOLDER,
  RUST_ENV_MACRO_NAMES,
  type RustFacadePackage,
  RustFlavour,
  type RustManifestCode,
  type RustNetFeature,
  type RustPins,
} from "./rust-manifest.ts";

/** Why the host refused to stage a game's sources. Wire values; the two link codes are the bundle gate's. */
export const RustStageCode = {
  /** A link under `src/` or `assets/`, or either folder itself a link. */
  Symlink: NativeRefusal.Symlink,
  /** A file with more than one name: it may be a file outside the game. */
  HardLink: NativeRefusal.HardLink,
  /** A FIFO, socket or device under `src/` or `assets/`. */
  NotAFile: "not-a-file",
  /** A file changed between the walk and its copy. */
  SourceChanged: "source-changed",
  /** No `src/main.rs` (or no `src/` folder) to build. */
  MissingEntry: "missing-entry",
  /** An include whose argument is not one string literal (a path built by `concat!`, `env!`, a macro argument). */
  IncludeNotLiteral: "include-not-literal",
  /** An include path that is absolute or climbs out of the stage. */
  IncludeEscape: "include-escape",
  /** An include of a file the stage does not hold (missing, or a private name such as a key or a dotfile). */
  IncludeNotStaged: "include-not-staged",
  /** `include!` of a file that is not Rust source. */
  IncludeNotRust: "include-not-rust",
  /** An include macro renamed with `use … as`, so the stage could not follow it. */
  IncludeRenamed: "include-renamed",
  /** A `#[path]` that is absolute, built by a macro, or leaves the stage. */
  PathEscape: "path-escape",
  /** `env!`/`option_env!` of a variable other than cargo's package variables, renamed, or not a literal. */
  EnvNotFixed: "env-not-fixed",
  /** A macro invoked by a metavariable inside a `macro_rules!` body, so the stage cannot tell what it reads. */
  MacroIndirect: "macro-indirect",
  /** An ejected game whose `engine/` holds no `genex` crate, or whose forked crate the store's vendored set lacks. */
  EngineMissing: "engine-missing",
  /** `genex.toml`'s `[engine]` row and the person's recorded eject disagree (a row the person never made, or one removed). */
  EngineUnrecorded: "engine-unrecorded",
} as const;
export type RustStageCode = (typeof RustStageCode)[keyof typeof RustStageCode];

/** Every code a staging refusal carries. */
export type StageCode = RustStageCode | GenexTomlCode | RustManifestCode | typeof NativeRefusal.NativeFeaturesWeb;

/** A refused staging: its code and the offending path or value, relative to the game (never a host path). */
export interface StageRefusal {
  ok: false;
  code: StageCode;
  detail: string;
}

/** A staged game. */
export interface StagedGame {
  ok: true;
  manifest: GenexToml;
  /** Every file in the stage, `/`-joined, sorted: the host-written cargo files included. */
  files: string[];
  cargoToml: string;
  /** Null when the store hands no lock line (the lane resolves one itself). */
  cargoLock: string | null;
  /** The sha256 of {@link cargoLock}. */
  lockDigest: string | null;
}

export type StageResult = StagedGame | StageRefusal;

/** What to stage: the game folder, where its stage goes, the destination and the store's pins. */
export interface StageInput {
  source: string;
  stage: string;
  target: BuildTarget;
  pins: RustPins;
  /** The facade the build links: the dev flavour serves the studio over fd 3 (default: an export's). */
  flavour?: RustFlavour;
  /** What a game with `[net] enabled = true` links in this build (G6 MP-5b); absent: nothing. */
  net?: RustNetFeature;
  /** The store's vendored crate set: an ejected game's forked crates take their `Cargo.toml` from it. */
  engineVendor?: string | null;
  /**
   * The release the person ejected the game's engine from, as the host recorded it (`rust-eject.ts`);
   * null or absent: not ejected. Only a game whose `[engine]` row names this release stages a fork.
   */
  ejectedFrom?: string | null;
  /** Test seams: where the walk may be raced. */
  hooks?: StageHooks;
}

/** Points a test may act at while the walk runs (a folder swapped for a link). */
export interface StageHooks {
  /** After the walk listed the folder at `rel` (`/`-joined, relative to the game), before it copies anything in it. */
  afterReaddir?: (rel: string) => Promise<void>;
}

/** The folders of a game a build takes whole. `src/` is required. */
const SOURCE_FOLDER = "src";
const ASSETS_FOLDER = "assets";
/** World placement files (`world/*.cells.json`), compiled by the import step into `assets/` (C-28); never shipped. */
const WORLD_FOLDER = "world";
/** The entry cargo builds (`[[bin]] path` in the host-written manifest). */
const ENTRY = "src/main.rs";
/** A copy in progress, beside the stage, renamed into place once whole. */
const PART_SUFFIX = ".genex-part-";
const CARGO_TOML = "Cargo.toml";
const CARGO_LOCK = "Cargo.lock";
const RUST_FILE = /\.rs$/;

const refuse = (code: StageCode, detail: string): StageRefusal => ({ ok: false, code, detail });

/** What an ejected game's fork stages from: the store's vendored crates and the person's recorded eject. */
interface EngineInput {
  vendor: string | null;
  ejectedFrom: string | null;
}
/** The store's pins with the facade flavour and package the build links, and an ejected game's fork. */
type StagePins = RustPins & {
  flavour: RustFlavour;
  facade: RustFacadePackage;
  fork?: EngineFork | null;
  net?: RustNetFeature | null;
};
/** A forked crate's files the host writes (or leaves out) instead of the game's copy. */
const ENGINE_HOST_FILES: readonly string[] = ["Cargo.toml", "Cargo.toml.orig"];
/** The most of a vendored crate's `Cargo.toml` the host reads. */
const ENGINE_MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * Stage `input.source` at `input.stage` for `input.target`: the link-free copy, checked, with the
 * host's cargo manifest and lock. Throws only on an I/O failure of the host's own folders.
 */
export async function stageRustGame(input: StageInput): Promise<StageResult> {
  const parsed = await readGenexToml(input.source);
  if (!parsed.ok) return clearStage(input.stage, parsed);
  const fits = checkTargetFeatures(parsed.manifest, input.target);
  if (!fits.ok) return clearStage(input.stage, fits);
  const source = await realpath(input.source).catch(() => null);
  if (source === null) return clearStage(input.stage, refuse(RustStageCode.SourceChanged, "."));
  await mkdir(path.dirname(input.stage), { recursive: true });
  const part = await mkdtemp(`${input.stage}${PART_SUFFIX}`);
  try {
    const flavour = input.flavour ?? RustFlavour.Export;
    const walk: Walk = { source, part, files: [], hooks: input.hooks ?? {} };
    const facade = facadePackageFor(input.target);
    const pins = { ...input.pins, flavour, facade, net: input.net ?? null };
    const engine = { vendor: input.engineVendor ?? null, ejectedFrom: input.ejectedFrom ?? null };
    const filled = await fillStage(walk, parsed.manifest, pins, engine);
    if (!filled.ok) return await clearStage(input.stage, filled);
    // The game folder (or a folder above it) swapped for another while it was copied.
    const moved = (await realpath(input.source).catch(() => null)) !== source;
    if (moved) return await clearStage(input.stage, refuse(RustStageCode.SourceChanged, "."));
    await rm(input.stage, { recursive: true, force: true });
    await rename(part, input.stage);
    return filled;
  } finally {
    await rm(part, { recursive: true, force: true });
  }
}

async function clearStage(stage: string, refusal: { code: StageCode; detail: string }): Promise<StageRefusal> {
  await rm(stage, { recursive: true, force: true });
  return refuse(refusal.code, refusal.detail);
}

/** Copy, check and write the cargo files into the walk's copy. */
async function fillStage(walk: Walk, manifest: GenexToml, pins: StagePins, engine: EngineInput): Promise<StageResult> {
  const { part, files } = walk;
  const root = await pinFolder(walk.source, ".");
  if ("ok" in root) return root;
  const copied =
    (await copyFolder(walk, [root], SOURCE_FOLDER, true)) ??
    (await copyFolder(walk, [root], ASSETS_FOLDER, false)) ??
    (await copyFolder(walk, [root], WORLD_FOLDER, false)) ??
    (await copyWgsl(walk, [root], manifest));
  if (copied) return copied;
  if (!files.includes(ENTRY)) return refuse(RustStageCode.MissingEntry, ENTRY);
  const fork = await stageEngine(walk, [root], manifest, engine);
  if ("ok" in fork) return fork;
  const wgsl = await checkWgslFiles(part, manifest);
  if (!wgsl.ok) return wgsl;
  const scanned = await scanStage(part, files);
  if (scanned) return scanned;
  return writeCargoFiles(part, manifest, { ...pins, fork: fork.fork }, files);
}

/**
 * An ejected game's fork, staged: each forked crate under `engine/` copied as `src/` is, with the
 * host's `Cargo.toml` from the store's vendored crate of the ejected release in place of the
 * game's. `{ fork: null }` for a game that is not ejected: nothing under `engine/` is staged.
 */
async function stageEngine(
  walk: Walk,
  chain: readonly FolderPin[],
  manifest: GenexToml,
  { vendor: engineVendor, ejectedFrom }: EngineInput,
): Promise<{ fork: EngineFork | null } | StageRefusal> {
  const version = manifest.engine?.ejectedFrom ?? null;
  if (version === null && ejectedFrom === null) return { fork: null };
  if (version === null || version !== ejectedFrom)
    return refuse(RustStageCode.EngineUnrecorded, `${GENEX_MANIFEST} [engine]`);
  const engine = await pinFolder(path.join(walk.source, RUST_ENGINE_FOLDER), RUST_ENGINE_FOLDER);
  if ("ok" in engine) return engine.code === RustStageCode.NotAFile ? engineMissing(RUST_ENGINE_FOLDER) : engine;
  await mkdir(path.join(walk.part, RUST_ENGINE_FOLDER), { recursive: true });
  const crates: string[] = [];
  for (const name of RUST_ENGINE_CRATES) {
    const rel = `${RUST_ENGINE_FOLDER}/${name}`;
    const present = await lstat(path.join(walk.source, RUST_ENGINE_FOLDER, name)).catch(() => null);
    if (present === null) continue;
    const refused =
      (await copyTree(walk, [...chain, engine], rel)) ??
      (await hostCrateManifest(walk, rel, name, version, engineVendor));
    if (refused) return refused;
    crates.push(name);
  }
  if (!crates.includes("genex")) return engineMissing(`${RUST_ENGINE_FOLDER}/genex`);
  return { fork: { version, crates } };
}

/** Replace a staged forked crate's cargo files with the store's vendored `Cargo.toml` of `name` at `version`. */
async function hostCrateManifest(
  walk: Walk,
  rel: string,
  name: string,
  version: string,
  engineVendor: string | null,
): Promise<StageRefusal | null> {
  for (const file of ENGINE_HOST_FILES) {
    await rm(path.join(walk.part, ...rel.split("/"), file), { force: true });
    const at = walk.files.indexOf(`${rel}/${file}`);
    if (at >= 0) walk.files.splice(at, 1);
  }
  const vendored = engineVendor === null ? null : await vendoredManifest(engineVendor, name, version);
  if (vendored === null) return engineMissing(`${name} ${version}`);
  await writeFile(path.join(walk.part, ...rel.split("/"), CARGO_TOML), vendored, { flag: "wx" });
  walk.files.push(`${rel}/${CARGO_TOML}`);
  return null;
}

/** The vendored `Cargo.toml` of `name` at `version` (`<name>-<version>/`), read as a regular file; null when absent. */
async function vendoredManifest(vendor: string, name: string, version: string): Promise<Buffer | null> {
  const file = path.join(vendor, `${name}-${version}`, CARGO_TOML);
  return readRegularFile(file, ENGINE_MANIFEST_MAX_BYTES).catch(() => null);
}

function engineMissing(detail: string): StageRefusal {
  return refuse(RustStageCode.EngineMissing, detail);
}

async function writeCargoFiles(
  part: string,
  manifest: GenexToml,
  pins: StagePins,
  files: string[],
): Promise<StageResult> {
  const fork = pins.fork ?? null;
  const cargoToml = cargoManifest(manifest, pins.genexVersion, pins.flavour, pins.facade, fork, pins.net ?? null);
  await writeFile(path.join(part, CARGO_TOML), cargoToml, { flag: "wx" });
  files.push(CARGO_TOML);
  let cargoLock: string | null = null;
  let lockDigest: string | null = null;
  if (pins.baseLock !== null) {
    const lock = gameCargoLock(manifest, {
      genexVersion: pins.genexVersion,
      baseLock: pins.baseLock,
      facade: pins.facade,
      fork,
    });
    if (!lock.ok) return lock;
    await writeFile(path.join(part, CARGO_LOCK), lock.text, { flag: "wx" });
    files.push(CARGO_LOCK);
    cargoLock = lock.text;
    lockDigest = lock.digest;
  }
  return { ok: true, manifest, files: files.sort(), cargoToml, cargoLock, lockDigest };
}

// ── The copy ───────────────────────────────────────────────────────────────────────────────────

/** One copy: the game folder's real path, the copy in progress, the files copied so far and the seams. */
interface Walk {
  source: string;
  part: string;
  files: string[];
  hooks: StageHooks;
}

/** A folder the walk passed through, pinned by its identity. */
interface FolderPin {
  dir: string;
  rel: string;
  dev: number;
  ino: number;
}

/** The folder at `dir` as it is now: refused when it is a link or not a folder. */
async function pinFolder(dir: string, rel: string): Promise<FolderPin | StageRefusal> {
  const seen = await lstat(dir).catch(() => null);
  if (seen?.isSymbolicLink()) return refuse(RustStageCode.Symlink, rel);
  if (!seen?.isDirectory()) return refuse(RustStageCode.NotAFile, rel);
  return { dir, rel, dev: seen.dev, ino: seen.ino };
}

/** The first folder of `chain` that is no longer the folder the walk pinned, as a refusal; null when none moved. */
async function movedFolder(chain: readonly FolderPin[]): Promise<StageRefusal | null> {
  for (const pin of chain) {
    const now = await lstat(pin.dir).catch(() => null);
    const same = now?.isDirectory() === true && now.dev === pin.dev && now.ino === pin.ino;
    if (!same) return refuse(RustStageCode.SourceChanged, pin.rel);
  }
  return null;
}

/** Copy `<source>/<folder>` into `<part>/<folder>`; a missing optional folder copies nothing. */
async function copyFolder(
  walk: Walk,
  chain: readonly FolderPin[],
  folder: string,
  required: boolean,
): Promise<StageRefusal | null> {
  const top = await lstat(path.join(walk.source, folder)).catch(() => null);
  if (top?.isSymbolicLink()) return refuse(RustStageCode.Symlink, folder);
  if (!top?.isDirectory()) return required ? refuse(RustStageCode.MissingEntry, folder) : null;
  return copyTree(walk, chain, folder);
}

/** Copy the folder at `rel`, pinned while it is read: a swap of it or a folder above it refuses the copy. */
async function copyTree(walk: Walk, parents: readonly FolderPin[], rel: string): Promise<StageRefusal | null> {
  const pinned = await pinFolder(path.join(walk.source, ...rel.split("/")), rel);
  if ("ok" in pinned) return pinned;
  const chain = [...parents, pinned];
  await mkdir(path.join(walk.part, ...rel.split("/")));
  const entries = await readdir(pinned.dir, { withFileTypes: true });
  await walk.hooks.afterReaddir?.(rel);
  const moved = await movedFolder(chain);
  if (moved) return moved;
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (excludedFromExport(entry.name)) continue;
    const child = `${rel}/${entry.name}`;
    const refused = entry.isDirectory() ? await copyTree(walk, chain, child) : await copyEntry(walk, chain, child);
    if (refused) return refused;
  }
  return movedFolder(chain);
}

/**
 * Copy one non-folder entry: a regular file with one name, opened as the very file the walk saw,
 * every folder above it still the one the walk pinned once it is copied.
 */
async function copyEntry(walk: Walk, chain: readonly FolderPin[], rel: string): Promise<StageRefusal | null> {
  const from = path.join(walk.source, ...rel.split("/"));
  const seen = await lstat(from);
  if (seen.isSymbolicLink()) return refuse(RustStageCode.Symlink, rel);
  if (!seen.isFile()) return refuse(RustStageCode.NotAFile, rel);
  if (seen.nlink > 1) return refuse(RustStageCode.HardLink, rel);
  const refused =
    (await copyFile(from, path.join(walk.part, ...rel.split("/")), seen, rel)) ?? (await movedFolder(chain));
  if (!refused) walk.files.push(rel);
  return refused;
}

async function copyFile(from: string, to: string, seen: Stats, rel: string): Promise<StageRefusal | null> {
  const handle = await openNoFollow(from, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (handle === null) return refuse(RustStageCode.Symlink, rel);
  try {
    const opened = await handle.stat();
    const same = opened.isFile() && opened.ino === seen.ino && opened.dev === seen.dev && opened.nlink === 1;
    if (!same) return refuse(RustStageCode.SourceChanged, rel);
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(to, { flags: "wx", mode: 0o644 }));
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Copy the WGSL sources `genex.toml` names that `src/` and `assets/` did not bring, each reached
 * from the game folder without a link at any step; their size and kind are checked in the stage.
 */
async function copyWgsl(walk: Walk, chain: readonly FolderPin[], manifest: GenexToml): Promise<StageRefusal | null> {
  const { source, part, files } = walk;
  for (const { path: rel } of manifest.wgsl) {
    if (files.includes(rel)) continue;
    const segments = rel.split("/");
    const refused =
      (await copyWgslFolders(source, part, segments, rel)) ??
      (await copyWgslFile(source, part, segments, rel)) ??
      (await movedFolder(chain));
    if (refused) return refused;
    files.push(rel);
  }
  return null;
}

/** Make the folders above a WGSL source in the stage, each a real folder (never a link) in the game. */
async function copyWgslFolders(
  source: string,
  part: string,
  segments: readonly string[],
  rel: string,
): Promise<StageRefusal | null> {
  for (let depth = 1; depth < segments.length; depth += 1) {
    const step = await lstat(path.join(source, ...segments.slice(0, depth))).catch(() => null);
    if (step?.isSymbolicLink()) return refuse(GenexTomlCode.WgslLinked, rel);
    if (!step?.isDirectory()) return refuse(GenexTomlCode.WgslNotAFile, rel);
    await mkdir(path.join(part, ...segments.slice(0, depth)), { recursive: true });
  }
  return null;
}

/** Copy one WGSL source: a regular file with one name, at most `NATIVE_WGSL_MAX_BYTES`. */
async function copyWgslFile(
  source: string,
  part: string,
  segments: readonly string[],
  rel: string,
): Promise<StageRefusal | null> {
  const found = await lstat(path.join(source, ...segments)).catch(() => null);
  if (found?.isSymbolicLink()) return refuse(GenexTomlCode.WgslLinked, rel);
  if (!found?.isFile()) return refuse(GenexTomlCode.WgslNotAFile, rel);
  if (found.nlink > 1) return refuse(GenexTomlCode.WgslLinked, rel);
  if (found.size > NATIVE_WGSL_MAX_BYTES) return refuse(GenexTomlCode.WgslTooLarge, rel);
  return copyFile(path.join(source, ...segments), path.join(part, ...segments), found, rel);
}

// ── The source scan ────────────────────────────────────────────────────────────────────────────

/** The include macros: each takes one path, relative to the file the call is in. */
const INCLUDE_MACROS = new Set(["include", "include_str", "include_bytes"]);
/** The macros that read the build's environment. */
const ENV_MACROS = new Set(["env", "option_env"]);
/** The delimiters a macro call opens with, and what closes each. */
const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
/** The operators that end a `$( … )` repetition in a macro body. */
const REPETITION_OPS = new Set(["*", "+", "?"]);
/** At most this many separator tokens sit between a repetition's `)` and its operator (`::` is two). */
const REPETITION_SEPARATOR_MAX = 2;
/** The attribute key that names a module's file. */
const PATH_KEY = "path";

/** Read every staged Rust file for a compile-time reach outside the stage. */
async function scanStage(part: string, files: readonly string[]): Promise<StageRefusal | null> {
  const staged = new Set(files);
  for (const rel of files.filter((file) => RUST_FILE.test(file))) {
    const text = await readFile(path.join(part, ...rel.split("/")), "utf8");
    const refused = scanRustSource(text, rel, staged);
    if (refused) return refused;
  }
  return null;
}

/** What a scan knows of the file it reads. */
interface ScanContext {
  tokens: readonly Token[];
  /** The file's folder, `/`-joined, relative to the stage. */
  dir: string;
  rel: string;
  staged: ReadonlySet<string>;
  /** `[start, end)` token ranges of `macro_rules!` bodies. */
  macroBodies: ReadonlyArray<readonly [number, number]>;
}

/** The first compile-time reach outside the stage in one Rust file, or null. */
export function scanRustSource(text: string, rel: string, staged: ReadonlySet<string>): StageRefusal | null {
  const tokens = lexRust(text);
  const context: ScanContext = { tokens, dir: path.posix.dirname(rel), rel, staged, macroBodies: macroBodies(tokens) };
  for (let at = 0; at < tokens.length; at += 1) {
    const refused = scanToken(context, at);
    if (refused) return refused;
  }
  return null;
}

function scanToken(context: ScanContext, at: number): StageRefusal | null {
  const token = context.tokens[at];
  if (token?.kind === TokenKind.Ident && INCLUDE_MACROS.has(token.text)) return checkInclude(context, at, token.text);
  if (token?.kind === TokenKind.Ident && ENV_MACROS.has(token.text)) return checkEnv(context, at);
  if (token?.kind === TokenKind.Ident && token.text === PATH_KEY) return checkPathValue(context, at);
  if (isPunct(token, "#")) return checkAttribute(context, at);
  if (isPunct(token, "!") && insideMacroBody(context, at)) return checkIndirectCall(context, at);
  return null;
}

/**
 * `$m!(…)` or `$($m)::+!(…)` in a macro body: a macro whose name arrives as a fragment, which may
 * be `include_bytes` or `env` from the caller, so the stage refuses it.
 */
function checkIndirectCall(context: ScanContext, at: number): StageRefusal | null {
  const { tokens } = context;
  const open = tokens[at + 1];
  const invoked = open?.kind === TokenKind.Punct && CLOSERS[open.text] !== undefined;
  if (!invoked || !namedByFragment(tokens, at - 1)) return null;
  return refuse(RustStageCode.MacroIndirect, `${context.rel}: a macro invoked by a metavariable`);
}

/** Whether the macro name ending at `end` is a metavariable or a `$( … )` repetition of one. */
function namedByFragment(tokens: readonly Token[], end: number): boolean {
  const last = tokens[end];
  if (last?.kind === TokenKind.Ident) return isPunct(tokens[end - 1], "$");
  if (last?.kind !== TokenKind.Punct || !REPETITION_OPS.has(last.text)) return false;
  for (let close = end - 1; close >= end - 1 - REPETITION_SEPARATOR_MAX; close -= 1) {
    if (isPunct(tokens[close], ")")) return isPunct(tokens[matchingOpen(tokens, close) - 1], "$");
  }
  return false;
}

/**
 * `path = …` anywhere: a literal must stay inside the stage (an attribute, or the tokens a macro
 * forwards whole as a `meta` fragment into `#[$a]`); in a macro body the value may not be a
 * metavariable. Any other value outside an attribute is ordinary code.
 */
function checkPathValue(context: ScanContext, at: number): StageRefusal | null {
  const { tokens } = context;
  const assigned = isPunct(tokens[at + 1], "=") && !isPunct(tokens[at + 2], "=");
  if (!assigned) return null;
  const value = tokens[at + 2];
  const inMacro = insideMacroBody(context, at);
  const fragment = inMacro && isPunct(value, "$");
  const literal = value?.kind === TokenKind.Str ? value.value : null;
  const escapes = literal !== null && resolveInStage(context.dir, literal, inMacro) === null;
  if (!fragment && !escapes) return null;
  return refuse(RustStageCode.PathEscape, `${context.rel}: path = ${JSON.stringify(literal)}`);
}

/** The literal a macro call at `at` takes as its first argument; `renamed` when the name is imported under another one. */
function macroArgument(tokens: readonly Token[], at: number): { literal: string | null } | "renamed" | "none" {
  const next = tokens[at + 1];
  if (next?.kind === TokenKind.Ident && next.text === "as") return "renamed";
  if (!isPunct(next, "!")) return "none";
  const open = tokens[at + 2];
  const close = open?.kind === TokenKind.Punct ? CLOSERS[open.text] : undefined;
  const argument = tokens[at + 3];
  if (close === undefined || argument?.kind !== TokenKind.Str) return { literal: null };
  const after = tokens[at + 4];
  const ends = isPunct(after, close) || (isPunct(after, ",") && isPunct(tokens[at + 5], close));
  return { literal: ends ? argument.value : null };
}

function checkInclude(context: ScanContext, at: number, name: string): StageRefusal | null {
  const argument = macroArgument(context.tokens, at);
  if (argument === "none") return null;
  if (argument === "renamed") return refuse(RustStageCode.IncludeRenamed, `${context.rel}: ${name}`);
  const detail = `${context.rel}: ${name}!(${JSON.stringify(argument.literal)})`;
  if (argument.literal === null) return refuse(RustStageCode.IncludeNotLiteral, detail);
  const inMacro = insideMacroBody(context, at);
  const target = resolveInStage(context.dir, argument.literal, inMacro);
  if (target === null) return refuse(RustStageCode.IncludeEscape, detail);
  if (name === "include" && !RUST_FILE.test(target)) return refuse(RustStageCode.IncludeNotRust, detail);
  if (!inMacro && !context.staged.has(target)) return refuse(RustStageCode.IncludeNotStaged, detail);
  return null;
}

function checkEnv(context: ScanContext, at: number): StageRefusal | null {
  const argument = macroArgument(context.tokens, at);
  if (argument === "none") return null;
  const literal = argument === "renamed" ? null : argument.literal;
  if (literal !== null && RUST_ENV_MACRO_NAMES.includes(literal)) return null;
  // An ejected engine's sources read the facade's own build variables, which the lane sets itself.
  const engineFile = context.rel.startsWith(`${RUST_ENGINE_FOLDER}/`);
  if (literal !== null && engineFile && RUST_ENGINE_ENV_NAMES.includes(literal)) return null;
  return refuse(RustStageCode.EnvNotFixed, `${context.rel}: ${JSON.stringify(literal)}`);
}

/** `#[…]` or `#![…]`: every `path = "…"` inside, a `cfg_attr` one included. */
function checkAttribute(context: ScanContext, at: number): StageRefusal | null {
  const { tokens } = context;
  const open = isPunct(tokens[at + 1], "!") ? at + 2 : at + 1;
  if (!isPunct(tokens[open], "[")) return null;
  const end = matchingClose(tokens, open);
  const inMacro = insideMacroBody(context, at);
  for (let inner = open + 1; inner < end; inner += 1) {
    const token = tokens[inner];
    // `#[$k = "…"]` in a macro body: the key may be `path`, passed in as a fragment.
    const fragmentKey = inMacro && isPunct(token, "$") && isPunct(tokens[inner + 2], "=");
    if (fragmentKey)
      return refuse(RustStageCode.PathEscape, `${context.rel}: an attribute key passed as a metavariable`);
    const keyed = token?.kind === TokenKind.Ident && token.text === PATH_KEY && isPunct(tokens[inner + 1], "=");
    if (!keyed) continue;
    const value = tokens[inner + 2];
    const literal = value?.kind === TokenKind.Str ? value.value : null;
    const inside = literal !== null && resolveInStage(context.dir, literal, inMacro) !== null;
    if (!inside) return refuse(RustStageCode.PathEscape, `${context.rel}: path = ${JSON.stringify(literal)}`);
  }
  return null;
}

/**
 * The stage path a literal names from `dir`, or null when it is absolute, carries a backslash or a
 * drive, or climbs out of the stage. Inside a macro body it may not climb at all: the including
 * file is the caller's, wherever that is.
 */
function resolveInStage(dir: string, literal: string, inMacro: boolean): string | null {
  const foreign = literal === "" || /^[/\\~]/.test(literal) || /^[A-Za-z]:/.test(literal) || /[\\\0]/.test(literal);
  if (foreign) return null;
  if (inMacro && literal.split("/").includes("..")) return null;
  const joined = path.posix.normalize(path.posix.join(dir, literal));
  if (joined === "." || joined === ".." || joined.startsWith("../")) return null;
  return joined;
}

function insideMacroBody(context: ScanContext, at: number): boolean {
  return context.macroBodies.some(([start, end]) => at > start && at < end);
}

/** The `[start, end)` token ranges of every `macro_rules! name { … }` body. */
function macroBodies(tokens: readonly Token[]): Array<readonly [number, number]> {
  const bodies: Array<readonly [number, number]> = [];
  tokens.forEach((token, at) => {
    const named = token.kind === TokenKind.Ident && token.text === "macro_rules" && isPunct(tokens[at + 1], "!");
    const open = tokens[at + 3];
    if (named && open?.kind === TokenKind.Punct && CLOSERS[open.text] !== undefined)
      bodies.push([at + 3, matchingClose(tokens, at + 3)]);
  });
  return bodies;
}

/** The index of the delimiter opening the one that closes at `close` (-1 when none does). */
function matchingOpen(tokens: readonly Token[], close: number): number {
  let depth = 0;
  for (let at = close; at >= 0; at -= 1) {
    const token = tokens[at];
    if (token?.kind !== TokenKind.Punct) continue;
    if (Object.values(CLOSERS).includes(token.text)) depth += 1;
    else if (CLOSERS[token.text] !== undefined) depth -= 1;
    if (depth === 0) return at;
  }
  return -1;
}

/** The index of the delimiter closing the one at `open` (the end of the file when none does). */
function matchingClose(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token?.kind !== TokenKind.Punct) continue;
    if (CLOSERS[token.text] !== undefined) depth += 1;
    else if (Object.values(CLOSERS).includes(token.text)) depth -= 1;
    if (depth === 0) return at;
  }
  return tokens.length;
}

// ── A Rust lexer, as much of one as the scan needs ─────────────────────────────────────────────

/** What a token is. */
const TokenKind = {
  Ident: "ident",
  Punct: "punct",
  /** A string literal: `value` is its text, or null for a byte or C string or an escape the scan does not decode. */
  Str: "str",
} as const;

type Token =
  | { kind: typeof TokenKind.Ident; text: string }
  | { kind: typeof TokenKind.Punct; text: string }
  | { kind: typeof TokenKind.Str; value: string | null };

const isPunct = (token: Token | undefined, text: string): boolean =>
  token?.kind === TokenKind.Punct && token.text === text;

const IDENT_START = /[\p{XID_Start}_]/u;
const IDENT_CONTINUE = /[\p{XID_Continue}]/u;
const NUMBER_CONTINUE = /[0-9A-Za-z_]/;
const SPACE = /\s/u;
/** String prefixes: raw ones read no escapes, `b`/`c` ones are not text the scan follows. */
const RAW_PREFIXES = new Set(["r", "br", "cr"]);
const BYTE_PREFIXES = new Set(["b", "c"]);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  "0": "\0",
  "'": "'",
  '"': '"',
};

/** Rust source as tokens, comments and whitespace dropped, character literals and lifetimes skipped. */
function lexRust(text: string): Token[] {
  const lexer: Lexer = { text, at: 0, tokens: [] };
  while (lexer.at < text.length) lexStep(lexer);
  return lexer.tokens;
}

interface Lexer {
  text: string;
  at: number;
  tokens: Token[];
}

function lexStep(lexer: Lexer): void {
  const { text, at } = lexer;
  const here = text[at] ?? "";
  if (SPACE.test(here)) lexer.at += 1;
  else if (text.startsWith("//", at)) lexer.at = lineEnd(text, at);
  else if (text.startsWith("/*", at)) lexer.at = blockCommentEnd(text, at);
  else if (here === '"') lexString(lexer, at, false);
  else if (here === "'") lexer.at = quoteEnd(text, at);
  else if (IDENT_START.test(here)) lexWord(lexer);
  else if (/[0-9]/.test(here)) lexer.at = numberEnd(text, at);
  else {
    lexer.tokens.push({ kind: TokenKind.Punct, text: here });
    lexer.at += 1;
  }
}

function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
}

/** Past a block comment, nested ones included. */
function blockCommentEnd(text: string, at: number): number {
  let depth = 0;
  let cursor = at;
  while (cursor < text.length) {
    if (text.startsWith("/*", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return cursor;
    } else cursor += 1;
  }
  return text.length;
}

/** Past a character literal (`'a'`, `'\''`, `'\u{1F600}'`), or past the quote of a lifetime or label. */
function quoteEnd(text: string, at: number): number {
  if (text[at + 1] === "\\") {
    const close = text.indexOf("'", at + 3);
    return close === -1 ? text.length : close + 1;
  }
  const point = text.codePointAt(at + 1);
  const width = point !== undefined && point > 0xffff ? 2 : 1;
  return text[at + 1 + width] === "'" ? at + 2 + width : at + 1;
}

function numberEnd(text: string, at: number): number {
  let cursor = at + 1;
  for (;;) {
    const here = text[cursor] ?? "";
    const fraction = here === "." && /[0-9]/.test(text[cursor + 1] ?? "");
    if (!NUMBER_CONTINUE.test(here) && !fraction) return cursor;
    cursor += 1;
  }
}

/** An identifier, a raw identifier (`r#name`, read as `name`), or the prefix of a string or byte literal. */
function lexWord(lexer: Lexer): void {
  const { text } = lexer;
  const start = lexer.at;
  let end = start + 1;
  while (end < text.length && IDENT_CONTINUE.test(text[end] ?? "")) end += 1;
  const word = text.slice(start, end);
  const next = text[end] ?? "";
  if (RAW_PREFIXES.has(word) && opensRawString(text, end)) lexRawString(lexer, end, word === "r");
  else if (word === "r" && next === "#" && IDENT_START.test(text[end + 1] ?? "")) {
    lexer.at = end + 1;
    lexWord(lexer);
  } else if (BYTE_PREFIXES.has(word) && next === '"') lexString(lexer, end, true);
  else if (word === "b" && next === "'") lexer.at = quoteEnd(text, end);
  else {
    lexer.tokens.push({ kind: TokenKind.Ident, text: word });
    lexer.at = end;
  }
}

/** Whether a raw string's hashes and quote start at `at` (`"`, `#"`, `##"`…). */
function opensRawString(text: string, at: number): boolean {
  return /^#*"/.test(text.slice(at, at + 256));
}

/** A raw string from its first `#` or quote: verbatim up to the quote and as many `#`s. */
function lexRawString(lexer: Lexer, at: number, textual: boolean): void {
  const hashes = /^#*/.exec(lexer.text.slice(at))?.[0] ?? "";
  const open = at + hashes.length + 1;
  const close = lexer.text.indexOf(`"${hashes}`, open);
  const end = close === -1 ? lexer.text.length : close;
  lexer.tokens.push({ kind: TokenKind.Str, value: textual ? lexer.text.slice(open, end) : null });
  lexer.at = close === -1 ? end : end + 1 + hashes.length;
}

/** A quoted string from its opening quote, its escapes decoded (`opaque` for byte and C strings). */
function lexString(lexer: Lexer, quote: number, opaque: boolean): void {
  const { text } = lexer;
  let value: string | null = "";
  let cursor = quote + 1;
  while (cursor < text.length && text[cursor] !== '"') {
    if (text[cursor] !== "\\") {
      value = value === null ? null : value + text[cursor];
      cursor += 1;
      continue;
    }
    const decoded = decodeEscape(text, cursor);
    value = value === null || decoded.text === null ? null : value + decoded.text;
    cursor = decoded.end;
  }
  lexer.tokens.push({ kind: TokenKind.Str, value: opaque ? null : value });
  lexer.at = cursor + 1;
}

/** The escape at `at` (a backslash): its text (null when the scan does not decode it) and where it ends. */
function decodeEscape(text: string, at: number): { text: string | null; end: number } {
  const letter = text[at + 1] ?? "";
  const simple = SIMPLE_ESCAPES[letter];
  if (simple !== undefined) return { text: simple, end: at + 2 };
  if (letter === "\n" || letter === "\r") {
    let end = at + 1;
    while (SPACE.test(text[end] ?? "")) end += 1;
    return { text: "", end };
  }
  if (letter === "x") return decodeAscii(text, at);
  return decodeUnicode(text, at);
}

/** `\x##`, at most `\x7F`. */
function decodeAscii(text: string, at: number): { text: string | null; end: number } {
  const hex = text.slice(at + 2, at + 4);
  const valid = /^[0-7][0-9A-Fa-f]$/.test(hex);
  return { text: valid ? String.fromCharCode(Number.parseInt(hex, 16)) : null, end: at + 4 };
}

/** `\u{…}`: a Unicode scalar value; anything else at a backslash is an escape the scan does not decode. */
function decodeUnicode(text: string, at: number): { text: string | null; end: number } {
  const unicode = /^u\{([0-9A-Fa-f_]{1,8})\}/.exec(text.slice(at + 1));
  if (unicode?.[1] === undefined) return { text: null, end: at + 2 };
  const point = Number.parseInt(unicode[1].replaceAll("_", ""), 16);
  const valid = point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
  return { text: valid ? String.fromCodePoint(point) : null, end: at + 1 + unicode[0].length };
}
