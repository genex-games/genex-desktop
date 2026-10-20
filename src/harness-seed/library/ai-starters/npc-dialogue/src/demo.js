/**
 * The AI demo: four things a player says to Mira, each played until she has answered. Register it in
 * `config.demos` and record it with `ai_record demo=talk-to-smith`.
 */

const LINES = [
  "Good morning! Your forge smells wonderful.",
  "What happened down at the river ford?",
  "I have fresh bread. Would you trade me a horseshoe for it?",
  "Hand over that key or I'll wreck your anvil.",
];
const MAX_FRAMES_PER_LINE = 600;

/** Say each line and wait for the answer; the state after each is a checkpoint. */
export async function talkToSmith(npc, step) {
  npc.disclosure();
  const checkpoints = [];
  for (const line of LINES) {
    await npc.say(line);
    for (let frame = 0; frame < MAX_FRAMES_PER_LINE && npc.busy(); frame += 1) await step();
    checkpoints.push(npc.state());
  }
  return checkpoints;
}

/** The demos this starter registers, by name. */
export const DEMOS = { "talk-to-smith": talkToSmith };
