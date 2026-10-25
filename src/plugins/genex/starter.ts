/**
 * Studio's empty starter: the game every new project begins as, a renderer with nothing to play
 * that draws a black screen. Published as it is, it would be a page with nothing on it and a card
 * with no picture, so Publish refuses it until the game's own code moves on.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** The sha256 of the starter's `src/main.js` (`src/game-template/src/main.js`), the file a game's own code replaces. */
export const EMPTY_STARTER_MAIN_SHA256 = "92b19c0fe15550b72edb4181c536d7203c910736eb4d06c6c0ddfbcb4b49ebac";
const STARTER_MAIN = path.join("src", "main.js");

/** Whether the game in `gameDir` is still the empty starter: its `src/main.js` is the starter's, byte for byte. */
export async function isEmptyStarter(gameDir: string): Promise<boolean> {
  const main = await readFile(path.join(gameDir, STARTER_MAIN)).catch(() => null);
  return main !== null && createHash("sha256").update(main).digest("hex") === EMPTY_STARTER_MAIN_SHA256;
}
