/**
 * A reference the host issues for a file a running Loop delivered into one of its build workspaces
 * (its integration worktree, or a worker's copy) and the game folder does not hold yet:
 * `@build/<runId>/<workspace>/<file>`. The Assets stage reads it like any asset (`ProjectAsset.assetRef`);
 * the host resolves the workspace among the game's own worktrees, never from a path the page sends.
 */

export const BUILD_REF_PREFIX = "@build/";

/** A run id or a workspace's name: one plain path segment. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A build reference's parts: the run, its workspace's folder name, and the game-relative file. */
export interface BuildRef {
  runId: string;
  workspace: string;
  file: string;
}

/** Whether a value is a build reference (its parts still to be checked by `parseBuildRef`). */
export function isBuildRef(value: unknown): value is `@build/${string}` {
  return typeof value === "string" && value.startsWith(BUILD_REF_PREFIX);
}

/** The reference of `file` in run `runId`'s workspace `workspace`. */
export function buildRef(runId: string, workspace: string, file: string): string {
  return `${BUILD_REF_PREFIX}${runId}/${workspace}/${file}`;
}

/**
 * A build reference's parts, or null for any that is not plainly one: a run or workspace that is
 * not one segment, a file that is empty, absolute, or steps out with `..`.
 */
export function parseBuildRef(ref: unknown): BuildRef | null {
  if (!isBuildRef(ref)) return null;
  const [runId = "", workspace = "", ...path] = ref.slice(BUILD_REF_PREFIX.length).split("/");
  const plain = path.length > 0 && path.every((part) => part !== "" && part !== "." && part !== "..");
  if (!SEGMENT.test(runId) || !SEGMENT.test(workspace) || !plain || ref.includes("\0")) return null;
  return { runId, workspace, file: path.join("/") };
}
