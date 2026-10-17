/**
 * The traces whose goal the studio itself saw reached, and which goal. A computer session that
 * checks a quest after every move tells this registry the trace that shows it; when the harness —
 * agent-editable code — records an interaction as `studio-verified`, the host keeps that word only
 * for a trace listed here, once: one goal the studio saw vouches for one record, which then names
 * that goal (`harness-events.ts` `vouchedInteractions`). Anything else is recorded as the model's word.
 */

/** How many verified traces are remembered; the oldest is forgotten first. */
const MAX_VERIFIED_TRACES = 2_000;

const verified = new Map<string, string>();

/** The studio saw this trace reach the goal `questId`. */
export function markVerified(tracePath: string, questId: string): void {
  if (verified.size >= MAX_VERIFIED_TRACES) {
    const oldest = verified.values().next().value;
    if (oldest !== undefined) verified.delete(oldest);
  }
  verified.set(tracePath, questId);
}

/** Did the studio itself see this trace's goal reached? */
export function isVerified(tracePath: unknown): boolean {
  return typeof tracePath === "string" && verified.has(tracePath);
}

/** The goal this trace showed reached, taken: a trace vouches for one record only. Null when it showed none. */
export function takeVerified(tracePath: unknown): string | null {
  if (typeof tracePath !== "string") return null;
  const questId = verified.get(tracePath) ?? null;
  verified.delete(tracePath);
  return questId;
}
