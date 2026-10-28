/**
 * Budgets said per destination. Gen3 was a native desktop game judged through its web preview: a
 * 15 s web boot gate and a phone-sized memory note pushed its builders to 1k and 256 px scans with
 * no normal or ORM maps, and its director capped textures at 1k to protect a boot no player of the
 * desktop build would ever wait through. The web preview's boot is how Genex looks at a native
 * game, not the game's own budget; a budget is met by deferring asset groups, never by dropping maps.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { asksForLook } from "./look-bar.ts";
import { BuildTarget } from "./native-contract.ts";
import { MINUTE_MS, SECOND_MS } from "./time.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";

/** The boot a run with a visual bar asks its builders to declare in studio.json (`bootMs`): 2k/4k scans load in it. */
export const LOOK_BAR_BOOT_MS = 45 * SECOND_MS;
/** The most the studio waits for a boot, whatever studio.json says (substrate/preview-ready.ts `BOOT_MS_MAX`). */
export const BOOT_MS_MAX = MINUTE_MS;

/** The destinations a run's game ships to, when it names any. */
const targetsOf = (run: AnyRecord | null | undefined): string[] => {
  const targets = (run?.destinations as { targets?: unknown } | undefined)?.targets;
  return Array.isArray(targets) ? targets.map(String) : [];
};

/** Is the web build only how Genex looks at this game: it names destinations, and the browser is not one. */
export function webJudgesOnly(run: AnyRecord | null | undefined): boolean {
  const targets = targetsOf(run);
  return targets.length > 0 && !targets.includes(BuildTarget.Web);
}

/** The rule every judge and the director reads: a budget never becomes a cut to the look. */
export const BUDGETS_NEVER_CUT_MAPS =
  "A boot, memory or texture budget is met by deferring what the first playable frame does not need into [[asset_group]]s that stream after it, never by dropping normal or ORM maps, shrinking near surfaces below 2k, sharing one GLB for different props or cutting lights. Never ask for any of those to save boot or memory.";

/**
 * The slow-boot warning for a look that took `ms` to report itself ready, worded for the game's
 * destinations: a native game's web preview boot is the preview's, not the player's.
 */
export function slowBootWarning(ms: number, run: AnyRecord | null | undefined): string {
  const seconds = (ms / SECOND_MS).toFixed(1);
  if (webJudgesOnly(run))
    return `the web preview Genex judges this native game through took ${seconds} s to report itself ready — that is the preview's boot, not the desktop build's budget: keep full-resolution maps and stream what the first playable frame does not need in [[asset_group]]s`;
  return `the page took ${seconds} s to report itself ready — every pass of the run pays that boot; defer what the first playable frame does not need into [[asset_group]]s rather than cutting maps`;
}

/**
 * The boot line a builder of a run with a visual bar reads: declare the longer boot in studio.json
 * and stream the rest, so the look is never cut to fit the default. Empty for any other run.
 */
export function bootBudgetLine(run: Pick<Run, "goal" | "reference"> & { asks?: unknown }): string {
  if (!asksForLook(run)) return "";
  return `BOOT: this look loads 2k and 4k scans. Set "bootMs": ${LOOK_BAR_BOOT_MS} in studio.json (at most ${BOOT_MS_MAX}); the game is ready on its first playable frame, so put what that frame does not need in [[asset_group]]s and stream them after it. ${BUDGETS_NEVER_CUT_MAPS}`;
}
