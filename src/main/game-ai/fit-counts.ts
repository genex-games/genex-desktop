/**
 * Fit from real play (D12's follow-up): with the person's usage-stats consent (Settings → Play-time
 * AI, `shareFitCounts`), every reply a published game gets on a model the person runs is counted as
 * fitting the game's shape or not, per (game, door, model, ISO week). The counts are all that is
 * kept or sent: never a prompt, an answer or who played. genex.games adds them up so a model nobody
 * checked still gets its Best or may-struggle tag, at no cost.
 *
 * Without consent nothing is counted; turning it off drops what is waiting. Counts wait in
 * `userData/game-ai/fit-counts.json` (outside every agent-writable root) and go to genex.games at
 * most every {@link FIT_SEND_INTERVAL_MS}; a send that fails keeps them for the next, and a count
 * made while a send is under way is never lost.
 */
import path from "node:path";
import { HOUR_MS } from "../../shared/duration.ts";
import {
  AI_FIT_MODEL_MAX_CHARS,
  type AiFitCountRow,
  mergeFitCounts,
  readAiFitCountRow,
} from "../../shared/game-ai-check.ts";
import { AiDoor, AiErrorCode, AiGameKind, type AiGameKey, isPlainRecord } from "../../shared/game-ai.ts";
import { AiValidation } from "../../shared/game-ai-report.ts";
import { AsyncLock, atomicWriteJson, readJsonIfExists } from "../../substrate/fsx.ts";
import type { AiCallTrace, GameAiCaller, GameAiClock, GenexAiPlatform } from "./types.ts";

/** The file the waiting counts live in, inside play-time AI's own folder. */
export const FIT_COUNTS_FILE = "fit-counts.json";
/** How often waiting counts go to genex.games. */
export const FIT_SEND_INTERVAL_MS = 6 * HOUR_MS;
/** The most rows that wait; past it the oldest weeks are dropped first. */
export const FIT_MAX_WAITING_ROWS = 2_000;
/** The saved file's version. */
const FILE_VERSION = 1;

/** Doors whose answers are not a model's reply to this play: replays and fixtures. */
const NOT_A_MODEL: readonly AiDoor[] = [AiDoor.Tape, AiDoor.Fixture];
/** A call with no reply still counts when the model itself failed it. */
const MODEL_FAILURES: readonly AiErrorCode[] = [AiErrorCode.Timeout, AiErrorCode.Provider];

/** What the counter needs. */
export interface FitCountsDeps {
  clock: GameAiClock;
  /** Play-time AI's own folder (`userData/game-ai`). */
  dir: string;
  /** The person's usage-stats consent, read on every record and send. */
  consent(): Promise<boolean>;
  send: GenexAiPlatform["sendFitCounts"];
}

/** The fit-from-play counter. */
export interface GameAiFitCounts {
  /** Count one settled call, if the person consents and it was a model's reply to a published game. */
  record(caller: GameAiCaller, trace: AiCallTrace): Promise<void>;
  /** Send what waits when it is due (or now, with `force`); keeps it when the send fails. */
  flush(force?: boolean): Promise<void>;
}

/** What the file holds. */
interface Saved {
  rows: AiFitCountRow[];
  lastAttemptAt: number | null;
}

/** The ISO week (`2026-W43`) of a time. */
export function isoWeek(ms: number): string {
  const date = new Date(ms);
  const day = date.getUTCDay() || 7;
  // The week's Thursday decides its year.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / (24 * HOUR_MS) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const isPublished = (game: AiGameKey): boolean => game.startsWith(`${AiGameKind.Play}:`);

/** The model id a count is kept under: the one the provider says ran, else the grant's. */
function modelOf(trace: AiCallTrace): string | null {
  const model = trace.servedModel ?? trace.model?.model ?? null;
  return model && model.length <= AI_FIT_MODEL_MAX_CHARS ? model : null;
}

/** How one call counts: a fitting reply, an invalid one, a model's failure, or not at all. */
function countOf(trace: AiCallTrace): Pick<AiFitCountRow, "calls" | "fitted" | "invalid"> | null {
  if (trace.validation === AiValidation.Valid || trace.validation === AiValidation.Repaired)
    return { calls: 1, fitted: 1, invalid: 0 };
  if (trace.validation === AiValidation.Invalid) return { calls: 1, fitted: 0, invalid: 1 };
  return trace.code !== null && MODEL_FAILURES.includes(trace.code) ? { calls: 1, fitted: 0, invalid: 0 } : null;
}

/** The row one call adds, or null when it is not counted. */
function rowOf(caller: GameAiCaller, trace: AiCallTrace, week: string): AiFitCountRow | null {
  const model = modelOf(trace);
  const count = countOf(trace);
  const counted = isPublished(caller.game) && !caller.replaying && !NOT_A_MODEL.includes(trace.door);
  if (!counted || !model || !count) return null;
  return { game: caller.game, door: trace.door, model, week, ...count };
}

/** The saved file as hostile input: its well-formed rows, or nothing. */
function readSaved(raw: unknown): Saved {
  if (!isPlainRecord(raw) || raw.v !== FILE_VERSION || !Array.isArray(raw.rows))
    return { rows: [], lastAttemptAt: null };
  const rows = raw.rows.map(readAiFitCountRow).filter((row) => row !== null);
  const at = raw.lastAttemptAt;
  return { rows, lastAttemptAt: typeof at === "number" && Number.isFinite(at) ? at : null };
}

/** `rows` without what `sent` sent: a count added while it was on its way stays. */
function subtract(rows: readonly AiFitCountRow[], sent: readonly AiFitCountRow[]): AiFitCountRow[] {
  const negative = sent.map((row) => ({ ...row, calls: -row.calls, fitted: -row.fitted, invalid: -row.invalid }));
  return mergeFitCounts([...rows, ...negative]).filter((row) => row.calls > 0);
}

/** At most {@link FIT_MAX_WAITING_ROWS}, the newest weeks kept. */
function bounded(rows: AiFitCountRow[]): AiFitCountRow[] {
  if (rows.length <= FIT_MAX_WAITING_ROWS) return rows;
  return [...rows].sort((a, b) => b.week.localeCompare(a.week)).slice(0, FIT_MAX_WAITING_ROWS);
}

/** The fit-from-play counter over `deps`. */
export function createFitCounts(deps: FitCountsDeps): GameAiFitCounts {
  const file = path.join(deps.dir, FIT_COUNTS_FILE);
  const lock = new AsyncLock();
  let sending: Promise<void> | null = null;

  const load = async (): Promise<Saved> => readSaved(await readJsonIfExists<unknown>(file).catch(() => null));
  const save = (saved: Saved) => atomicWriteJson(file, { v: FILE_VERSION, ...saved });

  const record = async (caller: GameAiCaller, trace: AiCallTrace): Promise<void> => {
    const row = rowOf(caller, trace, isoWeek(deps.clock.now()));
    if (!row || !(await deps.consent())) return;
    await lock.run(async () => {
      const saved = await load();
      await save({ ...saved, rows: bounded(mergeFitCounts([...saved.rows, row])) });
    });
  };

  /** One send: what waits now, sent outside the lock, then taken off what waits by then. */
  const sendOnce = async (force: boolean): Promise<void> => {
    const consent = await deps.consent();
    const batch = await lock.run(async () => {
      const saved = await load();
      if (!consent) {
        if (saved.rows.length) await save({ rows: [], lastAttemptAt: saved.lastAttemptAt });
        return null;
      }
      const due =
        force || saved.lastAttemptAt === null || deps.clock.now() - saved.lastAttemptAt >= FIT_SEND_INTERVAL_MS;
      if (!due || !saved.rows.length) return null;
      await save({ ...saved, lastAttemptAt: deps.clock.now() });
      return saved.rows;
    });
    if (!batch) return;
    await deps.send(batch);
    await lock.run(async () => {
      const saved = await load();
      await save({ ...saved, rows: subtract(saved.rows, batch) });
    });
  };

  const flush = (force = false): Promise<void> => {
    sending ??= sendOnce(force)
      .catch(() => {})
      .finally(() => {
        sending = null;
      });
    return sending;
  };

  return { record, flush };
}
