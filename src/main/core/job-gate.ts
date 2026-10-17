/**
 * A job's gate and box, by the chat's permission mode read when the job starts: Bypass runs it in
 * the Bypass worker's wider box, Auto in the box of its write roots, Accept edits and Manual ask the
 * person first and then box it, Plan holds it until the plan is approved. The never-touch list holds
 * in every box. Pure: the fence is read by the caller (`neverTouchFence`).
 */
import path from "node:path";
import { PermissionMode } from "../../shared/permissions.ts";
import type { NeverTouchList } from "../../substrate/engines/never-touch.ts";
import { isInside } from "../../substrate/paths.ts";
import { claudeFoldersIn, type SandboxPolicy } from "../../substrate/spawn.ts";

/** What a job's start does in the chat's mode. */
export const JobGate = {
  /** Bypass: it starts unasked in the home folder's box (the Bypass worker's). */
  Wide: "wide",
  /** Auto: it starts unasked in the box of its write roots. */
  Boxed: "boxed",
  /** Accept edits and Manual: the person's card first, then the box of its write roots. */
  Ask: "ask",
  /** Plan: it does not start; it belongs in the plan. */
  Plan: "plan",
} as const;
export type JobGate = (typeof JobGate)[keyof typeof JobGate];

const GATES = {
  [PermissionMode.Bypass]: JobGate.Wide,
  [PermissionMode.Auto]: JobGate.Boxed,
  [PermissionMode.AcceptEdits]: JobGate.Ask,
  [PermissionMode.Manual]: JobGate.Ask,
  [PermissionMode.Plan]: JobGate.Plan,
} as const satisfies Record<PermissionMode, JobGate>;

/** The gate a job passes in the chat's mode. */
export function jobGate(mode: PermissionMode): JobGate {
  return GATES[mode];
}

/**
 * Where a job may write and what it never reaches: its starter's write roots (already passed through
 * `writableRoots`), its never-touch list, the home folder, and the game's own folder, which every
 * sandboxed process may write, so a box whose roots do not hold it denies it.
 */
export interface JobReach {
  writeRoots: string[];
  neverTouch: NeverTouchList;
  home: string;
  gameFolder?: string;
}

/** The never-touch list as a box denies it (`neverTouchFence`). */
export interface JobFence {
  reads: string[];
  writes: string[];
}

/** The game's own folder, denied for writes when no write root is it, holds it or sits in it. */
function gameFolderDeny(reach: JobReach): string[] {
  const game = reach.gameFolder ? path.resolve(reach.gameFolder) : null;
  if (!game) return [];
  const overlaps = reach.writeRoots.some((root) => isInside(root, game) || isInside(game, root));
  return overlaps ? [] : [game];
}

/**
 * A job's box for ProcessSandbox, an overlay on the base policy (whose deny lists already hold the
 * studio's protected paths and sign-in stores, and only grow). It writes its roots (Bypass: the
 * home folder first, as the Bypass worker's box does), never the never-touch list (reads fenced
 * around the open and read-open folders, writes around the open ones) nor Claude Code's folder in a
 * root. No job reaches the network: the sandbox's domain list is one for every sandboxed process
 * and takes no "all", so a domain opened for a job would be open for the harness too. It may serve
 * on localhost (a dev server, a headless game). A job never sources a Claude home's shell snapshot,
 * so it gets no read-open folder beyond what the fence leaves.
 */
export function jobPolicy(gate: JobGate, reach: JobReach, fence: JobFence): Partial<SandboxPolicy> {
  const wide = gate === JobGate.Wide;
  return {
    allowWrite: wide ? [reach.home, ...reach.writeRoots] : [...reach.writeRoots],
    allowedDomains: [],
    allowLocalBinding: true,
    denyRead: [...fence.reads],
    denyWrite: [...fence.writes, ...claudeFoldersIn(reach.writeRoots), ...(wide ? [] : gameFolderDeny(reach))],
  };
}
