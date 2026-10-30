/** What the chat's agent is told when a run landed its build in a web game with Genex on (`cover-step.ts`). */
export const COVER_STEP_PROMPT = [
  "Genex here: the build is in the game folder now. Make the game's Genex cover as a small step of its own:",
  "a cover image of the real game (PNG or JPEG, at least 1280×720) and, if you like, a short clip of it, made",
  "by any means, saved in the game folder. Hand their paths to genex__cover as",
  '{ image: "<path>", clip?: "<path>" }; genex__skill {"name":"cover"} has the requirement and the API.',
  "Change nothing else in the game and start no build. Then tell the person in one short line that the cover is ready.",
].join(" ");
