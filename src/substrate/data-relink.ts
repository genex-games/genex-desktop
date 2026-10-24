/**
 * After Genex's data moved to another folder: what named a place in the old folder names the same
 * place in the new one. The library's index and the games folder setting keep absolute folders
 * (a game Genex keeps a copy of lives in its data); and every build copy is a Git worktree whose
 * `.git` file names its repository's folder, while that repository names the copy's folder back.
 * Git's own `worktree repair` mends the second link once the first is right.
 */
import { lstat, readdir, readFile, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { EngineId } from "../shared/providers.ts";
import { claudeProjectDirName } from "./engines/claude-permissions.ts";
import { atomicWriteText, readJsonIfExists } from "./fsx.ts";
import { isInside } from "./paths.ts";
import { gitOrNull } from "./snapshots.ts";

/** Claude Code's config home under the data folder, as the core makes it (`engine-homes/claude-code`). */
const CLAUDE_HOME: readonly string[] = ["engine-homes", EngineId.ClaudeCode];
/**
 * The files in the data folder that keep absolute folders, by their path in it: the library's
 * index, the games folder setting, and Claude Code's own config (its per-folder settings).
 */
export const PATH_KEEPING_FILES: readonly string[] = [
  "projects.json",
  "games-root.json",
  path.join(...CLAUDE_HOME, ".claude.json"),
];
/** How deep under the data folder a link Genex makes can sit (`scratch/builds/<shadow>/node_modules`). */
const LINK_DEPTH = 6;
/** How deep under the data folder a build copy can sit (`scratch/autopilot/<run>/<seat>/…`). */
const WORKTREE_DEPTH = 6;
/** Folders a build copy never sits in, and which can hold many thousand entries. */
const NOT_WORKTREE_HOMES: ReadonlySet<string> = new Set(["node_modules", ".git"]);
/** How a worktree's `.git` file names its repository's folder. */
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/** `value` with every absolute path inside `from` moved to the same place inside `to`, keys included. */
export function rebasePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return rebasePath(value, from, to);
  if (Array.isArray(value)) return value.map((item) => rebasePaths(item, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [rebasePath(key, from, to), rebasePaths(item, from, to)]),
  );
}

function rebasePath(text: string, from: string, to: string): string {
  if (!path.isAbsolute(text) || !isInside(from, text)) return text;
  const rebased = path.join(to, path.relative(from, text));
  // A Windows path written with forward slashes (as Claude Code keys its folders) keeps them.
  return path.sep === "\\" && text.includes("/") && !text.includes("\\") ? rebased.replaceAll("\\", "/") : rebased;
}

/** Rewrite each path-keeping file in `dir` (the new data folder) whose paths pointed into `from`. */
export async function rebaseDataFiles(dir: string, from: string): Promise<string[]> {
  const changed: string[] = [];
  for (const name of PATH_KEEPING_FILES) {
    const file = path.join(dir, name);
    const value = await readJsonIfExists<unknown>(file).catch(() => null);
    if (value === null) continue;
    const rebased = rebasePaths(value, from, dir);
    if (JSON.stringify(rebased) === JSON.stringify(value)) continue;
    await atomicWriteText(file, `${JSON.stringify(rebased, null, 2)}\n`);
    changed.push(name);
  }
  return changed;
}

/** The build copies under `dir`: folders holding a `.git` file, not descending into one. */
export async function findWorktrees(dir: string, depth = WORKTREE_DEPTH): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, left: number): Promise<void> => {
    const names = await readdir(folder).catch((): string[] => []);
    if (
      names.includes(".git") &&
      (await lstat(path.join(folder, ".git")).then(
        (info) => info.isFile(),
        () => false,
      ))
    ) {
      found.push(folder);
      return;
    }
    if (left === 0) return;
    for (const name of names) {
      if (NOT_WORKTREE_HOMES.has(name)) continue;
      const child = path.join(folder, name);
      const isFolder = await lstat(child).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (isFolder) await walk(child, left - 1);
    }
  };
  await walk(dir, depth);
  return found.sort();
}

/**
 * Point each build copy under `dir` back at its repository: a `.git` file naming a repository that
 * moved too (the harness's own, a game Genex keeps a copy of) is rewritten to the new folder, then
 * Git repairs the repository's link to the copy. The copies Git could not repair.
 */
export async function repairWorktrees(dir: string, from: string): Promise<string[]> {
  const failed: string[] = [];
  for (const worktree of await findWorktrees(dir)) {
    const dotGit = path.join(worktree, ".git");
    const text = await readFile(dotGit, "utf8").catch(() => "");
    const named = GITDIR_LINE.exec(text)?.[1];
    if (!named) continue;
    const rebased = rebasePath(named, from, dir);
    if (rebased !== named) await atomicWriteText(dotGit, `gitdir: ${rebased}\n`);
    if ((await gitOrNull(worktree, ["worktree", "repair"])) === null) failed.push(worktree);
  }
  return failed;
}

/** What repointing links did: how many it repointed, and the ones it could not. */
export interface Relinked {
  repointed: number;
  failed: string[];
}

/** The links under `dir`, down to `depth`, not entering a link, `.git` or a real `node_modules`. */
async function findLinks(dir: string, depth = LINK_DEPTH): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, left: number): Promise<void> => {
    for (const name of await readdir(folder).catch((): string[] => [])) {
      const child = path.join(folder, name);
      const info = await lstat(child).catch(() => null);
      if (info?.isSymbolicLink()) found.push(child);
      const descends = info?.isDirectory() && left > 0 && !NOT_WORKTREE_HOMES.has(name);
      if (descends) await walk(child, left - 1);
    }
  };
  await walk(dir, depth);
  return found.sort();
}

/**
 * Repoint each link under `dir` (the new data folder) whose target was inside `from` at the same
 * place inside `dir`: a build copy's `node_modules` linked to a game Genex keeps a copy of, a build
 * shadow's linked to a copy in scratch. Links to anything else are left as they are.
 */
export async function relinkLinks(dir: string, from: string): Promise<Relinked> {
  const result: Relinked = { repointed: 0, failed: [] };
  for (const link of await findLinks(dir)) {
    const target = await readlink(link).catch(() => "");
    const rebased = rebasePath(target, from, dir);
    if (rebased === target) continue;
    const isFolder = await stat(rebased).then(
      (info) => info.isDirectory(),
      () => false,
    );
    try {
      await rm(link, { force: true });
      await symlink(rebased, link, isFolder ? "junction" : "file");
      result.repointed++;
    } catch {
      result.failed.push(link);
    }
  }
  return result;
}

/** The folders under `dir` a Claude Code session may have worked in: build copies, the harness, games kept there. */
async function sessionFolders(dir: string): Promise<string[]> {
  const index = await readJsonIfExists<{ aliases?: Record<string, unknown> }>(path.join(dir, "projects.json")).catch(
    () => null,
  );
  const games = Object.values(index?.aliases ?? {}).filter(
    (folder): folder is string => typeof folder === "string" && path.isAbsolute(folder) && isInside(dir, folder),
  );
  return [...new Set([...(await findWorktrees(dir)), path.join(dir, "workspaces", "harness"), ...games])];
}

/**
 * Claude Code keeps each working folder's sessions under its config home's `projects/`, named
 * from the folder's path: a moved folder's sessions are renamed for its new path, so resuming a
 * chat or a worker there finds them. Only folders that exist in the new data folder are matched,
 * by their exact old path, so a neighbour with a similar name is never taken for one. The number
 * of folders whose sessions moved.
 */
export async function moveClaudeProjects(dir: string, from: string): Promise<number> {
  const projects = path.join(dir, ...CLAUDE_HOME, "projects");
  let moved = 0;
  for (const folder of await sessionFolders(dir)) {
    const oldName = claudeProjectDirName(path.join(from, path.relative(dir, folder)));
    const newName = claudeProjectDirName(folder);
    if (oldName === newName) continue;
    const there = await lstat(path.join(projects, oldName)).catch(() => null);
    const taken = await lstat(path.join(projects, newName)).catch(() => null);
    if (!there?.isDirectory() || taken) continue;
    await rename(path.join(projects, oldName), path.join(projects, newName));
    moved++;
  }
  return moved;
}
