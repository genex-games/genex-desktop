/**
 * What the lead hears of a worker's stopped round (kept-work.ts, kept-judge.ts, journal-prompts.ts):
 * `integrate` takes it as it is, and nobody has to judge it first (Loop phase 4). A new module, so a
 * kept older sibling can never be missing it.
 */
import { shortSha } from "../git.ts";

/** What the lead hears of a worker's stopped round (kept-work.ts). */
export const KEPT_WORDS = {
  /** How a stopped round from before a pause goes into the build: through a worker started from it. */
  judgedFirst: (kept: string) =>
    `worker_start from=${kept} builds on it, and integrate takes that worker's work as it is; look at it, or ask a judge, only when you want a second opinion`,
  /** What `integrate` left out of the build: nothing for want of a judge, any more (kept for a kept older integrate.ts). */
  leftOut: (id: string, kept: string) =>
    `its stopped round ${shortSha(kept)} is not merged yet: integrate worker=${id} takes it as it is`,
  /** A stopped round the build took in by hand. */
  inUnjudged: (id: string, kept: string) =>
    `worker ${id}'s stopped round ${shortSha(kept)} is in the build; nobody judged it, so look at integration if you want to see it`,
} as const;
