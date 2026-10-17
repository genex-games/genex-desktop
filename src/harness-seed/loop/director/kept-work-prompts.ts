/**
 * What the lead hears of a worker's stopped round, which nobody judged (kept-work.ts, kept-judge.ts,
 * journal-prompts.ts): judged against the build before it goes in, never merged by hand. A new
 * module, so a kept older sibling can never be missing it.
 */
import { shortSha } from "../git.ts";

/** What the lead hears of a worker's stopped round, which nobody judged (kept-work.ts). */
export const KEPT_WORDS = {
  /** How a stopped round from before a pause goes into the build: judged, never merged by hand. */
  judgedFirst: (kept: string) =>
    `worker_start from=${kept} builds on it; judge that worker against=integration before you integrate it, and never merge the kept round itself unjudged`,
  /** What `integrate` left out of the build. */
  leftOut: (id: string, kept: string) =>
    `its stopped round ${shortSha(kept)} was never judged and is not merged: judge target=${id} against=integration, and integrate takes it once the judge prefers it`,
  /** A stopped round the build took in without a judge (a merge by hand). */
  inUnjudged: (id: string, kept: string) =>
    `worker ${id}'s stopped round ${shortSha(kept)} is in the build without a judge: judge integration before building on it`,
} as const;
