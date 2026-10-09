/**
 * Whether the game folder changed while a worker wrote in place: a fingerprint of its working tree
 * (what `git add -A` would stage, ignored files left out) as the worker starts and as it ends. The
 * fingerprint is a tree id written through a throwaway index beside the game's own, never the real
 * one, so the person's and the lead's staged work is untouched. It sees the folder, not who wrote
 * in it: the lead or the person changing it at the same time counts too.
 */
import type { HarnessCtx } from "../../types/harness.d.ts";
import { GIT_TIMEOUT_MS } from "../config.ts";
import { gitExec } from "../git.ts";

/** A tree id, as `git write-tree` prints one. */
const TREE_ID = /^[0-9a-f]{40,64}$/;

/** One fingerprint's throwaway index in the game's git folder, apart from any other at once. */
let fingerprints = 0;

/**
 * The command line only the pool runs. The throwaway index starts as a copy of the game's own, so
 * only files changed since are read again; it is removed whatever happens.
 */
const CHANGE_GIT = {
  workingTree: (index: string): string =>
    `idx="$(git rev-parse --git-path ${index})" && rm -f "$idx" && { cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null; GIT_INDEX_FILE="$idx" git add -A && GIT_INDEX_FILE="$idx" git write-tree; }; code=$?; rm -f "$idx"; exit $code`,
} as const;

/** The game folder's working tree as one id, or null when git couldn't say. */
export async function gameFingerprint(ctx: HarnessCtx, project: string): Promise<string | null> {
  fingerprints += 1;
  const index = `genex-fingerprint-${process.pid}-${fingerprints}.index`;
  const exec = await gitExec(ctx, { project }, CHANGE_GIT.workingTree(index), {
    timeoutMs: GIT_TIMEOUT_MS.slow,
  }).catch(() => null);
  const tree = String(exec?.stdout ?? "").trim();
  return exec?.code === 0 && TREE_ID.test(tree) ? tree : null;
}

/** Whether the folder changed between two fingerprints; null when either is unknown. */
export function changedBetween(start: string | null | undefined, end: string | null): boolean | null {
  if (!start || !end) return null;
  return start !== end;
}
