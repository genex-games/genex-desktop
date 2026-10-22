/**
 * The director's claim that the goal is reached (`finish victory=yes`; the person's own Finish is no
 * claim), checked by a reviewer that did none of the work (`../finish-check.ts`) before the close.
 * The reviewer reads the integration worktree (the build that would land), the lead's proof, the
 * finish moment's notes and pictures, the run's job results and Genex's captures of the build; a yes
 * closes the run as before, a no goes back to the lead, and the no's that stop a Loop close it with
 * what isn't done. A claim the call (or the lead's turn) has no time left to check is not counted: the
 * lead is told to call finish again (the art director's look, which may have used the time, then
 * stands on the head), or, in the run's last turn, the run closes as no claim and says the time ran
 * out. A yes for a head that moved while the reviewer read is no answer; a close that lands another
 * head is no victory (integrate.ts).
 * Everything runs inside the lead's one `finish` call, whose time the close still needs: its settle,
 * the readers' stop, its look and, when the head still owes one, its judge (`closeMsOf`); that judge
 * ends before the call's end, leaving the landing its time (`claimJudgeBy`), and a close still running
 * at the call's end answers the lead that the run is closing (`closedBy`) and lands after it. A module
 * of its own, so the shipped parts that use it (integrate.ts, tools.ts, the journal, director.ts)
 * need no new name from a module an agent may have kept.
 */
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { HookImage, HookReport } from "../../types/host-api.d.ts";
import type { Evidence } from "../evidence.ts";
import {
  CALL_MARGIN_MS,
  CLAIM_BEFORE_END_MINUTES,
  checkFinish,
  FINISH_REPORT,
  type FinishOutcome,
  type FinishTally,
  finishAnswer,
  type NoTime,
  notDoneOf,
  tallyOf as savedTally,
} from "../finish-check.ts";
import { FINISH_ANSWER } from "../finish-check-prompts.ts";
import { FinishCheckStep, LEAD_CALL_MS, StopWhy } from "../finish-contract.ts";
import { readFinishLog } from "../finish-log.ts";
import { proofPathsIn } from "../finish-proof.ts";
import { gitAt } from "../git.ts";
import { FACT_ROOT } from "../folder-facts.ts";
import { RECORDING_FRAMES } from "../observers.ts";
import { timeLeftOf } from "../time-cap.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { list } from "./args.ts";
import { CLOSE_SETTLE_MS } from "./budgets.ts";
import { closeUnderWay } from "./close-latch.ts";
import { type LoopRun, WindowLease } from "./loop-run.ts";
import { GIT_WITHOUT_PROOF } from "./proof-git.ts";
import { type TurnEnds, turnEndsOf } from "./turn-ends.ts";

/**
 * How soon after it starts the close's own judge must be done asking (tools.ts `judgeTheLanding`).
 * The close runs inside the lead's `finish` call, which the engine gives up on after ten minutes, and
 * the settle, the close's look and the judge's own look share that time.
 */
export const FINAL_JUDGE_MS = 4 * MINUTE_MS;
/** The close's look at the head it lands, as a finish call budgets it (art-direction.ts budgets the same look). */
export const CLOSE_LOOK_MS = 2 * MINUTE_MS;
/** What a claim keeps for the close's judge: it ends before the call's end (`claimJudgeBy`), at most `FINAL_JUDGE_MS` after it starts. */
export const CLAIM_JUDGE_MS = 2 * MINUTE_MS;
/** What the close gives the run's readers to stop, as the worker pool does (workers/pool.ts `SETTLE_WAIT_MS`). */
export const CLOSE_READERS_MS = 30 * SECOND_MS;
/** What a claim keeps after the close's judge: the landing in the game folder and the run's close. */
export const CLAIM_LANDING_MS = 30 * SECOND_MS;
/**
 * What a yes still needs of the lead's `finish` call after the check, at most (`closeMsOf`): the
 * close's settle, readers, look, judge and landing.
 */
export const CLAIM_CLOSE_MAX_MS =
  CLOSE_SETTLE_MS + CLOSE_READERS_MS + CLOSE_LOOK_MS + CLAIM_JUDGE_MS + CLAIM_LANDING_MS;

/**
 * What a claim's answer says when the run closed under it, the build moved while the reviewer read,
 * its turn had no time for a review, the run closes without a yes, or the close outlasts the call.
 */
export const CLAIM_ANSWER = {
  alreadyClosed: FINISH_ANSWER.alreadyClosed,
  moved:
    "The build moved while the reviewer read your claim (something was integrated meanwhile), so its yes does not speak for what would land. Call finish again, with nothing else in the same turn.",
  noTimeInTurn: `Your turn ends too soon for a reviewer to check your claim, so it is not counted. Call finish early in your wrap-up, at least ${CLAIM_BEFORE_END_MINUTES} minutes before the run ends, with nothing else in the same turn.`,
  tooLate:
    "No time is left in this run for a reviewer to check your claim, so the run closes without a yes and its report says the time ran out.",
  noReviewer: "No engine here can hold a reviewer to check your claim, so the run closes without a yes.",
  stopped: (no: { rejections: number; reasons: readonly string[]; notDone: readonly string[] }) =>
    FINISH_ANSWER.stopped(no.rejections, no.reasons, no.notDone),
  closing:
    "The reviewer accepted that the goal is reached and the run is closing: Genex lands the build if it runs when it is checked at the end, and the report says so. End your session now with a one-paragraph summary for the user; do not say the build is live.",
  closingUnwon:
    "The run is closing without a yes: Genex lands the build if it runs when it is checked at the end, and the report says so. End your session now with a one-paragraph summary for the user; do not say the goal is reached or the build is live.",
  integrateClosing: "The run is closing: nothing more is integrated. End your session now.",
} as const;
/** Why a yes was recorded as no answer: the build moved while the reviewer read. */
const MOVED_WHY = "the build moved while the reviewer read the claim";
/** Where the build's look at a claim lands among the run's frames (`director/<label>`). */
const FINISH_LOOK_LABEL = "finish";
/** The demos the build's look at a claim plays at most: it shares the observers' window. */
const FINISH_LOOK_DEMOS = 3;

/**
 * What the lead's `finish` call brings beside its arguments: when it started, the finish moment's
 * notes and pictures, and how it waits for its close (a test may drive it; a real timer without).
 */
export interface FinishCall {
  started?: number;
  notes?: readonly string[];
  images?: readonly HookImage[];
  wait?: (ms: number) => Promise<void>;
}

/** The call the lead's `finish` hands on, from when it started and what the finish moment said. */
export function finishCallOf(started: number, held: Pick<HookReport, "notes" | "images">): FinishCall {
  return { started, notes: held.notes.map((note) => note.text), images: held.images };
}

/**
 * How a claim comes out: the close (a victory or not, with its words, what isn't done when not, and
 * what the lead is told before the landing when not), or an answer while the run goes on.
 */
export type ClaimVerdict =
  | {
      close: true;
      victory: boolean;
      because?: string;
      summary?: string;
      notDone?: string[];
      told?: string;
      /** Why the run stops short of its goal, for its result card. */
      why?: StopWhy;
    }
  | { close: false; answer: string };

/** When the lead's `finish` call must have its answer: the call ends then, less the answer's trip. */
export function claimAnswerBy(callStarted: number): number {
  return callStarted + LEAD_CALL_MS - CALL_MARGIN_MS;
}

/** When the close's judge after a claim must be done: before the call's answer, leaving the landing its time. */
export function claimJudgeBy(callStarted: number): number {
  return claimAnswerBy(callStarted) - CLAIM_LANDING_MS;
}

/**
 * The close's landing when it ends by `by`, else null: the close goes on after the call (the
 * harness's own close of the run waits for it), and the lead is answered that the run is closing.
 */
export async function closedBy(
  close: Promise<AnyRecord>,
  by: number,
  wait: (ms: number) => Promise<void> = realWait,
  now: () => number = Date.now,
): Promise<AnyRecord | null> {
  let late = false;
  const timer = wait(Math.max(0, by - now())).then(() => {
    late = true;
    return null;
  });
  const landed = await Promise.race([close, timer]);
  // A close left behind may still fail: the harness's own close of the run tries again.
  if (late) close.catch(() => {});
  return landed;
}

/** A real wait of `ms`, which keeps no process alive. */
function realWait(ms: number): Promise<void> {
  return delay(ms, undefined, { ref: false });
}

/**
 * What a yes still needs of the call: the settle and the readers' stop; with a landing, the close's
 * look, the judge when the head still owes one (none when the art director's gate already answered
 * it) and the landing itself.
 */
function closeMsOf(loopRun: LoopRun, land: boolean): number {
  if (!land) return CLOSE_SETTLE_MS + CLOSE_READERS_MS;
  const owed =
    typeof loopRun.closeJudgeAsk === "function" ? loopRun.closeJudgeAsk(loopRun.state.integrationHead) : true;
  return owed ? CLAIM_CLOSE_MAX_MS : CLAIM_CLOSE_MAX_MS - CLAIM_JUDGE_MS;
}

/** Whether the run is closing or closed: a check under way then records no answer. */
const closing = (loopRun: LoopRun): boolean =>
  Boolean(loopRun.state.finish || loopRun.state.finished) || closeUnderWay(loopRun.state);

/** The proof files each run's claims named that git does not track: kept out of the build, by the run's state. */
const PROOF_OUT = new WeakMap<object, string[]>();

/**
 * Keep the files a claim names as proof out of the build when git does not track them: a test
 * report or a picture the lead wrote to prove its claim is evidence for the reviewer, not part of
 * the game the close lands (integrate.ts commits around them). Files the build tracks stay in it.
 */
export async function keepProofOut(loopRun: LoopRun, names: readonly unknown[]): Promise<void> {
  const { ctx, integrationWorktree, run, state } = loopRun;
  const out = new Set(PROOF_OUT.get(state) ?? []);
  for (const rel of await proofPathsIn(integrationWorktree, names)) {
    const label = `director:${run.runId}:proof-status`;
    const status = await gitAt(ctx, integrationWorktree, GIT_WITHOUT_PROOF.untracked(rel), { label }).catch(() => "");
    if (String(status).startsWith("??")) out.add(rel);
  }
  PROOF_OUT.set(state, [...out]);
}

/** The proof files the run's claims keep out of its build (`keepProofOut`). */
export function proofKeptOut(state: object): readonly string[] {
  return PROOF_OUT.get(state) ?? [];
}

/** The build's look for the reviewer: the integration worktree's folder at `at`, in a window the run may borrow. */
function finishLook(loopRun: LoopRun, at: string): Promise<Evidence> {
  const { evidenceOf, integrationWorktree, run, withLease } = loopRun;
  const root = at === FACT_ROOT ? integrationWorktree : path.join(integrationWorktree, at);
  const options = {
    label: FINISH_LOOK_LABEL,
    motion: RECORDING_FRAMES,
    maxDemos: FINISH_LOOK_DEMOS,
    setup: run.setup ?? null,
  };
  return withLease(WindowLease.Judge, (handle: string | null) => evidenceOf(root, { ...options, handle }), {
    borrow: true,
  });
}

/**
 * The run's finish checks so far, kept in its journal (the raw journal's count when a kept older
 * journal.ts restored none), numbered past every round its log holds: a round's number never
 * repeats, whatever kept the count.
 */
function tallyFor(loopRun: LoopRun, lastRound: number): FinishTally {
  loopRun.state.finishTally ??= savedTally(loopRun.journal?.director?.finishTally);
  const tally = loopRun.state.finishTally;
  tally.round = Math.max(tally.round, lastRound);
  return tally;
}

/** The lead's summary, and what the reviewer's last no found not done after it, when it found any. */
const withNotDone = (summary: string, notDone: readonly string[]): string =>
  notDone.length ? `${summary}\n\n${FINISH_REPORT.summaryNotDone(notDone)}` : summary;

/**
 * The lead's turn the claim is in: as wake.ts noted it, else (a kept older wake loop notes none) the
 * run's own working deadline, or its end once that passed; none for a run that has neither.
 */
function turnOf(loopRun: LoopRun): Partial<TurnEnds> {
  const noted = turnEndsOf(loopRun.state);
  if (noted) return noted;
  const { finalDeadline, softDeadline } = loopRun;
  if (!Number.isFinite(softDeadline)) return {};
  const last = Date.now() >= softDeadline;
  const endsBy = last ? finalDeadline : softDeadline;
  return Number.isFinite(endsBy) ? { endsBy, last } : {};
}

/**
 * A claim with no time for a review: not counted while a later turn comes (its call again, or the
 * wrap-up); in the run's last turn, the run closes as no claim, the time having run out.
 */
function noTimeVerdict(outcome: NoTime, claim: ClaimContext): ClaimVerdict {
  if (!outcome.turnEnds) return { close: false, answer: finishAnswer(outcome) };
  if (!claim.lastTurn) return { close: false, answer: CLAIM_ANSWER.noTimeInTurn };
  const notDone = notDoneOf(claim.tally);
  return {
    close: true,
    victory: false,
    because: FINISH_REPORT.tooLate,
    summary: withNotDone(claim.summary, notDone),
    ...(notDone.length ? { notDone } : {}),
    told: CLAIM_ANSWER.tooLate,
    why: StopWhy.Time,
  };
}

/** What a verdict reads besides the check's outcome: the lead's summary, whether its turn is the last, and the tally. */
interface ClaimContext {
  summary: string;
  lastTurn: boolean;
  tally: FinishTally;
}

/**
 * What a check came to for the close: a yes and the stopping no close the run; no reviewer closes it
 * as no claim; no time is not counted, and the lead calls again (in the last turn the run closes as
 * no claim); a yes for a head that moved neither. A close without a yes tells the lead why.
 */
function verdictOf(outcome: FinishOutcome, claim: ClaimContext): ClaimVerdict {
  if ("noTime" in outcome) return noTimeVerdict(outcome, claim);
  if (outcome.step === FinishCheckStep.Accepted) return { close: true, victory: true };
  if (outcome.step === FinishCheckStep.Unanswered && outcome.lapsed)
    return { close: false, answer: CLAIM_ANSWER.moved };
  if (outcome.step === FinishCheckStep.Unanswered && outcome.seatless)
    return { close: true, victory: false, because: FINISH_REPORT.noReviewer, told: CLAIM_ANSWER.noReviewer };
  if (outcome.step !== FinishCheckStep.Rejected || !outcome.stop)
    return { close: false, answer: finishAnswer(outcome) };
  const notDone = notDoneOf(outcome);
  return {
    close: true,
    victory: false,
    because: FINISH_REPORT.notAccepted,
    summary: withNotDone(claim.summary, notDone),
    notDone,
    told: CLAIM_ANSWER.stopped(outcome),
    why: StopWhy.Stuck,
  };
}

/** Why a yes no longer speaks for the head the reviewer read (`head`, when the caller named it), or null. */
async function headMoved(loopRun: LoopRun, head: string | null | undefined): Promise<string | null> {
  if (head === undefined) return null;
  return (await loopRun.syncHead()) === head ? null : MOVED_WHY;
}

/**
 * Check the lead's claim (the module's header) on the head the close would land (`head`, the one the
 * reviewer reads), from the call's start, within the lead's turn. A run that closed while the
 * reviewer read (the clock's own close) answers that it did.
 */
export async function checkClaim(
  loopRun: LoopRun,
  claim: { summary: string; args: AnyRecord; call: FinishCall; land?: boolean; head?: string | null },
): Promise<ClaimVerdict> {
  const { ctx, inbox, integrationWorktree, projectDir, run, threadId } = loopRun;
  const { summary, args, call } = claim;
  const turn = turnOf(loopRun);
  const log = await readFinishLog(ctx, threadId, run.runId, await inbox.steering(undefined, false));
  const tally = tallyFor(loopRun, log.lastRound);
  const outcome = await checkFinish(
    {
      ctx,
      run,
      threadId,
      game: { name: run.project, dir: projectDir, facts: loopRun.gameFacts },
      leadFolder: integrationWorktree,
      tally,
      now: Date.now,
      callStarted: call.started ?? Date.now(),
      closeMs: closeMsOf(loopRun, claim.land !== false),
      ...(turn.endsBy === undefined ? {} : { endsBy: turn.endsBy }),
      said: log.said,
      relayed: log.relayed,
      previewPass: (at) => finishLook(loopRun, at),
      ended: () => closing(loopRun),
      lapsed: () => headMoved(loopRun, claim.head),
      timeLeft: () => timeLeftOf(run, loopRun.softDeadline, Date.now()),
      workMark: async () => (await loopRun.currentHead().catch(() => null)) ?? null,
      keep: () => loopRun.saveJournal(),
    },
    { summary, proof: list(args.proof), hookNotes: call.notes ?? [], hookImages: call.images ?? [] },
  );
  await loopRun.saveJournal().catch(() => {});
  if (closing(loopRun)) return { close: false, answer: CLAIM_ANSWER.alreadyClosed };
  return verdictOf(outcome, { summary, lastTurn: turn.last === true, tally });
}
