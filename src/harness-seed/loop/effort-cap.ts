/**
 * How hard each role thinks against the user's one effort setting: the lead at it, a worker and a
 * reviewer at most high, and a fixed effort (a bounded job's, a critic's) never above a lower one
 * the user chose. A new module with no imports, so a kept older model-roles.ts never hides it; the
 * app's copy is shared/model-roles.ts `roleEffortCap`, held to this one by seed-contracts.test.ts.
 */

/** Every effort an engine names, from least to most thinking (shared/model-preferences.ts `ReasoningEffort`). */
export const EFFORT_ORDER: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * The most a worker or a reviewer thinks. Deeper thinking fills a round's context with tokens
 * nobody reads, paid again on every later call, and outlasts a reviewer's few minutes; the lead
 * plans at the user's own setting.
 */
export const WORKER_EFFORT_CEILING = "high";

/**
 * The effort a role runs at for the user's `effort`: the lead's (`lead`) as set; a worker's or a
 * reviewer's at most `WORKER_EFFORT_CEILING`, so a lower setting is every role's. A level no engine
 * names is left as it is.
 */
export function effortCap(effort: string | undefined, lead: boolean): string | undefined {
  if (effort === undefined || lead) return effort;
  return EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(WORKER_EFFORT_CEILING) ? WORKER_EFFORT_CEILING : effort;
}

/**
 * A fixed effort (a bounded job's, a critic's) held to the user's choice: the lower of the two, or
 * the fixed one when they chose none, or a level no engine names.
 */
export function boundedEffort(fixed: string, chosen: string | undefined): string {
  if (chosen === undefined) return fixed;
  const at = EFFORT_ORDER.indexOf(chosen);
  return at >= 0 && at < EFFORT_ORDER.indexOf(fixed) ? chosen : fixed;
}
