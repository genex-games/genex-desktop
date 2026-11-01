/**
 * What the open lead is answered about its evidence and its time: the picture a save point names
 * (`save_point {shows}`), and a wait the turn's end shortened. A module of its own, so the shipped tools need no new name from a
 * `prompts.ts` an agent may have kept.
 */

/** A save point's `shows`, as its answer speaks of it. */
export const SHOWS_WORDS = {
  /** A file `shows` named that is no PNG or JPEG. */
  notPicture: "not a PNG or JPEG",
  /** A save point whose `shows` named no picture Genex could read. */
  refused: (rel: string, why: string) =>
    `${JSON.stringify(rel)} is not a picture in the project's folder (${why}), so the save point keeps Genex's own pictures only.`,
} as const;

/** Beside a `worker_wait` the lead's turn end shortened: how long the turn has left. */
export const turnEndingWords = (minutesLeft: number): string =>
  `Your turn ends in about ${minutesLeft} minutes: end it now unless something is quick; Genex wakes you when a worker ends.`;
