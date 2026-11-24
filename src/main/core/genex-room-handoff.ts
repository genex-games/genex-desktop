/**
 * Where a running `genex__room` is named for an engine's editor: `<game>/.studio/authority.json`,
 * `{"url":"ws://127.0.0.1:<port>"}`. Genex's Unreal plugin (GenexMultiplayerEditor's
 * GenexLocalAuthority) reads it as Play begins and hands the address to the game in
 * `GENEX_AUTHORITY_URL`, so the editor's players join the room the bots are in. The file exists
 * only while the room runs and this computer reaches it.
 *
 * Written and removed as every handoff is (`editor-handoff.ts`): never through a link, and removed
 * only while it still names the room that wrote it.
 */
import { removeHandoff, writeHandoff } from "./editor-handoff.ts";

/** The handoff's name in the game's `.studio`. */
const HANDOFF_FILE = "authority.json";

/** The handoff's text for `url`: compact, as the Unreal plugin's parser takes it. */
const handoffText = (url: string) => JSON.stringify({ url });

/** Name the running room at `url` in `game`'s `.studio/authority.json`. Throws, writing nothing, through a link. */
export function nameRoom(game: string, url: string): Promise<void> {
  return writeHandoff(game, HANDOFF_FILE, handoffText(url));
}

/** Remove the handoff while it is a plain file in a plain `.studio` and still names `url`. */
export function unnameRoom(game: string, url: string): Promise<void> {
  return removeHandoff(game, HANDOFF_FILE, handoffText(url));
}
