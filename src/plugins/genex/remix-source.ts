/**
 * A game's project as remixers get it: the files its own git would keep (tracked, or new and not
 * ignored), copied out of the game folder into a folder of Studio's that the Genex CLI pushes as the
 * game's source. Never part of it: history, Studio's and Genex's own folders, installed packages, agent
 * settings, secrets, and an engine's caches and builds (and, for an engine game, Genex's copies of its
 * assets and the agents' proof screenshots). The folder is written by agents, so only a
 * real file inside it is copied: a link, or a path that leads out of it, is left behind. A project too
 * big for Genex's source store is refused before anything is pushed. A model, picture, sound, video or
 * Unreal package, and any file big enough to trip the upload's request limit, is named in the copy's
 * `.gitattributes`, so it goes to Git LFS (Genex keeps those blobs in its object store, not on the
 * git server's disk).
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../shared/duration.ts";
import { assetExtension, isMediaFile } from "../../shared/game-assets.ts";
import { GenexRemixProblem } from "../../shared/genex.ts";
import { HOST_GIT_CONFIG, hostGitEnv } from "../../substrate/git-policy.ts";

const exec = promisify(execFile);

/** The most Genex keeps of a game's source by default (its source store's limit for an account). */
export const SOURCE_MAX_BYTES = 5 * 1024 ** 3;
/** The most files Genex keeps of a game's source by default. */
export const SOURCE_MAX_FILES = 5_000;
/** A file at least this big goes to Git LFS by its own name: the upload refuses requests near 100 MB. */
export const LFS_FILE_BYTES = 50 * 1024 ** 2;
/** Unreal's packages and levels: binary, and most of an Unreal project's size. */
const ENGINE_PACKAGES = new Set(["uasset", "umap"]);
/** Whether a file is a binary asset, which goes to Git LFS whatever its size: media or an Unreal package. */
const isBinaryAsset = (file: string): boolean => isMediaFile(file) || ENGINE_PACKAGES.has(assetExtension(file));

/** The most git may print when it lists a game's files: a line per file. */
const LIST_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** How long git may take to list a game's files. */
const LIST_TIMEOUT_MS = MINUTE_MS;

/** Why a staging is refused: every remix problem but the CLI's own failure. */
export type StagingProblem = Exclude<GenexRemixProblem, typeof GenexRemixProblem.Failed>;

/** A project that could not be staged, with the code a caller acts on. */
export class RemixSourceError extends Error {
  readonly code: StagingProblem;
  constructor(code: StagingProblem) {
    super(`The game's project can't be sent for remixing (${code})`);
    this.name = "RemixSourceError";
    this.code = code;
  }
}

/** A project as staged: how many files and bytes the copy holds. */
export interface StagedSource {
  files: number;
  bytes: number;
}

/** How a staging lists the game's own files: paths relative to the folder, with `/` between parts. */
export interface RemixSourceDeps {
  listFiles(gameDir: string): Promise<string[]>;
}

/** Folders that are never a game's own, wherever they are: history, Studio's, Genex's, packages, agent settings. */
const NEVER_FOLDERS = new Set([".git", ".studio", ".genex", "node_modules", ".claude", ".codex", ".cursor", ".agents"]);
/** Files that are never a game's own: an agent's MCP settings (which may hold keys) and Finder's notes. */
const NEVER_FILES = new Set([".mcp.json", ".DS_Store"]);
/** A secrets file: `.env` or `.env.<anything>`, except the template meant to be shared. */
const isSecretsFile = (name: string): boolean =>
  (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";

/**
 * An engine project's own caches and builds, by the file that marks the project's folder, and those
 * of each plugin in its `plugins` folder (an Unreal plugin builds its own Binaries and Intermediate).
 */
const ENGINE_CACHES: ReadonlyArray<{
  marks: (file: string) => string | null;
  caches: ReadonlySet<string>;
  plugins?: { folder: string; caches: ReadonlySet<string> };
}> = [
  {
    // Unity: the folder holding `ProjectSettings/ProjectVersion.txt`.
    marks: (file) => (file.endsWith("ProjectSettings/ProjectVersion.txt") ? parentOf(parentOf(file)) : null),
    caches: new Set(["Library", "Temp", "Logs", "obj", "UserSettings", "Builds"]),
  },
  {
    marks: (file) => (path.posix.basename(file) === "project.godot" ? parentOf(file) : null),
    caches: new Set([".godot", ".import"]),
  },
  {
    marks: (file) => (file.endsWith(".uproject") ? parentOf(file) : null),
    // Builds holds the apps package-game makes: what players install, never the project.
    caches: new Set(["Binaries", "Intermediate", "Saved", "DerivedDataCache", "Builds"]),
    plugins: { folder: "Plugins", caches: new Set(["Binaries", "Intermediate"]) },
  },
];

/** A path's folder, `""` at the top. */
function parentOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at < 0 ? "" : file.slice(0, at);
}

/** `folder` under `root` as a path prefix ending in `/` (`root` is `""` at the top). */
const under = (root: string, folder: string): string => (root ? `${root}/${folder}/` : `${folder}/`);

/** The plugin folders among `files` in `plugins` (a prefix ending in `/`), each as a prefix. */
function pluginFolders(files: readonly string[], plugins: string): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(plugins)) continue;
    const name = file.slice(plugins.length).split("/")[0];
    if (name && file.length > plugins.length + name.length) found.add(`${plugins}${name}`);
  }
  return found;
}

/** The cache folders of one engine project at `root`, and of its plugins, as path prefixes ending in `/`. */
function cachesAt(engine: (typeof ENGINE_CACHES)[number], root: string, files: readonly string[]): string[] {
  const own = [...engine.caches].map((cache) => under(root, cache));
  if (!engine.plugins) return own;
  const { folder, caches } = engine.plugins;
  const plugins = [...pluginFolders(files, under(root, folder))];
  return [...own, ...plugins.flatMap((plugin) => [...caches].map((cache) => `${plugin}/${cache}/`))];
}

/** The cache folders of every engine project among `files`, and of its plugins, as path prefixes ending in `/`. */
function engineCaches(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    ENGINE_CACHES.flatMap((engine) => {
      const root = engine.marks(file);
      return root === null ? [] : cachesAt(engine, root, files);
    }),
  );
}

/**
 * What an engine game's remixers never need beside its engine project: Genex's copies of the game's
 * assets (`assets/`, models and sounds already imported into the project) and the screenshots agents
 * keep as proof (`docs/proof/`). Only while every engine project sits in a folder of its own (a Godot
 * project at the top keeps its `assets/`) and no web page is at the top (there the assets are the game).
 */
const ENGINE_GAME_EXTRAS = ["assets/", "docs/proof/"];
const WEB_PAGE = "index.html";

/** The engine projects' folders among `files` (`""` for one at the top). */
const engineRoots = (files: readonly string[]): string[] =>
  files.flatMap((file) =>
    ENGINE_CACHES.map((engine) => engine.marks(file)).filter((root): root is string => root !== null),
  );

/** `ENGINE_GAME_EXTRAS` as prefixes to leave out, or none for a web game or one without an engine project in a folder. */
function engineGameExtras(files: readonly string[]): string[] {
  const roots = engineRoots(files);
  const engineGame = roots.length > 0 && !roots.includes("") && !files.includes(WEB_PAGE);
  return engineGame ? ENGINE_GAME_EXTRAS : [];
}

/** Whether `file` (relative, `/` between parts) may be part of the game's project. */
function isProjectFile(file: string, caches: readonly string[]): boolean {
  const parts = file.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (parts.slice(0, -1).some((part) => NEVER_FOLDERS.has(part))) return false;
  const name = parts[parts.length - 1] ?? "";
  if (NEVER_FILES.has(name) || isSecretsFile(name)) return false;
  return !caches.some((cache) => file.startsWith(cache));
}

/** The game's own files as its git sees them: tracked, or new and not ignored, without history. */
export async function gitListFiles(gameDir: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    [...HOST_GIT_CONFIG, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: gameDir, env: hostGitEnv(), windowsHide: true, maxBuffer: LIST_OUTPUT_MAX_BYTES, timeout: LIST_TIMEOUT_MS },
  ).catch(() => {
    throw new RemixSourceError(GenexRemixProblem.NoRepository);
  });
  return [...new Set(stdout.split("\0").filter(Boolean))];
}

/** A file of the game to copy: where it is, its size and mode, or null when it is not a real file inside the folder. */
async function realFile(root: string, file: string): Promise<{ at: string; bytes: number; mode: number } | null> {
  const at = path.join(root, ...file.split("/"));
  const info = await lstat(at).catch(() => null);
  if (!info?.isFile()) return null;
  // A folder on the way may be a link out of the game: the file must really be inside it.
  const real = await realpath(at).catch(() => null);
  if (!real?.startsWith(root + path.sep)) return null;
  return { at: real, bytes: info.size, mode: info.mode & 0o777 };
}

/** A `.gitattributes` line that sends `file` to Git LFS by its own name, or null when the name can't be written there. */
function lfsLine(file: string): string | null {
  // Quoted C-style, anchored at the top: control characters have no safe spelling, so such a file stays out.
  if (/[\u0000-\u001f\u007f]/.test(file)) return null;
  return `"/${file.replace(/[\\"]/g, (c) => `\\${c}`)}" filter=lfs diff=lfs merge=lfs -text`;
}

/** Name the big files in the copy's `.gitattributes`, after whatever the game's own says. */
async function routeBigFiles(dest: string, big: readonly string[]): Promise<void> {
  const lines = big.map(lfsLine).filter((line): line is string => line !== null);
  if (lines.length === 0) return;
  const file = path.join(dest, ".gitattributes");
  const own = await readFile(file, "utf8").catch(() => "");
  const lead = own && !own.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${own}${lead}${lines.join("\n")}\n`);
}

/**
 * Copy `gameDir`'s project into `dest`, which is made afresh (anything there before goes): the files
 * its git would keep, without what is never a game's own. Refused, with nothing copied, when the
 * folder has no repository, holds nothing of its own, or is more than Genex keeps.
 */
export async function stageRemixSource(
  gameDir: string,
  dest: string,
  deps: RemixSourceDeps = { listFiles: gitListFiles },
): Promise<StagedSource> {
  const root = await realpath(gameDir);
  const listed = await deps.listFiles(root);
  const caches = [...engineCaches(listed), ...engineGameExtras(listed)];
  const files: Array<{ file: string; at: string; bytes: number; mode: number }> = [];
  for (const file of listed.filter((candidate) => isProjectFile(candidate, caches))) {
    const real = await realFile(root, file);
    if (real) files.push({ file, ...real });
  }
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (files.length === 0) throw new RemixSourceError(GenexRemixProblem.Empty);
  if (files.length > SOURCE_MAX_FILES || bytes > SOURCE_MAX_BYTES) throw new RemixSourceError(GenexRemixProblem.TooBig);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const file of files) {
    const to = path.join(dest, ...file.file.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    // A clone on APFS: a big engine project costs no extra disk and no time to copy.
    await copyFile(file.at, to, constants.COPYFILE_FICLONE);
    await chmod(to, file.mode);
  }
  await routeBigFiles(
    dest,
    files.filter((file) => file.bytes >= LFS_FILE_BYTES || isBinaryAsset(file.file)).map((file) => file.file),
  );
  return { files: files.length, bytes };
}
