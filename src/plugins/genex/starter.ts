/**
 * Studio's empty starter: the game every new project begins as, a page whose `src/main.js` holds
 * one comment and nothing to play. Published as it is, it would be a page with nothing on it and a
 * card with no picture, so Publish refuses it until the game's own code moves on.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** The sha256 of the starter's `src/main.js` (`src/game-template/src/main.js`), the file a game's own code replaces. */
export const EMPTY_STARTER_MAIN_SHA256 = "d95bc8961b153969829913c79f89ef80607d63a6fba5ad0310980f0df7e76e4a";
const STARTER_MAIN = path.join("src", "main.js");

/** Whether the game in `gameDir` is still the empty starter: its `src/main.js` is the starter's, byte for byte. */
export async function isEmptyStarter(gameDir: string): Promise<boolean> {
  const main = await readFile(path.join(gameDir, STARTER_MAIN)).catch(() => null);
  return main !== null && createHash("sha256").update(main).digest("hex") === EMPTY_STARTER_MAIN_SHA256;
}
