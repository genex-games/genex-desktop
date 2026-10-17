/**
 * A game's Godot project and the paths an agent names in it. The project is the folder holding
 * `project.godot`: the game's own root (a Godot folder opened as a game), else `godot/` (where New
 * Godot game makes one), else the nearest one a few folders down. Everything is checked by real
 * path inside the game, so a link never leads Godot out of it. A scene is named the way Godot names
 * it (`res://levels/one.tscn`) or relative to the project; it must be a scene file that is there.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isInside } from "../../substrate/paths.ts";

/** The folder in a game New Godot game makes its project in. */
export const GAME_PROJECT_FOLDER = "godot";
/** The file that makes a folder a Godot project. */
export const PROJECT_FILE = "project.godot";
/** How deep below the game a project is looked for. */
const SEARCH_DEPTH = 3;
/** Folders never searched: Godot's cache, dependencies and hidden folders. */
const NEVER_SEARCHED = new Set(["node_modules", "Library", "Saved", "Intermediate"]);
const RES_PREFIX = "res://";
const SCENE_EXTENSIONS = new Set([".tscn", ".scn"]);
/** The longest scene path an agent may name. */
const SCENE_PATH_CHARS = 200;
/** The first character code a scene path may use: below it are control characters. */
const FIRST_PRINTABLE = 0x20;

const MESSAGE = {
  NoGame: "Open a game in Genex first: a Godot project is a game's.",
  NoProject:
    "This game has no Godot project (project.godot) yet. Make one with godot__new-game, or open a folder that has one.",
  BadScene: (scene: string) =>
    `${scene} isn't a scene of this project: name a .tscn or .scn file inside it, such as res://main.tscn.`,
  NoScene: (scene: string) => `This project has no scene ${scene}.`,
} as const;

/** Why an agent's request about a game's project was refused: the words it reads. */
export class ProjectError extends Error {}

const isDirectory = async (folder: string) => (await lstat(folder).catch(() => null))?.isDirectory() === true;
const isFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;

/** The folders below `folder` to look in, hidden and generated ones left out, in name order. */
async function childFolders(folder: string): Promise<string[]> {
  const found = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return found
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NEVER_SEARCHED.has(entry.name))
    .map((entry) => path.join(folder, entry.name))
    .sort();
}

/** The nearest folder below `folder` (breadth first, at most `depth` down) holding a project file. */
async function nearestProject(folder: string, depth: number): Promise<string | null> {
  let level = [folder];
  for (let down = 0; down <= depth && level.length > 0; down++) {
    for (const candidate of level) if (await isFile(path.join(candidate, PROJECT_FILE))) return candidate;
    level = (await Promise.all(level.map(childFolders))).flat();
  }
  return null;
}

/** The game's Godot project folder by its real path, or null when it has none inside it. */
export async function findGameProject(gameDir: string): Promise<string | null> {
  const game = await realpath(gameDir).catch(() => null);
  if (!game) return null;
  const preferred = path.join(game, GAME_PROJECT_FOLDER);
  const ordered = [game, ...((await isDirectory(preferred)) ? [preferred] : [])];
  for (const candidate of ordered) if (await isFile(path.join(candidate, PROJECT_FILE))) return candidate;
  const found = await nearestProject(game, SEARCH_DEPTH);
  const real = found ? await realpath(found).catch(() => null) : null;
  return real && isInside(game, real) ? real : null;
}

/** The game's project, or why there is none: no game bound, or no project in it. */
export async function requireGameProject(gameDir: string | undefined): Promise<string> {
  if (!gameDir) throw new ProjectError(MESSAGE.NoGame);
  const project = await findGameProject(gameDir);
  if (!project) throw new ProjectError(MESSAGE.NoProject);
  return project;
}

/** Whether a path has no backslash and no control character. */
const isPlainPath = (text: string) => [...text].every((c) => c !== "\\" && c.charCodeAt(0) >= FIRST_PRINTABLE);

/** A scene path as an agent wrote it, as a project-relative path, or null when its shape is wrong. */
function sceneRelative(asked: string): string | null {
  const text = asked.trim();
  if (!text || text.length > SCENE_PATH_CHARS || !isPlainPath(text)) return null;
  const relative = text.startsWith(RES_PREFIX) ? text.slice(RES_PREFIX.length) : text;
  if (!relative || path.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === ""))
    return null;
  return SCENE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) ? relative : null;
}

/**
 * The scene an agent names, as Godot names it (`res://…`), once it is a scene file inside the
 * project by its real path; an empty name is the project's main scene, answered as "".
 */
export async function projectScene(project: string, asked: string): Promise<string> {
  if (!asked.trim()) return "";
  const relative = sceneRelative(asked);
  if (!relative) throw new ProjectError(MESSAGE.BadScene(asked.trim()));
  const real = await realpath(path.join(project, ...relative.split("/"))).catch(() => null);
  if (!real || !isInside(project, real) || !(await isFile(real))) throw new ProjectError(MESSAGE.NoScene(asked.trim()));
  return `${RES_PREFIX}${relative}`;
}
