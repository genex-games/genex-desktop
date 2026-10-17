/**
 * An Unreal project inside a Genex game's folder: New game, made from an open game, puts the
 * project in `<game>/unreal/`, so the game's checkpoints, Rewind and landing cover it. The game's
 * `.gitignore` gets Unreal's scratch and build folders first, so no snapshot sweeps them in. The
 * game folder is the user's, so nothing is written through a link and nothing is replaced.
 */
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CreateError, CreateErrorCode } from "./create-project.ts";

/** The project's folder inside the game. */
export const GAME_PROJECT_FOLDER = "unreal";
/** What the game's ignore file needs for a project inside it: Unreal's scratch, builds and Python caches. */
const UNREAL_IGNORES = [
  `${GAME_PROJECT_FOLDER}/Saved/`,
  `${GAME_PROJECT_FOLDER}/Intermediate/`,
  `${GAME_PROJECT_FOLDER}/DerivedDataCache/`,
  `${GAME_PROJECT_FOLDER}/Binaries/`,
  `${GAME_PROJECT_FOLDER}/Plugins/*/Intermediate/`,
  `${GAME_PROJECT_FOLDER}/Plugins/*/Binaries/`,
  "__pycache__/",
] as const;
const IGNORE_FILE = ".gitignore";
/** How often, and how far apart, a failed step's folder is removed while Windows still holds a file. */
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_MS = 200;

const MESSAGE = {
  HasProject: "This game already has an unreal folder, so New game can't make its project there.",
  IgnoreIsLink: "This game's .gitignore is a link, so Genex won't write through it.",
} as const;

const lstatOrNull = (file: string) => lstat(file).catch(() => null);

/** Refuses a game that already has something at `unreal`, or whose ignore file isn't a plain file. */
export async function assertGameFolderFree(gameDir: string): Promise<void> {
  if (await lstatOrNull(path.join(gameDir, GAME_PROJECT_FOLDER)))
    throw new CreateError(CreateErrorCode.NameTaken, MESSAGE.HasProject);
  const ignore = await lstatOrNull(path.join(gameDir, IGNORE_FILE));
  if (ignore && !ignore.isFile()) throw new CreateError(CreateErrorCode.Link, MESSAGE.IgnoreIsLink);
}

/** Adds the lines a project inside the game needs to its ignore file; what is there stays. */
export async function ignoreUnrealScratch(gameDir: string): Promise<void> {
  await assertGameFolderFree(gameDir);
  const file = path.join(gameDir, IGNORE_FILE);
  const current = await readFile(file, "utf8").catch(() => null);
  const lines = new Set((current ?? "").split(/\r?\n/).map((line) => line.trim()));
  const missing = UNREAL_IGNORES.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  const before = current === null ? "" : `${current.replace(/\s*$/, "")}\n`;
  await writeFile(file, `${before}${missing.join("\n")}\n`);
}

/**
 * Removes the game's `unreal` folder a step that failed part-way made, so the game is as free as it
 * was: only a real folder directly inside the game, never a link (nor anything behind one).
 */
export async function removeGameProjectFolder(gameDir: string): Promise<void> {
  const folder = path.join(gameDir, GAME_PROJECT_FOLDER);
  const found = await lstatOrNull(folder);
  if (!found?.isDirectory()) return;
  const [real, game] = await Promise.all([realpath(folder), realpath(gameDir)]);
  if (path.dirname(real) !== game) return;
  await rm(real, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_MS });
}

/** Whether a step was refused because the game already had something at `unreal`: what is there was never the step's. */
export const placeTaken = (error: unknown): boolean =>
  error instanceof CreateError && error.code === CreateErrorCode.NameTaken;

/** The game's ignore file as it is now (null: it has none), for {@link undoGameProjectFolder} to put back. */
export async function readGameIgnore(gameDir: string): Promise<string | null> {
  return readFile(path.join(gameDir, IGNORE_FILE), "utf8").catch(() => null);
}

/** Puts the game's ignore file back to `before` (null: none); never through a link. */
async function restoreGameIgnore(gameDir: string, before: string | null): Promise<void> {
  const file = path.join(gameDir, IGNORE_FILE);
  if (!(await lstatOrNull(file))?.isFile()) return;
  if (before === null) await rm(file, { force: true });
  else if ((await readFile(file, "utf8")) !== before) await writeFile(file, before);
}

/**
 * Undoes a step that failed with `error`: removes the game's `unreal` folder and, given the text
 * it had when the step began (`ignore`), puts the game's ignore file back, unless the refusal says
 * the place was taken (what is there was never this call's). A cleanup that fails (Windows still
 * holding a file) never hides why the step failed: the caller rethrows `error`.
 */
export async function undoGameProjectFolder(gameDir: string, error: unknown, ignore?: string | null): Promise<void> {
  if (placeTaken(error)) return;
  await removeGameProjectFolder(gameDir).catch(() => undefined);
  if (ignore !== undefined) await restoreGameIgnore(gameDir, ignore).catch(() => undefined);
}
