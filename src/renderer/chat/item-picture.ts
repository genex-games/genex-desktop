/**
 * A local draft's picture for its card: the file the CLI keeps in the draft's own folder
 * (`.genex/items/<localId>/`), read through main as the game's item picture and shown as a data URL.
 * Read again when the draft's content changes, since an agent's new picture keeps the file's name.
 */
import { useEffect, useState } from "react";
import { ProjectAssetScope } from "../../shared/game-assets.ts";

/** The longest side a card's picture is read at: twice the card's 132-pixel render. */
const PICTURE_PX = 264;

/** The draft's picture as a data URL, or null while it has none or none is read. */
export function useLocalPicture(project: string, picture: string | null, contentHash: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!picture) return;
    let live = true;
    const request = { project, scope: ProjectAssetScope.ItemPicture, file: picture, maxPx: PICTURE_PX } as const;
    void window.studio
      .readProjectAsset(request)
      .then((image) => {
        if (live && image) setUrl(`data:${image.mimeType};base64,${image.data}`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // The hash is the draft's content: a new picture under the same name is read again.
  }, [project, picture, contentHash]);
  return url;
}
