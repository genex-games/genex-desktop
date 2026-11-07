/**
 * The Loop's run as one explicit object, and the functions of it every part shares. `prepareLoopRun`
 * (setup.ts) builds it: the run, the project's own folder the lead builds in, `state` (the log, the
 * close), the journal and the report. Every function of the run takes it as its first argument;
 * `bindLoopRun` puts each on the object as well, so a function reaches the others through the run it
 * was handed.
 */
import { appendRun as appendRunEvent, RunEvent, saveJournal as saveRunJournal } from "../run-events.ts";
import type { FactRef } from "../folder-facts.ts";
import type { HookedGame } from "../hooks.ts";
import { isWorking, type WorkerRecord } from "../workers/records.ts";
import { journalText, recordLoopRun } from "./journal.ts";
import { plainly } from "./rules.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { EngineLimit } from "../outage.ts";
import type { RunInbox } from "../run-inbox.ts";
import type { FinishAsk } from "./wrap-up.ts";
import type { LeadSeat } from "./lead-session.ts";
import type { OpenLoop } from "./open/contract.ts";
import type { NoteKind } from "./wake-schedule.ts";
import type { FinishTally } from "../finish-check.ts";
import type * as loopRunFunctions from "./loop-run.ts";

/** One line of the run's log (`note`): one of Genex's facts for the lead. */
export interface LoopRunLogEntry {
  at: number;
  seq: number;
  text: string;
  /** What it is about (wake-schedule.ts decides what wakes the lead); a line an earlier seed wrote may have none. */
  kind?: NoteKind;
}

/** The run's `state`: the log and the close — everything that changes for the whole run. */
export interface LoopRunState {
  run: Run;
  threadId: string;
  projectDir: string;
  baseCommit: string | null;
  /** The provider loss that pauses the run: an engine limit, a lost sign-in, an outage the lead could not wait out. */
  limit: EngineLimit | null;
  log: LoopRunLogEntry[];
  finish: AnyRecord | null;
  finished: boolean;
  /** How many second opinions the lead asked for: their pictures are filed by it. */
  judges: number;
  /** The end number of the run's last job end the lead has had (`jobs.list`, loop/jobs/watch.ts). */
  jobsCursor?: number;
  /** Where the Loop's finish checks stand (open/finish.ts); absent until the lead claims the goal. */
  finishTally?: FinishTally;
  /** The user's ask to finish, as the lead recorded it with `wrap_up` (wrap-up.ts). */
  finishAsk?: FinishAsk | null;
}

/** How a lead's turn ended, for what waits for its end: `last` when it was the run's wrap-up turn, after which none comes. */
export type TurnEnds = { last: boolean };

/** What the run knows (`prepareLoopRun`, setup.ts). */
export interface LoopRunData {
  ctx: HarnessCtx;
  threadId: string;
  run: Run;
  resume: boolean;
  inbox: RunInbox;
  priorJournal: AnyRecord | null;
  /** What the game's folder holds (`game.list`'s `facts`). */
  gameFacts?: FactRef[];
  /** The game as far as Genex's moments go (`game.list`'s `hookEvents`). */
  game?: HookedGame;
  report: AnyRecord;
  /** The game folder: the lead and the run's merges work in it. */
  projectDir: string;
  baseCommit: string | null;
  state: LoopRunState;
  journal: AnyRecord;
  logSeq: number;
  waitSeq: number;
  toolCalls: number;
  /** The lead's tool calls under way (open/tools.ts): a turn inside one is never cut short for the chat. */
  toolsInFlight?: number;
  /** The wake loop drives the lead's session (wake.ts sets it as it starts). */
  waking?: boolean;
  /** The run's wrap-up started (wake.ts `startWrapUp`): the lead's turn under way, or its next, is its last. */
  wrapping?: boolean;
  /** The lead: its chat's own session, in the game folder (lead-session.ts). */
  lead?: LeadSeat | null;
  /** Genex's context, the lead's system text: the same as its chat's own turns send (chat-session.ts `chatContext`). */
  context?: string;
  /** The log's sequence number the journal's last save holds (`saveJournal`). */
  journaledSeq?: number;
  /** The journal as its last save wrote it (journal.ts `journalText`). */
  journalSaved?: string | null;
  /** The Loop's own record (open/contract.ts): its facts, journal, git-write queue, clock and pool. */
  open: OpenLoop;
  /** How long the run worked in its earlier sessions, as its journal kept it (`director.worked`, work-time.ts). */
  workedBefore?: number;
  /** How many of the run's jobs ran when they were last read (null: the host could not say), and when (`active-work.ts`). */
  jobsRunning?: number | null;
  jobsReadAt?: number | null;
  /** What waits for the end of each of the lead's turns before the next (`last`: the run's wrap-up turn); the wake loop awaits it. */
  afterTurn?: (ends: TurnEnds) => Promise<void>;
}

/** A function of the run as the run carries it: bound, so the run itself is already given. */
type Bound<F> = F extends (loopRun: never, ...args: infer A) => infer R ? (...args: A) => R : never;
/** The names of a module's functions, as `bindLoopRun` binds them (a constant is not one). */
type FunctionKey<M> = { [K in keyof M]: M[K] extends (...args: never[]) => unknown ? K : never }[keyof M];
/** Every function of one of the run's modules, bound to the run (`bindLoopRun`). */
type BoundModule<M> = { readonly [K in Exclude<FunctionKey<M>, "bindLoopRun">]: Bound<M[K]> };

/** The run: its data, and every function of its module bound to it by `bindLoopRun`. */
export interface LoopRun extends LoopRunData, BoundModule<typeof loopRunFunctions> {}

/** The run's log keeps this many lines; the waker reads them by sequence number, not by index. */
const MAX_LOOP_RUN_LOG = 400;

/** Each run's own clock (the wake loop's), by its run object. */
const RUN_CLOCKS = new WeakMap<object, () => number>();

/** The run's own clock, for what reads the time outside the wake loop (`wrap_up` stamps the person's ask with it). */
export function keepRunClock(loopRun: LoopRun, now: () => number): void {
  RUN_CLOCKS.set(loopRun, now);
}

/** Now on the run's own clock, else the wall clock. */
export function runNow(loopRun: LoopRun): number {
  return RUN_CLOCKS.get(loopRun)?.() ?? Date.now();
}

/** One custom event on the run's thread, stamped with the run (run-events.ts: a failed write is logged, never thrown). */
export function appendRun(loopRun: LoopRun, event_type: RunEvent, payload: AnyRecord): Promise<unknown> {
  const { ctx, run, threadId } = loopRun;
  return appendRunEvent(ctx, threadId, event_type, payload, { runId: run.runId });
}

/**
 * A decision card. `text` is the record (shas, worker ids, the engine's own words); `plain` is the
 * one sentence the chat shows someone who is not reading git.
 */
export function decision(loopRun: LoopRun, text: string, plain?: string | null): Promise<unknown> {
  return loopRun.appendRun(RunEvent.AutopilotDecision, {
    decision: text,
    text,
    plain: plainly(plain ?? text),
    at: new Date().toISOString(),
  });
}

/**
 * Save the run's journal, with the run's record on it (journal.ts `recordLoopRun`): what a Resume
 * goes on from. A save that would write what the last one wrote is not made.
 */
export async function saveJournal(loopRun: LoopRun): Promise<number | void> {
  const { ctx, journal, run, threadId } = loopRun;
  recordLoopRun(loopRun);
  const seq = loopRun.logSeq;
  const text = journalText(journal);
  const heldUpTo = () => {
    loopRun.journaledSeq = Math.max(loopRun.journaledSeq ?? 0, seq);
  };
  if (text !== null && text === loopRun.journalSaved) {
    heldUpTo();
    return;
  }
  loopRun.journalSaved = text;
  const version = await saveRunJournal(ctx, threadId, run.runId, journal);
  if (version !== undefined) heldUpTo();
  else if (loopRun.journalSaved === text) loopRun.journalSaved = null;
  return version;
}

/**
 * A line in the run's log: one of Genex's facts, which wakes a resting lead or reaches a working one
 * (director/news.ts). `kind` says what it is about; the waker decides by it.
 */
export function note(loopRun: LoopRun, text: string, kind: NoteKind): void {
  const { state } = loopRun;
  loopRun.logSeq += 1;
  state.log.push({ at: Date.now(), seq: loopRun.logSeq, text, kind });
  if (state.log.length > MAX_LOOP_RUN_LOG) state.log.shift();
}

/** Every line after `seq`. */
export function notesSince(loopRun: LoopRun, seq: number): LoopRunLogEntry[] {
  return loopRun.state.log.filter((entry) => (entry.seq ?? 0) > seq);
}

/** The workers of the run's pool still at work. */
export function runningWorkers(loopRun: LoopRun): WorkerRecord[] {
  return (loopRun.open.pool?.state.records ?? []).filter(isWorking);
}

/**
 * Put every function of the run on the object, bound to it, so a function destructures the ones it
 * calls from the run it was handed. `modules` are the run's module namespaces.
 */
export function bindLoopRun(
  data: Pick<LoopRunData, "ctx" | "threadId" | "run" | "resume">,
  modules: ReadonlyArray<Record<string, unknown>>,
): LoopRun {
  const loopRun = data as LoopRun;
  const slots = loopRun as unknown as Record<string, unknown>;
  for (const module of modules) {
    for (const [name, fn] of Object.entries(module)) {
      if (typeof fn !== "function" || name === "bindLoopRun" || name === "prepareLoopRun") continue;
      slots[name] = (...args: unknown[]) => fn(loopRun, ...args);
    }
  }
  return loopRun;
}
