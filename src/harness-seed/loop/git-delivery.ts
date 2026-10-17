/**
 * A sub-agent's delivery on its way from its copy of the game into the game folder, said to git:
 * one folder committed in the copy (`commitFolder`), what that commit holds under the folder with
 * sizes (`treeEntries`), and chosen files checked out of it into the game (`checkoutPaths`). The
 * command lines are `loop/git.ts`'s (`GIT.addFolder`, `GIT.treeEntries`, `GIT.checkoutPaths`).
 *
 * A module of its own, importing only names every `git.ts` the agent may have kept exports
 * (`GIT`, `gitAt`, `gitExec`): a kept older `git.ts` lacks the delivery's command lines, so a
 * delivery then lands nothing instead of the harness failing to load.
 */
import type { HarnessCtx } from "../types/harness.d.ts";
import { GIT_TIMEOUT_MS } from "./config.ts";
import { type ExecOptions, GIT, gitAt, gitExec, type Where } from "./git.ts";
import { isCommit } from "./shell.ts";

/** The delivery's command lines, as `git.ts` builds them (absent from a kept older copy). */
type DeliveryLines = {
  addFolder?: (folder: string) => string;
  treeEntries?: (rev: unknown, folder: string) => string;
  checkoutPaths?: (rev: unknown, files: readonly string[]) => string;
};

/** The delivery's command lines, or a throw naming the one this `git.ts` doesn't build. */
function line<K extends keyof DeliveryLines>(name: K): NonNullable<DeliveryLines[K]> {
  const built = (GIT as DeliveryLines)[name];
  if (typeof built !== "function") throw new Error(`git.ts builds no ${name} command line`);
  return built as NonNullable<DeliveryLines[K]>;
}

/**
 * Commits one folder of a worktree under the studio's name (an empty commit when nothing in it
 * changed) and answers the commit, or null when git refused: what a sub-agent delivered, in its
 * copy, kept where its files can be checked out from.
 */
export async function commitFolder(
  ctx: HarnessCtx,
  at: Where,
  folder: string,
  message: string,
  { label = null, timeoutMs = GIT_TIMEOUT_MS.slow }: ExecOptions = {},
): Promise<string | null> {
  const options = { label, timeoutMs, trim: "both" as const };
  try {
    await gitAt(ctx, at, line("addFolder")(folder), options);
    await gitAt(ctx, at, GIT.commit(message, { allowEmpty: true }), options);
    const head = await gitAt(ctx, at, GIT.head, options);
    return isCommit(head) && head !== "HEAD" ? head : null;
  } catch {
    return null;
  }
}

/** The entries `rev` holds under `folder` (`GIT.treeEntries`), one each; none when git refused. */
export async function treeEntries(
  ctx: HarnessCtx,
  at: Where,
  rev: unknown,
  folder: string,
  { label = null, timeoutMs = GIT_TIMEOUT_MS.quick }: ExecOptions = {},
): Promise<string[]> {
  try {
    const exec = await gitExec(ctx, at, line("treeEntries")(rev, folder), { label, timeoutMs });
    return exec?.code === 0
      ? String(exec.stdout ?? "")
          .split("\0")
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/** Checks `files` out of `rev` into the worktree; whether git did. A refused revision is a no. */
export async function checkoutPaths(
  ctx: HarnessCtx,
  at: Where,
  rev: unknown,
  files: readonly string[],
  { label = null, timeoutMs = GIT_TIMEOUT_MS.slow }: ExecOptions = {},
): Promise<boolean> {
  if (!files.length) return false;
  try {
    const exec = await gitExec(ctx, at, line("checkoutPaths")(rev, files), { label, timeoutMs });
    return exec?.code === 0;
  } catch {
    return false;
  }
}
