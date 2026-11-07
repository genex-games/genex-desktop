/**
 * What the judge (`second-opinion.ts`) is told about pictures that come with their times: a motion
 * strip's frames or pictures the lead timed. A sword duel's critic scored stills for 17 rounds while
 * its fighters slid, and a contact sheet of tiny frames with the interval only in the question let it
 * say "the feet look planted"; each frame at full size, numbered with its game time, is what lets a
 * model see a foot ride along with the body. A module of its own, so the shipped judge needs no new
 * name from a prompts file an agent may have kept. Model-facing: the judge reads them as written.
 */

/** Seconds as the frame list shows them. */
const seconds = (value: number) => `${value.toFixed(3)} s`;

/** The judge's words for pictures that come with times. */
export const JUDGE_FRAMES_WORDS = {
  /** One picture's line: its place, what it is, and its game time when it has one. */
  line: (index: number, name: string, at: number | null, previous: number | null) => {
    if (at === null) return `Picture ${index}: ${name}, no time given.`;
    const gap = previous === null ? "" : `, ${seconds(at - previous)} after the one before`;
    return `Picture ${index}: ${name}, at ${seconds(at)} game time${gap}.`;
  },
  /** The note after the question, listing every picture in order. */
  note: (lines: readonly string[], leftOut: number) =>
    [
      "The pictures come in this order:",
      ...lines,
      "Pictures with times are frames of the game in motion. Judge the motion across them from their times: how far the body travels against how its feet step (a planted foot stays put while the body passes over it), whether a pose jumps from one frame to the next, whether a move plays through or is cut off. Say when the frames can't show what you are asked.",
      ...(leftOut > 0 ? [`${leftOut} later frames were left out: together they were too large to send.`] : []),
    ].join("\n"),
} as const;
