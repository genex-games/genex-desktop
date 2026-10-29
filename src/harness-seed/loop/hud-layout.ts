/**
 * The HUD's layout checks, by the ids the harness once forced and a plan may still name: only the
 * part that draws the HUD is held to them (screen-owner.ts `linkScreenOwner`). A new module with
 * no imports, so a kept older sibling never hides it.
 */
export const HUD_LAYOUT_CHECKS: readonly string[] = ["hud-coverage", "hud-overlap"];
