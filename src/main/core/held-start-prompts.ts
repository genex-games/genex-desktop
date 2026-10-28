/** What the chat's agent is told when the Loop it started didn't start (`held-start.ts`). */
export const HELD_START_PROMPT = (why: string): string =>
  [
    `Genex here: the Loop you started didn't start. ${why}`,
    "Fix what stopped it yourself if you can: reopen the project's app or editor with your tools, or fix the code that doesn't build. Then start the Loop again on the same goal.",
    "Ask the person only for what only they can do, and tell them in one plain line what you did.",
  ].join("\n");
