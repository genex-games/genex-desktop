/**
 * The turns in the builder's own session after its build turn — the review's fix, a regression's
 * revert — and the steer that interrupts any of its turns. Nobody asked the round to stop, so a
 * steer is handed over in front of everything and the same session carries on.
 */
import { StopReason } from "../outage.ts";
import { RunEvent } from "../run-events.ts";
import { CLIP_REASON } from "../text.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "./state.ts";
import { FOLLOWUP_MS } from "./policy.ts";
import { steerPrompt } from "./prompt.ts";
import { roundFields } from "./record.ts";

/** How many steers in a row one follow-up turn is resumed for; past them a stop ends the round. */
const MAX_STEERED_FOLLOW_UPS = 3;

/**
 * Steering that could not wait: somebody interrupted this turn to hand the builder an
 * instruction. Nobody has asked it to stop, so this is not the end of the round — the steer goes
 * in front of everything and the same session carries on. Null when this was no steer.
 */
export async function steerThatArrived(
  loop: FacetLoop,
  round: FacetRound,
  delegation: AnyRecord,
): Promise<unknown[] | null> {
  const { appendRun, ctx, finishRequested, steering } = loop;
  if (delegation.stopReason !== StopReason.Stopped) return null;
  if (await finishRequested(loop.iterationsThisRound).catch(() => false)) return null;
  const arrived = (await steering()).filter(Boolean);
  // The stop may have landed while that was in flight: a user's stop aborts the turn
  // the same way a steer does, and it must never be answered with another one.
  if (!arrived.length || ctx.cancelled) return null;
  round.userSteering.push(...arrived);
  await appendRun(RunEvent.FacetSteered, {
    ...roundFields(loop, round.iteration),
    texts: arrived.map((t: unknown) => String(t).slice(0, CLIP_REASON)),
    delivered: "mid-round",
  });
  return arrived;
}

/**
 * One follow-up turn in the builder's session. A steer that interrupts it is handed over and the
 * session goes on; a stop with no steer waiting ends the round where it stands (the stopped round's
 * commit and ref). Answers whether the round stopped.
 */
export async function followUpTurn(loop: FacetLoop, round: FacetRound, prompt: string): Promise<boolean> {
  let ask: string | null = prompt;
  let steers = 0;
  while (ask !== null) {
    const turn: AnyRecord = await round.delegate(ask, loop.sessionId, FOLLOWUP_MS);
    if (turn.sessionId) loop.sessionId = turn.sessionId;
    if (turn.ok !== false || turn.stopReason !== StopReason.Stopped) return false;
    const arrived: unknown[] | null =
      steers < MAX_STEERED_FOLLOW_UPS ? await steerThatArrived(loop, round, turn) : null;
    steers += 1;
    ask = arrived ? steerPrompt(arrived) : null;
  }
  await loop.stoppedHere(round.iteration, true);
  return true;
}
