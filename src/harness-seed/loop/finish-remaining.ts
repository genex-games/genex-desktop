/**
 * What a lead says is not done yet when it claims the goal (`finish {remaining}`): one item a line,
 * read by the reviewer before the claim and never clipped with it. A module of its own, so the
 * shipped claims need no new name from a `finish-check.ts` an agent may have kept.
 */
import { clipMarked } from "./text.ts";

/** At most this many items of what remains are read, each at most this long. */
const REMAINING_MAX = 24;
const REMAINING_ITEM_CHARS = 600;
/** A list mark a line may open with: a dash, a star, a bullet or a number. */
const LIST_MARK = /^\s*(?:[-*•]|\d+[.)])\s*/;

/** What the lead says is not done yet, as its `finish` sends it: one item per line, list marks dropped. */
export function remainingOf(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split("\n")
    .map((line) => line.replace(LIST_MARK, "").trim())
    .filter(Boolean)
    .slice(0, REMAINING_MAX)
    .map((line) => clipMarked(line, REMAINING_ITEM_CHARS));
}
