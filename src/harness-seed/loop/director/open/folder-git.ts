/**
 * The git command lines an open Loop reads its game folder with: its uncommitted changes, and what it
 * holds. None writes the folder's own index or its object store. They live in a module of their own because the shipped
 * `loop/git.ts` may gain no key another module reads: an in-app agent's kept older copy would lack it.
 */

/** The git commands that read an open Loop's game folder. */
export const FOLDER_GIT = {
  /**
   * The game folder's uncommitted changes as git lists them. A nested repository's own uncommitted
   * work is left out: no commit of the folder can take it, so it would read as changed after every
   * save. A look that never writes the folder's index (`--no-optional-locks`): another chat's
   * checkpoint or a worker's git in the folder never meets its lock.
   */
  status: "git --no-optional-locks status --porcelain --ignore-submodules=dirty",
  /**
   * What the game folder holds, read without writing a thing: its commit's tree, then its uncommitted
   * changes as `status` lists them. A save point of an unchanged folder leaves both as they were (its
   * commit is empty), so a timed Loop's idle wakes are told from work by it (director/work-time.ts).
   */
  content:
    "git --no-optional-locks rev-parse HEAD: && git --no-optional-locks status --porcelain --ignore-submodules=dirty",
} as const;
