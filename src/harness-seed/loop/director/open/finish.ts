/**
 * The open lead's `finish`: its claim that the project meets the request. Genex's finish moment runs
 * first (a plugin may hold the finish back: the lead hears why and keeps working); then a reviewer
 * that did none of the work checks the claim (`../../finish-check.ts`), reading the game folder, the
 * lead's proof and the observers' captures. A yes closes the Loop in place inside the call; a no
 * comes back with its reasons, and the no's that stop a Loop close it with what isn't done. A finish
 * the person asked for needs no claim. Everything runs on the Loop's clock, inside the lead's call
 * and its turn, which the close's own time (`OPEN_CLOSE_MS`) shares: a close that outlasts the call
 * goes on after the lead is told it was accepted. A claim whose turn ended while the reviewer read,
 * or whose folder went back to a save point meanwhile, gets no answer. No claim is made while Genex
 * brings the project's app back, nor while a rewind or restart the lead asked for waits for the turn's end,
 * nor while a worker writes in the folder in place, nor while the lead names what remains and has
 * time for it; one before the Loop's cap is checked like any other.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { DelegateResult } from "../../../types/host-api.d.ts";
import {
  CALL_MARGIN_MS,
  checkFinish,
  FINISH_REPORT,
  type FinishClaim,
  type FinishOutcome,
  type FinishTally,
  finishAnswer,
  tallyOf,
} from "../../finish-check.ts";
import { FinishCheckStep, LEAD_CALL_MS } from "../../finish-contract.ts";
import { readFinishLog } from "../../finish-log.ts";
import { GAPS_FIRST_MIN_MS, remainingOf } from "../../finish-remaining.ts";
import { fireHooks, HookEvent, runScope } from "../../hooks.ts";
import { HOOK_PROMPTS } from "../../hooks-prompts.ts";
import { CLIP_REASON, clipMarked, hasText } from "../../text.ts";
import { minutes, SECOND_MS, sleep } from "../../time.ts";
import { closeUnderWay, holdFinish, releaseFinish } from "../close-latch.ts";
import { heldTurnEnding } from "../held-words.ts";
import type { LoopRun } from "../loop-run.ts";
import { WrapCause } from "../wake-schedule.ts";
import { type TurnEnds, turnEndsOf } from "../turn-ends.ts";
import { closeInPlace, type OpenEnd } from "./close.ts";
import { asksPending, OPEN_CLOSE_MS, type OpenClock } from "./contract.ts";
import { gapsFirstWords } from "./evidence-prompts.ts";
import { OPEN_WORDS } from "./prompts.ts";
import { writersInPlace } from "./writers.ts";

/** Why the Loop ended when its lead's claim was accepted, the person asked it to finish, or its time ran out. */
export const MESSAGE = {
  goalReached: "the reviewer accepted that the goal is reached",
  personFinished: "the person asked the Loop to finish",
  timeUpNoClaim: "the Loop's time ran out before a reviewer accepted the goal; here is where it stands",
  /** The Loop's time ran out while a reviewer still checked the lead's claim. */
  timeUpUnderReview: "the Loop's time ran out while a reviewer checked the lead's claim; here is where it stands",
  /** The lead's session ended before it claimed the goal (`how`: how it ended). */
  sessionEnded: (how: string) => `the lead's session ended (${how}) before it claimed the goal`,
  /** The Loop's lead had nothing left at work and kept or changed nothing in the turn it was asked what next. */
  idle: "the lead had nothing left to do and did not claim the goal",
  /** The person asked to finish, and the lead did not claim the goal in its last turn. */
  finishAsked: "the person asked the Loop to finish, and the lead did not claim the goal in its last turn",
  /** A reviewer's yes given across a way back to a save point no longer speaks for the folder. */
  wentBackUnderReview: "the folder went back to a save point while the reviewer read it",
} as const;

/** How often a close running past the lead's call is looked at, until the call must answer. */
const CLOSE_POLL_MS = SECOND_MS;

/** The Loop's clock: the wake loop's, else the wall clock (a run a kept older setup made). */
const clockOf = (loopRun: LoopRun): OpenClock => loopRun.open?.clock ?? { now: Date.now, sleep };

/** Whether the Loop is closing or closed: nothing more is claimed or ended then. */
const closing = (loopRun: LoopRun): boolean =>
  loopRun.state.finished || Boolean(loopRun.state.finish) || closeUnderWay(loopRun.state);

/** The files the lead names as proof: a comma-separated list. */
const proofOf = (args: AnyRecord): string[] =>
  hasText(args.proof)
    ? args.proof
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];

/** The Loop's finish checks so far, kept in its journal, numbered past every round its log holds. */
function tallyFor(loopRun: LoopRun, lastRound: number): FinishTally {
  loopRun.state.finishTally ??= tallyOf(loopRun.journal?.director?.finishTally);
  const tally = loopRun.state.finishTally;
  tally.round = Math.max(tally.round, lastRound);
  return tally;
}

/** Whether the claim's own turn is over: its session returned, or another turn began. */
const turnLost = (loopRun: LoopRun, claimed: TurnEnds | undefined): boolean => {
  const now = turnEndsOf(loopRun.state);
  return now !== claimed || now?.over === true;
};

/** Why a yes no longer speaks for the folder: a recovery took it back to a save point since the claim. */
function lapsedSince(loopRun: LoopRun): () => Promise<string | null> {
  const restores = loopRun.open?.restores ?? 0;
  return async () => ((loopRun.open?.restores ?? 0) !== restores ? MESSAGE.wentBackUnderReview : null);
}

/**
 * Ask the reviewer about the claim, on the Loop's clock, from the call's start, within the lead's
 * turn: a yes leaves the close its time (`OPEN_CLOSE_MS`) before the turn's cap.
 */
async function check(loopRun: LoopRun, claim: FinishClaim, started: number): Promise<FinishOutcome> {
  const { ctx, gameFacts, inbox, projectDir, run, threadId } = loopRun;
  const clock = clockOf(loopRun);
  const log = await readFinishLog(ctx, threadId, run.runId, await inbox.steering(undefined, false));
  const turn = turnEndsOf(loopRun.state);
  return checkFinish(
    {
      ctx,
      run,
      threadId,
      game: { name: run.project, dir: projectDir, facts: gameFacts },
      leadFolder: projectDir,
      tally: tallyFor(loopRun, log.lastRound),
      now: clock.now,
      sleep: clock.sleep,
      callStarted: started,
      closeMs: OPEN_CLOSE_MS,
      ...(turn ? { endsBy: turn.endsBy - OPEN_CLOSE_MS } : {}),
      said: log.said,
      relayed: log.relayed,
      ended: () => closing(loopRun),
      abandoned: () => turnLost(loopRun, turn),
      lapsed: lapsedSince(loopRun),
      keep: () => loopRun.saveJournal(),
    },
    claim,
  );
}

/**
 * A claim turned back before any review: the lead names what remains and more than
 * `GAPS_FIRST_MIN_MS` of working time is left, so it works on that first; null when it may be checked.
 */
function gapsFirst(loopRun: LoopRun, remaining: readonly string[]): string | null {
  if (!remaining.length) return null;
  const left = loopRun.softDeadline - clockOf(loopRun).now();
  return left > GAPS_FIRST_MIN_MS ? gapsFirstWords(remaining, minutes(left), minutes(GAPS_FIRST_MIN_MS)) : null;
}

/** What a check came to: the close it calls for and what the lead is told then, or null while the Loop goes on. */
function endOf(loopRun: LoopRun, outcome: FinishOutcome): { end: OpenEnd; told: string; closing?: string } | null {
  if ("noTime" in outcome) {
    const last = turnEndsOf(loopRun.state)?.last === true;
    if (!outcome.turnEnds || !last) return null;
    return { end: { victory: false, because: FINISH_REPORT.tooLate }, told: OPEN_WORDS.noTimeLeft };
  }
  if (outcome.step === FinishCheckStep.Accepted) {
    const end = { victory: true, because: MESSAGE.goalReached, checked: true };
    return { end, told: OPEN_WORDS.accepted, closing: OPEN_WORDS.acceptedClosing };
  }
  if (outcome.step === FinishCheckStep.Unanswered && outcome.seatless)
    return { end: { victory: false, because: FINISH_REPORT.noReviewer, checked: true }, told: OPEN_WORDS.noReviewer };
  if (outcome.step !== FinishCheckStep.Rejected || !outcome.stop) return null;
  const end = { victory: false, because: FINISH_REPORT.notAccepted, notDone: outcome.reasons, checked: true };
  return { end, told: finishAnswer(outcome) };
}

/**
 * The close a check called for, inside the lead's call: waited for until the call must answer
 * (`LEAD_CALL_MS` from its start), then left to finish on its own; whether it finished in time.
 */
async function closeWithinCall(loopRun: LoopRun, end: OpenEnd, started: number): Promise<boolean> {
  const clock = clockOf(loopRun);
  const answerBy = started + LEAD_CALL_MS - CALL_MARGIN_MS;
  let done = false;
  const closing = closeInPlace(loopRun, end).finally(() => {
    done = true;
  });
  closing.catch(() => {});
  while (!done && clock.now() < answerBy) await Promise.race([closing.catch(() => {}), clock.sleep(CLOSE_POLL_MS)]);
  if (done) await closing;
  return done;
}

/**
 * Why a claim is turned back before anything looks, or null: no summary, a recovery or an ask of the
 * lead's still under way, a worker that writes in the folder in place (the reviewer would read a
 * folder that keeps changing), or what remains named while the Loop has time for it (`gapsFirst`).
 * Otherwise a claim is never refused for time: before the cap its reviewer decides, and a yes ends
 * the Loop (time-cap.ts).
 */
function claimRefusal(loopRun: LoopRun, args: AnyRecord): string | null {
  if (!hasText(args.summary)) return OPEN_WORDS.needsSummary;
  if (loopRun.open?.recovering) return OPEN_WORDS.recovering;
  // The folder the reviewer would read is not the one the lead asked for yet.
  if (loopRun.open && asksPending(loopRun.open.journal)) return OPEN_WORDS.askFirst;
  const writers = loopRun.open ? writersInPlace(loopRun.open).map((record) => record.id) : [];
  if (writers.length) return OPEN_WORDS.writerAtWork(writers);
  return gapsFirst(loopRun, remainingOf(args.remaining));
}

/** The reviewer's check, the chat's status saying so while it reads. */
async function checked(loopRun: LoopRun, claim: FinishClaim, started: number): Promise<FinishOutcome> {
  const { ctx, run } = loopRun;
  ctx.setStatus(`run ${run.runId} · lead in place finishing`);
  try {
    return await check(loopRun, claim, started);
  } finally {
    ctx.setStatus(`run ${run.runId} · lead in place`);
  }
}

/** The claim itself, once the finish is the lead's alone: the moment, the check, and the close it calls for. */
async function claimFinish(loopRun: LoopRun, args: AnyRecord, started: number): Promise<string> {
  if (await loopRun.inbox.finishing().catch(() => false)) {
    const closed = await closeWithinCall(loopRun, { victory: false, because: MESSAGE.personFinished }, started);
    return closed ? OPEN_WORDS.personFinished : OPEN_WORDS.closing;
  }
  const refused = claimRefusal(loopRun, args);
  if (refused) return refused;
  const held = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Finish, runScope(loopRun));
  if (held.blocked) return HOOK_PROMPTS.finishHeld(held.blocked.reason);
  const claim: FinishClaim = {
    summary: args.summary.trim(),
    remaining: remainingOf(args.remaining),
    proof: proofOf(args),
    hookNotes: held.notes.map((note) => clipMarked(note.text, CLIP_REASON)),
    hookImages: held.images,
  };
  const outcome = await checked(loopRun, claim, started);
  await loopRun.saveJournal().catch(() => {});
  // The Loop closed while the reviewer read (its clock, a Stop): nothing more is ended here.
  if (closing(loopRun)) return OPEN_WORDS.ending;
  const ends = endOf(loopRun, outcome);
  // Turned down with the Loop going on: the lead's turn did something, whatever else it changed.
  const turnedDown = "step" in outcome && outcome.step === FinishCheckStep.Rejected;
  if (!ends && turnedDown && loopRun.open) loopRun.open.claimTurnedDown = true;
  if (!ends) return finishAnswer(outcome);
  // Told how it ended and that the Loop closes, though the close outlasts the call: never "carry on".
  if (await closeWithinCall(loopRun, ends.end, started)) return ends.told;
  return ends.closing ?? OPEN_WORDS.closing;
}

/** `finish` (the module's header): one claim at a time, never on a Loop already closing. */
export async function openFinish(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const started = clockOf(loopRun).now();
  if (closing(loopRun)) return OPEN_WORDS.ending;
  if (!holdFinish(loopRun.state)) return OPEN_WORDS.finishUnderWay;
  try {
    return await claimFinish(loopRun, args, started);
  } finally {
    releaseFinish(loopRun.state);
  }
}

/** How a lead session that ended by itself ended: its stop reason, or whether it stopped or failed. */
const endedHow = (result: Partial<DelegateResult>): string =>
  result?.stopReason ?? (result?.ok ? "on its own" : "failed");

/**
 * Why an open Loop its lead left open ended, in its own words (the lead, never the director's), for
 * the closes whose words are the Loop's own: an idle lead, the person's finish, the time running out
 * under a claim's review, a session that ended. Null for the rest (a Stop, a lost provider, a turn
 * Genex's moments held back), whose words are every Loop's.
 */
export function openEndWords(
  loopRun: LoopRun,
  result: Partial<DelegateResult>,
  wrapCause: WrapCause | null,
): string | null {
  const { ctx, softDeadline, state } = loopRun;
  if (ctx.cancelled || state.limit || heldTurnEnding(result) !== null) return null;
  if (wrapCause === WrapCause.Idle) return MESSAGE.idle;
  if (wrapCause === WrapCause.Finish) return MESSAGE.finishAsked;
  const onTheClock = wrapCause !== WrapCause.Failed && clockOf(loopRun).now() >= softDeadline;
  if (onTheClock && state.finishTally?.checking) return MESSAGE.timeUpUnderReview;
  if (onTheClock) return MESSAGE.timeUpNoClaim;
  return MESSAGE.sessionEnded(endedHow(result));
}

/**
 * Did the Loop's time run out with no reviewer's yes (its wrap-up was the clock's, or its clock is
 * past its working time), and nothing else ended it: no Stop, no lost provider, no claim still under
 * review? Then it closes in its own words (`MESSAGE.timeUpNoClaim`), and no reviewer is asked.
 */
export function timeUpWithoutYes(loopRun: LoopRun, wrapCause: WrapCause | null): boolean {
  const { ctx, softDeadline, state } = loopRun;
  if (ctx.cancelled || state.limit || state.finishTally?.checking) return false;
  if (wrapCause === WrapCause.Deadline) return true;
  return wrapCause === null && clockOf(loopRun).now() >= softDeadline;
}
