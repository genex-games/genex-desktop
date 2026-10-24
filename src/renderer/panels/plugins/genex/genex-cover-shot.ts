/**
 * The game's kept Genex cover shot as a picture the renderer can show: read from Genex's storage
 * by the game's name (`readProjectAsset`'s `genex-cover` scope), never a picture a tool carried.
 */
import { ProjectAssetScope } from "../../../../shared/game-assets.ts";

/** The kept shot as an image source, read at `maxPx` (or whole), or null when there is none. */
export async function readGenexShot(project: string, maxPx?: number): Promise<string | null> {
  const request = { project, scope: ProjectAssetScope.GenexCover, ...(maxPx ? { maxPx } : {}) };
  const image = await window.studio.readProjectAsset(request).catch(() => null);
  return image ? `data:${image.mimeType};base64,${image.data}` : null;
}
