/**
 * The Unreal lead's `finish`: its word that the game meets the request. Genex's finish moment runs
 * first (a plugin may hold the finish back: the lead hears why and keeps working); then, only when the
 * lead asks for one, a reviewer that did none of the work gives a second opinion (`../finish-check.ts`):
 * its yes closes the run, its no comes back with its reasons and decides nothing. A finish the person
 * asked for needs no claim: the run ends as theirs.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { checkFinish, type FinishClaim, type FinishOutcome, type FinishTally, newTally } from "../finish-check.ts";
import { FinishCheckStep } from "../finish-contract.ts";
import { yes } from "../director/args.ts";
import { secondOpinionNo } from "../director/second-opinion-prompts.ts";
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

/** Whether the turn that made the claim is over (the run may go on): its check then records no answer and ends nothing. */
const turnOver = (lead: FinishingLead, turn: LeadTurn | null): boolean => turn?.over === true || lead.turn !== turn;

/** Whether the claim's run ended, or the turn that made it is over: nothing more is ended by its check. */
const overFor = (lead: FinishingLead, turn: LeadTurn | null): boolean => Boolean(lead.end) || turnOver(lead, turn);

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
 * `finish`: Genex's finish moment, then — only when the lead asks (`review=yes`) — a reviewer's
 * second opinion. The lead's word ends the run; a reviewer's no comes back with its reasons and
 * decides nothing, and the run goes on until the lead calls finish again.
 */
export async function leadFinish(lead: FinishingLead, args: AnyRecord): Promise<string> {
  const callStarted = lead.clock.now();
  const turn = lead.turn;
  if (lead.end) return LEAD_FINISH.Ending;
  if (await personFinishes(lead)) return LEAD_FINISH.PersonFinished;
  if (!hasText(args.summary)) return LEAD_FINISH.NeedsSummary;
  const held = await fireHooks(lead.ctx, lead.game, HookEvent.Finish, runScope(lead));
  if (held.blocked) return HOOK_PROMPTS.finishHeld(held.blocked.reason);
  if (yes(args.review, false)) {
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
    const said = reviewerSaid(outcome);
    if (said) return said;
  }
  lead.end ??= { status: ExecutionStatus.Completed, reason: LeadEndReason.GoalReached, why: null };
  await endTurn(lead);
  return LEAD_FINISH.Accepted;
}

/** What a review the lead asked for said, when it did not say yes: its no (deciding nothing), or that none came; null on a yes. */
function reviewerSaid(outcome: FinishOutcome): string | null {
  if ("noTime" in outcome) return LEAD_FINISH.NoReview;
  if (outcome.step === FinishCheckStep.Accepted) return null;
  if (outcome.step === FinishCheckStep.Rejected) return secondOpinionNo(outcome.reasons, outcome.notDone);
  return LEAD_FINISH.NoReview;
}
