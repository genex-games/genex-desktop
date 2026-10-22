/**
 * The Rust build lane's bake step (game systems NAV-14b): the outputs of the bakes a game registers
 * (`game.nav_bake`, kind `nav`; `game.impostor_bake`, kind `impostor`: one RGBA8 KTX2 atlas per
 * model and device-class row, LOD-23), made once per input at build time and served from the
 * build's stage, never the game folder (owner call C3).
 *
 * A bake's input is everything a game could read while baking: its staged sources and assets
 * (`bakeInputDigest`, before the import step rewrites any asset for a destination, without the
 * host-written manifest and lock) and the toolchain lock it builds on. That digest keys the
 * profile's bake cache, `<cache>/<digest>/` with a `bakes.json` manifest and one file per bake, so
 * every destination of one game at one input (the web and an export included, which cannot bake)
 * takes the same bytes a dev build made.
 *
 * - `placeCachedBakes` copies a whole cache entry into `<out>/assets/baked/<kind>/<name>`, every
 *   file checked against its sha256 first; any mismatch is a miss and nothing is placed.
 * - `bakeInSession`, after a dev build's admission: a cache hit spawns nothing. On a miss a game
 *   whose staged sources register no bake records an empty entry and spawns nothing either; one
 *   that may register one gets a sandboxed headless session (`open`, the caller's), which is sent
 *   `bakeAssets {kind, name}` for each bake its `ready` receipt advertises. The game writes the
 *   output into its run's `state/bakes/<kind>/<name>`; the host reads it without following a link,
 *   checks its size and FNV-1a 64 against the reply, then writes it atomically into the cache and
 *   the stage. An entry is recorded only when every advertised bake came through, so a refused one
 *   is asked for again by the next build.
 *
 * Every name is checked by `isBakeName` (one path segment, never a dot) and every folder written
 * or read below the stage, the cache and the run's state must be a real folder: a hostile name or a
 * linked folder refuses that bake with nothing written. A bake that fails never fails the build:
 * the game's `NavMesh::from_bytes_for` bakes again at reset when no output, or a stale one, is there,
 * and an impostor whose atlas is missing or stale bakes on the GPU at runtime (a streamed one keeps
 * its coarsest mesh, `impostor-not-baked`).
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ASSET_LOCK_VERSION, type AssetLock, type AssetLockDerived } from "../shared/asset-db.ts";
import type { BuildTarget } from "../shared/game-project.ts";
import {
  BakeKind,
  isBakeName,
  isNativeBakeRef,
  NATIVE_BAKE_MAX_BYTES,
  type NativeBakeRef,
  NativeOp,
  NativeRunMode,
} from "../shared/native-contract.ts";
import type { ToolchainLock } from "../shared/toolchain.ts";
import { atomicWriteFile, atomicWriteText, ensureDirBelow, openNoFollow, readRegularFile } from "../substrate/fsx.ts";
import { type AdmittedOutputFile, RunDirLayout } from "../substrate/native-bundle.ts";
import { fnv1a64Hex, NativeOpRefusedError } from "../substrate/native-game-port.ts";
import { AssetLockState, readAssetLock, withDerived, writeAssetLock } from "./asset-db.ts";

/** The folder under the stage's `assets/` the bakes go to: `assets/baked/<kind>/<name>`. */
export const BAKED_ASSETS_FOLDER = "baked";
/** The bake cache's folder in the profile's import cache (`layout.assetCache`). */
export const BAKE_CACHE_FOLDER = "bakes";
/** The cache entry's manifest file. */
const MANIFEST_FILE = "bakes.json";
/** The cache entry format; another version is a miss. */
const BAKE_CACHE_VERSION = 1;
/** The most bytes a cache manifest may hold. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** The most bytes one staged source file is read for a bake registration. */
const SOURCE_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/** The cache entries kept per project; older ones go when a new one is written. */
const BAKE_CACHE_ENTRIES_MAX = 8;
/** One read's chunk while a staged file is hashed. */
const HASH_CHUNK_BYTES = 1024 * 1024;
/** The staged files the host writes per build (the manifest and lock differ by flavour and destination). */
const HOST_WRITTEN = new Set(["Cargo.toml", "Cargo.lock"]);
/** The staged source folder the registration scan reads. */
const SOURCE_FOLDER = "src";
/** A Rust source file. */
const RUST_SOURCE = /\.rs$/;
/** A cache entry's folder name: the input digest. */
const INPUT_DIGEST = /^[0-9a-f]{64}$/;
/** A sha256 in lowercase hex. */
const SHA256 = /^[0-9a-f]{64}$/;
/** An FNV-1a 64 digest in lowercase hex. */
const FNV64 = /^[0-9a-f]{16}$/;
/** The run's state folder for bakes, as genex-studio writes it: `<state>/bakes/<kind>/<name>`. */
const STATE_BAKES_FOLDER = "bakes";
/** Hex characters of a project's cache folder name (a sha256 prefix: never the name itself). */
const PROJECT_FOLDER_HEX = 32;

/**
 * The call a game's source makes to register a bake of each kind; a game whose staged `src/`
 * names none of them is not started to ask. A prefilter only: a game the scan misses bakes at reset.
 */
const BAKE_REGISTRATIONS = {
  [BakeKind.Nav]: "nav_bake",
  [BakeKind.Impostor]: "impostor_bake",
} as const satisfies Record<BakeKind, string>;

/** Where a run's bakes came from. Wire values: never rename one. */
export const BakeSource = {
  /** The profile's cache held the input's entry: nothing was started. */
  Cache: "cache",
  /** A headless session baked them. */
  Session: "session",
  /** Nothing to bake: the game registers none, or no session could be opened. */
  None: "none",
} as const;
export type BakeSource = (typeof BakeSource)[keyof typeof BakeSource];

/** Why the host refused one bake (beside the game's own codes, kept as it answered them). Wire values: never rename one. */
export const BakeRefusal = {
  /** The receipt named a kind or name that is not a bake's: nothing was asked or written. */
  UnsafeName: "unsafe-bake-name",
  /** A folder on the way to the output (stage, cache or run state) is a link or not a folder. */
  UnsafeFolder: "unsafe-bake-folder",
  /** The game's reply was not about the bake asked, or out of shape. */
  ReplyInvalid: "bake-reply-invalid",
  /** The output file is missing, a link, not a regular file or past the cap. */
  OutputUnreadable: "bake-output-unreadable",
  /** The output's size or digest is not the reply's. */
  OutputMismatch: "bake-output-mismatch",
  /** The session could not be opened, or ended before it answered. */
  SessionFailed: "bake-session-failed",
} as const;
export type BakeRefusal = (typeof BakeRefusal)[keyof typeof BakeRefusal];

/** One bake placed in the stage: its kind and name, and the bytes' sha256, size and FNV-1a 64. */
export interface BakedOutput {
  kind: BakeKind;
  name: string;
  sha256: string;
  bytes: number;
  digest: string;
}

/** One bake refused: the kind and name as the receipt sent them (cut to a line), and why. */
export interface BakeRefused {
  kind: string;
  name: string;
  /** A {@link BakeRefusal}, or the game's own code (`unknown-bake`, `bake-too-large`, a `nav-*` code). */
  code: string;
}

/** What a bake step did. */
export interface BakeRunReport {
  source: BakeSource;
  /** The input digest the outputs were made from. */
  input: string;
  baked: BakedOutput[];
  refused: BakeRefused[];
  /** Whether a session was opened. */
  spawned: boolean;
}

/** A sandboxed headless session of an admitted dev build, opened for its bakes. */
export interface BakeSession {
  /** The bakes its `ready` receipt advertises, as the game sent them (each is checked here). */
  readonly bakes: readonly unknown[];
  /** The run's `state/` folder: the game writes `bakes/<kind>/<name>` into it. */
  readonly state: string;
  /** Sends `bakeAssets` for one bake: the reply, or a rejection (`NativeOpRefusedError` carries the game's code). */
  bake(ref: NativeBakeRef): Promise<unknown>;
  /** Ends the session; called once, whatever happened. */
  close(): Promise<void>;
}

/** The admitted dev build a bake session is opened on: the lane's build in flight, never built again. */
export interface BakeRun {
  project: string;
  target: BuildTarget;
  /** The admitted `<bin>.out`. */
  out: string;
  /** The toolchain lock it was built on. */
  lock: ToolchainLock;
  /** The digests the lane admitted `out` with (its receipt's `outputs`), which the run is assembled from. */
  outputs: readonly AdmittedOutputFile[];
  signal: AbortSignal;
}

/** What the build lane hands the bake step (`RustBuildsOptions.bakes`). */
export interface RustBakeOptions {
  /** The project's folder in the profile's bake cache (`<cache>/<digest>/` below it; see {@link bakeCacheFolder}). */
  cache: (project: string) => string;
  /** Opens a sandboxed headless session of the admitted dev build in `out`; absent: cached bakes only. */
  open?: (run: BakeRun) => Promise<BakeSession>;
  /** Whether `open` serves a dev build for `target` (default: every one); another takes cached bakes only. */
  opensFor?: (target: BuildTarget) => boolean;
}

/**
 * The native run registry as the bake step starts a run (`NativeRunsHost`, `core/native-runs.ts`):
 * a headless run of a `prebuilt` output, which its prepare admits and assembles without asking the
 * build lane (the build in flight is the one asking), and its stop.
 */
export interface BakeRuns {
  start(request: {
    project: string;
    target: BuildTarget;
    mode: typeof NativeRunMode.Headless;
    prebuilt: { output: string; lock: ToolchainLock; admittedFiles: readonly AdmittedOutputFile[] };
    signal: AbortSignal;
  }): Promise<{
    status: { runId: string; receipt?: { bakes?: readonly unknown[] } | null };
    port: { call(op: typeof NativeOp.BakeAssets, arg: NativeBakeRef): Promise<unknown> };
  }>;
  stop(runId: string): Promise<void>;
}

/** The bake step's sessions over the native run registry: what the core hands `RustBakeOptions`. */
export interface NativeBakeSessions {
  open: (run: BakeRun) => Promise<BakeSession>;
  opensFor: (target: BuildTarget) => boolean;
}

/**
 * Bake sessions as headless runs of the admitted dev build (`runs`, under the game profile's
 * sandbox like an agent's run), each in `runsRoot/<runId>/state/`, for the destinations in
 * `targets` (those with a headless run lane on this host: the Mac's).
 */
export function nativeBakeSessions(options: {
  runs: () => BakeRuns;
  runsRoot: string;
  targets: readonly BuildTarget[];
}): NativeBakeSessions {
  const open = async (run: BakeRun): Promise<BakeSession> => {
    const runs = options.runs();
    const prebuilt = { output: run.out, lock: run.lock, admittedFiles: run.outputs };
    const request = { project: run.project, target: run.target, mode: NativeRunMode.Headless, prebuilt };
    const started = await runs.start({ ...request, signal: run.signal });
    const { runId, receipt } = started.status;
    let closing: Promise<void> | null = null;
    return {
      bakes: receipt?.bakes ?? [],
      state: path.join(options.runsRoot, runId, RunDirLayout.State),
      bake: (ref) => started.port.call(NativeOp.BakeAssets, ref),
      close: () => {
        closing ??= runs.stop(runId);
        return closing;
      },
    };
  };
  return { open, opensFor: (target) => options.targets.includes(target) };
}

/**
 * A project's folder in the profile's bake cache, `<assetCache>/bakes/<digest of the project>`: the
 * import cache's host-owned folder (never writable by an agent process), whose sweep skips it.
 */
export function bakeCacheFolder(assetCache: string, project: string): string {
  const folder = createHash("sha256").update(project).digest("hex").slice(0, PROJECT_FOLDER_HEX);
  return path.join(assetCache, BAKE_CACHE_FOLDER, folder);
}

/** What `bakeInSession` reads. */
export interface BakeRunRequest {
  /** The build's admitted `<bin>.out`. */
  out: string;
  /** The build's stage (`<bin>.stage`), read for bake registrations. */
  stage: string;
  /** {@link bakeInputDigest} of the stage. */
  input: string;
  /** The project's cache folder. */
  cache: string;
  /** Opens the session. */
  open: () => Promise<BakeSession>;
  signal?: AbortSignal;
}

/** One cache manifest row. */
interface ManifestRow extends BakedOutput {}

/**
 * The digest of everything a bake may read: each regular file of the stage but the host-written
 * manifest and lock, by `/`-separated path and sha256, and the toolchain lock's digest. Links are
 * skipped (the stage has none).
 */
export async function bakeInputDigest(stage: string, lockDigest: string): Promise<string> {
  const lines: string[] = [];
  for (const rel of await regularFiles(stage)) {
    if (HOST_WRITTEN.has(rel)) continue;
    lines.push(`${rel}\t${await hashFile(path.join(stage, ...rel.split("/")))}`);
  }
  const body = [`genex-bake-input ${BAKE_CACHE_VERSION}`, lockDigest, ...lines.sort()].join("\n");
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The cache entry for `input` placed into `<out>/assets/baked/`: the report, or null on a miss (no
 * entry, an entry out of shape, a file whose bytes are not its row's, a linked folder), with
 * nothing placed.
 */
export async function placeCachedBakes(out: string, cache: string, input: string): Promise<BakeRunReport | null> {
  const entry = await cachedEntry(cache, input);
  if (!entry) return null;
  try {
    for (const { row, bytes } of entry) await writeStaged(out, row.kind, row.name, bytes);
  } catch {
    await rm(path.join(out, "assets", BAKED_ASSETS_FOLDER), { recursive: true, force: true }).catch(() => {});
    return null;
  }
  const baked = entry.map(({ row }) => row);
  return { source: BakeSource.Cache, input, baked, refused: [], spawned: false };
}

/**
 * A dev build's bakes: the cache's entry when it holds one; otherwise each advertised bake run in
 * a headless session and written into the cache and the stage (see the module comment).
 */
export async function bakeInSession(request: BakeRunRequest): Promise<BakeRunReport> {
  const { out, cache, input } = request;
  const cached = await placeCachedBakes(out, cache, input);
  if (cached) return cached;
  const none: BakeRunReport = { source: BakeSource.None, input, baked: [], refused: [], spawned: false };
  if (!(await registersBakes(request.stage))) {
    await recordEntry(cache, input, []).catch(() => {});
    return none;
  }
  if (request.signal?.aborted) return none;
  const session = await request.open().catch(() => null);
  if (!session) return { ...none, spawned: true, refused: [{ kind: "", name: "", code: BakeRefusal.SessionFailed }] };
  const report: BakeRunReport = { ...none, source: BakeSource.Session, spawned: true };
  try {
    for (const raw of session.bakes) {
      if (request.signal?.aborted) break;
      const result = await bakeOne(session, raw, request);
      if ("code" in result) report.refused.push(result);
      else report.baked.push(result);
    }
  } finally {
    await session.close().catch(() => {});
  }
  const whole = report.refused.length === 0 && !request.signal?.aborted;
  if (whole) await recordEntry(cache, input, report.baked).catch(() => {});
  return report;
}

/**
 * Records `baked` as lock `derived` rows of the game's `genex-assets.lock` (C-4's `withDerived`),
 * each from every source entry with the input digest as its params; written only when the lock
 * reads as trusted and changed. True when it wrote.
 */
export async function recordBakesInLock(
  gameDir: string,
  baked: readonly BakedOutput[],
  input: string,
): Promise<boolean> {
  if (baked.length === 0) return false;
  const read = await readAssetLock(gameDir);
  if (read.state !== AssetLockState.Trusted) return false;
  const inputs = read.entries.map((entry) => entry.id);
  let lock: AssetLock = { version: ASSET_LOCK_VERSION, entries: read.entries, derived: read.derived };
  for (const { kind, name, sha256, bytes } of baked) {
    const row: AssetLockDerived = { kind, name, inputs, params: input, sha256, bytes };
    lock = withDerived(lock, row);
  }
  return await writeAssetLock(gameDir, lock, read.text);
}

/** One advertised bake asked for, read back and written: the output, or why it was refused. */
async function bakeOne(
  session: BakeSession,
  raw: unknown,
  request: BakeRunRequest,
): Promise<BakedOutput | BakeRefused> {
  if (!isNativeBakeRef(raw)) return refusedOf(raw, BakeRefusal.UnsafeName);
  const ref: NativeBakeRef = { kind: raw.kind, name: raw.name };
  const refuse = (code: string): BakeRefused => ({ kind: ref.kind, name: ref.name, code });
  if (!(await stagedFolderIsReal(request.out, ref.kind))) return refuse(BakeRefusal.UnsafeFolder);
  let reply: unknown;
  try {
    reply = await session.bake(ref);
  } catch (error) {
    return refuse(error instanceof NativeOpRefusedError ? error.gameError : BakeRefusal.SessionFailed);
  }
  if (!isReplyFor(reply, ref)) return refuse(BakeRefusal.ReplyInvalid);
  const bytes = await readStateOutput(session.state, ref);
  if (bytes === null) return refuse(BakeRefusal.OutputUnreadable);
  if (bytes.length !== reply.bytes || fnv1a64Hex(bytes) !== reply.digest) return refuse(BakeRefusal.OutputMismatch);
  const output: BakedOutput = { ...ref, sha256: sha256Of(bytes), bytes: bytes.length, digest: reply.digest };
  try {
    await writeCached(request.cache, request.input, ref, bytes);
    await writeStaged(request.out, ref.kind, ref.name, bytes);
  } catch {
    return refuse(BakeRefusal.UnsafeFolder);
  }
  return output;
}

/** A refusal naming what the receipt sent, cut to a line. */
function refusedOf(raw: unknown, code: BakeRefusal): BakeRefused {
  const field = (key: string) => {
    const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value.slice(0, 80) : "";
  };
  return { kind: field("kind"), name: field("name"), code };
}

/** Whether `reply` is a `bakeAssets` answer about `ref`: its kind and name, a size within the cap and a digest. */
function isReplyFor(reply: unknown, ref: NativeBakeRef): reply is { bytes: number; digest: string } {
  if (reply === null || typeof reply !== "object") return false;
  const { kind, name, bytes, digest } = reply as Record<string, unknown>;
  const sized = Number.isSafeInteger(bytes) && Number(bytes) >= 0 && Number(bytes) <= NATIVE_BAKE_MAX_BYTES;
  const about = kind === ref.kind && name === ref.name;
  return about && sized && typeof digest === "string" && FNV64.test(digest);
}

/** The game's output in `<state>/bakes/<kind>/<name>`, every folder a real one and the file never a link; null otherwise. */
async function readStateOutput(state: string, ref: NativeBakeRef): Promise<Buffer | null> {
  const folder = await realFolderBelow(state, [STATE_BAKES_FOLDER, ref.kind]);
  if (!folder) return null;
  return await readRegularFile(path.join(folder, ref.name), NATIVE_BAKE_MAX_BYTES).catch(() => null);
}

/** Whether the stage's bake folder for `kind`, as far as it exists, is made of real folders only. */
async function stagedFolderIsReal(out: string, kind: BakeKind): Promise<boolean> {
  let current = out;
  for (const part of ["assets", BAKED_ASSETS_FOLDER, kind]) {
    current = path.join(current, part);
    const found = await lstat(current).catch(() => null);
    if (!found) return true;
    if (!found.isDirectory()) return false;
  }
  return true;
}

/** `root/parts…` when each is a real folder (never a link) and it resolves inside `root`; null otherwise. */
async function realFolderBelow(root: string, parts: readonly string[]): Promise<string | null> {
  const base = await realpath(root).catch(() => null);
  if (!base) return null;
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!(await lstat(current).catch(() => null))?.isDirectory()) return null;
  }
  return (await realpath(current).catch(() => null)) === current ? current : null;
}

/** Writes one output into `<out>/assets/baked/<kind>/<name>` atomically; throws on a hostile name or a linked folder. */
async function writeStaged(out: string, kind: BakeKind, name: string, bytes: Uint8Array): Promise<void> {
  if (!isBakeName(name) || !Object.values(BakeKind).includes(kind)) throw new Error(BakeRefusal.UnsafeName);
  const folder = await ensureDirBelow(out, ["assets", BAKED_ASSETS_FOLDER, kind]);
  await atomicWriteFile(path.join(folder, name), bytes);
}

/** Writes one output into the cache entry `<cache>/<input>/<kind>/<name>` atomically. */
async function writeCached(cache: string, input: string, ref: NativeBakeRef, bytes: Uint8Array): Promise<void> {
  await mkdir(cache, { recursive: true });
  const folder = await ensureDirBelow(cache, [input, ref.kind]);
  await atomicWriteFile(path.join(folder, ref.name), bytes);
}

/** Writes the entry's manifest (the entry is whole from then on), then lets the oldest entries go. */
async function recordEntry(cache: string, input: string, baked: readonly BakedOutput[]): Promise<void> {
  await mkdir(cache, { recursive: true });
  const folder = await ensureDirBelow(cache, [input]);
  const manifest = { version: BAKE_CACHE_VERSION, input, bakes: baked };
  await atomicWriteText(path.join(folder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await pruneCache(cache, input);
}

/** The cache entry for `input`, every file read and checked against its row; null on any miss. */
async function cachedEntry(cache: string, input: string): Promise<Array<{ row: ManifestRow; bytes: Buffer }> | null> {
  if (!INPUT_DIGEST.test(input)) return null;
  const folder = await realFolderBelow(cache, [input]);
  if (!folder) return null;
  const text = await readRegularFile(path.join(folder, MANIFEST_FILE), MANIFEST_MAX_BYTES).catch(() => null);
  const rows = text ? manifestRows(text.toString("utf8"), input) : null;
  if (!rows) return null;
  const entry: Array<{ row: ManifestRow; bytes: Buffer }> = [];
  for (const row of rows) {
    const kindFolder = await realFolderBelow(folder, [row.kind]);
    const bytes = kindFolder
      ? await readRegularFile(path.join(kindFolder, row.name), NATIVE_BAKE_MAX_BYTES).catch(() => null)
      : null;
    if (!bytes || bytes.length !== row.bytes || sha256Of(bytes) !== row.sha256) return null;
    entry.push({ row, bytes });
  }
  return entry;
}

/** A manifest's rows for `input`, each checked; null when the manifest is out of shape. */
function manifestRows(text: string, input: string): ManifestRow[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const { version, input: named, bakes } = raw as Record<string, unknown>;
  if (version !== BAKE_CACHE_VERSION || named !== input || !Array.isArray(bakes)) return null;
  const rows = bakes.filter(isManifestRow);
  return rows.length === bakes.length
    ? rows.map(({ kind, name, sha256, bytes, digest }) => ({ kind, name, sha256, bytes, digest }))
    : null;
}

function isManifestRow(value: unknown): value is ManifestRow {
  if (!isNativeBakeRef(value)) return false;
  const { sha256, bytes, digest } = value as unknown as Record<string, unknown>;
  const sized = Number.isSafeInteger(bytes) && Number(bytes) >= 0 && Number(bytes) <= NATIVE_BAKE_MAX_BYTES;
  return sized && typeof sha256 === "string" && SHA256.test(sha256) && typeof digest === "string" && FNV64.test(digest);
}

/** Keeps the newest {@link BAKE_CACHE_ENTRIES_MAX} entries (by their manifest's time) and `keep`. */
async function pruneCache(cache: string, keep: string): Promise<void> {
  const entries: Array<{ name: string; at: number }> = [];
  for (const name of await readdir(cache).catch(() => [] as string[])) {
    if (!INPUT_DIGEST.test(name) || name === keep) continue;
    const at = (await stat(path.join(cache, name, MANIFEST_FILE)).catch(() => null))?.mtimeMs ?? 0;
    entries.push({ name, at });
  }
  entries.sort((a, b) => b.at - a.at);
  for (const { name } of entries.slice(BAKE_CACHE_ENTRIES_MAX - 1))
    await rm(path.join(cache, name), { recursive: true, force: true });
}

/** Whether a staged `src/**.rs` names a bake registration call ({@link BAKE_REGISTRATIONS}). */
async function registersBakes(stage: string): Promise<boolean> {
  const calls = Object.values(BAKE_REGISTRATIONS);
  for (const rel of await regularFiles(path.join(stage, SOURCE_FOLDER))) {
    if (!RUST_SOURCE.test(rel)) continue;
    const bytes = await readRegularFile(
      path.join(stage, SOURCE_FOLDER, ...rel.split("/")),
      SOURCE_SCAN_MAX_BYTES,
    ).catch(() => null);
    // A file past the cap is read as one that may register a bake: the scan only ever saves a start.
    if (bytes === null) return true;
    const text = bytes.toString("utf8");
    if (calls.some((call) => text.includes(call))) return true;
  }
  return false;
}

/** Every regular file below `dir`, `/`-separated and sorted; links and anything else are left out. */
async function regularFiles(dir: string, rel = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await regularFiles(dir, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

/** The sha256 of one file, read in chunks without following a link at its name. */
async function hashFile(file: string): Promise<string> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
