/**
 * The Loop's own names, on a project of any kind, led in place by the chat's own session: its tools,
 * its clock and caps, its journal (`journal.director.open`) and what the run object carries for it
 * (`LoopRun.open`).
 */
import { setTimeout as idle } from "node:timers/promises";
import type { AnyRecord, Run } from "../../../types/harness.d.ts";
import type { FactRef, FolderHolds } from "../../folder-facts.ts";
import { HookEvent, type HookedGame, hooksOn } from "../../hooks.ts";
import { MINUTE_MS, SECOND_MS } from "../../time.ts";
import type { WorkerPool } from "../../workers/pool.ts";
import type { AppSeen } from "./app-look.ts";

/** The open lead's own tools, by the names its engine sends. Never rename a value. */
export const OpenTool = { SavePoint: "save_point", Rewind: "rewind", Restart: "restart", Pause: "pause" } as const;
export type OpenTool = (typeof OpenTool)[keyof typeof OpenTool];

/** How often Genex asks the project's app whether it is well, when a plugin hooks `health`. */
export const HEALTH_POLL_MS = 15 * SECOND_MS;
/**
 * How many times Genex reopened a stopped app before it went back to the last save point. Kept for a
 * `health.ts` an agent kept from before, which a caller kept from before may still run: none, as
 * Genex reopens no app now, so its recovery tries no reopen, finds nothing to give up and takes
 * nothing back.
 */
export const MAX_REOPENS = 0;
/**
 * How many times Genex handed a stopped app it couldn't bring back to the lead before the Loop paused.
 * Kept for a `health.ts` an agent kept from before: Genex hands nothing over, and pauses no Loop.
 */
export const MAX_HANDOFFS = 3;
/**
 * How long a lead that paused its Loop has to end its turn with its words for the person before Genex
 * ends its session (director/news.ts). Ended at once, its own `pause` call was cut off before it
 * answered: Claude Code answered it "The user doesn't want to take this action right now", and the
 * lead told the person they had declined the pause (sword duel).
 */
export const PAUSE_END_MS = 30 * SECOND_MS;
/** How long, from the lead's pause, a call of Genex's tools still answering (the pause's own included) holds off the end of its session. */
export const PAUSE_CALLS_MS = 2 * MINUTE_MS;
/** What a yes still needs of the lead's `finish` call: the workers settled and the last checkpoint. */
export const OPEN_CLOSE_MS = 2 * MINUTE_MS;
/** The longest save point label Genex keeps. */
export const MAX_SAVE_POINT_LABEL = 80;
/** The Genex credits an open Loop's paid jobs may commit when its run record names none. */
export const DEFAULT_CREDIT_CAP = 600;

/** One of the lead's save points: Genex's checkpoint of the game folder, with the plugins' notes. */
export interface OpenSavePoint {
  label: string;
  summary: string;
  snapshotId: string;
  /** Genex took it between turns (an autosave), not the lead. */
  auto: boolean;
  at: number;
  notes: string[];
  /** The picture in the project's folder the lead named as showing what changed; absent when it named none. */
  shows?: string | null;
}

/** A rewind the lead asked for: the save point's label, and the snapshot that label named when it asked. */
export interface OpenRewind {
  label: string;
  snapshotId: string;
}

/** What an open Loop keeps in its journal beside the director's record (`journal.director.open`). */
export interface OpenJournal {
  version: 1;
  savePoints: OpenSavePoint[];
  /** What the lead asked for when its turn ends: the save point to go back to (resolved when asked), a restart. */
  between: { rewind: OpenRewind | null; restart: boolean };
  /** How many times the watch saw the project's app stop answering (`app-look.ts`). */
  crashes: number;
}

/** Whether the lead asked for a rewind or a restart that its turn's end has not run yet. */
export function asksPending(journal: OpenJournal): boolean {
  return Boolean(journal.between.rewind || journal.between.restart);
}

/** An open Loop's journal before anything happened. */
export function newOpenJournal(): OpenJournal {
  return {
    version: 1,
    savePoints: [],
    between: { rewind: null, restart: false },
    crashes: 0,
  };
}

/** Whether a value is a plain record. */
const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A save point as a journal kept it, or null when it is not one. */
function savePointOf(value: unknown): OpenSavePoint | null {
  if (!isRecord(value) || typeof value.label !== "string" || typeof value.snapshotId !== "string") return null;
  return {
    label: value.label,
    summary: typeof value.summary === "string" ? value.summary : "",
    snapshotId: value.snapshotId,
    auto: value.auto === true,
    at: typeof value.at === "number" ? value.at : 0,
    notes: Array.isArray(value.notes) ? value.notes.filter((note): note is string => typeof note === "string") : [],
  };
}

/** A rewind as a journal kept it, or null when it holds none. */
function rewindOf(value: unknown): OpenRewind | null {
  if (!isRecord(value) || typeof value.label !== "string" || typeof value.snapshotId !== "string") return null;
  return { label: value.label, snapshotId: value.snapshotId };
}

/** A count a journal kept, or zero. */
const countOf = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;

/** The open Loop's record a saved journal holds (`director.open`), read field by field; null when it holds none. */
export function openJournalOf(saved: AnyRecord | null | undefined): OpenJournal | null {
  const open = saved?.director?.open;
  if (!isRecord(open)) return null;
  const between = isRecord(open.between) ? open.between : {};
  return {
    version: 1,
    savePoints: (Array.isArray(open.savePoints) ? open.savePoints : [])
      .map(savePointOf)
      .filter((point): point is OpenSavePoint => point !== null),
    between: { rewind: rewindOf(between.rewind), restart: between.restart === true },
    crashes: countOf(open.crashes),
  };
}

/** The open Loop's clock: the wake loop's, so a test drives the workers, the reviewer and the turns alike. */
export interface OpenClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * The wall clock, for an open Loop whose caller names none. Its waits never hold the process open by
 * themselves: the harness keeps itself running (its host channel and heartbeat), and a wait that lost
 * a race (an observer's deadline, a pool's close) is left with nothing waiting on it.
 */
export const OPEN_WALL_CLOCK: OpenClock = { now: () => Date.now(), sleep: (ms) => idle(ms, undefined, { ref: false }) };

/** What a run leading an open Loop carries for it (`LoopRun.open`). */
export interface OpenLoop {
  /** What the game's folder holds, and whether Genex could read it. */
  facts: readonly FactRef[];
  holds: FolderHolds | null;
  /** The moments the game's plugins hook, as `game.list` listed them. */
  hookEvents: readonly string[];
  /** Genex's eyes reach the game (`seenInWindow`): the lead's turns get the window its chat's turns have. */
  seen: boolean;
  journal: OpenJournal;
  /** Why the Loop pauses: its lead's words for the person (`pause`), once it asked; null while it runs. */
  halted: string | null;
  /** When its lead asked to pause, on the Loop's clock: a call still answering holds its session up to `PAUSE_CALLS_MS` from then. */
  haltedAt?: number;
  /** When its lead's `pause` call answered, on the Loop's clock: it has `PAUSE_END_MS` from then to end its turn itself. */
  haltAnsweredAt?: number;
  /** The save point count when the lead's turn under way began: a turn that saved none is autosaved. */
  turnSavedFrom: number;
  /**
   * A session of the lead's read its message in this attempt (`../news.ts`): a Stop before any did is
   * a stopped start (nothing kept), however long the first turn waited.
   */
  sessionWorked: boolean;
  /** Genex's work between the lead's turns is under way: no look at the project's app starts meanwhile. */
  betweenTurns: boolean;
  /** Chains a git write to the game folder after the one before it: the lead's saves, the workers' merges. */
  gitWrite: <T>(write: () => Promise<T>) => Promise<T>;
  clock: OpenClock;
  /** The run's own worker pool, opened as the Loop starts. */
  pool: WorkerPool | null;
  /** When the Loop (this process) took the project up: unsaved work and fresh eyes count from here at the least. */
  since: number;
  /** When Genex last asked the project's app whether it is well (the watch and the start's look, `app-look.ts`). */
  healthAt: number;
  /**
   * What Genex last saw of the project's app: answering, not answering, or null before a look a
   * step answered. The start's look sets it (`app-look.ts` `appAtStart`), and so does the wait after
   * the lead's rewind or restart (`sawAfterAsk`); the watch goes on from it, so each change is said
   * once. A kept setup leaves it unset.
   */
  appSeen?: AppSeen | null;
  /** A session call of the lead's is under way (`../news.ts` watches it): only then does a pause end a session in the folder. */
  inTurn: boolean;
  /** A look at the project's app under way (`app-look.ts`): one at a time, never awaited by the wake loop's reads. */
  healthLook: Promise<void> | null;
}

/** Whether a plugin of the project restarts its app (`restore.before` or `restore.after`): its lead is offered `restart`. */
export function restartsApp(game: HookedGame): boolean {
  return hooksOn(game, HookEvent.RestoreBefore) || hooksOn(game, HookEvent.RestoreAfter);
}

/** The run's Genex credit cap: its record's own whole number, or null when it names none. */
export function creditCapOf(run: Pick<Run, "budgets"> | null | undefined): number | null {
  const own = (run?.budgets as AnyRecord | undefined)?.creditCap;
  return typeof own === "number" && Number.isSafeInteger(own) && own >= 0 ? own : null;
}

/** One git write at a time to a game folder: each waits for the one before it, and a failure blocks none after it. */
export function gitQueue(): <T>(write: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(write: () => Promise<T>): Promise<T> => {
    const next = last.then(write);
    last = next.catch(() => {});
    return next;
  };
}
