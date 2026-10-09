/**
 * Host auto-resume: a paused build picks itself back up when what paused it has passed. A build an
 * engine limit paused resumes once the limit resets; one a provider outage paused is tried again
 * after a wait; one the loop's crash paused resumes once the loop runs again. A build paused on a
 * lost sign-in (an expired login, an account whose access was taken away) waits for the user, who
 * has to fix it. Bounded: at most AUTO_RESUMES_MAX times a run, never after the user's Stop or
 * Finish, never with too little working time or memory left, and only while Settings → Harness
 * "Resume builds automatically" is on. A cold start (the app itself died) stays the user's click.
 *
 * It lives on the host, not in the harness seed, so a kept older seed cannot shadow it, and it
 * decides from typed fields only: the close's `limit`, the host's own record of a crash, the run's
 * `run_control` and `run_auto_resumed` records — never from the words a close is written in.
 */
import { AutoResumeCause, CustomEvent, customRecord, type RunAutoResumedPayload } from "../../shared/custom-events.ts";
import { RunControlAction } from "../../shared/coordinator.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import { RUN_START_EVENTS, RunState, runExecution, runExecutions } from "../../shared/run-state.ts";

/** The most times the studio resumes one run on its own; after that it is the user's. */
export const AUTO_RESUMES_MAX = 2;
/** How long after a limit's reset the resume waits, so the first call does not meet the old limit. */
export const LIMIT_RESET_MARGIN_MS = 2 * MINUTE_MS;
/**
 * How long after a provider outage paused a build the studio tries it again. The lead had already
 * waited the outage out for about half an hour before it paused (the seed's outage ladder).
 */
export const OUTAGE_RESUME_AFTER_MS = 15 * MINUTE_MS;
/** A reset further away than this is the user's to wait for (a weekly cap, say). */
export const AUTO_RESUME_HORIZON_MS = 12 * HOUR_MS;
/** Less working time left than this is not worth a resume. */
export const AUTO_RESUME_MIN_WORK_MS = 10 * MINUTE_MS;
/** The free memory a resumed build needs (the seed's director budgets keep the same floor). */
export const AUTO_RESUME_MIN_FREE_MB = 1_024;
/** How long past its time a resume waits for the loop or for memory before giving up. */
export const AUTO_RESUME_WAIT_MS = 10 * MINUTE_MS;
/** How often a waiting resume looks again at the loop and at memory. */
export const AUTO_RESUME_RECHECK_MS = 30 * SECOND_MS;
/**
 * The longest single timer a planned resume sets. A Node timer counts only the time the Mac is
 * awake (and App Nap can defer it), so a reset hours away is approached in bounded steps, each
 * planned again against the wall clock: after a sleep the first look resumes. The host holds the
 * Mac awake while a resume waits (`onPendingChange`), so the sleep this covers is a closed lid.
 */
export const AUTO_RESUME_RECHECK_MAX_MS = 5 * MINUTE_MS;

/** What to do about a paused run now. */
export const AutoResumeAction = {
  Resume: "resume",
  Wait: "wait",
  None: "none",
} as const;
export type AutoResumeAction = (typeof AutoResumeAction)[keyof typeof AutoResumeAction];

/** What a waiting resume waits for. */
export const AutoResumeHold = {
  /** The engine limit has not reset yet. */
  Reset: "reset",
  /** The wait after a provider outage is not over yet. */
  Outage: "outage",
  /** The loop is not running yet. */
  Harness: "harness",
  /** Free memory is below the floor. */
  Memory: "memory",
} as const;
export type AutoResumeHold = (typeof AutoResumeHold)[keyof typeof AutoResumeHold];

/** Why a paused run is left for the user. */
export const AutoResumeSkip = {
  Off: "off",
  NotPaused: "not-paused",
  UserStopped: "user-stopped",
  FinishAsked: "finish-asked",
  /** Neither an engine limit with a reset time, a provider outage nor a crash of the loop paused it. */
  NotResumable: "not-resumable",
  /** A lost sign-in paused it — an expired login, or an account whose access was taken away: the user fixes it. */
  AccessLost: "access-lost",
  Spent: "spent",
  /** The user moved on: a newer run started in the conversation, or another run is running. */
  Superseded: "superseded",
  NoTimeLeft: "no-time-left",
  ResetTooFar: "reset-too-far",
  HarnessDown: "harness-down",
  LowMemory: "low-memory",
} as const;
export type AutoResumeSkip = (typeof AutoResumeSkip)[keyof typeof AutoResumeSkip];

export type AutoResumePlan =
  | { action: typeof AutoResumeAction.Resume; cause: AutoResumeCause; attempt: number }
  | { action: typeof AutoResumeAction.Wait; at: number; hold: AutoResumeHold }
  | { action: typeof AutoResumeAction.None; skip: AutoResumeSkip };

/** What the planner knows besides the run's own records: the setting and the host's own facts. */
export interface AutoResumeFacts {
  runId: string;
  /** Settings → Harness "Resume builds automatically". */
  enabled: boolean;
  /** Is the loop running and answering? */
  harnessReady: boolean;
  /** Free memory in MB, or null when it cannot be read. */
  freeMb: number | null;
  /** When the host last saw the loop die with this run open (ms), or null. */
  crashedAt: number | null;
  /** When the user last stopped this run or pressed Stop in its conversation (ms), or null. */
  stoppedAt: number | null;
}

/** The engine limits that reset on their own; any other failure is the user's to look at. */
const RESETTING_LIMITS: ReadonlySet<unknown> = new Set([EngineFailureKind.RateLimit, EngineFailureKind.UsageLimit]);

const none = (skip: AutoResumeSkip): AutoResumePlan => ({ action: AutoResumeAction.None, skip });
const waitUntil = (at: number, hold: AutoResumeHold): AutoResumePlan => ({ action: AutoResumeAction.Wait, at, hold });

/** A finite positive number of ms, or null: a limit's fields come from editable harness code. */
const positiveMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The run's own records since it last started, its last start, and how many times it was auto-resumed. */
interface RunStretch {
  startAt: number;
  sinceStart: { event_type: string; payload: Record<string, unknown>; at: number }[];
  budgets: Record<string, unknown> | null;
  autoResumes: number;
}

function runStretch(events: readonly EventEnvelope[], runId: string): RunStretch {
  const stretch: RunStretch = { startAt: Number.NEGATIVE_INFINITY, sinceStart: [], budgets: null, autoResumes: 0 };
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.payload.runId !== runId) continue;
    const at = Date.parse(event.created_at);
    if (custom.event_type === CustomEvent.RunAutoResumed) stretch.autoResumes++;
    if (RUN_START_EVENTS.has(custom.event_type)) {
      stretch.startAt = at;
      stretch.sinceStart = [];
      stretch.budgets = record(custom.payload.budgets) ?? stretch.budgets;
      continue;
    }
    stretch.sinceStart.push({ event_type: custom.event_type, payload: custom.payload, at });
  }
  return stretch;
}

/** When a paused run is due to resume and why, from its close: a resetting limit, or the loop's crash. */
function dueResume(
  close: RunStretch["sinceStart"][number],
  stretch: RunStretch,
  facts: AutoResumeFacts,
): { at: number; cause: AutoResumeCause } | AutoResumeSkip {
  const limit = record(close.payload.limit);
  // No wait mends a lost sign-in, whatever reset the close names: the user does.
  if (limit?.kind === EngineFailureKind.Auth) return AutoResumeSkip.AccessLost;
  const hitAt = positiveMs(limit?.at) ?? close.at;
  const resetMs = positiveMs(limit?.retryAfterMs);
  if (limit && resetMs !== null && RESETTING_LIMITS.has(limit.kind)) {
    return { at: hitAt + resetMs + LIMIT_RESET_MARGIN_MS, cause: AutoResumeCause.LimitReset };
  }
  if (limit?.kind === EngineFailureKind.Unavailable)
    return { at: hitAt + OUTAGE_RESUME_AFTER_MS, cause: AutoResumeCause.ProviderOutage };
  // The crash the host saw happened while this stretch ran, and this close came after it.
  const { crashedAt } = facts;
  const crashClosedIt = crashedAt !== null && stretch.startAt <= crashedAt && close.at >= crashedAt;
  if (crashClosedIt) return { at: close.at, cause: AutoResumeCause.LoopRestart };
  return AutoResumeSkip.NotResumable;
}

/** What a resume due later waits for: the outage's wait, or the limit's reset. */
function holdFor(cause: AutoResumeCause): AutoResumeHold {
  return cause === AutoResumeCause.ProviderOutage ? AutoResumeHold.Outage : AutoResumeHold.Reset;
}

/** Has the user moved on from this run: a newer run in its conversation, or another one running? */
function superseded(events: readonly EventEnvelope[], runId: string): boolean {
  if (runExecution(events)?.runId !== runId) return true;
  for (const [id, run] of runExecutions(events)) if (id !== runId && run.state === RunState.Running) return true;
  return false;
}

/** Is less working time left than a resume is worth? A run until satisfied has no clock to run out. */
function tooLittleTime(events: readonly EventEnvelope[], stretch: RunStretch, runId: string): boolean {
  const budget = positiveMs(stretch.budgets?.wallClockMs);
  if (budget === null || stretch.budgets?.untilSatisfied === true) return false;
  const worked = runExecution(events, runId)?.worked.ms ?? 0;
  return budget - worked < AUTO_RESUME_MIN_WORK_MS;
}

/** Why the user's own word holds this run back, if it does: a Stop or a Finish since it last started. */
function userHeld(stretch: RunStretch, facts: AutoResumeFacts): AutoResumeSkip | null {
  if (facts.stoppedAt !== null && facts.stoppedAt >= stretch.startAt) return AutoResumeSkip.UserStopped;
  const finishAsked = stretch.sinceStart.some(
    (e) => e.event_type === CustomEvent.RunControl && e.payload.action === RunControlAction.Finish,
  );
  return finishAsked ? AutoResumeSkip.FinishAsked : null;
}

/** Waits for the loop and for memory, bounded by AUTO_RESUME_WAIT_MS past the time it was due. */
function readiness(dueAt: number, now: number, facts: AutoResumeFacts): AutoResumePlan | null {
  const waitedOut = now - dueAt > AUTO_RESUME_WAIT_MS;
  if (!facts.harnessReady)
    return waitedOut
      ? none(AutoResumeSkip.HarnessDown)
      : waitUntil(now + AUTO_RESUME_RECHECK_MS, AutoResumeHold.Harness);
  const lowMemory = facts.freeMb !== null && facts.freeMb < AUTO_RESUME_MIN_FREE_MB;
  if (!lowMemory) return null;
  return waitedOut ? none(AutoResumeSkip.LowMemory) : waitUntil(now + AUTO_RESUME_RECHECK_MS, AutoResumeHold.Memory);
}

/**
 * What to do about run `facts.runId` at `now`, from its conversation's records: resume it now, look
 * again at a later time, or leave it for the user (and why). Pure: the caller supplies the clock.
 */
export function autoResumePlan(events: readonly EventEnvelope[], now: number, facts: AutoResumeFacts): AutoResumePlan {
  if (!facts.enabled) return none(AutoResumeSkip.Off);
  if (runExecution(events, facts.runId)?.state !== RunState.Paused) return none(AutoResumeSkip.NotPaused);
  const stretch = runStretch(events, facts.runId);
  const close = stretch.sinceStart.findLast((e) => e.event_type === CustomEvent.RunFinished);
  if (!close) return none(AutoResumeSkip.NotPaused);
  const held = userHeld(stretch, facts);
  if (held) return none(held);
  if (superseded(events, facts.runId)) return none(AutoResumeSkip.Superseded);
  if (stretch.autoResumes >= AUTO_RESUMES_MAX) return none(AutoResumeSkip.Spent);
  if (tooLittleTime(events, stretch, facts.runId)) return none(AutoResumeSkip.NoTimeLeft);
  const due = dueResume(close, stretch, facts);
  if (typeof due === "string") return none(due);
  if (due.at - now > AUTO_RESUME_HORIZON_MS) return none(AutoResumeSkip.ResetTooFar);
  if (now < due.at) return waitUntil(due.at, holdFor(due.cause));
  return (
    readiness(due.at, now, facts) ?? {
      action: AutoResumeAction.Resume,
      cause: due.cause,
      attempt: stretch.autoResumes + 1,
    }
  );
}

/** What the service needs from the core; the clock and timers are injectable for tests. */
export interface AutoResumeDeps {
  enabled(): boolean;
  harnessReady(): boolean;
  freeMb(): Promise<number | null>;
  /** The conversation's records, oldest first. */
  events(threadId: string): Promise<readonly EventEnvelope[]>;
  /** Write the `run_auto_resumed` record into the run's conversation. */
  record(threadId: string, payload: RunAutoResumedPayload): Promise<void>;
  /** The same resume the user's Resume runs. */
  resume(runId: string): Promise<void>;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onLog?: (line: string) => void;
  /**
   * A resume started or stopped waiting: true while any paused run waits on its reset, the loop or
   * memory, false once none does (resumed, cancelled, left for the user, or the core stopping). The
   * host holds the Mac awake meanwhile; the run's own hold ended when the paused run settled.
   */
  onPendingChange?: (pending: boolean) => void;
}

/** A planned look at one paused run. */
interface Planned {
  threadId: string;
  handle: unknown;
  token: number;
  /** The wall-clock time (ms) of the look. */
  dueAt: number;
  /** A look already decided the run waits (the first look at a pause has not decided yet). */
  waiting: boolean;
}

/**
 * The planner wired to the core: a pause the log receives is looked at at once, then again at the
 * time the plan names, and resumed through the user's own Resume path when the plan says so.
 */
export class AutoResumeService {
  readonly #deps: AutoResumeDeps;
  readonly #planned = new Map<string, Planned>();
  /** When the host last saw the loop die with each run open. */
  readonly #crashedAt = new Map<string, number>();
  /** When the user last pressed Stop in each conversation. */
  readonly #stoppedAt = new Map<string, number>();
  /** When the user last stopped each run through the run controls (`studio:run.stop`). */
  readonly #stoppedRunAt = new Map<string, number>();
  readonly #ticks = new Set<Promise<void>>();
  #nextToken = 1;
  /** What `onPendingChange` last said, so a replanned wait does not flap the host's hold. */
  #pendingSaid = false;

  constructor(deps: AutoResumeDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** Records just appended to a conversation: a pause is planned, a run starting again is not. */
  observe(threadId: string, events: readonly EventEnvelope[]): void {
    for (const event of events) {
      const custom = customRecord(event.data);
      const runId = typeof custom?.payload.runId === "string" ? custom.payload.runId : null;
      if (!custom || !runId) continue;
      if (RUN_START_EVENTS.has(custom.event_type)) this.cancelRun(runId);
      if (custom.event_type === CustomEvent.AutopilotPaused) this.#plan(threadId, runId, this.#now());
    }
  }

  /** The loop died with these runs open: a pause that closes one of them came from the crash. */
  noteCrash(runIds: Iterable<string>): void {
    const at = this.#now();
    for (const runId of runIds) this.#crashedAt.set(runId, at);
  }

  /** A crash loop the watchdog rewound is the user's to resume: the crashes no longer count. */
  forgetCrashes(): void {
    this.#crashedAt.clear();
  }

  /** The user pressed Stop in this conversation: nothing in it resumes on its own. */
  userStopped(threadId: string): void {
    this.#stoppedAt.set(threadId, this.#now());
    for (const [runId, planned] of this.#planned) if (planned.threadId === threadId) this.cancelRun(runId);
  }

  /** The user stopped this run itself (the run controls, not the chat's Stop): it never resumes on its own. */
  userStoppedRun(runId: string): void {
    this.#stoppedRunAt.set(runId, this.#now());
    this.cancelRun(runId);
  }

  /** Forget a planned resume (the user resumed it, or it started again). */
  cancelRun(runId: string): void {
    this.#drop(runId);
    this.#sayPending();
  }

  /** Every planned resume dropped: the core is stopping. */
  dispose(): void {
    for (const runId of [...this.#planned.keys()]) this.#drop(runId);
    this.#sayPending();
  }

  /** The wall-clock time (ms) of the soonest resume waiting, or null when none waits. */
  nextResumeAt(): number | null {
    const waiting = [...this.#planned.values()].filter((planned) => planned.waiting).map((planned) => planned.dueAt);
    return waiting.length > 0 ? Math.min(...waiting) : null;
  }

  /** Settles once every look already running has finished. */
  async idle(): Promise<void> {
    while (this.#ticks.size > 0) await Promise.all([...this.#ticks]);
  }

  #drop(runId: string): void {
    const planned = this.#planned.get(runId);
    if (!planned) return;
    this.#planned.delete(runId);
    this.#clear(planned.handle);
  }

  /** Tell the host when "a resume is waiting" changed; a listener that throws never stops a plan. */
  #sayPending(): void {
    const pending = this.nextResumeAt() !== null;
    if (pending === this.#pendingSaid) return;
    this.#pendingSaid = pending;
    try {
      this.#deps.onPendingChange?.(pending);
    } catch (err) {
      this.#deps.onLog?.(`[auto-resume] holding the Mac awake: ${errorMessage(err)}`);
    }
  }

  #clear(handle: unknown): void {
    if (this.#deps.clearTimer) this.#deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  /** Look at the run again at wall-clock time `dueAt`; `waiting` once a look has decided it waits. */
  #plan(threadId: string, runId: string, dueAt: number, waiting = false): void {
    this.#drop(runId);
    const planned: Planned = { threadId, handle: null, token: this.#nextToken++, dueAt, waiting };
    this.#planned.set(runId, planned);
    this.#arm(runId, planned);
    this.#sayPending();
  }

  /**
   * One bounded step towards the plan's time: a step that ends before it only sets the next step
   * (nothing is read), so a Mac that slept through the time looks at the run at its first step.
   */
  #arm(runId: string, planned: Planned): void {
    const run = () => {
      if (!this.#current(runId, planned.token)) return;
      if (this.#now() < planned.dueAt) return this.#arm(runId, planned);
      const tick = this.#tick(planned.threadId, runId, planned.token).finally(() => this.#ticks.delete(tick));
      this.#ticks.add(tick);
    };
    const ms = Math.min(Math.max(0, planned.dueAt - this.#now()), AUTO_RESUME_RECHECK_MAX_MS);
    if (this.#deps.setTimer) {
      planned.handle = this.#deps.setTimer(run, ms);
      return;
    }
    const timer = setTimeout(run, ms);
    timer.unref?.();
    planned.handle = timer;
  }

  /** Is this look still the run's current one (no cancel or newer plan since)? */
  #current(runId: string, token: number): boolean {
    return this.#planned.get(runId)?.token === token;
  }

  /** Forget this look's plan, unless a newer plan (a later pause of the run) has replaced it. */
  #forget(runId: string, token: number): void {
    if (this.#current(runId, token)) this.#planned.delete(runId);
    this.#sayPending();
  }

  /** The user's latest Stop that applies to this run: of the run itself or of its conversation. */
  #lastStop(threadId: string, runId: string): number | null {
    const stops = [this.#stoppedAt.get(threadId), this.#stoppedRunAt.get(runId)].filter((at) => at !== undefined);
    return stops.length > 0 ? Math.max(...stops) : null;
  }

  #planAt(
    events: readonly EventEnvelope[],
    now: number,
    ids: { threadId: string; runId: string },
    freeMb: number | null,
  ) {
    return autoResumePlan(events, now, {
      runId: ids.runId,
      enabled: this.#deps.enabled(),
      harnessReady: this.#deps.harnessReady(),
      freeMb,
      crashedAt: this.#crashedAt.get(ids.runId) ?? null,
      stoppedAt: this.#lastStop(ids.threadId, ids.runId),
    });
  }

  async #tick(threadId: string, runId: string, token: number): Promise<void> {
    try {
      if (!this.#current(runId, token)) return;
      const events = await this.#deps.events(threadId);
      if (!this.#current(runId, token)) return;
      const ids = { threadId, runId };
      const now = this.#now();
      const due = this.#planAt(events, now, ids, null);
      // Memory is read only once a resume is due: on macOS each reading starts a process.
      const freeMb = due.action === AutoResumeAction.Resume ? await this.#deps.freeMb().catch(() => null) : null;
      if (!this.#current(runId, token)) return;
      const plan = freeMb === null ? due : this.#planAt(events, now, ids, freeMb);
      if (plan.action === AutoResumeAction.Wait) return this.#plan(threadId, runId, plan.at, true);
      if (plan.action !== AutoResumeAction.Resume) return this.#forget(runId, token);
      await this.#resume({ threadId, runId, token }, events, plan);
    } catch (err) {
      // The resume settles only when the resumed run ends: by then a later pause may have a plan.
      this.#forget(runId, token);
      this.#deps.onLog?.(`[auto-resume] ${runId}: ${errorMessage(err)}`);
    }
  }

  /**
   * Recorded first, so the count that bounds resumes holds even when the resume itself fails. The
   * plan stays current while the record is appended: a Stop or the user's own Resume in that window
   * cancels it, and then nothing is dispatched.
   */
  async #resume(
    look: { threadId: string; runId: string; token: number },
    events: readonly EventEnvelope[],
    plan: Extract<AutoResumePlan, { action: typeof AutoResumeAction.Resume }>,
  ): Promise<void> {
    const { threadId, runId, token } = look;
    const project = events
      .map((event) => customRecord(event.data)?.payload)
      .findLast((payload) => payload?.runId === runId && typeof payload.project === "string")?.project;
    await this.#deps.record(threadId, {
      runId,
      ...(typeof project === "string" ? { project } : {}),
      cause: plan.cause,
      attempt: plan.attempt,
    });
    if (!this.#current(runId, token)) return;
    // Forgotten before the dispatch: the resume settles only when the resumed run ends.
    this.#forget(runId, token);
    await this.#deps.resume(runId);
  }
}
