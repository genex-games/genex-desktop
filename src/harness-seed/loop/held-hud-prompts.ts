/**
 * The one-screen rule for a game that keeps an older, edited `src/hud.js` (loop/held-hud.ts): the
 * brief and the prompt name only what that HUD draws, and say the rest is skipped. A run holding
 * the template's HUD gets null from both, and its brief and prompt stay byte-identical. A new
 * module; it imports only from held-hud.ts, which is as new.
 */
import { FIRST_HUD_GENERATION, FIRST_HUD_SKIPS, heldHudDraws, heldHudGeneration } from "./held-hud.ts";

/** What happens to a call the held HUD lacks, in the words a builder reads. */
function skippedCalls(generation: number): string {
  return generation === FIRST_HUD_GENERATION
    ? `its ${FIRST_HUD_SKIPS} calls are skipped with a console warning, so do not build the HUD on them`
    : "a newer call is skipped with a console warning, so do not build the HUD on one";
}

/** The brief's ONE SCREEN rule for a game holding an older HUD, or null when it holds the template's. */
export function heldHudBriefRule(run: unknown): string | null {
  const generation = heldHudGeneration(run);
  if (generation === null) return null;
  return `- ONE SCREEN: all UI goes through \`__studio.hud\`, drawn into the canvas. This game keeps its own edited src/hud.js (HUD generation ${generation}, older than the studio's), so \`__studio.hud\` draws ${heldHudDraws(generation)} — ${skippedCalls(generation)}. Keep the middle of the view for the game. No DOM elements, no second HUD quad or canvas, no camera-parented panels — the harness-owned checks no-dom-ui and single-hud fail the build otherwise.`;
}

/** What the prompt's ONE SCREEN rule says `__studio.hud` draws on an older HUD, or null when it holds the template's. */
export function heldHudPromptDraws(run: unknown): string | null {
  const generation = heldHudGeneration(run);
  if (generation === null) return null;
  return `drawn into the canvas: ${heldHudDraws(generation)} — this game keeps its own edited src/hud.js (HUD generation ${generation}) and ${skippedCalls(generation)}; keep the middle of the view for the game`;
}
