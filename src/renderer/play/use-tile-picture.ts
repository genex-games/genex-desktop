/**
 * The picture on one of Play's asset tiles: its cover or an image's own file at once, or a preview of
 * its 3D file drawn the way the Assets tab draws one. The file is read through main (only from
 * genex.games' asset hosts), drawn off screen once the tile is on screen, a few at a time, and kept
 * for the session, so a tile that comes back shows it at once.
 */
import type { RefObject } from "react";
import { useEffect, useMemo, useState } from "react";
import { ASSET_PREVIEW_MIME, assetExtension, PreviewFileError } from "../../shared/asset-preview.ts";
import { viewerSnapshot } from "../asset-snapshot.ts";
import { studio } from "../state/studio.ts";
import { type AssetTile, PictureFrom, tilePicture } from "./asset-tiles.ts";
import { type ModelFile, pictureFileBytes, pictureQueue, viewerFileOf } from "./tile-pictures.ts";

/** A drawn picture's side in CSS pixels: a tile's widest in the usual window. */
const PICTURE_PX = 256;
/** The type of bytes no format table names. */
const UNKNOWN_TYPE = "application/octet-stream";

const MESSAGE = { notTheFile: "A tile's model reads only its own file." } as const;

/** Read a library model through main and draw it; a resource it names beside itself is not read. */
async function drawModel(model: ModelFile): Promise<string> {
  const data = pictureFileBytes(await studio().api.assetLibraryFile(model.url));
  const file = viewerFileOf(model);
  const mimeType = ASSET_PREVIEW_MIME[assetExtension(file)] ?? UNKNOWN_TYPE;
  return viewerSnapshot({
    file,
    companions: [],
    read: async (name) => {
      // A model that needs files beside it is one a tile cannot draw, however often it asks.
      if (name !== file) throw new PreviewFileError(MESSAGE.notTheFile);
      return { mimeType, data };
    },
    width: PICTURE_PX,
    height: PICTURE_PX,
  });
}

/** The session's drawn pictures, shared by every tile. */
const pictures = pictureQueue(drawModel);

/**
 * The picture drawn from the 3D file at `url` (of `format`, when main knows it) for the tile `ref`
 * holds: kept, or asked for while the
 * tile is on screen (a tile that leaves before its turn gives its turn up; one whose draw failed for a
 * reason that may pass asks again when next on screen). Null until it is drawn, or when it cannot be.
 */
function useDrawnPicture(url: string | null, format: string | null, ref: RefObject<HTMLElement | null>): string | null {
  const [picture, setPicture] = useState(() => (url ? (pictures.drawn(url) ?? null) : null));
  useEffect(() => {
    const kept = url ? pictures.drawn(url) : undefined;
    setPicture(kept ?? null);
    const target = ref.current;
    if (!url || kept || !target) return;
    let asking: AbortController | null = null;
    let mounted = true;
    const ask = (): void => {
      const controller = new AbortController();
      asking = controller;
      pictures.request({ url, format }, controller.signal).then(
        (drawn) => {
          if (mounted) setPicture(drawn);
        },
        () => {
          // Left the screen before its turn, or a draw failed for a reason that may pass (it asks again
          // when next on screen), or the file itself cannot be drawn.
          if (asking === controller) asking = null;
        },
      );
    };
    const observer = new IntersectionObserver((entries) => {
      const onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen && !asking) ask();
      if (onScreen) return;
      asking?.abort();
      asking = null;
    });
    observer.observe(target);
    return () => {
      mounted = false;
      observer.disconnect();
      asking?.abort();
    };
  }, [url, format, ref]);
  return picture;
}

/** What a tile's square shows from: its cover or image file, or its 3D file's drawn picture; null keeps the glyph. */
export function useTilePicture(tile: AssetTile, ref: RefObject<HTMLElement | null>): string | null {
  const picture = useMemo(() => tilePicture(tile), [tile]);
  const model = picture?.from === PictureFrom.Model ? picture : null;
  const drawn = useDrawnPicture(model?.url ?? null, model?.format ?? null, ref);
  return model ? drawn : (picture?.url ?? null);
}
