/**
 * The traces whose goal the studio itself saw reached. A computer session that checks a quest after
 * every move tells this registry the trace that shows it; when the harness — agent-editable code —
 * records an interaction as `studio-verified`, the host keeps that word only for a trace listed here
 * (`harness-events.ts` `vouchedInteractions`). Anything else is recorded as the model's word.
 */

/** How many verified traces are remembered; the oldest is forgotten first. */
const MAX_VERIFIED_TRACES = 2_000;

const verified = new Set<string>();

/** The studio saw this trace's goal reached. */
export function markVerified(tracePath: string): void {
  if (verified.size >= MAX_VERIFIED_TRACES) {
    const oldest = verified.values().next().value;
    if (oldest !== undefined) verified.delete(oldest);
  }
  verified.add(tracePath);
}

/** Did the studio itself see this trace's goal reached? */
export function isVerified(tracePath: unknown): boolean {
  return typeof tracePath === "string" && verified.has(tracePath);
}
