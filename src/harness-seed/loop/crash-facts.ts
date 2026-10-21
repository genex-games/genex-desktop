/**
 * Crash facts (game systems CRASH-6): what a builder is told when the run it is judged on crashed.
 *
 * The host keeps a game's crash records (`genex-crash/1`: a Rust panic, a lost device, a native
 * fault, a hang) and answers them with `game.crashes`, newest first. When a look finds its window
 * crashed (`preview.status` `crashed`) or its native run crashed (`native.status`), the pass reads
 * the newest record and hands the builder its kind, message, place, seed, tick, the game's own top
 * frames when the host symbolicated them, and whether the input to replay it was kept.
 *
 * A host that does not answer `game.crashes`, keeps no records yet, or kept none for this pass
 * gives no facts, and the look says exactly what it always said. Every record comes from the game,
 * so what is read here is cut to size and never trusted beyond its shape.
 */
import { HostMethod } from "./host-methods.ts";
import { isRecord } from "./json.ts";
import { NativeRunState } from "./native-contract.ts";
import { clipMarked } from "./text.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import type { CrashKind, CrashLocation, CrashSource, GameCrashEntry } from "../types/host-api.d.ts";

/** The most of the game's own frames a builder is shown. */
const CRASH_FACT_FRAMES = 4;
/** The longest message, function name and source path the facts keep. */
const MESSAGE_CHARS = 240;
const FUNCTION_CHARS = 120;
const PATH_CHARS = 160;

/**
 * Where a panic's own machinery lives: frames inside these crates are how Rust reports a panic,
 * never where the game went wrong, so the builder is shown the frames after them.
 */
const RUNTIME_FRAME_PREFIXES = [
  "std::",
  "core::",
  "alloc::",
  "genex_crash::",
  "rust_begin_unwind",
  "rust_panic",
  "__rust",
  "<std::",
  "<core::",
  "<alloc::",
];

/** Whether the input to replay the crash was kept, and from where. */
export interface CrashReplayFacts {
  seed: number;
  fromTick: number;
  toTick: number;
  /** False when the game's input ring overflowed or was busy, so the track starts late or is missing. */
  complete: boolean;
  /** The record carries input rows (a track), not only the seed and tick to start from. */
  rows: boolean;
}

/** The newest crash record of a look, as a builder reads it. */
export interface CrashFacts {
  crashId: string;
  kind: CrashKind;
  source: CrashSource;
  fatal: boolean;
  message: string;
  location: CrashLocation | null;
  tick: number | null;
  seed: number | null;
  /** The game's own top frames, `function (file:line)`, when the host symbolicated the record. */
  frames: string[];
  symbolicated: boolean;
  replay: CrashReplayFacts | null;
  /** How many runs crashed with the same signature. */
  repeat: number;
}

/** What a look asks about: its game, its window, whether it judged a native run, and when it began. */
export interface CrashFactsRequest {
  project: string;
  handle?: string | null;
  /** A native run: the host's `native.status` names its crash record. */
  native: boolean;
  /** When the look began (ISO 8601): a record kept before it belongs to another run. */
  since: string;
}

/**
 * The newest crash record of this look, or null: a native run that did not crash, a host that
 * keeps no records (an older one answers nothing, or `unavailable`), or none kept since the look
 * began. Never throws: a crash read is a fact for the builder, never a reason to fail a pass.
 */
export async function readCrashFacts(ctx: HarnessCtx, request: CrashFactsRequest): Promise<CrashFacts | null> {
  try {
    const query = await crashQuery(ctx, request);
    if (!query) return null;
    const answer: unknown = await ctx.call(HostMethod.GameCrashes, query).catch(() => null);
    const records = isRecord(answer) && Array.isArray(answer.records) ? answer.records : [];
    return records.length ? crashFactsOf(records[0]) : null;
  } catch {
    return null;
  }
}

/** What `game.crashes` is asked: the record a native run's status names, else the ones since the look began. */
async function crashQuery(
  ctx: HarnessCtx,
  { project, handle, native, since }: CrashFactsRequest,
): Promise<{ project: string; id?: string; since?: string } | null> {
  if (!native) return { project, since };
  const params = typeof handle === "string" && handle ? { project, handle } : { project };
  const status: unknown = await ctx.call(HostMethod.NativeStatus, params).catch(() => null);
  if (!isRecord(status)) return null;
  const crashId = isRecord(status.crash) && typeof status.crash.crashId === "string" ? status.crash.crashId : null;
  if (crashId) return { project, id: crashId };
  return status.state === NativeRunState.Crashed ? { project, since } : null;
}

/** One kept record as facts, or null when it is not a record's shape. */
export function crashFactsOf(value: unknown): CrashFacts | null {
  if (!isRecord(value) || typeof value.crashId !== "string" || !isRecord(value.record)) return null;
  const entry = value as unknown as GameCrashEntry;
  const record = entry.record as unknown as AnyRecord;
  if (typeof record.kind !== "string") return null;
  const context = isRecord(record.context) ? record.context : {};
  return {
    crashId: entry.crashId,
    kind: record.kind as CrashKind,
    source: record.source as CrashSource,
    fatal: record.fatal === true,
    message: oneLine(record.message, MESSAGE_CHARS),
    location: locationOf(record.location),
    tick: wholeOrNull(context.tick),
    seed: wholeOrNull(context.seed),
    frames: entry.symbolicated === true ? gameFrames(entry.symbols) : [],
    symbolicated: entry.symbolicated === true,
    replay: replayOf(record.replay),
    repeat: wholeOrNull(entry.repeat) ?? 1,
  };
}

/** The record's source place, cut to size; null when it has none. */
function locationOf(value: unknown): CrashLocation | null {
  if (!isRecord(value) || typeof value.file !== "string") return null;
  return {
    file: oneLine(value.file, PATH_CHARS),
    line: wholeOrNull(value.line) ?? 0,
    column: wholeOrNull(value.column) ?? 0,
  };
}

/** What the record kept to replay the crash. */
function replayOf(value: unknown): CrashReplayFacts | null {
  if (!isRecord(value)) return null;
  const seed = wholeOrNull(value.seed);
  const fromTick = wholeOrNull(value.fromTick);
  const toTick = wholeOrNull(value.toTick);
  if (seed === null || fromTick === null || toTick === null) return null;
  const rows = typeof value.track === "string" && value.track.length > 0;
  return { seed, fromTick, toTick, complete: value.complete === true, rows };
}

/** The game's own top frames, past the panic machinery: each frame's innermost function and its place. */
function gameFrames(symbols: unknown): string[] {
  if (!isRecord(symbols) || !Array.isArray(symbols.frames)) return [];
  const named: string[] = [];
  for (const frame of symbols.frames) {
    if (named.length >= CRASH_FACT_FRAMES) break;
    const said = frameLine(frame);
    if (said) named.push(said);
  }
  return named;
}

/** `function (file:line)` for a frame in the game's image, or null for a foreign or runtime frame. */
function frameLine(frame: unknown): string | null {
  if (!isRecord(frame) || frame.foreign !== false || !Array.isArray(frame.functions)) return null;
  const inner = frame.functions[0];
  if (!isRecord(inner) || typeof inner.function !== "string") return null;
  const name = oneLine(inner.function, FUNCTION_CHARS);
  if (RUNTIME_FRAME_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  const line = wholeOrNull(inner.line);
  const place =
    typeof inner.file === "string" ? `${oneLine(inner.file, PATH_CHARS)}${line === null ? "" : `:${line}`}` : null;
  return place ? `${name} (${place})` : name;
}

/** A whole number at least zero, else null. */
function wholeOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/** Text on one line, at most `max` characters. */
function oneLine(value: unknown, max: number): string {
  return clipMarked(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}
