/**
 * The craft a game is handed before anything fails: the library's recipes for its kind and its
 * brief's words, on its stack.
 *
 * Retrieval by failing check (library.ts `recipesForChecks`) reaches a loop worker only after a
 * check on its board has failed, and never reaches the director or a single-session builder at
 * all. Bodycam (2026-10-27) planned, built and judged a first-person Rust game for four hours and
 * `fps.hands-in-frame` — the exact technique its judges asked for in every verdict — was applied 0
 * times. So the game's own craft is chosen up front: every recipe written for its kind, plus any
 * recipe whose tags its brief names, written whole to `.studio/CRAFT.md` and named in one short
 * block of the director's brief, its plan's answer and each builder's brief.
 *
 * Its own module so a workspace that kept an older `library.ts` still links it.
 */
import { loadRecipes, RecipeStatus, writeWorktreeFile } from "./library.ts";
import type { Recipe } from "./library.ts";
import { GameStack } from "./native-contract.ts";
import { sketchBlock } from "./recipe-sketch.ts";
import { clipWords } from "./word-clip.ts";
import { sharesStem } from "./text.ts";

/** The file beside BRIEF.md that holds the game's craft whole: its name, and the path a brief names. */
export const CRAFT_FILE = "CRAFT.md";
export const CRAFT_FILE_PATH = ".studio/CRAFT.md";
/** The most recipes one game is handed up front: a menu, not the library. */
export const MAX_GAME_CRAFT = 10;
/** What a recipe written for this game's kind scores before any word; a word the brief names scores one, a shared stem half. */
const KIND_SCORE = 2;
const WORD_SCORE = 1;
const STEM_SCORE = 0.5;
/** The least score that makes a recipe this game's craft: its kind's, or two words of its brief. */
const MIN_CRAFT_SCORE = 2;
/** A brief word shorter than this is grammar, not a subject. */
const MIN_WORD = 3;
/** How much of a recipe's note one prompt line quotes. */
const CRAFT_LINE_NOTE_CHARS = 150;

/** What a game's craft is chosen by: its declared kind, its stack, and the brief's own text. */
export interface CraftAsk {
  /** The game's declared kind (loop/kinds.ts), or null before anyone declared one. */
  kind?: string | null;
  stack: GameStack;
  /** The texts the brief is made of: the goal, the direction, a plan's summary, a builder's own brief. */
  texts: ReadonlyArray<string | null | undefined>;
}

/** A recipe chosen for a game, and how strongly. */
export interface CraftPick {
  recipe: Recipe;
  score: number;
}

/** The words of a brief, lower-cased, of MIN_WORD letters or more. */
function briefWords(texts: CraftAsk["texts"]): Set<string> {
  const words = texts.flatMap((text) =>
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/),
  );
  return new Set(words.filter((word) => word.length >= MIN_WORD));
}

/** How strongly a recipe's tags meet the brief's words: one per tag named, half per tag a word shares a stem with. */
function wordScore(recipe: Recipe, words: ReadonlySet<string>): number {
  let score = 0;
  for (const tag of recipe.tags) {
    if (words.has(tag)) score += WORD_SCORE;
    else if ([...words].some((word) => sharesStem(word, tag))) score += STEM_SCORE;
  }
  return score;
}

/** A recipe this game may be handed at all: on its stack, not retired, and not written for another kind of game. */
function servesGame(recipe: Recipe, { kind, stack }: CraftAsk): boolean {
  if (recipe.status === RecipeStatus.Retired) return false;
  if ((recipe.runtime ?? GameStack.ThreeJs) !== stack) return false;
  const forOtherKinds = Boolean(kind) && Boolean(recipe.kinds?.length) && !recipe.kinds?.includes(String(kind));
  return !forOtherKinds;
}

/** Does this recipe name the game's kind among its own? */
function forThisKind(recipe: Recipe, kind: string | null | undefined): boolean {
  return Boolean(kind) && Boolean(recipe.kinds?.includes(String(kind)));
}

/**
 * The game's craft: every recipe for its kind and each recipe two of its brief's words reach, on
 * its stack, the strongest first and at most `limit`. Promoted recipes and those that have won
 * outrank the rest at an equal score.
 */
export function craftForGame(
  recipes: readonly Recipe[] | null | undefined,
  ask: CraftAsk,
  limit = MAX_GAME_CRAFT,
): CraftPick[] {
  const words = briefWords(ask.texts);
  const picks: CraftPick[] = [];
  for (const recipe of recipes ?? []) {
    if (!servesGame(recipe, ask)) continue;
    const score = (forThisKind(recipe, ask.kind) ? KIND_SCORE : 0) + wordScore(recipe, words);
    if (score >= MIN_CRAFT_SCORE) picks.push({ recipe, score });
  }
  return picks.sort(byStrength).slice(0, limit);
}

/** Stronger first; then promoted, then more wins than losses, then by id. */
function byStrength(a: CraftPick, b: CraftPick): number {
  const promoted = (pick: CraftPick) => (pick.recipe.status === RecipeStatus.Promoted ? 1 : 0);
  const record = (pick: CraftPick) => pick.recipe.stats.wins - pick.recipe.stats.losses;
  return (
    b.score - a.score || promoted(b) - promoted(a) || record(b) - record(a) || (a.recipe.id < b.recipe.id ? -1 : 1)
  );
}

/** How a recipe's own check reads in the craft file: what the board would measure, if a plan adopts it. */
function checkLine(recipe: Recipe): string {
  const check = recipe.check;
  if (!check?.id) return "";
  const body = check.expr ?? check.ask ?? check.js ?? "";
  const on = check.camera ? ` on ${check.camera}` : "";
  const by = check.name ? ` (demo ${check.name})` : "";
  return `Measured by: ${check.id}, a ${check.kind} check${on}${by}: ${body}`;
}

/** `.studio/CRAFT.md`: each recipe chosen for the game, whole. */
export function renderCraftFile(picks: readonly CraftPick[], { kind = null }: { kind?: string | null } = {}): string {
  const lines = [
    "# Craft for this game",
    "",
    `The studio's recipes for ${kind ? `a ${kind} game` : "this game"} on this stack, chosen by its kind and its brief before anything was judged. They are technique, not law: port what fits, in this game's own structure, and read a sketch before you copy from it.`,
    "",
  ];
  for (const { recipe } of picks) {
    lines.push(`## ${recipe.title} (${recipe.id})`);
    if (recipe.note) lines.push(`For: ${recipe.note}`);
    if (recipe.intent) lines.push(`How: ${recipe.intent}`);
    if (recipe.sketch?.trim()) lines.push(sketchBlock(recipe));
    if (recipe.port) lines.push(`Port: ${recipe.port}`);
    const measured = checkLine(recipe);
    if (measured) lines.push(measured);
    lines.push("");
  }
  return lines.join("\n");
}

/** The prompt's block: one line per recipe, and where the whole of them is. Nothing when none was chosen. */
export function craftBlock(picks: readonly CraftPick[], file: string | null, { heading }: { heading: string }): string {
  if (!picks.length) return "";
  const where = file ? ` Whole, with code: ${file}.` : "";
  return [
    `${heading}${where}`,
    ...picks.map(({ recipe }) => `- ${recipe.id} — ${clipWords(recipe.note || recipe.title, CRAFT_LINE_NOTE_CHARS)}`),
  ].join("\n");
}

/**
 * The game's craft chosen from the workspace's library and written whole into `dir`'s
 * `.studio/CRAFT.md`. The file is null when nothing was chosen or it could not be written; the
 * picks stand either way. A library that will not load chooses nothing.
 */
export async function writeGameCraft(
  workspace: string,
  dir: string | null,
  ask: CraftAsk,
): Promise<{ picks: CraftPick[]; file: string | null }> {
  const picks = craftForGame(await loadRecipes(workspace).catch(() => []), ask);
  if (!picks.length || !dir) return { picks, file: null };
  const file = await writeWorktreeFile(dir, CRAFT_FILE, renderCraftFile(picks, { kind: ask.kind ?? null })).catch(
    () => null,
  );
  return { picks, file };
}
