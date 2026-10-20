/**
 * Host crash intake (game-systems PROFILE, CRASH-5): a native run's crash record, kept under the
 * game's own `.studio/crashes/` (the ignored Genex data folder) when the run ends, announced once
 * as `game_crashed` and listed by `game.crashes` and `studio:game.crashes`.
 *
 * - The record comes from the game's own `crash` event (the port keeps the last one per run), or
 *   the host makes one: `hang` for a run it killed for a call timeout, `process-exit` for an
 *   abnormal exit that sent none.
 * - The file name is the host's (`<runId>-<n>.json`, the run id the registry drew); nothing from the
 *   record names a path, and the folder is made by real path, a link on the way refused with no
 *   side effect.
 * - Records with one signature (kind, place and the top frames as distances from the image's
 *   anchor, so address-space layout does not split them) keep one file: the newest run's, with a
 *   `repeat` count. At most `GAME_CRASHES_MAX` files are kept; the oldest go first.
 */
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { constants as OS } from "node:os";
import path from "node:path";
import {
  CRASH_RECORD_FORMAT,
  CRASH_RECORD_MAX_BYTES,
  CrashKind,
  type CrashRecordV1,
  CrashSource,
  type GameCrashedPayload,
  type GameCrashEntry,
  type GameCrashesAnswer,
  GAME_CRASHES_MAX,
  parseCrashRecord,
} from "../../shared/crash-record.ts";
import { errorMessage } from "../../shared/errors.ts";
import { NativeRefusal, NativeRunState, type NativeRunStatus } from "../../shared/native-contract.ts";
import { createFileInDir, ensureDirBelow, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { fnv1a64Hex } from "../../substrate/native-game-port.ts";

/** The folder below a game's root that holds its crash records. */
export const GAME_CRASHES_DIR: readonly string[] = Object.freeze([".studio", "crashes"]);
/** The most bytes one kept entry may take: a record at its cap plus the host's own fields. */
const CRASH_ENTRY_MAX_BYTES = CRASH_RECORD_MAX_BYTES + 4 * 1024;
/** How many of the top frames a signature reads. */
const SIGNATURE_FRAMES = 8;
/** A run id as the registry draws it (`native-runs.ts`): 12 to 32 lowercase hex. */
const RUN_ID = /^[0-9a-f]{12,32}$/;
/** A kept entry's file name: the crash id and `.json`. */
const ENTRY_FILE = /^([0-9a-f]{12,32}-[1-9][0-9]{0,3})\.json$/;
/** The most runs one signature is counted over (a number that never overflows a display). */
const REPEAT_MAX = 1_000_000;
/** An exit code past this one is a shell's report of a signal: 128 + its number. */
const SIGNAL_EXIT_BASE = 128;

const MESSAGE = {
  hang: (refusal: NativeRefusal) => `the host ended the game: it stopped answering (${refusal})`,
  processExit: (code: number | null, signal: string | null) =>
    `the game ended abnormally and sent no crash record (exit ${code ?? "none"}${signal ? `, ${signal}` : ""})`,
  notKept: (project: string, error: string) => `game crashes: a crash record of ${project} was not kept: ${error}`,
  notAnnounced: (project: string, error: string) =>
    `game crashes: the crash record of ${project} was kept but not announced: ${error}`,
  badRunId: (runId: string) => `"${runId.slice(0, 64)}" is not a run id the host drew`,
} as const;

/** The run whose record is kept. */
export interface CrashedRun {
  project: string;
  runId: string;
}

/** What the store reaches, injected. */
export interface GameCrashStoreDeps {
  /** The game's own folder, checked against the allowed root; throws for one it may not write. */
  gameDir(project: string): Promise<string>;
  /** Appends the `game_crashed` event (the studio's main thread). */
  announce(payload: GameCrashedPayload): Promise<unknown>;
  now(): number;
  /** Where a record that was not kept is written (default: `console.warn`). */
  log?(line: string): void;
}

/** Keeps a run's crash record; answers the kept entry, or null when it was refused (logged, never thrown). */
export interface GameCrashStore {
  keep(run: CrashedRun, record: CrashRecordV1): Promise<GameCrashEntry | null>;
}

/** A kept entry on disk: the listed entry plus its signature. */
interface StoredCrash extends GameCrashEntry {
  signature: string;
}

/** The crash id the host gives a run's record (the registry's status names it before it is written). */
export function crashIdOf(runId: string): string {
  return `${runId}-1`;
}

/** A record in its wire shape (the anchor as `{ip}`), which `parseCrashRecord` reads back unchanged. */
export function crashWire(record: CrashRecordV1): Record<string, unknown> {
  return { ...record, anchor: record.anchor === null ? null : { ip: record.anchor } };
}

/** A frame as its distance from the anchor (or its image and offset), so ASLR does not change it. */
function relativeFrame(frame: CrashRecordV1["frames"][number], anchor: string | null): string {
  if (!("ip" in frame)) return `${frame.image}+${frame.offset}`;
  if (anchor === null) return frame.ip;
  const distance = BigInt(frame.ip) - BigInt(anchor);
  return distance < 0n ? `-0x${(-distance).toString(16)}` : `+0x${distance.toString(16)}`;
}

/** What makes two crashes the same: kind, place and the top frames relative to the anchor. */
export function crashSignature(record: CrashRecordV1): string {
  const place = record.location ? `${record.location.file}:${record.location.line}:${record.location.column}` : "";
  const frames = record.frames.slice(0, SIGNATURE_FRAMES).map((frame) => relativeFrame(frame, record.anchor));
  return fnv1a64Hex(new TextEncoder().encode(JSON.stringify([record.kind, place, frames])));
}

/** The record a run that ended so is owed by the host, when the game sent none: a hang or an abnormal exit. */
export function hostCrashRecord(
  ending: Pick<NativeRunStatus, "state" | "refusal" | "exit">,
  facts: { destination: string; tick?: number | null },
): CrashRecordV1 | null {
  const context = { destination: facts.destination, ...(typeof facts.tick === "number" ? { tick: facts.tick } : {}) };
  const timedOut = ending.refusal === NativeRefusal.Unresponsive || ending.refusal === NativeRefusal.GpuHang;
  if (ending.state === NativeRunState.Killed && timedOut && ending.refusal !== null)
    return hostRecord(CrashKind.Hang, MESSAGE.hang(ending.refusal), context);
  if (ending.state !== NativeRunState.Crashed) return null;
  const code = ending.exit?.code ?? null;
  return hostRecord(CrashKind.ProcessExit, MESSAGE.processExit(code, exitSignal(ending.exit)), context);
}

/** The signal an exit names: its own, or the one a shell reports as `128 + n` (exit 134 is SIGABRT). */
export function exitSignal(exit: NativeRunStatus["exit"]): string | null {
  if (!exit) return null;
  if (exit.signal) return exit.signal;
  if (exit.code === null || exit.code <= SIGNAL_EXIT_BASE) return null;
  const number = exit.code - SIGNAL_EXIT_BASE;
  return Object.entries(OS.signals).find(([, value]) => value === number)?.[0] ?? null;
}

function hostRecord(kind: CrashKind, message: string, context: CrashRecordV1["context"]): CrashRecordV1 {
  return {
    format: CRASH_RECORD_FORMAT,
    kind,
    source: CrashSource.Host,
    fatal: true,
    handled: false,
    message,
    location: null,
    thread: null,
    frames: [],
    anchor: null,
    images: [],
    gpu: null,
    wasm: null,
    context,
    replay: null,
    profile: null,
    hitches: [],
    symbols: null,
    trimmed: [],
  };
}

/** The `game_crashed` payload for a kept entry: only the fields the record has. */
function crashedPayload(project: string, entry: GameCrashEntry): GameCrashedPayload {
  const { record } = entry;
  const fields: GameCrashedPayload = {
    project,
    runId: entry.runId ?? undefined,
    crashId: entry.crashId,
    kind: record.kind,
    source: record.source,
    fatal: record.fatal,
    handled: record.handled,
    tick: record.context.tick,
    seed: record.context.seed,
    destination: record.context.destination,
    location: record.location ?? undefined,
    symbolicated: entry.symbolicated,
    repeat: entry.repeat,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** One kept file as an entry, or null for anything that is not one the host wrote under this name. */
function storedOf(value: unknown, crashId: string): StoredCrash | null {
  if (!isJsonObject(value) || value.crashId !== crashId) return null;
  const { runId, at, repeat, symbolicated, signature } = value;
  const runOk = runId === null || (typeof runId === "string" && RUN_ID.test(runId));
  const atOk = typeof at === "string" && Number.isFinite(Date.parse(at));
  const repeatOk = Number.isSafeInteger(repeat) && Number(repeat) >= 1 && Number(repeat) <= REPEAT_MAX;
  const signatureOk = typeof signature === "string" && /^[0-9a-f]{16}$/.test(signature);
  if (!runOk || !atOk || !repeatOk || !signatureOk || typeof symbolicated !== "boolean") return null;
  const record = parseCrashRecord(value.record);
  if (!record) return null;
  return { crashId, runId, at, repeat: Number(repeat), symbolicated, signature, record };
}

/** Every entry kept in `dir` (a folder the caller checked), newest first; a file that is not one is skipped. */
async function readEntries(dir: string): Promise<StoredCrash[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const entries: StoredCrash[] = [];
  for (const name of names) {
    const crashId = ENTRY_FILE.exec(name)?.[1];
    if (!crashId) continue;
    // No link followed, nothing but a regular file, never more than an entry's cap.
    const bytes = await readRegularFile(path.join(dir, name), CRASH_ENTRY_MAX_BYTES).catch(() => null);
    const entry = bytes ? storedOf(parseJson(bytes.toString("utf8")), crashId) : null;
    if (entry) entries.push(entry);
  }
  return entries.sort(newestFirst);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const newestFirst = (a: GameCrashEntry, b: GameCrashEntry): number =>
  Date.parse(b.at) - Date.parse(a.at) || (a.crashId < b.crashId ? 1 : -1);

const listed = ({ signature: _signature, ...entry }: StoredCrash): GameCrashEntry => entry;

/**
 * A game's crash records, newest first and at most `GAME_CRASHES_MAX`: those kept after `since`
 * (an ISO time; one that is not a time filters nothing) or the one `id` names. A crashes folder
 * reached through a link reads as empty.
 */
export async function readGameCrashes(
  gameDir: string,
  filter: { since?: string; id?: string },
): Promise<GameCrashesAnswer> {
  const dir = await crashesDirIfOwn(gameDir);
  if (dir === null) return { records: [] };
  const since = filter.since === undefined ? Number.NaN : Date.parse(filter.since);
  const records = (await readEntries(dir))
    .filter((entry) => !Number.isFinite(since) || Date.parse(entry.at) > since)
    .filter((entry) => filter.id === undefined || entry.crashId === filter.id)
    .slice(0, GAME_CRASHES_MAX)
    .map(listed);
  return { records };
}

/** The game's crashes folder by real path when every part of it is a folder of its own; null otherwise. */
async function crashesDirIfOwn(gameDir: string): Promise<string | null> {
  const root = await realpath(gameDir).catch(() => null);
  if (root === null) return null;
  let dir = root;
  for (const part of GAME_CRASHES_DIR) {
    dir = path.join(dir, part);
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory()) return null;
  }
  return dir;
}

/** The store `NativeRuns` hands each crashed run's record to; one write at a time per game. */
export function createGameCrashStore(deps: GameCrashStoreDeps): GameCrashStore {
  const queues = new Map<string, Promise<unknown>>();
  const log = deps.log ?? console.warn;
  const keep = async (run: CrashedRun, record: CrashRecordV1): Promise<GameCrashEntry | null> => {
    try {
      const entry = await keepOne(deps, run, record);
      await deps.announce(crashedPayload(run.project, entry)).catch((error: unknown) => {
        log(MESSAGE.notAnnounced(run.project, errorMessage(error)));
      });
      return entry;
    } catch (error) {
      log(MESSAGE.notKept(run.project, errorMessage(error)));
      return null;
    }
  };
  return {
    keep(run, record) {
      const before = queues.get(run.project) ?? Promise.resolve();
      const next = before.then(() => keep(run, record));
      queues.set(run.project, next);
      void next.finally(() => {
        if (queues.get(run.project) === next) queues.delete(run.project);
      });
      return next;
    },
  };
}

/** Writes one record: a new file, the older one of its signature removed, the oldest past the cap pruned. */
async function keepOne(deps: GameCrashStoreDeps, run: CrashedRun, record: CrashRecordV1): Promise<GameCrashEntry> {
  if (!RUN_ID.test(run.runId)) throw new Error(MESSAGE.badRunId(run.runId));
  const dir = await ensureDirBelow(await deps.gameDir(run.project), GAME_CRASHES_DIR);
  const entries = await readEntries(dir);
  const signature = crashSignature(record);
  const same = entries.filter((entry) => entry.signature === signature);
  const repeat = Math.min(REPEAT_MAX, 1 + Math.max(0, ...same.map((entry) => entry.repeat)));
  const crashId = crashIdOf(run.runId);
  const at = new Date(deps.now()).toISOString();
  const stored: StoredCrash = { crashId, runId: run.runId, at, repeat, symbolicated: false, signature, record };
  const text = `${JSON.stringify({ ...stored, record: crashWire(record) })}\n`;
  await createFileInDir(dir, `${crashId}.json`, text);
  const others = entries.filter((entry) => entry.signature !== signature && entry.crashId !== crashId);
  const pruned = [...same.filter((entry) => entry.crashId !== crashId), ...others.slice(GAME_CRASHES_MAX - 1)];
  for (const entry of pruned) await unlink(path.join(dir, `${entry.crashId}.json`)).catch(() => {});
  return listed(stored);
}
