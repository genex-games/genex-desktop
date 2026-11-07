/**
 * The Loop's wake loop. The lead ends its turn when it decides to; between turns nothing of it runs;
 * the studio wakes the SAME session when something happens: with the person's message as they wrote
 * it, or with Genex's own lines — a worker or a job that ended, the project's app that stopped
 * (director/news.ts; wake-schedule.ts decides when). A turn that ends with nothing at work and nothing
 * to be woken for closes the Loop, as a bare agent's turn ends. The one clock that wakes or ends it is
 * the time the person asked for (work-time.ts): while some is left such a turn is woken to go on, and
 * once it is up the next turn is the last. One turn at
 * a time: what arrives during a turn reaches it at its next step when its engine can take it, or opens
 * the next message. The fresh-session fallback covers every turn; a lost provider (a limit, a sign-in)
 * pauses the run, and the host resumes it.
 *
 * The journal holds what the loop needs after a restart (journal.ts). The lead answers the chat while
 * the run is going (live chat, lead-line.ts). Its functions take the run explicitly; they are not
 * bound onto it.
 */
import { isResumeFailure } from "../chat-session.ts";
import { fireHooks, HookEvent, type HookScope, runScope as runMoment } from "../hooks.ts";
import { momentLines } from "../moment-lines.ts";
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
import { CLIP_DETAIL, CLIP_REASON, clip } from "../text.ts";
import { SECOND_MS } from "../time.ts";
import { recordLoopRun, restoredWake, resumedFromJournal, wakeRecord } from "./journal.ts";
import { folderBusy } from "./lead-session.ts";
import { LEAD_FRESH_START, SESSION_LOST_WHY } from "./lead-session-prompts.ts";
import { noteTurnEnds, noteTurnOver } from "./turn-ends.ts";
import { activeWork, hasWorkAtHand } from "./open/active-work.ts";
import { OPEN_WALL_CLOCK, type OpenClock } from "./open/contract.ts";
import { healthWatch } from "./open/app-look.ts";
import {
  askOf,
  handAgain,
  handNotes,
  runOver,
  saysSomething,
  startedASession,
  toldThrough,
  type TurnAsk,
  type TurnSaid,
  untold,
  watchTurn,
} from "./news.ts";
import { LOOP_WORDS } from "./wake-prompts.ts";
import { afterTurn, nextWake, NoteKind, TurnEnd, WrapCause } from "./wake-schedule.ts";
import { keepRunClock } from "./loop-run.ts";
import {
  type KeepState,
  keepsWorking,
  newKeepState,
  sayTimeUp,
  timeIsUp,
  timeUpWrapLine,
  withWorkLine,
  workedLine,
} from "./work-time.ts";
import type { HarnessCtx } from "../../types/harness.d.ts";
import type { DelegateResult } from "../../types/host-api.d.ts";
import type { RestoredWake } from "./journal.ts";
import type { LeadLine } from "./lead-line.ts";
import type { LoopRun } from "./loop-run.ts";
import type { TurnFacts } from "./wake-schedule.ts";

/** How often a resting lead's line and log are read. */
export const WAKE_POLL_MS = SECOND_MS;
/** A run opens at most this many fresh sessions for a lead whose own was lost. */
export const MAX_FRESH_SESSIONS = 3;
/** A lead's turn the host refused because another session holds its lock is asked again after this wait, until the lock is free or the person stops the run. */
export const BUSY_RETRY_MS = 15 * SECOND_MS;
/** Lines that reach a resting lead are saved once they have waited this long for a wake that did not come. */
const JOURNAL_NEWS_MS = 5 * SECOND_MS;

/** The lead's session as the run talks to it: one turn at a time, and the session id it resumes. */
export interface DirectorTalk {
  session: (prompt: string, sid: string | null | undefined, said?: TurnSaid) => Promise<Partial<DelegateResult>>;
  sessionId: string | null;
  /** Keep the session a turn answered with, on the journal where a resume finds it. */
  keep: (result: Partial<DelegateResult> | null | undefined) => Promise<void>;
}

/** What the loop keeps between the lead's turns. */
export interface WakeState {
  turns: number;
  asleepSince: number | null;
  wrapping: boolean;
  wrapCause: WrapCause | null;
  /** Genex's own lines of a message no turn worked on (the Loop's start, the wrap-up): the next message says them first. */
  owedLead: readonly string[];
  /** The turn under way was cut short by the chat's words: it is resumed at once with them. */
  cut: boolean;
  /** The log's sequence number, and the time, the loop last saved the journal. */
  journaledSeq: number;
  journaledAt: number;
  freshSessions: number;
  /** The turn whose failure started the wrap-up. */
  failed: Partial<DelegateResult> | null;
  /** When the run's job ends were last asked for (null: not yet). */
  jobsPolledAt: number | null;
  /** The wakes to go on while the person's time has some left, and whether its end was said (work-time.ts). */
  keep: KeepState;
}

/** How the loop ended: the last turn's answer, why the wrap-up started, and the turn that failed. */
export interface WakeOutcome {
  result: Partial<DelegateResult>;
  wrapCause: WrapCause | null;
  failed: Partial<DelegateResult> | null;
}

/** What a turn needs besides the run: the Loop's first lines (a fresh session is told them), the clock, and the chat's line. */
interface TurnKit {
  talk: DirectorTalk;
  start: readonly string[];
  clock: OpenClock;
  line: LeadLine | null;
}

/** The loop's state as a run starts: a resumed one takes back what its journal kept of it. */
function newWakeState(restored: RestoredWake = {}): WakeState {
  return {
    turns: 0,
    asleepSince: null,
    wrapping: false,
    wrapCause: null,
    owedLead: [],
    cut: false,
    journaledSeq: 0,
    journaledAt: 0,
    freshSessions: restored.freshSessions ?? 0,
    failed: null,
    jobsPolledAt: null,
    keep: newKeepState(),
  };
}

/** Everything `afterTurn` decides on, read from the run as the turn ends. */
async function turnFacts(
  loopRun: LoopRun,
  wake: WakeState,
  result: Partial<DelegateResult>,
  now: number,
): Promise<TurnFacts> {
  const { inbox, state } = loopRun;
  return {
    ok: result?.ok === true,
    closed: runOver(loopRun) || wake.wrapping,
    providerLost: Boolean(state.limit) || (await pauseOnLostSignIn(loopRun, now)),
    finishRequested: await inbox.finishing().catch(() => false),
    timeUp: timeIsUp(loopRun),
  };
}

/** The wrap-up starts, for `cause` unless an earlier one is kept: the next message opens the run's last turn. */
function startWrapUp(
  loopRun: LoopRun,
  wake: WakeState,
  cause: WrapCause,
  result: Partial<DelegateResult> | null,
): void {
  if (cause === WrapCause.Failed) wake.failed = result;
  if (!wake.wrapCause) wake.wrapCause = cause;
  wake.wrapping = true;
  loopRun.wrapping = true;
}

/**
 * Genex's line the wrap-up turn opens with: the person's Finish, their time that is up, or the turn
 * that failed and why; with a time asked, the time the Loop worked beside it.
 */
function wrapLine(loopRun: LoopRun, wake: WakeState): string {
  if (wake.wrapCause === WrapCause.Time) return timeUpWrapLine(loopRun);
  const worked = workedLine(loopRun);
  return worked ? `${wrapCauseLine(wake)} ${worked}` : wrapCauseLine(wake);
}

/** Why the wrap-up turn is the last: the person's Finish, or the turn that failed and why. */
function wrapCauseLine(wake: WakeState): string {
  if (wake.wrapCause === WrapCause.Finish) return LOOP_WORDS.finishAsked;
  const failed = wake.failed;
  return LOOP_WORDS.turnFailed(clip(String(failed?.errorText ?? failed?.stopReason ?? ""), CLIP_REASON));
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

/** What the loop reads of the run each round, resting or working: the run's job ends, the person's notes, and the project's app. */
async function tick(loopRun: LoopRun, wake: WakeState, line: LeadLine | null, now: number): Promise<void> {
  await watchJobs(loopRun, wake, now);
  await handNotes(loopRun, line);
  healthWatch(loopRun);
}

/** When the lead is woken next, read from the run (wake-schedule.ts `nextWake`). */
function dueAt(loopRun: LoopRun, wake: WakeState, line: LeadLine | null, now: number): number | null {
  const personWaiting = (line?.unheard().length ?? 0) > 0;
  return nextWake({ now, untold: untold(loopRun), asleepSince: wake.asleepSince ?? now, personWaiting });
}

/** Lines that have waited `JOURNAL_NEWS_MS` for a wake that did not come are saved to the journal. */
async function journalNews(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  const saved = Math.max(wake.journaledSeq, loopRun.journaledSeq ?? 0);
  const oldest = loopRun.notesSince(saved)[0];
  if (!oldest) return;
  const waited = now - oldest.at >= JOURNAL_NEWS_MS && now - wake.journaledAt >= JOURNAL_NEWS_MS;
  if (waited) await keepWake(loopRun, wake, now);
}

/**
 * Rest until something is due — the person's message, a line of Genex's, the person's Finish or the
 * end of the time they asked for (either starts the wrap-up); false once the run ends under the lead,
 * or once nothing is at work and nothing would wake it: then the Loop is done, as a bare agent's turn
 * ends — unless the person's time has some left, which wakes the lead to go on (`keepsWorking`). A
 * message from the chat cuts the rest short.
 */
async function sleepUntilDue(loopRun: LoopRun, wake: WakeState, kit: TurnKit): Promise<boolean> {
  const { clock, line } = kit;
  for (;;) {
    if (runOver(loopRun)) return false;
    const spoke = line?.heard();
    await tick(loopRun, wake, line, clock.now());
    await activeWork(loopRun, clock.now());
    const ends = await restEnds(loopRun);
    if (ends) {
      startWrapUp(loopRun, wake, ends, null);
      return true;
    }
    const now = clock.now();
    const due = dueAt(loopRun, wake, line, now);
    if (due !== null && due <= now) return true;
    const idle = await restingIdle(loopRun, wake, line, { due, now });
    if (idle === false) return false;
    if (idle) continue;
    await journalNews(loopRun, wake, now);
    await (spoke ? Promise.race([clock.sleep(WAKE_POLL_MS), spoke]) : clock.sleep(WAKE_POLL_MS));
  }
}

/**
 * A resting lead with nothing due and nothing at work: false when its Loop is done, true when it is
 * woken to go on because the person's time has some left (`keepsWorking`); null while something is
 * due or at work, or ended just now.
 */
async function restingIdle(
  loopRun: LoopRun,
  wake: WakeState,
  line: LeadLine | null,
  { due, now }: { due: number | null; now: number },
): Promise<boolean | null> {
  if (due !== null || hasWorkAtHand(loopRun)) return null;
  if (!(await nothingJustEnded(loopRun, wake, line, now))) return null;
  return keepsWorking(loopRun, wake.keep);
}

/** Why a resting lead's next turn is its wrap-up: the person's Finish, or the time they asked for is up; null for neither. */
async function restEnds(loopRun: LoopRun): Promise<WrapCause | null> {
  if (await loopRun.inbox.finishing().catch(() => false)) return WrapCause.Finish;
  return timeIsUp(loopRun) ? WrapCause.Time : null;
}

/**
 * Whether nothing ended just now that the lead must hear before its Loop is done: the run's job ends
 * are read again at once (a job that ended since their last read is no longer at work, and its end
 * wakes the lead), and nothing is due after it.
 */
async function nothingJustEnded(
  loopRun: LoopRun,
  wake: WakeState,
  line: LeadLine | null,
  now: number,
): Promise<boolean> {
  wake.jobsPolledAt = null;
  await watchJobs(loopRun, wake, now);
  return dueAt(loopRun, wake, line, now) === null;
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

/**
 * A new session for a later turn. It knows nothing of the run, so beside this turn's own message it
 * is told, in Genex's words, that the earlier session was lost and how the Loop began.
 */
function openFresh(loopRun: LoopRun, kit: TurnKit, ask: TurnAsk, why: string): Promise<Partial<DelegateResult>> {
  // A Loop its lead paused, or one the person stopped, opens no new session.
  const refused = openSessionRefused(loopRun);
  if (refused) return Promise.resolve(refused);
  const lost = [LEAD_FRESH_START(why), ...withWorkLine(loopRun, kit.start)].join("\n");
  return kit.talk.session(ask.prompt, null, { ...ask.said, notices: [lost, ...(ask.said.notices ?? [])] });
}

/**
 * The lead's session is lost — it cannot be resumed, or its context is full: a fresh one carries
 * the run (`openFresh`). On the first turn the message already says how the Loop began.
 */
async function freshSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  ask: TurnAsk,
  why: string,
): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  const refused = openSessionRefused(loopRun);
  if (refused) return refused;
  if (wake.freshSessions >= MAX_FRESH_SESSIONS)
    return { ok: false, stopReason: StopReason.Error, errorText: `the lead's session was lost too often (${why})` };
  wake.freshSessions += 1;
  talk.sessionId = null;
  // The first turn already says how the Loop began: a Resume whose old session is gone opens a new one silently.
  if (wake.turns === 1) return talk.session(ask.prompt, null, ask.said);
  await loopRun.decision(
    `the director's session was lost (${why}); a fresh session carries the run on`,
    "the lead's conversation was lost, so a fresh one picks the build up where it stands",
  );
  return openFresh(loopRun, kit, ask, why);
}

/**
 * Whether a lead the host refused because another session holds its lock (`folderBusy`: for an open
 * Loop's lead, another chat's turn in the game folder) waits once more: until the lock is free, never
 * under a Stop or the lead's pause. Its turn has not begun: a claim of it speaks for the turn that
 * may begin.
 */
async function waitsForFolder(loopRun: LoopRun, kit: TurnKit): Promise<boolean> {
  const stopped = () => loopRun.ctx.cancelled === true || Boolean(loopRun.open.halted);
  if (stopped()) return false;
  await kit.clock.sleep(BUSY_RETRY_MS);
  // A Stop or a pause during the wait: the run's Stop freed the folder, and the next ask would be seated.
  if (stopped()) return false;
  noteTurnEnds(loopRun.state);
  return true;
}

/** The lead's session asked this turn's message; a turn that came back failed on an outage is thrown as one. */
async function askSession(loopRun: LoopRun, kit: TurnKit, ask: TurnAsk): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  // A Loop its lead paused, or one the person stopped, opens no new session: a retry included.
  const refused = openSessionRefused(loopRun);
  if (refused) return refused;
  const result = await talk.session(ask.prompt, talk.sessionId, ask.said);
  if (!endedOnOutage(result)) return result;
  throw Object.assign(new Error(String(result.errorText)), { kind: EngineFailure.Unavailable });
}

/**
 * The run's ctx as the outage ladder reads it: its wait also ends once the Loop is paused
 * (`open.halted`, its lead's `pause`), never after the rest of that wait.
 */
function patienceCtx(loopRun: LoopRun): HarnessCtx {
  const { ctx, open } = loopRun;
  return Object.create(ctx, {
    cancelled: { get: () => ctx.cancelled === true || Boolean(open.halted) },
  }) as HarnessCtx;
}

/**
 * The lead's session asked, with a provider outage waited out on the run's outage ladder, on the
 * Loop's own clock: an overloaded gateway on one wake used to end the whole run — workers stopped,
 * head landed, run reported done. What the ladder cannot outlast still fails.
 */
function patientAsk(loopRun: LoopRun, kit: TurnKit, ask: TurnAsk): Promise<Partial<DelegateResult>> {
  return withProviderPatience(patienceCtx(loopRun), () => askSession(loopRun, kit, ask), {
    clock: kit.clock,
    delays: outageDelays(loopRun.run),
    label: "the lead's provider",
    onWait: ({ wait, error }) =>
      loopRun.decision(
        `the lead's provider failed (${error}); asking it again in ${Math.ceil(wait / SECOND_MS)} s`,
        "the lead's provider is briefly down, so the studio waits and asks again; the builders keep working",
      ),
  });
}

/** `patientAsk`, and for a lead refused because another session holds its lock, asked again each time it may wait for it (`waitsForFolder`). */
async function patientSession(loopRun: LoopRun, kit: TurnKit, ask: TurnAsk): Promise<Partial<DelegateResult>> {
  for (;;) {
    try {
      return await patientAsk(loopRun, kit, ask);
    } catch (err) {
      if (!folderBusy(err) || !(await waitsForFolder(loopRun, kit))) throw err;
    }
  }
}

/**
 * One delegation of the lead's session, or a fresh session when its own is lost — or when a later
 * turn has none to resume (a fresh one that met the engine's limit before it began). A failure on
 * the first turn is the run's (the crash close); on a later one it is a failed turn — and so is a
 * first turn whose wait for its busy lock a Stop or a pause ended: the run closes on its own terms.
 * A first turn cut short for the chat's words is no failure at all (`oneTurn`).
 */
async function sessionOrFresh(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  ask: TurnAsk,
): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  const failed = async (err: any): Promise<Partial<DelegateResult>> => {
    if (await pauseOnProvider(loopRun, err, kit.clock.now())) return failedTurn(err);
    if (wake.turns === 1 && !folderBusy(err)) throw err;
    return failedTurn(err);
  };
  if (!talk.sessionId && wake.turns > 1) return openFresh(loopRun, kit, ask, SESSION_LOST_WHY.noSession).catch(failed);
  let result: Partial<DelegateResult>;
  try {
    result = await patientSession(loopRun, kit, ask);
  } catch (err: any) {
    const why = lostSessionWhy(talk, err);
    if (!why) return failed(err);
    return freshSession(loopRun, wake, kit, ask, why).catch(failed);
  }
  if (result?.stopReason !== StopReason.ContextOverflow) return result;
  return freshSession(loopRun, wake, kit, ask, SESSION_LOST_WHY.contextOverflowed).catch(failed);
}

/** A turn Genex ended because the Loop is paused: it never opened a session. */
const haltedTurn = (why: string): Partial<DelegateResult> => ({
  ok: false,
  stopReason: StopReason.Stopped,
  errorText: why,
});

/** Why the person stopped a turn that never opened a session. */
const STOPPED_BY_THE_USER = "stopped by the user";

/**
 * The turn the lead gets in place of a new session: it paused the Loop for the person, or the person
 * pressed Stop (a session in the folder has Edit and Bash and would work on under it); null while it
 * may open one.
 */
function openSessionRefused(loopRun: LoopRun): Partial<DelegateResult> | null {
  if (loopRun.open.halted) return haltedTurn(loopRun.open.halted);
  if (loopRun.ctx.cancelled === true) return haltedTurn(STOPPED_BY_THE_USER);
  return null;
}

/**
 * What a turn's message told the lead: heard and told once the turn worked on it, or answered; when
 * it failed first (an error, a limit, a cut before it read it), the chat's words and Genex's lines of
 * the log are still unheard, and its own lines (`lead`) open the next message.
 */
async function settleAsk(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  ask: TurnAsk,
  result: Partial<DelegateResult>,
): Promise<void> {
  if (result?.ok !== true && !startedASession(result)) {
    wake.owedLead = ask.lead;
    return;
  }
  wake.owedLead = [];
  toldThrough(loopRun, ask.toldSeq);
  if (ask.through) await kit.line?.heardThrough(ask.through);
}

/**
 * One session call of the lead's, watched while it runs (news.ts `watchTurn`): what the chat and Genex
 * say meanwhile reaches it at its next step. A first turn's failure is the run's (`sessionOrFresh`) —
 * unless the chat's words cut it short before its session began: then it is resumed with them
 * (`takeTurn`). The watch settles first, since the host's answer to the cut may come after the
 * failure the cut caused.
 */
async function oneTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  ask: TurnAsk,
): Promise<Partial<DelegateResult>> {
  wake.turns += 1;
  // A claim made in this turn is checked within it (open/finish.ts `turnLost`).
  noteTurnEnds(loopRun.state);
  const watch = watchTurn(loopRun, {
    line: kit.line,
    clock: kit.clock,
    turn: wake.turns,
    ask,
    mayCut: () => mayCut(loopRun, wake, kit),
    poll: async () => {
      await tick(loopRun, wake, kit.line, kit.clock.now());
      sayTimeUp(loopRun, wake.keep);
    },
  });
  let result: Partial<DelegateResult> | undefined;
  let thrown: { err: unknown } | null = null;
  try {
    result = await sessionOrFresh(loopRun, wake, kit, ask);
  } catch (err) {
    thrown = { err };
  }
  await watch.end(result);
  if (thrown && !watch.cut()) throw thrown.err;
  const ended = result ?? failedTurn(thrown?.err);
  noteTurnOver(loopRun.state);
  await settleAsk(loopRun, wake, kit, ask, ended);
  wake.cut = watch.cut();
  await kit.talk.keep(ended);
  return ended;
}

/**
 * One turn of the lead's, and its resumptions: a turn the chat's words cut short is resumed at once
 * in the same session with those words, as they were written (and Genex's own lines a turn that never
 * read its message still owes). A cut is never a failed turn. What the game's plugins said as the turn
 * starts (`turn.start`) is a line of the run's log its message carries; the turn always runs.
 */
async function takeTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  lead: readonly string[],
): Promise<Partial<DelegateResult>> {
  // One turn to the game's plugins, its resumptions included: its start and its end name it alike.
  const moment = turnScope(loopRun, wake);
  // What the plugins' steps found as the turn starts is the lead's to read in it: nothing holds the turn back.
  const found = await momentLines(loopRun.ctx, loopRun.game, HookEvent.TurnStart, moment);
  for (const line of found) loopRun.note(line, NoteKind.Folder);
  const ask = await askOf(loopRun, kit.line, [...wake.owedLead, ...lead]);
  let result = await oneTurn(loopRun, wake, kit, ask);
  while (wake.cut && !runOver(loopRun)) {
    wake.cut = false;
    const resume = await askOf(loopRun, kit.line, wake.owedLead);
    if (!saysSomething(resume)) break;
    result = await oneTurn(loopRun, wake, kit, resume);
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
 * A turn with a session to resume may be cut short for the chat's words — the first too: an engine
 * that cannot read input mid-turn would otherwise hear nothing for a whole turn. Never one with no
 * session yet (a fresh lead's first: a cut would leave nothing to resume), the wrap-up, a turn whose
 * run is already over (its `finish` may be under way), or one inside a tool call — cut there, the lead
 * never gets the call's answer (tools.ts counts them).
 */
function mayCut(loopRun: LoopRun, wake: WakeState, kit: TurnKit): boolean {
  const resumable = Boolean(kit.talk.sessionId);
  const inCall = (loopRun.toolsInFlight ?? 0) > 0;
  return resumable && !inCall && !wake.wrapping && !runOver(loopRun);
}

/** The journal keeps the loop's own state and the run's record (loop-run.ts `saveJournal`) as they stand now. */
async function keepWake(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  journalWake(loopRun, wake);
  wake.journaledSeq = loopRun.logSeq;
  wake.journaledAt = now;
  await loopRun.saveJournal();
}

/** The lead rests until something is due (`sleepUntilDue`), the journal holding what a restart needs; false once the Loop is done. */
async function restUntilDue(loopRun: LoopRun, wake: WakeState, kit: TurnKit): Promise<boolean> {
  const now = kit.clock.now();
  wake.asleepSince = now;
  // The run's jobs are read again at once: a job the turn started is at work.
  loopRun.jobsReadAt = null;
  await keepWake(loopRun, wake, now);
  return sleepUntilDue(loopRun, wake, kit);
}

/** One turn of the lead's, then what waits for its end before the next (`afterTurn`). */
async function turnThenBetween(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  lead: readonly string[],
): Promise<Partial<DelegateResult>> {
  const result = await takeTurn(loopRun, wake, kit, lead);
  if (loopRun.afterTurn && !runOver(loopRun)) await loopRun.afterTurn({ last: wake.wrapping });
  return result;
}

/**
 * The run as a series of the lead's turns. The first opens with the Loop's first lines (`start`:
 * that it started or resumed, with its goal, and what the project's plugins said); each later one
 * with what woke it; the wrap-up, when one starts, is the last. Returns when the run is over for the
 * lead — finished, stopped, paused on a limit, wrapped up, or done with nothing at work — and the
 * caller closes what it left open.
 */
export async function runWakeLoop(
  loopRun: LoopRun,
  talk: DirectorTalk,
  start: readonly string[],
  clock: OpenClock = OPEN_WALL_CLOCK,
  line: LeadLine | null = null,
): Promise<WakeOutcome> {
  // The run's tools read the time on this clock (`wrap_up` stamps the person's ask with it).
  keepRunClock(loopRun, () => clock.now());
  const resumed = resumedFromJournal(loopRun);
  const wake = newWakeState(resumed ? restoredWake(loopRun.priorJournal?.director?.wake) : undefined);
  const kit: TurnKit = { talk, start, clock, line };
  if (resumed) await handAgain(loopRun, line);
  // The parts the lead calls (the plan hold, worker_start) answer a run the wake loop drives.
  loopRun.waking = true;
  let result = await turnThenBetween(loopRun, wake, kit, withWorkLine(loopRun, start));
  for (;;) {
    const verdict = afterTurn(await turnFacts(loopRun, wake, result, clock.now()));
    if (verdict.next === TurnEnd.Close) break;
    if (verdict.next === TurnEnd.WrapUp && verdict.wrapCause) startWrapUp(loopRun, wake, verdict.wrapCause, result);
    else if (!(await restUntilDue(loopRun, wake, kit))) break;
    // A sign-in a worker or a judge lost while the lead slept pauses the run before it is woken.
    if (await pauseOnLostSignIn(loopRun, clock.now())) break;
    result = await turnThenBetween(loopRun, wake, kit, wake.wrapping ? [wrapLine(loopRun, wake)] : []);
  }
  journalWake(loopRun, wake);
  return { result, wrapCause: wake.wrapCause, failed: wake.failed };
}

/**
 * Put the wake loop's own state on the journal (`journal.director.wake`, journal.ts `wakeRecord`),
 * and the run's record with it. The caller saves it.
 */
export function journalWake(loopRun: LoopRun, wake: WakeState): void {
  const director = loopRun.journal?.director;
  if (!director) return;
  recordLoopRun(loopRun);
  director.wake = wakeRecord(wake);
}
