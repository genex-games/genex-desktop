/**
 * The HUD's own layout checks (spec.ts `HARNESS_CHECKS` ids): only the part that draws the HUD is
 * held to them (spec.ts `withHarnessChecks`, screen-owner.ts `linkScreenOwner`). A new module with
 * no imports, so a kept older sibling never hides it.
 */
export const HUD_LAYOUT_CHECKS: readonly string[] = ["hud-coverage", "hud-overlap"];
