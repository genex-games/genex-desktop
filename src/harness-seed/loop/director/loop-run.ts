/**
 * The Loop's run as one explicit object, and the functions of it every part shares. `prepareLoopRun`
 * (setup.ts) builds it: the run and its clock, the folder the lead builds in (a web game's
 * integration worktree, or the project's own folder for a Loop in place), `state` (the heads, the
 * log, the close), the journal and the report. Every function of the run takes it as its first
 * argument; `bindLoopRun` puts each on the object as well, so a function reaches the others through
 * the run it was handed.
 */
import { headOf, shortSha, updateRef } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { appendRun as appendRunEvent, RunEvent, saveJournal as saveRunJournal } from "../run-events.ts";
import type { FactRef, LoopProfile } from "../folder-facts.ts";
import type { HookedGame } from "../hooks.ts";
import { isWorking, type WorkerRecord } from "../workers/records.ts";
import { isCommit } from "../shell.ts";
import type { HealthCheck } from "../health-check.ts";
import { verdictRecord } from "../verdict.ts";
import { journalText, recordLoopRun } from "./journal.ts";
import { plainly } from "./rules.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { EngineLimit } from "../outage.ts";
import type { RunInbox } from "../run-inbox.ts";
import type { FinishAsk } from "./wrap-up.ts";
import type { LoopRunClock } from "./journal.ts";
import type { LeadSeat } from "./lead-session.ts";
import type { OpenLoop } from "./open/contract.ts";
import type { NoteKind } from "./wake-schedule.ts";
import type { FinishTally } from "../finish-check.ts";
import type { StopWhy } from "../finish-contract.ts";
import type { WorkerPool } from "../workers/pool.ts";
import type * as integrateFunctions from "./integrate.ts";
import type * as loopRunFunctions from "./loop-run.ts";
import type * as toolFunctions from "./tools.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** The last judge on the integration branch: the head it looked at, and that it answered. */
export interface LastJudge extends AnyRecord {
  head?: string | null;
  ok?: boolean;
}

/** One line of the run's log (`note`). */
export interface LoopRunLogEntry {
  at: number;
  seq: number;
  text: string;
  /** What it is about, when it was written outside the lead's own turn (wake-schedule.ts decides what wakes it). */
  kind?: NoteKind;
}

/** The run's `state`: the heads, the log and the close — everything that changes for the whole run. */
export interface LoopRunState {
  run: Run;
  threadId: string;
  projectDir: string;
  baseCommit: string | null;
  /** Where the lead builds: a web game's integration worktree, or the project's folder for a Loop in place. */
  integrationWorktree: string;
  integrationHead: string | null;
  /** The last health check of each head (health-check.ts), as merges and the close took them. */
  healthByHead: Map<string | null | undefined, HealthCheck>;
  /** Whether the integration head passed its last health check; null before one. */
  integrationHealthy: boolean | null;
  /** The provider loss that pauses the run: an engine limit, a lost sign-in, an outage the lead could not wait out. */
  limit: EngineLimit | null;
  log: LoopRunLogEntry[];
  finish: AnyRecord | null;
  finished: boolean;
  /** How many second opinions the lead asked for: their pictures are filed by it. */
  judges: number;
  softDeadline: number;
  finalDeadline: number;
  /** The end number of the run's last job end the lead has had (`jobs.list`, loop/jobs/watch.ts). */
  jobsCursor?: number;
  /** Where an open Loop's finish checks stand (open/finish.ts); absent until the lead claims the goal. */
  finishTally?: FinishTally;
  /** Why the run stopped short of its goal, as the close that ends it said; its result card reads it. */
  endedWhy?: StopWhy;
  /** The user's ask to finish, as the lead recorded it with `wrap_up` (wrap-up.ts). */
  finishAsk?: FinishAsk | null;
  /** The last judge the lead asked about the integration branch. */
  lastJudge?: LastJudge | null;
}

/** What the run knows (`prepareLoopRun`, setup.ts). */
export interface LoopRunData {
  ctx: HarnessCtx;
  threadId: string;
  run: Run;
  resume: boolean;
  inbox: RunInbox;
  started: number;
  softDeadline: number;
  finalDeadline: number;
  /** The run's own clock (journal.ts `loopRunClock`), which the journal keeps and a Resume goes on with. */
  clock?: LoopRunClock;
  priorJournal: AnyRecord | null;
  /** What the game's folder holds once it is ready (`game.list`'s `facts`). */
  gameFacts?: FactRef[];
  /** The game as far as Genex's moments go (`game.list`'s `hookEvents`). */
  game?: HookedGame;
  report: AnyRecord;
  projectDir: string;
  baseCommit: string | null;
  forkCommit: string | null;
  integrationWorktree: string;
  integrationRef: string;
  state: LoopRunState;
  journal: AnyRecord;
  logSeq: number;
  waitSeq: number;
  toolCalls: number;
  /** The lead's tool calls under way (tools.ts `handler`): a turn inside one is never cut short for the chat. */
  toolsInFlight?: number;
  /** The wake loop drives the lead's session (wake.ts sets it as it starts). */
  waking?: boolean;
  /** The lead rests between turns (wake.ts sets it). */
  resting?: boolean;
  /** The lead: its chat's own session, in the game folder (lead-session.ts). */
  lead?: LeadSeat | null;
  /** The log's sequence number the journal's last save holds (`saveJournal`). */
  journaledSeq?: number;
  /** The journal as its last save wrote it (journal.ts `journalText`). */
  journalSaved?: string | null;
  /** How the Loop works on its project (folder-facts.ts `loopProfileOf`): a web game's, or in place (`open`). */
  profile?: LoopProfile;
  /** A Loop in place's own record (open/contract.ts): its facts, journal, git-write queue, clock and pool. */
  open?: OpenLoop;
  /** A web game's Loop's worker pool (the run's pool, its workers' copies merging into the integration worktree). */
  pool?: WorkerPool | null;
  /** What waits for the end of each of the lead's turns before the next (an open Loop's); the wake loop awaits it. */
  afterTurn?: () => Promise<void>;
}

/** A function of the run as the run carries it: bound, so the run itself is already given. */
type Bound<F> = F extends (loopRun: never, ...args: infer A) => infer R ? (...args: A) => R : never;
/** The names of a module's functions, as `bindLoopRun` binds them (a constant such as `SERVES_LEAD` is not one). */
type FunctionKey<M> = { [K in keyof M]: M[K] extends (...args: never[]) => unknown ? K : never }[keyof M];
/** Every function of one of the run's modules, bound to the run (`bindLoopRun`). */
type BoundModule<M> = { readonly [K in Exclude<FunctionKey<M>, "bindLoopRun">]: Bound<M[K]> };

/** The run: its data, and every function of its modules bound to it by `bindLoopRun`. */
export interface LoopRun
  extends LoopRunData,
    BoundModule<typeof loopRunFunctions>,
    BoundModule<typeof toolFunctions>,
    BoundModule<typeof integrateFunctions> {}

/** The builds a lead names by word: the integration branch (its own worktree) and the live folder the user sees. */
export const BuildTarget = {
  Integration: "integration",
  Live: "live",
} as const;
export type BuildTarget = (typeof BuildTarget)[keyof typeof BuildTarget];

/** The run's log keeps this many lines; the waker reads them by sequence number, not by index. */
const MAX_LOOP_RUN_LOG = 400;
/** The report keeps this many verdicts, the most recent. */
const MAX_REPORT_VERDICTS = 200;

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

/** Keep `head` reachable on the run's integration ref: a worktree's commits go with it otherwise. */
export async function protectHead(loopRun: LoopRun, head: string | null | undefined): Promise<void> {
  const { ctx, integrationRef, run } = loopRun;
  if (!isCommit(head) || !integrationRef) return;
  await updateRef(ctx, { project: run.project }, integrationRef, head, {
    label: `director:${run.runId}:protect`,
  }).catch(() => {});
}

/**
 * Save the run's journal, with the run's record on it (journal.ts `recordLoopRun`): what a Resume
 * goes on from. A save that would write what the last one wrote (the worked time aside) is not made.
 */
export async function saveJournal(loopRun: LoopRun): Promise<number | void> {
  const { ctx, journal, run, threadId } = loopRun;
  recordLoopRun(loopRun, loopRun.open?.clock.now());
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
 * A line in the run's log: what wakes a resting lead (wake.ts) and what its next message carries.
 * `kind` says what a line written outside the lead's own turn is about; the waker decides by it.
 */
export function note(loopRun: LoopRun, text: string, kind?: NoteKind): void {
  const { state } = loopRun;
  loopRun.logSeq += 1;
  state.log.push({ at: Date.now(), seq: loopRun.logSeq, text, ...(kind ? { kind } : {}) });
  if (state.log.length > MAX_LOOP_RUN_LOG) state.log.shift();
}

/** Every line the lead has not been told yet. */
export function notesSince(loopRun: LoopRun, seq: number): LoopRunLogEntry[] {
  return loopRun.state.log.filter((entry) => (entry.seq ?? 0) > seq);
}

/** What the integration worktree stands on right now. */
export function currentHead(loopRun: LoopRun) {
  const { ctx, integrationWorktree, run } = loopRun;
  return headOf(ctx, integrationWorktree, { label: `director:${run.runId}:head` });
}

/**
 * The lead commits in its worktree with its own hands: whatever HEAD says is the integration head,
 * protected by the ref, written to the journal, and named to the lead.
 */
export async function syncHead(loopRun: LoopRun) {
  const { journal, state } = loopRun;
  const head = await loopRun.currentHead().catch(() => null);
  if (!head || head === state.integrationHead) return state.integrationHead;
  state.integrationHead = head;
  journal.director.integrationHead = head;
  await loopRun.protectHead(head);
  await loopRun.saveJournal();
  await loopRun.appendRun(RunEvent.DirectorProgress, { head });
  loopRun.note(`you committed ${shortSha(head)} — it is now the integration head`);
  return head;
}

/** The workers of the run's pool still at work. */
export function runningWorkers(loopRun: LoopRun): WorkerRecord[] {
  const pool = loopRun.pool ?? loopRun.open?.pool ?? null;
  return (pool?.state.records ?? []).filter(isWorking);
}

/** Every build this run checked gets the same record, on the same event path as `director_worker`. */
export async function recordVerdict(loopRun: LoopRun, fields: Parameters<typeof verdictRecord>[0]) {
  const { report } = loopRun;
  const record = verdictRecord(fields);
  report.verdicts.push(record);
  if (report.verdicts.length > MAX_REPORT_VERDICTS) report.verdicts.shift();
  await loopRun.appendRun(RunEvent.DirectorVerdict, record);
  return record;
}

/** Load the live folder in the user's own window again, once something there changed. */
export async function reloadLive(loopRun: LoopRun): Promise<void> {
  await loopRun.ctx.call(HostMethod.PreviewLoad, { project: loopRun.run.project }).catch(() => {});
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
