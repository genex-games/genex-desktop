/**
 * The brief a round writes, within BRIEF_MAX_CHARS once the moved sections are in. `renderBrief`
 * fits its own sections; the "Done means" block and the seam rules `briefWithMovedSections`
 * splices in come after, and their size does not depend on the body, so one more render with
 * that much less room is exact. A kept older `renderBrief` ignores `maxChars` and the brief is
 * as long as it always was.
 */
import { renderBrief } from "../library.ts";
import type { BriefOptions } from "../library.ts";
import { BRIEF_MAX_CHARS } from "../brief-budget.ts";
import { briefWithMovedSections } from "./prompt.ts";

/** What `briefWithMovedSections` is told: the spec, who owns the entry, the shape's entry and build. */
export type MovedSectionOptions = Parameters<typeof briefWithMovedSections>[1];

/** The rendered brief (`briefText`) and the brief the builder reads (`brief`), bounded together. */
export function fitBrief(
  input: BriefOptions,
  moved: MovedSectionOptions,
  max = BRIEF_MAX_CHARS,
): { briefText: string; brief: string } {
  const briefText = renderBrief({ ...input, maxChars: max });
  const brief = briefWithMovedSections(briefText, moved);
  if (brief.length <= max) return { briefText, brief };
  const room = Math.max(0, max - (brief.length - briefText.length));
  const refitted = renderBrief({ ...input, maxChars: room });
  return { briefText: refitted, brief: briefWithMovedSections(refitted, moved) };
}
