/**
 * Which Unity project a game builds in. A Unity project is a folder, not a file: the one holding
 * `ProjectSettings/ProjectVersion.txt`. Genex looks for it in the game's own folder, so the game's
 * checkpoints and Rewind cover it, with the walk and the rule the host finds the `unity-project`
 * fact by (`substrate/project-facts.ts`: a few folders deep, never through a link, never in a
 * hidden folder or an engine's scratch). Of several, the game's own folder wins, then `unity/`,
 * then the first by path.
 *
 * The backend finds the project when Genex runs it for a game and keeps what it found in the
 * plugin's storage (`projects/<game>.json`). The editor connector knows only its game's id (its
 * folder in that storage), so it reads the project there; agents can't write the record, and it is
 * believed only while its folder is still a Unity project at exactly that real path.
 */
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { CORE_FACT_RULES, CoreFact, FactSource, factsOfFiles } from "../../shared/project-facts.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists, readRegularFile } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { ruleFiles } from "../../substrate/project-facts.ts";

/** The subfolder a game's Unity project is looked for in first, after the game's own folder. */
export const GAME_PROJECT_FOLDER = "unity";
/** The folder in the plugin's storage holding each game's record, `<game>.json`. */
const RECORDS_FOLDER = "projects";
/** The folder every Unity project keeps its settings in. */
const SETTINGS_FOLDER = "ProjectSettings";
/** The file in it naming the editor the project was last saved with. */
const VERSION_FILE = "ProjectVersion.txt";
/** The most of a version file Genex reads: Unity writes two short lines. */
const VERSION_FILE_MAX_BYTES = 4096;
/** The line naming the editor version, such as `m_EditorVersion: 6000.6.0f1`. */
const EDITOR_VERSION_LINE = /^m_EditorVersion:[ \t]*([0-9A-Za-z.]{1,40})[ \t]*$/m;
/** Genex's own rule for a Unity project, so the plugin finds what the host calls `unity-project`. */
const UNITY_RULES = CORE_FACT_RULES.filter((rule) => rule.fact === CoreFact.UnityProject).map((rule) => ({
  rule,
  source: FactSource.Core,
}));
/** The game's own folder, as a fact's path spells it. */
const ROOT = ".";
/** A game id as Genex names a game's record: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** The connector's folder for a call with no game (the host's `PLUGIN_MCP_SHARED`). */
const SHARED_BRIDGE = "_shared";

const MESSAGE = { InvalidGame: "Invalid game" } as const;

/**
 * A game's Unity project: its folder and the game's own folder holding it, both by real path, and
 * the editor its version file names, when it names one.
 */
export interface UnityProject {
  root: string;
  game: string;
  editorVersion?: string;
}

/** Where a game's Unity project is, as the editor connector takes it: both folders by real path. */
export type ProjectPlace = Pick<UnityProject, "root" | "game">;

/** The project's folder as the game names it: `.` for the game's own folder, else the subfolder. */
export const folderInGame = (project: ProjectPlace): string =>
  path.relative(project.game, project.root).split(path.sep).join("/") || ".";

/** Whether `entry` is of the kind asked for and no link. */
async function isReal(entry: string, kind: "file" | "folder"): Promise<boolean> {
  const stat = await lstat(entry).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return false;
  return kind === "file" ? stat.isFile() : stat.isDirectory();
}

/** Whether `root` holds Unity's settings folder and version file, neither one a link. */
async function holdsProject(root: string): Promise<boolean> {
  const settings = path.join(root, SETTINGS_FOLDER);
  return (await isReal(settings, "folder")) && (await isReal(path.join(settings, VERSION_FILE), "file"));
}

/** The editor version a project's version file names, when it names one. */
async function editorVersionOf(root: string): Promise<string | undefined> {
  const file = path.join(root, SETTINGS_FOLDER, VERSION_FILE);
  const text = await readRegularFile(file, VERSION_FILE_MAX_BYTES).catch(() => null);
  return text ? EDITOR_VERSION_LINE.exec(text.toString("utf8"))?.[1] : undefined;
}

/** The folders of a game that hold a Unity project, as the host finds the fact: POSIX paths relative to it. */
async function projectFolders(game: string): Promise<string[]> {
  const files = await ruleFiles(game, UNITY_RULES).catch(() => []);
  return factsOfFiles(files, UNITY_RULES).map((fact) => fact.path);
}

/**
 * The Unity project in a game's folder, or undefined when it holds none: the folder itself, else
 * `unity/`, else the first by path. A folder reached through a link is not looked in.
 */
export async function findUnityProject(gameDir: string): Promise<UnityProject | undefined> {
  const game = await realpath(gameDir).catch(() => undefined);
  if (!game) return undefined;
  const folders = await projectFolders(game);
  const folder = [ROOT, GAME_PROJECT_FOLDER].find((first) => folders.includes(first)) ?? folders.sort()[0];
  if (folder === undefined) return undefined;
  const root = path.join(game, ...folder.split("/"));
  const editorVersion = await editorVersionOf(root);
  return { root, game, ...(editorVersion ? { editorVersion } : {}) };
}

/** Where a game's record is kept in the plugin's storage. */
export const projectRecordFile = (storage: string, game: string): string =>
  path.join(storage, RECORDS_FOLDER, `${game}.json`);

/** Keeps the project a game was found with for the editor connector, or forgets it when there is none. */
export async function rememberProject(
  storage: string,
  game: string,
  project: UnityProject | undefined,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!GAME_ID.test(game)) throw new Error(MESSAGE.InvalidGame);
  const file = projectRecordFile(storage, game);
  if (!project) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file, { ...project, foundAt: now().toISOString() });
}

/** Whether `folder` is spelled as a real path is: absolute, with no `.` or `..` part. */
const isPlainAbsolute = (folder: string): boolean => path.isAbsolute(folder) && path.normalize(folder) === folder;

/** `folder` when it is text naming a plainly spelled folder that is its own real path. */
async function realFolderOf(folder: unknown): Promise<string | undefined> {
  if (typeof folder !== "string" || !isPlainAbsolute(folder)) return undefined;
  return (await realpath(folder).catch(() => undefined)) === folder ? folder : undefined;
}

/**
 * The project a game's record names, while its folder is still a Unity project at exactly that real
 * path; undefined for a game with no record, or one that no longer holds. The game's folder is the
 * record's while it still holds the project, else the project's own.
 */
export async function rememberedProject(storage: string, game: string | undefined): Promise<ProjectPlace | undefined> {
  if (!game || !GAME_ID.test(game)) return undefined;
  const record = await readJsonIfExists<unknown>(projectRecordFile(storage, game)).catch(() => null);
  const fields = isJsonObject(record) ? record : {};
  const root = await realFolderOf(fields.root);
  if (!root || !(await holdsProject(root))) return undefined;
  const folder = await realFolderOf(fields.game);
  return { root, game: folder && isInside(folder, root) ? folder : root };
}

/**
 * The plugin's storage and the game an editor connector serves, from its working folder: the host
 * runs one per game in `<storage>/mcp/<game>`, and one in `_shared` for a call with no game.
 */
export function bridgeHome(cwd: string): { storage: string; game?: string } {
  const folder = path.basename(cwd);
  const storage = path.dirname(path.dirname(cwd));
  return folder === SHARED_BRIDGE ? { storage } : { storage, game: folder };
}
