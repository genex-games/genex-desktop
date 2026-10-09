/**
 * A lead's turn a plugin of the game holds back at its start (`turn.start`): never an idle turn.
 * The wake loop asks again after a wait, and the turn runs once nothing holds it; after
 * {@link MAX_HELD_TURNS} asks (or at once, when the run can't wait: its wrap-up, or a run that is
 * over) it gives up with the hold's reason. A module of its own, so the shipped wake loop needs no
 * new name from a module an agent may have kept.
 */
import { MINUTE_MS } from "../time.ts";

/** How long the wake loop waits before it asks a held turn's start again. */
export const HELD_TURN_WAIT_MS = MINUTE_MS;
/** How many times a turn's start is asked before the run stops waiting for it. */
export const MAX_HELD_TURNS = 5;

/** The clock the waits run on: the run's, or a test's. */
export type HoldClock = { sleep: (ms: number) => Promise<void> };

/**
 * Asks `held` (the hold's reason, or null when the turn may start) until the turn may start,
 * waiting {@link HELD_TURN_WAIT_MS} between asks. Answers null once it may, else the last reason
 * after {@link MAX_HELD_TURNS} asks, or as soon as `giveUp` says the run can't wait.
 */
export async function whileTurnHeld(
  held: () => Promise<string | null>,
  clock: HoldClock,
  giveUp: () => boolean,
): Promise<string | null> {
  for (let asked = 1; ; asked += 1) {
    const reason = await held();
    if (reason === null) return null;
    if (asked >= MAX_HELD_TURNS || giveUp()) return reason;
    await clock.sleep(HELD_TURN_WAIT_MS);
  }
}
