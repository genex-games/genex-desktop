/**
 * BRIEF.md's budget. Without a total bound a brief grows past what an engine reads, and an inline
 * copy cut from the end loses the seam and the entry rule. The brief has one ceiling, each long
 * section a cap of its own, and a fixed order in which the lowest sections leave when it is over:
 * what governs the round (the goal and scope, the steering, the move or the finish, THE FIX, the
 * checks, Done means and the rules) never does.
 *
 * Its own module, so a workspace that kept an older `library.ts` still links the phases that read
 * these names; library.ts re-exports BRIEF_MAX_CHARS.
 */

/** The whole brief, moved sections included: the inline brief a direct engine carries is the same size. */
export const BRIEF_MAX_CHARS = 12_000;
/** Review violations a brief lists; the rest are counted. */
export const REVIEW_VIOLATIONS_SHOWN = 6;
/** The liveness critic's card and the integration note, cut at a word past these. */
export const BRIEF_LIVENESS_CHARS = 1_200;
export const BRIEF_INTEGRATION_CHARS = 1_000;
/** A recipe's intent as the brief quotes it; RECIPES.md has the whole of it. */
export const RECIPE_INTENT_CHARS = 400;
/** The file beside BRIEF.md that holds the retrieved recipes whole: its name, and the path a brief names. */
export const RECIPES_FILE = "RECIPES.md";
export const RECIPES_FILE_PATH = ".studio/RECIPES.md";

/** A section the budget may take out of a brief, lowest first. Never rename a value: a brief's note names it. */
export const BriefCut = {
  Lessons: "lessons",
  Style: "style",
  DiffStats: "diff-stats",
  RecipeBodies: "recipe-bodies",
  Polish: "polish",
} as const;
export type BriefCut = (typeof BriefCut)[keyof typeof BriefCut];

/** The order sections leave an over-budget brief. */
export const BRIEF_DROP_ORDER: readonly BriefCut[] = [
  BriefCut.Lessons,
  BriefCut.Style,
  BriefCut.DiffStats,
  BriefCut.RecipeBodies,
  BriefCut.Polish,
];

/** How the brief's closing note names each section it left out. */
const CUT_WORDS = {
  [BriefCut.Lessons]: "the lessons from earlier runs",
  [BriefCut.Style]: "the distances to the references",
  [BriefCut.DiffStats]: "the earlier rounds' diff stats",
  [BriefCut.RecipeBodies]: `the recipes' text and sketches (whole in ${RECIPES_FILE_PATH} when it is there)`,
  [BriefCut.Polish]: "the judge's optional polish notes",
} as const satisfies Record<BriefCut, string>;

/**
 * The brief `render` makes, within `max` characters when it can be: sections leave in
 * BRIEF_DROP_ORDER until it fits, and a closing line says which went. A cut that changed nothing
 * is not named. What is left when every cut is made is what governs the round, kept whole.
 */
export function fitWithin(max: number, render: (cuts: ReadonlySet<BriefCut>) => string): string {
  const cuts = new Set<BriefCut>();
  let bare = render(cuts);
  let text = bare;
  for (const cut of BRIEF_DROP_ORDER) {
    if (text.length <= max) break;
    cuts.add(cut);
    const next = render(cuts);
    if (next.length === bare.length) {
      cuts.delete(cut);
      continue;
    }
    bare = next;
    text = withCutNote(next, cuts);
  }
  return text;
}

/** The heading of the brief's last section when the budget left something out. */
const CUT_HEADING = "## Left out of this brief";

/** The brief with its closing section naming what the budget left out: a section of its own, so nothing moved after it takes it along. */
function withCutNote(text: string, cuts: ReadonlySet<BriefCut>): string {
  if (!cuts.size) return text;
  const named = BRIEF_DROP_ORDER.filter((cut) => cuts.has(cut)).map((cut) => CUT_WORDS[cut]);
  return `${text}\n\n${CUT_HEADING}\nTo stay readable: ${named.join("; ")}.`;
}

/** A recipe as RECIPES.md renders it. */
interface RecipeForFile {
  recipe: { id: string; title: string; intent?: string; sketch?: string; port?: string };
  checkIds?: readonly string[];
}

/** What RECIPES.md says on a round that picked none, so an earlier round's recipes are not read again. */
const NO_RECIPES = "# Recipes for this round\n\nNo recipes apply this round. BRIEF.md is the whole brief.\n";

/** `.studio/RECIPES.md`: every retrieved recipe whole, its intent, its sketch and how to port it. */
export function renderRecipesFile(hits: readonly RecipeForFile[] | null | undefined): string {
  if (!hits?.length) return NO_RECIPES;
  const lines = [
    "# Recipes for this round",
    "",
    "The recipes BRIEF.md names, whole. Port what fits this game; do not paste a sketch you have not read.",
    "",
  ];
  for (const { recipe, checkIds } of hits ?? []) {
    lines.push(`## ${recipe.title} (${recipe.id})${checkIds?.length ? ` — for ${checkIds.join(", ")}` : ""}`);
    if (recipe.intent) lines.push(`How: ${recipe.intent}`);
    if (recipe.sketch?.trim()) lines.push("```js", recipe.sketch.trim(), "```");
    if (recipe.port) lines.push(`Port: ${recipe.port}`);
    lines.push("");
  }
  return lines.join("\n");
}
