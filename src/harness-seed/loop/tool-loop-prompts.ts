/**
 * The words the tool loop adds to a turn on its own. A module of its own: a seed upgrade keeps an
 * agent-edited turn-prompts.ts, and a name the tool loop imported from an older copy would not link.
 */

/** What the model hears after a reply its output limit cut off: nothing from it ran. */
export const OUTPUT_LIMIT_NOTE =
  "Your last reply reached its output limit, so none of its tool calls ran. Use a smaller, targeted edit or split the change across complete tool calls; do not rewrite a whole file or repeat finished actions.";
