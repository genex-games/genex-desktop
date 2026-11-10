/**
 * Where a running `genex__room` is named for an engine's editor: `<game>/.studio/authority.json`,
 * `{"url":"ws://127.0.0.1:<port>"}`. Genex's Unreal plugin (GenexMultiplayerEditor's
 * GenexLocalAuthority) reads it as Play begins and hands the address to the game in
 * `GENEX_AUTHORITY_URL`, so the editor's players join the room the bots are in. The file exists
 * only while the room runs and this computer reaches it.
 *
 * The game folder is the person's and its agents write in it: nothing is written or removed
 * through a link, and a handoff is removed only while it still names the room that wrote it.
 */
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensureDirBelow, writeFileNoFollow } from "../../substrate/fsx.ts";

/** Studio's folder in a game, and the handoff's name in it. */
const HANDOFF_FOLDER = ".studio";
const HANDOFF_FILE = "authority.json";
/** A handoff is far smaller than this; the Unreal plugin reads no more than 1 KiB. */
const HANDOFF_MAX_BYTES = 1024;

/** The handoff's text for `url`: compact, as the Unreal plugin's parser takes it. */
const handoffText = (url: string) => JSON.stringify({ url });

/** Name the running room at `url` in `game`'s `.studio/authority.json`. Throws, writing nothing, through a link. */
export async function nameRoom(game: string, url: string): Promise<void> {
  const folder = await ensureDirBelow(game, [HANDOFF_FOLDER]);
  await writeFileNoFollow(path.join(folder, HANDOFF_FILE), handoffText(url));
}

/** Remove the handoff while it is a plain file in a plain `.studio` and still names `url`. */
export async function unnameRoom(game: string, url: string): Promise<void> {
  const folder = path.join(game, HANDOFF_FOLDER);
  const file = path.join(folder, HANDOFF_FILE);
  const [folderInfo, fileInfo] = await Promise.all([lstat(folder).catch(() => null), lstat(file).catch(() => null)]);
  const plain = folderInfo?.isDirectory() && fileInfo?.isFile() && fileInfo.size <= HANDOFF_MAX_BYTES;
  if (!plain) return;
  if ((await readFile(file, "utf8").catch(() => null)) !== handoffText(url)) return;
  await rm(file, { force: true });
}
