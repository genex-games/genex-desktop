/**
 * The cameras a facet's taste judge is shown: the facet's own and the harness's eyes the evidence
 * has. Shared by the taste phase and the verify phase's blind-round check.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import type { FacetLoop, FacetRound } from "./state.ts";

/** The harness's eyes the taste judge looks through beside the facet's own cameras. */
export const TASTE_EYES = ["eye:spawn", "eye:here", "eye:down"];

/** The facet's cameras and the eyes this round's evidence has, once each. */
export function tasteCamerasOf(loop: FacetLoop, round: FacetRound): string[] {
  const eyes = (round.evidence?.eyes ?? []).filter((e: string) => TASTE_EYES.includes(e));
  return [...new Set([...loop.spec.cameras, ...eyes])];
}
