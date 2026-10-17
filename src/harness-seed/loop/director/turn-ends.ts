/**
 * When a director's run's lead turn under way ends, and whether it is the run's last (the wrap-up):
 * wake.ts notes it as each turn starts, and a claim made in that turn ends its review before it
 * (finish-claim.ts); a claim the last turn has no time to check closes the run as no claim. Kept
 * per run state in memory, as the turn is. A module of its own with no imports, so the shipped
 * wake.ts needs no new name from a module an agent may have kept.
 */

/** The lead's turn under way: when it ends (`Date.now()` time), and whether no turn follows it. */
export interface TurnEnds {
  endsBy: number;
  last: boolean;
  /** Its session has returned: a claim made in it that is still checked has lost its turn. */
  over?: boolean;
}

/** The turn under way of each run, by its state. */
const TURN_ENDS = new WeakMap<object, TurnEnds>();

/** Note when the run's lead turn under way ends, and whether it is the run's last (its wrap-up). */
export function noteTurnEnds(state: object, deadline: number, last = false): void {
  TURN_ENDS.set(state, { endsBy: deadline, last });
}

/** The run's lead turn under way, or undefined when no turn said. */
export function turnEndsOf(state: object): TurnEnds | undefined {
  return TURN_ENDS.get(state);
}

/** Note that the run's lead turn under way has ended (its session returned). */
export function noteTurnOver(state: object): void {
  const noted = TURN_ENDS.get(state);
  if (noted) noted.over = true;
}
