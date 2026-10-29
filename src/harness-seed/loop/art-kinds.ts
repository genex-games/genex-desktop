/**
 * What an art-pass asset is (`kind`), and the art pass read by kind. Its own module: a workspace
 * whose agent kept an older look-bar.ts still loads every module that reads kinds.
 *
 * A new module: a kept older sibling can never shadow these names.
 */

/** What an art-pass asset is, which decides the sources it may come from. */
export const ArtKind = {
  /** A movable object seen up close: furniture, a bench, a bin, a vehicle, a weapon. */
  Prop: "prop",
  /** Trees, bushes, grass, anything grown. */
  Organic: "organic",
  /** The modular shell: walls, floors, ceilings, trims, building blocks. */
  Structure: "structure",
  /** A surface: a PBR texture set or a decal. */
  Surface: "surface",
  /** A person or creature. */
  Character: "character",
  /** Sky, weather and the light's mood. */
  Atmosphere: "atmosphere",
} as const;
export type ArtKind = (typeof ArtKind)[keyof typeof ArtKind];

/** The draw tags the art pass plans as grown things (`kind: organic`): the engine cannot tell a tree from a post. */
export function organicTags(run: { readonly [field: string]: unknown } | null | undefined): Set<string> {
  const art = run?.art as { assets?: unknown } | null | undefined;
  const assets = (Array.isArray(art?.assets) ? art.assets : []) as Array<{ kind?: unknown; tags?: unknown }>;
  const tagsOf = (asset: { tags?: unknown }): string[] => (Array.isArray(asset.tags) ? asset.tags.map(String) : []);
  return new Set(assets.filter((asset) => asset.kind === ArtKind.Organic).flatMap(tagsOf));
}

/**
 * The parts a re-plan adds that the art pass it keeps plans nothing for: on a run with a visual
 * bar, a plan that adds a part and omits `art` must give the pass again with the new area in it.
 * Gen3's 16:45 re-plan added the yard, and its assets were planned by nobody.
 */
export function unplannedParts(previousWorkers: readonly string[], workers: readonly string[]): string[] {
  const before = new Set(previousWorkers);
  return workers.filter((id) => !before.has(id));
}
