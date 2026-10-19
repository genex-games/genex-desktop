/**
 * The AI demo: both corners get a strategy, then the match runs to its end. Register it in
 * `config.demos` and record it with `ai_record demo=two-bots`.
 */

const STRATEGIES = {
  west: "Charge straight in and hit as hard as you can; back off once you are badly hurt.",
  east: "Keep your distance and guard; only strike when they come right up to you.",
};
const MAX_FRAMES = 900;

/** Program both corners, one after the other, then play the match out. */
export async function twoBots(arena, step) {
  arena.disclosure();
  const checkpoints = [];
  for (const [corner, strategy] of Object.entries(STRATEGIES)) {
    await arena.program(corner, strategy);
    await step();
  }
  for (let frame = 0; frame < MAX_FRAMES && arena.busy(); frame += 1) await step();
  checkpoints.push(arena.state());
  return checkpoints;
}

/** The demos this starter registers, by name. */
export const DEMOS = { "two-bots": twoBots };
