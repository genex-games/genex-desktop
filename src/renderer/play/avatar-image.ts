/**
 * A picture the person chose, made into what genex.games takes as an avatar: its centred square,
 * 512 pixels a side, as a WebP of at most 512 KB. Done in the page, where the browser decodes and
 * encodes images; main only checks the bytes and sends them on.
 */
import { PLAY_AVATAR_MAX_BYTES, PLAY_AVATAR_SIDE } from "../../shared/play-people.ts";

/** The WebP qualities tried in turn until the picture fits. */
const QUALITIES = [0.9, 0.8, 0.65, 0.5] as const;

/** Where the centred square of a `width` × `height` picture starts, and its side. */
export function centredSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** The picture as a square avatar WebP; throws when it cannot be read or will not fit. */
export async function avatarWebp(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(PLAY_AVATAR_SIDE, PLAY_AVATAR_SIDE);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    const { x, y, side } = centredSquare(bitmap.width, bitmap.height);
    context.drawImage(bitmap, x, y, side, side, 0, 0, PLAY_AVATAR_SIDE, PLAY_AVATAR_SIDE);
    for (const quality of QUALITIES) {
      const blob = await canvas.convertToBlob({ type: "image/webp", quality });
      if (blob.type === "image/webp" && blob.size <= PLAY_AVATAR_MAX_BYTES)
        return new Uint8Array(await blob.arrayBuffer());
    }
    throw new Error("the picture does not fit");
  } finally {
    bitmap.close();
  }
}
