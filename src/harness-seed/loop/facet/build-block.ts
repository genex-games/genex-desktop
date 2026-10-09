/**
 * The build block. A worker judged blind from its first short round spends its rounds on what one
 * look at a time can reward; a part needs a long stretch of its own module, with a bench page and
 * a screenshot-and-fix loop, before anything judges it. A new loop worker's first round is one
 * long build of BUILD_BLOCK_MIN_MS to BUILD_BLOCK_MAX_MS: whenever the builder ends its
 * turn early, the same session is asked to keep going on its bench page, and the block is kept on
 * the checks alone — it must run, regress nothing and change what a player sees. The taste judge
 * looks once for its notes (the defects, the polish, the big move, whether the move is there),
 * never as a verdict; the blind side-by-side starts from the next round.
 *
 * Only the first round of a worker its orchestrator asked a block of (the director's new parts:
 * `buildBlock`), building, on a session engine, in its own worktree, given a window that holds the
 * block and as long again of side-by-side rounds after it. A restart, a finisher, a short worker,
 * a resumed loop (it starts past round one) and the classic pipeline have none.
 *
 * A new module on purpose: a workspace that kept an older plan.ts, build.ts, taste.ts or
 * publish.ts still loads, and a round no phase stamped is no block.
 */
import { MINUTE_MS } from "../time.ts";
import { VerdictSource } from "../verdict.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import { strongFlips } from "./rules.ts";
import { FacetStage, roundStage } from "./stage.ts";

/** The block's shortest: an earlier end of the builder's turn is answered with more building. */
export const BUILD_BLOCK_MIN_MS = 60 * MINUTE_MS;
/** The block's longest: no turn of it runs past this. */
export const BUILD_BLOCK_MAX_MS = 90 * MINUTE_MS;
/** The most times a block asks its builder to keep going: one that stops at once is not asked forever. */
const BUILD_BLOCK_TURNS = 8;
/** Another stretch is asked only with this much left for it: less is the verdict's time. */
const BLOCK_TURN_MIN_MS = 5 * MINUTE_MS;
/** The shortest worker window a block opens: the block, and as long again of side-by-side rounds. */
const BUILD_BLOCK_MIN_WINDOW_MS = 2 * BUILD_BLOCK_MIN_MS;

/** What the block reads off the loop: whether it was asked for, where and how it builds, and its window. */
type BlockLoop = {
  buildBlock?: unknown;
  legacy?: boolean;
  delegated?: boolean;
  worktree?: string | null;
  spec?: AnyRecord | null;
  /** The facet's whole clock when it started. */
  budgetMs?: number;
  /** The loop's own clock (tests); the wall clock when it has none. */
  now?: () => number;
};

/**
 * Is this round its worker's build block? Its first, building, on a session engine in its own
 * worktree, with a window long enough for the block and the rounds after it, when asked for.
 */
export function isBuildBlock(loop: BlockLoop, round: { iteration: number; stage?: unknown }): boolean {
  if (loop.buildBlock !== true || loop.legacy === true) return false;
  if (round.iteration !== 1 || !loop.delegated || !loop.worktree) return false;
  const windowHoldsIt = Number(loop.budgetMs) >= BUILD_BLOCK_MIN_WINDOW_MS;
  return windowHoldsIt && roundStage(round, loop.spec) === FacetStage.Build;
}

/** The block's clock: the loop's own when it has one, else the wall clock. */
export const blockClock = (loop: BlockLoop): number => loop.now?.() ?? Date.now();

/** A turn's budget inside a block that started at `startedAt`: never past the block's longest. */
export const withinBlock = (startedAt: number, now: number, budgetMs: number): number =>
  Math.min(budgetMs, startedAt + BUILD_BLOCK_MAX_MS - now);

/** Where a block stands: when it started, now, the stretches it has asked for, and what the facet's clock leaves a turn. */
export interface BlockState {
  startedAt: number;
  now: number;
  turns: number;
  leftMs: number;
}

/**
 * The next stretch of the block, in ms, or null when it is over: its shortest end is reached, it
 * has asked as often as it may, or what is left (of the block's longest, and of the facet's clock)
 * is too little for a stretch.
 */
export function nextBlockStretch({ startedAt, now, turns, leftMs }: BlockState): number | null {
  if (now - startedAt >= BUILD_BLOCK_MIN_MS || turns >= BUILD_BLOCK_TURNS) return null;
  const stretch = withinBlock(startedAt, now, leftMs);
  return stretch >= BLOCK_TURN_MIN_MS ? stretch : null;
}

/** Whole minutes until the block's shortest end, at least one. */
export const minutesToBlockEnd = ({ startedAt, now }: Pick<BlockState, "startedAt" | "now">): number =>
  Math.max(1, Math.ceil((startedAt + BUILD_BLOCK_MIN_MS - now) / MINUTE_MS));

/**
 * The block's verdict: kept. A broken build, a regression, a lost camera or demo and a build that
 * changed nothing were refused on the board before the judge was asked (verify.ts), so what
 * reaches here passed the checks; the strong flips are what it is credited with.
 */
export function keptByBlock(
  spec: { checks?: AnyRecord[] } | null | undefined,
  board: AnyRecord | null | undefined,
  comparison: { flips?: string[] } | null | undefined,
): { accepted: true; strong: string[]; source: VerdictSource } {
  return { accepted: true, strong: strongFlips(spec, board, comparison?.flips ?? []), source: VerdictSource.Checks };
}
