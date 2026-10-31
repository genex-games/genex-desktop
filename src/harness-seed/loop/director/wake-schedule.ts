/**
 * When a Loop's lead is woken, and what the end of one of its turns means — the rules of the wake
 * loop (wake.ts), with no run of their own. A leaf: it imports only time.ts, so every part of the run
 * may type its lines with it. The lead ends its turn when it decides to; nothing of it runs between
 * turns; the studio wakes the same session when something happens: the person speaks or asks to
 * finish, a worker ends or asks, a job ends, the project's app stops, the working time ends. No timer
 * wakes it otherwise. What counts is decided by typed fields, never by reading a line's English.
 */
import { HOUR_MS, SECOND_MS } from "../time.ts";

/** How a lead's session is driven; the journal's wake record keeps it. Never rename a value. */
export const DirectorLoop = {
  /** The lead ends its turn and is woken with a message when something happens. */
  Wake: "wake",
} as const;
export type DirectorLoop = (typeof DirectorLoop)[keyof typeof DirectorLoop];

/** This part wakes an open Loop's lead too: a run reads it by namespace. */
export const SERVES_OPEN_LOOP = true;

/**
 * What a line of the run's log is about, set by whoever writes it outside the lead's own turn
 * (`note(text, kind)`). A line with no kind is the lead's own doing when it was written during its
 * turn, and news when it was written while it slept. Persisted in wake reasons: never rename a value.
 */
export const NoteKind = {
  /** A worker ended: done, failed or stopped. */
  WorkerEnded: "worker_ended",
  /** A job of the run (the lead's or a worker's) ended, and not by the agent's own stop. */
  JobEnded: "job_ended",
  /** A worker of the run's pool waits on the person with a question. */
  WorkerAsks: "worker_asks",
  /** The project's app stopped under an open Loop, and what Genex did about it. */
  AppCrashed: "app_crashed",
  /** The project's app stopped answering under an open Loop, and Genex is bringing it back: said, never woken for. */
  AppStopping: "app_stopping",
} as const;
export type NoteKind = (typeof NoteKind)[keyof typeof NoteKind];

/** How soon a line wakes a resting lead: at once, after the settle window, or not at all. */
export const WakeUrgency = { Now: "now", Soon: "soon", Never: "never" } as const;
export type WakeUrgency = (typeof WakeUrgency)[keyof typeof WakeUrgency];

/** How soon each kind of line wakes the lead. A line it sleeps through still opens the next message. */
export const NOTE_WAKE = {
  [NoteKind.WorkerAsks]: WakeUrgency.Now,
  [NoteKind.AppCrashed]: WakeUrgency.Now,
  [NoteKind.AppStopping]: WakeUrgency.Never,
  [NoteKind.WorkerEnded]: WakeUrgency.Soon,
  [NoteKind.JobEnded]: WakeUrgency.Soon,
} as const satisfies Record<NoteKind, WakeUrgency>;

/** Why the lead is woken when no typed line says so. Persisted in `director_continued.reasons`: never rename a value. */
export const WakeCause = {
  UserMessage: "user_message",
  FinishRequested: "finish_requested",
  /** A line with no kind, written while the lead slept. */
  News: "news",
  WrapUp: "wrap_up",
  /** An open Loop's lead reached its turn's cap with working time left: it goes on at once. */
  TurnCap: "turn_cap",
  /** An open Loop's lead whose turn changed something, woken at once with whatever else is due. */
  CarryOn: "carry_on",
} as const;
export type WakeCause = (typeof WakeCause)[keyof typeof WakeCause];
/** Why one wake happened: a kind of line, or a cause of its own. */
export type WakeReason = NoteKind | WakeCause;

/** Why the wrap-up started. The journal keeps it: never rename a value. */
export const WrapCause = {
  Deadline: "deadline",
  Failed: "failed",
  Finish: "finish",
} as const;
export type WrapCause = (typeof WrapCause)[keyof typeof WrapCause];

/** What the loop does when a turn of the lead's ends. */
export const TurnEnd = {
  Sleep: "sleep",
  WrapUp: "wrap_up",
  Close: "close",
  /** An open Loop's turn reached its own cap: the lead is woken again at once, never rested. */
  Continue: "continue",
  /** An open Loop's lead whose turn changed something: woken again at once. */
  CarryOn: "carry_on",
} as const;
export type TurnEnd = (typeof TurnEnd)[keyof typeof TurnEnd];

/** News that is not the user's settles this long before it wakes the lead, and what else arrives rides along. */
export const WAKE_DEBOUNCE_MS = 5 * SECOND_MS;
/** At most this many wakes in any window of `WAKE_WINDOW_MS`; the user, finish and the wrap-up are never held back. */
export const MAX_WAKES_PER_HOUR = 30;
/** The window the wake cap counts in. */
export const WAKE_WINDOW_MS = HOUR_MS;
/** A wrap-up turn ends this long before the run's end. */
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
  /** The user asked to finish, and no message has said so yet. */
  finishNew: boolean;
  softDeadline: number;
  wrapping: boolean;
  /** When the lead was woken, recently. */
  wakesAt: readonly number[];
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

/** How soon a line wakes a lead who went to sleep after `asleepFromSeq`. */
function urgencyOf(line: WakeLine, asleepFromSeq: number): WakeUrgency {
  if (line.kind) return NOTE_WAKE[line.kind] ?? WakeUrgency.Soon;
  return line.seq > asleepFromSeq ? WakeUrgency.Soon : WakeUrgency.Never;
}

/** The lines' reasons to wake: the urgent at once, the rest together once the first has settled. */
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

/** The studio's own reason: the end of the working time. */
function timerCandidates(view: WakeView): Candidate[] {
  if (view.wrapping) return [];
  return [{ at: view.softDeadline, reason: WakeCause.WrapUp, capped: false }];
}

/** The earliest a capped wake may happen: once the oldest wake of a full window has left it, or now. */
function capLiftsAt(view: WakeView): number {
  const recent = view.wakesAt.filter((at) => at > view.now - WAKE_WINDOW_MS);
  if (recent.length < MAX_WAKES_PER_HOUR) return view.now;
  return Math.min(...recent) + WAKE_WINDOW_MS;
}

/**
 * When the lead is woken next and why — or null when nothing would ever wake it. The user and the
 * finish request wake it at once; a worker's news waits `WAKE_DEBOUNCE_MS` so what arrives with it
 * rides along. `at` is never in the past, and the reasons are every one due by then.
 */
export function nextWake(view: WakeView): Wake | null {
  const liftsAt = capLiftsAt(view);
  const due = [...userCandidates(view), ...lineCandidates(view), ...timerCandidates(view)];
  const candidates = due.map((c) => ({
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
  /** A provider is lost under the run: the run pauses. */
  providerLost?: boolean;
  /** Working time is left and nobody asked to finish. */
  workingTimeLeft: boolean;
  finishRequested: boolean;
  /** The turn ended because it reached its own cap (an open Loop's), not because the lead ended it. */
  capped?: boolean;
  /** The turn changed something (an open Loop's lead builds by itself). */
  worked?: boolean;
}

/** What the loop does next, and why a wrap-up starts. */
export interface TurnVerdict {
  next: TurnEnd;
  wrapCause?: WrapCause;
}

/**
 * A turn has ended. The lead rests until something happens — the person speaks or asks to finish, a
 * worker or job ends, the working time ends — however much is running: nothing wakes it to ask what
 * next, and a quiet lead is never wrapped up for being quiet. A turn cut by its own cap (an open
 * Loop's), or one that changed something (an open Loop's lead builds by itself), goes on at once.
 * Out of working time — or asked by the user to finish — it wraps up; a failed turn does too, unless
 * a lost provider failed it: then the run closes paused.
 */
export function afterTurn(turn: TurnFacts): TurnVerdict {
  if (turn.closed || turn.providerLost === true) return { next: TurnEnd.Close };
  if (!turn.workingTimeLeft) {
    const wrapCause = turn.finishRequested ? WrapCause.Finish : WrapCause.Deadline;
    return { next: TurnEnd.WrapUp, wrapCause };
  }
  if (turn.capped === true) return { next: TurnEnd.Continue };
  if (!turn.ok) return { next: TurnEnd.WrapUp, wrapCause: WrapCause.Failed };
  if (turn.worked === true) return { next: TurnEnd.CarryOn };
  return { next: TurnEnd.Sleep };
}

/** The clocks a pass is held to. */
export interface PassClocks {
  now: number;
  softDeadline: number;
  finalDeadline: number;
}

/** Until when a pass the lead asks for may run: the working deadline while there is working time, else the wrap-up's own end. */
export function passDeadline({ now, softDeadline, finalDeadline }: PassClocks): number {
  return now < softDeadline ? softDeadline : finalDeadline - WRAP_UP_MARGIN_MS;
}
