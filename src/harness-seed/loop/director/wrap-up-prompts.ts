/**
 * What `wrap_up` answers the lead (wrap-up.ts): the user's ask to finish is on record, who still
 * works, and what comes next. Model-facing text: plain, and never a reason to start something.
 */
export const WRAP_UP_WORDS = {
  notQuoted:
    "wrap_up needs the user's own words asking to finish, quoted exactly from their message to this run. Nothing was recorded and the run goes on: a question alone stops no worker.",
  closing: "the run is already closing; nothing more to wrap up",
  already: "The user's ask to finish is already on record.",
  /** One running loop worker: the round it is in and the minutes its budget has left. */
  worker: (id: string, round: unknown, minutesLeft: unknown) =>
    `${id} (round ${typeof round === "number" ? round : "?"}, ${typeof minutesLeft === "number" ? minutesLeft : "?"} min left in its budget)`,
  /** One running single session: it has no round to end. */
  session: (id: string) => `${id} (one session: finish stops it)`,
  running: (workers: readonly string[]) =>
    `Recorded: the user asked to finish. No worker or round starts from now. Still running: ${workers.join("; ")} — each loop worker ends the round it is in and stops; you are woken as each lands, so integrate what it keeps then. Once no loop worker runs the studio starts the wrap-up: look at the integrated build and call finish. Tell the user this in a sentence. To stop at once instead, call finish with user_asked.`,
  /** Only single sessions run: none has a round to end, so the wrap-up starts when this turn ends. */
  sessionsOnly: (sessions: readonly string[]) =>
    `Recorded: the user asked to finish. No worker starts from now. Still running: ${sessions.join("; ")}. Integrate what is ready, look at the integrated build and call finish; when this turn ends the studio starts the wrap-up. Tell the user this in a sentence.`,
  nothingRunning:
    "Recorded: the user asked to finish, and no worker is running. Integrate what is ready, look at the integrated build and call finish; when this turn ends the studio starts the wrap-up. Tell the user this in a sentence.",
  openLoop:
    "Recorded: the user asked to finish. No worker starts from now; when this turn ends the studio starts the wrap-up. Tell the user this in a sentence.",
  /** The new Loop the user asked for is on record with the ask (next-loop.ts). */
  nextLoop: "Their new Loop starts by itself once this run has closed: tell them so, in the same sentence.",
  /** Why an open Loop's `worker_start` refuses once the user asked to finish. */
  openNoWorkers: "the user asked to finish: no new workers. The wrap-up starts when this turn ends.",
} as const;

/** Why `worker_start` refuses once the user asked to finish. */
export const FINISH_ASKED_NO_WORKERS =
  "the user asked to finish: no new workers. Integrate what the running ones keep as each ends its round; the wrap-up starts once no loop worker runs.";
