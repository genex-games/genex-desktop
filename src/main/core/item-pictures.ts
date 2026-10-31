/**
 * Studio's own copy of each local draft's picture (`<userData>/item-pictures/<game>/.genex/items/
 * <localId>/<name>`), kept as the CLI wrote it. A Loop's builder lists store items in its build's
 * copy of the game, which reaches the game's own folder only when the build lands, yet the item's
 * card shows its picture at once: the card reads this copy first, then the game's own folder (a
 * draft made before Studio kept copies). The copy sits outside every agent-writable root, and only
 * a plain file in the draft's own folder is copied, never through a link.
 */
import { copyFile, lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { isLocalPicture, type LocalListingDraft } from "../../shared/item-draft.ts";
import { assertProjectName } from "../../substrate/game-workspace.ts";
import { readContainedImage } from "../game-assets.ts";

/**
 * The smallest side of a store item's picture: its card shows it square and edge to edge, sharp at
 * twice the card's size. genex.games takes up to 4096 × 4096.
 */
export const PICTURE_SIDE_MIN = 768;
/** The bytes read to find a picture's size: its header. */
const PICTURE_HEADER_BYTES = 32;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The largest picture Studio keeps a copy of: what the card would read at all. */
const KEPT_PICTURE_MAX_BYTES = 16 * 1024 * 1024;
/** Where a local draft's picture lives in a game, and so in its kept copy. */
const LOCAL_ITEMS_PREFIX = ".genex/items/";

/** The kept copies of `project`'s pictures, laid out as the game lays out its drafts. */
function keptFolder(root: string, project: string): string {
  assertProjectName(project);
  return path.join(root, project);
}

/**
 * Keeps `draft`'s picture from `folder`, the CLI's run folder that holds what it just wrote: the
 * draft's earlier copy goes first, so a renamed picture leaves nothing behind. Nothing is kept for a
 * draft with no picture, or one that is not a plain file of a size the card reads.
 */
export async function keepDraftPicture(root: string, folder: string, draft: LocalListingDraft): Promise<void> {
  const file = draft.picture;
  if (!file || !isLocalPicture(file)) return;
  const source = path.join(folder, ...file.split("/"));
  const st = await lstat(source).catch(() => null);
  if (!st?.isFile() || st.size > KEPT_PICTURE_MAX_BYTES) return;
  const kept = keptFolder(root, draft.project);
  const target = path.join(kept, ...file.split("/"));
  await rm(path.dirname(target), { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

/**
 * A local draft's picture for its card: Studio's kept copy, else the game's own folder (`game`).
 * Null for anything that is not a draft's picture or does not read as an image.
 */
export async function readItemPicture(
  where: { root: string; game: string },
  project: string,
  file: string,
  resize: { resize?: (data: Buffer) => Promise<Buffer> } = {},
): Promise<{ mimeType: string; data: string } | null> {
  if (!isLocalPicture(file)) return null;
  const options = { prefixes: [LOCAL_ITEMS_PREFIX], ...resize };
  const kept = await readContainedImage(keptFolder(where.root, project), file, options);
  return kept ?? readContainedImage(where.game, file, options);
}

/** A width and a height in pixels. */
export interface PictureSize {
  width: number;
  height: number;
}

/** A WebP's size from the chunk after its RIFF header: extended, lossless or lossy. */
function webpSize(head: Buffer): PictureSize | null {
  const chunk = head.toString("latin1", 12, 16);
  if (chunk === "VP8X") return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
  if (chunk === "VP8L") {
    const bits = head.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
  return null;
}

/** A PNG's or WebP's size from its header; null for anything else. */
export function pictureSize(head: Buffer): PictureSize | null {
  const png = head.length >= 24 && head.subarray(0, 8).equals(PNG_SIGNATURE);
  if (png && head.toString("latin1", 12, 16) === "IHDR")
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  const webp = head.length >= 30 && head.toString("latin1", 0, 4) === "RIFF";
  return webp && head.toString("latin1", 8, 12) === "WEBP" ? webpSize(head) : null;
}

/** The size of the picture file `file` (a real path the caller checked), or null when it is not a PNG or WebP. */
export async function readPictureSize(file: string): Promise<PictureSize | null> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(PICTURE_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, PICTURE_HEADER_BYTES, 0);
    return pictureSize(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Whether a picture fills a store item's card: square, and at least {@link PICTURE_SIDE_MIN} a side. */
export const fitsItemCard = (size: PictureSize): boolean =>
  size.width === size.height && size.width >= PICTURE_SIDE_MIN;
