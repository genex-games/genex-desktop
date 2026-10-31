/**
 * The words a Loop's time cap says (time-cap.ts, director/cap-lines.ts): to the lead before and at
 * its cap, to a lead that asks for a worker once the time is up, and in the report of a Loop Genex
 * closed at the end of its grace.
 */

/** What the lead hears of its hours, and what the close's report says of them. */
export const TIME_CAP_WORDS = {
  /** Before the cap: what is left. */
  headsUp: (minutesLeft: number) => `About ${minutesLeft} minutes left.`,
  /** At the cap: said mid-turn when the lead's engine reads it, else at its next turn. */
  timesUp: "Time's up. Call finish, claiming the goal only if it is reached.",
  /** A worker asked for once the time is up. */
  noNewWorkers:
    "worker_start refused: time's up, so no new workers start. Call finish, claiming the goal only if it is reached.",
  /** The close at the end of the grace, when no claim reached a reviewer: the person reads it on the card. */
  notChecked: "The time ran out.",
} as const;
