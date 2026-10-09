/**
 * The art director's do-not-regress list: what already works and must stay. Its own module, not
 * ship-review.ts: a workspace that kept an older ship-review.ts still links the journal that reads it.
 */
import type { AnyRecord } from "../types/harness.d.ts";
import { clipWords } from "./word-clip.ts";

/** The most items one review's do-not-regress list keeps. */
const MAX_DO_NOT_REGRESS = 8;
/** How much of one do-not-regress item is kept: a short name ("rain on the windscreen"), cut at a word. */
const DO_NOT_REGRESS_CHARS = 80;

/**
 * A judge's do-not-regress list as the review keeps it: at most `MAX_DO_NOT_REGRESS` short names,
 * each cut at a word. A rubric the workspace kept from before the list asks for `strengths`, which
 * name what already works too, so those stand in for it.
 */
export function doNotRegressOf(raw: AnyRecord | null | undefined): string[] {
  const named: unknown = Array.isArray(raw?.doNotRegress) ? raw.doNotRegress : raw?.strengths;
  return (Array.isArray(named) ? named : [])
    .map((item: unknown) => clipWords(String(item ?? "").trim(), DO_NOT_REGRESS_CHARS))
    .filter(Boolean)
    .slice(0, MAX_DO_NOT_REGRESS);
}
