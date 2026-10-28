/**
 * What Create › Items hands a game's chat agent (marketplace plan 8.3). These are model prompts,
 * written in English and never translated: the agent reads them, and the person sees them as
 * their own message.
 */

/** Add to \<game>: the chat turn that puts a shared item in the game (plan 8.3, step 5). */
export const addItemPrompt = (name: string, itemId: string): string =>
  `Add the shared item ${name} (\`${itemId}\`) to this game. Run \`genex items add ${itemId}\` and follow the genex-items skill.`;

/** Ask the agent to change it: words left in the composer, for the person to finish and send. */
export const changeItemPrompt = (name: string, itemId: string): string =>
  `Change the store item ${name} (\`${itemId}\`): `;
