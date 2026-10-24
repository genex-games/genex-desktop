/**
 * Scripts as files, both ways: a Roblox game's scripts live as `.luau` files under the game's
 * `src/` (named by `script-paths.ts`), and the Genex helper in Studio keeps the place's scripts in
 * step with them. Genex syncs a script's `Source` only; its attributes, tags and everything else
 * stay in the place export.
 *
 * - **The record.** `.genex/roblox.json` holds each script file's hash as of the last time disk and
 *   Studio agreed on it (`scripts`), and the files Genex itself wrote at the game's top (`written`).
 * - **Reconcile.** Each time a game's helper binds, every script is decided three ways, by Studio's
 *   hash, the file's and the record's: whichever side changed since the record wins; a script new
 *   on one side is copied to the other; one deleted on a side that the other left unchanged is
 *   deleted there too (in Studio only while its hash still matches the record). Changed on both
 *   sides, Studio's version stays and the file's goes to `.genex/conflicts/<when>/`, never under
 *   `src/`. An edit always beats a deletion.
 * - **After a restore.** Git put back `src/` and the record together, so the record says nothing of
 *   what Studio changed since: the restored files win. The reconcile then takes Studio's listing as
 *   the record, so each restored file goes to Studio and a script Studio has alone is removed.
 * - **While bound.** A change under `src/` (a watcher, quiet for {@link SYNC_DEBOUNCE_MS}) is pushed
 *   with the record's hash as the base, so the helper refuses it when Studio changed meanwhile, and
 *   the same conflict rule applies. A script Studio changes (`scripts.changed`) is written to its
 *   file. Echoes are dropped by hash: a write is recorded before it lands, so the change it causes
 *   on the other side matches the record. A change Studio refuses while a play test runs is sent
 *   again after {@link BUSY_RETRY_MS}; a watch an error ended is armed again after
 *   {@link WATCH_REARM_MS}.
 * - **What is skipped.** Scripts Studio's Script Sync keeps in files of its own (listed as synced)
 *   are skipped both ways. A `default.project.json` at the game's top that Genex didn't write is the
 *   person's Rojo project: Rojo keeps their scripts in step, so Genex writes no script either way.
 *   A script file the scan finds but can't take (too long, not UTF-8, unreadable, a link, or in a
 *   folder it can't list) counts as present: neither side's copy is touched for it.
 *   A `src/` that is a link is refused, and nothing is read or written. Every write stays inside
 *   the game folder by real path; a link anywhere on the way is refused and nothing is written
 *   through it.
 */
import { type Dirent, watch as watchFolder } from "node:fs";
import { lstat, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, ensureDirBelow, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import type { JobClock } from "../../substrate/job-process.ts";
import { type HelperAsk, HelperLinkError, scriptTarget } from "./helper-link.ts";
import {
  HelperErrorCode,
  HelperMessage,
  helperHash,
  isScriptPath,
  MAX_SCRIPT_SOURCE_BYTES,
  type ScriptChange,
  type ScriptEntry,
  type ScriptRef,
} from "./helper-protocol.ts";
import { clearPendingScripts, existingFolder, hasPendingScripts, writeWhole } from "./place-files.ts";
import { layoutScripts, SCRIPT_EXTENSION, SCRIPTS_FOLDER, scriptKey, scriptRefOf } from "./script-paths.ts";
import { isGameId } from "./studio-binding.ts";

/** How long `src/` stays quiet before its changes are pushed: an editor's save is several writes. */
export const SYNC_DEBOUNCE_MS = 150;
/** How soon changes Studio refused while a play test ran are sent again. */
export const BUSY_RETRY_MS = 5 * SECOND_MS;
/** How soon a watch that stopped on an error is armed again. */
export const WATCH_REARM_MS = 5 * SECOND_MS;
/** Genex's record of the game's scripts, as path segments in the game folder. */
export const SCRIPT_RECORD = [".genex", "roblox.json"] as const;
/** Where a file's version goes when Studio's version of the same script wins. */
export const CONFLICTS_FOLDER = [".genex", "conflicts"] as const;
/** The longest Source Studio takes: a longer one is refused when it is set. */
export const STUDIO_SOURCE_MAX_CHARS = 200_000;
/** A person's Rojo project, at the game's top. */
export const ROJO_PROJECT = "default.project.json";
/** Studio's lock files beside a place, kept out of save points. */
export const LOCK_IGNORES = ["*.rbxl.lock", "*.rbxlx.lock"] as const;
const GITIGNORE = ".gitignore";
const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_GITIGNORE_BYTES = 1024 * 1024;
/** The most script files a scan reads, and how deep it goes. */
const MAX_FILES = 10_000;
const MAX_DEPTH = 64;
const HASH = /^[0-9a-f]{8}$/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Whether Genex keeps a game's scripts in step, and why not. Wire values: never rename. */
export const ScriptSyncMode = {
  /** Not started, or stopped. */
  Off: "off",
  On: "on",
  /** The person's Rojo project keeps the scripts in step. */
  Rojo: "rojo",
  /** `src/` is a link or not a folder: nothing is read or written. */
  Refused: "refused",
} as const;
export type ScriptSyncMode = (typeof ScriptSyncMode)[keyof typeof ScriptSyncMode];

/** Watches a folder and everything below it, telling of an error that ended it; tests fire it by hand. */
export type WatchFolder = (
  folder: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
) => { close(): void };

/** fs.watch over the folder and its subfolders; an error ends the watch with a log line, and is told. */
export function systemWatch(log: (line: string) => void): WatchFolder {
  return (folder, onChange, onError) => {
    const watcher = watchFolder(folder, { recursive: true, persistent: false }, () => onChange());
    watcher.on("error", (error) => {
      log(`script sync: watching ${folder} stopped: ${String(error)}`);
      watcher.close();
      onError?.(error);
    });
    return { close: () => watcher.close() };
  };
}

/** The record as it is kept: other fields a later writer added are kept as they are. */
interface ScriptRecord {
  v: number;
  /** Files at the game's top that Genex wrote (such as a published place's project file). */
  written: string[];
  /** Each script file below `src/` with its hash as of the last sync. */
  scripts: Record<string, string>;
  [other: string]: unknown;
}

/** A script file read from disk. */
interface DiskScript {
  file: string;
  ref: ScriptRef;
  hash: string;
  source: string;
}

/** What one game's sync works with. */
export interface ScriptSyncDeps {
  /** The game folder. */
  folder: string;
  /** The game's helper; rejects when it isn't bound. */
  ask: HelperAsk;
  clock: JobClock;
  watch: WatchFolder;
  log?(line: string): void;
}

/** One game's sync. */
/** How a reconcile decides. */
export interface ReconcileOptions {
  /** `src/` was just restored: the restored files win over whatever Studio holds. */
  restored?: boolean;
}

export interface ScriptSync {
  /**
   * Reconciles disk and Studio, then keeps them in step; called again on every new binding. On
   * only once the reconcile ran to its end; one that failed leaves the sync Off, for the next try.
   */
  start(options?: ReconcileOptions): Promise<ScriptSyncMode>;
  /** A script Studio changed, as the helper reports it. */
  changed(change: ScriptChange): Promise<void>;
  /** Lists a file Genex wrote at the game's top in the record, after any pass under way. */
  written(name: string): Promise<void>;
  /**
   * Sends file changes still waiting out the quiet spell to Studio now, then settles. With a limit,
   * each request asks within it and the wait ends at it (the pass goes on after).
   */
  flush(timeoutMs?: number): Promise<void>;
  mode(): ScriptSyncMode;
  /** Settles once every pass under way has finished. */
  idle(): Promise<void>;
  stop(): void;
}

const emptyRecord = (): ScriptRecord => ({ v: RECORD_VERSION, written: [], scripts: {} });

const isPlainName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !/[/\\\u0000-\u001f]/.test(value);

/** The record in the game folder; a missing or damaged one is empty (every difference then a conflict). */
async function readRecord(folder: string): Promise<ScriptRecord> {
  const dir = await existingFolder(folder, SCRIPT_RECORD.slice(0, -1));
  const bytes =
    dir && (await readRegularFile(path.join(dir, SCRIPT_RECORD[1]), MAX_RECORD_BYTES).catch(() => undefined));
  if (!bytes) return emptyRecord();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return emptyRecord();
  }
  if (!isJsonObject(value) || value.v !== RECORD_VERSION) return emptyRecord();
  const written = Array.isArray(value.written) ? value.written.filter(isPlainName) : [];
  const scripts = isJsonObject(value.scripts)
    ? Object.fromEntries(
        Object.entries(value.scripts).filter(
          ([file, hash]) => isScriptPath(file) && scriptRefOf(file) && typeof hash === "string" && HASH.test(hash),
        ),
      )
    : {};
  return { ...value, v: RECORD_VERSION, written, scripts: scripts as Record<string, string> };
}

async function writeRecord(folder: string, record: ScriptRecord): Promise<void> {
  const dir = await ensureDirBelow(folder, SCRIPT_RECORD.slice(0, -1));
  await writeWhole(dir, SCRIPT_RECORD[1], `${JSON.stringify(record, null, 2)}\n`);
}

/** Whether `name` at the game's top is a file Genex wrote, as the record lists it. */
export async function writtenByGenex(folder: string, name: string): Promise<boolean> {
  return (await readRecord(folder)).written.includes(name);
}

/**
 * Lists `name`, a file Genex writes at the game's top (a published place's project file), in the
 * record's `written`, so the sync never takes it for the person's own Rojo project. Write it in the
 * record before the file itself: a pass in between then still sees Genex's file.
 */
export async function recordWritten(folder: string, name: string): Promise<void> {
  if (!isPlainName(name)) throw new Error(`Not a plain file name: ${name}`);
  const record = await readRecord(folder);
  if (record.written.includes(name)) return;
  await writeRecord(folder, { ...record, written: [...record.written, name] });
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** The game's `src/` by real path, made when missing; undefined when it is a link or not a folder. */
async function scriptRoot(folder: string): Promise<string | undefined> {
  const base = await realpath(folder);
  const info = await lstat(path.join(base, SCRIPTS_FOLDER)).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) return undefined;
  return ensureDirBelow(base, [SCRIPTS_FOLDER]);
}

/** Whether the game holds a Rojo project Genex didn't write. */
async function personsRojo(folder: string, record: ScriptRecord): Promise<boolean> {
  if (record.written.includes(ROJO_PROJECT)) return false;
  const info = await lstat(path.join(folder, ROJO_PROJECT)).catch(() => undefined);
  return info !== undefined;
}

/** Adds Studio's lock files to the game's `.gitignore` when they aren't there; a linked one is left. */
export async function ignoreLocks(folder: string, log: (line: string) => void): Promise<void> {
  const base = await realpath(folder);
  let text = "";
  try {
    text = (await readRegularFile(path.join(base, GITIGNORE), MAX_GITIGNORE_BYTES)).toString("utf8");
  } catch (error) {
    if (!isMissing(error)) {
      log(`script sync: ${GITIGNORE} left as it is (${String(error)})`);
      return;
    }
  }
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = LOCK_IGNORES.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  const start = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  await writeWhole(base, GITIGNORE, `${start}${missing.join("\n")}\n`);
}

/** The source in `bytes` when it is text Studio can hold, else why not. */
function sourceOf(bytes: Buffer): { source: string } | { problem: string } {
  let source: string;
  try {
    source = STRICT_UTF8.decode(bytes);
  } catch {
    return { problem: "isn't UTF-8 text" };
  }
  return source.length > STUDIO_SOURCE_MAX_CHARS
    ? { problem: `is longer than the ${STUDIO_SOURCE_MAX_CHARS} characters Studio takes` }
    : { source };
}

/**
 * Script files the scan found but couldn't take (too long, not UTF-8, unreadable, a link, or in a
 * folder it couldn't list): each counts as present, so neither side's copy is touched for it.
 */
class HeldFiles {
  files = new Set<string>();
  keys = new Set<string>();
  /** Folders below `src/` the scan couldn't list or follow, each ending in `/`. */
  folders: string[] = [];
  /** The scan stopped at its file limit: every file it didn't reach counts as present. */
  all = false;

  holdFile(file: string): void {
    const ref = scriptRefOf(file);
    this.files.add(file);
    if (ref) this.keys.add(scriptKey(ref));
  }

  /** Whether the script in `file` (or under another of its names) is held. */
  holds(file: string, key: string): boolean {
    if (this.all || this.files.has(file) || this.keys.has(key)) return true;
    return this.folders.some((folder) => file.startsWith(folder));
  }
}

/** What a scan of `src/` found: the scripts it read, and the files it found but couldn't take. */
interface DiskScan {
  scripts: DiskScript[];
  held: HeldFiles;
}

/** Every script file below `src/` (by real path), read; links are never followed, other files skipped. */
async function scanScripts(root: string, log: (line: string) => void): Promise<DiskScan> {
  const scan: DiskScan = { scripts: [], held: new HeldFiles() };
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    if (rel.length > MAX_DEPTH) return holdFolder(scan, rel, "is nested too deep", log);
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      holdFolder(scan, rel, `can't be listed (${String(error)})`, log);
      return [];
    });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (scan.scripts.length >= MAX_FILES) {
        scan.held.all = true;
        return;
      }
      const parts = [...rel, entry.name];
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), parts);
      else await scanFile(scan, root, entry, parts, log);
    }
  };
  await walk(root, []);
  return scan;
}

/** One entry that isn't a folder: a link held, a script file read, anything else skipped. */
async function scanFile(scan: DiskScan, root: string, entry: Dirent, parts: string[], log: (line: string) => void) {
  if (entry.isSymbolicLink()) holdLink(scan, parts, log);
  else if (entry.isFile() && entry.name.endsWith(SCRIPT_EXTENSION)) await readScript(scan, root, parts, log);
}

function holdFolder(scan: DiskScan, rel: string[], problem: string, log: (line: string) => void): void {
  if (rel.length === 0) scan.held.all = true;
  else scan.held.folders.push(`${rel.join("/")}/`);
  log(`script sync: ${SCRIPTS_FOLDER}/${rel.join("/")} ${problem}; its scripts are left as they are in Studio`);
}

/** A link is never followed, and what it stands for is left alone on both sides. */
function holdLink(scan: DiskScan, parts: string[], log: (line: string) => void): void {
  const file = parts.join("/");
  if (file.endsWith(SCRIPT_EXTENSION)) scan.held.holdFile(file);
  else scan.held.folders.push(`${file}/`);
  log(`script sync: ${SCRIPTS_FOLDER}/${file} is a link; it is never followed, and Studio's scripts there stay`);
}

async function readScript(scan: DiskScan, root: string, parts: string[], log: (line: string) => void) {
  const file = parts.join("/");
  const ref = scriptRefOf(file);
  if (!ref) return;
  const bytes = await readRegularFile(path.join(root, ...parts), MAX_SCRIPT_SOURCE_BYTES).catch(() => undefined);
  const read = bytes ? sourceOf(bytes) : { problem: "can't be read" };
  if ("problem" in read) {
    scan.held.holdFile(file);
    log(`script sync: ${SCRIPTS_FOLDER}/${file} ${read.problem}; it stays out of Studio`);
    return;
  }
  scan.scripts.push({ file, ref, hash: helperHash(read.source), source: read.source });
}

/** Writes a script file below `src/`, its folders made on the way; a link on the way is refused. */
async function writeScriptFile(folder: string, file: string, source: string): Promise<void> {
  // Refuses a link anywhere on the way, or a target that isn't a plain file, before anything is made.
  await scriptTarget(folder, file);
  const segments = file.split("/");
  const name = segments.pop() as string;
  const dir = await ensureDirBelow(folder, [SCRIPTS_FOLDER, ...segments]);
  await writeWhole(dir, name, source);
}

/** Deletes a script file below `src/` when nothing on the way is a link and it is a plain file. */
async function deleteScriptFile(folder: string, file: string): Promise<void> {
  const target = await scriptTarget(folder, file).catch(() => undefined);
  const info = target && (await lstat(target).catch(() => undefined));
  if (target && info && info.isFile()) await unlink(target);
}

/** Saves a file's losing version under `.genex/conflicts/<when>/`, beside nothing under `src/`. */
async function keepConflict(folder: string, file: string, source: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const segments = file.split("/");
  const name = segments.pop() as string;
  const dir = await ensureDirBelow(folder, [...CONFLICTS_FOLDER, stamp, ...segments]);
  await writeWhole(dir, name, source);
  return [...CONFLICTS_FOLDER, stamp, file].join("/");
}

/** The helper's own error code on a failed request, if it answered with one. */
const helperCode = (error: unknown) => (error instanceof HelperLinkError ? error.helperCode : undefined);

/** What one script's three hashes call for. Wire values: never rename. */
export const ScriptStep = {
  /** Disk and Studio agree: the record takes their hash. */
  InStep: "in-step",
  /** Neither side has it any more: the record forgets it. */
  Forget: "forget",
  ToDisk: "to-disk",
  ToStudio: "to-studio",
  DeleteFile: "delete-file",
  RemoveFromStudio: "remove-from-studio",
  /** Both sides changed since the record: Studio's stays, the file's goes to the conflicts folder. */
  Conflict: "conflict",
} as const;
export type ScriptStep = (typeof ScriptStep)[keyof typeof ScriptStep];

/**
 * One script decided by Studio's hash, the file's and the record's (each undefined when that side
 * has none): the side that changed since the record wins, a new script is copied, a deletion is
 * copied only when the other side is as recorded, and changed on both sides is a conflict.
 */
export function decideScript(studio?: string, disk?: string, recorded?: string): ScriptStep {
  if (studio !== undefined && disk !== undefined) {
    if (studio === disk) return ScriptStep.InStep;
    if (recorded === studio) return ScriptStep.ToStudio;
    return recorded === disk ? ScriptStep.ToDisk : ScriptStep.Conflict;
  }
  if (studio !== undefined) return recorded === studio ? ScriptStep.RemoveFromStudio : ScriptStep.ToDisk;
  if (disk !== undefined) return recorded === disk ? ScriptStep.DeleteFile : ScriptStep.ToStudio;
  return ScriptStep.Forget;
}

/** One game's sync over its folder and helper. */
export function createScriptSync(deps: ScriptSyncDeps): ScriptSync {
  return new SyncState(deps).api();
}

/** The sync's state; every pass runs one after another on `queue`. */
class SyncState {
  deps: ScriptSyncDeps;
  current: ScriptSyncMode = ScriptSyncMode.Off;
  record: ScriptRecord = emptyRecord();
  root: string | undefined;
  /** Scripts Script Sync keeps, and scripts with no file of their own (a clash), by key. */
  skipped = new Set<string>();
  queue: Promise<void> = Promise.resolve();
  /** The files the last scan found but couldn't take: left alone on both sides. */
  held = new HeldFiles();
  /** Scripts this reconcile couldn't carry to the other side (a request that failed). */
  misses = 0;
  watcher: { close(): void } | undefined;
  timer: unknown;
  /** Arms the watch again after an error ended it. */
  rearm: unknown;

  constructor(deps: ScriptSyncDeps) {
    this.deps = deps;
  }

  log(line: string): void {
    this.deps.log?.(line);
  }

  api(): ScriptSync {
    return {
      start: (options = {}) => this.enqueue(() => this.reconcile(options)).then(() => this.current),
      changed: (change) => this.enqueue(() => this.fromStudio(change)),
      written: (name) => this.enqueue(() => this.noteWritten(name)),
      flush: async (timeoutMs) => {
        if (this.current !== ScriptSyncMode.On) return;
        this.deps.clock.clearTimeout(this.timer);
        const pass = this.enqueue(() => this.fromDisk(timeoutMs));
        await (timeoutMs === undefined ? pass : this.within(pass, timeoutMs));
      },
      mode: () => this.current,
      idle: async () => {
        for (let seen: Promise<void> | undefined; seen !== this.queue; ) {
          seen = this.queue;
          await seen;
        }
      },
      stop: () => this.stop(),
    };
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((error: unknown) => this.log(`script sync: ${String(error)}`));
    this.queue = run;
    return run;
  }

  /** Waits for `work` at most `ms` on the sync's clock; the work goes on after. */
  async within(work: Promise<void>, ms: number): Promise<void> {
    let timer: unknown;
    const limit = new Promise<void>((resolve) => {
      timer = this.deps.clock.setTimeout(resolve, ms);
    });
    try {
      await Promise.race([work, limit]);
    } finally {
      this.deps.clock.clearTimeout(timer);
    }
  }

  async noteWritten(name: string): Promise<void> {
    await recordWritten(this.deps.folder, name);
    if (!this.record.written.includes(name)) this.record.written.push(name);
  }

  stop(): void {
    this.current = ScriptSyncMode.Off;
    this.watcher?.close();
    this.watcher = undefined;
    this.deps.clock.clearTimeout(this.timer);
    this.deps.clock.clearTimeout(this.rearm);
  }

  /** A pass over `src/` once `ms` have passed, in place of any pass already waiting. */
  passIn(ms: number): void {
    this.deps.clock.clearTimeout(this.timer);
    this.timer = this.deps.clock.setTimeout(() => void this.enqueue(() => this.fromDisk()), ms);
  }

  /** The mode the folder allows now; anything but On stops the watch. */
  async check(): Promise<ScriptSyncMode> {
    this.root = await scriptRoot(this.deps.folder);
    if (!this.root) {
      this.log(`script sync: ${SCRIPTS_FOLDER} is a link or not a folder; Genex keeps no scripts in step here`);
      return ScriptSyncMode.Refused;
    }
    this.record = await readRecord(this.deps.folder);
    return (await personsRojo(this.deps.folder, this.record)) ? ScriptSyncMode.Rojo : ScriptSyncMode.On;
  }

  /**
   * Reconciles disk and Studio; the sync is On only once that ran to its end. A failed one (Studio
   * held by a dialog, the helper gone) stops the sync, so the next call or binding tries again.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<void> {
    try {
      await this.reconcileOnce(options);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async reconcileOnce(options: ReconcileOptions): Promise<void> {
    const mode = await this.check();
    if (mode !== ScriptSyncMode.On) {
      this.stop();
      this.current = mode;
      return;
    }
    await ignoreLocks(this.deps.folder, (line) => this.log(line));
    const listed = await this.deps.ask(HelperMessage.ScriptsList, {});
    const disk = await this.scan();
    this.misses = 0;
    await this.decideAll(listed.scripts, disk, options);
    await writeRecord(this.deps.folder, this.record);
    // After a restore every restored file must reach Studio: one that didn't would come back from Studio later.
    if (options.restored && this.misses > 0)
      throw new Error(`${this.misses} restored scripts didn't reach Studio; the restore's reconcile waits`);
    this.current = mode;
    this.watchScripts();
  }

  /**
   * Each script decided by Studio's hash, the file's and the record's; after a restore, Studio's
   * own hash stands in for the record's, so the restored files win.
   */
  async decideAll(listed: ScriptEntry[], disk: DiskScript[], options: ReconcileOptions = {}): Promise<void> {
    this.skipped = new Set(listed.filter((entry) => entry.synced).map(scriptKey));
    const kept = listed.filter((entry) => !entry.synced);
    const studio = new Map(kept.map((entry) => [scriptKey(entry), entry]));
    // The whole listing, so two scripts of one name are both seen and both refused.
    const layout = layoutScripts(this.takenFiles(disk), kept);
    for (const ref of layout.refused) this.refuse(ref);
    const onDisk = new Map(disk.map((script) => [scriptKey(script.ref), script]));
    const recorded = new Map(
      Object.entries(this.record.scripts).map(([file, hash]) => [
        scriptKey(scriptRefOf(file) as ScriptRef),
        { file, hash },
      ]),
    );
    const keys = new Set([...studio.keys(), ...onDisk.keys(), ...recorded.keys()]);
    const plans = [...keys]
      .filter((key) => !this.skipped.has(key))
      .map((key) => {
        const file = onDisk.get(key)?.file ?? recorded.get(key)?.file ?? layout.files.get(key);
        const base = options.restored ? studio.get(key)?.hash : recorded.get(key)?.hash;
        const step = decideScript(studio.get(key)?.hash, onDisk.get(key)?.hash, base);
        return { key, file, step, studio: studio.get(key), disk: onDisk.get(key), recorded: recorded.get(key) };
      });
    const needed = plans.filter((plan) => plan.step === ScriptStep.ToDisk || plan.step === ScriptStep.Conflict);
    const sources = await this.studioSources(needed.flatMap((plan) => (plan.studio ? [plan.studio] : [])));
    for (const plan of plans) {
      if (!plan.file || this.isHeld(plan.file, plan.key, plan.disk)) continue;
      // The script moved to another of its names: the record follows it.
      if (plan.recorded && plan.recorded.file !== plan.file) delete this.record.scripts[plan.recorded.file];
      const ref = (plan.studio ?? plan.disk?.ref ?? scriptRefOf(plan.file)) as ScriptRef;
      await this.apply({ ...plan, file: plan.file, ref: toRef(ref), studioSource: sources.get(plan.key) });
    }
  }

  /** The script files below `src/` now; what the scan couldn't take is kept in `held`. */
  async scan(): Promise<DiskScript[]> {
    const scan = await scanScripts(this.root as string, (line) => this.log(line));
    this.held = scan.held;
    return scan.scripts;
  }

  /** Whether the script in `file` has a file on disk the scan couldn't take: neither side is touched. */
  isHeld(file: string, key: string, onDisk: DiskScript | undefined): boolean {
    return onDisk === undefined && this.held.holds(file, key);
  }

  refuse(ref: ScriptRef): void {
    this.skipped.add(scriptKey(ref));
    this.log(
      `script sync: ${ref.path.join(".")} gets no file (another script has its name, or its letter case clashes)`,
    );
  }

  async studioSources(refs: ScriptRef[]): Promise<Map<string, string>> {
    if (refs.length === 0) return new Map();
    const read = await this.deps.ask(HelperMessage.ScriptsRead, { scripts: refs.map(toRef) });
    return new Map(read.scripts.map((script) => [scriptKey(script), script.source]));
  }

  /** Carries out one script's decision. */
  async apply(plan: Plan): Promise<void> {
    const { file, ref } = plan;
    switch (plan.step) {
      case ScriptStep.InStep:
        this.record.scripts[file] = plan.studio?.hash as string;
        return;
      case ScriptStep.Forget:
        delete this.record.scripts[file];
        return;
      case ScriptStep.ToDisk:
        if (plan.studioSource !== undefined) await this.toDisk(file, plan.studioSource);
        return;
      case ScriptStep.DeleteFile:
        delete this.record.scripts[file];
        await deleteScriptFile(this.deps.folder, file);
        return;
      case ScriptStep.ToStudio:
        await this.push(file, ref, plan.disk as DiskScript, plan.studio?.hash);
        return;
      case ScriptStep.RemoveFromStudio:
        // Studio's hash: the record's whenever the record decided, and Studio's own after a restore.
        await this.remove(file, ref, plan.studio?.hash as string);
        return;
      case ScriptStep.Conflict:
        if (plan.studioSource !== undefined) await this.conflict(file, plan.disk as DiskScript, plan.studioSource);
        return;
    }
  }

  /** Studio's source into the file; the record first, so the file's own change reads as no change. */
  async toDisk(file: string, source: string): Promise<void> {
    this.record.scripts[file] = helperHash(source);
    try {
      await writeScriptFile(this.deps.folder, file, source);
    } catch (error) {
      delete this.record.scripts[file];
      this.misses++;
      this.log(`script sync: ${SCRIPTS_FOLDER}/${file} not written: ${String(error)}`);
    }
  }

  /** Both sides changed: Studio's stays, in Studio and the file; the file's version is kept aside. */
  async conflict(file: string, disk: DiskScript, studioSource: string): Promise<void> {
    const kept = await keepConflict(this.deps.folder, file, disk.source, this.deps.clock.now());
    this.log(
      `script sync: ${SCRIPTS_FOLDER}/${file} changed in Studio and on disk; Studio's kept, yours is in ${kept}`,
    );
    await this.toDisk(file, studioSource);
  }

  /** The file's source into Studio, refused by the helper when Studio isn't at `base` any more. */
  async push(file: string, ref: ScriptRef, disk: DiskScript, base: string | undefined, timeoutMs?: number) {
    const body = base === undefined ? { script: ref, source: disk.source } : { script: ref, source: disk.source, base };
    try {
      const { hash } = await this.deps.ask(HelperMessage.ScriptsWrite, body, limitOf(timeoutMs));
      this.record.scripts[file] = hash;
    } catch (error) {
      await this.pushFailed(file, ref, disk, error);
    }
  }

  async pushFailed(file: string, ref: ScriptRef, disk: DiskScript, error: unknown): Promise<void> {
    const code = helperCode(error);
    if (code === HelperErrorCode.Conflict) {
      const studio = (await this.studioSources([ref])).get(scriptKey(ref));
      if (studio !== undefined) await this.conflict(file, disk, studio);
      return;
    }
    if (code === HelperErrorCode.Refused) this.skipped.add(scriptKey(ref));
    else this.misses++;
    // Studio takes no script change while a play test runs: the change goes again after it.
    if (code === HelperErrorCode.Busy) this.passIn(BUSY_RETRY_MS);
    this.log(`script sync: ${SCRIPTS_FOLDER}/${file} not sent to Studio: ${errorText(error)}`);
  }

  /** Removes a script deleted on disk, only while Studio's source is still the recorded one. */
  async remove(file: string, ref: ScriptRef, hash: string, timeoutMs?: number): Promise<void> {
    try {
      await this.deps.ask(HelperMessage.ScriptsRemove, { script: ref, hash }, limitOf(timeoutMs));
      delete this.record.scripts[file];
    } catch (error) {
      if (helperCode(error) !== HelperErrorCode.Conflict) {
        this.misses++;
        if (helperCode(error) === HelperErrorCode.Busy) this.passIn(BUSY_RETRY_MS);
        this.log(`script sync: ${ref.path.join(".")} not removed from Studio: ${errorText(error)}`);
        return;
      }
      // Changed in Studio since: an edit beats a deletion, so the file comes back.
      const studio = (await this.studioSources([ref])).get(scriptKey(ref));
      if (studio !== undefined) await this.toDisk(file, studio);
    }
  }

  watchScripts(): void {
    if (this.watcher || !this.root) return;
    const watcher = this.deps.watch(
      this.root,
      () => this.passIn(SYNC_DEBOUNCE_MS),
      () => this.watchEnded(watcher),
    );
    this.watcher = watcher;
  }

  /** A watch an error ended is armed again a little later, with a pass for what changed meanwhile. */
  watchEnded(watcher: { close(): void }): void {
    if (this.watcher !== watcher) return;
    watcher.close();
    this.watcher = undefined;
    this.deps.clock.clearTimeout(this.rearm);
    this.rearm = this.deps.clock.setTimeout(() => {
      if (this.current !== ScriptSyncMode.On) return;
      this.watchScripts();
      void this.enqueue(() => this.fromDisk());
    }, WATCH_REARM_MS);
  }

  /** What changed under `src/` since the record: pushed, or removed from Studio, each request within `timeoutMs` when given. */
  async fromDisk(timeoutMs?: number): Promise<void> {
    if (this.current !== ScriptSyncMode.On) return;
    const mode = await this.check();
    if (mode !== ScriptSyncMode.On) {
      this.stop();
      this.current = mode;
      return;
    }
    const disk = (await this.scan()).filter((script) => !this.skipped.has(scriptKey(script.ref)));
    for (const script of disk) {
      const recorded = this.record.scripts[script.file];
      if (script.hash !== recorded) await this.push(script.file, script.ref, script, recorded, timeoutMs);
    }
    await this.removeMissing(disk, timeoutMs);
    await writeRecord(this.deps.folder, this.record);
  }

  /**
   * Recorded files no longer on disk: their scripts are removed from Studio, unless the script is
   * still on disk under another of its names (moved into its own folder as `init`, or back).
   */
  async removeMissing(disk: DiskScript[], timeoutMs?: number): Promise<void> {
    const files = new Set(disk.map((script) => script.file));
    const keys = new Set(disk.map((script) => scriptKey(script.ref)));
    for (const [file, hash] of Object.entries(this.record.scripts)) {
      const ref = scriptRefOf(file) as ScriptRef;
      const key = scriptKey(ref);
      if (files.has(file) || this.skipped.has(key) || this.held.holds(file, key)) continue;
      if (keys.has(key)) delete this.record.scripts[file];
      else await this.remove(file, ref, hash, timeoutMs);
    }
  }

  /** Every file name already taken below `src/`: on disk, or held by the record. */
  takenFiles(disk: DiskScript[]): string[] {
    return [...disk.map((script) => script.file), ...this.held.files, ...Object.keys(this.record.scripts)];
  }

  /** The file a script is in, or goes in: on disk, in the record, or where the layout puts it. */
  fileFor(ref: ScriptRef, disk: DiskScript[], onDisk: DiskScript | undefined): string | undefined {
    const key = scriptKey(ref);
    if (onDisk) return onDisk.file;
    const recorded = Object.keys(this.record.scripts).find((file) => scriptKey(scriptRefOf(file) as ScriptRef) === key);
    return recorded ?? layoutScripts(this.takenFiles(disk), [ref]).files.get(key);
  }

  /** A script Studio changed or removed, into its file. */
  async fromStudio(change: ScriptChange): Promise<void> {
    const ref = toRef(change);
    const key = scriptKey(ref);
    if (this.current !== ScriptSyncMode.On || this.skipped.has(key)) return;
    const disk = await this.scan();
    const onDisk = disk.find((script) => scriptKey(script.ref) === key);
    const file = this.fileFor(ref, disk, onDisk);
    if (!file) {
      this.refuse(ref);
      return;
    }
    if (this.isHeld(file, key, onDisk)) {
      this.log(`script sync: ${SCRIPTS_FOLDER}/${file} can't be taken from disk; Studio's change to it isn't written`);
      return;
    }
    const recorded = this.record.scripts[file];
    const studioHash = change.source === null ? undefined : helperHash(change.source);
    const plan: Plan = { key, file, ref, step: decideScript(studioHash, onDisk?.hash, recorded), disk: onDisk };
    if (recorded !== undefined) plan.recorded = { file, hash: recorded };
    if (studioHash !== undefined) plan.studio = { ...ref, hash: studioHash, synced: false };
    if (change.source !== null) plan.studioSource = change.source;
    await this.apply(plan);
    await writeRecord(this.deps.folder, this.record);
  }
}

/** One script's decision with what it needs. */
interface Plan {
  key: string;
  file: string;
  ref: ScriptRef;
  step: ScriptStep;
  studio?: ScriptEntry | undefined;
  disk?: DiskScript | undefined;
  recorded?: { file: string; hash: string } | undefined;
  studioSource?: string | undefined;
}

/** A request's options with its limit, when the caller gave one. */
const limitOf = (timeoutMs: number | undefined) => (timeoutMs === undefined ? {} : { timeoutMs });

/** Just the reference: the fields the helper takes, nothing a listing added. */
function toRef(value: ScriptRef): ScriptRef {
  return value.runContext === undefined
    ? { path: value.path, class: value.class }
    : { path: value.path, class: value.class, runContext: value.runContext };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where the backend keeps each game's folder, in the plugin's own storage: `games/<game>.json`. */
export const GAMES_FOLDER = "games";
const MAX_GAME_RECORD_BYTES = 64 * 1024;

/** What the syncs of every game work with. */
export interface ScriptSyncsDeps {
  /** The plugin's storage, where each game's folder is kept. */
  storage: string;
  /** A game's helper. */
  ask(game: string): HelperAsk;
  /** Whether a game's helper is bound now. */
  bound(game: string): boolean;
  clock: JobClock;
  watch: WatchFolder;
  log?(line: string): void;
}

/** The syncs of every game the backend has heard of. */
export interface ScriptSyncs {
  /** A call for `game` came with its folder: kept, and the sync started if its helper is bound. */
  seen(game: string, folder: string): Promise<void>;
  /**
   * The game's helper bound, or its folder was restored: its sync reconciles (when its folder is
   * known); whether that reconcile ran to its end. A restore's wait (`pending-scripts.json`) makes
   * it a restore's reconcile unless told, and is cleared only once such a reconcile ran.
   */
  bind(game: string, options?: ReconcileOptions): Promise<boolean>;
  changed(game: string, change: ScriptChange): Promise<void>;
  /** Lists a file Genex wrote at the top of `game`'s folder in its record, in turn with its sync. */
  written(game: string, folder: string, name: string): Promise<void>;
  /** Sends `game`'s file changes still on their way to Studio now, waiting at most `timeoutMs` when given; nothing when its sync isn't on. */
  flush(game: string, timeoutMs?: number): Promise<void>;
  /** The folder kept for `game`, when it is still a folder. */
  folder(game: string): Promise<string | undefined>;
  mode(game: string): ScriptSyncMode;
  idle(): Promise<void>;
  stop(): void;
}

const gameRecord = (storage: string, game: string) => path.join(storage, GAMES_FOLDER, `${game}.json`);

/** The folder kept for `game`, when it is still a folder. */
async function readGameFolder(storage: string, game: string): Promise<string | undefined> {
  if (!isGameId(game)) return undefined;
  const bytes = await readRegularFile(gameRecord(storage, game), MAX_GAME_RECORD_BYTES).catch(() => undefined);
  let value: unknown;
  try {
    value = bytes && JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const folder = isJsonObject(value) ? value.folder : undefined;
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return undefined;
  const info = await stat(folder).catch(() => undefined);
  return info?.isDirectory() ? folder : undefined;
}

/** The syncs over the plugin's storage and the helper link. */
export function createScriptSyncs(deps: ScriptSyncsDeps): ScriptSyncs {
  const folders = new Map<string, string>();
  const syncs = new Map<string, { folder: string; sync: ScriptSync }>();
  const log = (line: string) => deps.log?.(line);
  const folderOf = async (game: string) => folders.get(game) ?? (await readGameFolder(deps.storage, game));
  const bind = async (game: string, options: ReconcileOptions = {}): Promise<boolean> => {
    const folder = await folderOf(game);
    if (!folder) {
      log(`script sync: ${game}'s folder isn't known yet; its scripts sync once Genex calls the plugin for it`);
      return false;
    }
    let held = syncs.get(game);
    if (held?.folder !== folder) {
      held?.sync.stop();
      held = {
        folder,
        sync: createScriptSync({ folder, ask: deps.ask(game), clock: deps.clock, watch: deps.watch, log }),
      };
      syncs.set(game, held);
    }
    const restored = options.restored ?? (await hasPendingScripts(folder));
    const reconciled = (await held.sync.start({ restored })) === ScriptSyncMode.On;
    if (reconciled && restored) await clearPendingScripts(folder);
    return reconciled;
  };
  return {
    async seen(game, folder) {
      if (!isGameId(game) || !path.isAbsolute(folder)) return;
      const real = await realpath(folder).catch(() => undefined);
      if (!real || !(await stat(real)).isDirectory()) return;
      if (folders.get(game) !== real) {
        folders.set(game, real);
        await atomicWriteJson(gameRecord(deps.storage, game), { folder: real });
      }
      const running = syncs.get(game)?.sync.mode() === ScriptSyncMode.On;
      if (deps.bound(game) && !running) await bind(game);
    },
    bind: (game, options) => (isGameId(game) ? bind(game, options) : Promise.resolve(false)),
    changed: async (game, change) => {
      await syncs.get(game)?.sync.changed(change);
    },
    async written(game, folder, name) {
      const held = syncs.get(game);
      if (held && held.folder === (await realpath(folder).catch(() => folder))) await held.sync.written(name);
      else await recordWritten(folder, name);
    },
    flush: async (game, timeoutMs) => {
      await syncs.get(game)?.sync.flush(timeoutMs);
    },
    folder: folderOf,
    mode: (game) => syncs.get(game)?.sync.mode() ?? ScriptSyncMode.Off,
    async idle() {
      await Promise.all([...syncs.values()].map((held) => held.sync.idle()));
    },
    stop() {
      for (const held of syncs.values()) held.sync.stop();
    },
  };
}
