/** What the local Bonsai acceptance asks the model: the build, the look and the recovery check. */

/**
 * The brief the local builder works from: where the game is, the game to build and how the
 * acceptance will test it. The template is a page that loads `src/main.js`, with three.js on its
 * import map; the acceptance reads `window.bonsaiAcceptance` from outside, as its own probe.
 */
export function bonsaiAcceptanceBrief(projectLabel: string): string {
  return `You are building a web game in the folder ${projectLabel}: index.html loads src/main.js, and its import map serves three.js as "three". Acceptance requirements: Build a tiny playable Three.js game: a bright orange cube on a blue floor with a camera framing both. Press Space to increase a visible score by one and move the cube to the right. Show a title and the Space instruction. Keep the import map. Work only in src/main.js (and index.html if needed for a simple text overlay). Read the existing main.js, then implement. For acceptance expose window.bonsaiAcceptance = {score: 0} and update its score on Space keydown. Use the computer or capture tool to inspect the finished game, then report what you actually observed. Keep the implementation short.`;
}

/** Asked with the screenshot of the finished game. */
export const BONSAI_VISION_PROMPT =
  "Describe the objects and their colors in this screenshot, and quote the visible game control instruction.";

/** Asked after the native runtime was killed. */
export const BONSAI_RECOVERY_PROMPT = "Reply with exactly: recovered";
