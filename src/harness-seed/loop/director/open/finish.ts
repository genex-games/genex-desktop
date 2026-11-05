/**
 * The lead's `finish`: its claim that the project meets the request. Genex's finish moment runs
 * first (a plugin may hold the finish back: the lead hears why and keeps working), and a web game's
 * page (never an engine's game's, by what its folder holds then) gets one health check in the game
 * folder (it loads, throws nothing uncaught, its frame is not blank: a failing one comes back to the
 * lead, and the Loop goes on); then the claim closes the Loop
 * in place on the lead's word (Loop phase 4). With `review=yes` the lead asks a
 * reviewer that did none of the work for a second opinion first (`../../finish-check.ts`), reading
 * the game folder, the lead's proof and the observers' captures: a yes closes the Loop as reviewed,
 * and a no comes back with its reasons and decides nothing. A finish the person asked for needs no
 * claim. Everything runs on the Loop's clock, inside the lead's call, which the close's own time
 * (`OPEN_CLOSE_MS`) shares: a close that outlasts the call goes on after the lead is told it was
 * accepted. A claim whose turn ended while the reviewer read, or whose folder went back to a save
 * point meanwhile, gets no answer. No claim is made while Genex brings the project's app back, nor
 * while a rewind or restart the lead asked for waits for the turn's end, nor while a worker writes in
 * the folder in place.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { DelegateResult } from "../../../types/host-api.d.ts";
import {
  CALL_MARGIN_MS,
  checkFinish,
  type FinishClaim,
  type FinishOutcome,
  type FinishTally,
  finishAnswer,
  tallyOf,
} from "../../finish-check.ts";
import { FinishCheckStep, LEAD_CALL_MS } from "../../finish-contract.ts";
import { readFinishLog } from "../../finish-log.ts";
import { remainingOf } from "../../finish-remaining.ts";
import { fireHooks, HookEvent, runScope } from "../../hooks.ts";
import { HOOK_PROMPTS } from "../../hooks-prompts.ts";
import { CLIP_REASON, clipMarked, hasText } from "../../text.ts";
import { SECOND_MS } from "../../time.ts";
import { type FactsOfDescriptor, pageChecked } from "../../folder-facts.ts";
import { checkHealth, healthLine } from "../../health-check.ts";
import { HostMethod } from "../../host-methods.ts";
import { yes } from "../args.ts";
import { closeUnderWay, holdFinish, releaseFinish } from "../close-latch.ts";
import { CLAIM_WORDS } from "../second-opinion-prompts.ts";
import { heldTurnEnding } from "../held-words.ts";
import type { LoopRun } from "../loop-run.ts";
import { WrapCause } from "../wake-schedule.ts";
import { type TurnEnds, turnEndsOf } from "../turn-ends.ts";
import { closeInPlace, type OpenEnd } from "./close.ts";
import { asksPending, OPEN_CLOSE_MS } from "./contract.ts";
import { OPEN_WORDS } from "./prompts.ts";
import { writersInPlace } from "./writers.ts";

/** Why the Loop ended when its lead's claim was accepted, the person asked it to finish, its lead's turn ended, or its session did. */
export const MESSAGE = {
  goalReached: "the reviewer accepted that the goal is reached",
  /** The lead claimed the goal is reached and asked no reviewer: its word closes the Loop. */
  leadClaimed: "the lead says the goal is reached",
  personFinished: "the person asked the Loop to finish",
  /** The ordinary end: the lead's turn ended with nothing at work and nothing to be woken for. */
  nothingAtWork: "the lead's turn ended with nothing at work",
  /** The lead's session failed before it claimed the goal (`how`: how it ended). */
  sessionEnded: (how: string) => `the lead's session ended (${how}) before it claimed the goal`,
  /** The person asked to finish, and the lead did not claim the goal in its last turn. */
  finishAsked: "the person asked the Loop to finish, and the lead did not claim the goal in its last turn",
  /** A reviewer's yes given across a way back to a save point no longer speaks for the folder. */
  wentBackUnderReview: "the folder went back to a save point while the reviewer read it",
} as const;

/** How often a close running past the lead's call is looked at, until the call must answer. */
const CLOSE_POLL_MS = SECOND_MS;

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

/** What marks the lead's work: its Loop's newest save point, its own or an autosave ("" before the first). */
const workMarkOf = (loopRun: LoopRun): string => loopRun.open.journal.savePoints.at(-1)?.snapshotId ?? "";

/** Whether the claim's own turn is over: its session returned, or another turn began. */
const turnLost = (loopRun: LoopRun, claimed: TurnEnds | undefined): boolean => {
  const now = turnEndsOf(loopRun.state);
  return now !== claimed || now?.over === true;
};

/** Why a yes no longer speaks for the folder: a recovery took it back to a save point since the claim. */
function lapsedSince(loopRun: LoopRun): () => Promise<string | null> {
  const restores = loopRun.open.restores;
  return async () => (loopRun.open.restores !== restores ? MESSAGE.wentBackUnderReview : null);
}

/** Ask the reviewer about the claim, on the Loop's clock, from the call's start: a yes leaves the close its time (`OPEN_CLOSE_MS`). */
async function check(loopRun: LoopRun, claim: FinishClaim, started: number): Promise<FinishOutcome> {
  const { ctx, gameFacts, inbox, projectDir, run, threadId } = loopRun;
  const clock = loopRun.open.clock;
  const log = await readFinishLog(ctx, threadId, run.runId, await inbox.steering());
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
      said: log.said,
      relayed: log.relayed,
      ended: () => closing(loopRun),
      abandoned: () => turnLost(loopRun, turn),
      lapsed: lapsedSince(loopRun),
      workMark: async () => workMarkOf(loopRun),
      keep: () => loopRun.saveJournal(),
    },
    claim,
  );
}

/**
 * What a review the lead asked for came to: a yes closes the Loop as reviewed; anything else — a no,
 * no answer, no time, no reviewer to seat — goes back to the lead, who decides (null).
 */
function endOf(outcome: FinishOutcome): { end: OpenEnd; told: string; closing?: string } | null {
  if ("noTime" in outcome || outcome.step !== FinishCheckStep.Accepted) return null;
  const end = { victory: true, because: MESSAGE.goalReached, checked: true };
  return { end, told: OPEN_WORDS.accepted, closing: OPEN_WORDS.acceptedClosing };
}

/** What the lead hears when its review did not close the Loop: the reviewer's no as a second opinion, or why there was none. */
function reviewAnswer(outcome: FinishOutcome): string {
  if ("noTime" in outcome) return finishAnswer(outcome);
  if (outcome.step === FinishCheckStep.Unanswered && outcome.seatless) return CLAIM_WORDS.noReviewer;
  return finishAnswer(outcome);
}

/**
 * The close a check called for, inside the lead's call: waited for until the call must answer
 * (`LEAD_CALL_MS` from its start), then left to finish on its own; whether it finished in time.
 */
async function closeWithinCall(loopRun: LoopRun, end: OpenEnd, started: number): Promise<boolean> {
  const clock = loopRun.open.clock;
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
 * lead's still under way, the project's app still closed for the lead to fix, a worker that writes in the folder in place (the reviewer would read a
 * folder that keeps changing). A finish is never refused for time, nor for what the lead says remains.
 */
function claimRefusal(loopRun: LoopRun, args: AnyRecord): string | null {
  if (!hasText(args.summary)) return OPEN_WORDS.needsSummary;
  if (loopRun.open.recovering) return OPEN_WORDS.recovering;
  if (loopRun.open.appDown) return OPEN_WORDS.appDown;
  // The folder the reviewer would read is not the one the lead asked for yet.
  if (asksPending(loopRun.open.journal)) return OPEN_WORDS.askFirst;
  const writers = writersInPlace(loopRun.open).map((record) => record.id);
  return writers.length ? OPEN_WORDS.writerAtWork(writers) : null;
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

/**
 * The game as the host lists it as the lead finishes: the Loop may have changed what its folder holds
 * (an engine's project made in it). The Loop's start's reading when the host can't list it.
 */
async function gameAtFinish(loopRun: LoopRun): Promise<FactsOfDescriptor> {
  const { ctx, gameFacts, open, run } = loopRun;
  const games = await ctx.call(HostMethod.GameList).catch(() => null);
  const listed = Array.isArray(games) ? games.find((game) => game.name === run.project) : undefined;
  return listed ?? { facts: gameFacts, holds: open.holds };
}

/**
 * A web game's page, checked once in the game folder before its Loop closes: what is wrong with it,
 * or null when it is healthy, the project is no web game or an engine's game as the lead finishes
 * (`pageChecked`), or no check could be made.
 */
async function pageProblems(loopRun: LoopRun): Promise<string | null> {
  const { ctx, run } = loopRun;
  if (!pageChecked(await gameAtFinish(loopRun))) return null;
  const target = { project: run.project, runId: run.runId, label: "director/finish" };
  const check = await checkHealth(ctx, target, { sleep: loopRun.open.clock.sleep });
  return check.ok || check.unchecked ? null : OPEN_WORDS.unhealthy(healthLine(check));
}

/** The claim itself, once the finish is the lead's alone: the moment, then the close on the lead's word or after the review it asked for. */
async function claimFinish(loopRun: LoopRun, args: AnyRecord, started: number): Promise<string> {
  if (await loopRun.inbox.finishing().catch(() => false)) {
    const closed = await closeWithinCall(loopRun, { victory: false, because: MESSAGE.personFinished }, started);
    return closed ? OPEN_WORDS.personFinished : OPEN_WORDS.closing;
  }
  const refused = claimRefusal(loopRun, args);
  if (refused) return refused;
  const review = yes(args.review, false);
  const held = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Finish, runScope(loopRun));
  if (held.blocked) return HOOK_PROMPTS.finishHeld(held.blocked.reason);
  const unhealthy = await pageProblems(loopRun);
  if (unhealthy) return unhealthy;
  if (!review) {
    const closed = await closeWithinCall(loopRun, { victory: true, because: MESSAGE.leadClaimed }, started);
    return closed ? CLAIM_WORDS.closedOnClaim : OPEN_WORDS.closing;
  }
  return reviewedClaim(loopRun, args, held, started);
}

/** A claim the lead asked a reviewer to read first: the review, then the close on its yes, or its answer. */
async function reviewedClaim(
  loopRun: LoopRun,
  args: AnyRecord,
  held: Awaited<ReturnType<typeof fireHooks>>,
  started: number,
): Promise<string> {
  const claim: FinishClaim = {
    summary: args.summary.trim(),
    remaining: remainingOf(args.remaining),
    proof: proofOf(args),
    hookNotes: held.notes.map((note) => clipMarked(note.text, CLIP_REASON)),
    hookImages: held.images,
  };
  const outcome = await checked(loopRun, claim, started);
  await loopRun.saveJournal().catch(() => {});
  // The Loop closed while the reviewer read (a Stop, a pause): nothing more is ended here.
  if (closing(loopRun)) return OPEN_WORDS.ending;
  const ends = endOf(outcome);
  if (!ends) return reviewAnswer(outcome);
  // Told how it ended and that the Loop closes, though the close outlasts the call: never "carry on".
  if (await closeWithinCall(loopRun, ends.end, started)) return ends.told;
  return ends.closing ?? OPEN_WORDS.closing;
}

/** `finish` (the module's header): one claim at a time, never on a Loop already closing. */
export async function openFinish(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const started = loopRun.open.clock.now();
  if (closing(loopRun)) return OPEN_WORDS.ending;
  if (!holdFinish(loopRun.state)) return OPEN_WORDS.finishUnderWay;
  try {
    return await claimFinish(loopRun, args, started);
  } finally {
    releaseFinish(loopRun.state);
  }
}

/** How a lead session that failed ended: its stop reason, or that it failed. */
const endedHow = (result: Partial<DelegateResult>): string => result?.stopReason ?? "failed";

/**
 * Why an open Loop its lead left open ended, in its own words (the lead, never the director's), for
 * the closes whose words are the Loop's own: the person's finish, a turn that ended with nothing at
 * work, a session that failed. Null for the rest (a Stop, a lost provider, a turn Genex's moments
 * held back), whose words are every Loop's.
 */
export function openEndWords(
  loopRun: LoopRun,
  result: Partial<DelegateResult>,
  wrapCause: WrapCause | null,
): string | null {
  const { ctx, state } = loopRun;
  if (ctx.cancelled || state.limit || heldTurnEnding(result) !== null) return null;
  if (wrapCause === WrapCause.Finish) return MESSAGE.finishAsked;
  if (result?.ok) return MESSAGE.nothingAtWork;
  return MESSAGE.sessionEnded(endedHow(result));
}
