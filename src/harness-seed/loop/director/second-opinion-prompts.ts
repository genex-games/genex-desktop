/**
 * What a lead hears now that a judge or a reviewer is a second opinion it asks for, never a gate
 * (Loop phase 4): the finish mark's rule with nobody looking for it, a reviewer's no that decides
 * nothing, and a claim that closed on the lead's word. A new module, so a kept older sibling
 * (art-direction-prompts.ts, finish-check-prompts.ts, open/prompts.ts) never lacks these names.
 */
import { FINISH_MARK_RULE } from "./art-direction-prompts.ts";

/** The heading of the finish mark's paragraph. */
const FINISH_MARK_HEADING = "THE FINISH MARK — the last stretch of this build's working time";

/** The rule at the finish mark, said in the lead's own words: nobody looks at the game for it there. */
const FINISH_MARK_ASK =
  "The art director looks only when you ask: judge ship=yes for its opinion, which decides nothing.";

/** The wake's paragraph at the finish mark: the rule from here on, and that the art director's look is the lead's to ask for. */
export function finishMarkBlock(): string {
  return [FINISH_MARK_HEADING, FINISH_MARK_RULE, FINISH_MARK_ASK].join("\n");
}

/** A reviewer's no, as the lead reads it: its reasons and what isn't done, each once. */
function reviewerNo(reasons: readonly string[], notDone: readonly string[]): string {
  const said = reasons.length ? reasons.join(" ") : "it gave no reason.";
  return notDone.length ? `${said} Not done: ${notDone.join("; ")}.` : said;
}

/** What a lead is told after a review it asked for came back no: a second opinion, which decides nothing. */
export function secondOpinionNo(reasons: readonly string[], notDone: readonly string[] = []): string {
  return `The reviewer you asked did not accept that the goal is reached: ${reviewerNo(reasons, notDone)} Its no decides nothing: work on what it names, or call finish again without review to close the build as you judge it. Say nothing to the person about the reviewer.`;
}

/** What an open Loop's lead is told when its claim closed the Loop, or when no reviewer could read it. */
export const CLAIM_WORDS = {
  /** A claim on the lead's word, with no review asked: the Loop closed. */
  closedOnClaim: "The Loop is closed on your word. End your turn with a one-paragraph summary for the person.",
  /** A review the lead asked for, with no engine here to hold a reviewer. */
  noReviewer:
    "No engine here can hold a reviewer to read your claim. Call finish again without review to close the Loop as you judge it.",
} as const;
