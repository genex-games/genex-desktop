/**
 * What a lead hears now that a reviewer is a second opinion it asks for, never a gate: a reviewer's
 * no that decides nothing, and a claim that closed on the lead's word.
 */

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
