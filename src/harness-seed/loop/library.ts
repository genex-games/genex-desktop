/**
 * The technique library — HARNESS-REWORK.md §4.6.
 *
 * What replaces SkillOpt for builders. A recipe is one technique that satisfies one class of
 * check (planar mirror → `mirror-rt`, knee-band fog → `fog-band`, …): intent, a code sketch,
 * the check it satisfies, and the evidence that earned it (run, facet, iteration, spike).
 * Recipes are written from spike outcomes and accepted iterations, never from verdict prose,
 * and they are promoted or retired by outcomes: a check that failed before the recipe was
 * injected and passed after it is a win; the same check still failing is a loss. Text votes
 * are gone.
 *
 * Injection is what actually reaches the model that builds: per iteration the harness writes
 * `<worktree>/.studio/BRIEF.md` — the scoreboard, the failing checks, the retained attempts,
 * and only the recipes relevant to what is failing now — and the game's `CLAUDE.md` points
 * the contractor at it. Retrieval is by check id and tags, never an 800-line dump.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CheckOrigin,
  checkTokens,
  CheckWeight,
  MAX_CAMERAS,
  MAX_CHECKS,
  MAX_CRAFT,
  normalizeCheck,
  renderChecks,
  slug,
} from "./spec.ts";
import { renderScoreboard } from "./checks.ts";
import { appliesToBuild } from "./applies-to-build.ts";
import { nearestReference } from "./style.ts";
import { facetNotes } from "./repo.ts";
import { gameLine, KIND_NAMES } from "./kinds.ts";
import { roleEngine, RoleKey, toolCall } from "./model-roles.ts";
import { clip, CLIP_BRIEF, CLIP_DETAIL, CLIP_QUOTE, CLIP_REASON, sharesStem } from "./text.ts";
import { clipTailWords, clipWords } from "./word-clip.ts";
import {
  BRIEF_INTEGRATION_CHARS,
  BRIEF_LIVENESS_CHARS,
  BRIEF_MAX_CHARS,
  BriefCut,
  fitWithin,
  RECIPE_INTENT_CHARS,
  REVIEW_VIOLATIONS_SHOWN,
} from "./brief-budget.ts";
import { isRecord } from "./json.ts";
import { lessonLine, MAX_CONTRACT_LESSONS, renderContractLessons } from "./contract-lessons.ts";
import { RECIPE_ID_CHARS } from "./config.ts";
import { FacetStage, FINISH_POLISH_NOTES, moveEscalated, stageOf } from "./facet/stage.ts";
import {
  FINISH_CRITIC_KEY,
  FINISH_FIX_LINE,
  FINISH_POLISH_HEAD,
  FINISH_RULES,
  FINISH_SECTION_HEAD,
} from "./facet/stage-prompts.ts";
import { heldHudBriefRule } from "./held-hud-prompts.ts";
import { screenOwnerFinishRules, screenOwnerLine, type ScreenOwnerSpec } from "./screen-owner-prompts.ts";
import { benchPage, blockBriefSection } from "./facet/build-block-prompts.ts";
import { CARRY_OVER_EXCEPTION, carryOverSection } from "./facet/carried-fixes-prompts.ts";
import type { CarriedFix } from "./facet/carried-fixes.ts";
import type { Check, FacetSpec } from "./spec.ts";
import type { ReferenceStats, Scoreboard } from "./checks.ts";
import type { StyleStats } from "./style.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";

/** The most recipes one failing board retrieves, and how much of a recipe's code sketch it keeps. */
const MAX_RECIPES_PER_BRIEF = 3;
const MAX_SKETCH_CHARS = 6_000;
/** One line per recipe in the planner's menu; a note longer than this is cut. */
export const CRAFT_NOTE_CHARS = 70;
/** The whole craft menu's ceiling. Forty-one one-liners do not fit a planner prompt. */
export const CRAFT_MENU_MAX = 2_900;
/** Below this score a craft recipe is a coincidence, not the answer to a check. */
export const CRAFT_ADOPT_SCORE = 3;
/** A recipe as the library keeps it (its id: RECIPE_ID_CHARS): its check class, pack, origin and project names, its menu note and its intent or port. */
const CHECK_CLASS_CHARS = 60;
const PACK_CHARS = 40;
const ORIGIN_CHARS = 40;
const PROJECT_CHARS = 80;
const RECIPE_NOTE_CHARS = 160;
const RECIPE_TEXT_CHARS = 1_200;
/** The results a recipe remembers, the newest kept. */
const MAX_RECIPE_EVIDENCE = 24;
/**
 * What a builder's brief carries: ledger defects, the judge's polish notes, earlier rounds (the
 * latest), diff-stat lines each, this game's lessons and past runs' lessons. Six defects, not
 * twelve: a brief that is mostly defect material has the builders spend their rounds on it
 * instead of the move.
 */
const MAX_BRIEF_DEFECTS = 6;
const MAX_BRIEF_POLISH = 3;
const EARLIER_ROUNDS_SHOWN = 3;
const DIFF_STAT_LINES = 12;
const MAX_GAME_LESSONS = 5;
/** Past runs' lessons: six, not twelve, now that the file is applied — briefs already run 20-39 KB. */
const MAX_BRIEF_LESSONS = 6;
/** A recipe is promoted after this many wins (and more wins than losses), and retired after this many losses outnumbering its wins this many times over. */
const PROMOTE_AFTER_WINS = 2;
const RETIRE_AFTER_LOSSES = 3;
const RETIRE_LOSS_RATIO = 2;
/** The overlap below which two words in common are a coincidence, not relevance. */
const MIN_OVERLAP = 2;
/** The style distance a camera must move by before the brief calls it better or worse. */
const STYLE_TOLERANCE = 0.02;

/** One technique in the library, with the check it satisfies and what the runs made of it. */
export interface Recipe {
  id: string;
  title: string;
  tags: string[];
  checkClass: string;
  /** "technique" (how the harness can see and drive a build) or "craft" (an opinion about looks). */
  kind: string;
  pack: string;
  note: string;
  intent: string;
  sketch: string;
  check: AnyRecord | null;
  port: string;
  evidence: AnyRecord[];
  stats: { applied: number; wins: number; losses: number };
  status: string;
  origin: string;
  scope: string;
  /** The game kinds (loop/kinds.ts) this recipe is for; none means every kind. */
  kinds?: string[];
  project?: string;
  retiredBecause?: string;
  file?: string;
}

/** A recipe retrieved for failing checks, and the check it answers most strongly. */
export interface RecipeHit {
  recipe: Recipe;
  score: number;
  checkIds: string[];
  primaryCheckId: string;
}

/** A check as retrieval reads it: its id and the words it is about. */
type CheckWords = Partial<Check> & { id?: string };

const LESSONS_FILE = "contract-lessons.md";

/**
 * Lessons every facet re-learned, promoted into a durable list the brief carries (WP8):
 * `library/contract-lessons.md`, one bullet per line. SkillOpt distils them from `## Fixed by
 * looking` / `HARNESS:` notes across runs in one light model call — no blind gate — and stages
 * them (loop/contract-lessons.ts); the host applies them by the user's switches, and Undo works.
 */
export async function loadContractLessons(workspace: string): Promise<string[]> {
  const text = await readFile(path.join(workspace, "library", LESSONS_FILE), "utf8").catch(() => "");
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
  // Once each: a suggestion folded while the host applied the one it replaced appends twice.
  return [...new Set(lines)];
}

export async function saveContractLessons(
  workspace: string,
  lessons: readonly unknown[] | null | undefined,
): Promise<string[]> {
  const dir = path.join(workspace, "library");
  await mkdir(dir, { recursive: true });
  const unique = [...new Set((lessons ?? []).map(lessonLine).filter(Boolean))].slice(0, MAX_CONTRACT_LESSONS);
  await writeFile(path.join(dir, LESSONS_FILE), renderContractLessons(unique));
  return unique;
}

/** The file for a list of lessons; staged changes to it are bounded edits (loop/contract-lessons.ts). */
export { renderContractLessons };

/** BRIEF.md's ceiling, moved sections included (loop/brief-budget.ts). */
export { BRIEF_MAX_CHARS } from "./brief-budget.ts";

/** Where a recipe stands: new, proven by its wins, or retired by its losses. Libraries keep it: never rename a value. */
export const RecipeStatus = {
  Candidate: "candidate",
  Promoted: "promoted",
  Retired: "retired",
} as const;
export type RecipeStatus = (typeof RecipeStatus)[keyof typeof RecipeStatus];
/** Every recipe status, for code that checks one at run time. */
export const RECIPE_STATUS: string[] = Object.values(RecipeStatus);

/** Whose a recipe is: the game it was found in, or every game. */
const RecipeScope = {
  Project: "project",
  Global: "global",
} as const;
/**
 * What a recipe IS. `technique` is the original meaning: how to make the harness able to see
 * and drive a build at all (the named camera rig, the seeded step, the draw-call capture) —
 * the few things whose checks are still on the board of every game. `craft` is an opinion
 * about how a thing should look, which used to be a catalogue check imposed on every plan and
 * is now retrieved: it reaches a builder when its check fails, when a judge names the matching
 * defect, or when a plan asks for it by name.
 */
export const RecipeKind = {
  Technique: "technique",
  Craft: "craft",
} as const;
export type RecipeKind = (typeof RecipeKind)[keyof typeof RecipeKind];
/** Every recipe kind, for code that checks one at run time. */
export const RECIPE_KINDS: string[] = Object.values(RecipeKind);

/** A recipe kept for one game, asked about by another one. */
function belongsElsewhere(recipe: Recipe, project: string | null | undefined): boolean {
  return (
    recipe.scope === RecipeScope.Project && Boolean(project) && Boolean(recipe.project) && recipe.project !== project
  );
}

export function normalizeRecipe(raw: AnyRecord | null | undefined): Recipe | null {
  if (!isRecord(raw) || !raw.id) return null;
  const tags = recipeTags(raw.tags);
  return {
    id: String(raw.id)
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .slice(0, RECIPE_ID_CHARS),
    title: String(raw.title ?? raw.id).slice(0, CLIP_QUOTE),
    tags,
    checkClass: clip(raw.checkClass ?? tags[0], CHECK_CLASS_CHARS),
    // A recipe written before craft existed is a technique: that is what they all were.
    kind: RECIPE_KINDS.includes(raw.kind) ? raw.kind : RecipeKind.Technique,
    pack: slug(raw.pack ?? "", "").slice(0, PACK_CHARS),
    // One line, for the menu. The intent is the how; this is what it is for.
    note: String(raw.note ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, RECIPE_NOTE_CHARS),
    intent: clip(raw.intent, RECIPE_TEXT_CHARS),
    sketch: clip(raw.sketch, MAX_SKETCH_CHARS),
    check: raw.check && typeof raw.check === "object" ? raw.check : null,
    port: clip(raw.port, RECIPE_TEXT_CHARS),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.slice(0, MAX_RECIPE_EVIDENCE) : [],
    stats: recipeStats(raw.stats),
    status: RECIPE_STATUS.includes(raw.status) ? raw.status : RecipeStatus.Candidate,
    ...recipeProvenance(raw),
    ...recipeKinds(raw.kinds),
  };
}

/** The game kinds a recipe names, known ones only; none (or none known) leaves the field out: every kind. */
function recipeKinds(raw: unknown): Pick<Recipe, "kinds"> {
  if (!Array.isArray(raw)) return {};
  const kinds = [
    ...new Set(raw.map((kind: unknown) => String(kind).trim()).filter((kind) => KIND_NAMES.includes(kind))),
  ];
  return kinds.length ? { kinds } : {};
}

/** A recipe written for other kinds of game than this one (a first-person viewmodel in a racer). */
function fitsOtherKinds(recipe: Recipe, kind: string | null | undefined): boolean {
  return Boolean(kind) && Boolean(recipe.kinds?.length) && !recipe.kinds?.includes(String(kind));
}

/** A recipe's tags: lower-cased, trimmed, deduplicated. */
function recipeTags(raw: unknown): string[] {
  const tags = (Array.isArray(raw) ? raw : []).map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean);
  return [...new Set<string>(tags)];
}

/** A recipe's record of use: how often it was applied, and how often that won or lost. */
function recipeStats(raw: AnyRecord | null | undefined): Recipe["stats"] {
  return {
    applied: Number(raw?.applied) || 0,
    wins: Number(raw?.wins) || 0,
    losses: Number(raw?.losses) || 0,
  };
}

/** Where a recipe came from, how far it reaches, and why it was retired, if it was. */
function recipeProvenance(raw: AnyRecord): Pick<Recipe, "origin" | "scope" | "project" | "retiredBecause"> {
  return {
    origin: clip(raw.origin ?? "seed", ORIGIN_CHARS),
    // A spike's recipe is scoped to the game it was proven in until it wins elsewhere: what
    // solved one game's ragdoll is a guess for the next, not a technique.
    scope: raw.scope === RecipeScope.Project ? RecipeScope.Project : RecipeScope.Global,
    ...(raw.project ? { project: String(raw.project).slice(0, PROJECT_CHARS) } : {}),
    ...(raw.retiredBecause ? { retiredBecause: String(raw.retiredBecause).slice(0, CLIP_REASON) } : {}),
  };
}

/**
 * What a run learns about a recipe, kept beside the library instead of inside the recipe file.
 * A recipe the seed ships is upgradable only while its bytes still match the manifest, and a run
 * that wrote its wins back into the file made every one of them "agent edited" for ever — the way
 * `loop/run-inbox.mjs` was frozen at its first vintage. The sidecar is workspace-only: the seed
 * does not ship it, so applySeed never touches it, and a corrected technique can still land.
 */
const RECIPE_STATE_FILE = "recipe-stats.json";
const RECIPE_STATE_FIELDS = ["stats", "status", "scope", "project", "retiredBecause", "evidence"];

async function loadRecipeState(workspace: string): Promise<AnyRecord> {
  const raw = await readFile(path.join(workspace, "library", RECIPE_STATE_FILE), "utf8").catch(() => "");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function loadRecipes(workspace: string): Promise<Recipe[]> {
  const dir = path.join(workspace, "library", "recipes");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const state = await loadRecipeState(workspace);
  const recipes: Recipe[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const body = JSON.parse(await readFile(path.join(dir, entry.name), "utf8"));
      const recipe = normalizeRecipe({ ...body, ...(state[String(body?.id ?? "")] ?? {}) });
      if (recipe) recipes.push({ ...recipe, file: path.join(dir, entry.name) });
    } catch {
      /* a broken recipe file is skipped, never fatal — the library is data */
    }
  }
  return recipes.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function saveRecipe(workspace: string, recipe: Recipe): Promise<string> {
  // A recipe the builder cannot read is only a tag cloud: the `intent` (the how) is mandatory.
  if (!String(recipe?.intent ?? "").trim())
    throw new Error(`recipe ${recipe?.id ?? "?"} has no intent text — refusing to save a technique nobody can follow`);
  const dir = path.join(workspace, "library", "recipes");
  await mkdir(dir, { recursive: true });
  const { file: _file, ...body } = recipe;
  // A seeded recipe keeps its shipped bytes; only what this run learned about it is written.
  if (body.origin === "seed") {
    const target = path.join(workspace, "library", RECIPE_STATE_FILE);
    const state = await loadRecipeState(workspace);
    state[body.id] = Object.fromEntries(
      RECIPE_STATE_FIELDS.filter((key) => (body as AnyRecord)[key] !== undefined).map((key) => [
        key,
        (body as AnyRecord)[key],
      ]),
    );
    await writeFile(target, `${JSON.stringify(state, null, 2)}\n`);
    return target;
  }
  const target = path.join(dir, `${body.id}.json`);
  await writeFile(target, `${JSON.stringify(body, null, 2)}\n`);
  return target;
}

/** True when the recipe was written for exactly this check (its class or its check id). */
export function recipeMatchesCheck(recipe: Recipe, check: CheckWords | null | undefined): boolean {
  const id = String(check?.id ?? "");
  return Boolean(id) && (recipe.checkClass === id || recipe.check?.id === id);
}

/**
 * Relevance of a recipe to a check: an exact class/id match, or a token overlap of at least
 * two words between the check's words (id, kind, camera, ask) and the recipe's tags/title/
 * checkClass. One shared word was enough once, and a ragdoll spike's recipe got retrieved
 * for — and then blamed for — a crosshair check. Retired recipes never come back; promoted
 * ones outrank candidates at equal overlap; a project-scoped recipe reaches another project
 * only on an exact match.
 */
export function scoreRecipe(
  recipe: Recipe,
  check: CheckWords | null | undefined,
  { project = null, kind = null }: { project?: string | null; kind?: string | null } = {},
): number {
  if (recipe.status === RecipeStatus.Retired) return 0;
  const exact = recipeMatchesCheck(recipe, check);
  if (belongsElsewhere(recipe, project) && !exact) return 0;
  // A recipe for other kinds of game reaches this one only on its own check.
  if (fitsOtherKinds(recipe, kind) && !exact) return 0;
  const words = new Set(checkTokens(check));
  const bag = new Set(
    [
      ...recipe.tags,
      ...String(recipe.title)
        .toLowerCase()
        .split(/[^a-z0-9]+/),
      ...String(recipe.checkClass)
        .toLowerCase()
        .split(/[^a-z0-9.]+/),
      ...String(recipe.check?.id ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/),
    ].filter((w) => w.length >= 3),
  );
  let overlap = 0;
  for (const word of words) {
    if (bag.has(word)) overlap += 1;
    else if ([...bag].some((b) => sharesStem(word, b))) overlap += 0.5;
  }
  if (exact) overlap += 2;
  if (overlap < MIN_OVERLAP) return 0;
  const promotion = recipe.status === RecipeStatus.Promoted ? 1.5 : 1;
  const record = 1 + (recipe.stats.wins - recipe.stats.losses) * 0.1;
  return overlap * promotion * Math.max(0.5, record);
}

/** How retrieval narrows: this game's project and kind, the score a word overlap must reach, and the checks only an exact recipe may answer. */
export interface RetrievalOptions {
  project?: string | null;
  kind?: string | null;
  /** The least score a hit that is not the recipe's own check needs (CRAFT_ADOPT_SCORE in a brief). */
  minScore?: number;
  /** Checks answered by exact matches only: nothing has failed them yet, so two words in common are no reason. */
  exactOnly?: readonly string[];
}

/**
 * The few recipes worth a failing check's attention, with which checks each one serves.
 * `primaryCheckId` is the check the recipe was retrieved for most strongly — the only check
 * whose outcome the recipe is later credited or blamed for.
 */
export function recipesForChecks(
  recipes: readonly Recipe[] | null | undefined,
  failingChecks: readonly (CheckWords & { id: string })[] | null | undefined,
  limit = MAX_RECIPES_PER_BRIEF,
  options: RetrievalOptions = {},
): RecipeHit[] {
  const scored = new Map<string, RecipeHit>();
  for (const check of failingChecks ?? []) {
    for (const recipe of recipes ?? []) {
      const score = retrievalScore(recipe, check, options);
      if (score <= 0) continue;
      const entry = scored.get(recipe.id) ?? { recipe, score: 0, checkIds: [], primaryCheckId: check.id };
      if (score > entry.score) {
        entry.score = score;
        entry.primaryCheckId = check.id;
      }
      if (!entry.checkIds.includes(check.id)) entry.checkIds.push(check.id);
      scored.set(recipe.id, entry);
    }
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A recipe's score for one check under the retrieval's narrowing; 0 when it does not make the cut. */
function retrievalScore(
  recipe: Recipe,
  check: CheckWords & { id: string },
  { project = null, kind = null, minScore = 0, exactOnly = [] }: RetrievalOptions,
): number {
  const score = scoreRecipe(recipe, check, { project, kind });
  if (score <= 0 || recipeMatchesCheck(recipe, check)) return score;
  const weak = exactOnly.includes(check.id) || score < minScore;
  return weak ? 0 : score;
}

/**
 * The outcome gate. Called at most ONCE per recipe per iteration, for the check the recipe
 * was retrieved for: that check flipping is a win, that check measurably still failing is a
 * loss; an unmeasured check is neither and must not reach here. Promotion and demotion are
 * counts, not votes. A project-scoped recipe that wins in another project becomes global.
 */
export function applyRecipeOutcome(
  recipe: Recipe,
  { checkId, flipped, evidence = null }: { checkId: string; flipped: boolean; evidence?: AnyRecord | null },
): Recipe {
  recipe.stats.applied += 1;
  if (flipped) recipe.stats.wins += 1;
  else recipe.stats.losses += 1;
  if (evidence)
    recipe.evidence = [
      ...recipe.evidence.slice(-(MAX_RECIPE_EVIDENCE - 1)),
      { ...evidence, checkId, flipped, at: new Date().toISOString() },
    ];
  if (flipped && belongsElsewhere(recipe, evidence?.project)) recipe.scope = RecipeScope.Global;
  const { wins, losses } = recipe.stats;
  const provenByWins = wins >= PROMOTE_AFTER_WINS && wins > losses;
  const beatenByLosses = losses >= RETIRE_AFTER_LOSSES && losses > wins * RETIRE_LOSS_RATIO;
  if (recipe.status !== RecipeStatus.Retired && provenByWins) recipe.status = RecipeStatus.Promoted;
  if (beatenByLosses) {
    recipe.status = RecipeStatus.Retired;
    recipe.retiredBecause = `${losses} losses against ${wins} wins on ${checkId}`;
  }
  return recipe;
}

/** A recipe born from a passing spike — the code that hit the check, as evidence. */
export function recipeFromSpike({
  id,
  check,
  tags,
  intent,
  sketch,
  port,
  evidence,
  origin = "spike",
  project = null,
}: {
  id: string;
  check?: CheckWords | null;
  tags?: string[];
  intent?: string;
  sketch?: string;
  port?: string;
  evidence?: AnyRecord | null;
  origin?: string;
  project?: string | null;
}): Recipe | null {
  return normalizeRecipe({
    id,
    title: intent?.split("\n")[0]?.slice(0, CLIP_QUOTE) || id,
    tags: [...new Set([...(tags ?? []), ...checkTokens(check)])],
    checkClass: check?.id ?? "",
    intent:
      String(intent ?? "").trim() ||
      `Technique that satisfies ${check?.id ?? "the check"}, proven in a spike; see the sketch.`,
    sketch,
    check,
    port,
    evidence: evidence ? [{ ...evidence, at: new Date().toISOString() }] : [],
    stats: { applied: 0, wins: 1, losses: 0 },
    status: RecipeStatus.Candidate,
    origin,
    scope: project ? RecipeScope.Project : RecipeScope.Global,
    ...(project ? { project } : {}),
  });
}

// ── craft ──────────────────────────────────────────────────────────────────────────────────

/**
 * Craft: the opinions that used to be law.
 *
 * The seed shipped forty-one hand-written opinions about northern-European winter villages in
 * `library/checks.json`, and every plan for every game got them offered as reusable checks —
 * a racing game was told what a snow ridge on a branch must measure. They now live in
 * `library/recipes` as craft recipes, each carrying the check body it used to be, and they
 * reach a builder three ways: the check fails (exact retrieval by id, the oldest path), a
 * judge names the defect the recipe is about (retrieval from prose, `checksFromDefects`), or
 * a plan asks for one by name (`withCraftChecks`, capped at MAX_CRAFT per facet).
 */

/** A recipe that carries an opinion with a check body to measure it by. */
export function isCraftRecipe(recipe: Recipe | null | undefined): recipe is Recipe & { check: AnyRecord } {
  return recipe?.kind === RecipeKind.Craft && Boolean(recipe?.check?.id);
}

/** Every craft check the library holds, by check id: `id -> { recipe, check }`. */
export function craftChecks(
  recipes: readonly Recipe[] | null | undefined,
): Map<string, { recipe: Recipe; check: AnyRecord }> {
  const out = new Map<string, { recipe: Recipe; check: AnyRecord }>();
  for (const recipe of recipes ?? []) {
    if (!isCraftRecipe(recipe)) continue;
    const id = String(recipe.check.id).toLowerCase();
    if (!id || out.has(id)) continue;
    out.set(id, { recipe, check: recipe.check });
  }
  return out;
}

/**
 * The craft library as a menu the planner reads: one line per recipe, grouped by pack, so a
 * plan can ask for the few its game actually needs. Deliberately small — forty-one one-liners
 * with their notes is seven kilobytes of prompt, and the point of this change was that nobody
 * has to read them all. `perPack` lines per pack, notes cut to CRAFT_NOTE_CHARS, and the whole
 * block dropped back line by line (largest pack first) until it fits CRAFT_MENU_MAX.
 */
export function renderCraftForPlanner(
  recipes: readonly Recipe[] | null | undefined,
  { perPack = 4, max = CRAFT_MENU_MAX }: { perPack?: number; max?: number } = {},
): string {
  const packs = new Map<string, Recipe[]>();
  const ranked = (recipes ?? [])
    .filter((r) => isCraftRecipe(r) && r.status !== RecipeStatus.Retired)
    .sort(
      (a, b) =>
        (b.status === RecipeStatus.Promoted ? 1 : 0) - (a.status === RecipeStatus.Promoted ? 1 : 0) ||
        b.stats.wins - b.stats.losses - (a.stats.wins - a.stats.losses) ||
        (a.id < b.id ? -1 : 1),
    );
  for (const recipe of ranked) {
    const pack = recipe.pack || recipe.checkClass || "craft";
    const list = packs.get(pack) ?? [];
    if (list.length < perPack) list.push(recipe);
    packs.set(pack, list);
  }
  if (packs.size === 0) return "";
  const header = [
    "## Craft recipes — technique, not law (library/recipes)",
    `Name at most ${MAX_CRAFT} ids in a facet's "craft" and the harness puts that recipe's check on its board. Everything else is retrieved for the builder the moment a check fails or a judge names the matching defect — you do not have to ask for it here.`,
  ];
  const clip = (note: string): string =>
    note.length <= CRAFT_NOTE_CHARS ? note : `${note.slice(0, CRAFT_NOTE_CHARS).replace(/\s+\S*$/, "")}…`;
  const line = (recipe: Recipe): string => `- ${recipe.id} — ${clip(recipe.note)}`;
  const render = () =>
    [
      ...header,
      ...[...packs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .flatMap(([pack, list]) => ["", `### ${pack}`, ...list.map(line)]),
    ].join("\n");
  let text = render();
  while (text.length > max) {
    const largest = [...packs.entries()].sort(([aId, a], [bId, b]) => b.length - a.length || (aId < bId ? -1 : 1))[0];
    if (!largest || largest[1].length === 0) break;
    largest[1].pop();
    if (largest[1].length === 0) packs.delete(largest[0]);
    if (packs.size === 0) return "";
    text = render();
  }
  return text;
}

/**
 * Put the craft checks a facet asked for on its board. Each entry resolves as a recipe id
 * first and as the id of the check that recipe carries second, so a plan may name either. A
 * check already on the board is left alone (the plan's own wording wins), the board's own
 * ceiling is respected, and every adopted check lands at weight `normal`, origin `craft` and
 * `fromRecipe` — which is what keeps it out of the catalogue afterwards.
 *
 * Called inside `decompose`, in the per-facet loop right after `validateFacetSpec`, so the
 * `unknown` ids it reports still reach the planner's single re-ask.
 */
export function withCraftChecks<S extends { craft?: unknown; checks?: Check[]; cameras?: string[] }>(
  spec: S,
  recipes: readonly Recipe[] | null | undefined,
  { max = MAX_CRAFT, maxChecks = MAX_CHECKS }: { max?: number; maxChecks?: number } = {},
): { spec: S; added: Array<{ id: string; recipe: string }>; unknown: string[]; dropped: string[] } {
  const wanted = [
    ...new Set<string>(
      (Array.isArray(spec?.craft) ? spec.craft : [])
        .map((c: unknown) => String(c).trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, max);
  if (!wanted.length) return { spec, added: [], unknown: [], dropped: [] };
  const byRecipe = new Map<string, Recipe & { check: AnyRecord }>();
  const byCheck = craftChecks(recipes);
  for (const recipe of recipes ?? [])
    if (isCraftRecipe(recipe) && !byRecipe.has(recipe.id)) byRecipe.set(recipe.id, recipe);
  const board: CraftBoard = {
    checks: [...(spec?.checks ?? [])],
    onBoard: new Set((spec?.checks ?? []).map((c) => c.id)),
    cameras: [...(spec?.cameras ?? [])],
    added: [],
    unknown: [],
    dropped: [],
  };
  for (const id of wanted) {
    const recipe = byRecipe.get(id) ?? byCheck.get(id)?.recipe ?? null;
    adoptCraftCheck(board, id, recipe, maxChecks);
  }
  const { checks, cameras, added, unknown, dropped } = board;
  if (added.length === 0) return { spec, added, unknown, dropped };
  return { spec: { ...spec, checks, cameras: cameras.slice(0, MAX_CAMERAS) }, added, unknown, dropped };
}

/** A facet's board while craft checks are put on it, and what happened to each one asked for. */
interface CraftBoard {
  checks: Check[];
  onBoard: Set<string>;
  cameras: string[];
  added: Array<{ id: string; recipe: string }>;
  unknown: string[];
  dropped: string[];
}

/** A camera the evidence pass does not capture yet; the harness's own player-eye cameras never need declaring. */
function isUndeclaredCamera(board: CraftBoard, camera: string): boolean {
  return !camera.startsWith("eye:") && !board.cameras.includes(camera);
}

/** Put one asked-for craft recipe's check on the board, or say why it is not there. */
function adoptCraftCheck(board: CraftBoard, id: string, recipe: Recipe | null, maxChecks: number): void {
  if (!recipe) {
    board.unknown.push(id);
    return;
  }
  if (board.onBoard.has(String(recipe.check?.id))) return;
  if (board.checks.length >= maxChecks) {
    board.dropped.push(recipe.id);
    return;
  }
  const check = normalizeCheck(
    { ...recipe.check, weight: CheckWeight.Normal, origin: CheckOrigin.Craft, fromRecipe: recipe.id },
    board.checks.length,
  );
  if (!check) {
    board.unknown.push(id);
    return;
  }
  board.checks.push(check);
  board.onBoard.add(check.id);
  board.added.push({ id: check.id, recipe: recipe.id });
  // A camera the check names has to be a camera the evidence pass captures — except the
  // harness's own player-eye cameras, which are never declared.
  if (check.camera && isUndeclaredCamera(board, check.camera)) board.cameras.push(check.camera);
}

/**
 * Retrieval from prose. A judge's defect sentence is not a check, but it is words about the
 * same thing a recipe is words about: "[blob] the reeds are grey faceted balls on sticks"
 * should reach `flora.organic-not-solid`. Each sentence becomes a pseudo-check the ordinary
 * `scoreRecipe` path can rank — kind `defect`, so nothing mistakes it for something on the
 * board, and the leading `[class]` marker stripped out of the id but kept in the words.
 */
export function checksFromDefects(
  defects: readonly unknown[] | null | undefined,
  { limit = 6 }: { limit?: number } = {},
): Array<{ id: string; kind: string; note: string; defect: string }> {
  const out: Array<{ id: string; kind: string; note: string; defect: string }> = [];
  const seen = new Set<string>();
  for (const raw of defects ?? []) {
    const text = String(
      typeof raw === "string" ? raw : ((raw as AnyRecord | null)?.what ?? (raw as AnyRecord | null)?.defect ?? ""),
    ).trim();
    if (!text) continue;
    const body = text.replace(/^\s*\[[^\]]{1,40}\]\s*/, "").trim() || text;
    const id = `defect:${slug(body, "defect")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind: "defect", note: clip(text, CLIP_DETAIL), defect: clip(text, CLIP_DETAIL) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The craft recipe worth handing a builder alongside a check somebody just wrote — a judge's
 * new vision check, a milestone's check. Only a real overlap counts: below CRAFT_ADOPT_SCORE
 * two words in common is a coincidence, and a wrong recipe costs an iteration. `kind` is the
 * game's kind: a recipe for other kinds of game reaches it only on its own check.
 */
export function craftForNewCheck(
  recipes: readonly Recipe[] | null | undefined,
  newCheck: CheckWords | null | undefined,
  { min = CRAFT_ADOPT_SCORE, limit = 1, kind = null }: { min?: number; limit?: number; kind?: string | null } = {},
): Array<{ recipe: Recipe; score: number }> {
  const hits: Array<{ recipe: Recipe; score: number }> = [];
  for (const recipe of recipes ?? []) {
    if (!isCraftRecipe(recipe)) continue;
    const score = scoreRecipe(recipe, newCheck, { kind });
    if (score >= min) hits.push({ recipe, score });
  }
  return hits.sort((a, b) => b.score - a.score || (a.recipe.id < b.recipe.id ? -1 : 1)).slice(0, limit);
}

// ── the worktree brief ─────────────────────────────────────────────────────────────────────

/**
 * `.studio/BRIEF.md` — the one file per iteration a builder is told to read first. Written by
 * the harness, gitignored by its own `.gitignore`, so it never lands in a commit or a merge.
 */
/** What one iteration's `.studio/BRIEF.md` is written from. */
export interface BriefOptions {
  run: Pick<Run, "runId" | "goal"> &
    Partial<Pick<Run, "reference" | "game" | "engine" | "builderEngine" | "heldHudGeneration">>;
  /** The facet loop passes its seam here too; briefWithMovedSections (facet-loop.ts) renders it, not renderBrief. */
  ownsMain?: boolean;
  entryMain?: string;
  ownShape?: boolean;
  build?: string | null;
  /**
   * The part; `ownsScreen` / `screenOwner` (loop/screen-owner.ts) name who draws the screen, and
   * `doNotRegress` what the art director says already works in the whole game.
   */
  spec: Pick<FacetSpec, "id" | "title" | "intent" | "identity" | "owns" | "checks" | "doNotRegress"> & ScreenOwnerSpec;
  iteration: number;
  board?: Scoreboard | null;
  comparison?: { flips?: string[]; regressions?: string[] } | null;
  attempts?: AnyRecord[];
  recipes?: RecipeHit[];
  spike?: string | null;
  steering?: string[];
  review?: { violations?: AnyRecord[] } | null;
  integration?: string | null;
  resumed?: boolean;
  defects?: string[];
  /** The judge's polish notes on the accepted build: optional, after the move and the defects. */
  polish?: string[];
  style?: StyleForBrief | null;
  flags?: AnyRecord[];
  lessons?: string[];
  gameLessons?: string[];
  move?: AnyRecord | null;
  liveness?: string | null;
  fix?: AnyRecord | null;
  screen?: boolean;
  critic?: string;
  template?: boolean;
  game?: AnyRecord | null;
  /** The worker's stage (facet/stage.ts): "finish" makes polish the work; anything else is the build stage. */
  stage?: string | null;
  /** The brief's ceiling (loop/brief-budget.ts); the lowest sections leave first when it is over. */
  maxChars?: number;
  /** Where the retrieved recipes are written whole (`.studio/RECIPES.md`): the brief then points there for every sketch but the fix's. */
  recipesFile?: string | null;
  /** The worker's build block (facet/build-block.ts): its first, long round, and the bench page it names. */
  buildBlock?: { bench: string | null } | null;
  /** What undone rounds had fixed that the accepted build still fails (facet/carried-fixes.ts): carried over. */
  carried?: CarriedFix[];
}

/** Per-camera style distance to the stills, now and the round before. */
export interface StyleForBrief {
  shots?: ReadonlyArray<{ camera?: string; stats?: StyleStats | null } | null | undefined>;
  references?: ReferenceStats[];
  previous?: Array<{ camera?: string; distance?: number | null }>;
  pairs?: Array<{ camera?: string; path?: string }>;
}

/**
 * BRIEF.md, within `maxChars` (BRIEF_MAX_CHARS): the lessons, the style distances, the earlier
 * rounds' diff stats, the recipes' sketches and the optional polish leave in that order when it is
 * over (loop/brief-budget.ts). The goal, the steering, the move or the finish, THE FIX, the checks
 * and the rules are always there.
 */
export function renderBrief(options: BriefOptions): string {
  return fitWithin(options.maxChars ?? BRIEF_MAX_CHARS, (cuts) => renderBriefSections(options, cuts));
}

/** Every section of the brief, without the ones `cuts` takes out. */
function renderBriefSections(
  {
    run,
    spec,
    iteration,
    board,
    comparison,
    attempts = [],
    recipes = [],
    spike = null,
    steering = [],
    review = null,
    integration = null,
    resumed = false,
    defects = [],
    polish = [],
    /** `{ shots, references, previous }` — per-camera style distance to the stills (WP4e). */
    style = null,
    /** The builder's own `HARNESS:` flags acknowledged by the loop. */
    flags = [],
    lessons = [],
    /** What earlier runs on THIS game cost (loop/ledger.ts) — already one sentence each. */
    gameLessons = [],
    /** This iteration's structural move: `{ what, why?, milestoneId?, check?, mandatory?, ladder?, polishStreak?, escalated? }`. */
    move = null,
    /** The liveness critic's last card, already rendered to lines (judge.ts renderLiveness). */
    liveness = null,
    /** THE FIX: a biggest gap the judge repeated — `{ what, checkId?, streak, mandatory, recipe? }`; `recipe` is the craft recipe retrieved for the defect sentence. */
    fix = null,
    /** false for a game the user brought with its own UI and input handling — the one-screen rule is the template's, not this game's. */
    screen = true,
    /** Which critic asked the liveness question — "place" (a world you stand in) or "screen" (a board, a puzzle, a builder). */
    critic = "place",
    /** false for a game the user brought: the determinism, one-input-path and Blender rules are the studio template's craft law, not this game's (M4.6). */
    template = true,
    /** The run's declared game — kind, traits and play script (loop/kinds.ts). Its one line heads the brief the way it heads every judge call. */
    game = null,
    /** "finish" for a worker finishing what exists: THE FINISH replaces THE MOVE, and the polish list is the work. */
    stage = null,
    recipesFile = null,
    buildBlock = null,
    carried = [],
  }: BriefOptions,
  cuts: ReadonlySet<BriefCut>,
): string {
  const finishing = stageOf({ stage }) === FacetStage.Finish;
  const recipeShape = { file: recipesFile, pinned: fix?.recipe?.id ?? null, bodies: !cuts.has(BriefCut.RecipeBodies) };
  const lines = [
    ...briefHeader(run, spec, iteration, game),
    ...steeringSection(steering),
    ...(buildBlock ? blockBriefSection(buildBlock.bench) : []),
    ...(finishing ? finishSection(polish, finishRules(spec, screen && template)) : moveSection(move)),
    ...fixSection(fix, template, finishing),
    ...carryOverSection(carried),
    ...scoreboardSection(board, comparison, spec),
    ...doNotRegressSection(spec.doNotRegress),
    ...(integration ? [`## Integration`, clipWords(integration, BRIEF_INTEGRATION_CHARS), ``] : []),
    ...livenessSection(liveness, critic, finishing),
    ...(cuts.has(BriefCut.Style) ? [] : styleSection(style)),
    ...flagsSection(flags),
    ...defectsSection(defects, move),
    ...(finishing || cuts.has(BriefCut.Polish) ? [] : polishSection(polish)),
    ...reviewSection(review),
    ...(spike ? [`## Spike result`, spike, ``] : []),
    ...attemptsSection(attempts, !cuts.has(BriefCut.DiffStats), carried.length > 0),
    ...recipesSection(recipes, recipeShape),
    ...briefRules(run, spec, { screen, template, resumed }),
    ...(cuts.has(BriefCut.Lessons) ? [] : lessonsSections(gameLessons, lessons)),
  ];
  return lines
    .filter((line) => line !== undefined && line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The brief's head: the facet, the run and its game, the intent, identity, seam and checks. */
function briefHeader(
  run: BriefOptions["run"],
  spec: BriefOptions["spec"],
  iteration: number,
  game: AnyRecord | null,
): string[] {
  const notes = run.reference?.notes ? ` — ${run.reference.notes}` : "";
  return [
    `# Brief — facet "${spec.title}" (${spec.id}), iteration ${iteration}`,
    ``,
    `Run ${run.runId} · goal: ${run.goal}`,
    gameLine(game ?? run?.game),
    run.reference?.name ? `Reference / direction: ${run.reference.name}${notes}` : "",
    ``,
    `## Intent`,
    spec.intent,
    ``,
    spec.identity?.length ? `Identity features, ranked: ${spec.identity.join(" > ")}` : "",
    spec.owns?.length ? `Files this facet owns: ${spec.owns.join(", ")}` : "",
    ``,
    `## Checks (the contract — verified by the harness every iteration)`,
    renderChecks(spec.checks),
    ``,
  ];
}

/**
 * What the art director says already works in the whole game (director/art-direction.ts): every
 * builder keeps it, and the round's taste judge calls losing one a regression. Nothing when no
 * review has named any.
 */
function doNotRegressSection(doNotRegress: readonly string[] | undefined): string[] {
  if (!doNotRegress?.length) return [];
  return [
    `## Do not regress — what already works in the whole game, as the art director last named it`,
    ...doNotRegress.map((item) => `- ${item}`),
    `A build that loses one of these where your part touches it has regressed: the taste judge rolls it back.`,
    ``,
  ];
}

/** What the user asked for this run, above everything else. */
function steeringSection(steering: readonly string[]): string[] {
  if (!steering.length) return [];
  return [`## USER STEERING — obeys over everything below`, ...steering.map((s) => `- ${s}`), ``];
}

/** This iteration's structural move, and how it is judged. */
function moveSection(move: AnyRecord | null): string[] {
  if (!move?.what) return [];
  return [
    move.mandatory
      ? `## THE MOVE this iteration (mandatory — a build that only tunes what already exists is a loss)`
      : `## THE MOVE this iteration (asked for — build it first; a build without it is judged on its own merits and the move is asked again)`,
    move.what,
    move.why ? `Why now: ${move.why}` : "",
    move.check
      ? `Measured by check ${move.check.id} (on the board above); the taste judge also answers whether the move is visible.`
      : "The taste judge answers whether this change is visible in your build; make it unmistakable.",
    `Alongside the move, fix up to three items from the defect ledger below — the move first, the polish second. Never spend the iteration on the ledger alone.`,
    moveEscalated(move)
      ? `ESCALATE: the last ${move.polishStreak} accepted builds were polish only. The judge now rejects a build without the move.`
      : "",
    move.ladder ? `\nThe facet's ladder:\n${move.ladder}` : "",
    ``,
  ];
}

/**
 * The finish rules this part reads: the stage's own, or — in a template game where another part
 * owns the screen (loop/screen-owner.ts) — the same rules with the HUD's craft handed to that part.
 */
function finishRules(spec: BriefOptions["spec"], applies: boolean): readonly string[] {
  return (applies ? screenOwnerFinishRules(spec) : null) ?? FINISH_RULES;
}

/** A finishing worker's iteration: no move — the judge's polish list, all of it, is the work. */
function finishSection(polish: readonly string[], rules: readonly string[] = FINISH_RULES): string[] {
  return [
    FINISH_SECTION_HEAD,
    ...rules,
    ...(polish.length
      ? ["", FINISH_POLISH_HEAD, ...polish.slice(0, FINISH_POLISH_NOTES).map((p, i) => `${i + 1}. ${p}`)]
      : []),
    ``,
  ];
}

/** The biggest gap the judge keeps naming, and how to replace the mechanism behind it (or, finishing, close it). */
function fixSection(fix: AnyRecord | null, template: boolean, finishing = false): string[] {
  if (!fix?.what) return [];
  const urgency = fix.mandatory
    ? "mandatory — a build that leaves it loses, whatever else it flips"
    : `named by the judge ${fix.streak} judged builds in a row — mandatory from the next verdict on`;
  return [
    `## THE FIX this iteration (${urgency})`,
    fix.what,
    fix.checkId
      ? `Measured by check ${fix.checkId} on the board below. It fails on the accepted build; your build must flip it.`
      : "The taste judge answers whether it is gone: if it is still the biggest gap after your build, the build loses.",
    fix.recipe
      ? `The library has a recipe for exactly this: ${fix.recipe.title} (${fix.recipe.id}) — it is under "Recipes that apply" below. Port it; do not invent a fourth way.`
      : "",
    // A finishing worker may close a polish defect by tuning: "do not tune it" is the build stage's.
    finishing ? FINISH_FIX_LINE : fixMechanismLine(template),
    ``,
  ];
}

/** THE FIX's build-stage instruction: replace the mechanism, in the template's terms or the game's own. */
function fixMechanismLine(template: boolean): string {
  // The named modules are the studio template's own (foliage.js, materials.js). A game the
  // user brought has neither, and the builder's seam forbids inventing them at those paths,
  // so it hears the same rule in its own game's terms. The Blender clause stays on the run,
  // not on the shape: the modeller is granted to an own-shape worker too.
  return template
    ? `Replace the mechanism behind it, do not tune it. A faceted or smooth solid that should read as something organic (a tree, a bush, hay, an animal) is rebuilt from cards or parts (\`foliage.js\`); a flat wash that should read as a material gets a baked material kind (\`materials.js\`); a thing that floats gets a contact patch and sinks. Land it in the same build as the move — the move comes first, this before the rest of the ledger.`
    : `Replace the mechanism behind it, do not tune it. A faceted or smooth solid that should read as something organic (a tree, a bush, hay, an animal) is rebuilt out of cards or parts, the way this game already builds its objects; a flat wash that should read as a material gets a material this game's renderer can bake; a thing that floats gets a contact patch and sinks. Land it in the same build as the move — the move comes first, this before the rest of the ledger.`;
}

/**
 * The board after the last judged build: identity first, and what could not be measured. Only this
 * build's questions: a harness check it cannot answer (loop/applies-to-build.ts) is not named.
 */
function scoreboardSection(
  board: Scoreboard | null | undefined,
  comparison: BriefOptions["comparison"],
  spec: BriefOptions["spec"],
): string[] {
  if (!board || !Object.keys(board).length) {
    return [
      `## Scoreboard`,
      `No build has been judged yet — every check above is currently failing. Flip as many as you can, identity first.`,
      ``,
    ];
  }
  const entries = Object.values(board).filter((e) => appliesToBuild(e, spec));
  const identityFailing = entries.filter((e) => e.pass === false && e.weight === CheckWeight.Identity);
  const unmeasuredEntries = entries.filter((e) => e.pass !== true && e.pass !== false);
  const lines = [`## Scoreboard after the last judged build`, renderScoreboard(board, comparison, spec), ``];
  if (identityFailing.length) {
    lines.push(
      `Work identity checks first: ${identityFailing.map((e) => e.id).join(", ")}. A lower check must not be polished while an identity check still fails.`,
      ``,
    );
  }
  if (unmeasuredEntries.length) {
    lines.push(
      `UNMEASURED (the harness could not gather evidence for these — they are not failures, and not passes): ${unmeasuredEntries.map((e) => `${e.id} — ${e.reason}`).join("; ")}. If the reason names something you control (a demo, a camera), register it.`,
      ``,
    );
  }
  return lines;
}

/** The liveness (or readability) critic's last card. */
function livenessSection(liveness: string | null, critic: string, finishing = false): string[] {
  if (!liveness) return [];
  // A finishing worker builds nothing new: the critic's grow notes wait for the build stage.
  // "deepen", never "build": the critic's fixes deepen what the user asked for (loop/scope.ts).
  const key = finishing ? FINISH_CRITIC_KEY : "grow = what to deepen next, polish = optional";
  return [
    critic === "screen"
      ? `## Why the screen does not read yet (the readability critic, 0–3 per principle; ${key})`
      : `## Why it does not feel like a real place yet (the liveness critic, 0–3 per principle; ${key})`,
    clipWords(liveness, BRIEF_LIVENESS_CHARS),
    ``,
  ];
}

/** How far each camera is from the reference stills. */
function styleSection(style: StyleForBrief | null): string[] {
  const distances = renderStyleDistances(style);
  if (!distances.length) return [];
  return [
    `## Distance to the references (0 = same statistics as a still; lower is better, tol 0.02)`,
    ...distances,
    ``,
  ];
}

/** The builder's own `HARNESS:` flags, acknowledged. */
function flagsSection(flags: readonly AnyRecord[]): string[] {
  if (!flags.length) return [];
  return [
    `## Your HARNESS: flags (acknowledged — the loop acts on them)`,
    ...flags.map((f) => {
      const action = f.action ? `: ${f.action}` : "";
      return `- ${f.what}${f.checkId ? ` → check ${f.checkId}${action}` : ""}`;
    }),
    ``,
  ];
}

/** The judge's defect ledger, worst first. */
function defectsSection(defects: readonly string[], move: AnyRecord | null): string[] {
  if (!defects.length) return [];
  return [
    `## The judge's defect ledger (broken or missing, worst first — the worst are also vision checks above${move?.what ? "; fix up to three alongside the move" : ""})`,
    ...defects.slice(0, MAX_BRIEF_DEFECTS).map((d, i) => `${i + 1}. ${d}`),
    ``,
  ];
}

/** The judge's polish notes: optional, and never a round's whole work. */
function polishSection(polish: readonly string[]): string[] {
  if (!polish.length) return [];
  return [
    `## Polish the judge noticed (optional — only once the move and the defects are done; never a round's whole work)`,
    ...polish.slice(0, MAX_BRIEF_POLISH).map((p) => `- ${p}`),
    ``,
  ];
}

/** What the code review flagged: the first few, and how many more there are. */
function reviewSection(review: BriefOptions["review"]): string[] {
  const violations = review?.violations ?? [];
  if (!violations.length) return [];
  const more = violations.length - REVIEW_VIOLATIONS_SHOWN;
  return [
    `## Code review flagged (fix these first)`,
    ...violations
      .slice(0, REVIEW_VIOLATIONS_SHOWN)
      .map((v) => `- ${v.file}${v.line ? `:${v.line}` : ""} — ${v.what}${v.fix ? ` → ${v.fix}` : ""}`),
    ...(more > 0 ? [`- (+${more} more)`] : []),
    ``,
  ];
}

/**
 * The latest rounds, kept or lost, with what they flipped, broke and changed. Every round used
 * to be filed under "Attempts that lost — do not repeat them", accepted ones too, which told a
 * builder not to repeat the work it had just been kept for.
 */
function attemptsSection(attempts: readonly AnyRecord[], diffStats = true, carrying = false): string[] {
  if (!attempts.length) return [];
  const exception = carrying ? CARRY_OVER_EXCEPTION : "";
  const lines = [`## Earlier rounds (build on what was kept; do not repeat what lost${exception})`];
  for (const attempt of attempts.slice(-EARLIER_ROUNDS_SHOWN)) lines.push(...attemptLines(attempt, diffStats));
  lines.push(``);
  return lines;
}

/** One earlier round: kept or lost, its line, its diff stat (unless the budget took them) and its newest notes. */
function attemptLines(attempt: AnyRecord, diffStats = true): string[] {
  const flipped = (attempt.flips ?? []).join(", ") || "nothing";
  const regressed = (attempt.regressions ?? []).join(", ") || "nothing";
  const fate = attempt.won ? "kept" : "lost";
  const lines = [
    `- iteration ${attempt.iteration}, ${fate} — its code is on ${attempt.branch ?? "n/a"}: flipped [${flipped}], regressed [${regressed}]${attempt.why ? ` — ${attempt.why}` : ""}`,
  ];
  if (diffStats && attempt.diffStat)
    lines.push(
      "  ```",
      ...String(attempt.diffStat)
        .trim()
        .split("\n")
        .slice(0, DIFF_STAT_LINES)
        .map((l) => `  ${l}`),
      "  ```",
    );
  // The notes file appends, so its end is the newest: that is what the next builder reads.
  if (attempt.notes) lines.push(`  notes: ${clipTailWords(attempt.notes, CLIP_BRIEF)}`);
  return lines;
}

/** How the recipes render: the file their bodies were written to, the fix's own recipe, and whether bodies fit at all. */
interface RecipeShape {
  file: string | null;
  pinned: string | null;
  bodies: boolean;
}

/** The recipes retrieved for what is failing. */
function recipesSection(recipes: readonly RecipeHit[], shape: RecipeShape): string[] {
  if (!recipes.length) return [];
  return [
    `## Recipes that apply to what is failing (retrieved by failing check, and by the defects the judge named — a "for defect:…" line is prose the judge wrote, not a check on your board)`,
    ...recipes.flatMap((hit) => recipeLines(hit, shape)),
  ];
}

/**
 * One recipe: its title, its intent, and its sketch and port inline, or a pointer to the file
 * that has them. With a recipes file only THE FIX's own recipe keeps its sketch here; without
 * one (a direct engine, an older caller) every sketch stays inline unless the budget took them.
 */
function recipeLines({ recipe, checkIds }: RecipeHit, shape: RecipeShape): string[] {
  const hasBody = Boolean(recipe.sketch?.trim() || recipe.port);
  const keptHere = shape.file ? shape.bodies && recipe.id === shape.pinned : shape.bodies;
  const pointer =
    hasBody && shape.file ? `Sketch and port: ${shape.file}, under "${recipe.title} (${recipe.id})".` : "";
  const how = shape.file ? clipWords(recipe.intent, RECIPE_INTENT_CHARS) : recipe.intent;
  return [
    `### ${recipe.title} (${recipe.id}, ${recipe.status}; ${recipe.stats.wins}W/${recipe.stats.losses}L) — for ${checkIds.join(", ")}`,
    // Past the budget only the title and the pointer stay: the file has the rest.
    shape.bodies ? `How: ${how}` : "",
    keptHere && recipe.sketch ? "```js\n" + recipe.sketch.trim() + "\n```" : "",
    keptHere && recipe.port ? `Port: ${recipe.port}` : "",
    keptHere ? "" : pointer,
    ``,
  ];
}

/** The rules that do not change, in the template's terms or the game's own. */
function briefRules(
  run: BriefOptions["run"],
  spec: BriefOptions["spec"],
  { screen, template, resumed }: { screen: boolean; template: boolean; resumed: boolean },
): string[] {
  return [
    `## Rules that do not change`,
    `- Tag every object you create: \`obj.userData.tag = "<tag>"\` — untagged objects are invisible to scene checks and do not count.`,
    // A game keeping an edited older HUD (held-hud.ts) is told only what that HUD draws.
    screen
      ? (heldHudBriefRule(run) ??
        `- ONE SCREEN: all UI goes through \`__studio.hud\`, drawn into the canvas: text, bars, arcs and gauges, vector paths, images, rounded panels and bundled fonts, anchored to the frame in frame fractions (a bar's length is a fraction of the frame's width and its thickness of its height; arcs, paths, panels and images are sized in frame heights, so a curve stays round and sharp — never build one out of rectangles). Keep the middle of the view for the game: the harness measures how much of the frame the HUD covers and which items run into each other. No DOM elements, no second HUD quad or canvas, no camera-parented panels — the harness-owned checks no-dom-ui and single-hud fail the build otherwise.`)
      : `- THE GAME'S OWN SCREEN: this game has its own UI and input handling — keep them as they are; do not add __studio.hud overlays or a second input path.`,
    // Who owns that screen (loop/screen-owner.ts), where the rule holds: nothing when no part does.
    ...briefScreenOwner(spec, screen && template),
    template
      ? `- ONE INPUT PATH: read keys from ctx.keys (Mouse1/Mouse2 included), mouse look from ctx.look, wheel from ctx.wheel — never add your own pointer-lock or mousemove listeners; studio.js owns them and feeds the same ctx a human's mouse does.`
      : `- THIS GAME'S INPUT PATH: it already reads its own keys and mouse — leave that alone. The studio's input arrives as real DOM events on the page, so the listeners this game has are the ones that get it.`,
    template
      ? `- Keep window.__studio working (installStudio with scene/renderer/camera/player passed). A build the harness cannot inspect is a loss.`
      : `- Keep the studio able to see this game. It attaches to whatever your three renders — do not fight it; and where the entry calls \`installStudio({ renderer, player })\`, leave those two lines in. A build the harness cannot inspect is a loss.`,
    template
      ? `- Determinism: rng from update(), no Math.random, no wall clock.`
      : `- Determinism: the studio seeds Math.random and owns the clock for this page, so the same seed replays the same run — take time from the delta your own loop already computes, never from a second clock of your own.`,
    `- Capture (${toolCall(roleEngine(run, RoleKey.Builder), "capture")}) after every meaningful change and LOOK before you finish; write what you tried and why in ${facetNotes(spec.id)}.`,
    ...(template ? [benchRule(spec.id)] : []),
    `- A line beginning \`HARNESS:\` in ${facetNotes(spec.id)} is read by the loop, not by the next builder: use it to say a check cannot pass as written (name the check id) or that a camera cannot see what it asks — the planner re-points the check instead of you burning iterations.`,
    resumed
      ? `- You are resuming your own session: you remember your previous attempt — change the mechanism where a check keeps failing, do not re-tune the same numbers.`
      : "",
  ];
}

/** The screen owner's line (screen-owner-prompts.ts) for a template game's brief, or nothing. */
function briefScreenOwner(spec: BriefOptions["spec"], applies: boolean): string[] {
  const line = applies ? screenOwnerLine(spec) : null;
  return line ? [line] : [];
}

/**
 * The fast self-look: a page that mounts one module loads in seconds where the whole game takes
 * most of a minute. It stays out of index.html, so it never enters the judged build; the round's
 * evidence pass still judges the game.
 */
function benchRule(facetId: string): string {
  const page = benchPage(facetId);
  return `- For work inside one module, keep a bench page ${page} that mounts just your module, and capture page=${page} to look at it in seconds; index.html never references a bench page. Capture the game itself before you finish.`;
}

/**
 * The game's own lessons before the general ones: what this exact game cost last time beats
 * what some other game taught, and both sit below the steering the user gave this run.
 */
function lessonsSections(gameLessons: readonly string[], lessons: readonly string[]): string[] {
  const lines: string[] = [];
  if (gameLessons.length)
    lines.push(
      ``,
      `## LAST TIME ON THIS GAME (earlier runs on this exact game — do not pay for them again)`,
      ...gameLessons.slice(0, MAX_GAME_LESSONS).map((l) => `- ${l}`),
    );
  if (lessons.length)
    lines.push(
      ``,
      `## Lessons from past runs (each cost a run — do not re-learn them)`,
      // The file appends (loop/contract-lessons.ts), so the newest are last: those are shown.
      ...lessons.slice(-MAX_BRIEF_LESSONS).map((l) => `- ${l}`),
    );
  return lines;
}

/** A camera's trend against the round before: better, WORSE or the same, within the tolerance. */
function styleTrend(distance: number, before: { distance?: number | null } | undefined): string {
  if (!before || typeof before.distance !== "number") return "";
  let direction = ", same";
  if (distance < before.distance - STYLE_TOLERANCE) direction = ", better";
  else if (distance > before.distance + STYLE_TOLERANCE) direction = ", WORSE";
  return ` (was ${before.distance.toFixed(3)}${direction})`;
}

/** Is this a camera the brief compares to the stills? Not a demo's, and not the user's own view. */
function comparesToStills(camera: string | undefined): boolean {
  return !String(camera ?? "").startsWith("demo:") && camera !== "user:view";
}

/** One line per camera: distance now, before, the nearest still, and the pair image path. */
export function renderStyleDistances(style: StyleForBrief | null | undefined): string[] {
  const refs = style?.references ?? [];
  if (!style || !refs.length) return [];
  const previous = new Map((style.previous ?? []).map((p) => [p.camera, p]));
  const pairs = new Map((style.pairs ?? []).map((p) => [p.camera, p.path]));
  const out: string[] = [];
  for (const shot of style.shots ?? []) {
    if (!shot?.stats || !comparesToStills(shot.camera)) continue;
    const near = nearestReference(shot.stats, refs);
    if (!near) continue;
    const trend = styleTrend(near.distance, previous.get(shot.camera));
    const pair = pairs.get(shot.camera);
    out.push(
      `- ${shot.camera}: ${near.distance.toFixed(3)}${trend} — nearest still "${near.label}"${pair ? ` — pair image: ${pair} (Read it: reference LEFT, your build RIGHT)` : ""}`,
    );
  }
  return out;
}

/**
 * A file in the worktree's own `.studio/` — the scratch folder the brief, the director's
 * memory and a builder's helper scripts all live in. Self-ignoring: a worktree scaffolded
 * before `.studio/` joined the template still keeps everything here out of every commit and
 * merge.
 */
export async function writeWorktreeFile(dir: string, name: string, text: string): Promise<string> {
  const studioDir = path.join(dir, ".studio");
  await mkdir(studioDir, { recursive: true });
  await writeFile(path.join(studioDir, ".gitignore"), "*\n");
  const file = path.join(studioDir, name);
  await writeFile(file, text);
  return file;
}

export async function writeWorktreeBrief(dir: string, text: string): Promise<string> {
  return writeWorktreeFile(dir, "BRIEF.md", text);
}
