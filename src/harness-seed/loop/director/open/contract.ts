/**
 * The open Loop's own names: a Loop on a project that isn't a web game, led in place by the chat's
 * own session. Its tools, its clocks and caps, its journal (`journal.director.open`) and what the
 * run object carries for it (`LoopRun.open`). A module new to the seed, so the shipped parts that
 * read it (director.ts, setup.ts, wake.ts) need no new name from a module an agent may have kept.
 */
import { setTimeout as idle } from "node:timers/promises";
import type { AnyRecord, Run } from "../../../types/harness.d.ts";
import type { FactRef, FolderHolds } from "../../folder-facts.ts";
import { HookEvent, type HookedGame, hooksOn } from "../../hooks.ts";
import { MINUTE_MS, SECOND_MS } from "../../time.ts";
import type { WorkerPool } from "../../workers/pool.ts";

/** This part serves a Loop on a project of any kind: a run reads it by namespace before it leads one. */
export const SERVES_OPEN_LOOP = true;

/**
 * Does every part an open Loop depends on serve one (`SERVES_OPEN_LOOP`)? A seed upgrade keeps a part
 * the agent edited before Loops on any project, which would prepare a web run on the folder or lack
 * the open Loop's wake-ups: such a run is refused with words, never led.
 */
export function servesOpenLoop(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_OPEN_LOOP === true);
}

/** The open lead's own tools, by the names its engine sends. Never rename a value. */
export const OpenTool = { SavePoint: "save_point", Rewind: "rewind", Restart: "restart", Pause: "pause" } as const;
export type OpenTool = (typeof OpenTool)[keyof typeof OpenTool];

/** A turn of the open lead's lasts at most this long; it goes on at once after. */
export const OPEN_TURN_MS = 45 * MINUTE_MS;
/** The lead hears a reminder to save this long after its last save point, while a turn works. */
export const SAVE_REMINDER_MS = 15 * MINUTE_MS;
/** How often Genex asks the project's app whether it is well, when a plugin hooks `health`. */
export const HEALTH_POLL_MS = 15 * SECOND_MS;
/** Genex reopens a stopped app at most this many times before it goes back to the last save point. */
export const MAX_REOPENS = 2;
/** The lead is reminded of a read-only worker's fresh look after this long without one. */
export const FRESH_EYES_MS = 45 * MINUTE_MS;
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
  /** Lines the lead's next message carries (what the plugins said, what Genex did between turns). */
  carried: string[];
  crashes: number;
  /** When the lead last started a read-only worker (the fresh look), or null. */
  lastReaderAt: number | null;
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
    carried: [],
    crashes: 0,
    lastReaderAt: null,
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
    carried: Array.isArray(open.carried) ? open.carried.filter((line): line is string => typeof line === "string") : [],
    crashes: countOf(open.crashes),
    lastReaderAt: typeof open.lastReaderAt === "number" ? open.lastReaderAt : null,
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

/**
 * The game folder at a turn's edge: its commit, and its content as one tree id (every file git
 * doesn't ignore, as a commit would take it), so a second edit of a file already changed still
 * reads as a change; null where git couldn't say.
 */
export interface OpenFolderMark {
  head: string | null;
  tree: string | null;
}

/**
 * What the lead's turn began with (`writers.ts`), held against its end: how many workers the pool had
 * and how many of them the lead had marked, its writers in place at work and those waiting on the
 * person, the run's jobs that write beside the lead running and the last of their ends, whether a
 * recovery of the project's app was under way, and how many had started and taken the folder back.
 */
export interface TurnStart {
  records: number;
  marked: number;
  writers: string[];
  waiting: string[];
  writerJobs: number;
  writerJobEndSeq: number;
  recovering: boolean;
  recoveries: number;
  restores: number;
}

/**
 * A turn whose work is read only from the folder's content while someone else may have written in it
 * (`between.ts`) is the lead's at most this many times in a row: after that the lead rests while that
 * writer works, or is asked what next.
 */
export const MAX_UNCLEAR_TURNS = 2;

/**
 * A turn whose only sign of work is the folder's content changing while the lead's own session shows
 * no act of its own (no tool call: `sessionActed`; no save point of its own; nobody else known to
 * write) is the lead's at most this many times in a row: something outside the run may be writing
 * there (the project's own app or tools, the person, another chat). A session that acted, a save point
 * of its own, or any other act of the lead's, starts the count again.
 */
export const MAX_FOLDER_ONLY_TURNS = 4;

/** What a run leading an open Loop carries for it (`LoopRun.open`). */
export interface OpenLoop {
  /** What the game's folder holds, and whether Genex could read it. */
  facts: readonly FactRef[];
  holds: FolderHolds | null;
  /** The moments the game's plugins hook, as `game.list` listed them. */
  hookEvents: readonly string[];
  journal: OpenJournal;
  /** Why the Loop pauses (the app could not be brought back), once it must; null while it runs. */
  halted: string | null;
  /** Why the Loop closes before its first turn (a paused run's journal it can't read); null when it runs. */
  refused: string | null;
  /** The refused run stays paused (another kind of Loop's journal), rather than closing for good. */
  refusalPauses: boolean;
  /** The save point count when the lead's turn under way began: a turn that saved none is autosaved. */
  turnSavedFrom: number;
  /** The lead's last turn did something (`between.ts`): it was no idle turn. */
  turnWorked: boolean;
  /** The game folder as the lead's turn under way began (`between.ts`); null before its first turn. */
  turnMark: OpenFolderMark | null;
  /** When `turnMark` was read, on the Loop's clock: one read long before the turn began is read again. */
  turnMarkAt: number | null;
  /** What the turn under way began with (`writers.ts`): who else may write in the folder; null before its first turn. */
  turnStart: TurnStart | null;
  /**
   * How many turns in a row whose work was read only from the folder's content while someone else may
   * have written in it counted as the lead's (`MAX_UNCLEAR_TURNS`).
   */
  unclearStreak: number;
  /** How many turns in a row whose only sign of work was the folder's content counted as the lead's (`MAX_FOLDER_ONLY_TURNS`). */
  folderOnlyStreak: number;
  /**
   * The lead's session in the turn under way took an act of its own (`news.ts` reads it from each of
   * the turn's session calls: a tool call, or a cut at its cap): a change of the folder in that turn,
   * nobody else known to write, is its work.
   */
  sessionActed: boolean;
  /**
   * A session of the lead's read its message in this attempt (`news.ts`): a Stop before any did is a
   * stopped start (nothing kept, none of the Loop's hours spent), however long the first turn waited.
   */
  sessionWorked: boolean;
  /** Genex couldn't read the folder's content at a turn's edge, and said so once on the run's feed. */
  treeUnread: boolean;
  /** Genex's work between the lead's turns is under way: no recovery of the project's app starts meanwhile. */
  betweenTurns: boolean;
  /** A rewind or restart was still waiting as the turn began (a recovery held it back): asked again, it is no new work. */
  askPending: boolean;
  /** A claim of this turn's a reviewer turned down, the Loop going on (`finish.ts`): the turn did something. */
  claimTurnedDown: boolean;
  /** Chains a git write to the game folder after the one before it: the lead's saves, the workers' merges. */
  gitWrite: <T>(write: () => Promise<T>) => Promise<T>;
  clock: OpenClock;
  /** The run's own worker pool, opened as the Loop starts. */
  pool: WorkerPool | null;
  /** How many of the run's jobs ran when they were last read, and when (`active-work.ts`). */
  jobsRunning: number;
  jobsReadAt: number | null;
  /** How many of those may write in the game folder beside the lead (`writesBeside`), and the last of their ends (`endSeq`). */
  writerJobsRunning: number;
  writerJobEndSeq: number;
  /** The titles of those running jobs whose writer in place has ended (`active-work.ts`): only the lead can stop them now. */
  leftoverJobs: string[];
  /** When the Loop (this process) took the project up: unsaved work and fresh eyes count from here at the least. */
  since: number;
  /** The log lines a turn under way took mid-turn, by sequence number: no digest tells them again (`news.ts`). */
  heard: Set<number>;
  /** The workers' questions already told, by `<worker>:<question>`: each is told once. */
  asked: Set<string>;
  /** When Genex last asked the project's app whether it is well (`health.ts`). */
  healthAt: number;
  /** A session call of the lead's is under way (`news.ts` watches it): only then does a pause end a session in the folder. */
  inTurn: boolean;
  /** A recovery of the project's app under way: nothing is kept or restored between turns, a save point and a finish are refused. */
  recovering: Promise<void> | null;
  /** How many recoveries of the project's app started: one since a turn began means its writes may be Genex's. */
  recoveries: number;
  /** How many times a recovery took the folder back to a save point: a reviewer's yes given across one lapses. */
  restores: number;
  /**
   * The save point a recovery last took the folder back to; null before any. Until the lead hears it
   * (`news.ts` `wentBackUnheard`), a close says so and keeps nothing over it (`close.ts`).
   */
  wentBack: string | null;
  /** The run log's line that told the lead of that way back, once written; null before. */
  wentBackSeq: number | null;
  /** A look at the project's app under way (`health.ts`): one at a time, never awaited by the wake loop's reads. */
  healthLook: Promise<void> | null;
  /** The turn the save reminder was last said in, or null. */
  remindedTurn: number | null;
  /** When the fresh-eyes line was last said, or null. */
  freshEyesAt: number | null;
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
