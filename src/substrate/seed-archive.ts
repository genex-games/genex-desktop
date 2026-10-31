/**
 * The archive on upgrade (phase 5). Upgrading into {@link ARCHIVE_EPOCH}, the seed pass moves what
 * the runs learned, and the agent's edits of harness files the new seed removes or changes, into
 * `<harness workspace>/archive/<date>/` at their own paths, and lays the seed's copies down. Nothing
 * reads the archive: it is kept for the person and the agent to look at, never injected. It happens
 * once per epoch; between epochs a seed upgrade keeps the agent's edits (seed-upgrade.ts).
 *
 * The workspace is the agent's and may hold links: a file is moved with `rename`, which moves a
 * link as a link, and the archive folder must resolve inside the workspace or nothing is archived.
 */
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { isBelow } from "./paths.ts";

/** The seed generation that archives on upgrade; a manifest records the last one it reached. */
export const ARCHIVE_EPOCH = 1;

/** The workspace folder archives live in, one folder per upgrade date below it. */
export const ARCHIVE_FOLDER = "archive";

/**
 * What the runs learned and wrote into the workspace, by path (a folder: everything in it): each
 * game's ledger, the contract lessons, the grown check catalogue and the recipes' statistics.
 */
export const LEARNED_PATHS: readonly string[] = [
  "library/games",
  "library/contract-lessons.md",
  "library/checks.json",
  "library/recipe-stats.json",
];

/**
 * What the runs learned into the app's own records (thread artifacts, not workspace files): the
 * agent's memory, which every prompt carried (the person's taste among it), and the
 * self-improvement edits staged for approval. Archived as `artifacts/<id>.json` by the boot.
 */
export const LEARNED_ARTIFACTS: readonly string[] = ["memory", "skillopt_staged"];

/** The folder, inside the archive, that holds the archived artifacts. */
export const ARCHIVED_ARTIFACTS_FOLDER = "artifacts";

/** What one archiving upgrade moved: its folder (workspace-relative), the learned paths and the agent's edits. */
export interface SeedArchive {
  dir: string;
  learned: string[];
  edits: string[];
}

/** `archive/<YYYY-MM-DD>` for an upgrade on `date` (UTC). */
export function archiveFolderFor(date: Date): string {
  return `${ARCHIVE_FOLDER}/${date.toISOString().slice(0, 10)}`;
}

/** Whether something (a file, a folder or a link) is at `file`, without following a link. */
async function present(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/**
 * One archive folder of a workspace, made ready to move files into: its real path must stay inside
 * the workspace, so a planted link (`archive` → somewhere else) archives nothing. Null when it
 * cannot be made or leads out.
 */
export async function openArchive(workspaceDir: string, dir: string): Promise<string | null> {
  const root = await realpath(workspaceDir).catch(() => null);
  if (root === null) return null;
  const target = path.join(root, dir);
  if (!(await insideReal(root, target))) return null;
  await mkdir(target, { recursive: true }).catch(() => null);
  return (await insideReal(root, target)) ? target : null;
}

/** Whether the real path of `target` (or of its nearest existing parent) is below `root`. */
async function insideReal(root: string, target: string): Promise<boolean> {
  let probe = target;
  while (!(await present(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const real = await realpath(probe).catch(() => null);
  return real !== null && (real === root || isBelow(root, real));
}

/**
 * Move the workspace's `rel` into the archive folder at the same path. A link moves as a link; a
 * path whose parent leads out of the workspace is left where it is. True when something moved.
 */
export async function moveIntoArchive(workspaceDir: string, archiveDir: string, rel: string): Promise<boolean> {
  const root = await realpath(workspaceDir).catch(() => null);
  if (root === null) return false;
  const source = path.join(root, rel);
  if (!(await present(source))) return false;
  if (!(await insideReal(root, path.dirname(source)))) return false;
  const target = path.join(archiveDir, rel);
  if (!(await insideReal(root, path.dirname(target)))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  if (!(await insideReal(root, path.dirname(target)))) return false;
  await rename(source, target);
  return true;
}

/** Move every learned path that is there into the archive; the ones that moved. */
export async function archiveLearned(workspaceDir: string, archiveDir: string): Promise<string[]> {
  const moved: string[] = [];
  for (const rel of LEARNED_PATHS) if (await moveIntoArchive(workspaceDir, archiveDir, rel)) moved.push(rel);
  return moved;
}
