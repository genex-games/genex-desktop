/**
 * Which files the Assets canvas draws: the ones that get a card, and its tabs (All, and one per
 * media kind). Pure, so what a tab keeps and counts can be checked without a window. A file of no
 * media kind shows under All only.
 */
import { type MakingJob, MakingKind } from "../shared/asset-making.ts";
import type { AssetKind, ProjectAsset } from "../shared/game-assets.ts";
import { withoutGenexSources } from "../shared/genex.ts";
import type { FoldedMotions } from "../shared/model-rig.ts";

/** The tabs, each named by the asset kind it keeps; also a tab's `data-assets-tab`. */
export const AssetTab = {
  All: "all",
  Models: "model",
  Images: "image",
  Sounds: "audio",
  Video: "video",
} as const satisfies Record<string, AssetKind | "all">;
export type AssetTab = (typeof AssetTab)[keyof typeof AssetTab];

/** How a source's cards run (`assets-layout.ts`): its newest job first, or its files by name or by size. */
export const AssetOrder = { Newest: "newest", Name: "name", Size: "size" } as const;
export type AssetOrder = (typeof AssetOrder)[keyof typeof AssetOrder];

/** The tabs in the order the canvas draws them. */
export const ASSET_TABS: readonly AssetTab[] = Object.values(AssetTab);

/** The tab a job still on its way lands in, by what it is making. */
const TAB_OF_MAKING = {
  [MakingKind.Character]: AssetTab.Models,
  [MakingKind.Creature]: AssetTab.Models,
  [MakingKind.Model]: AssetTab.Models,
  [MakingKind.RiggedModel]: AssetTab.Models,
  [MakingKind.Animation]: AssetTab.Models,
  [MakingKind.Image]: AssetTab.Images,
  [MakingKind.Texture]: AssetTab.Images,
  [MakingKind.Video]: AssetTab.Video,
  [MakingKind.SoundEffect]: AssetTab.Sounds,
  [MakingKind.Music]: AssetTab.Sounds,
  [MakingKind.Voice]: AssetTab.Sounds,
} as const satisfies Record<MakingKind, AssetTab>;

/**
 * The files that get a card. Every file has one while the models' headers are still being read
 * (`folded` null), so the canvas shows at once; once they are read, clips ride on their model (a
 * clip with no model keeps its own card), and a Genex source copy on the finished model it was made
 * into.
 */
export function cardedAssets(assets: readonly ProjectAsset[], folded: FoldedMotions | null): ProjectAsset[] {
  if (!folded) return withoutGenexSources(assets);
  return withoutGenexSources(
    assets.filter((asset) => !folded.motions.has(asset.file) || folded.loose.includes(asset.file)),
  );
}

/** How many files each tab holds. */
export function tabCounts(assets: readonly ProjectAsset[]): Record<AssetTab, number> {
  const counts: Record<AssetTab, number> = {
    [AssetTab.All]: assets.length,
    [AssetTab.Models]: 0,
    [AssetTab.Images]: 0,
    [AssetTab.Sounds]: 0,
    [AssetTab.Video]: 0,
  };
  for (const asset of assets) if (asset.kind !== "other") counts[asset.kind]++;
  return counts;
}

/** The files a tab keeps, in the order given; All keeps the list itself. */
export function assetsOfTab<T extends readonly ProjectAsset[]>(assets: T, tab: AssetTab): T | ProjectAsset[] {
  return tab === AssetTab.All ? assets : assets.filter((asset) => asset.kind === tab);
}

/** The jobs still on their way that a tab keeps; one that never said what it makes shows under All only. */
export function waitingOfTab<T extends readonly MakingJob[]>(waiting: T, tab: AssetTab): T | MakingJob[] {
  if (tab === AssetTab.All) return waiting;
  return waiting.filter((job) => job.kind !== undefined && TAB_OF_MAKING[job.kind] === tab);
}
