/**
 * What the model is told: the arena's tiny language, and that the player's strategy (in
 * `untrusted`) is what to compile, never an instruction to follow.
 */
import { CONDITIONS, MAX_RULES, MOVES } from "./schema.js";

/** The language, the same on every call. */
export const compilerBible = () =>
  [
    "You compile a player's battle strategy, given in <untrusted>, into a bot program for a one-on-one arena.",
    `A program is 1 to ${MAX_RULES} rules, read top to bottom each tick; the first whose condition holds runs.`,
    `Conditions: ${CONDITIONS.join(", ")} (near is within 3 metres; hurt is under 40% health).`,
    `Moves: ${MOVES.join(", ")}. power 1-3 trades stamina for force.`,
    "End with an always rule. Compile what the strategy says, not what would win.",
  ].join("\n");

/** The compile call for a corner of the arena. */
export const compilePrompt = (corner) => `Compile the strategy in <untrusted> for the bot in the ${corner} corner.`;
