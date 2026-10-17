/**
 * Which part draws the HUD, and so answers for its layout (`HUD_LAYOUT_CHECKS`): a new module, so a
 * kept older workers.ts or screen-owner.ts never hides it from the other.
 */
import { SCREEN_CRITIC, type ScreenSpec } from "../screen-owner.ts";

/** A part as the HUD rule reads it: its critic, whether it owns the entry, and the part it restarts. */
interface HudPart {
  critic: string | null;
  ownsMain: boolean;
  replaces: string | null;
}

/** Does `spec` own the screen. */
const ownsScreen = (spec: ScreenSpec): boolean => spec.ownsScreen === true;

/**
 * Does this part draw the HUD: it is the screen's owner (critic=screen), or a restart of the part
 * that owned it (screen-owner.ts `linkScreenOwner` makes it the owner), or it owns the entry while
 * no part of the run owns the screen — finished ones too, as `linkScreenOwner` names them, so a part
 * is never held to a layout the screen rule forbids it to change.
 */
export function drawsTheHud(part: HudPart, specs: readonly ScreenSpec[]): boolean {
  if (part.critic === SCREEN_CRITIC) return true;
  const restartsOwner = specs.some((spec) => spec.id === part.replaces && ownsScreen(spec));
  if (part.replaces && restartsOwner) return true;
  return part.ownsMain && !specs.some(ownsScreen);
}
