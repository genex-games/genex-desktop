/**
 * The Loop's wake loop. The lead ends its turn when it decides to; between turns nothing of it runs;
 * the studio wakes the SAME session with a message when something happens — the user speaks, a worker
 * ends or asks, a job ends, the project's app stops, the working time ends (wake-schedule.ts decides
 * which). One turn at a time: what arrives during a turn reaches it mid-turn when its engine can take
 * it, or opens the next message. The limit wait and the fresh-session fallback cover every turn.
 *
 * The journal holds what the loop needs after a restart (journal.ts); a resumed run's first message
 * is read from it. The lead answers the chat while the run is going (live chat, lead-line.ts).
 * Its functions take the run explicitly; they are not bound onto it.
 */
import { isResumeFailure } from "../chat-session.ts";
import { fireHooks, HookEvent, type HookScope, runScope as runMoment } from "../hooks.ts";
import { HOOK_PROMPTS } from "../hooks-prompts.ts";
import { type HeldBack, heldTurnEnding, heldTurnResult, turnsHeldWords } from "./held-words.ts";
import { whileTurnHeld } from "./turn-hold.ts";
import { HostMethod } from "../host-methods.ts";
import { jobEndLine } from "../jobs/prompts.ts";
import { JOB_POLL_MS, jobEnds } from "../jobs/watch.ts";
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
import { MINUTE_MS, minutes, SECOND_MS } from "../time.ts";
import { estimateTokens } from "../prompt.ts";
import { limitResumePrompt, wrapUpPrompt } from "./briefs.ts";
import { recordLoopRun, restoredWake, resumedFromJournal, wakeRecord } from "./journal.ts";
import { folderBusy } from "./lead-session.ts";
import { noteTurnEnds, noteTurnOver } from "./turn-ends.ts";
import { closeUnderWay } from "./close-latch.ts";
import { activeWork, leadsOpenLoop, workAtHand } from "./open/active-work.ts";
import { OPEN_TURN_MS, OPEN_WALL_CLOCK } from "./open/contract.ts";
import { openClosingOf, openDigestOf } from "./open/digest.ts";
import { healthWatch } from "./open/health.ts";
import { heardMidTurn, noteWorkerQuestions, watchOpenTurn } from "./open/news.ts";
import { watchTurnNews } from "./turn-news.ts";
import { openTurnBegins } from "./open/between.ts";
import { openWakeRules } from "./open/prompts.ts";
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
import * as liveChat from "../live-chat.ts";
import * as messageQueue from "../message-queue.ts";
import { afterTurn, nextWake, NoteKind, TurnEnd, WAKE_WINDOW_MS, WakeCause, WRAP_UP_MARGIN_MS, WrapCause } from "./wake-schedule.ts";
import { cutShortWake, midTurnUserSays } from "./live-prompts.ts";
import { turnEndAtCap, keepRunClock, withCapWatch, withCapWords } from "./cap-lines.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { DelegateResult } from "../../types/host-api.d.ts";
import type { RestoredWake } from "./journal.ts";
import type { LeadLine } from "./lead-line.ts";
import type { LoopRun } from "./loop-run.ts";
import type { DigestFacts } from "./wake-prompts.ts";
import type { TurnFacts, TurnVerdict, Wake, WakeReason, WakeView } from "./wake-schedule.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;
/** This part wakes an open Loop's lead too (a project that isn't a web game): a run reads it by namespace. */
export const SERVES_OPEN_LOOP = true;

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
 * A turn the host refused because another session holds the lead's lock is asked again after this
 * wait, at most this many times; an open Loop's lead waits within its working time instead.
 */
export const BUSY_RETRY_MS = 15 * SECOND_MS;
export const MAX_BUSY_RETRIES = 4;
/** News that reaches a resting lead is saved once it has waited this long for a wake that did not come. */
const JOURNAL_NEWS_MS = 5 * SECOND_MS;
/** A wake message's news is held to about this many tokens: the oldest gives way first. */
const WAKE_TOKEN_BUDGET = 8_000;

/** The user's own reasons to wake the lead: never held back by the hourly cap, so never counted in it. */
const USER_WAKES: ReadonlySet<WakeReason> = new Set<WakeReason>([WakeCause.UserMessage, WakeCause.FinishRequested]);

/** An open Loop's lead going straight on with its own work: never counted in the wake cap. */
const SELF_CONTINUED: ReadonlySet<WakeReason> = new Set<WakeReason>([WakeCause.CarryOn, WakeCause.TurnCap]);

/** The lead's session as the run talks to it: one turn at a time, and the session id it resumes. */
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
export const SYSTEM_CLOCK: WakeClock = { now: () => Date.now(), sleep: (ms) => OPEN_WALL_CLOCK.sleep(ms) };

/** Why a run the waking lead left open ended, when the wrap-up had a cause of its own (the report's sentence). */
export const WAKE_ENDING = {
  [WrapCause.Idle]: "the lead had nothing left to run and did not call finish in its wrap-up",
  [WrapCause.Finish]: "the user asked to finish and the lead did not call finish in its wrap-up",
} as const satisfies Partial<Record<WrapCause, string>>;

/** What the loop keeps between the lead's turns. */
export interface WakeState {
  turns: number;
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
  /** The user's words the lead was told although the store refused to record their hand-over. */
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
  /** The session's first message, when a plugin held its turn back: it opens the next one (`heldTurn`). */
  heldFirst?: string;
  finishNew: boolean;
  finishSaid: boolean;
  /** The log's sequence number, and the time, the loop last saved the journal. */
  journaledSeq: number;
  journaledAt: number;
  limitWaits: number;
  freshSessions: number;
  /** The turn whose failure started the wrap-up. */
  failed: Partial<DelegateResult> | null;
  /** When the run's job ends were last asked for (null: not yet). */
  jobsPolledAt: number | null;
  /** When the turn under way reaches its own cap (an open Loop's), or null for a turn with none. */
  turnCapAt?: number | null;
  /** When the turn's session last returned, before anything ran between turns. */
  turnReturnedAt?: number | null;
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
    journaledSeq: 0,
    journaledAt: 0,
    limitWaits: 0,
    freshSessions: restored.freshSessions ?? 0,
    failed: null,
    jobsPolledAt: null,
  };
}

/**
 * The run is over for the lead: it finished, the user stopped it, or it failed on its own; or its
 * close has started; or, an open Loop, it pauses because the project's app couldn't be brought back.
 */
const loopRunOver = (loopRun: LoopRun): boolean =>
  loopRun.state.finished ||
  loopRun.ctx.cancelled === true ||
  Boolean(loopRun.report.failure) ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  Boolean(loopRun.open?.halted);

/** Of the inbox's untold steers, what the lead has not heard: those it was told on a refused hand-over lead the list. */
function unheard(wake: WakeState, untold: readonly string[]): string[] {
  const stillLeading = wake.heardUnrecorded.every((text, i) => untold[i] === text);
  if (!stillLeading) wake.heardUnrecorded = [];
  return untold.slice(wake.heardUnrecorded.length);
}

/**
 * The user's words the lead is told now — what a turn was handed and did not read first, then the
 * inbox's — and how many of the chat's messages the line had been handed by then (`through`).
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

/** The user's words a message to the lead carries, taken off the inbox, which records their hand-over. */
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

/** How the Loop works, as the lead's first message (and a fresh session's) says it. */
const rulesFor = (loopRun: LoopRun): string => (leadsOpenLoop(loopRun) ? openWakeRules() : wakeRules());

/**
 * The first message: the brief, how the Loop works, and whatever the user said before it began —
 * on a resumed run, inside a message read from its journal. A run whose working time is already over
 * opens in its wrap-up.
 */
async function firstPrompt(loopRun: LoopRun, wake: WakeState, brief: () => string, now: number): Promise<string> {
  const said = await tellUser(loopRun, wake);
  const opening = [brief(), rulesFor(loopRun)];
  if (resumedFromJournal(loopRun)) return [...opening, resumedDigest(loopRun, wake, said, now)].join("\n\n");
  const closing = wake.wrapping ? closingFor(loopRun, wake, [], now) : "";
  return [...opening, said.length ? userSaysBlock(said) : "", closing].filter(Boolean).join("\n\n");
}

/** A resumed run's first message, read from what its journal kept, under a heading of its own. */
function resumedDigest(loopRun: LoopRun, wake: WakeState, userSays: string[], now: number): string {
  const happened = readUnread(loopRun);
  const closing = closingFor(loopRun, wake, [], now);
  if (leadsOpenLoop(loopRun)) return openDigestOf(loopRun, { now, reasons: [], userSays, happened, closing, resumed: true });
  const heading = "THE RUN PICKS UP where it paused.";
  return wakeDigest(digestFacts(loopRun, wake, { now, reasons: [], userSays, finishNew: false, happened, closing, heading }));
}

/** Everything `afterTurn` decides on, read from the run as the turn ends. */
async function turnFacts(
  loopRun: LoopRun,
  wake: WakeState,
  result: Partial<DelegateResult>,
  now: number,
): Promise<TurnFacts> {
  const { inbox, state } = loopRun;
  const finishRequested = await inbox.finishing().catch(() => false);
  const open = leadsOpenLoop(loopRun);
  const running = open ? await activeWork(loopRun, now) : loopRun.runningWorkers().length;
  return {
    ok: result?.ok === true,
    closed: loopRunOver(loopRun) || wake.wrapping,
    providerLost: Boolean(state.limit) || (await pauseOnLostSignIn(loopRun, now)),
    running,
    idleAsked: wake.idleAsked,
    workingTimeLeft: now < loopRun.softDeadline && !finishRequested,
    finishRequested,
    capped: cutByItsCap(wake, result),
    // An open Loop's lead builds by itself: a turn that did something is never idle.
    worked: open && loopRun.open?.turnWorked === true,
    // An ∞ Loop ends on its lead's finish or its hours, never because its lead went quiet.
    untilFinish: loopRun.run.budgets?.untilSatisfied === true,
  };
}

/** Whether the turn ended because it reached its own cap (an open Loop's turn), not because the lead ended it. */
function cutByItsCap(wake: WakeState, result: Partial<DelegateResult>): boolean {
  const cap = wake.turnCapAt ?? null;
  if (cap === null || result?.ok === true || heldTurnEnding(result) !== null) return false;
  const returnedAt = wake.turnReturnedAt ?? Number.NEGATIVE_INFINITY;
  return returnedAt >= cap || result?.stopReason === StopReason.Deadline;
}

/** The wrap-up starts now: the working deadline moves up to this moment, so every clock the run reads agrees. */
function startWrapUp(loopRun: LoopRun, wake: WakeState, cause: WrapCause, now: number): void {
  if (!wake.wrapCause) wake.wrapCause = cause;
  const at = Math.min(loopRun.softDeadline, now);
  loopRun.softDeadline = at;
  loopRun.state.softDeadline = at;
}

/** Act on the end of a turn: owe the lead the idle question, or start the wrap-up. */
function settleTurn(loopRun: LoopRun, wake: WakeState, verdict: TurnVerdict, result: Partial<DelegateResult>, now: number) {
  wake.idleAsked = verdict.idleAsked;
  if (verdict.next === TurnEnd.AskIdle) wake.idleDue = true;
  if (verdict.next !== TurnEnd.WrapUp) return;
  if (verdict.wrapCause === WrapCause.Failed) wake.failed = result;
  startWrapUp(loopRun, wake, verdict.wrapCause ?? WrapCause.Deadline, now);
}

/** The run's jobs that ended since the lead last heard, each a line of the run's log; asked at most every `JOB_POLL_MS`. */
async function watchJobs(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  if (wake.jobsPolledAt !== null && now - wake.jobsPolledAt < JOB_POLL_MS) return;
  wake.jobsPolledAt = now;
  const { ctx, run, state } = loopRun;
  const read = await jobEnds(ctx, { project: run.project, runId: run.runId }, state.jobsCursor ?? 0);
  state.jobsCursor = read.cursor;
  for (const end of read.ends) loopRun.note(jobEndLine(end), NoteKind.JobEnded);
}

/** Read the inbox while the lead rests: what the user said, a finish request, its workers' questions and job ends. */
async function collect(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  const { inbox } = loopRun;
  await watchJobs(loopRun, wake, now);
  await noteWorkerQuestions(loopRun, now);
  if (leadsOpenLoop(loopRun)) {
    await activeWork(loopRun, now);
    healthWatch(loopRun);
  }
  const untold = await inbox.steering(undefined, false, { onlyNew: true }).catch(() => []);
  wake.userWaiting = wake.owed.length > 0 || unheard(wake, untold).length > 0;
  const finishing = await inbox.finishing().catch(() => false);
  // An ask the lead recorded itself (`wrap_up`) is said already: no news to it.
  if (finishing && Boolean(loopRun.state.finishAsk)) wake.finishSaid = true;
  wake.finishNew = !wake.finishSaid && finishing;
}

/** What `nextWake` decides on, read from the run. */
function wakeView(loopRun: LoopRun, wake: WakeState, now: number): WakeView {
  return {
    now,
    unread: loopRun.notesSince(loopRun.waitSeq).filter((entry) => !heardMidTurn(loopRun, entry.seq)),
    asleepFromSeq: wake.asleepFromSeq,
    asleepSince: wake.asleepSince ?? now,
    userWaiting: wake.userWaiting,
    finishNew: wake.finishNew,
    running: leadsOpenLoop(loopRun) ? workAtHand(loopRun) : loopRun.runningWorkers().length,
    softDeadline: loopRun.softDeadline,
    wrapping: wake.wrapping,
    idleDue: wake.idleDue,
    idleAsked: wake.idleAsked,
    wakesAt: wake.wakesAt,
  };
}

/** A wrap-up that would not have its minimum before the run's end is not started. */
const tooLateToWrap = (loopRun: LoopRun, due: Wake, now: number): boolean =>
  due.reasons.includes(WakeCause.WrapUp) && loopRun.finalDeadline - now <= WRAP_UP_MIN_MS;

/** News that has waited `JOURNAL_NEWS_MS` for a wake that did not come is saved to the journal. */
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

/** The log's lines the lead has not read, as text; the shared cursor moves past them. */
function readUnread(loopRun: LoopRun): string[] {
  const unread = loopRun.notesSince(loopRun.waitSeq);
  const last = unread.at(-1);
  if (last) loopRun.waitSeq = Math.max(loopRun.waitSeq, last.seq);
  return unread.filter((entry) => !heardMidTurn(loopRun, entry.seq)).map((entry) => entry.text);
}

/** Record the wake: the cap's window, and every request it says, so none is said twice. */
function markSaid(wake: WakeState, reasons: readonly WakeReason[], now: number): void {
  wake.wakes += 1;
  wake.lastWakeAt = now;
  const selfContinued = reasons.some((reason) => SELF_CONTINUED.has(reason));
  const capped = !selfContinued && reasons.some((reason) => !USER_WAKES.has(reason));
  wake.wakesAt = [...wake.wakesAt.filter((at) => at > now - WAKE_WINDOW_MS), ...(capped ? [now] : [])];
  wake.idleDue = false;
  if (reasons.includes(WakeCause.IdleAsk)) wake.idleAsked = true;
  wake.userWaiting = false;
  if (wake.finishNew) wake.finishSaid = true;
  wake.finishNew = false;
  if (!reasons.includes(WakeCause.WrapUp)) return;
  wake.wrapping = true;
  if (!wake.wrapCause) wake.wrapCause = WrapCause.Deadline;
}

/** How this wake's message ends: the wrap-up, the idle question, or carry on. */
function closingFor(loopRun: LoopRun, wake: WakeState, reasons: readonly WakeReason[], now: number): string {
  if (leadsOpenLoop(loopRun))
    return openClosingOf(loopRun, { wrapping: wake.wrapping, wrapCause: wake.wrapCause ?? null, reasons, now });
  const { finalDeadline, run, state } = loopRun;
  if (wake.wrapping) {
    const wrapUp = wrapUpPrompt({
      run,
      finalDeadline,
      integrationHead: state.integrationHead,
      integrationHealthy: state.integrationHealthy,
      running: loopRun.runningWorkers().map((record) => String(record.id)),
      userAsked: wake.wrapCause === WrapCause.Finish || Boolean(state.finishAsk),
    });
    return wrapLead(wake.wrapCause ?? WrapCause.Deadline, wrapUp);
  }
  if (reasons.includes(WakeCause.IdleAsk)) return idleAsk({ minutesLeft: minutes(loopRun.softDeadline - now) });
  return carryOn();
}

/** The web digest's facts, read from the run at the moment of the wake. */
function digestFacts(
  loopRun: LoopRun,
  wake: WakeState,
  said: Pick<DigestFacts, "now" | "reasons" | "userSays" | "finishNew" | "happened" | "closing" | "heading">,
): DigestFacts {
  const { finalDeadline, pool, state } = loopRun;
  return {
    ...said,
    softDeadline: loopRun.softDeadline,
    finalDeadline,
    wrapping: wake.wrapping,
    integrationHead: state.integrationHead,
    integrationHealthy: state.integrationHealthy,
    workers: (pool?.state.records ?? []).map((record: AnyRecord) => ({
      id: String(record.id),
      title: String(record.title),
      state: String(record.state),
      verdict: record.verdict ?? null,
    })),
  };
}

/** The message that wakes the lead: the user's words, the news, where the run stands and the closing. */
async function wakePrompt(loopRun: LoopRun, wake: WakeState, due: Wake, clock: WakeClock): Promise<string> {
  const now = clock.now();
  // The person asked to finish while the lead rested: this message opens its last turn, in their words.
  if (due.reasons.includes(WakeCause.FinishRequested) && !wake.wrapping) {
    startWrapUp(loopRun, wake, WrapCause.Finish, now);
    wake.wrapping = true;
  }
  const userSays = await tellUser(loopRun, wake);
  const happened = readUnread(loopRun);
  const finishNew = wake.finishNew;
  markSaid(wake, due.reasons, now);
  await loopRun.appendRun(RunEvent.DirectorContinued, { minutesLeft: minutes(loopRun.softDeadline - now), reasons: due.reasons });
  const closing = closingFor(loopRun, wake, due.reasons, now);
  let prompt: string;
  if (leadsOpenLoop(loopRun)) prompt = openDigestOf(loopRun, { now, reasons: due.reasons, userSays, happened, closing });
  else {
    const told = digestFacts(loopRun, wake, { now, reasons: due.reasons, userSays, finishNew, happened, closing });
    const render = (lines: readonly string[]) => wakeDigest({ ...told, happened: lines, userSays: [] });
    prompt = wakeDigest({ ...told, happened: fitHappened(told.happened, render, WAKE_TOKEN_BUDGET) });
  }
  // What the lead has now been told is heard: a restart during its turn does not tell it again.
  await keepWake(loopRun, wake, now);
  return prompt;
}

/**
 * The news a wake can carry within `budget` tokens of `render`'s text: all of it when it fits;
 * otherwise the newest, halved until it fits, behind one line saying how much was left out.
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
  return left > 0 ? [`(${left} earlier events left out to keep this message short)`, ...kept] : kept;
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
 * than throw it? It is asked again on the outage ladder like a thrown one (`patientAsk`).
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
  why: string,
): Promise<Partial<DelegateResult>> {
  // An open Loop Genex paused (its app couldn't be brought back), or one the person stopped, opens no new session.
  const refused = openSessionRefused(loopRun);
  if (refused) return Promise.resolve(refused);
  const text = freshStart({ why, brief: kit.brief(), rules: rulesFor(loopRun), ...freshContext(loopRun), digest: turn.prompt });
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
  const refused = openSessionRefused(loopRun);
  if (refused) return refused;
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
  return openFresh(loopRun, kit, turn, why);
}

/**
 * Whether an open Loop's lead, refused because another chat's turn holds the game folder it leads
 * in (`folderBusy`), waits once more: within its working time (the run's end for its wrap-up), never
 * under a Stop or a pause Genex made. Its turn has not begun, so its cap starts again from when it may.
 */
async function waitsForFolder(loopRun: LoopRun, wake: WakeState, kit: TurnKit, turn: TurnAsk): Promise<boolean> {
  const { clock } = kit;
  const until = wake.wrapping ? loopRun.finalDeadline - WRAP_UP_MARGIN_MS : loopRun.softDeadline;
  const stopped = () => loopRun.ctx.cancelled === true || Boolean(loopRun.open?.halted);
  if (stopped() || clock.now() + BUSY_RETRY_MS >= until) return false;
  await clock.sleep(BUSY_RETRY_MS);
  // A Stop or a pause during the wait: the run's Stop freed the folder, and the next ask would be seated.
  if (stopped()) return false;
  turn.deadline = turnDeadline(loopRun, wake, clock.now());
  noteTurnEnds(loopRun.state, turn.deadline, lastTurn(loopRun, wake, turn.deadline));
  return true;
}

/** Whether a lead the host refused because another session holds its lock (not an open Loop's) asks again: `MAX_BUSY_RETRIES` times. */
async function asksAgainWhenFree(loopRun: LoopRun, kit: TurnKit, tries: number): Promise<boolean> {
  if (tries >= MAX_BUSY_RETRIES || loopRun.ctx.cancelled) return false;
  await kit.clock.sleep(BUSY_RETRY_MS);
  return true;
}

/**
 * The lead's session asked this turn's message — and, but for an open Loop's lead, asked again after
 * a wait on the loop's clock while the host refuses it because another session holds its lock
 * (`folderBusy`): that passes. An open Loop's lead waits for its folder outside the outage ladder
 * (`patientSession`).
 */
async function askSession(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  const { talk, clock } = kit;
  for (let tries = 0; ; tries += 1) {
    // An open Loop Genex paused (its app couldn't be brought back), or one the person stopped, opens no new session: a retry included.
    const refused = openSessionRefused(loopRun);
    if (refused) return refused;
    let result: Partial<DelegateResult>;
    try {
      result = await talk.session(turn.prompt, talk.sessionId, turn.deadline - clock.now());
    } catch (err: any) {
      const retries = folderBusy(err) && !leadsOpenLoop(loopRun);
      if (!retries || !(await asksAgainWhenFree(loopRun, kit, tries))) throw err;
      continue;
    }
    if (!endedOnOutage(result)) return result;
    throw Object.assign(new Error(String(result.errorText)), { kind: EngineFailure.Unavailable });
  }
}

/**
 * The run's ctx as the outage ladder reads it: an open Loop's wait also ends once Genex pauses the
 * Loop (`open.halted`, its app couldn't be brought back), never after the rest of that wait. A web
 * Loop's ladder reads the run's ctx as it always did.
 */
function patienceCtx(loopRun: LoopRun): HarnessCtx {
  const open = loopRun.open;
  if (!open || !leadsOpenLoop(loopRun)) return loopRun.ctx;
  const ctx = loopRun.ctx;
  return Object.create(ctx, {
    cancelled: { get: () => ctx.cancelled === true || Boolean(open.halted) },
  }) as HarnessCtx;
}

/**
 * The lead's session asked, with a provider outage waited out on the run's outage ladder within
 * the turn's deadline (an open Loop's within its working time, on its clock, asked again with a fresh
 * cap): an overloaded gateway on one wake used to end the whole run — workers stopped, head landed,
 * run reported done. What the ladder cannot outlast still fails.
 */
function patientAsk(loopRun: LoopRun, wake: WakeState, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  const open = leadsOpenLoop(loopRun);
  let waited = false;
  // An open Loop's session asked again after an outage wait has a fresh cap: its first may be spent.
  const attempt = () => {
    if (waited && open) turn.deadline = retryDeadline(loopRun, wake, kit, turn);
    return askSession(loopRun, kit, turn);
  };
  return withProviderPatience(patienceCtx(loopRun), attempt, {
    // An open Loop's turn has a cap of its own, but its patience is judged by its working time.
    deadline: open ? Math.max(turn.deadline, loopRun.softDeadline) : turn.deadline,
    // An open Loop's ladder runs on the Loop's own clock; the web director's keeps the wall clock it always had.
    clock: open ? kit.clock : null,
    delays: outageDelays(loopRun.run),
    label: "the lead's provider",
    onWait: ({ wait, error }) => {
      waited = true;
      return loopRun.decision(
        `the lead's provider failed (${error}); asking it again in ${Math.ceil(wait / SECOND_MS)} s`,
        "the lead's provider is briefly down, so the studio waits and asks again; the builders keep working",
      );
    },
  });
}

/**
 * `patientAsk`, and for an open Loop's lead refused because another chat's turn holds the game
 * folder, asked again each time it may wait for it (`waitsForFolder`): each wait moves the turn's
 * deadline, which the next outage ladder is held to.
 */
async function patientSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  for (;;) {
    try {
      return await patientAsk(loopRun, wake, kit, turn);
    } catch (err) {
      const waits = folderBusy(err) && leadsOpenLoop(loopRun);
      if (!waits || !(await waitsForFolder(loopRun, wake, kit, turn))) throw err;
    }
  }
}

/**
 * One delegation of the lead's session, or a fresh session when its own is lost — or when a later
 * turn has none to resume (a fresh one that met the engine's limit before it began). A failure on
 * the first turn is the run's (the crash close); on a later one it is a failed turn — and so is a
 * first turn the host kept refusing because its lock stayed busy: the run closes on its own terms.
 * A first turn cut short for the user's words is no failure at all (`lineWatchedSession`).
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
    return openFresh(loopRun, kit, turn, SESSION_LOST_WHY.noSession).catch(failed);
  let result: Partial<DelegateResult>;
  try {
    result = await patientSession(loopRun, wake, kit, turn);
  } catch (err: any) {
    const why = lostSessionWhy(talk, err);
    if (!why) return failed(err);
    return freshSession(loopRun, wake, kit, turn, why).catch(failed);
  }
  if (result?.stopReason !== StopReason.ContextOverflow) return result;
  return freshSession(loopRun, wake, kit, turn, SESSION_LOST_WHY.contextOverflowed).catch(failed);
}

/** A turn Genex ended because the open Loop paused: it never opened a session. */
const haltedTurn = (why: string): Partial<DelegateResult> => ({
  ok: false,
  stopReason: StopReason.Stopped,
  errorText: why,
});

/** Why the person stopped a turn that never opened a session. */
const STOPPED_BY_THE_USER = "stopped by the user";

/**
 * The turn an open Loop's lead gets in place of a new session: Genex paused the Loop (its app couldn't
 * be brought back), or the person pressed Stop (a session in the folder has Edit and Bash and would work
 * on under it); null while it may open one. A web Loop's sessions are left as they always were.
 */
function openSessionRefused(loopRun: LoopRun): Partial<DelegateResult> | null {
  if (loopRun.open?.halted) return haltedTurn(loopRun.open.halted);
  if (leadsOpenLoop(loopRun) && loopRun.ctx.cancelled === true) return haltedTurn(STOPPED_BY_THE_USER);
  return null;
}

/**
 * Is the lead's own session limit one to wait out: a rate limit that resets well before this turn's
 * deadline? An open Loop's turn has a cap of its own, but its wait is judged by its working time, as
 * the web director's is; one Genex paused waits for nothing.
 */
function limitToWait(loopRun: LoopRun, wake: WakeState, turnEnds: number, now: number): boolean {
  const { ctx, state } = loopRun;
  const limit = state.limit;
  if (!limit || limit.kind !== EngineFailure.RateLimit || state.finished || ctx.cancelled) return false;
  if (loopRun.open?.halted) return false;
  const deadline = leadsOpenLoop(loopRun) ? Math.max(turnEnds, loopRun.softDeadline) : turnEnds;
  const waitMs = limit.retryAfterMs ?? 0;
  const resetsInTime = now + waitMs + LIMIT_WAIT_MARGIN_MS <= deadline;
  return waitMs > 0 && wake.limitWaits < MAX_LIMIT_WAITS && resetsInTime;
}

/** Wait `ms` on the loop's clock, reading the inbox as the lead would; false when the user stopped the run (or Genex paused an open Loop). */
async function sleepThrough(loopRun: LoopRun, wake: WakeState, ms: number, clock: WakeClock): Promise<boolean> {
  const until = clock.now() + ms;
  const stopped = () => loopRun.ctx.cancelled === true || Boolean(loopRun.open?.halted);
  while (clock.now() < until && !stopped()) {
    await collect(loopRun, wake, clock.now());
    await clock.sleep(Math.min(WAKE_POLL_MS, until - clock.now()));
  }
  return !stopped();
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
    result = await watchedSession(loopRun, wake, kit, { prompt, deadline: retryDeadline(loopRun, wake, kit, turn) });
  }
  return result;
}

/**
 * When the session asked again after a limit wait must be over: the turn's own deadline, or an open
 * Loop's fresh cap from now (its cap may have passed while the limit was waited out).
 */
function retryDeadline(loopRun: LoopRun, wake: WakeState, kit: TurnKit, turn: TurnAsk): number {
  if (!leadsOpenLoop(loopRun)) return turn.deadline;
  const deadline = turnDeadline(loopRun, wake, kit.clock.now());
  noteTurnEnds(loopRun.state, deadline, lastTurn(loopRun, wake, deadline));
  return deadline;
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
  const deadline = turnDeadline(loopRun, wake, kit.clock.now());
  // A claim made in this turn ends its review before the turn does; the wrap-up is the last turn (finish-claim.ts).
  noteTurnEnds(loopRun.state, deadline, lastTurn(loopRun, wake, deadline));
  const turn = { prompt, deadline };
  const result = await waitOutLimit(loopRun, wake, kit, turn, await watchedSession(loopRun, wake, kit, turn));
  // An open Loop's session call stamped its own return (`watchedSession`).
  if (!leadsOpenLoop(loopRun)) wake.turnReturnedAt = kit.clock.now();
  noteTurnOver(loopRun.state);
  await settleTold(wake, result);
  await kit.talk.keep(result);
  return result;
}

/** Whether no turn follows one that must be over by `deadline`: the wrap-up, or a turn that ends with the run. */
const lastTurn = (loopRun: LoopRun, wake: WakeState, deadline: number): boolean =>
  wake.wrapping || deadline >= loopRun.finalDeadline - WRAP_UP_MARGIN_MS;

/**
 * When a turn must be over: the run's end for the wrap-up, else the working deadline — for a turn
 * that reaches the Loop's cap, the end of its grace, the time's-up said or cut into it mid-turn
 * (cap-lines.ts `turnEndAtCap`); an open Loop's turn also at its own cap, `OPEN_TURN_MS` from now
 * (kept as `wake.turnCapAt` while it comes first).
 */
function turnDeadline(loopRun: LoopRun, wake: WakeState, now: number): number {
  wake.turnCapAt = null;
  if (wake.wrapping) return loopRun.finalDeadline - WRAP_UP_MARGIN_MS;
  if (!leadsOpenLoop(loopRun) || now + OPEN_TURN_MS >= loopRun.softDeadline) return turnEndAtCap(loopRun);
  wake.turnCapAt = now + OPEN_TURN_MS;
  return wake.turnCapAt;
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
  // A turn has no cap until its session starts: a held one never reads an earlier turn's.
  wake.turnCapAt = null;
  wake.turnReturnedAt = null;
  // One turn to the game's plugins, its resumptions included: its start and its end name it alike.
  const moment = turnScope(loopRun, wake);
  const held = await heldTurn(loopRun, wake, kit, prompt, moment);
  if (held) return held;
  // An open Loop's lead: the folder and who else may write in it, as its turn begins.
  if (leadsOpenLoop(loopRun)) await openTurnBegins(loopRun);
  const first = wake.heldFirst;
  wake.heldFirst = undefined;
  // What the lead has not heard of its cap opens the message: the time's-up a wrap-up turn begins with.
  let asked = withCapWords(loopRun, first ? `${first}\n\n${prompt}` : prompt, kit.clock.now());
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
  await fireHooks(loopRun.ctx, loopRun.game, HookEvent.TurnEnd, moment);
  return result;
}

/** A lead's turn as Genex's moments name it: the run, and the turn's number. */
function turnScope(loopRun: LoopRun, wake: WakeState): HookScope {
  return { ...runMoment(loopRun), turn: String(wake.turns + 1) };
}

/**
 * A lead's turn a plugin of the game holds back before it starts: asked again after a wait
 * (turn-hold.ts), never counted as an idle turn. Null once the turn may start. A turn still held
 * after the last ask is a failed turn with the hold's reason (the run wraps up, saying why): the
 * lead hears why, the user's words the message carried are said again then, and a first message
 * (the brief) opens the next one.
 */
async function heldTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
  moment: HookScope,
): Promise<Partial<DelegateResult> | null> {
  let held: HeldBack | null = null;
  const ask = async () => {
    const report = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.TurnStart, moment);
    held = report.blocked;
    return report.blocked?.reason ?? null;
  };
  const cantWait = () => wake.wrapping || loopRunOver(loopRun) || kit.clock.now() >= loopRun.softDeadline;
  const reason = await whileTurnHeld(ask, kit.clock, cantWait);
  if (reason === null) return null;
  if (wake.turns === 0) wake.heldFirst ??= prompt;
  wake.owed.unshift(...wake.promptWords);
  wake.promptWords = [];
  loopRun.note(HOOK_PROMPTS.turnHeld(reason));
  // The failed turn's words reach the person: Genex's own hold in theirs, never the agents'.
  return heldTurnResult(turnsHeldWords(held ?? { reason }));
}

/** A turn cut before it read its message is asked it again — its words and all — with the user's newer words after it. */
async function askAgain(loopRun: LoopRun, wake: WakeState, asked: string): Promise<string> {
  const carried = wake.promptWords;
  const userSays = await tellUser(loopRun, wake);
  wake.promptWords = [...carried, ...userSays];
  return [asked, sinceThen({ userSays, happened: [] })].filter(Boolean).join("\n\n");
}

/**
 * A turn with a session to resume may be cut short for the user's words — the first too, whose
 * session has read its brief or is asked it again (`askAgain`): an engine that cannot read input
 * mid-turn would otherwise hear nothing for a whole open Loop turn. Never one with no session yet
 * (a fresh lead's first: a cut would leave nothing to resume), the wrap-up, a turn whose run is
 * already over (its `finish` may be under way), or one inside a tool call — cut there, the lead
 * never gets the call's answer (tools.ts counts them).
 */
function mayCut(loopRun: LoopRun, wake: WakeState, kit: TurnKit): boolean {
  const resumable = Boolean(kit.talk.sessionId);
  const inCall = (loopRun.toolsInFlight ?? 0) > 0;
  return resumable && !inCall && !wake.wrapping && !loopRunOver(loopRun);
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

/**
 * A web lead's session call: its cap's lines from a watch of its own, and the news a resting lead
 * would be woken by — a worker's or a job's end — said into its turn as it comes (turn-news.ts).
 */
async function webWatchedSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  // On the wall clock's timers, never the wake loop's (a loop clock that answers at once would spin
  // this watch without yielding to the session it watches), and never holding the process open.
  const news = watchTurnNews(loopRun, { clock: OPEN_WALL_CLOCK, turn: wake.turns });
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await withCapWatch(
      loopRun,
      () => kit.clock.now(),
      () => lineWatchedSession(loopRun, wake, kit, turn),
    );
    return result;
  } finally {
    await news.stop();
    news.settle(result);
  }
}

/**
 * One session call, watched while it runs: for the user's words (live chat) and for the news a
 * resting lead would be woken by (open/news.ts, turn-news.ts).
 */
async function watchedSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  if (!leadsOpenLoop(loopRun)) return webWatchedSession(loopRun, wake, kit, turn);
  const pollJobs = () => watchJobs(loopRun, wake, kit.clock.now());
  const news = watchOpenTurn(loopRun, { clock: kit.clock, turn: wake.turns, pollJobs });
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await lineWatchedSession(loopRun, wake, kit, turn);
    return result;
  } finally {
    // Its cap is judged from when its session returned, never from when its watch has settled.
    wake.turnReturnedAt = kit.clock.now();
    await news.stop();
    news.settle(result);
  }
}

/** One session call, watched for the user's words while it runs; what it read is heard, what it did not is owed. */
async function lineWatchedSession(
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
  } catch (err) {
    // A first turn's failure is the run's (`sessionOrFresh`) — unless it was cut short for the
    // user's words before its session began: then it is asked again (`takeTurn`). The watch settles
    // first, since the host's answer to the cut may come after the failure the cut caused.
    await watch.stop();
    if (!wake.cut) throw err;
    result = failedTurn(err);
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

/** One turn of the lead's, then what waits for its end before the next (an open Loop's `afterTurn`). */
async function turnThenBetween(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
): Promise<Partial<DelegateResult>> {
  const result = await takeTurn(loopRun, wake, kit, prompt);
  if (typeof loopRun.afterTurn === "function" && !loopRunOver(loopRun)) await loopRun.afterTurn();
  return result;
}

/**
 * When the lead is woken next: at once for a turn its own cap cut short, or an open Loop's lead's
 * turn that worked (it is never rested then), else once something is due while it rests (null: the
 * run ended under it).
 */
async function dueAfter(loopRun: LoopRun, wake: WakeState, kit: TurnKit, verdict: TurnVerdict): Promise<Wake | null> {
  if (verdict.next === TurnEnd.Continue) return { at: kit.clock.now(), reasons: [WakeCause.TurnCap] };
  if (verdict.next === TurnEnd.CarryOn) return carryOnWake(loopRun, wake, kit);
  await rest(loopRun, wake, kit.clock.now());
  const due = await sleepUntilDue(loopRun, wake, kit);
  loopRun.resting = false;
  return due;
}

/** An open Loop's lead whose turn worked goes on at once, told whatever else is due now. */
async function carryOnWake(loopRun: LoopRun, wake: WakeState, kit: TurnKit): Promise<Wake> {
  const now = kit.clock.now();
  await collect(loopRun, wake, now);
  const due = nextWake(wakeView(loopRun, wake, now));
  // Never the question of what next: a lead whose turn worked is not asked it.
  const also = due && due.at <= now ? due.reasons.filter((reason) => reason !== WakeCause.IdleAsk) : [];
  return { at: now, reasons: [...new Set([...also, WakeCause.CarryOn])] };
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
  // The run's tools read its time on this clock (a worker refused from the cap on).
  keepRunClock(loopRun, () => clock.now());
  // A resumed run takes back what its journal kept of the loop: the idle question, the wake cap.
  const restored = resumedFromJournal(loopRun)
    ? restoredWake(loopRun.priorJournal?.director?.wake, clock.now())
    : undefined;
  const wake = newWakeState(restored);
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
  // The wrap-up still hears the chat, but what is sent from now on is the chat's to answer once the run closes.
  if (wake.wrapping) wrapUpLine(line);
  let result = await turnThenBetween(loopRun, wake, kit, first);
  for (;;) {
    const verdict = afterTurn(await turnFacts(loopRun, wake, result, clock.now()));
    if (verdict.next === TurnEnd.Close) break;
    settleTurn(loopRun, wake, verdict, result, clock.now());
    const due = await dueAfter(loopRun, wake, kit, verdict);
    if (!due) break;
    // A sign-in a worker or a judge lost while the lead slept pauses the run before it is woken.
    if (await pauseOnLostSignIn(loopRun, clock.now())) break;
    const prompt = await wakePrompt(loopRun, wake, due, clock);
    if (wake.wrapping) wrapUpLine(line);
    result = await turnThenBetween(loopRun, wake, kit, prompt);
  }
  journalWake(loopRun, wake);
  return { result, wrapCause: wake.wrapCause, failed: wake.failed };
}

/**
 * The wrap-up began: the lead still hears the chat, and what is sent from now on stays the chat's to
 * answer once the run closes (`LeadLine.wrapUp`). Only when the chat's door and queue both keep what
 * the lead is told then: a kept older copy of either would deliver it to a run that is ending, and
 * nobody would answer it. Otherwise, or with a kept older lead-line.ts, the line shuts and what is
 * sent waits for the run to close.
 */
function wrapUpLine(line: LeadLine | null): void {
  if (typeof line?.wrapUp === "function" && wrapUpKeeps()) line.wrapUp();
  else line?.shut();
}

/** Do the chat's door (live-chat.ts) and queue (message-queue.ts) keep what a lead in its wrap-up is told? */
export function wrapUpKeeps(): boolean {
  const door: { DOOR_KEEPS_IN_WRAP_UP?: unknown } = liveChat;
  const queue: { QUEUE_KEEPS_TOLD?: unknown } = messageQueue;
  return door.DOOR_KEEPS_IN_WRAP_UP === true && queue.QUEUE_KEEPS_TOLD === true;
}

/**
 * Put the wake loop's own state on the journal (`journal.director.wake`, journal.ts `wakeRecord`),
 * and the run's record with it: a kept loop-run.ts from before the full journal saves without
 * writing the record (`recordLoopRun` is idempotent). The caller saves it.
 */
export function journalWake(loopRun: LoopRun, wake: WakeState): void {
  const director = loopRun.journal?.director;
  if (!director) return;
  recordLoopRun(loopRun, loopRun.open?.clock.now());
  director.wake = wakeRecord(wake);
}
