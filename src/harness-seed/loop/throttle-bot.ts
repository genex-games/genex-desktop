/**
 * The throttle-only bot: a race that a bot holding only the throttle can win is no challenge. The
 * evidence pass races it when a board asks (evidence.ts `raceThrottleBot`), and the
 * harness check `throttle-bot-loses` (spec.ts HARNESS_CHECKS) reads the state its race left.
 *
 * A module of its own: a seed upgrade keeps a spec.ts the agent edited, and a name added there would
 * stop every importer linking beside that older copy.
 */
import type { Check } from "./spec.ts";

/**
 * A state a probe may read instead of the drive's (`Check.after`): the one a run the evidence pass
 * makes on its own left behind. Boards keep it: never rename a value.
 */
export const ProbeAfter = {
  /** The race a bot that only holds the throttle drives (evidence.ts `raceThrottleBot`). */
  ThrottleBot: "throttle-bot",
} as const;
export type ProbeAfter = (typeof ProbeAfter)[keyof typeof ProbeAfter];

/** Does a board read the throttle-only bot's race (`after: "throttle-bot"`)? Then its evidence pass races it. */
export function racesThrottleBot(checks: readonly Check[] | null | undefined): boolean {
  return (checks ?? []).some((check) => check?.after === ProbeAfter.ThrottleBot);
}
