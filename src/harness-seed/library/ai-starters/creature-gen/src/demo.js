/**
 * The AI demo: three creatures described one after another, then a few seconds of the pond. Register
 * it in `config.demos` and record it with `ai_record demo=three-creatures`.
 */

const DESCRIPTIONS = [
  "a fluffy round thing that floats near lily pads and hums",
  "a long eel with eight stubby legs that hunts at dusk",
  "a tall glassy stork that drinks sunlight",
];
const MAX_FRAMES_PER_CREATURE = 600;
const POND_FRAMES = 90;

/** Describe three creatures, each played until it has landed; then let the pond run. */
export async function threeCreatures(pond, step) {
  pond.disclosure();
  const checkpoints = [];
  for (const description of DESCRIPTIONS) {
    await pond.describe(description);
    for (let frame = 0; frame < MAX_FRAMES_PER_CREATURE && pond.busy(); frame += 1) await step();
    checkpoints.push(pond.state());
  }
  for (let frame = 0; frame < POND_FRAMES; frame += 1) await step();
  checkpoints.push(pond.state());
  return checkpoints;
}

/** The demos this starter registers, by name. */
export const DEMOS = { "three-creatures": threeCreatures };
