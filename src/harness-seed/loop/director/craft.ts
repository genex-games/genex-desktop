/**
 * The game's craft (loop/game-craft.ts) as the lead and its builders are handed it: in the
 * director's opening brief from the goal and the direction, again in the plan's answer once the
 * plan declares the game's kind, and in each builder's brief from its own words. Each writes the
 * recipes whole into the folder that session works in (`.studio/CRAFT.md`, never committed).
 */
import { CRAFT_FILE_PATH, craftBlock, type CraftAsk, type CraftPick, writeGameCraft } from "../game-craft.ts";
import { workingGoal } from "../goal-prompts.ts";
import { stackOfShape, stampedStack } from "../native-loop.ts";
import type { AnyRecord, Run } from "../../types/harness.d.ts";
import type { LoopRun } from "./loop-run.ts";

/** How each block opens. Every builder is handed its own part's recipes too; the lead's list is for planning and its own work. */
const CRAFT_HEADING = {
  opening:
    "CRAFT FOR THIS GAME (the studio's recipes for its kind and brief — technique, not law; plan with them, use them in your own work, and name the ids a builder's brief should start from):",
  plan: (kind: string) =>
    `CRAFT FOR A ${kind.toUpperCase()} GAME (recipes the plan's kind adds to what your brief listed; hand a part the ones its work needs):`,
  builder: "CRAFT FOR YOUR PART (the studio's recipes for this kind of game and your brief — port what fits):",
} as const;

/** The brief's own texts for a run: its goal and its direction. */
function runTexts(run: Run): string[] {
  return [workingGoal(run), run.reference?.name ?? "", run.reference?.notes ?? ""];
}

/** What the run's craft is chosen by, with `more` texts beside the run's own and the kind the run declared unless `kind` says. */
function askOf(loopRun: Pick<LoopRun, "run" | "shape">, more: readonly string[], kind?: string | null): CraftAsk {
  const { run, shape } = loopRun;
  const declared = typeof run.game?.kind === "string" ? run.game.kind : null;
  return {
    kind: kind ?? declared,
    stack: stampedStack(run) ?? stackOfShape(shape),
    texts: [...runTexts(run), ...more],
  };
}

/** The picks a lead has not been handed yet, remembered as handed. */
function unseen(loopRun: Pick<LoopRun, "state">, picks: readonly CraftPick[]): CraftPick[] {
  const shown = new Set(loopRun.state.craftShown ?? []);
  const fresh = picks.filter((pick) => !shown.has(pick.recipe.id));
  loopRun.state.craftShown = [...shown, ...fresh.map((pick) => pick.recipe.id)];
  return fresh;
}

/** The opening brief's craft block, its recipes written into the integration worktree; "" when none fits. */
export async function openingCraft(
  loopRun: Pick<LoopRun, "ctx" | "run" | "shape" | "state" | "integrationWorktree">,
): Promise<string> {
  const { ctx, integrationWorktree } = loopRun;
  const { picks, file } = await writeGameCraft(ctx.workspace, integrationWorktree, askOf(loopRun, []));
  return craftBlock(unseen(loopRun, picks), file, { heading: CRAFT_HEADING.opening });
}

/**
 * What a plan that declares the game's kind adds: the kind's recipes and those its summary reaches
 * that the lead was not handed yet, written over the integration worktree's CRAFT.md. "" without a
 * kind or anything new.
 */
export async function planCraft(
  loopRun: Pick<LoopRun, "ctx" | "run" | "shape" | "state" | "integrationWorktree">,
  plan: AnyRecord,
): Promise<string> {
  const kind = typeof plan.game?.kind === "string" ? plan.game.kind : null;
  if (!kind) return "";
  const { ctx, integrationWorktree } = loopRun;
  const ask = askOf(loopRun, [String(plan.summary ?? "")], kind);
  const { picks, file } = await writeGameCraft(ctx.workspace, integrationWorktree, ask);
  return craftBlock(unseen(loopRun, picks), file, { heading: CRAFT_HEADING.plan(kind) });
}

/** A builder's craft block from the run and its own brief, written into its worktree (its cwd, so the path is relative); "" when none fits. */
export async function builderCraft(
  loopRun: Pick<LoopRun, "ctx" | "run" | "shape">,
  worktree: string | null,
  texts: readonly string[],
): Promise<string> {
  const { picks, file } = await writeGameCraft(loopRun.ctx.workspace, worktree, askOf(loopRun, texts));
  return craftBlock(picks, file ? CRAFT_FILE_PATH : null, { heading: CRAFT_HEADING.builder });
}
