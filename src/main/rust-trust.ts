/**
 * The per-game trust flag (extension ladder level 5): with it on, the Rust lane lets `unsafe` and
 * build scripts into the game's own crates (`rustTrustPolicy` in `rust-build.ts`); ProcessSandbox
 * is the same with it on or off. Only the person sets it, through `studio:engine.setTrust` after a
 * warning (`EngineTrust.tsx`); every change is a persisted `game_trust` event.
 *
 * The flag lives in the profile (`<userData>/engine-trust.json`, outside every writable root an
 * agent has), never in the game: no harness method, `genex.toml` key or file in the game folder
 * can set it. A game that claims trust itself is answered `trust-person-only` and stays untrusted.
 * Default off. A flag holds for the library folder it was set on (its real path, device, inode and
 * birth time): a copy, an import under the same name or a folder replaced behind the library
 * starts untrusted, and a build of the game's worktree is trusted only while the game is.
 */
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, type CustomEventRecord, customEventData } from "../shared/custom-events.ts";
import { type EngineTrustAnswer, ExtensionRefusal } from "../shared/game-conformance.ts";
import { GameStack, stackOf } from "../shared/game-project.ts";
import { AsyncLock, atomicWriteJson, isJsonObject, readRegularFile } from "../substrate/fsx.ts";
import { GENEX_MANIFEST } from "../substrate/project-shape.ts";
import type { StudioCore } from "./studio-core.ts";

/** The profile file the flags live in, under userData. Also the name a game planting its own copy is caught by. */
export const ENGINE_TRUST_FILE = "engine-trust.json";
const TRUST_SCHEMA = 1;
/** The most of the profile file, or of a game's `genex.toml`, the host reads. */
const TRUST_FILE_MAX_BYTES = 1024 * 1024;
const GENEX_TOML_MAX_BYTES = 256 * 1024;
/**
 * A `genex.toml` line keying trust (`trust`, `trusted`, `[trust]`, `engine.trusted`, quoted or
 * not). Only ever read to answer `trust-person-only`: a line it misses changes nothing, because
 * nothing in the game is ever read as the flag.
 */
const TRUST_KEY = /^\s*\[?\s*["']?(?:[\w-]+\.)*trust(?:ed)?["']?\s*(?:=|\])/im;

/** A game's own build script, and where cargo looks for one in an ejected engine crate. */
const BUILD_SCRIPT = "build.rs";
/** The folder an ejected engine lives in (M7.1). */
const ENGINE_DIR = "engine";
const CARGO_MANIFEST = "Cargo.toml";
/** How much of an ejected engine the build-script scan walks before it refuses the rest. */
const ENGINE_SCAN_MAX_ENTRIES = 20_000;
const ENGINE_SCAN_MAX_DEPTH = 16;
const ENGINE_MANIFEST_MAX_BYTES = 1024 * 1024;
/**
 * What an engine crate's manifest may not say while its game is untrusted: a `build` key (plain,
 * dotted, quoted or in an inline table) other than cargo's own `build = false`, which every
 * vendored genex crate's normalized manifest carries; a proc macro set to anything; or an escape
 * a quoted key could hide either behind. Deliberately broad otherwise: a false match is refused
 * and the person's trust flag lifts it.
 */
const ENGINE_MANIFEST_REFUSED = [
  /(?:^|[\s{,.'"])build["']?\s*=(?!\s*false\s*(?:$|[,}#]))/m,
  /proc[-_]macro["']?\s*=/i,
  /\\[uU]/,
];

const MESSAGE = {
  notRust: (project: string) => `${project} is not a Rust game in the library`,
} as const;

/** The trust flag as the person's window reaches it (`main/ipc/engine.ts`). */
export interface EngineTrustService {
  setTrust(project: string, trusted: boolean): Promise<EngineTrustAnswer>;
}

/** Whether a game is trusted now, and whether it claimed trust itself (`trust-person-only`). */
export interface GameTrust {
  trusted: boolean;
  /** `trust-person-only` when the game's own files claim trust; null otherwise. Never changes `trusted`. */
  claim: ExtensionRefusal | null;
}

/** The answer for a game nobody trusted: the default everywhere. */
export const UNTRUSTED: GameTrust = Object.freeze({ trusted: false, claim: null });

/** The trust flags of a profile: the person's setter and the build lane's reader. */
export interface EngineTrustStore extends EngineTrustService {
  /** Whether a build of `project` (from `dir`, its folder or a worktree of it) runs trusted. */
  trustOf(game: { project: string; dir: string }): Promise<GameTrust>;
}

/** What the store reaches, injected. */
export interface EngineTrustDeps {
  /** The profile file (`<userData>/engine-trust.json`). */
  file: string;
  /** The Rust game `project` names in the library (its folder), or null. */
  rustGame: (project: string) => Promise<{ dir: string } | null>;
  /** Appends persisted events. */
  record: (events: CustomEventRecord[]) => Promise<void>;
  now?: () => number;
}

/** The library folder a flag (or an eject) was set on: a different folder under the same name is a different game. */
export interface FolderIdentity {
  dir: string;
  dev: string;
  ino: string;
  birth: string;
}

/** One trusted game in the profile file. Only trusted games are kept: absence is off. */
interface TrustRecord extends FolderIdentity {
  project: string;
  setAt: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Whether every field of a record read back is a non-empty string. */
function isTrustRecord(fields: Record<keyof TrustRecord, unknown>): fields is TrustRecord {
  return Object.values(fields).every(isText);
}

/** A record as the file holds it, or null for anything else (a hand edit, another schema). */
function parseRecord(value: unknown): TrustRecord | null {
  if (!isJsonObject(value)) return null;
  const { project, dir, dev, ino, birth, setAt } = value;
  const fields = { project, dir, dev, ino, birth, setAt };
  return isTrustRecord(fields) ? fields : null;
}

/** The profile's trusted games; an absent, linked or unreadable file trusts nothing (fail closed). */
async function readRecords(file: string): Promise<TrustRecord[]> {
  const bytes = await readRegularFile(file, TRUST_FILE_MAX_BYTES).catch(() => null);
  if (bytes === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  if (!isJsonObject(parsed) || parsed.schema !== TRUST_SCHEMA || !Array.isArray(parsed.games)) return [];
  return parsed.games.map(parseRecord).filter((record): record is TrustRecord => record !== null);
}

/** The identity of a game's library folder, by its real path; null when it is gone or not a folder. */
export async function identityOf(dir: string): Promise<FolderIdentity | null> {
  const real = await realpath(dir).catch(() => null);
  if (real === null) return null;
  const stats: BigIntStats | null = await lstat(real, { bigint: true }).catch(() => null);
  if (!stats?.isDirectory()) return null;
  return { dir: real, dev: String(stats.dev), ino: String(stats.ino), birth: String(stats.birthtimeNs) };
}

/** Whether two identities name the very same folder. */
export const sameFolder = (a: FolderIdentity, b: FolderIdentity): boolean =>
  a.dir === b.dir && a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;

/**
 * Whether the game at `dir` claims trust in its own files: a trust key in its `genex.toml`, or a
 * planted copy of the profile file. A claim never trusts anything; it is answered `trust-person-only`.
 */
export async function trustClaimOf(dir: string): Promise<ExtensionRefusal | null> {
  const planted = await lstat(path.join(dir, ENGINE_TRUST_FILE)).catch(() => null);
  if (planted) return ExtensionRefusal.TrustPersonOnly;
  const toml = await readRegularFile(path.join(dir, GENEX_MANIFEST), GENEX_TOML_MAX_BYTES).catch(() => null);
  if (toml !== null && TRUST_KEY.test(toml.toString("utf8"))) return ExtensionRefusal.TrustPersonOnly;
  return null;
}

/** Whether an engine crate's `Cargo.toml` at `file` asks for a build script or a proc macro; unreadable counts as asking. */
async function manifestAsks(file: string): Promise<boolean> {
  const bytes = await readRegularFile(file, ENGINE_MANIFEST_MAX_BYTES).catch(() => null);
  if (bytes === null) return true;
  const text = bytes.toString("utf8");
  return ENGINE_MANIFEST_REFUSED.some((pattern) => pattern.test(text));
}

/** The walk's place: what it found and how much it has read. */
interface EngineScan {
  found: string[];
  seen: number;
}

/** Walks `rel` under `root` without following a link, collecting build scripts and manifests that ask for one. */
async function scanEngineFolder(root: string, rel: string, depth: number, scan: EngineScan): Promise<void> {
  const names = await readdir(path.join(root, rel)).catch(() => null);
  if (names === null) return;
  for (const name of names.sort()) {
    scan.seen += 1;
    const entry = path.posix.join(rel, name);
    if (scan.seen > ENGINE_SCAN_MAX_ENTRIES || depth > ENGINE_SCAN_MAX_DEPTH) {
      scan.found.push(entry);
      return;
    }
    const stats = await lstat(path.join(root, entry)).catch(() => null);
    if (name === BUILD_SCRIPT) scan.found.push(entry);
    else if (stats?.isDirectory()) await scanEngineFolder(root, entry, depth + 1, scan);
    else if (name === CARGO_MANIFEST && (await manifestAsks(path.join(root, entry)))) scan.found.push(entry);
  }
}

/**
 * The build scripts and proc macros in a game's own crates, `/`-separated from the game folder: a
 * `build.rs` beside its `genex.toml`, and in an ejected `engine/` any `build.rs` or a crate
 * manifest asking for a build script or a proc macro (an engine too big to walk names where the
 * walk stopped). Nothing is followed through a link. With the game's trust flag off, any of them
 * refuses the build `build-script-refused` before cargo runs.
 */
export async function ownBuildScripts(dir: string): Promise<string[]> {
  const found: string[] = [];
  if (await lstat(path.join(dir, BUILD_SCRIPT)).catch(() => null)) found.push(BUILD_SCRIPT);
  const engine = await lstat(path.join(dir, ENGINE_DIR)).catch(() => null);
  if (!engine?.isDirectory()) return found;
  const scan: EngineScan = { found, seen: 0 };
  await scanEngineFolder(dir, ENGINE_DIR, 0, scan);
  return scan.found;
}

/** The trust flags kept in `deps.file`: set by the person alone, read by the build lane. */
export function createEngineTrust(deps: EngineTrustDeps): EngineTrustStore {
  const lock = new AsyncLock();
  const now = deps.now ?? Date.now;

  /** Whether `project`'s library folder is the very one its flag was set on. */
  const flagged = async (project: string): Promise<boolean> => {
    const game = await deps.rustGame(project);
    if (!game) return false;
    const [record, identity] = await Promise.all([
      readRecords(deps.file).then((records) => records.find((kept) => kept.project === project)),
      identityOf(game.dir),
    ]);
    return record !== undefined && identity !== null && sameFolder(record, identity);
  };

  const setTrust = async (project: string, trusted: boolean): Promise<EngineTrustAnswer> => {
    const game = await deps.rustGame(project);
    if (!game) throw new Error(MESSAGE.notRust(project));
    const identity = await identityOf(game.dir);
    if (!identity) throw new Error(MESSAGE.notRust(project));
    return await lock.run(async () => {
      const records = await readRecords(deps.file);
      const kept = records.find((record) => record.project === project);
      const was = kept !== undefined && sameFolder(kept, identity);
      if (was === trusted) return { project, ok: true, refusal: null, trusted };
      const others = records.filter((record) => record.project !== project);
      const setAt = new Date(now()).toISOString();
      const games = trusted ? [...others, { project, ...identity, setAt }] : others;
      await atomicWriteJson(deps.file, { schema: TRUST_SCHEMA, games });
      await deps.record([customEventData(CustomEvent.GameTrust, { project, trusted })]);
      return { project, ok: true, refusal: null, trusted };
    });
  };

  const trustOf = async (game: { project: string; dir: string }): Promise<GameTrust> => {
    const [trusted, claim] = await Promise.all([
      flagged(game.project).catch(() => false),
      trustClaimOf(game.dir).catch(() => null),
    ]);
    return { trusted, claim };
  };

  return { setTrust, trustOf };
}

const services = new WeakMap<StudioCore, EngineTrustStore>();

/** The core's trust flags: its profile's file and its library's Rust games. */
export function engineTrustFor(core: StudioCore): EngineTrustStore {
  const known = services.get(core);
  if (known) return known;
  const service = createEngineTrust({
    file: path.join(core.options.paths.userData, ENGINE_TRUST_FILE),
    rustGame: async (project) =>
      (await core.games.list()).find((game) => game.name === project && stackOf(game.shape) === GameStack.RustWgpu) ??
      null,
    record: async (events) => {
      await core.append(events);
    },
  });
  services.set(core, service);
  return service;
}
