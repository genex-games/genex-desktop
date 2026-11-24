/**
 * A handoff: a small file in a game's `.studio` folder that names something Genex runs on this
 * computer to the game's engine editor, which reads it as its Play begins (a local room in
 * `authority.json`, `genex-room-handoff.ts`; a practice helper in `llm-practice.json`,
 * `practice-handoff.ts`). It exists only while what it names runs.
 *
 * The game folder is the person's and its agents write in it: nothing is written or removed
 * through a link, and a handoff is removed only while it still says what its writer wrote.
 */
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensureDirBelow, writeFileNoFollow } from "../../substrate/fsx.ts";

/** Studio's folder in a game, where its handoffs are. */
export const HANDOFF_FOLDER = ".studio";
/** A handoff is far smaller than this; the Unreal plugin reads no more than 1 KiB. */
const HANDOFF_MAX_BYTES = 1024;

/** Write `text` as the handoff `name` in `game`'s `.studio`. Throws, writing nothing, through a link. */
export async function writeHandoff(game: string, name: string, text: string): Promise<void> {
  const folder = await ensureDirBelow(game, [HANDOFF_FOLDER]);
  await writeFileNoFollow(path.join(folder, name), text);
}

/** Remove the handoff `name` while it is a plain file in a plain `.studio` and still says `text`. */
export async function removeHandoff(game: string, name: string, text: string): Promise<void> {
  const folder = path.join(game, HANDOFF_FOLDER);
  const file = path.join(folder, name);
  const [folderInfo, fileInfo] = await Promise.all([lstat(folder).catch(() => null), lstat(file).catch(() => null)]);
  const plain = folderInfo?.isDirectory() && fileInfo?.isFile() && fileInfo.size <= HANDOFF_MAX_BYTES;
  if (!plain) return;
  if ((await readFile(file, "utf8").catch(() => null)) !== text) return;
  await rm(file, { force: true });
}
