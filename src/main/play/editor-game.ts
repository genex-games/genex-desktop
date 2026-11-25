/**
 * The game an editor's Genex button means: the Genex button in a game engine's editor sends the
 * project's folder (`genex://editor/<folder>`, `game-links.ts`), and the game is the one of this
 * library whose folder holds it. The folder comes from outside Genex, so it is only compared, by
 * real path. When no game holds it, Genex reads the names in it once, to offer only a folder that
 * is an Unreal project; nothing is written to it or opened until the person agrees in the sheet.
 */
import { readdir, realpath } from "node:fs/promises";
import { isInside } from "../../substrate/paths.ts";

/** A game of the library, as far as finding one by folder needs. */
export interface LibraryGame {
  name: string;
  dir: string;
}

const realOrNull = (folder: string): Promise<string | null> => realpath(folder).catch(() => null);

/** The name of the game whose folder is `folder` or holds it, or null when no game here does. */
export async function gameHoldingFolder(games: readonly LibraryGame[], folder: string): Promise<string | null> {
  const real = await realOrNull(folder);
  if (!real) return null;
  for (const game of games) {
    const dir = await realOrNull(game.dir);
    if (dir && isInside(dir, real)) return game.name;
  }
  return null;
}

/** What marks a folder as an Unreal project: its project file. */
const UNREAL_PROJECT_FILE = ".uproject";

/** The real path of `folder` when it is an Unreal project's folder (it holds a `.uproject` file), else null. */
export async function unrealProjectFolder(folder: string): Promise<string | null> {
  const real = await realOrNull(folder);
  if (!real) return null;
  const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
  const project = entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(UNREAL_PROJECT_FILE));
  return project ? real : null;
}
