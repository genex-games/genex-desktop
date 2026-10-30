/**
 * What `wrap_up` answers the lead (wrap-up.ts): the user's ask to finish is on record, who still
 * works, and what comes next. Model-facing text: plain, and never a reason to start something.
 */
export const WRAP_UP_WORDS = {
  notQuoted:
    "wrap_up needs the user's own words asking to finish, quoted exactly from their message to this run. Nothing was recorded and the run goes on: a question alone stops no worker.",
  closing: "the run is already closing; nothing more to wrap up",
  already: "The user's ask to finish is already on record.",
  /** Workers still run: finish stops them. */
  sessionsOnly: (workers: readonly string[]) =>
    `Recorded: the user asked to finish. No worker starts from now. Still running: ${workers.join(", ")} — finish stops them; merge what is ready first. When this turn ends the wrap-up starts. Tell the user this in a sentence.`,
  nothingRunning:
    "Recorded: the user asked to finish, and no worker is running. Merge what is ready and call finish; when this turn ends the wrap-up starts. Tell the user this in a sentence.",
  openLoop:
    "Recorded: the user asked to finish. No worker starts from now; when this turn ends the wrap-up starts. Tell the user this in a sentence.",
  /** The new Loop the user asked for is on record with the ask (next-loop.ts). */
  nextLoop: "Their new Loop starts by itself once this run has closed: tell them so, in the same sentence.",
  /** Why an open Loop's `worker_start` refuses once the user asked to finish. */
  openNoWorkers: "the user asked to finish: no new workers. The wrap-up starts when this turn ends.",
} as const;

/** Why `worker_start` refuses once the user asked to finish. */
export const FINISH_ASKED_NO_WORKERS =
  "the user asked to finish: no new workers. The wrap-up starts when this turn ends.";

/** Why `worker_start` refuses once the lead's finish closes the run: nothing would run the worker. */
export const RUN_OVER_NO_WORKERS = "the run is finishing: no new workers. End your turn.";
