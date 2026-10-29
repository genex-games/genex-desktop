/** The brief (`.studio/BRIEF.md` in the worktree) and the prompt that points at it. */
import { rotateSession } from "../session-rotation.ts";
import { renderLiveness } from "../../judge.ts";
import {
  CRAFT_ADOPT_SCORE,
  checksFromDefects,
  recipesForChecks,
  writeWorktreeBrief,
  writeWorktreeFile,
} from "../../library.ts";
import { RECIPES_FILE, RECIPES_FILE_PATH, renderRecipesFile } from "../../brief-budget.ts";
import { stackOfShape, stampedStack } from "../../native-loop.ts";
import type { GameStack } from "../../native-contract.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import type { RoundFlow } from "../flow.ts";
import { pinFixRecipe } from "../rules.ts";
import { facetPrompt, promptImagesFor } from "../prompt.ts";
import { roundStage } from "../stage.ts";
import { fitBrief } from "../brief-fit.ts";
import { blockBench } from "../build-block-prompts.ts";
import { openCarriedFixes } from "../carried-fixes.ts";
import { withIdentity } from "../../workers/identity.ts";
import { CRAFT_FILE_PATH, craftBlock, writeGameCraft } from "../../game-craft.ts";
import { workingGoal } from "../../goal-prompts.ts";

/** A template game's entry module, when the shape names none. */
const DEFAULT_ENTRY = "src/main.js";

/**
 * A C++ · raylib facet's brief carries only recipes written for its stack and reads its rules in
 * C++ terms; a copy of this module kept from before native support would hand it three.js ones
 * (native-contract.ts `servesNative`).
 */
export const SERVES_NATIVE = true;
/** A Rust · wgpu facet's brief carries Rust recipes only and its prompt reads `RUST_FACET` (facet/prompt.ts `facetLinesFor`). */
export const SERVES_RUST = true;

/** The facet's game's stack: the run's stamp, else the folder's kind. */
function facetStack({ run, shape }: Pick<FacetLoop, "run" | "shape">): GameStack {
  return stampedStack(run) ?? stackOfShape(shape);
}

/** The brief (`.studio/BRIEF.md` in the worktree) and the prompt that points at it. */
export async function writeBrief(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { baseShots, delegated, ownShape, ownsMain, run, shape, spec, workdir } = loop;
  // ── the brief: `.studio/BRIEF.md` in the worktree, plus the prompt that points at it ──
  pickRecipes(loop, round);
  const recipesFile = await writeRecipesFile(loop, round);
  await pickCraft(loop);
  // The four sections the prompt no longer renders for a delegated engine (M4.8b) live here, and
  // the whole of it stays within BRIEF_MAX_CHARS (loop/brief-budget.ts).
  const fitted = fitBrief(
    { ...briefInput(loop, round), recipesFile },
    {
      spec,
      ownsMain,
      ownShape,
      entryMain: shape?.main ?? DEFAULT_ENTRY,
      build: shape?.build ?? null,
      // A compiled game's seam, entry and demo rules are its own (CPP_FACET, RUST_FACET).
      kind: shape?.kind,
    },
  );
  round.briefText = fitted.briefText;
  round.brief = fitted.brief;
  round.briefFile = workdir ? await writeWorktreeBrief(workdir, round.brief).catch(() => null) : null;
  round.acceptedShots = (loop.incumbentEvidence?.shots ?? []).map((shot: AnyRecord) => shot.path).filter(Boolean);
  // Stills into the prompt (WP3d): every reference still plus the base build's frames on the
  // first iteration; later, one reference|build pair per camera — only when a style or
  // vision check is failing or the last build lost (context cost otherwise).
  round.promptImages = promptImagesFor({
    run,
    spec,
    iteration: round.iteration,
    board: loop.board,
    loseStreak: loop.loseStreak,
    baseShots,
    incumbentEvidence: loop.incumbentEvidence,
    pairs: loop.lastPairs,
  });
  await rotateSession(loop, round.iteration);
  round.prompt = facetPromptFor(loop, round, {
    resumed: Boolean(loop.sessionId),
    briefText: delegated ? null : round.brief,
    fix: loop.currentFix,
  });
}

/**
 * `.studio/RECIPES.md` beside the brief: the retrieved recipes whole, so BRIEF.md names them and
 * points there. Only for a delegated builder, which reads files; a direct engine gets the brief
 * inline and keeps the sketches in it. Null when no recipe was written, and the brief then keeps
 * them. A round that picked none still rewrites the file, saying so: a resumed builder remembers
 * an earlier round's pointer and must not port recipes this round did not choose.
 */
async function writeRecipesFile(loop: FacetLoop, round: FacetRound): Promise<string | null> {
  const { delegated, workdir } = loop;
  if (!delegated || !workdir) return null;
  const hits = round.injectedWithFix;
  const written = await writeWorktreeFile(workdir, RECIPES_FILE, renderRecipesFile(hits)).catch(() => null);
  return written && hits.length ? RECIPES_FILE_PATH : null;
}

/**
 * The recipes the brief injects: retrieved for the failing and unscored checks and, beside
 * retrieval by check id, from prose — the fix's own sentence pulls its recipe into "Recipes
 * that apply", which is where THE FIX's line says it is. Only recipes for this kind of game, and
 * only a real overlap (CRAFT_ADOPT_SCORE) unless it is the recipe's own check; the unscored
 * checks of a first round take exact matches only, since nothing has failed them yet.
 */
function pickRecipes(loop: FacetLoop, round: FacetRound): void {
  const { game, run, spec } = loop;
  round.failingChecks = Object.values(loop.board)
    .filter((e) => e.pass === false)
    .map((e) => spec.checks.find((c) => c.id === e.id) ?? e);
  round.unscored = Object.keys(loop.board).length === 0 ? spec.checks : [];
  round.fixDefects = loop.currentFix ? checksFromDefects([loop.currentFix.what], { limit: 1 }) : [];
  round.injected = recipesForChecks(
    loop.recipes,
    [...round.failingChecks, ...round.unscored, ...round.fixDefects],
    undefined,
    // A compiled facet is never handed a three.js recipe, nor a three.js facet a compiled one.
    {
      project: run.project,
      kind: typeof game?.kind === "string" ? game.kind : null,
      stack: facetStack(loop),
      minScore: CRAFT_ADOPT_SCORE,
      exactOnly: round.unscored.map((check: { id: string }) => check.id),
    },
  );
  round.injectedWithFix = pinFixRecipe(round.injected, loop.currentFix, round.fixDefects[0]?.id ?? null);
}

/** How the brief's craft block opens: chosen before anything failed, unlike the recipes retrieved for this round. */
const CRAFT_HEADING =
  "## Craft for this game (the studio's recipes for its kind and your part, chosen before anything failed — port what fits)";

/**
 * The game's craft (loop/game-craft.ts), once per loop: the recipes for its kind and for the run's
 * and this part's words, written whole to `.studio/CRAFT.md` for a delegated builder that reads
 * files, and named in every round's brief. Before it, a first-person Rust worker got a recipe only
 * once a check on its board had failed — Bodycam's hands recipe never reached anyone.
 */
async function pickCraft(loop: FacetLoop): Promise<void> {
  if (loop.craft !== undefined) return;
  const { ctx, delegated, game, run, spec, workdir } = loop;
  // A loop built without a workspace (an older caller, a bench) has no library to choose from.
  if (!ctx?.workspace) {
    loop.craft = "";
    return;
  }
  const { picks, file } = await writeGameCraft(ctx.workspace, delegated ? workdir : null, {
    kind: typeof game?.kind === "string" ? game.kind : null,
    stack: facetStack(loop),
    texts: [workingGoal(run), run.reference?.name ?? "", spec.title, spec.intent, ...(spec.identity ?? [])],
  });
  loop.craft = craftBlock(picks, file ? CRAFT_FILE_PATH : null, { heading: CRAFT_HEADING });
}

/** Everything `renderBrief` renders: the contract, the board, the last attempts, the recipes and this round's move and fix. */
function briefInput(loop: FacetLoop, round: FacetRound) {
  const { critic, game, lessons, ownShape, ownsMain, result, run, shape, spec } = loop;
  const last = result.attempts.at(-1);
  return {
    run,
    spec,
    iteration: round.iteration,
    screen: !ownShape,
    // Which world this worker is in (M4.6): the studio's template, or a game the user
    // brought. The brief's determinism, one-input-path and materials lines are the
    // template's rules and are not asked of somebody's own game.
    template: !ownShape,
    ownsMain,
    entryMain: shape?.main ?? DEFAULT_ENTRY,
    ownShape,
    build: shape?.build ?? null,
    critic,
    game,
    board: loop.board,
    comparison: last?.iteration === round.iteration - 1 ? { flips: last.flips, regressions: last.regressions } : null,
    attempts: result.attempts,
    recipes: round.injectedWithFix,
    craft: loop.craft ?? null,
    spike: round.spikeText,
    steering: round.userSteering,
    integration: loop.integrationNote,
    resumed: Boolean(loop.sessionId),
    defects: loop.defectList,
    polish: loop.polishList,
    style: styleInput(loop),
    flags: loop.flags,
    lessons,
    // What earlier runs on this game cost. The director loads them once and hangs them on
    // the run so every worker's BRIEF.md carries the same five (loop/ledger.ts).
    gameLessons: run.gameLessons ?? [],
    move: loop.currentMove,
    fix: loop.currentFix,
    liveness: loop.lastLiveness ? renderLiveness(loop.lastLiveness) : null,
    stack: facetStack(loop),
    // Building or finishing (facet/stage.ts): the stage this round was fixed in when its move was chosen.
    stage: roundStage(round, spec),
    // The worker's first, long round (facet/build-block.ts), and what undone rounds had fixed.
    buildBlock: round.buildBlock ? { bench: blockBench(loop) } : null,
    carried: openCarriedFixes(loop.carriedFixes, loop.board),
  };
}

/** The brief's "distance to the references": the accepted build's shots against the references, when there are both. */
function styleInput(loop: FacetLoop): AnyRecord | null {
  const { references } = loop;
  if (!references.length || !loop.incumbentEvidence) return null;
  return {
    shots: loop.incumbentEvidence.shots,
    references,
    previous: loop.lastStyle?.previous ?? [],
    pairs: loop.lastPairs.map((p) => ({ camera: p.camera, path: p.path })),
  };
}

/**
 * The build prompt for this round, as `facetPrompt` renders it from the loop's state. A director's
 * builder opens a fresh session with Genex's identity (the loop's `identity` option); a classic
 * Autopilot's builders pass none and keep their prompt.
 */
export function facetPromptFor(
  loop: FacetLoop,
  round: FacetRound,
  { resumed, briefText = null, fix = null }: { resumed: boolean; briefText?: string | null; fix?: AnyRecord | null },
): string {
  const prompt = renderedPrompt(loop, round, { resumed, briefText, fix });
  return resumed ? prompt : withIdentity(loop.options?.identity, prompt);
}

/** The build prompt as `facetPrompt` renders it from the loop's state. */
function renderedPrompt(
  loop: FacetLoop,
  round: FacetRound,
  { resumed, briefText, fix }: { resumed: boolean; briefText: string | null; fix: AnyRecord | null },
): string {
  const { game, gapHistory, legacy, ownShape, ownsMain, result, run, shape, spec, worktree } = loop;
  return facetPrompt({
    shape,
    ownShape,
    game,
    run,
    spec,
    iteration: round.iteration,
    resumed,
    briefFile: round.briefFile,
    briefText,
    board: loop.board,
    lastAttempt: result.attempts.at(-1) ?? null,
    lastFailure: loop.lastFailure,
    loseStreak: loop.loseStreak,
    gapHistory,
    defectList: loop.defectList,
    worktree,
    userSteering: round.userSteering,
    acceptedShots: round.acceptedShots,
    ownsMain,
    spike: round.spikeText,
    integrationNote: loop.integrationNote,
    legacy,
    imagesAttached: round.promptImages.length,
    move: loop.currentMove,
    fix,
    stage: roundStage(round, spec),
    buildBlock: round.buildBlock ? { bench: blockBench(loop) } : null,
  });
}
