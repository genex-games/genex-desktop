/**
 * Eject (extension ladder level 5): the person copies the genex crates of a Rust game's lock line
 * into its `engine/` as a game-owned fork, or gives the store engine back. Person-initiated only,
 * through `studio:engine.eject` and `studio:engine.uneject`; no harness method reaches it (an
 * agent can only suggest it in chat).
 *
 * An eject reads the vendored crates of the game's own lock line (the lock it recorded, kept by
 * retention; the current lock for a game never built), holds each forked crate
 * (`RUST_ENGINE_CRATES`) to cargo's own digest manifest (`.cargo-checksum.json`: every file
 * listed, none missing, none added, each sha256 equal, no link), copies it byte for byte into
 * `engine/<crate>/` beside a digest manifest of what was copied (`engine/genex-engine.json`,
 * `engine-updates: manual`), writes `[engine] ejected_from` into `genex.toml` and records the eject
 * in the profile (`<userData>/engine-ejects.json`, keyed by the game's library folder identity like
 * the trust flag). The profile record is what makes a game ejected: the build links a fork only
 * where the row and the record agree (`rust-stage.ts` refuses `engine-unrecorded` otherwise, so an
 * agent writing the row and an `engine/` itself builds nothing), and the conformance gate asks the
 * record, never the game's files. From then on lock bumps never touch the fork, and Live, capture
 * and export need a green conformance run on the current build (`core/game-conformance-gate.ts`).
 * The suite judges a Mac build, so eject is offered only on a Mac for a game naming macOS
 * (`eject-needs-mac`). The copy is made in the host's scratch folder, outside every root an agent
 * may write, and renamed into the game whole. A refused eject writes nothing.
 *
 * Un-eject takes a game snapshot first (the fork is in the game's history), then removes the
 * `[engine]` row, `engine/` and the profile record: the game builds on the store's engine again.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData } from "../shared/custom-events.ts";
import { SnapshotScope } from "../shared/event-log.ts";
import { type EngineEjectAnswer, type EngineEjectedPayload, ExtensionRefusal } from "../shared/game-conformance.ts";
import { GameStack, stackOf } from "../shared/game-project.ts";
import { ToolchainId, type ToolchainLock } from "../shared/toolchain.ts";
import { AsyncLock, atomicWriteJson, atomicWriteText, isJsonObject, readRegularFile } from "../substrate/fsx.ts";
import { GENEX_MANIFEST } from "../substrate/project-shape.ts";
import { parseGenexToml, RUST_ENGINE_FOLDER, withEngineRow } from "../substrate/genex-toml.ts";
import { locateComponents } from "../substrate/toolchain-store/locate.ts";
import { readCurrentLock, readRecordedLock } from "../substrate/toolchain-store/lock.ts";
import { stackOfLock } from "../substrate/toolchain-store/retention.ts";
import { RUST_VENDOR_LAYOUT } from "../substrate/toolchain-store/rust-locate.ts";
import { BuildTarget, destinationsOf } from "../shared/game-project.ts";
import { hostOf, hostTarget } from "../shared/game-targets.ts";
import { genexReleaseOfLock, rustPayloadDir, shippedGenexRelease } from "./core/rust-lane.ts";
import { RUST_ENGINE_CRATES } from "./rust-manifest.ts";
import { type FolderIdentity, identityOf, sameFolder } from "./rust-trust.ts";
import type { StudioCore } from "./studio-core.ts";

/** Whether a game's engine follows the store's lock line or only what is in its folder. Wire values. */
export const EngineUpdates = {
  /** The store's engine: a lock bump or an app update brings the genex release it pins. */
  Automatic: "automatic",
  /** An ejected engine: nothing updates it but an edit in `engine/` (or an un-eject). */
  Manual: "manual",
} as const;
export type EngineUpdates = (typeof EngineUpdates)[keyof typeof EngineUpdates];

/** The digest manifest an eject writes into `engine/`: what was copied, from which release and lock. */
export const ENGINE_MANIFEST_FILE = "genex-engine.json";
/** The profile file the person's ejects live in, under userData (never in a game). */
export const ENGINE_EJECTS_FILE = "engine-ejects.json";
const EJECTS_SCHEMA = 1;
/** The most of the profile's eject records the host reads. */
const EJECTS_FILE_MAX_BYTES = 1024 * 1024;
/** A genex release as the `[engine]` row and the records carry it. */
const RELEASE = /^\d+\.\d+\.\d+$/;
/** cargo's own digest manifest of a vendored crate. */
const CARGO_CHECKSUM_FILE = ".cargo-checksum.json";
/**
 * The copy in progress, made in the host's scratch folder and renamed into `engine/` once whole;
 * only where the game sits on another volume is it made inside the game (a dotfile: never staged
 * or exported).
 */
const PART_PREFIX = ".engine.genex-part-";
const ENGINE_MANIFEST_SCHEMA = 1;
/** The most of one vendored file an eject copies. */
const ENGINE_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** The most of a crate's `.cargo-checksum.json` an eject reads. */
const CHECKSUM_MAX_BYTES = 4 * 1024 * 1024;
/** The most of a `genex.toml` an eject edits (the parser's own cap). */
const GENEX_TOML_MAX_BYTES = 64 * 1024;
/** The most files one forked crate may hold. */
const CRATE_MAX_FILES = 8192;
const SHA256 = /^[0-9a-f]{64}$/;
/** The facade: an eject without it in the lock line has nothing to fork. */
const FACADE = "genex";

const MESSAGE = {
  notRust: (project: string) =>
    `${project} is not a Rust · wgpu game in the library: only a Rust game has an engine to eject`,
  snapshotReason: "Before giving the store engine back",
  uneditable: (project: string) => `${project}: ${GENEX_MANIFEST} is not one the host can read and edit`,
} as const;

/** One forked crate as the digest manifest records it. */
export interface EngineManifestCrate {
  name: string;
  version: string;
  /** Crate-relative `/` paths to sha256, `.cargo-checksum.json` included: the bytes copied. */
  files: Record<string, string>;
}

/** `engine/genex-engine.json`. */
export interface EngineManifest {
  schema: typeof ENGINE_MANIFEST_SCHEMA;
  ejectedFrom: string;
  /** The lock digest whose vendored crates were copied, or null when the line named none. */
  lock: string | null;
  engineUpdates: typeof EngineUpdates.Manual;
  crates: EngineManifestCrate[];
}

/** The engine actions the person's window reaches (`main/ipc/engine.ts`). */
export interface EngineEjectService {
  eject(project: string): Promise<EngineEjectAnswer>;
  uneject(project: string): Promise<EngineEjectAnswer>;
}

/** A game's lock line as an eject reads it: its vendored crate set and the genex release that set holds. */
export interface EngineLockLine {
  vendor: string;
  genexVersion: string;
  /** The lock digest, for the digest manifest. */
  lock: string | null;
}

/** The person's ejects as the profile keeps them: what the build lane and the conformance gate believe. */
export interface EngineEjections {
  /** The release the person ejected `project`'s engine from, while its library folder is the one ejected; null otherwise. */
  ejectedFrom(project: string): Promise<string | null>;
  /** Records the person's eject of `project` from its library folder `dir`, or with null clears it. */
  set(project: string, dir: string, ejectedFrom: string | null): Promise<void>;
}

/** What an eject reaches: the game, its lock line, game snapshots and the event log. */
export interface EngineEjectDeps {
  /** The Rust game's folder, or null when the library holds no Rust game by that name. */
  rustGame(project: string): Promise<{ dir: string } | null>;
  /** Whether this host can judge the game's ejected engine: a Mac, and macOS among the game's destinations. */
  judgeable(project: string): Promise<boolean>;
  /** The profile's eject records. */
  ejections: EngineEjections;
  /** A host-owned folder outside every root an agent may write, where the copy is made. */
  scratch: string;
  /** The game's own lock line, or null when the store no longer holds it (swept) or holds none. */
  lockLine(project: string): Promise<EngineLockLine | null>;
  /** Takes a game snapshot; answers its id. Throws when it could not be taken. */
  snapshot(project: string, reason: string): Promise<string>;
  /** Records the `engine_ejected` event. */
  record(payload: EngineEjectedPayload): Promise<void>;
}

/** What an eject or un-eject answers when nothing was written: the typed refusal. */
const refused = (project: string, refusal: ExtensionRefusal): EngineEjectAnswer => ({
  project,
  ok: false,
  refusal,
  ejectedFrom: null,
});

const done = (project: string, ejectedFrom: string | null): EngineEjectAnswer => ({
  project,
  ok: true,
  refusal: null,
  ejectedFrom,
});

/** A vendored crate checked against its digest manifest: every file and its sha256. */
type VerifiedCrate = { ok: true; name: string; folder: string; files: Map<string, string> } | { ok: false };

/** The eject service over `deps`: one engine action at a time per game. */
export function createEngineEject(deps: EngineEjectDeps): EngineEjectService {
  const locks = new Map<string, AsyncLock>();
  const serial = <T>(project: string, run: () => Promise<T>): Promise<T> => {
    const lock = locks.get(project) ?? new AsyncLock();
    locks.set(project, lock);
    return lock.run(run);
  };
  return {
    eject: (project) => serial(project, () => eject(deps, project)),
    uneject: (project) => serial(project, () => uneject(deps, project)),
  };
}

/** The game's real folder; throws for a project that is not a Rust game in the library. */
async function rustGameDir(deps: EngineEjectDeps, project: string): Promise<string> {
  const game = await deps.rustGame(project);
  if (game === null) throw new Error(MESSAGE.notRust(project));
  return realpath(game.dir);
}

/** The game's `genex.toml` text, or null when it is not a plain file the host can read. */
async function genexTomlText(dir: string): Promise<string | null> {
  const bytes = await readRegularFile(path.join(dir, GENEX_MANIFEST), GENEX_TOML_MAX_BYTES).catch(() => null);
  return bytes === null ? null : bytes.toString("utf8");
}

async function eject(deps: EngineEjectDeps, project: string): Promise<EngineEjectAnswer> {
  const dir = await rustGameDir(deps, project);
  if (!(await deps.judgeable(project))) return refused(project, ExtensionRefusal.EjectNeedsMac);
  const engine = path.join(dir, RUST_ENGINE_FOLDER);
  const present = await lstat(engine).catch(() => null);
  if (present !== null) return refused(project, ExtensionRefusal.EjectTargetExists);
  const text = await genexTomlText(dir);
  const parsed = text === null ? null : parseGenexToml(text);
  if (text === null || !parsed?.ok) throw new Error(MESSAGE.uneditable(project));
  if (parsed.manifest.engine) return refused(project, ExtensionRefusal.EjectTargetExists);
  const line = await deps.lockLine(project);
  if (line === null) return refused(project, ExtensionRefusal.EjectLockMissing);
  // The game's build input with the host's row, worked out before anything is written.
  const edited = withEngineRow(text, line.genexVersion);
  if (!edited.ok) throw new Error(MESSAGE.uneditable(project));
  const crates = await lockLineCrates(line);
  if (!crates.ok) return refused(project, crates.refusal);
  const copied = await copyFork(deps.scratch, crates.crates, line, engine);
  if (copied !== null) return refused(project, copied);
  try {
    await atomicWriteText(path.join(dir, GENEX_MANIFEST), edited.text);
    await deps.ejections.set(project, dir, line.genexVersion);
  } catch (error) {
    // No fork without its row and the person's record: the game stays on the store's engine.
    await atomicWriteText(path.join(dir, GENEX_MANIFEST), text).catch(() => {});
    await rm(engine, { recursive: true, force: true });
    throw error;
  }
  await deps.record({ project, ejected: true, ejectedFrom: line.genexVersion });
  return done(project, line.genexVersion);
}

/** Whether a rename failed only because the two folders are on different volumes. */
const crossDevice = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EXDEV";

/**
 * Copies the verified crates into a part folder, then renames it into `engine` whole. The part is
 * made in the host's scratch folder, where no agent can swap a folder in it for a link; a game on
 * another volume than the profile gets its part beside `engine` instead. The refusal when a source
 * file changed or `engine` appeared meanwhile; null when the fork is in place.
 */
async function copyFork(
  scratch: string,
  crates: readonly Extract<VerifiedCrate, { ok: true }>[],
  line: EngineLockLine,
  engine: string,
): Promise<ExtensionRefusal | null> {
  await mkdir(scratch, { recursive: true });
  const hosted = await copyIntoPart(scratch, crates, line, engine);
  if (hosted !== EXDEV) return hosted;
  const beside = await copyIntoPart(path.dirname(engine), crates, line, engine);
  return beside === EXDEV ? ExtensionRefusal.Unavailable : beside;
}

/** The answer of a part that could not be renamed across volumes. */
const EXDEV = "exdev";

/** One part folder under `parent`: copied, checked and renamed into `engine`, or the refusal; always removed. */
async function copyIntoPart(
  parent: string,
  crates: readonly Extract<VerifiedCrate, { ok: true }>[],
  line: EngineLockLine,
  engine: string,
): Promise<ExtensionRefusal | typeof EXDEV | null> {
  const part = await mkdtemp(path.join(parent, PART_PREFIX));
  try {
    const manifest = await copyCrates(crates, part, line);
    if (manifest === null) return ExtensionRefusal.EjectSourceTampered;
    await atomicWriteJson(path.join(part, ENGINE_MANIFEST_FILE), manifest);
    // Checked again just before the rename: a folder made meanwhile is never replaced.
    if ((await lstat(engine).catch(() => null)) !== null) return ExtensionRefusal.EjectTargetExists;
    try {
      await rename(part, engine);
    } catch (error) {
      if (crossDevice(error)) return EXDEV;
      throw error;
    }
    return null;
  } finally {
    await rm(part, { recursive: true, force: true });
  }
}

/** The forked crates of the lock line, each held to its digest manifest; the refusal when one is missing or tampered. */
async function lockLineCrates(
  line: EngineLockLine,
): Promise<{ ok: true; crates: Extract<VerifiedCrate, { ok: true }>[] } | { ok: false; refusal: ExtensionRefusal }> {
  const vendor = await lstat(line.vendor).catch(() => null);
  if (!vendor?.isDirectory()) return { ok: false, refusal: ExtensionRefusal.EjectLockMissing };
  const crates: Extract<VerifiedCrate, { ok: true }>[] = [];
  for (const name of RUST_ENGINE_CRATES) {
    const folder = path.join(line.vendor, `${name}-${line.genexVersion}`);
    const found = await lstat(folder).catch(() => null);
    if (found === null) {
      if (name === FACADE) return { ok: false, refusal: ExtensionRefusal.EjectLockMissing };
      continue;
    }
    const verified = await verifyVendoredCrate(name, folder);
    if (!verified.ok) return { ok: false, refusal: ExtensionRefusal.EjectSourceTampered };
    crates.push(verified);
  }
  return { ok: true, crates };
}

/** cargo's `.cargo-checksum.json` `files`, or null when it is not one. */
function checksumFiles(value: unknown): Map<string, string> | null {
  if (!isJsonObject(value) || !isJsonObject(value.files)) return null;
  const files = new Map<string, string>();
  for (const [rel, digest] of Object.entries(value.files)) {
    if (typeof digest !== "string" || !SHA256.test(digest) || !plainRelative(rel)) return null;
    files.set(rel, digest);
  }
  return files;
}

/** A crate-relative path as cargo lists it: `/`-separated, no empty, `.` or `..` segment, never absolute. */
function plainRelative(rel: string): boolean {
  if (rel.startsWith("/") || /[\\\0]/.test(rel)) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A vendored crate held to cargo's own digest manifest: the folder and every folder in it real
 * (no link), every file regular, listed and of the listed sha256, every listed file there.
 */
export async function verifyVendoredCrate(name: string, folder: string): Promise<VerifiedCrate> {
  const top = await lstat(folder).catch(() => null);
  if (!top?.isDirectory()) return { ok: false };
  const checksum = await readRegularFile(path.join(folder, CARGO_CHECKSUM_FILE), CHECKSUM_MAX_BYTES).catch(() => null);
  const listed = checksum === null ? null : checksumFiles(parsedJson(checksum));
  if (listed === null) return { ok: false };
  const found = await crateFiles(folder);
  if (found === null) return { ok: false };
  const unlisted = found.filter((rel) => rel !== CARGO_CHECKSUM_FILE && !listed.has(rel));
  const missing = [...listed.keys()].filter((rel) => !found.includes(rel));
  if (unlisted.length > 0 || missing.length > 0) return { ok: false };
  const files = new Map<string, string>();
  for (const rel of found) {
    const digest = await fileSha256(path.join(folder, ...rel.split("/")));
    const expected = rel === CARGO_CHECKSUM_FILE ? digest : listed.get(rel);
    if (digest === null || digest !== expected) return { ok: false };
    files.set(rel, digest);
  }
  return { ok: true, name, folder, files };
}

function parsedJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Every file under `folder`, `/`-joined and sorted; null when anything is a link or not a file or folder. */
async function crateFiles(folder: string, rel = ""): Promise<string[] | null> {
  const files: string[] = [];
  const entries = await readdir(path.join(folder, rel), { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = await crateFiles(folder, child);
      if (nested === null) return null;
      files.push(...nested);
    } else if (entry.isFile()) files.push(child);
    else return null;
    if (files.length > CRATE_MAX_FILES) return null;
  }
  return files.sort();
}

async function fileSha256(file: string): Promise<string | null> {
  const bytes = await readRegularFile(file, ENGINE_FILE_MAX_BYTES).catch(() => null);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copies each verified crate into `<part>/<name>/`, every file read once and held to its verified
 * digest as it is written (a file changed since the check stops the copy). The digest manifest
 * of what was copied, or null when a file changed.
 */
async function copyCrates(
  crates: readonly Extract<VerifiedCrate, { ok: true }>[],
  part: string,
  line: EngineLockLine,
): Promise<EngineManifest | null> {
  const recorded: EngineManifestCrate[] = [];
  for (const crate of crates) {
    for (const [rel, digest] of crate.files) {
      const bytes = await readRegularFile(path.join(crate.folder, ...rel.split("/")), ENGINE_FILE_MAX_BYTES).catch(
        () => null,
      );
      if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== digest) return null;
      const to = path.join(part, crate.name, ...rel.split("/"));
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, bytes, { flag: "wx", mode: 0o644 });
    }
    recorded.push({ name: crate.name, version: line.genexVersion, files: Object.fromEntries(crate.files) });
  }
  return {
    schema: ENGINE_MANIFEST_SCHEMA,
    ejectedFrom: line.genexVersion,
    lock: line.lock,
    engineUpdates: EngineUpdates.Manual,
    crates: recorded,
  };
}

async function uneject(deps: EngineEjectDeps, project: string): Promise<EngineEjectAnswer> {
  const dir = await rustGameDir(deps, project);
  const text = await genexTomlText(dir);
  const engine = path.join(dir, RUST_ENGINE_FOLDER);
  const folder = await lstat(engine).catch(() => null);
  const row = text === null ? null : withEngineRow(text, null);
  if (row !== null && !row.ok) throw new Error(MESSAGE.uneditable(project));
  const ejected = row !== null && row.text !== text;
  const recorded = await deps.ejections.ejectedFrom(project);
  if (!ejected && folder === null && recorded === null) return done(project, null);
  // The fork is in the game's history before anything of it is removed; a failed snapshot removes nothing.
  const snapshotId = await deps.snapshot(project, MESSAGE.snapshotReason);
  if (row !== null && ejected) await atomicWriteText(path.join(dir, GENEX_MANIFEST), row.text);
  await rm(engine, { recursive: true, force: true });
  await deps.ejections.set(project, dir, null);
  await deps.record({ project, ejected: false, ejectedFrom: null, snapshotId });
  return done(project, null);
}

// ── The core's eject ──────────────────────────────────────────────────────────────────────────

/** The game's own lock line in the store: its recorded lock while the store reads it back, else (never built) the current one. */
async function storeLockLine(store: string, payload: string, recorded: unknown): Promise<EngineLockLine | null> {
  const lock: ToolchainLock | null =
    recorded === undefined || recorded === null
      ? await readCurrentLock(store, GameStack.RustWgpu)
      : await readRecordedLock(store, recorded);
  if (lock === null || stackOfLock(lock) !== GameStack.RustWgpu) return null;
  const root = await realpath(store).catch(() => null);
  if (root === null) return null;
  const found = await locateComponents(root, lock, [ToolchainId.RustVendor]);
  const folder = found.ok ? found.components.get(ToolchainId.RustVendor)?.folder : undefined;
  if (folder === undefined) return null;
  const genexVersion = genexReleaseOfLock(lock) ?? (await shippedGenexRelease(payload));
  if (genexVersion === null) return null;
  return { vendor: path.join(folder, RUST_VENDOR_LAYOUT), genexVersion, lock: lock.digest };
}

// ── The profile's eject records ───────────────────────────────────────────────────────────────

/** One ejected game in the profile file. Only ejected games are kept: absence is Studio's engine. */
interface EjectRecord extends FolderIdentity {
  project: string;
  ejectedFrom: string;
  setAt: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A record as the file holds it, or null for anything else (a hand edit, another schema). */
function parseEjectRecord(value: unknown): EjectRecord | null {
  if (!isJsonObject(value)) return null;
  const { project, dir, dev, ino, birth, ejectedFrom, setAt } = value;
  const fields = { project, dir, dev, ino, birth, ejectedFrom, setAt };
  if (!Object.values(fields).every(isText)) return null;
  return RELEASE.test(String(ejectedFrom)) ? (fields as EjectRecord) : null;
}

/** The profile's ejected games; an absent, linked or unreadable file ejects nothing (fail closed). */
async function readEjectRecords(file: string): Promise<EjectRecord[]> {
  const bytes = await readRegularFile(file, EJECTS_FILE_MAX_BYTES).catch(() => null);
  const parsed = bytes === null ? null : parsedJson(bytes);
  if (!isJsonObject(parsed) || parsed.schema !== EJECTS_SCHEMA || !Array.isArray(parsed.games)) return [];
  return parsed.games.map(parseEjectRecord).filter((record): record is EjectRecord => record !== null);
}

/** What the eject records reach: the profile file and the library's Rust games. */
export interface EngineEjectionsDeps {
  /** The profile file (`<userData>/engine-ejects.json`). */
  file: string;
  /** The Rust game `project` names in the library (its folder), or null. */
  rustGame(project: string): Promise<{ dir: string } | null>;
  now?: () => number;
}

/**
 * The person's ejects kept in `deps.file`: written only by eject and un-eject, read by the build lane
 * and the conformance gate. A record holds for the library folder it was made on (its real path,
 * device, inode and birth time), as the trust flag does: a copy or an import is not ejected.
 */
export function createEngineEjections(deps: EngineEjectionsDeps): EngineEjections {
  const lock = new AsyncLock();
  const now = deps.now ?? Date.now;
  return {
    ejectedFrom: async (project) => {
      const game = await deps.rustGame(project).catch(() => null);
      if (!game) return null;
      const [record, identity] = await Promise.all([
        readEjectRecords(deps.file).then((records) => records.find((kept) => kept.project === project)),
        identityOf(game.dir),
      ]);
      return record !== undefined && identity !== null && sameFolder(record, identity) ? record.ejectedFrom : null;
    },
    set: (project, dir, ejectedFrom) =>
      lock.run(async () => {
        const others = (await readEjectRecords(deps.file)).filter((record) => record.project !== project);
        const identity = ejectedFrom === null ? null : await identityOf(dir);
        if (ejectedFrom !== null && identity === null) throw new Error(MESSAGE.notRust(project));
        const setAt = new Date(now()).toISOString();
        const kept = identity === null || ejectedFrom === null ? [] : [{ project, ...identity, ejectedFrom, setAt }];
        await atomicWriteJson(deps.file, { schema: EJECTS_SCHEMA, games: [...others, ...kept] });
      }),
  };
}

const ejections = new WeakMap<StudioCore, EngineEjections>();

/** The library's Rust game `project` names, or null. */
async function coreRustGame(core: StudioCore, project: string) {
  const game = (await core.games.list()).find((listed) => listed.name === project);
  return game && stackOf(game.shape) === GameStack.RustWgpu ? game : null;
}

/** The core's eject records: its profile's file and its library's Rust games. */
export function engineEjectionsFor(core: StudioCore): EngineEjections {
  const known = ejections.get(core);
  if (known) return known;
  const records = createEngineEjections({
    file: path.join(core.options.paths.userData, ENGINE_EJECTS_FILE),
    rustGame: (project) => coreRustGame(core, project),
  });
  ejections.set(core, records);
  return records;
}

/**
 * Whether this host judges an ejected engine: the conformance suite runs a game's Mac build, so the
 * host must be a Mac and macOS one of the game's destinations.
 */
export function judgesOnThisHost(platform: NodeJS.Platform, game: Parameters<typeof destinationsOf>[0]): boolean {
  const host = hostOf(platform);
  return (
    host !== null && hostTarget(host) === BuildTarget.Mac && destinationsOf(game).targets.includes(BuildTarget.Mac)
  );
}

const services = new WeakMap<StudioCore, EngineEjectService>();

/** The core's eject service: the library's Rust games, the profile's store, game snapshots and the event log. */
export function engineEjectFor(core: StudioCore): EngineEjectService {
  const known = services.get(core);
  if (known) return known;
  const payload = rustPayloadDir(core.options.paths.resources);
  const service = createEngineEject({
    rustGame: async (project) => {
      const game = await coreRustGame(core, project);
      return game ? { dir: game.dir } : null;
    },
    judgeable: async (project) => {
      const game = await coreRustGame(core, project);
      return game !== null && judgesOnThisHost(process.platform, game);
    },
    ejections: engineEjectionsFor(core),
    scratch: core.layout.scratch,
    lockLine: async (project) =>
      storeLockLine(core.layout.toolchains, payload, (await core.games.presentation(project)).native?.lock),
    snapshot: async (project, reason) => (await core.snapshot(SnapshotScope.Game, reason, project)).snapshot_id,
    record: async (payload) => {
      await core.append([customEventData(CustomEvent.EngineEjected, { ...payload })]);
    },
  });
  services.set(core, service);
  return service;
}
