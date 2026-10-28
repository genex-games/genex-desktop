/**
 * The look bar's words (look-bar.ts holds its rules): the art pass's grammar and refusals, the
 * lines every builder of a run with an art pass reads, and the shipped-look question its judges
 * answer per scene camera.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import {
  ArtKind,
  ArtRefusal,
  ArtSource,
  ArtTier,
  LookBlocker,
  MAX_ART_ASSETS,
  runArtPass,
  type ArtAsset,
  type ArtProblem,
} from "./look-bar.ts";
import { BUDGETS_NEVER_CUT_MAPS, bootBudgetLine } from "./destination-budgets.ts";

/** How the art pass is written: the plan's `art` argument. */
export const ART_GRAMMAR = `art is a JSON array of up to ${MAX_ART_ASSETS} assets, every area's: [{"area":"the yard","tier":"${ArtTier.Hero}","kind":"${ArtKind.Prop}","asset":"weathered park bench, snow on the slats","source":"${ArtSource.GenexModel}","tags":["bench"]},{"area":"the yard","tier":"${ArtTier.Mid}","kind":"${ArtKind.Structure}","asset":"panel-block facades and garages","source":"${ArtSource.BlenderKit}","why":"modular shell wearing the concrete_panels and worn_corrugated_iron scans","tags":["block","garage"]},{"area":"the yard","tier":"${ArtTier.Scatter}","kind":"${ArtKind.Surface}","asset":"snow-covered ground with drifts","source":"${ArtSource.Scan}","tags":["ground"]},{"area":"the yard","tier":"${ArtTier.Sky}","kind":"${ArtKind.Atmosphere}","asset":"overcast winter HDRI sky, flat grey light, falling snow","source":"${ArtSource.Scan}"}]. tier is ${ArtTier.Hero} (near the camera: hands, weapon, props within a few metres), ${ArtTier.Mid} (buildings, vehicles, trees at play distance), ${ArtTier.Scatter} (ground cover, debris) or ${ArtTier.Sky} (sky, weather, the light's mood); every tier is listed. kind is ${Object.values(ArtKind).join(", ")}. source is ${ArtSource.GenexModel}, ${ArtSource.GenexTexture} or ${ArtSource.GenexCharacter} (a Genex plugin generation), ${ArtSource.Scan} (a Poly Haven or ambientCG texture set or HDRI), ${ArtSource.Cc0Model} (a CC0 model, decimated to its tier), ${ArtSource.BlenderKit} (a modular bpy kit — walls, floors, trims, building shells — wearing scans named in "why"; never a hero, a prop, a character or anything organic), or ${ArtSource.Code} — geometry built in code, the last resort, with "why" no other source serves. A bpy script of untouched boxes and cones is ${ArtSource.Code}, whatever folder it lands in. tags are the draw tags the game draws the asset under, so the delivered files can be checked against this plan. A night or horror look says "night":true on its sky row; every other game's playable cameras are held to the day luminance band. "none" only when the ask sets no visual bar.`;

/** What a refused art pass is told, by code. */
const REFUSAL_WORDS: Record<ArtRefusal, (problem: ArtProblem) => string> = {
  [ArtRefusal.Missing]: () =>
    "the ask sets a visual bar (a photoreal, realistic, AAA or beautiful look, or reference stills), so the plan needs its art pass: art= lists every area's assets and where each comes from before a builder starts",
  [ArtRefusal.NotJson]: () => "art is not JSON",
  [ArtRefusal.NotList]: () => `art must be a JSON array of 1–${MAX_ART_ASSETS} assets`,
  [ArtRefusal.BadAsset]: (problem) =>
    `art asset ${problem.names.join(", ")} needs an area, the asset in words, a known tier and a known source`,
  [ArtRefusal.TierMissing]: (problem) => `art lists no ${problem.names.join(", ")} asset`,
  [ArtRefusal.CodeWithoutWhy]: (problem) =>
    `art builds ${problem.names.join(", ")} in code without a why: code-built geometry is the last resort, so say why a Genex generation, a scan or Blender cannot make it, or pick one of them`,
  [ArtRefusal.KindMissing]: (problem) =>
    `art asset ${problem.names.join(", ")} needs its kind (${Object.values(ArtKind).join(", ")}): the kind decides where it may come from`,
  [ArtRefusal.KitNotForHero]: (problem) =>
    `art plans ${problem.names.join(", ")} as a ${ArtSource.BlenderKit}: a kit is the modular shell only, never a hero asset, a prop, a character or anything organic — source those from ${ArtSource.GenexModel}, ${ArtSource.Cc0Model} or ${ArtSource.GenexCharacter}`,
  [ArtRefusal.KitWithoutWhy]: (problem) =>
    `art plans ${problem.names.join(", ")} as a ${ArtSource.BlenderKit} without a why: name the scans the kit wears`,
  [ArtRefusal.AreaUnplanned]: (problem) =>
    `the plan adds ${problem.names.join(", ")} and keeps an art pass that plans nothing for it: give art= again, the whole pass with the new area's assets in it`,
};

/** The plan's answer to a refused art pass: what is wrong, and the grammar. */
export function artRefusalWords(problem: ArtProblem): string {
  return `plan: ${REFUSAL_WORDS[problem.code](problem)}. ${ART_GRAMMAR}`;
}

/** One planned asset as a builder reads it. */
const assetLine = (asset: ArtAsset): string =>
  `- ${asset.area} · ${asset.tier}: ${asset.asset} ← ${asset.source}${asset.why ? ` (${asset.why})` : ""}${asset.tags?.length ? ` [draw tags: ${asset.tags.join(", ")}]` : ""}`;

/** The rule every builder of a run with an art pass works under. */
export const GREYBOX_RULE = `Greybox is a step inside a round, never a finish: a placeholder box, capsule or stick the judge sees is [${LookBlocker.Primitive}], and while any look blocker is on screen ([${Object.values(LookBlocker).join("], [")}]) no part closes. Replace your greybox with the asset the art pass names before you call a part done.`;

/**
 * The art pass as a builder's brief carries it: the assets, their sources, the Genex generations
 * reserved for them and the greybox rule. Empty when the run has no art pass.
 */
export function artPassLines(run: { readonly [field: string]: unknown } | null | undefined): string {
  const art = runArtPass(run);
  if (!art) return "";
  const reserved = art.generations
    ? `${art.generations} Genex generation${art.generations === 1 ? " is" : "s are"} reserved for these assets: spend Genex generation on them before anything else.`
    : "";
  return [
    "ART PASS — where every asset comes from (the director's plan; code-built geometry only where it says so):",
    ...art.assets.map(assetLine),
    reserved,
    GREYBOX_RULE,
    bootBudgetLine(run as Parameters<typeof bootBudgetLine>[0]),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The shipped-look question one judge answers for each scene camera, against the reference stills
 * when the run has them. A camera that would not pass becomes a `[not-shipped]` blocker.
 */
export function shippedLookLine(genre: string | null, stills: boolean, subject = "the better build"): string {
  const against = stills ? "next to the REFERENCE stills" : "by the bar the ask sets";
  const game = genre ? `a shipped ${genre} game` : "a shipped game of this genre";
  return `SHIPPED LOOK: for each scene camera of ${subject}, answer in "shipped": would this frame, ${against}, pass as a screenshot from ${game}? [{"camera":"<its label>","passes":true|false,"why":"the one thing that gives it away"}]. Be strict: a frame a player would know as unfinished does not pass.`;
}

/**
 * The art-bar question a taste judge answers on a run with a visual bar: which look blockers the
 * build the checks accepted shows that the other does not, and the rule that a build below the
 * bar has regressed even where the other build lacks the thing. Gen3 kept a bench of twelve boxes
 * because a new ugly bench was never a regression against no bench.
 */
export function artBarLine(accepted: string): string {
  return `ART BAR: in "added", list each look blocker (tagged, what, where, camera) that build ${accepted} shows and the other build does not — a new box bench, stick tree or slab of snow where the other build had nothing is added. A round that adds one is not kept, whatever checks flipped. "Worse against the art bar" is a regression: when build ${accepted} adds something below the bar, pick the other build and name it in "regression", even though the other build lacks the thing.`;
}

/**
 * The art pass as the lead's rules say it, for a run whose ask sets a visual bar: list every area's
 * assets with a source before the builders start, reserve the Genex generations, never ship greybox.
 */
export const ART_PASS_RULE = `- Art pass: this ask sets a visual bar, so \`plan\` takes art= — every area's assets by tier (hero assets near the camera, mid-range, scatter and ground cover, sky with weather and the light's mood), each with its kind, its draw tags and its source: a Genex plugin generation (model, texture, rigged character), a CC0 model, a Poly Haven or ambientCG scan, or a Blender kit for the modular shell only (walls, floors, trims, building blocks wearing scans — never a hero, a prop, a character or anything organic); code-built geometry, a box-and-cone bpy script included, is the last resort and says why. At round end the harness follows every planned tag to its file and its lock row: a tag delivered from a lesser source than planned is [${LookBlocker.ArtSourceMismatch}] and the round is not kept. A re-plan that adds a part gives art= again with that area's assets. The Genex generations it names are reserved for it: spend them on those assets first. Greybox is a step inside a round and never closes a part — a judge that sees a look blocker holds it open. ${BUDGETS_NEVER_CUT_MAPS}`;
