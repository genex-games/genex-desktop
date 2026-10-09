/**
 * When the director is woken, and what the end of one of its turns means — the rules of the
 * wake loop (wake.ts), with no run of their own. A leaf: it imports only time.ts, so every
 * part of the run may type its lines with it.
 *
 * The lead used to live inside one long turn: `wait` in a loop, and a "continue" prompt whenever
 * the turn ended with time left, which stretched a single session over the whole run. Now it
 * ends its turn after every decision, nothing of it runs between turns, and the
 * studio wakes the same session when something happens. What counts as something is decided
 * here, by typed fields and never by reading a line's English.
 */
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../time.ts";
import type { Run } from "../../types/harness.d.ts";

/** How a director's session is driven (`run.directorLoop`); the journal's run keeps it. Never rename a value. */
export const DirectorLoop = {
  /** The lead ends its turn after each decision and is woken with a digest (the default). */
  Wake: "wake",
  /** The long turn from before the wake loop, with `wait` and continuation prompts — kept for one release. */
  Turn: "turn",
} as const satisfies Record<string, NonNullable<Run["directorLoop"]>>;
export type DirectorLoop = (typeof DirectorLoop)[keyof typeof DirectorLoop];

/**
 * The harness's environment variable that picks the loop for a run that names none: the studio
 * hands it on from its own (shared/protocol.ts `DIRECTOR_LOOP_ENV`, which this copies).
 */
export const DIRECTOR_LOOP_ENV = "STUDIO_DIRECTOR_LOOP";

/**
 * The loop a run asks for: the long turn only when it is named — by the run, or, for a run that
 * names none, by `DIRECTOR_LOOP_ENV` in `env` (a shipped build's way back); anything else wakes.
 */
export function directorLoopOf(
  run: Pick<Run, "directorLoop">,
  env: Readonly<Record<string, string | undefined>> = {},
): DirectorLoop {
  const named = run.directorLoop ?? env[DIRECTOR_LOOP_ENV];
  return named === DirectorLoop.Turn ? DirectorLoop.Turn : DirectorLoop.Wake;
}

/**
 * What a line of the run's log is about, set by whoever writes it outside the lead's own turn
 * (`note(text, kind)`). A line with no kind is the lead's own doing when it was written during its
 * turn, and news when it was written while it slept. Wake reasons are persisted: never rename a value.
 */
export const NoteKind = {
  /** A loop worker's round was judged or stopped. */
  WorkerRound: "worker_round",
  /** A transition in a worker's loop worth acting on (a mandatory fix, an unjudgeable streak). */
  WorkerLoop: "worker_loop",
  /** A worker ended on its own: done or failed. */
  WorkerEnded: "worker_ended",
  /** A worker the lead stopped has settled. */
  WorkerStopped: "worker_stopped",
  /** The workers' engine hit its limit. */
  WorkerLimit: "worker_limit",
  /** The studio's look into a worktree found a contract violation it had not seen. */
  MonitorViolation: "monitor_violation",
  /** Violations cleared, or a round that has written nothing yet. */
  MonitorQuiet: "monitor_quiet",
  /** A defect whose owner has finished went on the run's ledger. */
  DefectShelved: "defect_shelved",
  /** A defect went to the running worker whose seam it is in. */
  DefectRouted: "defect_routed",
  /** The user spoke to one worker, or about a worker that is not building. */
  UserToWorker: "user_to_worker",
  /** A job of the run (the lead's or a worker's) ended, and not by the agent's own stop. */
  JobEnded: "job_ended",
} as const;
export type NoteKind = (typeof NoteKind)[keyof typeof NoteKind];

/** How soon a line wakes a resting lead: at once, after the settle window, or not at all. */
export const WakeUrgency = { Now: "now", Soon: "soon", Never: "never" } as const;
export type WakeUrgency = (typeof WakeUrgency)[keyof typeof WakeUrgency];

/** How soon each kind of line wakes the lead. A line it sleeps through still opens the next digest. */
export const NOTE_WAKE = {
  [NoteKind.UserToWorker]: WakeUrgency.Now,
  [NoteKind.WorkerRound]: WakeUrgency.Soon,
  [NoteKind.WorkerLoop]: WakeUrgency.Soon,
  [NoteKind.WorkerEnded]: WakeUrgency.Soon,
  [NoteKind.WorkerLimit]: WakeUrgency.Soon,
  [NoteKind.MonitorViolation]: WakeUrgency.Soon,
  [NoteKind.JobEnded]: WakeUrgency.Soon,
  [NoteKind.WorkerStopped]: WakeUrgency.Never,
  [NoteKind.MonitorQuiet]: WakeUrgency.Never,
  [NoteKind.DefectShelved]: WakeUrgency.Never,
  [NoteKind.DefectRouted]: WakeUrgency.Never,
} as const satisfies Record<NoteKind, WakeUrgency>;

/** Why the lead is woken when no typed line says so. Persisted in `director_continued.reasons`: never rename a value. */
export const WakeCause = {
  UserMessage: "user_message",
  FinishRequested: "finish_requested",
  /** A line with no kind, written while the lead slept. */
  News: "news",
  Heartbeat: "heartbeat",
  PlanWindow: "plan_window",
  WrapUp: "wrap_up",
  WorkersLimitLifted: "workers_limit_lifted",
  IdleAsk: "idle_ask",
  /**
   * The finish mark: the art director has looked at the whole game (art-direction.ts), and from
   * here the owners finish their parts. A timed build's timer, or a goal build idle with no review.
   */
  FinishMark: "finish_mark",
  /**
   * The art director's regular look at the whole game while workers build (art-direction.ts
   * `shipLookAt`): its defects go to their owners, and the build stage goes on.
   */
  ShipLook: "ship_look",
} as const;
export type WakeCause = (typeof WakeCause)[keyof typeof WakeCause];
/** Why one wake happened: a kind of line, or a cause of its own. */
export type WakeReason = NoteKind | WakeCause;

/** Why the wrap-up started. The journal keeps it: never rename a value. */
export const WrapCause = {
  Deadline: "deadline",
  /** Nothing ran, the lead was asked what next, and its next turn started nothing either. */
  Idle: "idle",
  Failed: "failed",
  Finish: "finish",
} as const;
export type WrapCause = (typeof WrapCause)[keyof typeof WrapCause];

/** What the loop does when a turn of the lead's ends. */
export const TurnEnd = {
  Sleep: "sleep",
  AskIdle: "ask_idle",
  WrapUp: "wrap_up",
  Close: "close",
  /** A goal build idle twice with no ship review on its head: the finish mark is due now, once. */
  ArtDirection: "art_direction",
} as const;
export type TurnEnd = (typeof TurnEnd)[keyof typeof TurnEnd];

/** News that is not the user's settles this long before it wakes the lead, and what else arrives rides along. */
export const WAKE_DEBOUNCE_MS = 5 * SECOND_MS;
/** A lead whose builders run and who heard nothing for this long is woken to look. */
export const HEARTBEAT_MS = 20 * MINUTE_MS;
/** At most this many wakes in any window of `WAKE_WINDOW_MS`; the user, finish, the plan window and the wrap-up are never held back. */
export const MAX_WAKES_PER_HOUR = 30;
/** The window the wake cap counts in. */
export const WAKE_WINDOW_MS = HOUR_MS;
/** A wrap-up turn ends this long before the run's end, and so does a pass it asks for. */
export const WRAP_UP_MARGIN_MS = 30 * SECOND_MS;

/** A line of the run's log as the waker reads it. */
export interface WakeLine {
  at: number;
  seq: number;
  kind?: NoteKind;
}

/** Everything `nextWake` decides on: plain facts, read by the loop from the run. */
export interface WakeView {
  now: number;
  /** Lines the lead has not been told yet. */
  unread: readonly WakeLine[];
  /** The log's last sequence number when the lead's turn ended: a kind-less line up to it was its own. */
  asleepFromSeq: number;
  /** When the lead's last turn ended. */
  asleepSince: number;
  /** The user said something the lead has not been told. */
  userWaiting: boolean;
  /** The user asked to finish, and no digest has said so yet. */
  finishNew: boolean;
  /** Workers running. */
  running: number;
  /** When the plan window closes, while it is open and its closing not yet said. */
  planWindowEndsAt: number | null;
  /** When the workers' engine limit lifts, while that is ahead and not yet said. */
  workersLimitLiftsAt: number | null;
  softDeadline: number;
  wrapping: boolean;
  /** The lead ended an idle turn and is owed the question of what next. */
  idleDue: boolean;
  /** The lead was asked what next and has not been busy since. */
  idleAsked: boolean;
  /** When the lead was woken, recently. */
  wakesAt: readonly number[];
  /** When the finish mark is due, while it is ahead of the wrap-up and not yet said (absent: none). */
  finishMarkAt?: number | null;
  /** When the art director's regular look at the whole game is due (absent: none). */
  shipLookAt?: number | null;
}

/** When to wake the lead, and why. */
export interface Wake {
  at: number;
  reasons: WakeReason[];
}

/** One reason to wake, at its time; `capped` ones wait for the hourly cap. */
interface Candidate {
  at: number;
  reason: WakeReason;
  capped: boolean;
}

/** The timers a run gone idle does not wait for: the question of what next comes first. */
const FAR_TIMERS: ReadonlySet<WakeReason> = new Set<WakeReason>([WakeCause.WrapUp, WakeCause.FinishMark]);

/** How soon a line wakes a lead who went to sleep after `asleepFromSeq`. */
function urgencyOf(line: WakeLine, asleepFromSeq: number): WakeUrgency {
  if (line.kind) return NOTE_WAKE[line.kind] ?? WakeUrgency.Soon;
  return line.seq > asleepFromSeq ? WakeUrgency.Soon : WakeUrgency.Never;
}

/** The lines' reasons to wake: the user's at once, the rest together once the first has settled. */
function lineCandidates(view: WakeView): Candidate[] {
  const now: Candidate[] = [];
  const soon: WakeLine[] = [];
  for (const line of view.unread) {
    const urgency = urgencyOf(line, view.asleepFromSeq);
    if (urgency === WakeUrgency.Now) now.push({ at: view.now, reason: line.kind ?? WakeCause.News, capped: false });
    if (urgency === WakeUrgency.Soon) soon.push(line);
  }
  if (!soon.length) return now;
  const settled = Math.max(Math.min(...soon.map((line) => line.at)), view.asleepSince) + WAKE_DEBOUNCE_MS;
  return [...now, ...soon.map((line) => ({ at: settled, reason: line.kind ?? WakeCause.News, capped: true }))];
}

/** The user's own reasons: what they said, and a finish request. Never held back. */
function userCandidates(view: WakeView): Candidate[] {
  const out: Candidate[] = [];
  if (view.userWaiting) out.push({ at: view.now, reason: WakeCause.UserMessage, capped: false });
  if (view.finishNew) out.push({ at: view.now, reason: WakeCause.FinishRequested, capped: false });
  return out;
}

/**
 * The finish mark wakes the lead only before the wrap-up is due: a mark still unsaid once the
 * working time is over (a Mac that slept through both, a Resume of a run paused in its wrap-up)
 * gives way to the wrap-up rather than spend its reserve on the art director's look.
 */
const markAheadOfWrapUp = (view: WakeView): view is WakeView & { finishMarkAt: number } =>
  !view.wrapping && typeof view.finishMarkAt === "number" && view.now < view.softDeadline;

/** The art director's regular look, like the mark, only in working time: the wrap-up has no room for it. */
const lookAheadOfWrapUp = (view: WakeView): view is WakeView & { shipLookAt: number } =>
  !view.wrapping && typeof view.shipLookAt === "number" && view.now < view.softDeadline;

/** The studio's own reasons: the idle ask, and the timers. */
function timerCandidates(view: WakeView): Candidate[] {
  const out: Candidate[] = [];
  const add = (at: number, reason: WakeReason, capped: boolean) => out.push({ at, reason, capped });
  if (view.idleDue) add(view.now, WakeCause.IdleAsk, false);
  if (view.planWindowEndsAt !== null) add(view.planWindowEndsAt, WakeCause.PlanWindow, false);
  if (!view.wrapping) add(view.softDeadline, WakeCause.WrapUp, false);
  if (markAheadOfWrapUp(view)) add(view.finishMarkAt, WakeCause.FinishMark, false);
  // Uncapped: busy workers fill the hourly cap with rounds, and the look is what they were missing.
  if (lookAheadOfWrapUp(view)) add(view.shipLookAt, WakeCause.ShipLook, false);
  if (view.workersLimitLiftsAt !== null) add(view.workersLimitLiftsAt, WakeCause.WorkersLimitLifted, true);
  if (view.running > 0) add(view.asleepSince + HEARTBEAT_MS, WakeCause.Heartbeat, true);
  return out;
}

/**
 * The question of what next, for a lead that went to sleep busy — a worker it had just stopped
 * was still settling, say — when the run has gone idle under it: nothing runs, nothing but the
 * wrap-up is ahead, and it was not asked yet. Without it, a stopped last worker left the lead
 * asleep until the wrap-up. Whatever else is due keeps its own wake, and the question then waits
 * for that turn's end (`afterTurn`).
 */
function wentIdle(view: WakeView, others: readonly Candidate[]): Candidate[] {
  const onlyTheWrapUp = others.every((c) => FAR_TIMERS.has(c.reason));
  const askable = !view.idleAsked && !view.wrapping && view.softDeadline > view.now;
  return onlyTheWrapUp && askable ? [{ at: view.now, reason: WakeCause.IdleAsk, capped: false }] : [];
}

/** The earliest a capped wake may happen: once the oldest wake of a full window has left it, or now. */
function capLiftsAt(view: WakeView): number {
  const recent = view.wakesAt.filter((at) => at > view.now - WAKE_WINDOW_MS);
  if (recent.length < MAX_WAKES_PER_HOUR) return view.now;
  return Math.min(...recent) + WAKE_WINDOW_MS;
}

/**
 * When the lead is woken next and why — or null when nothing would ever wake it. The user and
 * the finish request wake it at once; a worker's news waits `WAKE_DEBOUNCE_MS` so what arrives
 * with it rides along; a line the lead caused in its own turn and a line that asks nothing of it
 * only wait for the next digest. A run gone idle with nothing else ahead asks it what next.
 * `at` is never in the past, and the reasons are every one due by then.
 */
export function nextWake(view: WakeView): Wake | null {
  const liftsAt = capLiftsAt(view);
  const due = [...userCandidates(view), ...lineCandidates(view), ...timerCandidates(view)];
  const candidates = [...due, ...wentIdle(view, due)].map((c) => ({
    ...c,
    at: c.capped ? Math.max(c.at, liftsAt) : c.at,
  }));
  if (!candidates.length) return null;
  const at = Math.max(view.now, Math.min(...candidates.map((c) => c.at)));
  const reasons = [...new Set(candidates.filter((c) => c.at <= at).map((c) => c.reason))];
  return { at, reasons };
}

/** What the loop knows when one of the lead's turns has ended. */
export interface TurnFacts {
  ok: boolean;
  /** The run is over for this session: finished, stopped, or the wrap-up turn done. */
  closed: boolean;
  /**
   * A provider is lost under the run — the lead's sign-in, a limit it will not wait out, an outage
   * it could not outlast, or a sign-in a worker or judge lost (absent: none). The run pauses.
   */
  providerLost?: boolean;
  running: number;
  planWindowOpen: boolean;
  workersLimitPending: boolean;
  /** The lead was already asked what next and has not been busy since. */
  idleAsked: boolean;
  /** Working time is left and nobody asked to finish. */
  workingTimeLeft: boolean;
  finishRequested: boolean;
  /** A goal build with no ship review on its head, not yet sent to art direction (absent: never). */
  artDirectionOwed?: boolean;
}

/** What the loop does next, whether the idle question has been asked, and why a wrap-up starts. */
export interface TurnVerdict {
  next: TurnEnd;
  idleAsked: boolean;
  wrapCause?: WrapCause;
}

/** Is anything going on that the lead will be woken by? */
const busy = (turn: TurnFacts): boolean => turn.running > 0 || turn.planWindowOpen || turn.workersLimitPending;

/**
 * A turn has ended. With work going on the lead rests until something happens; with nothing
 * running and time left it is asked once what next, and a second idle turn starts the wrap-up —
 * unless the art director is owed a look first (a goal build, once: `artDirectionOwed`).
 * Out of working time — or asked by the user to finish — it wraps up; a failed turn does too,
 * unless a lost provider failed it: then the run closes paused, and no wrap-up lands a build.
 */
export function afterTurn(turn: TurnFacts): TurnVerdict {
  if (turn.closed || turn.providerLost === true) return { next: TurnEnd.Close, idleAsked: turn.idleAsked };
  if (!turn.workingTimeLeft) {
    const wrapCause = turn.finishRequested ? WrapCause.Finish : WrapCause.Deadline;
    return { next: TurnEnd.WrapUp, idleAsked: turn.idleAsked, wrapCause };
  }
  if (!turn.ok) return { next: TurnEnd.WrapUp, idleAsked: turn.idleAsked, wrapCause: WrapCause.Failed };
  if (busy(turn)) return { next: TurnEnd.Sleep, idleAsked: false };
  if (!turn.idleAsked) return { next: TurnEnd.AskIdle, idleAsked: true };
  if (turn.artDirectionOwed === true) return { next: TurnEnd.ArtDirection, idleAsked: true };
  return { next: TurnEnd.WrapUp, idleAsked: true, wrapCause: WrapCause.Idle };
}

/** The clocks a pass is held to. */
export interface PassClocks {
  now: number;
  softDeadline: number;
  finalDeadline: number;
}

/**
 * Until when a pass the lead asks for may run — a judge's patience with its provider, a playtest:
 * the working deadline while there is working time, and the wrap-up's own end once it is over. A
 * wrap-up that the user's finish, an idle run or a failed turn started moves the working
 * deadline to its start, and a playtest held to that had no time at all.
 */
export function passDeadline({ now, softDeadline, finalDeadline }: PassClocks): number {
  return now < softDeadline ? softDeadline : finalDeadline - WRAP_UP_MARGIN_MS;
}
