/** What a Loop lead's `judge_play` tool says to the lead: its description, arguments and answers. */

/** The tool's name: the chat's own name for it. Never rename. */
export const JUDGE_PLAY_TOOL = "judge_play";

/** The tool's description, as the lead's engine sees it. */
export const JUDGE_PLAY_DESCRIPTION =
  "A blind judge plays the game in its engine's editor (a play session it starts, with keys and the mouse, the game standing still while it decides) and answers one yes/no question it can settle by playing. It never sees your code or your notes. With goal_state, Genex itself checks the game's state after every move, and a yes it saw reached is studio-verified. Takes a few minutes; the answer is written to the run's record.";

/** The tool's words for each answer and refusal. */
export const JUDGE_PLAY_WORDS = {
  noAsk: "judge_play needs ask: one yes/no question the judge can settle by playing.",
  goalState: (why: string) => `goal_state: ${why}`,
  noWindow: (why: string) => `No judge could start right now: ${why}. Try again in a minute.`,
  notPlayed: (why: string) => `The judge played nothing: ${why}`,
  answered: (answer: string, verified: boolean, note: string) =>
    `The judge answered ${answer}${verified ? " (studio-verified: Genex saw the goal state reached)" : ""}${note ? `: ${note}` : "."}`,
  noAnswer: (note: string) => `The judge gave no yes or no${note ? `: ${note}` : "."}`,
} as const;

/** The tool's arguments, as the lead's engine sees them. */
export const JUDGE_PLAY_ARGS = {
  ask: "One yes/no question about playing the game, e.g. 'Can the player climb to the lighthouse door?'.",
  goalState:
    'Optional JSON: the state the game reaches when the answer is yes, as play-state reads it, e.g. {"path":"phase","equals":"won"} or {"path":"atDoor","truthy":true}.',
} as const;
