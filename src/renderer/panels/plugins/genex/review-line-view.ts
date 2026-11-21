/**
 * The sidebar's second line under a game on Genex as drawn: its words, its small mark before them (a
 * globe for Public, a clock while it waits on a review, the warning triangle for a problem), its tone
 * (Not approved and Taken down in orange, the rest grey) and whether it carries the working dot
 * (Fixing) in the mark's place. Pure: the row only draws it, tests read it.
 */
import { type GenexSidebarEntry, GenexSidebarLine } from "../../../../shared/genex-review.ts";
import type { IconName } from "../../../ui/icons.tsx";
import { REVIEW_WORDS } from "../../../words.ts";

/** How a line reads. Display only: the `data-review-tone` value. */
export const ReviewLineTone = { Warn: "warn", Quiet: "quiet" } as const;
export type ReviewLineTone = (typeof ReviewLineTone)[keyof typeof ReviewLineTone];

/** The line as the row draws it. */
export interface ReviewLineView {
  line: GenexSidebarLine;
  text: string;
  tone: ReviewLineTone;
  /** The mark before the words; null while the working dot stands there. */
  icon: IconName | null;
  /** The agent works on the game's fix: the line carries the working dot. */
  busy: boolean;
}

const TONE: Record<GenexSidebarLine, ReviewLineTone> = {
  [GenexSidebarLine.Public]: ReviewLineTone.Quiet,
  [GenexSidebarLine.InReview]: ReviewLineTone.Quiet,
  [GenexSidebarLine.HumanReview]: ReviewLineTone.Quiet,
  [GenexSidebarLine.NotApproved]: ReviewLineTone.Warn,
  [GenexSidebarLine.TakenDown]: ReviewLineTone.Warn,
  [GenexSidebarLine.Fixing]: ReviewLineTone.Quiet,
  [GenexSidebarLine.CheckingFixes]: ReviewLineTone.Quiet,
};

/** Each line's mark; Fixing has none, the working dot takes its place. */
const ICON: Record<GenexSidebarLine, IconName | null> = {
  [GenexSidebarLine.Public]: "globe",
  [GenexSidebarLine.InReview]: "clock",
  [GenexSidebarLine.HumanReview]: "clock",
  [GenexSidebarLine.NotApproved]: "warning",
  [GenexSidebarLine.TakenDown]: "warning",
  [GenexSidebarLine.Fixing]: null,
  [GenexSidebarLine.CheckingFixes]: "clock",
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
    icon: ICON[entry.line],
    busy: entry.line === GenexSidebarLine.Fixing,
  };
}
