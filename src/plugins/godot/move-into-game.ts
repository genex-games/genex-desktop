/**
 * Move into game: the open game's own Godot project, which lies in another folder, becomes the
 * game's `godot/` folder, where Rewind and Loops reach it. What may move, and why a project stays,
 * is the host's rule for every engine (`substrate/plugins/engine-move.ts`); here is what a Godot
 * project's own folder is, which games build in it, and the move itself.
 */
import { lstat, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_LINKS_FOLDER } from "../../shared/plugins.ts";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import {
  type MoveInFacts,
  type MoveInPlan,
  planMoveIn as planEngineMove,
} from "../../substrate/plugins/engine-move.ts";
import { GAME_PROJECT_FOLDER, PROJECT_FILE } from "./game-project.ts";

export { type MoveInPlan, MoveInRefusal } from "../../substrate/plugins/engine-move.ts";

/** The engine a Godot link names. */
const GODOT_KIND = "godot";
const LINK_SUFFIX = ".json";
/** The most of a link record Genex reads: the host writes a few short fields. */
const LINK_MAX_BYTES = 16 * 1024;
/**
 * The person's own folders in their home. A `project.godot` dropped in one makes all of it a
 * project to Godot, and still not a folder to move into a game.
 */
const HOME_FOLDERS: ReadonlySet<string> = new Set([
  "Applications",
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Videos",
]);
/** The file that keeps Godot's cache out of a game's save points, and its lines (a new project's own). */
const IGNORE_FILE = ".gitignore";
const IGNORE_TEXT = "# Godot rebuilds this cache from the project; it is never shared.\n.godot/\n";

/** Whether `folder` is a Godot project's own: it holds `project.godot` and is none of the person's own home folders. */
async function isProjectFolder(folder: string, home: string): Promise<boolean> {
  if (path.dirname(folder) === home && HOME_FOLDERS.has(path.basename(folder))) return false;
  return (await lstat(path.join(folder, PROJECT_FILE)).catch(() => null))?.isFile() === true;
}

/** Decides a move without changing anything: Godot's project folder, into the game's `godot/`. */
export const planMoveIn = (facts: MoveInFacts): Promise<MoveInPlan> =>
  planEngineMove(facts, { folder: GAME_PROJECT_FOLDER, isProjectFolder });

/** The project file a game's link record names, when the record is a Godot link. */
async function linkedFile(file: string): Promise<string | undefined> {
  const record = await readRegularFile(file, LINK_MAX_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(record) || record.kind !== GODOT_KIND) return undefined;
  return typeof record.project === "string" ? record.project : undefined;
}

/**
 * The Genex games whose link names the project in `folder` (its real path), by id: the links the
 * host keeps in the plugin's storage, which agents can't write. Only reads.
 */
export async function gamesLinkedTo(storage: string, folder: string): Promise<string[]> {
  const links = path.join(storage, ENGINE_LINKS_FOLDER);
  const names = (await readdir(links).catch(() => [] as string[])).filter((name) => name.endsWith(LINK_SUFFIX));
  const project = path.join(folder, PROJECT_FILE);
  const linked: string[] = [];
  for (const name of names)
    if ((await linkedFile(path.join(links, name))) === project) linked.push(name.slice(0, -LINK_SUFFIX.length));
  return linked;
}

/** A planned move and what names the project's path. */
export type MoveIn = {
  plan: { from: string; target: string };
  /** Links the open game to the project in its new folder. */
  link: (folder: string) => Promise<unknown>;
};

/**
 * Moves the project's folder into the game and links the game to it there. A link that fails moves
 * the folder back, so the project is never left where nothing names it. A project with no ignore
 * file of its own gets Godot's, so its cache stays out of the game's save points. Answers the
 * project's new folder.
 */
export async function moveIntoGame(move: MoveIn): Promise<string> {
  const { from, target } = move.plan;
  await rename(from, target);
  try {
    await move.link(target);
  } catch (error) {
    await rename(target, from).catch(() => undefined);
    throw error;
  }
  // `wx`: only a project with no ignore file gets one; its own is never rewritten.
  await writeFile(path.join(target, IGNORE_FILE), IGNORE_TEXT, { flag: "wx" }).catch(() => undefined);
  return target;
}
