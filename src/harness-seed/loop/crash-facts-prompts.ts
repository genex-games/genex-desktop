/**
 * The builder's line about a crashed run (game systems CRASH-6): the crash record's facts in one
 * sentence the next builder reads among the look's problems, and the library recipe that replays
 * it. The facts come from `crash-facts.ts`; this module only words them.
 */
import type { CrashFacts } from "./crash-facts.ts";

/** The library recipe a builder follows to reproduce a crash from its record. */
export const CRASH_REPLAY_RECIPE = "debug.crash-replay";

/**
 * One line naming what crashed, where, on which tick and seed, the game's own top frames, and how
 * to reproduce it: e.g. `the game crashed: panic "index out of bounds" at src/facets/dash.rs:42:9
 * on tick 300 (seed 7); ...`.
 */
export function crashFactsLine(facts: CrashFacts): string {
  const parts = [
    `the game crashed: ${facts.kind}${facts.message ? ` "${facts.message}"` : ""}${placeOf(facts)}${whenOf(facts)}`,
  ];
  if (facts.frames.length) parts.push(`top frames: ${facts.frames.join(" ← ")}`);
  parts.push(replayOf(facts));
  if (facts.repeat > 1) parts.push(`the same crash ended ${facts.repeat} runs`);
  return `${parts.join("; ")} (crash record ${facts.crashId}, \`game.crashes\`)`;
}

/** ` at file:line:column`, or nothing when the record names no place. */
function placeOf(facts: CrashFacts): string {
  const at = facts.location;
  return at ? ` at ${at.file}:${at.line}:${at.column}` : "";
}

/** ` on tick N (seed S)`, with whichever of the two the record knew. */
function whenOf(facts: CrashFacts): string {
  const tick = facts.tick === null ? "" : ` on tick ${facts.tick}`;
  const seed = facts.seed === null ? "" : ` (seed ${facts.seed})`;
  return `${tick}${seed}`;
}

/** How to reproduce it: the seed and the tick, and whether the input that led there was kept. */
function replayOf(facts: CrashFacts): string {
  const replay = facts.replay;
  const recipe = `library recipe ${CRASH_REPLAY_RECIPE}`;
  if (!replay) {
    const known = facts.seed !== null && facts.tick !== null;
    const how = known ? `with seed ${facts.seed} then step to tick ${facts.tick}` : "with the look's seed and drive";
    return `reproduce it ${how} (${recipe})`;
  }
  const input = replay.rows
    ? `its input from tick ${replay.fromTick} to ${replay.toTick} is in the record${replay.complete ? "" : " (incomplete: the oldest rows were dropped)"}`
    : "no input was recorded, so the seed and the step alone reproduce it";
  return `reproduce it with seed ${replay.seed} then step to tick ${replay.toTick}; ${input} (${recipe})`;
}
