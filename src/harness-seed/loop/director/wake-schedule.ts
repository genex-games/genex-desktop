/**
 * When a Loop's lead is woken, and what the end of one of its turns means — the rules of the wake
 * loop (wake.ts), with no run of their own. A leaf: it imports only time.ts, so every part of the run
 * may type its lines with it. The lead ends its turn when it decides to; nothing of it runs between
 * turns; the studio wakes the same session with the person's message, or with Genex's own lines of the
 * run's log (a worker or a job that ended, the project's app that stopped). No timer wakes it. What
 * counts is decided by typed fields, never by reading a line's English.
 */
import { SECOND_MS } from "../time.ts";

/**
 * What a line of the run's log is about, set by whoever writes it (`note(text, kind)`): each is one
 * of Genex's facts the lead is told. Persisted in the journal's log: never rename a value.
 */
export const NoteKind = {
  /** A worker ended: done, failed or stopped. */
  WorkerEnded: "worker_ended",
  /** A job of the run (the lead's or a worker's) ended, and not by the agent's own stop. */
  JobEnded: "job_ended",
  /** The project's app stopped answering under an open Loop, in its plugin's words (`open/app-look.ts`): it wakes the lead. */
  AppCrashed: "app_crashed",
  /**
   * The project's app stopped answering and an earlier seed's Genex began to bring it back: said,
   * never woken for. A journal from then keeps it; the seed writes none now.
   */
  AppStopping: "app_stopping",
  /** What an open Loop's lead asked for at its turn's end (a rewind, a restart) has run, and how it went. */
  AskDone: "ask_done",
  /**
   * What Genex did with an open Loop's folder outside the lead's turn, or held back: an autosave or
   * why none, an ask that waits, an ask a pause dropped; or what the project's plugins said at one of
   * Genex's moments (a turn's start), or that the project's app answers again. Said, never woken for.
   */
  Folder: "folder",
} as const;
export type NoteKind = (typeof NoteKind)[keyof typeof NoteKind];

/** How soon a line wakes a resting lead: at once, after the settle window, or not at all. */
export const WakeUrgency = { Now: "now", Soon: "soon", Never: "never" } as const;
export type WakeUrgency = (typeof WakeUrgency)[keyof typeof WakeUrgency];

/** How soon each kind of line wakes the lead. A line it sleeps through is still told with the next message. */
export const NOTE_WAKE = {
  [NoteKind.AppCrashed]: WakeUrgency.Now,
  [NoteKind.AppStopping]: WakeUrgency.Never,
  [NoteKind.AskDone]: WakeUrgency.Now,
  [NoteKind.WorkerEnded]: WakeUrgency.Soon,
  [NoteKind.JobEnded]: WakeUrgency.Soon,
  [NoteKind.Folder]: WakeUrgency.Never,
} as const satisfies Record<NoteKind, WakeUrgency>;

/** Why the wrap-up started. The journal keeps it: never rename a value. */
export const WrapCause = {
  Failed: "failed",
  Finish: "finish",
} as const;
export type WrapCause = (typeof WrapCause)[keyof typeof WrapCause];

/** What the loop does when a turn of the lead's ends. */
export const TurnEnd = {
  Sleep: "sleep",
  WrapUp: "wrap_up",
  Close: "close",
} as const;
export type TurnEnd = (typeof TurnEnd)[keyof typeof TurnEnd];

/** A line that is not the person's settles this long before it wakes the lead, and what else arrives rides along. */
export const WAKE_DEBOUNCE_MS = 5 * SECOND_MS;

/** A line of the run's log as the waker reads it. */
export interface WakeLine {
  at: number;
  seq: number;
  kind: NoteKind;
}

/** Everything `nextWake` decides on: plain facts, read by the loop from the run. */
export interface WakeView {
  now: number;
  /** Genex's lines the lead has not been told yet. */
  untold: readonly WakeLine[];
  /** When the lead's last turn ended. */
  asleepSince: number;
  /** The person sent a message the lead has not heard. */
  personWaiting: boolean;
}

/**
 * When the lead is woken next — or null when nothing would ever wake it. The person's message and a
 * line that cannot wait wake it at once; a worker's or a job's end waits `WAKE_DEBOUNCE_MS` from the
 * first of them (never before the lead slept), so what arrives with it rides along. Never in the past.
 */
export function nextWake(view: WakeView): number | null {
  if (view.personWaiting) return view.now;
  let first: number | null = null;
  for (const line of view.untold) {
    const urgency = NOTE_WAKE[line.kind] ?? WakeUrgency.Soon;
    if (urgency === WakeUrgency.Now) return view.now;
    if (urgency === WakeUrgency.Soon) first = Math.min(first ?? line.at, line.at);
  }
  if (first === null) return null;
  return Math.max(view.now, Math.max(first, view.asleepSince) + WAKE_DEBOUNCE_MS);
}

/** What the loop knows when one of the lead's turns has ended. */
export interface TurnFacts {
  ok: boolean;
  /** The run is over for this session: finished, stopped, or the wrap-up turn done. */
  closed: boolean;
  /** A provider is lost under the run: the run pauses. */
  providerLost?: boolean;
  finishRequested: boolean;
}

/** What the loop does next, and why a wrap-up starts. */
export interface TurnVerdict {
  next: TurnEnd;
  wrapCause?: WrapCause;
}

/**
 * A turn has ended. Asked by the person to finish, the lead gets its one wrap-up turn at once; a
 * failed turn does too, unless a lost provider failed it: then the run closes paused. Otherwise it
 * rests until something happens — the person speaks or asks to finish, a worker or a job ends — and
 * with nothing at work and nothing to be woken for, the Loop closes as a bare agent's turn ends
 * (wake.ts `sleepUntilDue`): nothing wakes it to ask what next.
 */
export function afterTurn(turn: TurnFacts): TurnVerdict {
  if (turn.closed || turn.providerLost === true) return { next: TurnEnd.Close };
  if (turn.finishRequested) return { next: TurnEnd.WrapUp, wrapCause: WrapCause.Finish };
  if (!turn.ok) return { next: TurnEnd.WrapUp, wrapCause: WrapCause.Failed };
  return { next: TurnEnd.Sleep };
}
