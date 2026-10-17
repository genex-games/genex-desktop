/**
 * Why a claim is refused while the art director names a blocker on its head (integrate.ts
 * `finishRefusal`): a goal ends once its outcomes are verified and nothing blocks. A new module, so
 * a kept older art-direction-prompts.ts never hides it.
 */
import { blockersOf } from "../ship-blockers.ts";
import { defectsByPart } from "./art-direction-prompts.ts";
import type { ShipDefect } from "../ship-review.ts";

/** Why a claim that the goal is reached is refused while the art director's look at its head names a blocker. */
export function shipClaimRefusal(review: { defects: readonly ShipDefect[] }): string {
  const groups = Object.entries(defectsByPart(blockersOf(review.defects))).map(
    ([part, lines]) => `${part}: ${lines.join(" | ")}`,
  );
  return `finish cannot claim victory: the art director names blockers on this build — ${groups.join("; ")}. Have their owners fix them, integrate and judge ship=yes again, or finish with victory=no and say what is left.`;
}
