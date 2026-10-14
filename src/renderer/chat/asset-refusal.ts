/**
 * Delivered files in the chat, pure: the line a file carries when the game's stack cannot load it,
 * which files become tiles, players or rows, and the page `AssetResults.tsx` shows. The host
 * decides a refusal (`stackAcceptsAsset`, marked `refused` on `asset.delivered`); this only finds
 * the words and keeps the row in view.
 */
import { assetPreviewMode } from "../../shared/asset-preview.ts";
import { type AssetDeliveredPayload, assetExtension } from "../../shared/game-assets.ts";
import { ASSET_REFUSAL_WORDS } from "../words.ts";

/** A delivered file, as far as this module reads it. */
type DeliveredFile = Pick<AssetDeliveredPayload["files"][number], "file" | "refused">;

/** Preview modes shown as a tile. */
const VISUAL: ReadonlySet<string> = new Set(["image", "model", "texture", "video"]);

/** Why `file` cannot be used by its game, or null when it can (or the refusal is one this renderer does not know). */
export function refusalLine(file: DeliveredFile): string | null {
  const { refused } = file;
  if (!refused || !Object.hasOwn(ASSET_REFUSAL_WORDS, refused)) return null;
  return ASSET_REFUSAL_WORDS[refused](assetExtension(file.file));
}

/** A file the game cannot load: a row that says so, never a tile or a player. */
export const isRefusedAsset = (asset: DeliveredFile): boolean => refusalLine(asset) !== null;

/** A picture, model, texture or video the game can load: a tile. */
export const isVisualAsset = (asset: DeliveredFile): boolean =>
  !isRefusedAsset(asset) && VISUAL.has(assetPreviewMode(asset.file));

/** A sound the game can load: a player strip. */
export const isAudioAsset = (asset: DeliveredFile): boolean =>
  !isRefusedAsset(asset) && assetPreviewMode(asset.file) === "audio";

/** What the chat shows of a delivery: a page of loadable media, and every refused file. */
export interface DeliveredPage<T> {
  /** Tiles, players and rows, `limit` at most: pictures first, then sounds. */
  media: T[];
  /** Every refused file's row: outside the page, so its reason is never behind "Show more assets". */
  refused: T[];
  /** More media waits for "Show more assets". */
  more: boolean;
}

/**
 * The page of `available` (the delivered files the game folder holds) the chat shows first.
 * Buffers, material and atlas files belong to the media beside them; alone they still get a row.
 */
export function deliveredPage<T extends DeliveredFile>(available: readonly T[], limit: number): DeliveredPage<T> {
  const visual = available.filter(isVisualAsset);
  const audio = available.filter(isAudioAsset);
  const media =
    visual.length || audio.length ? [...visual, ...audio] : available.filter((asset) => !isRefusedAsset(asset));
  return { media: media.slice(0, limit), refused: available.filter(isRefusedAsset), more: media.length > limit };
}
