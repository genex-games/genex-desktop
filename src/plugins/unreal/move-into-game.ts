/**
 * Move into game: the open game's own Unreal project, which lies in another folder, becomes the
 * game's `unreal/` folder, where Rewind, Loops and Publish reach it. What may move, and why a
 * project stays, is the host's rule for every engine (`substrate/plugins/engine-move.ts`); here is
 * what an Unreal project's own folder is, and what names its path once it has moved.
 */
import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  type MoveInFacts,
  type MoveInPlan,
  planMoveIn as planEngineMove,
} from "../../substrate/plugins/engine-move.ts";
import { rememberChoice } from "./editor-port.ts";
import { GAME_PROJECT_FOLDER, ignoreUnrealScratch, readGameIgnore, restoreGameIgnore } from "./game-folder.ts";
import { UPROJECT_EXTENSION } from "./project-file.ts";
import { moveSetupRecord } from "./setup.ts";

export { type MoveInPlan, MoveInRefusal } from "../../substrate/plugins/engine-move.ts";

/** The folders every Unreal project has; a folder without them is not a project's own. */
const PROJECT_FOLDERS = ["Config", "Content"] as const;

/** Whether `folder` holds a project and nothing else's: Unreal's own folders, and one project file. */
async function isProjectFolder(folder: string): Promise<boolean> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const folders = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const projects = entries.filter((entry) => entry.name.endsWith(UPROJECT_EXTENSION));
  return projects.length === 1 && PROJECT_FOLDERS.every((name) => folders.has(name));
}

/** Decides a move without changing anything: Unreal's project folder, into the game's `unreal/`. */
export const planMoveIn = (facts: MoveInFacts): Promise<MoveInPlan> =>
  planEngineMove(facts, { folder: GAME_PROJECT_FOLDER, isProjectFolder });

/** A planned move and what names the project's path. */
export type MoveIn = {
  plan: { from: string; target: string };
  /** The project's real `.uproject` before the move. */
  file: string;
  /** The open game's folder. */
  game: string;
  /** The plugin's storage, which keeps setup's record and the panel's choice. */
  storage: string;
  /** Links the open game to the project's new `.uproject`. */
  link: (project: string) => Promise<unknown>;
};

/**
 * Moves the project's folder into the game and carries what names its path: the game's ignore
 * lines for Unreal's scratch folders, setup's record, the game's link and the panel's choice.
 * A step that fails after the rename moves the folder back, so the project is never left where
 * nothing names it. Answers the project's new `.uproject`.
 */
export async function moveIntoGame(move: MoveIn): Promise<string> {
  const { from, target } = move.plan;
  const ignore = await readGameIgnore(move.game);
  const moved = path.join(target, path.basename(move.file));
  try {
    await ignoreUnrealScratch(move.game);
    await rename(from, target);
  } catch (error) {
    await restoreGameIgnore(move.game, ignore).catch(() => undefined);
    throw error;
  }
  try {
    await moveSetupRecord(move.file, moved, move.storage);
    await move.link(moved);
  } catch (error) {
    await moveSetupRecord(moved, move.file, move.storage).catch(() => undefined);
    await rename(target, from).catch(() => undefined);
    await restoreGameIgnore(move.game, ignore).catch(() => undefined);
    throw error;
  }
  await rememberChoice(move.storage, moved).catch(() => undefined);
  return moved;
}
