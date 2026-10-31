/**
 * The game folder a Genex host tool call is bound to, by real path: the game's own folder in the
 * library, or a Studio worktree of it that git registers under Studio's scratch. Anything else is
 * refused, so `genex__package` never installs into, and `genex__cli` never reads from or writes to,
 * a folder an agent named.
 */
import { realpath } from "node:fs/promises";
import type { PluginBinding } from "../../shared/plugins.ts";
import { isBelow } from "../../substrate/paths.ts";
import { git } from "../../substrate/snapshots.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";

const WORKTREE_LINE = "worktree ";

/** Where Studio keeps a game and its worktrees. */
export interface BoundGameDeps {
  /** The game's folder in the library; throws for a name that is not a game. */
  gameDir: (project: string) => string;
  /** Studio's scratch, where its worktrees of a game live. */
  scratch: string;
}

async function gameFolder(deps: BoundGameDeps, project: string): Promise<string | null> {
  try {
    return await realpath(deps.gameDir(project));
  } catch {
    return null;
  }
}

/** Whether git lists `dir` as a worktree of `game`, and it lies under Studio's scratch. */
async function isWorktreeOf(deps: BoundGameDeps, game: string, dir: string): Promise<boolean> {
  const scratch = await realpath(deps.scratch).catch(() => null);
  if (!scratch || !isBelow(scratch, dir)) return false;
  const listing = await git(game, ["worktree", "list", "--porcelain"]).catch(() => "");
  const worktrees = listing.split("\n").filter((line) => line.startsWith(WORKTREE_LINE));
  const real = await Promise.all(worktrees.map((line) => realpath(line.slice(WORKTREE_LINE.length)).catch(() => "")));
  return real.includes(dir);
}

/** The binding's folder by real path: the game's own, or a worktree of it under Studio's scratch. */
export async function boundGameFolder(binding: PluginBinding, deps: BoundGameDeps): Promise<string> {
  const game = await gameFolder(deps, binding.project);
  const real = await realpath(binding.directory).catch(() => null);
  if (real && game && (real === game || (await isWorktreeOf(deps, game, real)))) return real;
  throw new Error(GENEX_CLI_PROMPT.ForeignFolder);
}
