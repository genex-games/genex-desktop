/**
 * The two facts about a run that every projection needs and used to decide for itself: how a
 * round ended, and whether the run is running, paused or finished — and the words a verdict
 * record judges a build by.
 *
 * Round outcomes were ruled four ways. The summary counted a round with no winner as nothing at
 * all, the Builds graph and the morning card counted it as undone, and the review page counted a
 * stopped round as undone too. Execution was read from the log in as many places, each knowing a
 * different subset of the lifecycle events. Both rules live here now, and the summary
 * (`run-summary.ts`), the review (`run-review.ts`), the Builds graph (`renderer/run-graph.ts`) and
 * the chat (`renderer/chat-entries.ts`) read them.
 *
 * This is also the one place in `src/shared` that knows the harness's own verdict words
 * ("challenger", "incumbent", "stopped"); tests/conformance/words.test.ts keeps it that way.
 */
import { CustomEvent, customRecord, type CustomEventData, type CustomEventType } from "./custom-events.ts";
import { HOUR_MS } from "./duration.ts";

// ── verdict records ─────────────────────────────────────────────────────────────────────
// The app's copy of what a verdict record (`loop/verdict.ts`) says about who judged a build and
// by which rule. The seed cannot import this file and the app must not import the seed;
// `seed-contracts.test.ts` holds the two copies together. Records keep these values: never rename one.

/** The five passes that judge a build: a worker's own round, then the lead's gate, judge, health pass and close. */
export const VerdictPass = {
  Round: "round",
  Gate: "gate",
  Judge: "judge",
  Health: "health",
  Close: "close",
} as const;
export type VerdictPass = (typeof VerdictPass)[keyof typeof VerdictPass];

/** The rule that decided a verdict (`decision.rule`). */
export const VerdictRule = {
  ChecksFlipped: "checks-flipped",
  JudgePreferred: "judge-preferred",
  Satisfied: "satisfied",
  ChecksRegressed: "checks-regressed",
  Vetoed: "vetoed",
  NoChange: "no-change",
  NoMove: "no-move",
  Unfixed: "unfixed",
  Broken: "broken",
  Unreachable: "unreachable",
  Stopped: "stopped",
  FirstBuild: "first-build",
  NoStart: "no-start",
  Starts: "starts",
  DoesNotStart: "does-not-start",
  Preferred: "preferred",
  NotPreferred: "not-preferred",
  Unseen: "unseen",
  Landed: "landed",
  NotLanded: "not-landed",
} as const;
export type VerdictRule = (typeof VerdictRule)[keyof typeof VerdictRule];

/** The rules of a build judged with nothing before it: a run from an empty game, or a start nobody could photograph. */
const NOTHING_TO_COMPARE: ReadonlySet<string> = new Set([VerdictRule.FirstBuild, VerdictRule.NoStart]);

/** Whether a verdict's build had nothing to be compared with, so it was judged on its own. */
export const comparedWithNothing = (rule: string | null | undefined): boolean => NOTHING_TO_COMPARE.has(rule ?? "");

/** How a round ended, as every projection reads it (`roundOutcome`). */
export const RoundOutcome = {
  Accepted: "accepted",
  Rejected: "rejected",
  Stopped: "stopped",
  Unevaluated: "unevaluated",
} as const;
export type RoundOutcome = (typeof RoundOutcome)[keyof typeof RoundOutcome];

/** The harness's name for the build a round made; it won when the round's build was kept. */
const CHALLENGER = "challenger";
/** The build the round was compared against; it winning means the round was undone. */
const INCUMBENT = "incumbent";
/** The lead ended the round before anybody judged it. */
const STOPPED = "stopped";

/**
 * How a round ended, from its own record (`facet_iteration`, `run_iteration`): kept, undone,
 * stopped by the lead (its work is kept on a branch, and nobody judged it), or finished without a
 * verdict (no winner recorded) — which is neither kept nor undone.
 */
export function roundOutcome(record: { winner?: unknown; verdictSource?: unknown } | null | undefined): RoundOutcome {
  if (record?.verdictSource === STOPPED) return "stopped";
  if (record?.winner === CHALLENGER) return "accepted";
  if (record?.winner === INCUMBENT) return "rejected";
  return "unevaluated";
}

/** A judge's side-by-side pick: did it prefer the round's own build? */
export function preferredChallenger(pick: unknown): boolean {
  return pick === CHALLENGER;
}

/** The winner as the review page records it: the harness's two words, or none. */
export const RoundWinner = {
  Challenger: CHALLENGER,
  Incumbent: INCUMBENT,
} as const;
export type RoundWinner = (typeof RoundWinner)[keyof typeof RoundWinner];
export function roundWinner(value: unknown): RoundWinner | null {
  return value === CHALLENGER || value === INCUMBENT ? value : null;
}

/** Is a verdict's source the lead stopping the round? */
export function stoppedSource(source: string | null | undefined): boolean {
  return source === STOPPED;
}

// ── execution ─────────────────────────────────────────────────────────────────────────────

/** Where a run is: running, paused (it can be resumed) or finished. */
export const RunState = {
  Running: "running",
  Paused: "paused",
  Finished: "finished",
} as const;
export type RunState = (typeof RunState)[keyof typeof RunState];

/**
 * How the run's last close describes it (`executionStatus`), or running while it has none.
 * The harness writes these (its copy is `ExecutionStatus` in `loop/run-events.ts`): never rename a value.
 */
export const ExecutionStatus = {
  Running: "running",
  Paused: "paused",
  Completed: "completed",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

/**
 * Where a run's journal stands (`journal.phase`); a Resume reads it back. The harness writes these
 * (its copy is `JournalPhase` in `loop/run-events.ts`): never rename a value.
 */
export const JournalPhase = {
  /** The classic pipeline's one-part run. */
  Single: "single",
  /** A director run: the lead's own session. */
  Director: "director",
  Base: "base",
  Facets: "facets",
  Integrate: "integrate",
  Ledger: "ledger",
  IntegrationFacet: "integration-facet",
  Verdict: "verdict",
  Optimization: "optimization",
  /** Stopped before it finished: a resume picks it up. */
  Paused: "paused",
  Done: "done",
} as const;
export type JournalPhase = (typeof JournalPhase)[keyof typeof JournalPhase];

/**
 * What a run's budgets say ends it (`budgets.completionPolicy`): the judge's satisfaction, or its
 * time. The harness writes these (its copy is `CompletionPolicy` in `loop/completion-policy.ts`):
 * never rename a value.
 */
export const CompletionPolicy = {
  Goal: "goal",
  Duration: "duration",
} as const;
export type CompletionPolicy = (typeof CompletionPolicy)[keyof typeof CompletionPolicy];

const COMPLETION_POLICIES: ReadonlySet<unknown> = new Set<CompletionPolicy>(Object.values(CompletionPolicy));

/** Whether a recorded value is a completion policy. */
export function isCompletionPolicy(value: unknown): value is CompletionPolicy {
  return COMPLETION_POLICIES.has(value);
}

/**
 * How long a run has worked since its working time began: the stretches it ran, never a pause or
 * the hours the app was closed under it. The harness counts its budget the same way (its journal's
 * `loopRunClock`), so a resumed build goes on from the time it worked, not from its first start.
 */
export interface RunWorked {
  /** The working time of its closed stretches, in ms. */
  ms: number;
  /** When the stretch it is working now began; null while it is closed. */
  since: string | null;
}

/** A run that has not worked yet. */
const NOT_WORKED: RunWorked = { ms: 0, since: null };

export interface RunExecution {
  runId: string;
  state: RunState;
  status: ExecutionStatus;
  /** When it (last) started. */
  startedAt: string | null;
  /** When its working time began: its first start, or the start that reopened it once it had finished. A resume after a pause keeps it. */
  openedAt: string | null;
  /** When it last closed; null while it runs. */
  endedAt: string | null;
  /** How long it has worked since `openedAt`. */
  worked: RunWorked;
  /**
   * Its newest own record in the stretch it is working now (`executionActivity`): where that
   * stretch ends when a later launch closes a run the app died under. Null until one arrives.
   */
  activeAt: string | null;
}

/** The records that start (or restart) a run. */
export const RUN_START_EVENTS: ReadonlySet<string> = new Set<CustomEventType>([
  CustomEvent.RunRegistered,
  CustomEvent.RunStarted,
]);
/** The records that pause a run. */
export const RUN_PAUSE_EVENTS: ReadonlySet<string> = new Set<CustomEventType>([
  CustomEvent.AutopilotPaused,
  CustomEvent.RunPaused,
]);
/** The records that resume a paused run. */
export const RUN_RESUME_EVENTS: ReadonlySet<string> = new Set<CustomEventType>([
  CustomEvent.AutopilotResumed,
  CustomEvent.RunResumed,
]);
const CLOSES: ReadonlySet<string> = new Set<ExecutionStatus>([
  ExecutionStatus.Paused,
  ExecutionStatus.Completed,
  ExecutionStatus.Cancelled,
  ExecutionStatus.Failed,
]);

/** Every record that changes a run's execution: its starts, pauses, resumes and its close. */
const EXECUTION_EVENTS: ReadonlySet<string> = new Set([
  ...RUN_START_EVENTS,
  ...RUN_PAUSE_EVENTS,
  ...RUN_RESUME_EVENTS,
  CustomEvent.RunFinished,
]);

/** Does this record change a run's execution? */
export function isExecutionEvent(record: { event_type: string }): boolean {
  return EXECUTION_EVENTS.has(record.event_type);
}

/**
 * A close's own status: the one it names, else a failure, else paused when it says so, else
 * completed. A paused close is a paused run, not a finished one: it can be resumed.
 */
function closed(payload: Record<string, unknown>): ExecutionStatus {
  const named = payload.executionStatus;
  if (typeof named === "string" && CLOSES.has(named)) return named as ExecutionStatus;
  if (payload.failure) return "failed";
  return payload.paused === true ? "paused" : "completed";
}

/**
 * One lifecycle record applied to a run: a start (or restart), a close, a pause or a resume.
 * Anything else leaves it as it was. A history that lost the run's start still knows how it
 * closed: a close with no run before it is a run that started at an unknown time.
 */
export function executionStep(
  current: RunExecution | null,
  runId: string,
  record: { event_type: string; payload: Record<string, unknown>; at: string },
): RunExecution | null {
  const { event_type, payload, at } = record;
  if (RUN_START_EVENTS.has(event_type)) return startedStep(current, runId, at);
  if (!isExecutionEvent(record)) return current;
  const run: RunExecution = current ?? {
    runId,
    state: "running",
    status: "running",
    startedAt: null,
    openedAt: null,
    endedAt: null,
    worked: NOT_WORKED,
    activeAt: null,
  };
  if (event_type === CustomEvent.RunFinished) {
    const status = closed(payload);
    const state = status === "paused" ? "paused" : "finished";
    const worked = stoppedWorking(run, closeEnd(run, payload, at));
    return { ...run, status, state, endedAt: at, worked, activeAt: null };
  }
  if (RUN_PAUSE_EVENTS.has(event_type))
    return { ...run, state: "paused", status: "paused", worked: stoppedWorking(run, at), activeAt: null };
  return { ...run, state: "running", status: "running", endedAt: null, worked: workingFrom(run, at) };
}

/**
 * Any other record of the run's own, in order: while it works, the newest sign that it was
 * working. Closed, it leaves the run as it was.
 */
export function executionActivity(current: RunExecution | null, at: string): RunExecution | null {
  if (current?.state !== RunState.Running) return current;
  return { ...current, activeAt: at };
}

/** A start or restart: a finished run started again is reopened, and its working time counts from here. */
function startedStep(current: RunExecution | null, runId: string, at: string): RunExecution {
  const reopened = current?.state === RunState.Finished;
  const openedAt = reopened ? at : (current?.openedAt ?? at);
  return {
    runId,
    state: RunState.Running,
    status: ExecutionStatus.Running,
    startedAt: current?.startedAt ?? at,
    openedAt,
    endedAt: null,
    worked: reopened || !current ? { ms: 0, since: at } : workingFrom(current, at),
    activeAt: current?.state === RunState.Running ? current.activeAt : null,
  };
}

/** Its working time once it (re)starts at `at`: a stretch already under way goes on. */
function workingFrom(run: RunExecution, at: string): RunWorked {
  return run.worked.since ? run.worked : { ms: run.worked.ms, since: at };
}

/** Its working time once the stretch under way ends at `end`. */
function stoppedWorking(run: RunExecution, end: string): RunWorked {
  const { since } = run.worked;
  if (!since) return run.worked;
  const span = Date.parse(end) - Date.parse(since);
  return { ms: run.worked.ms + (Number.isFinite(span) ? Math.max(0, span) : 0), since: null };
}

/** Is this close the run's own report, written as it stopped: its status, or its rounds? */
const reportedByRun = (payload: Record<string, unknown>): boolean =>
  typeof payload.executionStatus === "string" || Array.isArray(payload.iterations);

/**
 * Where a `run_finished` written at `at` ends the stretch under way. The run's own report ends it
 * then: a build turn may work long after the run's last record of its own. A close that a later
 * launch settled for a run the app died under is written hours after the work stopped, and those
 * hours were never work: it ends when the conversation last heard from the run (`workedUntil`), or,
 * for a launch from before it said, at the run's newest own record.
 */
function closeEnd(run: RunExecution, payload: Record<string, unknown>, at: string): string {
  const { workedUntil } = payload;
  if (typeof workedUntil === "string" && Number.isFinite(Date.parse(workedUntil))) return workedUntil;
  if (reportedByRun(payload)) return at;
  return run.activeAt ?? at;
}

/** How long a run has worked by `now`, in ms: its closed stretches and the one under way. */
export function workedMs(worked: RunWorked, now: number): number {
  const since = worked.since ? Date.parse(worked.since) : Number.NaN;
  return worked.ms + (Number.isFinite(since) ? Math.max(0, now - since) : 0);
}

/**
 * When a working run would have started had it never paused, in ms — the origin a running clock
 * counts from. Null while it is closed.
 */
export function workStart(worked: RunWorked): number | null {
  const since = worked.since ? Date.parse(worked.since) : Number.NaN;
  return Number.isFinite(since) ? since - worked.ms : null;
}

type LogRecord = { readonly created_at: string; readonly data: CustomEventData };

/** Every run in the log by id, in the order they first started. */
export function runExecutions(events: readonly LogRecord[]): Map<string, RunExecution> {
  const runs = new Map<string, RunExecution>();
  for (const event of events) {
    const custom = customRecord(event.data);
    if (!custom || !isExecutionEvent(custom)) continue;
    const runId = typeof custom.payload.runId === "string" ? custom.payload.runId : null;
    if (!runId) continue;
    const next = executionStep(runs.get(runId) ?? null, runId, { ...custom, at: event.created_at });
    if (next) runs.set(runId, next);
  }
  return runs;
}

/**
 * The run a conversation is on: the one started last (or the named one), and where it stands.
 * A lifecycle record of any other run is not this run's.
 */
export function runExecution(events: readonly LogRecord[], runId: string | null = null): RunExecution | null {
  let run: RunExecution | null = null;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (!custom || !isExecutionEvent(custom)) continue;
    const id = typeof custom.payload.runId === "string" ? custom.payload.runId : null;
    const otherRun = Boolean(runId) && id !== runId;
    if (!id || otherRun) continue;
    run = conversationRunStep(run, id, { ...custom, at: event.created_at });
  }
  return run;
}

/** A start begins (or restarts) run `id`; any other record moves only the run it belongs to. */
function conversationRunStep(
  run: RunExecution | null,
  id: string,
  step: { event_type: string; payload: Record<string, unknown>; at: string },
): RunExecution | null {
  if (RUN_START_EVENTS.has(step.event_type)) return executionStep(run?.runId === id ? run : null, id, step);
  return run?.runId === id ? executionStep(run, id, step) : run;
}

// ── loop ──────────────────────────────────────────────────────────────────────────────────

/** The Loop a run was given, as its start record kept it: its hours, or `null` for ∞ (until satisfied). */
export interface RecordedRunLoop {
  hours: number | null;
}

/**
 * The Loop a start record's `budgets` gave the run: ∞ when it was recorded until satisfied (its
 * `wallClockMs` is then only the safety ceiling), its hours for a positive wall-clock budget, and
 * null for budgets it cannot read. The harness writes these (`loop/chat-dispatch.ts`
 * `intakeBudgets`); the payload types are the contract, not a check, so this checks.
 */
export function recordedRunLoop(budgets: unknown): RecordedRunLoop | null {
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) return null;
  const { wallClockMs, untilSatisfied } = budgets as { wallClockMs?: unknown; untilSatisfied?: unknown };
  if (untilSatisfied === true) return { hours: null };
  const timed = typeof wallClockMs === "number" && Number.isFinite(wallClockMs) && wallClockMs > 0;
  return timed ? { hours: wallClockMs / HOUR_MS } : null;
}
