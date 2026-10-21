/**
 * A game's own picture for the panel: the header Steam keeps in its library cache for each game the
 * person has, read from disk (Genex fetches nothing). Steam has kept it as `<id>_header.jpg` and,
 * newer, as `<id>/header.jpg` (sometimes one folder further down); none is fine, the panel then
 * shows the game's name alone.
 */
import { readdir } from "node:fs/promises";
import { readRegularFile } from "../../substrate/fsx.ts";
import { type GamesEnv, GameStore, pathsOf, steamRoot } from "./find-games.ts";
import type { InstalledGame } from "./find-games.ts";

/** The largest picture read: Steam's headers are tens of kilobytes. */
const MAX_PICTURE_BYTES = 1024 * 1024;
/** The picture's name in each of Steam's cache layouts. */
const HEADER = "header.jpg";
/** A Steam app id, as a cache file name may carry it. */
const APP_ID = /^\d{1,12}$/;

/** The places Steam may keep this app's header, in the order tried. */
async function headerPlaces(env: GamesEnv, appId: string): Promise<string[]> {
  const p = pathsOf(env);
  const cache = p.join(steamRoot(env), "appcache", "librarycache");
  const own = p.join(cache, appId);
  const below = await readdir(own, { withFileTypes: true }).catch(() => []);
  const nested = below.filter((e) => e.isDirectory()).map((e) => p.join(own, e.name, HEADER));
  return [p.join(cache, `${appId}_${HEADER}`), p.join(own, HEADER), ...nested];
}

/** The game's Steam header as a data URL, or null when Steam keeps none (or the game isn't Steam's). */
export async function steamPicture(env: GamesEnv, game: InstalledGame): Promise<string | null> {
  if (game.store !== GameStore.Steam || !game.storeId || !APP_ID.test(game.storeId)) return null;
  for (const place of await headerPlaces(env, game.storeId)) {
    const bytes = await readRegularFile(place, MAX_PICTURE_BYTES).catch(() => null);
    if (bytes) return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }
  return null;
}
