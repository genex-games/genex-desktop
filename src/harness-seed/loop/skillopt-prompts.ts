/**
 * SkillOpt's model prompts that live outside its control flow: the lessons distiller, which turns
 * what the builders wrote under `## Fixed by looking` and after `HARNESS:` into the short list every
 * brief carries. The words a lessons suggestion shows in Activity live here too.
 */

/** The most new lessons one pass may propose. */
export const MAX_LESSONS_PROPOSED = 4;

/** The reply shape the distiller is asked for, twice: once in the rules and once after the notes. */
const LESSONS_REPLY = 'Reply with JSON only: {"add":["…"],"remove":["exact current lesson text"],"rationale":"…"}';

/** One builder's note as the distiller reads it: the facet it came from, and what it said. */
export interface MinedLesson {
  text: string;
  facetId: string | null;
}

/** The distiller's request: the lessons already known (applied or waiting), and the builders' notes. */
export function lessonsPrompt(
  known: readonly string[],
  mined: readonly MinedLesson[],
): { systemPrompt: string; userContent: string } {
  return {
    systemPrompt: [
      "You maintain a short list of lessons that go into every game builder's brief. Each lesson is one concrete, general sentence a builder can act on (a helper's shape, a merge rule, a capture habit, a check to run before re-tuning).",
      `From the builders' own notes below, propose at most ${MAX_LESSONS_PROPOSED} NEW lessons that recur or would clearly recur, and name any CURRENT lesson that the notes show is wrong. Never restate a current lesson.`,
      "A lesson says what a player would see or what to do; never a floor on how much a build draws or measures.",
      LESSONS_REPLY,
    ].join("\n"),
    userContent: [
      `CURRENT LESSONS (${known.length}):`,
      ...known.map((lesson) => `- ${lesson}`),
      "",
      `BUILDER NOTES (${mined.length}):`,
      ...mined.map((note) => `- [${note.facetId ?? "?"}] ${note.text}`),
      "",
      LESSONS_REPLY,
    ].join("\n"),
  };
}

/** How a lessons suggestion reads in Activity, for someone who never opens the file. */
export const LESSONS_WORDS = {
  title: "Add what builders learned to every brief",
  /** The title of a suggestion that only takes lessons out. */
  removeTitle: "Take out lessons that no longer hold",
  added: (count: number) =>
    count === 1
      ? "Adds one lesson the builders wrote down to the list every builder reads."
      : `Adds ${count} lessons the builders wrote down to the list every builder reads.`,
  removed: (count: number) =>
    count === 1 ? "Takes out one lesson that no longer holds." : `Takes out ${count} lessons that no longer hold.`,
} as const;
