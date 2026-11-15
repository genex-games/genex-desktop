/**
 * How a card's thumbnail fills its frame (`panels/AssetThumbnail.tsx`). A picture with nothing
 * see-through fills the frame edge to edge, cropping a little, so no band of the frame shows above
 * or below it. A model's or texture's render and a see-through sprite keep their whole shape, on
 * what is behind the frame. Main makes a picture's thumbnail a JPEG unless a pixel of it is
 * see-through (`main/preview-images.ts`), so the thumbnail's own type tells the two apart.
 */
import { assetPreviewMode } from "../shared/asset-preview.ts";
import type { ProjectAsset } from "../shared/game-assets.ts";

/** The two ways a thumbnail fills its frame, as CSS `object-fit` names them. */
export const ThumbnailFit = { Cover: "cover", Contain: "contain" } as const;
export type ThumbnailFit = (typeof ThumbnailFit)[keyof typeof ThumbnailFit];

/** The start of a JPEG data URL: a picture with no transparency. */
const OPAQUE_PICTURE = "data:image/jpeg;";

/** How the thumbnail `src` made for `asset` fills its frame; a picture it cannot tell is kept whole. */
export function thumbnailFit(asset: Pick<ProjectAsset, "file" | "render">, src: string): ThumbnailFit {
  if (asset.render) return ThumbnailFit.Contain;
  const mode = assetPreviewMode(asset.file);
  if (mode === "video") return ThumbnailFit.Cover;
  const opaquePicture = mode === "image" && src.startsWith(OPAQUE_PICTURE);
  return opaquePicture ? ThumbnailFit.Cover : ThumbnailFit.Contain;
}
