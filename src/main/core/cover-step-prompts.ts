/** What the chat's agent is told when a run landed its build in a web game with Genex on (`cover-step.ts`). */
export const COVER_STEP_PROMPT = [
  "Genex here: the build is in the game folder now. Make the game's Genex cover as a small step of its own: read",
  'genex__skill {"name":"cover"} and do what it says (stage the genex-cover demo from the game\'s own world and shoot',
  "it with genex__cover). Change nothing else in the game and start no build. Then tell the person in one short line",
  "that the cover is ready.",
].join(" ");
