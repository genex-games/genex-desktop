/**
 * A builder's session is rotated every few rounds. Gen3's builders each ran one uncompacted
 * session to 815-833k tokens of context with about two hundred images, and two of them stopped on
 * the weekly limit: every round re-read everything the session had ever seen. A fresh session is
 * given the whole prompt again (brief, board, lessons, the attempt record), so nothing it needs is
 * lost, and what it no longer needs is no longer paid for.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { RunEvent } from "../run-events.ts";
import type { FacetLoop } from "./state.ts";
import { roundFields } from "./record.ts";

/** The rounds one builder session carries before the next round starts a fresh one. */
export const SESSION_ROUNDS = 3;

/** Why a session was rotated, as the reset event says it. */
const ROTATED = `rotated after ${SESSION_ROUNDS} rounds: a fresh session keeps the builder's context small`;

/** Counts a round the builder's session carried. */
export function noteSessionRound(loop: FacetLoop): void {
  if (loop.sessionId) loop.sessionRounds = (loop.sessionRounds ?? 0) + 1;
}

/**
 * Before a round's prompt is written: a session that has carried `SESSION_ROUNDS` rounds is let go,
 * so the round is briefed whole in a fresh one. Answers whether it rotated.
 */
export async function rotateSession(loop: FacetLoop, iteration: number): Promise<boolean> {
  if (!loop.sessionId || (loop.sessionRounds ?? 0) < SESSION_ROUNDS) return false;
  await loop.appendRun(RunEvent.FacetSessionReset, { ...roundFields(loop, iteration), reason: ROTATED });
  loop.sessionId = null;
  loop.sessionRounds = 0;
  return true;
}
