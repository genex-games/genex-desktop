/**
 * The AI demo: three orders, each played until its turn and follow-ups have settled. Register it in
 * `config.demos` (`"turn-three": () => turnThree(world, step)`, with `step` advancing one frame) and
 * record its playtest with `ai_record demo=turn-three`.
 */

/** The orders the demo gives, in a player's words. */
const ORDERS = [
  "Send envoys to Brenn and offer a grain-for-iron pact.",
  "Move two regiments to the Calder border, but do not cross it.",
  "Declare a week of festivals in the capital to calm the guilds.",
];
/** The most frames one turn may take before the demo moves on (a fallback ends it sooner). */
const MAX_FRAMES_PER_TURN = 600;

/** Step until the world has settled, at most `MAX_FRAMES_PER_TURN` frames. */
async function settle(world, step) {
  for (let frame = 0; frame < MAX_FRAMES_PER_TURN && world.busy(); frame += 1) await step();
}

/** Play the three orders; the state after each turn is a checkpoint. */
export async function turnThree(world, step) {
  world.disclosure();
  const checkpoints = [];
  for (const order of ORDERS) {
    await world.submitOrder(order);
    await step();
    await settle(world, step);
    checkpoints.push(world.state());
  }
  return checkpoints;
}

/** The demos this starter registers, by name (the tape is `ai/tapes/<name>.jsonl`). */
export const DEMOS = { "turn-three": turnThree };
