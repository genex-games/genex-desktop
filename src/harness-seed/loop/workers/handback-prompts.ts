/**
 * What the lead reads of what an ended worker handed back: its report, the files its copy's work
 * changes, and the pictures to look at once its work is merged. A module of its own, so the shipped
 * pool needs no new name from a `prompts.ts` an agent may have kept.
 */

/** Every answer about a worker's hand-back. */
export const HANDBACK_WORDS = {
  said: (sentence: string) => `said: ${sentence}`,
  report: (id: string, text: string) => `${id}'s report:\n${text}`,
  noReport: (id: string) => `${id} wrote no report when it ended.`,
  changes: (id: string, files: readonly string[]) => `${id}'s work changes: ${files.join(", ")}`,
  lookAt: (pictures: readonly string[]) =>
    `Look at the pictures it made before you build on it: ${pictures.join(", ")}.`,
} as const;
