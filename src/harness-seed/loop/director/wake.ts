import { estimateTokens } from "../prompt.ts";
import { outcomeTally, reviewProgress, verifyNudgeDue } from "./progress.ts";
import { durationCommission, goalCommission } from "./commission.ts";
/**
 * The director's wake loop. The lead ends its turn after every decision; between turns nothing
 * of it runs; the studio wakes the SAME session with a digest when something happens — the user
 * speaks, a worker lands a round or ends, the studio's look finds a violation, a timer is due
 * (wake-schedule.ts decides which). One turn at a time: what arrives during a turn opens the next
 * digest. The limit wait and the fresh-session fallback cover every turn, not only the first.
 *
 * It replaces the long turn (`wait` in a loop, and a "continue" prompt whenever the turn ended
 * with time left), which kept one session alive across a whole run — seventeen hours, once.
 * That loop stays behind `run.directorLoop: "turn"` for one release (director.ts).
 *
 * The journal holds what the loop needs after a restart (journal.ts): a wake and a rest save it, and
 * so does news that reaches a resting lead and wakes nobody; a resumed run's first message is a
 * digest read from it.
 *
 * The lead answers the chat while the run is going (live chat, lead-line.ts): a message the person
 * sends wakes a resting lead at once, and reaches a turn under way — read at its next step by an
 * engine that takes input mid-turn, or by cutting a later turn short (never inside a tool call) and
 * resuming the same session with the words in front. What the lead writes is the chat's.
 *
 * Its functions take the run explicitly; they are not bound onto it.
 */
import { isResumeFailure } from "../chat-session.ts";
import { HostMethod } from "../host-methods.ts";
import {
  EngineFailure,
  engineLimitOf,
  isTransientProviderError,
  outageDelays,
  StopReason,
  withProviderPatience,
  type EngineLimit,
} from "../outage.ts";
import { isProviderLoss, lostSignIn, noteProviderLoss, pauseDecision } from "../provider-loss.ts";
import { CLIP_DETAIL } from "../text.ts";
import { RunEvent } from "../run-events.ts";
import { SteerDelivery } from "../steer-delivery.ts";
import { MINUTE_MS, minutes, SECOND_MS, sleep } from "../time.ts";
import { limitResumePrompt, wrapUpPrompt } from "./briefs.ts";
import { MAX_WORKERS, workerWindows } from "./budgets.ts";
import { waitDigest } from "./digests.ts";
import {
  priorDigestWorkers,
  priorWorkersSummary,
  recordLoopRun,
  restoredWake,
  resumedFromJournal,
  wakeRecord,
} from "./journal.ts";
import { resumeClosing, resumedHeading } from "./journal-prompts.ts";
import { isReopened } from "./reopen.ts";
import { reopenClosing, reopenedHeading } from "./reopen-prompts.ts";
import { folderBusy } from "./lead-session.ts";
import {
  carryOn,
  FRESH_LOG_LINES,
  FRESH_NOTES,
  freshStart,
  idleAsk,
  SESSION_LOST_WHY,
  sinceThen,
  userSaysBlock,
  wakeDigest,
  wakeRules,
  wrapLead,
} from "./wake-prompts.ts";
// Read by namespace, not by name: a seed upgrade keeps an agent-edited wake-prompts.ts, and an
// older copy has no `buildCard` — a named import of it would keep the harness from linking.
import * as wakeWords from "./wake-prompts.ts";
import {
  afterTurn,
  HEARTBEAT_MS,
  nextWake,
  NoteKind,
  TurnEnd,
  WAKE_WINDOW_MS,
  WakeCause,
  WRAP_UP_MARGIN_MS,
  WrapCause,
} from "./wake-schedule.ts";
import { cutShortWake, midTurnUserSays } from "./live-prompts.ts";
import { artDirectionBlock, ART_SKIPPED, shipLookBlock } from "./art-direction-prompts.ts";
import { workingGoal } from "../goal-prompts.ts";
import { runScope } from "../scope.ts";
import { FacetStage, isFinishing } from "../facet/stage.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { DelegateResult } from "../../types/host-api.d.ts";
import type { ArtDirection, LastShip } from "./art-direction.ts";
import type { RestoredWake } from "./journal.ts";
import type { LeadLine } from "./lead-line.ts";
import type { LoopRun, LoopRunState, Worker } from "./loop-run.ts";
import type {
  CardFacts,
  DigestFacts,
  DigestWorker,
  OutcomeFacts,
  WorkerRoom,
  WorkersLimitFacts,
} from "./wake-prompts.ts";
import type { TurnFacts, TurnVerdict, Wake, WakeReason, WakeView } from "./wake-schedule.ts";

/**
 * This part serves a lead that is its chat's own session (one session): it builds in the integration
 * worktree by its full path and keeps no memory file. A run seats one only when every part it
 * depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** A session limit is waited out at most this often a run. */
export const MAX_LIMIT_WAITS = 2;
/** …and only when it resets at least this long before the turn's deadline. */
export const LIMIT_WAIT_MARGIN_MS = 5 * MINUTE_MS;
/** A wrap-up is worth a turn with at least this much of the run left. */
export const WRAP_UP_MIN_MS = 90 * SECOND_MS;
/** How often a resting lead's inbox, log and clocks are read. */
export const WAKE_POLL_MS = SECOND_MS;
/** A run opens at most this many fresh sessions for a lead whose own was lost. */
export const MAX_FRESH_SESSIONS = 3;
/**
 * A turn the host refused because another session holds the lead's lock (the paused run's last
 * turn, still settling under a Resume) is asked again after this wait, at most this many times.
 */
export const BUSY_RETRY_MS = 15 * SECOND_MS;
export const MAX_BUSY_RETRIES = 4;
/**
 * News that reaches a resting lead is saved once it has waited this long for a wake that did not
 * come, and at most this often (a wake saves what it tells).
 */
const JOURNAL_NEWS_MS = 5 * SECOND_MS;
const WAKE_TOKEN_BUDGET = 8_000;

/** The user's own reasons to wake the lead: never held back by the hourly cap, so never counted in it. */
const USER_WAKES: ReadonlySet<WakeReason> = new Set<WakeReason>([
  WakeCause.UserMessage,
  WakeCause.FinishRequested,
  NoteKind.UserToWorker,
]);

/** The director's session as the run talks to it: one turn at a time, and the session id it resumes. */
export interface DirectorTalk {
  session: (prompt: string, sid: string | null | undefined, timeoutMs: number) => Promise<Partial<DelegateResult>>;
  sessionId: string | null;
  /** Keep the session a turn answered with, on the journal where a resume finds it. */
  keep: (result: Partial<DelegateResult> | null | undefined) => Promise<void>;
}

/** The loop's clock: the real one, or one a test moves. */
export interface WakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
/** The wall clock. */
export const SYSTEM_CLOCK: WakeClock = { now: () => Date.now(), sleep };

/** Why a run the waking lead left open ended, when the wrap-up had a cause of its own (the report's sentence). */
export const WAKE_ENDING = {
  [WrapCause.Idle]: "the director had nothing left to run and did not call finish in its wrap-up",
  [WrapCause.Finish]: "the user asked to finish and the director did not call finish in its wrap-up",
} as const satisfies Partial<Record<WrapCause, string>>;

/** What the loop keeps between the lead's turns. */
export interface WakeState {
  turns: number;
  /** The build card this turn's digest left out because the session had seen it, for a fresh one. */
  cardLeftOut?: string;
  asleepFromSeq: number;
  asleepSince: number | null;
  idleAsked: boolean;
  idleDue: boolean;
  wrapping: boolean;
  wrapCause: WrapCause | null;
  wakes: number;
  wakesAt: number[];
  lastWakeAt: number | null;
  userWaiting: boolean;
  /**
   * The user's words the lead was told although the store refused to record their hand-over:
   * the inbox still has them as untold, at the head of its list, and they are never said again.
   */
  heardUnrecorded: string[];
  /** The user's words handed into a turn that ended before it read them: they open the next message. */
  owed: string[];
  /** The line the chat reaches the lead on (lead-line.ts), when the run opened one. */
  line: LeadLine | null;
  /** How many of the chat's messages the line had been handed when the lead's latest message was told them. */
  promptThrough: number;
  /** The user's words the lead's latest message carried: said again when no turn worked on it. */
  promptWords: string[];
  /** The turn under way was cut short to hand the lead the user's words: it is resumed at once with them. */
  cut: boolean;
  finishNew: boolean;
  finishSaid: boolean;
  /** The plan window (its `planReviewUntil`) whose closing a wake has said. */
  planWindowSaid: number | null;
  /** The finish mark was said (art-direction.ts): once a run, and the journal keeps it. */
  finishMarkSaid: boolean;
  /** A goal build idle with no ship review on its head is owed its finish mark now (`TurnEnd.ArtDirection`). */
  finishMarkDue: boolean;
  /** The working time the art director's next regular look is due at; null until its first (art-direction.ts `shipLookAt`). */
  nextShipLookWorkedMs: number | null;
  /** The art director's last review the loop has counted as a look (`noteShipLooks`). */
  shipSeen: LastShip | null;
  /** The working time the lead was last nudged to verify its outcomes; null before the first. */
  verifyNudgedWorkedMs: number | null;
  /** The art director's review (`LastShip.at`) the last nudge came after: a newer one is owed a nudge. */
  verifyNudgedShipAt: number | null;
  /** The log's sequence number, and the time, the loop last saved the journal (a kept older loop-run.ts counts only these). */
  journaledSeq: number;
  journaledAt: number;
  limitWaits: number;
  freshSessions: number;
  /** The turn whose failure started the wrap-up. */
  failed: Partial<DelegateResult> | null;
}

/** How the loop ended: the last turn's answer, why the wrap-up started, and the turn that failed. */
export interface WakeOutcome {
  result: Partial<DelegateResult>;
  wrapCause: WrapCause | null;
  failed: Partial<DelegateResult> | null;
}

/** What a turn needs besides the run: the brief a fresh session opens with, the clock, and the chat's line. */
interface TurnKit {
  talk: DirectorTalk;
  brief: () => string;
  clock: WakeClock;
  line: LeadLine | null;
}

/** One message to the lead's session, and when its turn must be over. */
interface TurnAsk {
  prompt: string;
  deadline: number;
}

/** The loop's state as a run starts: a resumed one takes back what its journal kept of it. */
function newWakeState(restored: RestoredWake = { idleAsked: false, wakesAt: [] }): WakeState {
  return {
    turns: 0,
    asleepFromSeq: 0,
    asleepSince: null,
    idleAsked: restored.idleAsked,
    idleDue: false,
    wrapping: false,
    wrapCause: null,
    wakes: 0,
    wakesAt: restored.wakesAt,
    lastWakeAt: null,
    userWaiting: false,
    heardUnrecorded: [],
    owed: [],
    line: null,
    promptThrough: 0,
    promptWords: [],
    cut: false,
    finishNew: false,
    finishSaid: false,
    planWindowSaid: null,
    finishMarkSaid: restored.finishMarkSaid === true,
    finishMarkDue: false,
    nextShipLookWorkedMs: restored.nextShipLookWorkedMs ?? null,
    shipSeen: null,
    verifyNudgedWorkedMs: restored.verifyNudgedWorkedMs ?? null,
    verifyNudgedShipAt: null,
    journaledSeq: 0,
    journaledAt: 0,
    limitWaits: 0,
    freshSessions: restored.freshSessions ?? 0,
    failed: null,
  };
}

/** The run is over for the lead: it finished, the user stopped it, or it failed on its own. */
const loopRunOver = (loopRun: LoopRun): boolean =>
  loopRun.state.finished || loopRun.ctx.cancelled === true || Boolean(loopRun.report.failure);

/** Is the user's window to read the plan still open? */
const planWindowOpen = (state: LoopRunState, now: number): boolean =>
  state.planReviewUntil !== null && !state.planGo && state.planReviewUntil > now;

/** When the workers' engine limit lifts, when the engine said. */
const workersLimitLifts = (state: LoopRunState): number | null =>
  state.workerLimit && typeof state.workerLimit.retryAfterMs === "number"
    ? state.workerLimit.at + state.workerLimit.retryAfterMs
    : null;

/** Is the workers' engine limit still ahead of `now`? */
function workersLimitPending(state: LoopRunState, now: number): boolean {
  const lifts = workersLimitLifts(state);
  return lifts !== null && lifts > now;
}

/** Of the inbox's untold steers, what the lead has not heard: those it was told on a refused hand-over lead the list. */
function unheard(wake: WakeState, untold: readonly string[]): string[] {
  const stillLeading = wake.heardUnrecorded.every((text, i) => untold[i] === text);
  // A reader took them since (a kept playbook's `wait`): the inbox has them as told after all.
  if (!stillLeading) wake.heardUnrecorded = [];
  return untold.slice(wake.heardUnrecorded.length);
}

/**
 * The user's words the lead is told now — what a turn was handed and did not read first, then the
 * inbox's — and how many of the chat's messages the line had been handed by then (`through`). The
 * count is the one read after the inbox, and read again until it stands still: a message handed
 * while the inbox was read may or may not be in its answer.
 */
async function userWords(loopRun: LoopRun, wake: WakeState): Promise<{ words: string[]; through: number }> {
  const owed = wake.owed.splice(0);
  const { line } = wake;
  let through = line?.count() ?? 0;
  const words = await takeUntold(loopRun, wake);
  while (line && line.count() !== through) {
    through = line.count();
    words.push(...(await takeUntold(loopRun, wake)));
  }
  return { words: [...owed, ...words], through };
}

/**
 * The user's words a message to the lead carries, taken off the inbox, which records their
 * hand-over. When the store refuses that record the lead still hears them — read without taking
 * them — and the loop remembers it did: the untaken steer woke the lead on every poll, each time
 * with nothing said. They are heard once a turn works on the message (`promptThrough`), and said
 * again in the next one when none does (`promptWords`).
 */
async function tellUser(loopRun: LoopRun, wake: WakeState): Promise<string[]> {
  const { words, through } = await userWords(loopRun, wake);
  wake.promptThrough = through;
  wake.promptWords = words;
  return words;
}

/** The inbox's steers the lead has not heard, taken off it (`tellUser`). */
async function takeUntold(loopRun: LoopRun, wake: WakeState): Promise<string[]> {
  const { inbox } = loopRun;
  const taken = await inbox.steering(undefined, true, { onlyNew: true }).catch(() => null);
  if (taken) {
    const words = unheard(wake, taken);
    wake.heardUnrecorded = [];
    return words;
  }
  const untold = await inbox.steering(undefined, false, { onlyNew: true }).catch(() => []);
  const words = unheard(wake, untold);
  wake.heardUnrecorded = [...untold];
  return words;
}

/**
 * The first message: the brief, how the run works, and whatever the user said before it began —
 * on a resumed run, inside a digest read from its journal (`resumedDigest`). A run whose working
 * time is already over opens in its wrap-up.
 */
async function firstPrompt(loopRun: LoopRun, wake: WakeState, brief: () => string, now: number): Promise<string> {
  const said = await tellUser(loopRun, wake);
  const opening = [brief(), wakeRules({ heartbeatMinutes: minutes(HEARTBEAT_MS) })];
  if (resumedFromJournal(loopRun)) return [...opening, resumedDigest(loopRun, wake, said, now)].join("\n\n");
  const closing = wake.wrapping ? closingFor(loopRun, wake, [], now) : "";
  return [...opening, said.length ? userSaysBlock(said) : "", closing].filter(Boolean).join("\n\n");
}

/**
 * A resumed run's first digest, read from what its journal kept: the workers and the defects
 * nobody owns from before the pause, the news the lead never heard, the plan window and the
 * run's own clock — under a heading of its own, since nothing woke the lead.
 */
function resumedDigest(loopRun: LoopRun, wake: WakeState, userSays: string[], now: number): string {
  const happened = readUnread(loopRun);
  const said = { now, reasons: [], userSays, finishNew: false, happened, closing: resumedClosing(loopRun, wake, now) };
  // The one digest that gives the workers from before the pause their full lines.
  const facts = digestFacts(loopRun, wake, said, { priorInFull: true });
  return wakeDigest({ ...facts, heading: resumedHeadingOf(loopRun, now) });
}

/** How a resumed run's first digest ends: its wrap-up, or what to decide — a paused run's rest, or a reopened build's ask. */
function resumedClosing(loopRun: LoopRun, wake: WakeState, now: number): string {
  if (wake.wrapping) return closingFor(loopRun, wake, [], now);
  return isReopened(loopRun) ? reopenClosing(!durationCommission(loopRun.run)) : resumeClosing();
}

/** The heading of a resumed run's first digest: it paused and picks up, or it had finished and goes on (director/reopen.ts). */
function resumedHeadingOf(loopRun: LoopRun, now: number): string {
  if (!isReopened(loopRun)) return resumedHeading(now);
  return reopenedHeading({ now, minutesLeft: minutes(loopRun.softDeadline - now) });
}

/** Everything `afterTurn` decides on, read from the run as the turn ends. */
async function turnFacts(
  loopRun: LoopRun,
  wake: WakeState,
  result: Partial<DelegateResult>,
  now: number,
): Promise<TurnFacts> {
  const { inbox, runningWorkers, state } = loopRun;
  const finishRequested = await inbox.finishing().catch(() => false);
  return {
    ok: result?.ok === true,
    closed: loopRunOver(loopRun) || wake.wrapping,
    providerLost: Boolean(state.limit) || (await pauseOnLostSignIn(loopRun, now)),
    running: runningWorkers().length,
    planWindowOpen: planWindowOpen(state, now),
    workersLimitPending: workersLimitPending(state, now),
    idleAsked: wake.idleAsked,
    workingTimeLeft: now < loopRun.softDeadline && !finishRequested,
    finishRequested,
    artDirectionOwed: artDirectionOwed(loopRun, wake),
  };
}

/** A goal build the art director has not looked at yet, on a run that has the art director. */
function artDirectionOwed(loopRun: LoopRun, wake: WakeState): boolean {
  if (wake.finishMarkSaid || typeof loopRun.shipOwed !== "function") return false;
  return loopRun.shipOwed();
}

/**
 * When the finish mark wakes the lead: now for a goal build sent to art direction, a timed build's
 * mark (art-direction.ts `finishMarkAt`) while it is ahead of the wrap-up, or never once it was
 * said, or once the wrap-up is due (the mark gives way to it) — or on a run without the art director.
 */
function finishMarkView(loopRun: LoopRun, wake: WakeState, now: number): number | null {
  if (wake.finishMarkSaid || !WakeCause.FinishMark) return null;
  if (now >= loopRun.softDeadline) return null;
  if (wake.finishMarkDue) return now;
  const at = typeof loopRun.finishMarkAt === "function" ? loopRun.finishMarkAt() : null;
  return at !== null && at < loopRun.softDeadline ? at : null;
}

/**
 * When the art director's regular look at the whole game wakes the lead (art-direction.ts
 * `shipLookAt`) — whatever the lead is doing, so a lead kept busy by its workers is still told —
 * or never: in the wrap-up, or on a run without the art director's regular look.
 */
function shipLookView(loopRun: LoopRun, wake: WakeState, now: number): number | null {
  if (wake.wrapping || typeof loopRun.shipLookAt !== "function") return null;
  const finishMarkAt = finishMarkView(loopRun, wake, now);
  return loopRun.shipLookAt({ nextAtWorkedMs: wake.nextShipLookWorkedMs, now, finishMarkAt });
}

/**
 * The wrap-up starts now: the working deadline moves up to this moment, so every clock the run
 * reads (run_status, `finish`, a new worker's budget) agrees that the working time is over.
 */
function startWrapUp(loopRun: LoopRun, wake: WakeState, cause: WrapCause, now: number): void {
  if (!wake.wrapCause) wake.wrapCause = cause;
  const at = Math.min(loopRun.softDeadline, now);
  loopRun.softDeadline = at;
  loopRun.state.softDeadline = at;
}

/** Act on the end of a turn: owe the lead the idle question, or start the wrap-up. */
function settleTurn(
  loopRun: LoopRun,
  wake: WakeState,
  verdict: TurnVerdict,
  result: Partial<DelegateResult>,
  now: number,
) {
  wake.idleAsked = verdict.idleAsked;
  if (verdict.next === TurnEnd.AskIdle) wake.idleDue = true;
  if (verdict.next === TurnEnd.ArtDirection) wake.finishMarkDue = true;
  if (verdict.next !== TurnEnd.WrapUp) return;
  if (verdict.wrapCause === WrapCause.Failed) wake.failed = result;
  startWrapUp(loopRun, wake, verdict.wrapCause ?? WrapCause.Deadline, now);
}

/**
 * A review on integration the loop did not run itself — the lead's own `judge ship=yes`, the finish
 * mark's or the finish gate's look — counts as the art director's look: the next regular one waits
 * a whole period from it (art-direction.ts `shipLookAfter`), so two looks never come close together.
 */
function noteShipLooks(loopRun: LoopRun, wake: WakeState, now: number): void {
  const last = loopRun.state.lastShip ?? null;
  if (last === wake.shipSeen) return;
  wake.shipSeen = last;
  if (last && typeof loopRun.shipLookAfter === "function")
    wake.nextShipLookWorkedMs = loopRun.shipLookAfter({ now, looked: last.ship !== null });
}

/** Read the inbox while the lead rests: what the user said, a finish request, and steers addressed to a worker. */
async function collect(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  const { inbox, routeUserSteers, state } = loopRun;
  noteShipLooks(loopRun, wake, now);
  await reviewProgress(loopRun, now);
  const untold = await inbox.steering(undefined, false, { onlyNew: true }).catch(() => []);
  wake.userWaiting = wake.owed.length > 0 || unheard(wake, untold).length > 0;
  wake.finishNew = !wake.finishSaid && (await inbox.finishing().catch(() => false));
  // Before the first worker there is no monitor to hand a worker's steer over.
  if (!state.monitor) await routeUserSteers().catch(() => {});
}

/** The plan window's closing, while it is open and no wake has said it. */
function planWindowUnsaid(state: LoopRunState, wake: WakeState): number | null {
  const open = state.planReviewUntil !== null && !state.planGo;
  return open && wake.planWindowSaid !== state.planReviewUntil ? state.planReviewUntil : null;
}

/** What `nextWake` decides on, read from the run. */
function wakeView(loopRun: LoopRun, wake: WakeState, now: number): WakeView {
  const { state } = loopRun;
  return {
    now,
    unread: loopRun.notesSince(loopRun.waitSeq),
    asleepFromSeq: wake.asleepFromSeq,
    asleepSince: wake.asleepSince ?? now,
    userWaiting: wake.userWaiting,
    finishNew: wake.finishNew,
    running: loopRun.runningWorkers().length,
    planWindowEndsAt: planWindowUnsaid(state, wake),
    // The wake that says it lifted clears it (`markSaid`), so it is said once.
    workersLimitLiftsAt: workersLimitLifts(state),
    softDeadline: loopRun.softDeadline,
    wrapping: wake.wrapping,
    idleDue: wake.idleDue,
    idleAsked: wake.idleAsked,
    wakesAt: wake.wakesAt,
    finishMarkAt: finishMarkView(loopRun, wake, now),
    shipLookAt: shipLookView(loopRun, wake, now),
  };
}

/** A wrap-up that would not have its minimum before the run's end is not started. */
const tooLateToWrap = (loopRun: LoopRun, due: Wake, now: number): boolean =>
  due.reasons.includes(WakeCause.WrapUp) && loopRun.finalDeadline - now <= WRAP_UP_MIN_MS;

/**
 * What happened while the lead rests reaches the journal before its next turn: the wake it causes
 * saves it (`wakePrompt`); news that has waited `JOURNAL_NEWS_MS` for a wake that did not come — one
 * the cap holds, or a line that wakes nobody — is saved here. News a save already holds is not.
 */
async function journalNews(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  const saved = Math.max(wake.journaledSeq, loopRun.journaledSeq ?? 0);
  const oldest = loopRun.notesSince(saved)[0];
  if (!oldest) return;
  const waited = now - oldest.at >= JOURNAL_NEWS_MS && now - wake.journaledAt >= JOURNAL_NEWS_MS;
  if (waited) await keepWake(loopRun, wake, now);
}

/** Rest until something is due, or the run ends under the lead (null); a message from the chat cuts it short. */
async function sleepUntilDue(loopRun: LoopRun, wake: WakeState, kit: TurnKit): Promise<Wake | null> {
  const { clock, line } = kit;
  for (;;) {
    if (loopRunOver(loopRun) || clock.now() >= loopRun.finalDeadline - WRAP_UP_MARGIN_MS) return null;
    const spoke = line?.heard();
    await collect(loopRun, wake, clock.now());
    const now = clock.now();
    const due = nextWake(wakeView(loopRun, wake, now));
    if (due && due.at <= now) return tooLateToWrap(loopRun, due, now) ? null : due;
    await journalNews(loopRun, wake, now);
    await (spoke ? Promise.race([clock.sleep(WAKE_POLL_MS), spoke]) : clock.sleep(WAKE_POLL_MS));
  }
}

/** The log's lines the lead has not read, as text; the shared cursor moves past them (`wait` reads it too). */
function readUnread(loopRun: LoopRun): string[] {
  const unread = loopRun.notesSince(loopRun.waitSeq);
  const last = unread.at(-1);
  if (last) loopRun.waitSeq = Math.max(loopRun.waitSeq, last.seq);
  return unread.map((entry) => entry.text);
}

/** Record the wake: the cap's window, and every timer and request it says, so none is said twice. */
function markSaid(loopRun: LoopRun, wake: WakeState, reasons: readonly WakeReason[], now: number): void {
  const { state } = loopRun;
  wake.wakes += 1;
  wake.lastWakeAt = now;
  // The cap holds the run's news back, never the user: a wake that is theirs alone is not counted.
  const capped = reasons.some((reason) => !USER_WAKES.has(reason));
  wake.wakesAt = [...wake.wakesAt.filter((at) => at > now - WAKE_WINDOW_MS), ...(capped ? [now] : [])];
  wake.idleDue = false;
  // Asked once: a run that went idle under a resting lead is asked here, not by `afterTurn`.
  if (reasons.includes(WakeCause.IdleAsk)) wake.idleAsked = true;
  wake.userWaiting = false;
  if (wake.finishNew) wake.finishSaid = true;
  wake.finishNew = false;
  if (reasons.includes(WakeCause.PlanWindow)) wake.planWindowSaid = state.planReviewUntil;
  if (reasons.includes(WakeCause.FinishMark)) {
    wake.finishMarkSaid = true;
    wake.finishMarkDue = false;
  }
  // The workers' limit has lifted: gone from the run, so nothing names it or wakes for it again.
  if (reasons.includes(WakeCause.WorkersLimitLifted)) state.workerLimit = null;
  if (!reasons.includes(WakeCause.WrapUp)) return;
  wake.wrapping = true;
  if (!wake.wrapCause) wake.wrapCause = WrapCause.Deadline;
}

/** Does this run commission a duration rather than goal completion? */
const isDirection = (loopRun: LoopRun): boolean => durationCommission(loopRun.run);

/** How this wake's message ends: the wrap-up, the idle question, or carry on. */
function closingFor(loopRun: LoopRun, wake: WakeState, reasons: readonly WakeReason[], now: number): string {
  const { finalDeadline, run, state } = loopRun;
  if (wake.wrapping) {
    const wrapUp = wrapUpPrompt({
      run,
      finalDeadline,
      integrationHead: state.integrationHead,
      integrationHealthy: state.integrationHealthy,
      workers: [...state.workers.values()],
      fromScratch: state.fromScratch,
    });
    return wrapLead(wake.wrapCause ?? WrapCause.Deadline, wrapUp);
  }
  if (reasons.includes(WakeCause.IdleAsk))
    return idleAsk({
      direction: isDirection(loopRun),
      minutesLeft: minutes(loopRun.softDeadline - now),
      // Past the finish mark the idle question repeats its rule, never asks for a new part.
      finishing: wake.finishMarkSaid,
    });
  return carryOn();
}

/** One worker as the digest names it. */
function digestWorker(worker: Worker, now: number): DigestWorker {
  const line = waitDigest(worker, now);
  return {
    id: worker.id,
    title: worker.title,
    state: worker.state,
    minutesLeft: line.minutesLeft,
    round: line.round,
    accepted: line.accepted,
    passing: line.passing,
    mandatoryFix: line.mandatoryFix,
    minutesInRound: line.minutesInRound,
    filesChanged: line.filesChanged,
    violations: line.violations,
    lastLook: line.lastLook,
    stoppedBecause: line.stoppedBecause,
    ideas: latestIdeas(worker),
    // A finishing worker says its stage: its reviewers' next big step is not its work.
    ...(isFinishing(worker.spec) ? { stage: FacetStage.Finish } : {}),
  };
}

/** What the worker's reviewers proposed last: its newest round that proposed anything. */
function latestIdeas(worker: Worker): string[] {
  const proposed = [...worker.iterations].reverse().find((round) => round.ideas?.length);
  return proposed?.ideas ?? [];
}

/** Workers running, and how many the pool allows at once, from the last capacity the studio gave. */
function workerRoom(loopRun: LoopRun): WorkerRoom | null {
  const cap = loopRun.capacity;
  if (!cap || typeof cap.max !== "number") return null;
  const allowed = cap.headless === false ? 1 : Math.min(MAX_WORKERS, workerWindows(cap.max));
  return { running: loopRun.runningWorkers().length, allowed };
}

/** The workers' engine limit while it is still ahead (or the engine never said when it resets). */
function workersLimitFacts(state: LoopRunState, now: number): WorkersLimitFacts | null {
  const limit = state.workerLimit;
  if (!limit) return null;
  const liftsAt = workersLimitLifts(state);
  if (liftsAt !== null && liftsAt <= now) return null;
  return { engine: limit.engine, kind: limit.kind, liftsAt };
}

/**
 * The run, its kind and its plan, for the build card — and, once a wake said the finish mark, that
 * the build is in its finish stage, so the card changes and the next wake carries it again.
 */
function cardFacts(loopRun: LoopRun, finishing = false): CardFacts {
  const { run, state } = loopRun;
  // What the run will not build rides on the card beside the clipped goal (loop/scope.ts).
  const cut = runScope(run)?.cut ?? [];
  return {
    runId: run.runId,
    project: run.project,
    goal: workingGoal(run),
    direction: isDirection(loopRun),
    plan: state.plan
      ? { summary: String(state.plan.summary ?? ""), parts: (state.plan.workers ?? []).map((w: AnyRecord) => w.id) }
      : null,
    lead: Boolean(loopRun.lead),
    ...(cut.length ? { cut } : {}),
    ...(finishing ? { finishing } : {}),
    ...(goalCommission(run) ? { goalCommission: true } : {}),
  };
}

/** How much of the run's working time has gone by at `now`, on its own clock (a Resume's goes on from the time worked). */
const workedAt = (loopRun: LoopRun, now: number): number => now - (loopRun.clock?.started ?? loopRun.started);

/**
 * A goal build's required outcomes for the digest while some are unverified (progress.ts
 * `outcomeTally`), and whether this wake carries the nudge to verify them; null when there is
 * nothing to say — a timed build, no outcomes yet, or every one verified.
 */
function outcomesNow(loopRun: LoopRun, nudge: boolean): OutcomeFacts | null {
  const ledger = loopRun.state.goals;
  if (!ledger || isDirection(loopRun)) return null;
  const tally = outcomeTally(ledger, loopRun.state.integrationHead);
  return tally.unverified.length ? { ...tally, nudge } : null;
}

/**
 * Is this wake owed the nudge to verify the outcomes (progress.ts `verifyNudgeDue`): every so much
 * working time, and after each of the art director's reviews. Never in the wrap-up, which has its
 * own rule. Owed, it is marked said.
 */
function nudgeNow(loopRun: LoopRun, wake: WakeState, now: number): boolean {
  const ledger = loopRun.state.goals;
  if (!ledger || wake.wrapping || isDirection(loopRun)) return false;
  const shipAt = loopRun.state.lastShip?.at ?? null;
  const due = verifyNudgeDue({
    tally: outcomeTally(ledger, loopRun.state.integrationHead),
    workedMs: workedAt(loopRun, now),
    nudgedWorkedMs: wake.verifyNudgedWorkedMs,
    reviewedSince: shipAt !== null && shipAt !== wake.verifyNudgedShipAt,
  });
  if (!due) return false;
  wake.verifyNudgedWorkedMs = workedAt(loopRun, now);
  wake.verifyNudgedShipAt = shipAt;
  return true;
}

/**
 * The digest's facts, read from the run at the moment of the wake. The workers from before the
 * pause get their full lines only when `priorInFull` (a resumed run's first digest); every later
 * digest names them in one line — they do not change, and each line is a few hundred characters.
 * A goal build's outcomes are named on every one, with the nudge to verify them when `nudge`.
 */
function digestFacts(
  loopRun: LoopRun,
  wake: WakeState,
  said: Pick<DigestFacts, "now" | "reasons" | "userSays" | "finishNew" | "happened" | "closing">,
  { priorInFull = false, nudge = false }: { priorInFull?: boolean; nudge?: boolean } = {},
): DigestFacts {
  const { finalDeadline, ledgerLines, state } = loopRun;
  const priorLine = priorInFull ? null : priorWorkersSummary(loopRun);
  return {
    ...said,
    softDeadline: loopRun.softDeadline,
    finalDeadline,
    wrapping: wake.wrapping,
    integrationHead: state.integrationHead,
    integrationHealthy: state.integrationHealthy,
    defects: state.ledger.length ? ledgerLines() : [],
    workers: [
      ...[...state.workers.values()].map((worker) => digestWorker(worker, said.now)),
      ...(priorInFull ? priorDigestWorkers(loopRun) : []),
    ],
    room: workerRoom(loopRun),
    ...(priorLine ? { priorLine } : {}),
    planWindowUntil: planWindowOpen(state, said.now) ? state.planReviewUntil : null,
    workersLimit: workersLimitFacts(state, said.now),
    finishRequested: wake.finishSaid,
    finishMarkAt: finishMarkView(loopRun, wake, said.now),
    ...(wake.finishMarkSaid ? { finishMarkPassed: true } : {}),
    outcomes: outcomesNow(loopRun, nudge),
    // Only a timed build's card changes at the mark: a goal build's is not sent again for it.
    card: cardFacts(loopRun, wake.finishMarkSaid && isDirection(loopRun)),
  };
}

/**
 * A wake the user is part of does not take the art director's regular look, which holds the turn
 * for minutes: the look stays due and comes with the next wake.
 */
function userFirst(due: Wake): Wake {
  if (!due.reasons.some((reason) => USER_WAKES.has(reason))) return due;
  return { ...due, reasons: due.reasons.filter((reason) => reason !== WakeCause.ShipLook) };
}

/** The message that wakes the lead: the user's words, the news, the run, the card and the closing. */
async function wakePrompt(loopRun: LoopRun, wake: WakeState, woken: Wake, clock: WakeClock): Promise<string> {
  const due = userFirst(woken);
  // The art director looks before anything is read, so where its defects went is this wake's news.
  const art = await artFor(loopRun, wake, due.reasons, clock);
  const now = clock.now();
  noteShipLooks(loopRun, wake, now);
  const userSays = await tellUser(loopRun, wake);
  const happened = readUnread(loopRun);
  const finishNew = wake.finishNew;
  markSaid(loopRun, wake, due.reasons, now);
  await loopRun.appendRun(RunEvent.DirectorContinued, {
    minutesLeft: minutes(loopRun.softDeadline - now),
    reasons: due.reasons,
  });
  const closing = [art, closingFor(loopRun, wake, due.reasons, now)].filter(Boolean).join("\n\n");
  const said = { now, reasons: due.reasons, userSays, finishNew, happened, closing };
  const told = digestFacts(loopRun, wake, said, { nudge: nudgeNow(loopRun, wake, now) });
  const director = loopRun.journal.director;
  const card = JSON.stringify(told.card);
  const includeCard = director.lastWakeCard !== card;
  // Held to its budget: the oldest news gives way first, and the user's words never do.
  const render = (lines: readonly string[]) => wakeDigest({ ...told, happened: lines, userSays: [] }, includeCard);
  const facts = { ...told, happened: fitHappened(told.happened, render, WAKE_TOKEN_BUDGET) };
  const prompt = wakeDigest(facts, includeCard);
  director.lastWakeCard = card;
  // A fresh session opened for this message has never seen the card the digest leaves out.
  wake.cardLeftOut = includeCard ? "" : cardText(facts);
  const estimatedTokens = estimateTokens(wakeDigest({ ...facts, userSays: [] }, includeCard));
  director.wakePayload = {
    estimatedTokens,
    budget: WAKE_TOKEN_BUDGET,
    overBudget: estimatedTokens > WAKE_TOKEN_BUDGET,
    peakEstimatedTokens: Math.max(director.wakePayload?.peakEstimatedTokens ?? 0, estimatedTokens),
    excludes: "user messages, attachments and provider-managed prior context",
  };
  // What the lead has now been told is heard: a restart during its turn does not tell it again.
  await keepWake(loopRun, wake, now);
  return prompt;
}

/**
 * The art director's paragraph a wake carries: the finish mark's, which also covers a regular look
 * due with it, or the regular look's (`regularLook`) — or none.
 */
function artFor(loopRun: LoopRun, wake: WakeState, reasons: readonly WakeReason[], clock: WakeClock): Promise<string> {
  if (reasons.includes(WakeCause.FinishMark)) return finishMarkBlock(loopRun);
  if (reasons.includes(WakeCause.ShipLook)) return regularLook(loopRun, wake, clock);
  return Promise.resolve("");
}

/**
 * The art director's regular look at the whole game (art-direction.ts `shipLookPass`): its defects
 * go to their owners while they keep building, and the lead reads the verdict, the defects by part
 * and what must not regress. A look that gave no review is tried again a shorter wait later; one
 * that did is counted by `noteShipLooks`, as every review on integration is.
 */
async function regularLook(loopRun: LoopRun, wake: WakeState, clock: WakeClock): Promise<string> {
  if (typeof loopRun.shipLookPass !== "function") return "";
  const before = loopRun.state.lastShip ?? null;
  const pass: ArtDirection = await loopRun.shipLookPass().catch((err: unknown) => ({
    head: loopRun.state.integrationHead,
    review: null,
    skipped: String((err as Error)?.message ?? err),
  }));
  const reviewed = (loopRun.state.lastShip ?? null) !== before;
  if (!reviewed && typeof loopRun.shipLookAfter === "function")
    wake.nextShipLookWorkedMs = loopRun.shipLookAfter({ now: clock.now(), looked: false });
  return shipLookBlock(pass);
}

/**
 * The finish mark's paragraph: the studio's own ship review of the integrated build
 * (art-direction.ts `artDirectionPass`), its defects by part, and the rule from here — or, on a
 * run bound without the art director, the rule alone.
 */
async function finishMarkBlock(loopRun: LoopRun): Promise<string> {
  if (typeof loopRun.artDirectionPass !== "function")
    return artDirectionBlock({ head: loopRun.state.integrationHead, review: null, skipped: ART_SKIPPED.olderTools });
  const pass = await loopRun.artDirectionPass().catch((err: unknown) => ({
    head: loopRun.state.integrationHead,
    review: null,
    skipped: String((err as Error)?.message ?? err),
  }));
  return artDirectionBlock(pass);
}

/** The digest's build card on its own, or nothing from an older wake-prompts.ts that cannot render one. */
function cardText(facts: Parameters<typeof wakeDigest>[0]): string {
  const render = (wakeWords as { buildCard?: (f: typeof facts) => string }).buildCard;
  return typeof render === "function" ? render(facts) : "";
}

/**
 * The news a wake can carry within `budget` tokens of `render`'s text: all of it when it fits;
 * otherwise the newest, halved until it fits, behind one line saying how much was left out (the
 * log still has it — run_status lists it). Exported for the incident tests.
 */
export function fitHappened(
  happened: readonly string[],
  render: (lines: readonly string[]) => string,
  budget: number,
): string[] {
  let kept = [...happened];
  const fits = (lines: readonly string[]) => estimateTokens(render(lines)) <= budget;
  while (!fits(withLeftOut(happened, kept)) && kept.length > 1) kept = kept.slice(-Math.floor(kept.length / 2));
  return withLeftOut(happened, kept);
}

/** `kept`, behind a line naming how many of `all` it leaves out, when it leaves any out. */
function withLeftOut(all: readonly string[], kept: string[]): string[] {
  const left = all.length - kept.length;
  return left > 0
    ? [`(${left} earlier events left out to keep this message short — run_status lists them)`, ...kept]
    : kept;
}

/** A turn that failed outright, as the loop reads it. */
function failedTurn(err: any): Partial<DelegateResult> {
  return { ok: false, stopReason: err?.kind ?? StopReason.Error, errorText: String(err?.message ?? err) };
}

/** The run pauses on `limit` (a provider loss), and its feed says why — once, whatever else failed after it. */
async function pauseOn(loopRun: LoopRun, limit: EngineLimit): Promise<void> {
  if (loopRun.state.limit) return;
  loopRun.state.limit = limit;
  const words = pauseDecision(limit.kind, String(limit.message).slice(0, CLIP_DETAIL));
  await loopRun.decision(words.line, words.plain);
}

/**
 * A lead turn a lost provider ended pauses the run: a lost sign-in or a limit (the session's own
 * catch has kept one already, director.ts `directorTalk`), or an outage the patience ladder could not
 * outlast. A first turn pauses too: a provider gone is no crash of the run. Answers whether it did.
 */
async function pauseOnProvider(loopRun: LoopRun, err: any, now: number): Promise<boolean> {
  if (loopRun.ctx.cancelled) return false;
  if (isProviderLoss(err?.kind)) {
    // Judges on the lead's engine stop asking it too, until the run resumes or the limit resets.
    noteProviderLoss(loopRun.run.runId, loopRun.run.engine, err, now);
    await pauseOn(loopRun, engineLimitOf(err, now));
    return true;
  }
  if (!isTransientProviderError(err)) return false;
  await pauseOn(loopRun, {
    kind: EngineFailure.Unavailable,
    message: String(err?.message ?? err),
    retryAfterMs: null,
    at: now,
  });
  return true;
}

/**
 * A sign-in lost on any engine of the run — a worker's, a judge's (provider-loss.ts `lostSignIn`) — pauses
 * the run at the lead's next turn: no worker can build and no round can be judged until the user
 * fixes it. Answers whether the run is paused on one.
 */
async function pauseOnLostSignIn(loopRun: LoopRun, now: number): Promise<boolean> {
  const lost = lostSignIn(loopRun.run.runId, now);
  if (!lost || loopRun.ctx.cancelled) return false;
  await pauseOn(loopRun, {
    kind: lost.kind,
    message: `${lost.engine}: ${lost.message}`,
    retryAfterMs: null,
    at: lost.at,
  });
  return true;
}

/**
 * Did the lead's turn come back failed on the provider's outage (a 529, a dropped gateway) rather
 * than throw it? It is asked again on the outage ladder like a thrown one (`patientSession`).
 */
function endedOnOutage(result: Partial<DelegateResult>): boolean {
  const failed = result?.ok === false && result.stopReason !== StopReason.Stopped;
  if (!failed || isProviderLoss(result.stopReason)) return false;
  return isTransientProviderError(String(result.errorText ?? ""));
}

/** Why the lead's session is gone and a fresh one must carry the run, or null when it is not. */
function lostSessionWhy(talk: DirectorTalk, err: any): string | null {
  if (talk.sessionId && isResumeFailure(err)) return SESSION_LOST_WHY.resumeFailed;
  const full = err?.kind === EngineFailure.ContextOverflow || err?.kind === EngineFailure.ContextThreshold;
  return full ? SESSION_LOST_WHY.contextFull : null;
}

/** The lead's notes and the log it has already read, for a fresh session. */
function freshContext(loopRun: LoopRun): { notes: string[]; recent: string[] } {
  const notes = (loopRun.journal.director?.notes ?? []).slice(-FRESH_NOTES).map((n: AnyRecord) => String(n.text));
  const recent = loopRun.state.log
    .filter((entry) => entry.seq <= loopRun.waitSeq)
    .slice(-FRESH_LOG_LINES)
    .map((entry) => entry.text);
  return { notes, recent };
}

/**
 * A new session for a later turn. It knows nothing of the run, so it is told the brief, the
 * rules, the lead's notes, the run so far and this turn's message — never the message alone.
 */
function openFresh(
  loopRun: LoopRun,
  kit: TurnKit,
  turn: TurnAsk,
  { why, card }: { why: string; card: string },
): Promise<Partial<DelegateResult>> {
  const text = freshStart({
    why,
    brief: kit.brief(),
    rules: wakeRules({ heartbeatMinutes: minutes(HEARTBEAT_MS) }),
    ...freshContext(loopRun),
    digest: turn.prompt,
    card,
    lead: Boolean(loopRun.lead),
  });
  return kit.talk.session(text, null, turn.deadline - kit.clock.now());
}

/**
 * The lead's session is lost — it cannot be resumed, or its context is full: a fresh one carries
 * the run (`openFresh`). On the first turn the message already is the brief.
 */
async function freshSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
  why: string,
): Promise<Partial<DelegateResult>> {
  const { talk, clock } = kit;
  if (wake.freshSessions >= MAX_FRESH_SESSIONS)
    return { ok: false, stopReason: StopReason.Error, errorText: `the lead's session was lost too often (${why})` };
  wake.freshSessions += 1;
  talk.sessionId = null;
  // The first turn already carries the brief: a Resume whose old session is gone opens a new one silently.
  if (wake.turns === 1) return talk.session(turn.prompt, null, turn.deadline - clock.now());
  await loopRun.decision(
    `the director's session was lost (${why}); a fresh session carries the run on`,
    "the lead's conversation was lost, so a fresh one picks the build up from its notes",
  );
  return openFresh(loopRun, kit, turn, { why, card: wake.cardLeftOut ?? "" });
}

/**
 * The lead's session asked this turn's message — and asked again, after a wait on the loop's clock,
 * while the host refuses it because another session holds its lock (`folderBusy`): that passes.
 */
async function askSession(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  const { talk, clock } = kit;
  for (let tries = 0; ; tries += 1) {
    let result: Partial<DelegateResult>;
    try {
      result = await talk.session(turn.prompt, talk.sessionId, turn.deadline - clock.now());
    } catch (err: any) {
      if (!folderBusy(err) || tries >= MAX_BUSY_RETRIES || loopRun.ctx.cancelled) throw err;
      await clock.sleep(BUSY_RETRY_MS);
      continue;
    }
    if (!endedOnOutage(result)) return result;
    throw Object.assign(new Error(String(result.errorText)), { kind: EngineFailure.Unavailable });
  }
}

/**
 * The lead's session asked, with a provider outage waited out on the run's outage ladder within
 * the turn's deadline: an overloaded gateway on one wake used to end the whole run —
 * workers stopped, head landed, run reported done. What the ladder cannot outlast still fails.
 */
function patientSession(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  return withProviderPatience(loopRun.ctx, () => askSession(loopRun, kit, turn), {
    deadline: turn.deadline,
    delays: outageDelays(loopRun.run),
    label: "the lead's provider",
    onWait: ({ wait, error }) =>
      loopRun.decision(
        `the lead's provider failed (${error}); asking it again in ${Math.ceil(wait / SECOND_MS)} s`,
        "the lead's provider is briefly down, so the studio waits and asks again; the builders keep working",
      ),
  });
}

/**
 * One delegation of the lead's session, or a fresh session when its own is lost — or when a later
 * turn has none to resume (a fresh one that met the engine's limit before it began). A failure on
 * the first turn is the run's (the crash close); on a later one it is a failed turn — and so is a
 * first turn the host kept refusing because its lock stayed busy: the run closes on its own terms.
 */
async function sessionOrFresh(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  const failed = async (err: any): Promise<Partial<DelegateResult>> => {
    if (await pauseOnProvider(loopRun, err, kit.clock.now())) return failedTurn(err);
    if (wake.turns === 1 && !folderBusy(err)) throw err;
    return failedTurn(err);
  };
  if (!talk.sessionId && wake.turns > 1)
    return openFresh(loopRun, kit, turn, { why: SESSION_LOST_WHY.noSession, card: wake.cardLeftOut ?? "" }).catch(
      failed,
    );
  let result: Partial<DelegateResult>;
  try {
    result = await patientSession(loopRun, kit, turn);
  } catch (err: any) {
    const why = lostSessionWhy(talk, err);
    if (!why) return failed(err);
    return freshSession(loopRun, wake, kit, turn, why).catch(failed);
  }
  if (result?.stopReason !== StopReason.ContextOverflow) return result;
  return freshSession(loopRun, wake, kit, turn, SESSION_LOST_WHY.contextOverflowed).catch(failed);
}

/** Is the lead's own session limit one to wait out: a rate limit that resets well before this turn's deadline? */
function limitToWait(loopRun: LoopRun, wake: WakeState, deadline: number, now: number): boolean {
  const { ctx, state } = loopRun;
  const limit = state.limit;
  if (!limit || limit.kind !== EngineFailure.RateLimit || state.finished || ctx.cancelled) return false;
  const waitMs = limit.retryAfterMs ?? 0;
  const resetsInTime = now + waitMs + LIMIT_WAIT_MARGIN_MS <= deadline;
  return waitMs > 0 && wake.limitWaits < MAX_LIMIT_WAITS && resetsInTime;
}

/** Wait `ms` on the loop's clock, reading the inbox as the lead would; false when the user stopped the run. */
async function sleepThrough(loopRun: LoopRun, wake: WakeState, ms: number, clock: WakeClock): Promise<boolean> {
  const until = clock.now() + ms;
  while (clock.now() < until && !loopRun.ctx.cancelled) {
    await collect(loopRun, wake, clock.now());
    await clock.sleep(Math.min(WAKE_POLL_MS, until - clock.now()));
  }
  return !loopRun.ctx.cancelled;
}

/**
 * What the lead is told after a limit it was made to wait out: that, this turn's message, and
 * what happened since. With no session to resume it goes out inside a fresh start (`sessionOrFresh`).
 */
async function retryPrompt(loopRun: LoopRun, wake: WakeState, kit: TurnKit, turn: { prompt: string }, waitMs: number) {
  // The brief already reached a session that exists; a wake's message may not have.
  const again = wake.turns > 1 || !kit.talk.sessionId ? turn.prompt : "";
  // The words that message carried ride again with it.
  const carried = again ? wake.promptWords : [];
  const userSays = await tellUser(loopRun, wake);
  wake.promptWords = [...carried, ...userSays];
  const happened = readUnread(loopRun);
  return [limitResumePrompt(minutes(waitMs)), again, sinceThen({ userSays, happened })].filter(Boolean).join("\n\n");
}

/**
 * The lead's own session limit, on any turn: one that resets well before the turn's deadline is
 * waited out while the workers keep going, and the same session carries on.
 */
async function waitOutLimit(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
  first: Partial<DelegateResult>,
): Promise<Partial<DelegateResult>> {
  let result = first;
  while (limitToWait(loopRun, wake, turn.deadline, kit.clock.now())) {
    const waitMs = loopRun.state.limit?.retryAfterMs ?? 0;
    wake.limitWaits += 1;
    await loopRun.decision(
      `waiting ${minutes(waitMs)} minutes for the engine's limit to reset; the workers keep going`,
      `waiting about ${minutes(waitMs)} minutes for that limit to reset; the builders keep working`,
    );
    if (!(await sleepThrough(loopRun, wake, waitMs, kit.clock))) return result;
    loopRun.state.limit = null;
    const prompt = await retryPrompt(loopRun, wake, kit, turn, waitMs);
    result = await watchedSession(loopRun, wake, kit, { prompt, deadline: turn.deadline });
  }
  return result;
}

/**
 * One turn of the lead's session, its limit waits included: until the working deadline, or the
 * run's end for the wrap-up. A turn that works on its message has heard what that message told it.
 */
async function oneTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
): Promise<Partial<DelegateResult>> {
  wake.turns += 1;
  const deadline = wake.wrapping ? loopRun.finalDeadline - WRAP_UP_MARGIN_MS : loopRun.softDeadline;
  const turn = { prompt, deadline };
  const result = await waitOutLimit(loopRun, wake, kit, turn, await watchedSession(loopRun, wake, kit, turn));
  await settleTold(wake, result);
  await kit.talk.keep(result);
  return result;
}

/**
 * The user's words a turn's message told: heard once the turn works on it, or answers; owed to the
 * next message when it failed first (an error, a limit) — unless it was cut before it read it, and
 * is asked that same message again (`takeTurn`). A failed turn is followed by the wrap-up or the
 * close (`afterTurn`), so owed words are said at most once more.
 */
async function settleTold(wake: WakeState, result: Partial<DelegateResult>): Promise<void> {
  const worked = result?.ok === true || startedWorking(result);
  if (!worked && wake.cut) return;
  if (worked) await wake.line?.heardThrough(wake.promptThrough);
  else wake.owed.unshift(...wake.promptWords);
  wake.promptWords = [];
}

/** Did the session read its message before it ended: it has a session and took a turn. */
const startedWorking = (result: Partial<DelegateResult>): boolean =>
  Boolean(result?.sessionId) && (result?.turns ?? 0) > 0;

/**
 * One turn of the lead's, and its resumptions. A turn cut short to hand the lead the user's words
 * is resumed at once in the same session, told it was cut, their words first (a wake of the
 * user's) — or, cut before it read its message, asked that message again with their words after
 * it. A cut is never a failed turn.
 */
async function takeTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
): Promise<Partial<DelegateResult>> {
  let asked = prompt;
  let result = await oneTurn(loopRun, wake, kit, asked);
  while (wake.cut && !loopRunOver(loopRun)) {
    wake.cut = false;
    asked = startedWorking(result)
      ? cutShortWake(
          await wakePrompt(loopRun, wake, { at: kit.clock.now(), reasons: [WakeCause.UserMessage] }, kit.clock),
        )
      : await askAgain(loopRun, wake, asked);
    result = await oneTurn(loopRun, wake, kit, asked);
  }
  wake.cut = false;
  return result;
}

/** A turn cut before it read its message is asked it again — its words and all — with the user's newer words after it. */
async function askAgain(loopRun: LoopRun, wake: WakeState, asked: string): Promise<string> {
  const carried = wake.promptWords;
  const userSays = await tellUser(loopRun, wake);
  wake.promptWords = [...carried, ...userSays];
  return [asked, sinceThen({ userSays, happened: [] })].filter(Boolean).join("\n\n");
}

/**
 * A later turn with a session to resume may be cut short for the user's words: never the first
 * (its brief), the wrap-up, a turn whose run is already over (its `finish` may be under way), or
 * one inside a tool call — cut there, the lead never gets the call's answer (tools.ts counts them).
 */
function mayCut(loopRun: LoopRun, wake: WakeState, kit: TurnKit): boolean {
  const later = wake.turns > 1 && Boolean(kit.talk.sessionId);
  const inCall = (loopRun.toolsInFlight ?? 0) > 0;
  return later && !inCall && !wake.wrapping && !loopRunOver(loopRun);
}

/**
 * What a turn under way was handed to read at its next step, by the id it went in under: the words,
 * and how many of the chat's messages the line had been handed then.
 */
type Handed = Map<string, { words: string[]; through: number }>;

/**
 * Hand the user's words to the lead's turn under way (`engine.steer`, addressed by the run): an
 * engine that reads input mid-turn takes them at its next step (`handed`, settled against what the
 * turn says it read); one that cannot is cut short when `mayCut`, and resumed with them
 * (`wake.cut`) — asked with `interrupt: false` otherwise. Words neither took open the lead's next
 * message.
 */
async function handMidTurn(loopRun: LoopRun, wake: WakeState, kit: TurnKit, handed: Handed, id: string): Promise<void> {
  // A run that is over hears nothing more: what was sent stays untold rather than said to no one.
  if (loopRunOver(loopRun)) return;
  const { words, through } = await userWords(loopRun, wake);
  if (!words.length) return;
  const answer = await loopRun.ctx
    .call(HostMethod.EngineSteer, {
      threadId: loopRun.threadId,
      into: loopRun.run.runId,
      messages: [{ id, text: midTurnUserSays(words) }],
      interrupt: mayCut(loopRun, wake, kit),
    })
    .catch(() => null);
  const how = answer?.accepted.includes(id) ? answer.how : null;
  if (how === SteerDelivery.Native) {
    handed.set(id, { words, through });
    return;
  }
  wake.owed.push(...words);
  if (how === SteerDelivery.Interrupt) wake.cut = true;
}

/**
 * Watch a session call under way for the user's words (live chat): at once, then each time a
 * message is handed to the lead, until the call ends or it is cut short for them.
 */
function watchTurn(loopRun: LoopRun, wake: WakeState, kit: TurnKit, line: LeadLine) {
  const handed: Handed = new Map();
  let over = false;
  let count = 0;
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const watching = (async () => {
    while (!over && !wake.cut) {
      const next = line.heard();
      await handMidTurn(loopRun, wake, kit, handed, `lead_${wake.turns}_${++count}`);
      await Promise.race([next, ended]);
    }
  })();
  const stop = async (): Promise<void> => {
    over = true;
    end();
    await watching.catch(() => {});
  };
  return { handed, stop };
}

/** One session call, watched for the user's words while it runs; what it read is heard, what it did not is owed. */
async function watchedSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  if (!kit.line) return sessionOrFresh(loopRun, wake, kit, turn);
  const watch = watchTurn(loopRun, wake, kit, kit.line);
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await sessionOrFresh(loopRun, wake, kit, turn);
    return result;
  } finally {
    await watch.stop();
    let read = 0;
    for (const [id, told] of watch.handed) {
      if (result?.steered?.includes(id)) read = Math.max(read, told.through);
      else wake.owed.push(...told.words);
    }
    await kit.line.heardThrough(read);
  }
}

/** The journal keeps the loop's own state and the run's record (loop-run.ts `saveJournal`) as they stand now. */
async function keepWake(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  journalWake(loopRun, wake);
  wake.journaledSeq = loopRun.logSeq;
  wake.journaledAt = now;
  await loopRun.saveJournal();
}

/**
 * The lead rests: its own lines up to here are quiet, the journal holds what a restart needs, and
 * a round that lands from now on is saved with the wake it causes (`run.resting`).
 */
async function rest(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  wake.asleepFromSeq = loopRun.logSeq;
  wake.asleepSince = now;
  loopRun.resting = true;
  await keepWake(loopRun, wake, now);
}

/**
 * The run as a series of the lead's turns. The first opens with the brief and the rules; each
 * later one is a wake with a digest; the wrap-up is the last. Returns when the run is over for
 * the lead — finished, stopped, paused on a limit, wrapped up, or out of time — and the caller
 * closes what it left open.
 */
export async function runWakeLoop(
  loopRun: LoopRun,
  talk: DirectorTalk,
  brief: () => string,
  clock: WakeClock = SYSTEM_CLOCK,
  line: LeadLine | null = null,
): Promise<WakeOutcome> {
  // A resumed run takes back what its journal kept of the loop: the idle question, the wake cap.
  const restored = resumedFromJournal(loopRun)
    ? restoredWake(loopRun.priorJournal?.director?.wake, clock.now())
    : undefined;
  const wake = newWakeState(restored);
  // A review a Resume restored was counted, and nudged after, before the pause.
  wake.shipSeen = loopRun.state.lastShip ?? null;
  wake.verifyNudgedShipAt = loopRun.state.lastShip?.at ?? null;
  const kit: TurnKit = { talk, brief, clock, line };
  // This loop answers for what its lead hears of the chat: what it never hears goes back at the end.
  wake.line = line;
  line?.attend();
  // The parts the lead calls (the plan hold, worker_start) answer a run the wake loop drives
  // with "end your turn"; a kept older director.ts runs the long turn and never marks its run.
  loopRun.waking = true;
  // Working time already over — a Resume after it, or a start that took all of it: the first turn is the wrap-up.
  if (clock.now() >= loopRun.softDeadline) {
    wake.wrapping = true;
    wake.wrapCause = WrapCause.Deadline;
  }
  const first = await firstPrompt(loopRun, wake, brief, clock.now());
  // The wrap-up takes no more of the chat: what is sent from now on waits for the run to close.
  if (wake.wrapping) line?.shut();
  let result = await takeTurn(loopRun, wake, kit, first);
  for (;;) {
    const verdict = afterTurn(await turnFacts(loopRun, wake, result, clock.now()));
    if (verdict.next === TurnEnd.Close) break;
    settleTurn(loopRun, wake, verdict, result, clock.now());
    await rest(loopRun, wake, clock.now());
    const due = await sleepUntilDue(loopRun, wake, kit);
    loopRun.resting = false;
    if (!due) break;
    // A sign-in a worker or a judge lost while the lead slept pauses the run before it is woken.
    if (await pauseOnLostSignIn(loopRun, clock.now())) break;
    const prompt = await wakePrompt(loopRun, wake, due, clock);
    if (wake.wrapping) line?.shut();
    result = await takeTurn(loopRun, wake, kit, prompt);
  }
  journalWake(loopRun, wake);
  return { result, wrapCause: wake.wrapCause, failed: wake.failed };
}

/**
 * Put the wake loop's own state on the journal (`journal.director.wake`, journal.ts `wakeRecord`),
 * and the run's record with it: a kept loop-run.ts from before the full journal saves without
 * writing the record (`recordLoopRun` is idempotent). The caller saves it.
 */
export function journalWake(loopRun: LoopRun, wake: WakeState): void {
  const director = loopRun.journal?.director;
  if (!director) return;
  recordLoopRun(loopRun);
  director.wake = wakeRecord(wake);
}
