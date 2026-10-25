/**
 * The Unreal lead's `finish`: its claim that the game meets the request. Genex's finish moment runs
 * first (a plugin may hold the finish back: the lead hears why and keeps working); then a reviewer
 * that did none of the work checks the claim (`../finish-check.ts`). A yes ends the run as the goal
 * reached; a no comes back with its reasons; the no's that stop a Loop end it with what isn't done.
 * The critic stays advisory: its open items never stand between the lead and the reviewer. A finish
 * the person asked for needs no claim: the run ends as theirs. A check whose turn ends under it
 * records no answer, and its reviewer is stopped; one whose run ends records nothing more. A claim no
 * engine here can hold a reviewer for ends the run without a yes, as the director's does: no retry
 * could be answered.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import {
  checkFinish,
  FINISH_REPORT,
  type FinishClaim,
  type FinishOutcome,
  type FinishTally,
  finishAnswer,
  newTally,
  staleClaim,
} from "../finish-check.ts";
import { FINISH_ANSWER } from "../finish-check-prompts.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS } from "../finish-contract.ts";
import { fireHooks, HookEvent, runScope } from "../hooks.ts";
import { HOOK_PROMPTS } from "../hooks-prompts.ts";
import { HostMethod } from "../host-methods.ts";
import { readFinishLog } from "../finish-log.ts";
import { ExecutionStatus } from "../run-events.ts";
import { CLIP_REASON, clipMarked, hasText } from "../text.ts";
import { timeLeftOf } from "../time-cap.ts";
import { LeadEndReason } from "./lead-contract.ts";
import { type Lead, type LeadTurn, saveLead } from "./lead-journal.ts";
import { LEAD_FINISH } from "./lead-finish-prompts.ts";
import type { RunEnd } from "./lead-turn.ts";

/** The lead as `finish` reads it: its run, and how the run ends once a check ends it (the runner's `LeadRun`). */
export type FinishingLead = Lead & { end?: RunEnd | null };

/**
 * What a yes still needs of the lead's `finish` call: nothing. The Unreal run's close (its save,
 * Genex's run end, the workers settled) runs after the lead's turn has ended, outside the call.
 */
const CLOSE_IN_CALL_MS = 0;

/**
 * Ends the lead's turn under way, as lead-turn.ts `abortTurn` does: this module may not import
 * lead-turn.ts, which imports the run tools that answer `finish` from here.
 */
async function endTurn(lead: FinishingLead): Promise<void> {
  await lead.ctx.call(HostMethod.EngineAbort, { cwd: lead.game.dir }).catch(() => {});
}

/** Whether the person asked the run to finish (its inbox's finish request): the run ends as theirs, by lead-turn.ts. */
async function personFinishes(lead: FinishingLead): Promise<boolean> {
  return (await lead.ctx.runInbox?.finishing().catch(() => false)) === true;
}

/** The lead's finish checks so far, kept in its journal. */
function tallyOf(lead: FinishingLead): FinishTally {
  lead.journal.finishTally ??= newTally();
  return lead.journal.finishTally;
}

/** What marks the lead's work: its newest save point ("" before its first). */
const workMarkOf = (lead: FinishingLead): string => lead.journal.savePoints.at(-1)?.snapshotId ?? "";

/** The files the lead names as proof: a comma-separated list. */
const proofOf = (args: AnyRecord): string[] =>
  hasText(args.proof)
    ? args.proof
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];

/**
 * The run's end a check came to: the goal reached, stopped with what isn't done, or ended without a
 * yes when no engine here can hold a reviewer; null when the run goes on.
 */
function endOf(outcome: FinishOutcome): RunEnd | null {
  if ("noTime" in outcome) return null;
  if (outcome.step === FinishCheckStep.Accepted)
    return { status: ExecutionStatus.Completed, reason: LeadEndReason.GoalReached, why: null };
  if (outcome.step === FinishCheckStep.Unanswered && outcome.seatless)
    return { status: ExecutionStatus.Completed, reason: LeadEndReason.NoReviewer, why: FINISH_REPORT.noReviewer };
  if (outcome.step !== FinishCheckStep.Rejected || !outcome.stop) return null;
  return { status: ExecutionStatus.Completed, reason: LeadEndReason.NotDone, why: FINISH_REPORT.notAccepted };
}

/** Whether the turn that made the claim is over (the run may go on): its check then records no answer and ends nothing. */
const turnOver = (lead: FinishingLead, turn: LeadTurn | null): boolean => turn?.over === true || lead.turn !== turn;

/** Whether the claim's run ended, or the turn that made it is over: nothing more is ended by its check. */
const overFor = (lead: FinishingLead, turn: LeadTurn | null): boolean => Boolean(lead.end) || turnOver(lead, turn);

/** Whether the claim's turn is the run's last: it ends at the run's working deadline. */
const lastTurn = (lead: FinishingLead, turn: LeadTurn | null): boolean =>
  turn !== null && turn.deadline >= lead.softDeadline;

/**
 * Ask the reviewer about the lead's claim, on the run's clock (its time and its waits), from the
 * call's start, within the turn that made it (`turn`).
 */
async function check(
  lead: FinishingLead,
  claim: FinishClaim,
  call: { started: number; turn: LeadTurn | null },
): Promise<FinishOutcome> {
  const listed = (await lead.ctx.runInbox?.steering(undefined, false).catch(() => [])) ?? [];
  const log = await readFinishLog(lead.ctx, lead.threadId, lead.run.runId, listed);
  const tally = tallyOf(lead);
  tally.round = Math.max(tally.round, log.lastRound);
  const game = { name: lead.run.project, dir: lead.game.dir, facts: lead.game.facts };
  return checkFinish(
    {
      ctx: lead.ctx,
      run: lead.run,
      threadId: lead.threadId,
      game,
      leadFolder: lead.game.dir,
      tally,
      now: lead.clock.now,
      sleep: (ms) => lead.clock.sleep(ms),
      callStarted: call.started,
      closeMs: CLOSE_IN_CALL_MS,
      ...(call.turn ? { endsBy: call.turn.deadline } : {}),
      said: log.said,
      relayed: log.relayed,
      ended: () => Boolean(lead.end),
      abandoned: () => turnOver(lead, call.turn),
      timeLeft: () => timeLeftOf(lead.run, lead.softDeadline, lead.clock.now()),
      workMark: async () => workMarkOf(lead),
      keep: () => saveLead(lead),
    },
    claim,
  );
}

/**
 * `finish`: Genex's finish moment, then the reviewer. A yes or the stopping no ends the run and the
 * lead's turn; anything else answers the lead and the run goes on (a claim with no time left for a
 * review is no claim).
 */
export async function leadFinish(lead: FinishingLead, args: AnyRecord): Promise<string> {
  const callStarted = lead.clock.now();
  const turn = lead.turn;
  if (lead.end) return LEAD_FINISH.Ending;
  if (await personFinishes(lead)) return LEAD_FINISH.PersonFinished;
  if (!hasText(args.summary)) return LEAD_FINISH.NeedsSummary;
  // Nothing new since the row of no's the run went on past: no plugin step and no reviewer for it.
  if (await staleClaim(tallyOf(lead), lead.game.dir, proofOf(args), workMarkOf(lead)))
    return FINISH_ANSWER.staleProof(MAX_FINISH_REJECTIONS);
  const held = await fireHooks(lead.ctx, lead.game, HookEvent.Finish, runScope(lead));
  if (held.blocked) return HOOK_PROMPTS.finishHeld(held.blocked.reason);
  const claim: FinishClaim = {
    summary: args.summary.trim(),
    proof: proofOf(args),
    hookNotes: held.notes.map((note) => clipMarked(note.text, CLIP_REASON)),
    hookImages: held.images,
  };
  const outcome = await check(lead, claim, { started: callStarted, turn });
  await saveLead(lead).catch(() => {});
  // The run ended (or the turn that claimed did) while the reviewer read: nothing more is ended here.
  if (overFor(lead, turn)) return LEAD_FINISH.Ending;
  // No time in the run's last turn for a review: no retry fits, and the run ends at its time.
  if ("noTime" in outcome && outcome.turnEnds && lastTurn(lead, turn)) return LEAD_FINISH.NoTimeLeft;
  const end = endOf(outcome);
  if (!end) return finishAnswer(outcome);
  lead.end ??= end;
  await endTurn(lead);
  if (end.reason === LeadEndReason.GoalReached) return LEAD_FINISH.Accepted;
  return end.reason === LeadEndReason.NoReviewer ? LEAD_FINISH.NoReviewer : finishAnswer(outcome);
}
