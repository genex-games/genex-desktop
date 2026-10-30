/** One round of the facet loop: its phases, in order. */
import { openRound, rebaselineIncumbent, takeIntegration } from "./phases/gate.ts";
import { applyReplans } from "./phases/replans.ts";
import { spikeHardCheck } from "./phases/spike.ts";
import { chooseRoundMove, nameTheFix } from "./phases/plan.ts";
import { writeBrief } from "./phases/brief.ts";
import { buildChallenger } from "./phases/build.ts";
import { readHarnessFlags } from "./phases/flags.ts";
import { reviewCode } from "./phases/review.ts";
import { gatherRoundEvidence } from "./phases/observe.ts";
import { verifyChallenger } from "./phases/verify.ts";
import { growDefectChecks } from "./phases/learn.ts";
import { keepOrRollBack, measureStyle, rememberAttempt } from "./phases/keep.ts";
import { settleMoveAndGap } from "./phases/settle.ts";
import { decideExit, publishRound } from "./phases/publish.ts";
import type { FacetLoop, FacetRound } from "./state.ts";
import type { RoundFlow } from "./flow.ts";

/**
 * What a round of the facet loop does, in order. Each phase reads and writes the facet's state
 * (`loop`) and this round's (`round`), and answers `RoundFlow.Stop` to end the loop, `RoundFlow.Next` to
 * go on to the next round (or run this one again, when it has put `round.iteration` back), or
 * nothing to hand on to the next phase.
 */
const ROUND_PHASES = [
  openRound,
  takeIntegration,
  rebaselineIncumbent,
  applyReplans,
  spikeHardCheck,
  chooseRoundMove,
  nameTheFix,
  writeBrief,
  buildChallenger,
  readHarnessFlags,
  reviewCode,
  gatherRoundEvidence,
  verifyChallenger,
  growDefectChecks,
  keepOrRollBack,
  measureStyle,
  rememberAttempt,
  settleMoveAndGap,
  publishRound,
  decideExit,
];

/** Play one round: its phases in order, until one of them ends it. */
export async function playRound(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  for (const phase of ROUND_PHASES) {
    const flow = await phase(loop, round);
    if (flow) return flow;
  }
  return null;
}
