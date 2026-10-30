/**
 * Blockout first, on a game the player moves through. Body-cam-6's look gate held every part but
 * one until that one area's hero shot passed the art director, and three hours later the game was a
 * hallway and two rooms with no entrance or exit. Now the first part is the blockout: it writes the
 * level plan (level-plan.ts) and greyboxes the whole level playable, and on a game built from
 * scratch every other part except the sourcing worker waits for it, for at most the first third of
 * the run. Art passes then go zone by
 * zone, and no zone's look holds another.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasPlace, kindOfRun, LEVEL_PLAN, levelPlanBrief, parseLevelPlan } from "../level-plan.ts";
import { isRunning } from "../outcomes.ts";
import { MINUTE_MS } from "../time.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LoopRun } from "./loop-run.ts";

/** The id of the part that plans and blocks out the whole level: the part every other one waits for. */
export const BLOCKOUT_PART = "blockout";
/** The share of the run the blockout hold may take: the whole level is greyboxed in about the first third. */
export const BLOCKOUT_SHARE = 1 / 3;
/** The parts the blockout hold never holds: the blockout itself and the sourcing worker (sourcing.ts). */
const UNHELD = new Set([BLOCKOUT_PART, "sourcing"]);

/** Does this run's game take a level plan and a blockout first. */
export const needsBlockout = (run: AnyRecord | null | undefined): boolean => hasPlace(kindOfRun(run));

/** A blockout worker's goal: the director's words, then the level-first ask in its kind's terms. */
export function blockoutGoal(run: AnyRecord | null | undefined, id: string, goal: string): string {
  const kind = kindOfRun(run);
  if (id !== BLOCKOUT_PART || !kind || !hasPlace(kind)) return goal;
  return `${goal}\n\n${levelPlanBrief(kind)}`;
}

/** Why the level plan in the integration is not finished yet, or null when it is. */
async function planGap(integrationWorktree: string): Promise<string | null> {
  const text = await readFile(path.join(integrationWorktree, LEVEL_PLAN), "utf8").catch(() => null);
  const plan = parseLevelPlan(text);
  if (!plan) return `${LEVEL_PLAN} is not in the integration yet`;
  if (plan.missing.length) return `${LEVEL_PLAN} leaves ${plan.missing.join(", ")} empty`;
  return null;
}

/** Why `worker_start` waits for the blockout, or null. */
export async function blockoutRefusal(loopRun: LoopRun, id: string, now: number): Promise<string | null> {
  const { integrationWorktree, run, started, softDeadline, state } = loopRun;
  // Only a game built from scratch is held: an edit to a game that already has its place is not.
  if (UNHELD.has(id) || !needsBlockout(run) || !(state as AnyRecord).fromScratch) return null;
  const until = started + (softDeadline - started) * BLOCKOUT_SHARE;
  if (now >= until) return null;
  const blockout = (state.workers as Map<string, AnyRecord>).get(BLOCKOUT_PART);
  const gap = await planGap(integrationWorktree);
  if (!gap && !isRunning(blockout)) return null;
  const minutes = Math.max(1, Math.ceil((until - now) / MINUTE_MS));
  const how = blockout
    ? `let ${BLOCKOUT_PART} finish and integrate it`
    : `start it with worker_start id=${BLOCKOUT_PART} owns_main=true`;
  return `worker_start waits for the blockout (up to ${minutes} more min): ${gap ?? `${BLOCKOUT_PART} is still building`}. The whole level is planned in ${LEVEL_PLAN} and greyboxed playable from spawn to exit before any zone gets its art; ${how}. The sourcing worker may run beside it.`;
}
