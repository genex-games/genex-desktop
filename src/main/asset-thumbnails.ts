/**
 * The thumbnails the Assets canvas keeps between sessions: one small picture per card, in Studio's
 * own data and never in the game. A game's folder and a picture's file are named by a hash of the
 * game's name and of the key the card made the picture for, so no name from the page is ever a path.
 * Only bytes that are a picture are kept or answered, and a game keeps its newest pictures up to a cap.
 */
import { createHash } from "node:crypto";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { ensureDir, ensureDirBelow, readRegularFile, writeFileInDir } from "../substrate/fsx.ts";
import { sniffImage } from "../substrate/image-sniff.ts";

/** The largest picture kept: a card's thumbnail is a few dozen kilobytes. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
/** The most pictures one game keeps, and how many are left after its oldest are forgotten. */
const MAX_THUMBNAILS_PER_GAME = 2000;
const KEPT_AFTER_PRUNE = 0.8;
/** Base64 spends four characters on three bytes. */
const BASE64_CHARS_PER_BYTE = 4 / 3;
const MS_PER_SECOND = 1000;

/** A kept picture as the page draws it: its type, read from its bytes, and its bytes in base64. */
export interface KeptThumbnail {
  mimeType: string;
  data: string;
}

/** What a test may set: a game's cap, and the clock a kept picture is stamped with. */
export interface KeepOptions {
  maxFiles?: number;
  now?: () => number;
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Where a picture is kept: the game's folder under `root` and the file in it, both hashes. */
function placeOf(project: string, key: string): { folder: string; name: string } {
  return { folder: hashOf(project), name: hashOf(key) };
}

/** The picture kept for `key` in `project`, or null: none kept, or what is there is no picture. */
export async function readThumbnail(root: string, project: unknown, key: unknown): Promise<KeptThumbnail | null> {
  if (typeof project !== "string" || typeof key !== "string") return null;
  const { folder, name } = placeOf(project, key);
  const bytes = await readRegularFile(path.join(root, folder, name), MAX_THUMBNAIL_BYTES).catch(() => null);
  const image = bytes && sniffImage(bytes);
  return image ? { mimeType: image.mimeType, data: bytes.toString("base64") } : null;
}

/** The bytes of a picture small enough to keep, or null for anything else. */
function pictureBytes(data: unknown): Buffer | null {
  const tooLong = typeof data !== "string" || data.length > MAX_THUMBNAIL_BYTES * BASE64_CHARS_PER_BYTE + 4;
  if (tooLong) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.length <= MAX_THUMBNAIL_BYTES && sniffImage(bytes) ? bytes : null;
}

/**
 * Keep `data` (base64) as the picture for `key` in `project`; false when it is no small picture, the
 * names are malformed or the store cannot be written. Past the game's cap its oldest pictures go.
 */
export async function keepThumbnail(
  root: string,
  project: unknown,
  key: unknown,
  data: unknown,
  options: KeepOptions = {},
): Promise<boolean> {
  if (typeof project !== "string" || typeof key !== "string") return false;
  const bytes = pictureBytes(data);
  if (!bytes) return false;
  const { folder, name } = placeOf(project, key);
  try {
    await ensureDir(root);
    const dir = await ensureDirBelow(root, [folder]);
    await writeFileInDir(dir, name, bytes);
    const at = (options.now?.() ?? Date.now()) / MS_PER_SECOND;
    await utimes(path.join(dir, name), at, at);
    await forgetOldest(dir, options.maxFiles ?? MAX_THUMBNAILS_PER_GAME);
    return true;
  } catch {
    return false;
  }
}

/** Past `maxFiles` pictures in `dir`, remove the oldest until a share of the cap is left. */
async function forgetOldest(dir: string, maxFiles: number): Promise<void> {
  const names = await readdir(dir);
  if (names.length <= maxFiles) return;
  const aged = await Promise.all(
    names.map(async (name) => ({ name, at: (await stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  aged.sort((a, b) => a.at - b.at);
  const keep = Math.max(1, Math.floor(maxFiles * KEPT_AFTER_PRUNE));
  for (const { name } of aged.slice(0, aged.length - keep)) await rm(path.join(dir, name), { force: true });
}
