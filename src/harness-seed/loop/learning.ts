import type { HarnessCtx } from "../types/harness.d.ts";
import { HostMethod } from "./host-methods.ts";

/**
 * The user's Self-improvement switch, in Studio's header. Off means Studio learns nothing: no
 * learning pass after a run, no lessons for a game's next run, no recipe or check-catalogue
 * statistics, no suggestions. What happened is still written down — the log and each game's
 * ledger are records, not changes — so turning it back on learns from everything since.
 *
 * Asked at the moment of each change, so a switch flipped during a run holds from then on. An
 * older host that has no switch answers with an unknown-method error, and learning stays on.
 */
export async function learningOn(ctx: HarnessCtx) {
  try {
    return (await ctx.call(HostMethod.LearningEnabled, {})) !== false;
  } catch {
    return true;
  }
}
