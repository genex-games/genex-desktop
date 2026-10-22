/**
 * Setting Roblox Studio up for Genex: the Genex helper in Studio's Plugins folder, and Studio's own
 * MCP server switched on in each account's settings (`mcp-switch.ts`), and taking both back.
 *
 * - The Plugins folder is `~/Documents/Roblox/Plugins` on a Mac and `%LOCALAPPDATA%\Roblox\Plugins`
 *   on Windows. Studio doesn't make it until something needs it, so Set up makes it, inside the
 *   real Roblox folder Studio made; it never makes the Roblox folder itself.
 * - Every hostile shape is refused before anything is written: a link where Genex would read or
 *   write, something other than a folder or file where one belongs, unreadable settings, Studio
 *   running (it rewrites its settings itself, so Genex writes them only while it is closed).
 * - Genex's record in its own storage (`setup/record.json`) lists every path written with its
 *   bytes' hash or the value it replaced, and keeps a copy of a helper file that was there before.
 *   Undo takes back only what still holds Genex's bytes; a file changed since is left as it is.
 * - The helper's whole-number version is the `GENEX_HELPER_VERSION = <n>` line it carries: an
 *   older or unmarked one is replaced, a newer one is left alone.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, readRegularFile, replaceFile } from "../../substrate/fsx.ts";
import { envValue } from "../../substrate/toolchain.ts";
import {
  MAX_SETTINGS_BYTES,
  planSwitches,
  type SwitchChange,
  type SwitchPlan,
  switchBackText,
  turnOn,
} from "./mcp-switch.ts";
import { RobloxSetupError, SetupRefusal } from "./setup-refusal.ts";
import { isMacPath, isWindowsPath } from "./studio-locate.ts";
import { MESSAGE } from "./words.ts";

/** The helper's file name, in the package and in Studio's Plugins folder. */
export const HELPER_FILE = "GenexStudioHelper.rbxmx";
/** The shipped helper's version; the file carries the same number as `GENEX_HELPER_VERSION`. */
export const HELPER_VERSION = 2;
const HELPER_VERSION_MARK = /\bGENEX_HELPER_VERSION\s*=\s*(\d{1,6})\b/;
/** The largest helper file Genex reads back: the shipped one is a few kilobytes. */
const HELPER_MAX_BYTES = 4 * 1024 * 1024;
/** The largest settings value Undo puts back. */
const SWITCH_VALUE_MAX_CHARS = 64 * 1024;
const SETUP_FOLDER = "setup";
const RECORD_FILE = "record.json";
const BEFORE_FOLDER = "before";
const RECORD_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;

/** The installed helper against the shipped one. Wire values: never rename. */
export const HelperState = { Current: "current", Outdated: "outdated", Newer: "newer", Missing: "missing" } as const;
export type HelperState = (typeof HelperState)[keyof typeof HelperState];

/** What Set up did to the helper. Wire values: never rename. */
export const HelperChange = { Added: "added", Updated: "updated", Kept: "kept" } as const;
export type HelperChange = (typeof HelperChange)[keyof typeof HelperChange];

/** Where Roblox keeps its plugins and its settings on this computer. */
export interface SetupPaths {
  /** Folders that must be real folders, never links: Roblox's own (and LOCALAPPDATA on Windows). */
  guarded: string[];
  /** Roblox's folder that holds the Plugins folder. */
  roblox: string;
  plugins: string;
  /** The folder of each account's settings file. */
  settings: string;
}

/** What setup works with: the folders, the shipped helper, Genex's storage, Studio and the clock. */
export interface SetupOptions {
  paths: SetupPaths;
  /** The shipped helper file. */
  helper: string;
  /** The plugin's own storage folder. */
  storage: string;
  running(): Promise<boolean>;
  now(): number;
}

/** What Set up would find. */
export interface SetupState {
  helper: HelperState;
  version?: number;
  pluginsFolder: boolean;
  /** Account settings files, and how many have the switch on already. */
  settings: number;
  alreadyOn: number;
  recorded: boolean;
}

/** What Set up did. */
export interface SetupDone {
  helper: HelperChange;
  pluginsCreated: boolean;
  switches: { files: number; turnedOn: number; alreadyOn: number };
}

/** What Undo took back, and the files it left because they changed since. */
export interface UndoDone {
  removed: string[];
  kept: string[];
}

interface HelperRecord {
  file: string;
  sha256: string;
  version: number;
  /** The file that was there before Genex's, kept in Genex's storage. */
  before?: { sha256: string; copy: string };
}

interface SwitchRecord extends SwitchChange {
  file: string;
}

interface SetupRecord {
  version: typeof RECORD_VERSION;
  at: string;
  plugins: { folder: string; created: boolean };
  helper?: HelperRecord;
  switches: SwitchRecord[];
}

/** The helper file as found in the Plugins folder. */
interface InstalledHelper {
  file: string;
  state: HelperState;
  version?: number;
  bytes?: Buffer;
}

const refuse = (code: SetupRefusal, message: string) => new RobloxSetupError(code, message);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The helper's version as its file states it; undefined for a file without the mark. */
export function helperVersionOf(text: string): number | undefined {
  const mark = HELPER_VERSION_MARK.exec(text);
  return mark ? Number(mark[1]) : undefined;
}

/** Where Roblox keeps its plugins and settings, from the home on a Mac and LOCALAPPDATA on Windows. */
export function setupPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): SetupPaths {
  if (platform === "darwin" && isMacPath(home)) {
    const roblox = path.posix.join(home, "Documents", "Roblox");
    const settings = path.posix.join(home, "Library", "Roblox", "AssistantSettings");
    return { guarded: [roblox], roblox, plugins: path.posix.join(roblox, "Plugins"), settings };
  }
  const local = platform === "win32" ? envValue(env, "LOCALAPPDATA") : undefined;
  if (local && isWindowsPath(local)) {
    const roblox = path.win32.join(local, "Roblox");
    const settings = path.win32.join(roblox, "AssistantSettings");
    return { guarded: [local, roblox], roblox, plugins: path.win32.join(roblox, "Plugins"), settings };
  }
  throw refuse(SetupRefusal.OtherSystem, MESSAGE.Setup.OtherSystem());
}

/** What Set up will do, in plain words, for its confirmation: no folder is read for it. */
export function planSetup(plan: { platform: NodeJS.Platform; paths: SetupPaths; settings: number }): string[] {
  const lines: string[] = plan.platform === "darwin" ? [MESSAGE.Setup.DocumentsNote()] : [];
  lines.push(MESSAGE.Setup.PlanHelper(plan.paths.plugins));
  lines.push(plan.settings > 0 ? MESSAGE.Setup.PlanSwitch(plan.settings) : MESSAGE.Setup.PlanNoSettings());
  lines.push(MESSAGE.Setup.PlanUndo());
  return lines;
}

/**
 * The guarded folders are real folders and the Plugins folder, when there, is a real folder inside
 * the real Roblox folder; whether it is there.
 */
async function checkFolders(paths: SetupPaths): Promise<boolean> {
  for (const folder of paths.guarded) {
    const info = await lstat(folder).catch(() => undefined);
    if (!info) throw refuse(SetupRefusal.NoRobloxFolder, MESSAGE.Setup.NoRobloxFolder(folder));
    if (info.isSymbolicLink()) throw refuse(SetupRefusal.Linked, MESSAGE.Setup.Linked(folder));
    if (!info.isDirectory()) throw refuse(SetupRefusal.NotAFolder, MESSAGE.Setup.NotAFolder(folder));
  }
  const plugins = await lstat(paths.plugins).catch(() => undefined);
  if (!plugins) return false;
  if (plugins.isSymbolicLink()) throw refuse(SetupRefusal.Linked, MESSAGE.Setup.Linked(paths.plugins));
  if (!plugins.isDirectory()) throw refuse(SetupRefusal.NotAFolder, MESSAGE.Setup.NotAFolder(paths.plugins));
  const inside = path.join(await realpath(paths.roblox), path.basename(paths.plugins));
  if ((await realpath(paths.plugins)) !== inside)
    throw refuse(SetupRefusal.Linked, MESSAGE.Setup.Linked(paths.plugins));
  return true;
}

/**
 * Whether helper bytes of this Genex's own version are still an earlier Genex's write: not the
 * shipped bytes, but the bytes Genex's record says it wrote. A version alone can't tell a changed
 * helper shipped under the same version; a person's own edit is never taken for Genex's.
 */
async function earlierGenexBytes(options: SetupOptions, bytes: Buffer): Promise<boolean> {
  const recorded = (await readRecord(options.storage))?.helper?.sha256;
  if (!recorded) return false;
  const installed = sha256(bytes);
  return installed === recorded && installed !== sha256(await readFile(options.helper));
}

/** The helper file in the Plugins folder: missing, or a plain file read for its version (and, at this version, its bytes). */
async function installedHelper(options: SetupOptions): Promise<InstalledHelper> {
  const { paths } = options;
  const file = path.join(paths.plugins, HELPER_FILE);
  const info = await lstat(file).catch(() => undefined);
  if (!info) return { file, state: HelperState.Missing };
  if (info.isSymbolicLink()) throw refuse(SetupRefusal.Linked, MESSAGE.Setup.Linked(file));
  if (!info.isFile()) throw refuse(SetupRefusal.NotAFolder, MESSAGE.Setup.NotAFolder(file));
  const bytes = await readRegularFile(file, HELPER_MAX_BYTES).catch(() => {
    throw refuse(SetupRefusal.NotAFolder, MESSAGE.Setup.NotAFolder(file));
  });
  const version = helperVersionOf(bytes.toString("utf8"));
  if (version === undefined || version < HELPER_VERSION) return { file, state: HelperState.Outdated, version, bytes };
  if (version > HELPER_VERSION) return { file, state: HelperState.Newer, version, bytes };
  const state = (await earlierGenexBytes(options, bytes)) ? HelperState.Outdated : HelperState.Current;
  return { file, state, version, bytes };
}

const needsHelper = (state: HelperState) => state === HelperState.Missing || state === HelperState.Outdated;

const setupFolder = (storage: string) => path.join(storage, SETUP_FOLDER);
const recordPath = (storage: string) => path.join(setupFolder(storage), RECORD_FILE);
const beforeCopy = (storage: string) => path.join(setupFolder(storage), BEFORE_FOLDER, HELPER_FILE);

function parseHelperRecord(raw: unknown): HelperRecord | undefined {
  if (!isRecordObject(raw)) return undefined;
  const { file, sha256: hash, version, before } = raw;
  const valid = isText(file, 4096) && isText(hash, 64) && SHA256.test(hash) && Number.isInteger(version);
  if (!valid) return undefined;
  const entry: HelperRecord = { file, sha256: hash, version: Number(version) };
  if (isRecordObject(before) && isText(before.sha256, 64) && isText(before.copy, 4096))
    entry.before = { sha256: before.sha256, copy: before.copy };
  return entry;
}

function parseSwitchRecord(raw: unknown): SwitchRecord | undefined {
  if (!isRecordObject(raw)) return undefined;
  const { file, before, after } = raw;
  const beforeOk = before === null || isText(before, SWITCH_VALUE_MAX_CHARS);
  if (!isText(file, 4096) || !beforeOk || !isText(after, SWITCH_VALUE_MAX_CHARS)) return undefined;
  return { file, before: before as string | null, after };
}

/** Genex's setup record, or null when there is none or it can't be read as one. */
async function readRecord(storage: string): Promise<SetupRecord | null> {
  const raw: unknown = await readFile(recordPath(storage), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (!isRecordObject(raw) || raw.version !== RECORD_VERSION || !isRecordObject(raw.plugins)) return null;
  const { folder, created } = raw.plugins;
  if (!isText(folder, 4096) || typeof created !== "boolean") return null;
  const switches = Array.isArray(raw.switches) ? raw.switches.map(parseSwitchRecord) : [];
  const record: SetupRecord = {
    version: RECORD_VERSION,
    at: typeof raw.at === "string" ? raw.at : "",
    plugins: { folder, created },
    switches: switches.filter((entry): entry is SwitchRecord => entry !== undefined),
  };
  const helper = parseHelperRecord(raw.helper);
  if (helper) record.helper = helper;
  return record;
}

/**
 * The helper Genex's record says it added: its version, and whether it is this Genex's own (this
 * version's shipped bytes, or a newer one) or an older one. Read from the plugin's storage and the
 * shipped file only, never from the Plugins folder.
 */
export async function recordedHelper(
  storage: string,
  shipped: string,
): Promise<{ version: number; current: boolean } | undefined> {
  const helper = (await readRecord(storage))?.helper;
  if (!helper) return undefined;
  if (helper.version !== HELPER_VERSION) return { version: helper.version, current: helper.version > HELPER_VERSION };
  const same = await readFile(shipped).then(
    (bytes) => sha256(bytes) === helper.sha256,
    () => true,
  );
  return { version: helper.version, current: same };
}

/** Writes `bytes` to `file` whole or not at all, never through a link at that name; `mode` for a new file. */
async function writeWhole(file: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const temporary = path.join(path.dirname(file), `.genex-${process.pid}-${randomBytes(6).toString("hex")}`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFile(temporary, file).catch(async (error: unknown) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });
}

/** The record's entry for the helper after this write, keeping the first file that was there before Genex's. */
async function helperEntry(
  storage: string,
  found: InstalledHelper,
  shipped: Buffer,
  earlier: HelperRecord | undefined,
): Promise<HelperRecord> {
  const entry: HelperRecord = { file: found.file, sha256: sha256(shipped), version: HELPER_VERSION };
  const stillOurs = earlier?.file === found.file && found.bytes !== undefined && sha256(found.bytes) === earlier.sha256;
  if (stillOurs) {
    if (earlier.before) entry.before = earlier.before;
    return entry;
  }
  if (!found.bytes) return entry;
  const copy = beforeCopy(storage);
  await mkdir(path.dirname(copy), { recursive: true });
  await writeWhole(copy, found.bytes);
  entry.before = { sha256: sha256(found.bytes), copy };
  return entry;
}

/** The record after this Set up: earlier entries kept unless this run rewrote the same path. */
function nextRecord(
  options: SetupOptions,
  earlier: SetupRecord | null,
  change: { pluginsCreated: boolean; helper?: HelperRecord; switches: SwitchPlan },
): SetupRecord {
  const { plugins } = options.paths;
  const createdBefore = earlier?.plugins.folder === plugins && earlier.plugins.created;
  const rewritten = new Set(change.switches.writes.map((write) => write.file));
  const record: SetupRecord = {
    version: RECORD_VERSION,
    at: new Date(options.now()).toISOString(),
    plugins: { folder: plugins, created: createdBefore || change.pluginsCreated },
    switches: [
      ...(earlier?.switches ?? []).filter((entry) => !rewritten.has(entry.file)),
      ...change.switches.writes.map(({ file, before, after }) => ({ file, before, after })),
    ],
  };
  const helper = change.helper ?? earlier?.helper;
  if (helper) record.helper = helper;
  return record;
}

/** What Set up would find, without writing anything; it reads the Plugins folder, so only from the person's press. */
export async function inspectSetup(options: SetupOptions): Promise<SetupState> {
  const pluginsFolder = await checkFolders(options.paths);
  const helper = await installedHelper(options);
  const switches = await planSwitches(options.paths.settings);
  const state: SetupState = {
    helper: helper.state,
    pluginsFolder,
    settings: switches.files,
    alreadyOn: switches.alreadyOn,
    recorded: (await readRecord(options.storage)) !== null,
  };
  if (helper.version !== undefined) state.version = helper.version;
  return state;
}

/** Adds or updates the helper once everything was checked; the record is written before the files. */
async function writeSetup(
  options: SetupOptions,
  found: { pluginsFolder: boolean; helper: InstalledHelper; switches: SwitchPlan },
): Promise<HelperChange> {
  const earlier = await readRecord(options.storage);
  const install = needsHelper(found.helper.state);
  const shipped = await readFile(options.helper);
  const helper = install ? await helperEntry(options.storage, found.helper, shipped, earlier?.helper) : undefined;
  const pluginsCreated = !found.pluginsFolder;
  await atomicWriteJson(
    recordPath(options.storage),
    nextRecord(options, earlier, { pluginsCreated, helper, switches: found.switches }),
  );
  if (pluginsCreated) await mkdir(options.paths.plugins);
  if (install) await writeWhole(found.helper.file, shipped);
  await turnOn(found.switches, options.running);
  if (!install) return HelperChange.Kept;
  return found.helper.state === HelperState.Missing ? HelperChange.Added : HelperChange.Updated;
}

/**
 * Sets Studio up for Genex while it is closed: makes the Plugins folder when missing, adds or
 * updates the helper, and turns the MCP switch on in every account's settings file. Everything is
 * checked first: a refusal writes nothing.
 */
export async function setUp(options: SetupOptions): Promise<SetupDone> {
  if (await options.running()) throw refuse(SetupRefusal.StudioRunning, MESSAGE.Setup.StudioRunning());
  const pluginsFolder = await checkFolders(options.paths);
  const helper = await installedHelper(options);
  const switches = await planSwitches(options.paths.settings);
  const change = await writeSetup(options, { pluginsFolder, helper, switches });
  return {
    helper: change,
    pluginsCreated: !pluginsFolder,
    switches: { files: switches.files, turnedOn: switches.writes.length, alreadyOn: switches.alreadyOn },
  };
}

/** Brings the helper up to the shipped version, leaving a current or newer one and every setting as they are. */
export async function updateHelper(options: SetupOptions): Promise<HelperChange> {
  const pluginsFolder = await checkFolders(options.paths);
  const helper = await installedHelper(options);
  if (!needsHelper(helper.state)) return HelperChange.Kept;
  return writeSetup(options, { pluginsFolder, helper, switches: { files: 0, alreadyOn: 0, writes: [] } });
}

/** A plain file's bytes up to `max`, read without following a link; undefined for anything else. */
async function plainBytes(file: string, info: Stats, max: number): Promise<Buffer | undefined> {
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  return readRegularFile(file, max).catch(() => undefined);
}

/** Takes the helper back if it still holds Genex's bytes: the file there before is put back, else it is removed. */
async function undoHelper(options: SetupOptions, entry: HelperRecord | undefined, done: UndoDone): Promise<void> {
  const file = path.join(options.paths.plugins, HELPER_FILE);
  if (entry?.file !== file) return;
  const info = await lstat(file).catch(() => undefined);
  if (!info) return;
  const bytes = await plainBytes(file, info, HELPER_MAX_BYTES);
  if (!bytes || sha256(bytes) !== entry.sha256) {
    done.kept.push(file);
    return;
  }
  const copy = entry.before?.copy === beforeCopy(options.storage) ? entry.before : undefined;
  const before = copy ? await readFile(copy.copy).catch(() => undefined) : undefined;
  if (before && sha256(before) === copy?.sha256) await writeWhole(file, before);
  else await unlink(file);
  done.removed.push(file);
}

/** Puts one account's switch back where the file still holds Genex's value. */
async function undoSwitch(options: SetupOptions, entry: SwitchRecord, done: UndoDone): Promise<void> {
  if (path.dirname(entry.file) !== options.paths.settings) return;
  const info = await lstat(entry.file).catch(() => undefined);
  if (!info) return;
  const bytes = await plainBytes(entry.file, info, MAX_SETTINGS_BYTES);
  const text = bytes ? switchBackText(bytes.toString("utf8"), entry) : undefined;
  if (text === undefined) {
    done.kept.push(entry.file);
    return;
  }
  await writeWhole(entry.file, Buffer.from(text, "utf8"), info.mode & 0o777);
  done.removed.push(entry.file);
}

/** Removes the Plugins folder only when Genex made it and it is empty now. */
async function undoPluginsFolder(options: SetupOptions, record: SetupRecord, done: UndoDone): Promise<void> {
  const folder = options.paths.plugins;
  if (!record.plugins.created || record.plugins.folder !== folder) return;
  const info = await lstat(folder).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  if ((await readdir(folder)).length > 0) return;
  await rmdir(folder);
  done.removed.push(folder);
}

/**
 * Takes back what Set up wrote, while Studio is closed: only bytes and values that are still
 * Genex's; anything changed since is kept and named. The record and its copies go last.
 */
export async function undoSetup(options: SetupOptions): Promise<UndoDone> {
  if (await options.running()) throw refuse(SetupRefusal.StudioRunning, MESSAGE.Setup.StudioRunning());
  const record = await readRecord(options.storage);
  if (!record) throw refuse(SetupRefusal.NotSetUp, MESSAGE.Setup.NotSetUp());
  const done: UndoDone = { removed: [], kept: [] };
  await undoHelper(options, record.helper, done);
  for (const entry of record.switches) await undoSwitch(options, entry, done);
  await undoPluginsFolder(options, record, done);
  await rm(setupFolder(options.storage), { recursive: true, force: true });
  return done;
}
