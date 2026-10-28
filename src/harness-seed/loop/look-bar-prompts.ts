/**
 * The look bar's words (look-bar.ts holds its rules): the art pass's grammar and refusals, the
 * lines every builder of a run with an art pass reads, and the shipped-look question its judges
 * answer per scene camera.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import {
  ArtRefusal,
  ArtSource,
  ArtTier,
  LookBlocker,
  MAX_ART_ASSETS,
  runArtPass,
  type ArtAsset,
  type ArtProblem,
} from "./look-bar.ts";

/** How the art pass is written: the plan's `art` argument. */
export const ART_GRAMMAR = `art is a JSON array of up to ${MAX_ART_ASSETS} assets, every area's: [{"area":"the yard","tier":"${ArtTier.Hero}","asset":"rusted Lada by the gate, snow on the roof","source":"${ArtSource.GenexModel}"},{"area":"the yard","tier":"${ArtTier.Scatter}","asset":"snow drifts and frozen weeds","source":"${ArtSource.Scan}"},{"area":"the yard","tier":"${ArtTier.Sky}","asset":"overcast winter sky, flat grey light, falling snow","source":"${ArtSource.Blender}"}]. tier is ${ArtTier.Hero} (near the camera: hands, weapon, props within a few metres), ${ArtTier.Mid} (buildings, vehicles, trees at play distance), ${ArtTier.Scatter} (ground cover, debris) or ${ArtTier.Sky} (sky, weather, the light's mood); every tier is listed. source is ${ArtSource.GenexModel}, ${ArtSource.GenexTexture} or ${ArtSource.GenexCharacter} (a Genex plugin generation), ${ArtSource.Scan} (Poly Haven or ambientCG), ${ArtSource.Blender} (a bpy script), or ${ArtSource.Code} — geometry built in code, the last resort, with "why" no other source serves. "none" only when the ask sets no visual bar.`;

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
};

/** The plan's answer to a refused art pass: what is wrong, and the grammar. */
export function artRefusalWords(problem: ArtProblem): string {
  return `plan: ${REFUSAL_WORDS[problem.code](problem)}. ${ART_GRAMMAR}`;
}

/** One planned asset as a builder reads it. */
const assetLine = (asset: ArtAsset): string =>
  `- ${asset.area} · ${asset.tier}: ${asset.asset} ← ${asset.source}${asset.why ? ` (${asset.why})` : ""}`;

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
 * The art pass as the lead's rules say it, for a run whose ask sets a visual bar: list every area's
 * assets with a source before the builders start, reserve the Genex generations, never ship greybox.
 */
export const ART_PASS_RULE = `- Art pass: this ask sets a visual bar, so \`plan\` takes art= — every area's assets by tier (hero assets near the camera, mid-range, scatter and ground cover, sky with weather and the light's mood), each with its source: a Genex plugin generation (model, texture, rigged character), a Poly Haven or ambientCG scan, or a Blender bpy script; code-built geometry is the last resort and says why. The Genex generations it names are reserved for it: spend them on those assets first. Greybox is a step inside a round and never closes a part — a judge that sees a look blocker holds it open.`;
