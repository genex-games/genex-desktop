/**
 * The game's Roblox Studio closed once its publish is done, as the person asked: the publish turn
 * leaves a mark (`publish-close/<game>.json` in the plugin's storage) when Roblox has the publish,
 * and the end of that turn quits each Studio whose command line opened this game's place, by its
 * file or its published place id. A Mac runs one Studio per place, so another place's Studio stays
 * open, and Studio's own quit keeps its save question the person's. The agent's own close-up in the
 * publish skill comes first; this one closes what it left.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { isGameId } from "./studio-binding.ts";
import { type LaunchDeps, quitLaunch } from "./studio-launch.ts";
import { studioPids } from "./studio-locate.ts";

/** How long after its publish a turn's end still closes the game's Studio. */
export const CLOSE_MARK_MS = 30 * MINUTE_MS;
const CLOSE_FOLDER = "publish-close";
const MAX_MARK_BYTES = 1024;
const PS = "/bin/ps";

const markFile = (storage: string, game: string) => path.join(storage, CLOSE_FOLDER, `${game}.json`);

/** The place a game builds in, as Studio's command line names it: its file, its published id. */
export interface ClosePlace {
  file?: string;
  placeId?: string;
}

/** Marks the game's Studio to close as this turn ends: its publish is on Roblox. */
export async function markClose(storage: string, game: string, now: number): Promise<void> {
  if (!isGameId(game)) return;
  await mkdir(path.join(storage, CLOSE_FOLDER), { recursive: true, mode: 0o700 });
  await atomicWriteJson(markFile(storage, game), { at: now });
}

/** Whether the game's Studio is marked to close, taking the mark: true once per publish, within its limit. */
export async function takeClose(storage: string, game: string, now: number): Promise<boolean> {
  if (!isGameId(game)) return false;
  const file = markFile(storage, game);
  const mark = await readRegularFile(file, MAX_MARK_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (mark === undefined) return false;
  await rm(file, { force: true });
  if (!isJsonObject(mark) || !Number.isSafeInteger(mark.at)) return false;
  const age = now - (mark.at as number);
  return age >= 0 && age <= CLOSE_MARK_MS;
}

/** Whether a Studio's command line opened `place`: its file exactly, or its published place id. */
export function opensPlace(command: string, place: ClosePlace): boolean {
  const args = ` ${command.trim()} `;
  if (place.file && args.endsWith(` --localPlaceFile ${place.file} `)) return true;
  if (place.file && args.includes(` --localPlaceFile ${place.file} --`)) return true;
  return place.placeId !== undefined && args.includes(` --placeId ${place.placeId} `);
}

/** The open Studios (on a Mac) whose command line opened `place`. */
export async function placeStudioPids(deps: LaunchDeps, place: ClosePlace): Promise<number[]> {
  const pids: number[] = [];
  for (const pid of await studioPids(deps)) {
    const answer = await deps.run(PS, ["-o", "command=", "-p", String(pid)]).catch(() => undefined);
    if (answer?.code === 0 && opensPlace(answer.stdout, place)) pids.push(pid);
  }
  return pids;
}

/** Asks each Studio holding `place` to quit, as Studio's own quit does; the pids asked. */
export async function closePlaceStudios(deps: LaunchDeps, place: ClosePlace): Promise<number[]> {
  const pids = await placeStudioPids(deps, place);
  for (const pid of pids) {
    const quit = quitLaunch(deps.platform, deps.env, pid);
    await deps.run(quit.file, quit.args).catch(() => undefined);
  }
  return pids;
}
