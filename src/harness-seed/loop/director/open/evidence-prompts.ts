/**
 * What the open lead is answered about its evidence and its time: the picture a save point names as
 * showing its change (`save_point {shows}`), a claim that still names what remains, and a wait the
 * turn's end shortened. A module of its own, so the shipped tools need no new name from a
 * `prompts.ts` an agent may have kept.
 */

/** A save point's `shows`, as its answer speaks of it. */
export const SHOWS_WORDS = {
  /** A save point that named no picture of its change. */
  none: "Next time, name the picture that shows what changed (shows): a close-up of the thing you changed, taken after the change and looked at, not a wide shot.",
  /** A file `shows` named that is no PNG or JPEG. */
  notPicture: "not a PNG or JPEG",
  /** A save point whose `shows` named no picture Genex could read. */
  refused: (rel: string, why: string) =>
    `${JSON.stringify(rel)} is not a picture in the project's folder (${why}), so the save point keeps Genex's own pictures only.`,
} as const;

/** A claim naming what is not done yet while the Loop has time: no reviewer reads it, the lead works on that first. */
export const gapsFirstWords = (remaining: readonly string[], minutesLeft: number, underMinutes: number): string =>
  `Not checked: you named what is not done yet, and about ${minutesLeft} minutes are left, so work on it first. ${remaining.map((item) => `- ${item}`).join(" ")} Call finish again once these are done, or when less than ${underMinutes} minutes are left; in remaining, name only what is still not done or not right.`;

/** Beside a `worker_wait` the lead's turn end shortened: how long the turn has left. */
export const turnEndingWords = (minutesLeft: number): string =>
  `Your turn ends in about ${minutesLeft} minutes: end it now unless something is quick; Genex wakes you when a worker ends.`;
