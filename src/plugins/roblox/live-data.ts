/**
 * Whether Roblox Studio can reach a game's live saved data: a published place whose Studio has
 * access to Roblox's API services reads and writes the same DataStores real players use. The play
 * adapter asks Studio once at each play's start and records the answer here, in the plugin's own
 * storage (`live-data/<game>.json`, `{reachable, at}`), never in the game folder agents write. The
 * Set up panel reads it to warn in the place block; the newest answer stands until the next play.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { isGameId } from "./studio-binding.ts";

/** The records' folder in the plugin's storage. */
export const LIVE_DATA_FOLDER = "live-data";
const MAX_RECORD_BYTES = 4 * 1024;

/** What the last play found: whether Studio could reach the live saved data, and when. */
export interface LiveData {
  reachable: boolean;
  at: number;
}

const recordFile = (storage: string, game: string) => path.join(storage, LIVE_DATA_FOLDER, `${game}.json`);

/** Records what a play found for `game`. */
export async function writeLiveData(storage: string, game: string, found: LiveData): Promise<void> {
  if (!isGameId(game)) throw new Error("Invalid game");
  await mkdir(path.join(storage, LIVE_DATA_FOLDER), { recursive: true, mode: 0o700 });
  await atomicWriteJson(recordFile(storage, game), { reachable: found.reachable, at: found.at });
}

/** What the last play found for `game`, or undefined when no play has asked or the record isn't one. */
export async function readLiveData(storage: string, game: string | undefined): Promise<LiveData | undefined> {
  if (!isGameId(game)) return undefined;
  const value = await readRegularFile(recordFile(storage, game), MAX_RECORD_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(value) || typeof value.reachable !== "boolean" || typeof value.at !== "number") return undefined;
  return { reachable: value.reachable, at: value.at };
}
