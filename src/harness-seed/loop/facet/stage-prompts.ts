/**
 * What the finish stage (facet/stage.ts) says to its builder and its judge. The build stage's
 * words stay where they are, byte for byte; these replace them only for a worker finishing what
 * exists, where polish is the work and wins on the blind pick.
 */

/** The brief's section in place of THE MOVE, for a finishing worker. */
export const FINISH_SECTION_HEAD = "## THE FINISH this iteration — polish wins";

/** What a finishing builder works on, and how its build is judged. */
export const FINISH_RULES: readonly string[] = [
  "This iteration finishes what exists. Work the judge's polish list below and the defect ledger, worst first.",
  "Change how what exists looks, sounds and feels — materials, light, readability, motion, the HUD's craft — not what exists: no new systems, no new mechanics.",
  "Keep every passing check: a regression still rolls the build back.",
  "Capture and look at the real window before you stop: the judge picks blind between your build and the accepted one, and a build that adds a system or changes nothing a player can see loses.",
];

/** The polish list's heading inside the finish section. */
export const FINISH_POLISH_HEAD = "The judge's polish list (this is the work, worst first):";

/** The one line a finishing builder's prompt carries where THE MOVE's would be. */
export const FINISH_PROMPT_LINE =
  "THE FINISH THIS ITERATION: polish what exists — the judge's polish list and defect ledger in the brief, worst first. No new systems. A build a player would rather ship wins on the blind pick; a regression still loses.";

/** THE FIX's last line in a finish-stage brief: tuning is allowed when tuning is what closes it. */
export const FINISH_FIX_LINE =
  "Close it the way that reads best on screen: tune it when tuning closes it, rebuild the part only when tuning cannot. Land it in this build, before the polish list.";

/** THE FIX's instruction in a finish-stage prompt. */
export const FINISH_FIX_ASK =
  "Close it the way that reads best on screen: tune it when tuning closes it, rebuild only when tuning cannot.";

/** A finishing builder's loss streak: change the approach, not "never tune". */
export const finishLossEscalate = (losses: number): string =>
  `ESCALATE: ${losses} losses in a row — the judge kept the build before yours. Change the approach to what a player sees, not more of the same.`;

/** The taste judge's user-content line for a finish-stage round. */
export const FINISH_STAGE_LINE =
  "STAGE: finish — this round polishes on purpose; `scale: polish` is expected and is no fault. Pick the build a player would rather ship.";

/** What `worker_start` answers about a finishing worker's moves. */
export const FINISH_START_MOVES =
  "stage finish: no move and no ladder — each round works the judge's polish list and defect ledger, wins on the blind pick, and a regression still rolls it back; worker_steer move= puts it back to building";

/** What `worker_steer stage=` answers: the stage the worker's next round runs in. */
export const steerStageWords = (id: string, finishing: boolean): string =>
  finishing
    ? `${id}'s next round finishes: no move, the judge's polish list and defects are the work; a round wins on the blind pick and a regression still rolls back`
    : `${id}'s next round builds again: its ladder, or the move the harness names`;

/** What `worker_steer move=` adds when it took a finishing worker back to the build stage. */
export const STEER_BACK_TO_BUILD = "It is back in the build stage.";

/** A finish asked of a single session, which has no rounds to read a stage in. */
export const FINISH_SINGLE_REFUSAL =
  "stage=finish needs a loop worker: a single session has no rounds to finish in. Drop stage or mode=single";

/** A steer with nothing in it. */
export const STEER_EMPTY_REFUSAL = "worker_steer needs text, move or stage";

/** The critic section's key in a finish-stage brief: its grow notes wait for the build stage. */
export const FINISH_CRITIC_KEY = "polish = the work; grow waits for the build stage";

/** A stage steered at a worker with no loop to read it. */
export const steerStageRefusal = (id: string): string =>
  `worker ${id} has no stage to set — it is a single session; send it text instead`;

/** The finish rubric's built-in text, for a workspace whose `judge/taste-finish.md` is missing. */
export const FINISH_RUBRIC_FALLBACK = [
  "THE FINISH STAGE: this worker finishes what exists; its rounds polish on purpose.",
  "`scale: polish` is expected and is no fault. Pick the build a player would rather ship: finish, readability, light, materials, motion, HUD craft. A build that adds a system instead of finishing loses.",
  "List up to eight `polish` items, worst first, each naming what, where and which camera: they are the builder's work now, not optional nits. `bigMove` may be null.",
  "A regression still needs a name in `regression` and `newCheck`, as above.",
  "Reply with JSON only, in the shape above.",
].join("\n");
