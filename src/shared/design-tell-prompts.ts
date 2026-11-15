/**
 * What the agent reads about the person's notes and picks on the Design board that go with their
 * next message (`design-tell.ts`): after the person's words and their tags' lines, a heading the
 * chat cuts the message at (`withoutMentionContext`), the notes and picks, and the rule.
 */

/** Where the board's lines start in a sent message; the chat shows only what comes before it. */
export const DESIGN_NEWS_HEADING =
  "\n\nLeft on the Design board since the person last wrote, sent with this message:\n";

/** The rule after the board's lines. */
export const DESIGN_NEWS_RULE = "Take these notes and picks into this turn's work, or say in your reply why not.";

/**
 * A note on an artboard whose spot the teller cannot say: one pinned before notes kept where on
 * their artboard they are, told with the person's next message (Tell Genex always knows the spot).
 */
export const noteOnArtboard = (title: string, file: string, text: string): string => `${title} (${file}): ${text}`;
