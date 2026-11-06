/**
 * The sidebar's second line under a game on Genex (mockup C1) as drawn: its words, its tone (Public in
 * green, Not approved and Taken down in red, the rest quiet) and whether it carries the working dot
 * (Fixing). Pure: the row only draws it, tests read it.
 */
import { type GenexSidebarEntry, GenexSidebarLine } from "../../../../shared/genex-review.ts";
import { REVIEW_WORDS } from "../../../words.ts";

/** How a line reads. Display only: the `data-review-tone` value. */
export const ReviewLineTone = { Ok: "ok", Error: "err", Quiet: "quiet" } as const;
export type ReviewLineTone = (typeof ReviewLineTone)[keyof typeof ReviewLineTone];

/** The line as the row draws it. */
export interface ReviewLineView {
  line: GenexSidebarLine;
  text: string;
  tone: ReviewLineTone;
  /** The agent works on the game's fix: the line carries the working dot. */
  busy: boolean;
}

const TONE: Record<GenexSidebarLine, ReviewLineTone> = {
  [GenexSidebarLine.Public]: ReviewLineTone.Ok,
  [GenexSidebarLine.InReview]: ReviewLineTone.Quiet,
  [GenexSidebarLine.HumanReview]: ReviewLineTone.Quiet,
  [GenexSidebarLine.NotApproved]: ReviewLineTone.Error,
  [GenexSidebarLine.TakenDown]: ReviewLineTone.Error,
  [GenexSidebarLine.Fixing]: ReviewLineTone.Quiet,
  [GenexSidebarLine.CheckingFixes]: ReviewLineTone.Quiet,
};

/** The line's words. */
function lineText(entry: GenexSidebarEntry): string {
  const words = REVIEW_WORDS.sidebar;
  if (entry.line === GenexSidebarLine.Fixing) return words.fixing(entry.things ?? 0);
  return words[entry.line];
}

/** The line under a game's name; null for a game with none (or a line this build does not know). */
export function reviewLineView(entry: GenexSidebarEntry | undefined): ReviewLineView | null {
  if (!entry || !Object.hasOwn(TONE, entry.line)) return null;
  return {
    line: entry.line,
    text: lineText(entry),
    tone: TONE[entry.line],
    busy: entry.line === GenexSidebarLine.Fixing,
  };
}
