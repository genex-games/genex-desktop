/**
 * What a run says when `game.upgradeContract` kept the game's own edited `src/studio.js` instead
 * of replacing it: the template asks the main owner to extend that file, so the host leaves an
 * edited copy (and the HUD beside it) at its older generation and answers `edited`. The lead and
 * the person hear it once, at the start, so nobody builds on HUD calls the kept facade lacks.
 */
import type { HarnessResult } from "../types/host-api.d.ts";

/** The first contract generation whose HUD facade forwards arc, panel, path, image and font. */
const DRAWING_FACADE_GENERATION = 5;

const MESSAGE = {
  record: (generation: number) =>
    `kept src/studio.js as it is: an edited copy of contract generation ${generation}, older than the template's, so the upgrade replaced neither it nor src/hud.js and the game's own additions keep working`,
  olderFacade:
    "its __studio.hud facade has no arc, panel, path, image or font: draw with the calls it has, or extend the facade in src/studio.js without removing what the game added",
  plain: "kept the game's own edited connection to the studio as it is; newer HUD drawing calls may be missing",
} as const;

/** The record and the plain sentence for a contract the upgrade kept; null for any other answer. */
export function keptContractWords(
  upgraded: HarnessResult<"game.upgradeContract"> | null | undefined,
): { record: string; plain: string } | null {
  if (upgraded?.edited !== true || typeof upgraded.generation !== "number") return null;
  const { generation } = upgraded;
  const facade = generation < DRAWING_FACADE_GENERATION ? `; ${MESSAGE.olderFacade}` : "";
  return { record: `${MESSAGE.record(generation)}${facade}`, plain: MESSAGE.plain };
}
