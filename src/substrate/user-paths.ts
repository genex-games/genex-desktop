/**
 * Paths the user types into chat — the Cursor/Codex equivalent of "this is the folder".
 *
 * A draft chat that names an existing directory should work *there*, not spawn a twin under
 * `~/AI Games`. A bound chat that names a folder of stills should look at those pictures where
 * they are, not copy them into `references/` and not go hunting the rest of the disk.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isImageFile } from "./game-workspace.ts";
import { StudioPlatform } from "../shared/boot.ts";

const STILL_DIR_NAMES = new Set(["ref", "refs", "references", "still", "stills", "mood", "moodboard"]);

/** Direct children of $HOME that are libraries of projects, never a project themselves. */
const BROAD_HOME_CHILDREN = new Set([
  "coding",
  "code",
  "dev",
  "developer",
  "documents",
  "desktop",
  "downloads",
  "pictures",
  "movies",
  "music",
  "library",
  "applications",
  "ai games",
  "ai-games",
]);

export interface NamedPaths {
  /** Folder to open as the project when the chat has none yet. */
  workspace: string | null;
  /** Directories of stills to look at (may sit outside the project). */
  stillRoots: string[];
  /** Image files found in those roots, or named directly. */
  stillFiles: string[];
  /** Folders of named files that are not pictures (a dropped document): the agent reads them there. */
  fileRoots: string[];
}

export function isStillDirName(name: string): boolean {
  return STILL_DIR_NAMES.has(name.trim().toLowerCase());
}

export function isTooBroad(dir: string, home = os.homedir()): boolean {
  const resolved = path.resolve(dir);
  const root = path.resolve(home);
  if (resolved === root) return true;
  if (path.parse(resolved).root === resolved) return true;
  if (path.dirname(resolved) === root && BROAD_HOME_CHILDREN.has(path.basename(resolved).toLowerCase())) {
    return true;
  }
  return false;
}

/** The home folder itself, or a drive's root. */
function isHomeOrRoot(dir: string, home: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.resolve(home) || path.parse(resolved).root === resolved;
}

/** A `file:` URL's path on this computer, or null when it is not one. */
function fileUrlPath(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** How a platform writes an absolute path, a home-relative one, and either bare in a sentence. */
interface PathSpelling {
  paths: path.PlatformPath;
  absolute: RegExp;
  home: RegExp;
  bare: RegExp;
}

const POSIX_SPELLING: PathSpelling = {
  paths: path.posix,
  absolute: /^\//,
  home: /^~\//,
  bare: /(?:^|[\s(])((?:~\/|\/)[^\s'"`]+)/g,
};

/** Windows: a drive (`C:\`, `c:/`), a UNC share (`\\server\share`) or `~\`, either slash. */
const WINDOWS_SPELLING: PathSpelling = {
  paths: path.win32,
  absolute: /^(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])/i,
  home: /^~[\\/]/,
  bare: /(?:^|[\s(])((?:~[\\/]|[a-z]:[\\/]|\\\\)[^\s'"`]+)/gi,
};

/** Absolute and `~/` paths written in a message, quoted or bare (on Windows drive and UNC paths). */
export function extractCandidatePaths(
  text: string,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const spelling = platform === StudioPlatform.Windows ? WINDOWS_SPELLING : POSIX_SPELLING;
  const found: string[] = [];
  const add = (raw: string): void => {
    let next = raw.trim().replace(/[.,;:!?]+$/g, "");
    if (spelling.home.test(next)) next = spelling.paths.join(home, next.slice(2));
    if (!spelling.absolute.test(next)) return;
    found.push(spelling.paths.normalize(next));
  };
  // A file URL carries a path with spaces whole (`file:///Users/me/level%20plan.pdf`).
  for (const match of text.matchAll(/file:\/\/[^\s'"`]+/g)) {
    const named = fileUrlPath(match[0]);
    if (named) add(named);
  }
  for (const match of text.matchAll(/['"`]([^'"`]+)['"`]/g)) {
    const inner = match[1] ?? "";
    if (spelling.absolute.test(inner) || spelling.home.test(inner)) add(inner);
  }
  for (const match of text.matchAll(spelling.bare)) {
    add(match[1] ?? "");
  }
  return [...new Set(found)];
}

/** What the named paths turned up so far: still folders, stills, and candidate workspaces in order. */
interface NamedPathsFound {
  home: string;
  stillRoots: Set<string>;
  stillFiles: Set<string>;
  fileRoots: Set<string>;
  workspaces: string[];
}

function considerWorkspace(found: NamedPathsFound, dir: string): void {
  if (isTooBroad(dir, found.home)) return;
  found.workspaces.push(dir);
}

/**
 * A named picture: it is a still, its folder a still root, and the folder (or its parent) the
 * workspace. Any other file is only read where it is: its folder joins the reads, nothing more.
 */
function addNamedFile(found: NamedPathsFound, file: string): void {
  if (!isImageFile(file)) {
    const folder = path.dirname(file);
    // A file kept loose in the home folder (or at a drive's root) is no reason to open all of it.
    if (!isHomeOrRoot(folder, found.home)) found.fileRoots.add(folder);
    return;
  }
  found.stillFiles.add(file);
  const folder = path.dirname(file);
  found.stillRoots.add(folder);
  if (isStillDirName(path.basename(folder))) considerWorkspace(found, path.dirname(folder));
  else considerWorkspace(found, folder);
}

/** A named folder: a stills folder itself, or a workspace with stills folders (and pictures) inside. */
async function addNamedDir(found: NamedPathsFound, dir: string): Promise<void> {
  if (isStillDirName(path.basename(dir))) {
    found.stillRoots.add(dir);
    considerWorkspace(found, path.dirname(dir));
    for (const file of await listImages(dir)) found.stillFiles.add(file);
    return;
  }
  considerWorkspace(found, dir);
  for (const name of STILL_DIR_NAMES) {
    const sub = path.join(dir, name);
    if (!(await existingPath(sub))) continue;
    found.stillRoots.add(sub);
    for (const file of await listImages(sub)) found.stillFiles.add(file);
  }
  for (const file of await listImages(dir, 1)) found.stillFiles.add(file);
}

export async function resolveNamedPaths(text: string, options: { home?: string } = {}): Promise<NamedPaths> {
  const home = options.home ?? os.homedir();
  const found: NamedPathsFound = {
    home,
    stillRoots: new Set(),
    stillFiles: new Set(),
    fileRoots: new Set(),
    workspaces: [],
  };

  for (const candidate of extractCandidatePaths(text, home)) {
    const resolved = await existingPath(candidate);
    if (!resolved) continue;
    const info = await stat(resolved).catch(() => null);
    if (!info) continue;
    if (info.isFile()) addNamedFile(found, resolved);
    else if (info.isDirectory()) await addNamedDir(found, resolved);
  }

  return {
    workspace: found.workspaces[0] ?? null,
    stillRoots: [...found.stillRoots],
    stillFiles: [...found.stillFiles],
    fileRoots: [...found.fileRoots],
  };
}

async function existingPath(dir: string): Promise<string | null> {
  try {
    return await realpath(dir);
  } catch {
    return null;
  }
}

async function listImages(dir: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth >= maxDepth) return;
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (isImageFile(full)) out.push(full);
    }
  };
  await walk(dir, 0);
  return out.sort();
}
