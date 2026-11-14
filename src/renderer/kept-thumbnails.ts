/**
 * A card's thumbnail across sessions (`panels/AssetThumbnail.tsx`): the picture Studio kept earlier
 * is shown as it is, and one made now is handed over to be kept. The store is a convenience: a read
 * or a write that fails never costs the card its picture.
 */

import { assetPreviewMode } from "../shared/asset-preview.ts";
import type { ProjectAsset } from "../shared/game-assets.ts";

/** What stands between a data URL's type and its base64 bytes. */
const BASE64_MARK = ";base64,";
/**
 * The version of a picture's thumbnail: earlier ones were JPEGs, a sprite's transparency painted
 * black, so a key without it is never read back for a picture.
 */
const PICTURE_THUMBNAIL_VERSION = "see-through-1";

/**
 * The identity a card's thumbnail is kept and cached under: one version of one file of one game.
 * A picture's key carries its thumbnail version; a model's render kept earlier stands.
 */
export function thumbnailKey(
  project: string,
  asset: Pick<ProjectAsset, "file" | "assetRef" | "mtime" | "bytes" | "render">,
): string {
  const identity = [project, asset.assetRef ?? asset.file, asset.mtime, asset.bytes, asset.render];
  const picture = !asset.render && assetPreviewMode(asset.file) === "image";
  return JSON.stringify(picture ? [...identity, PICTURE_THUMBNAIL_VERSION] : identity);
}

/** A kept picture as the store answers it. */
export interface KeptPicture {
  mimeType: string;
  data: string;
}

/** The base64 bytes a data URL holds, or null when it holds none. */
export function pictureOfDataUrl(url: string): string | null {
  const at = url.startsWith("data:") ? url.indexOf(BASE64_MARK) : -1;
  if (at < 0) return null;
  return url.slice(at + BASE64_MARK.length) || null;
}

/** A kept picture as the data URL a card draws. */
export const dataUrlOf = (picture: KeptPicture): string => `data:${picture.mimeType}${BASE64_MARK}${picture.data}`;

/**
 * The card's picture as a data URL: the kept one when `read` has it, else `make`'s, handed to
 * `keep` without waiting for it. Rejects only as `make` does.
 */
export async function keptOrMade(store: {
  read: () => Promise<KeptPicture | null>;
  make: () => Promise<string>;
  keep: (data: string) => Promise<unknown>;
}): Promise<string> {
  // A store call that throws before it returns a promise is a failure like any other.
  const kept = await Promise.resolve()
    .then(store.read)
    .catch(() => null);
  if (kept) return dataUrlOf(kept);
  const made = await store.make();
  const data = pictureOfDataUrl(made);
  if (data)
    void Promise.resolve()
      .then(() => store.keep(data))
      .catch(() => {});
  return made;
}
