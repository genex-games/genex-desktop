/**
 * The file moves an install and a removal are made of, none of them through a link: what a path
 * names (a folder of its own, nothing, or something else), a file copied under a temporary name
 * beside its target and renamed into place, and the digest of what a file holds now.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { chmod, lstat, rename, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openNoFollow } from "../../substrate/fsx.ts";

/** What a path names: a folder of its own, nothing, or anything else (a link, a file). */
export const FolderState = { Folder: "folder", Missing: "missing", Other: "other" } as const;
export type FolderState = (typeof FolderState)[keyof typeof FolderState];

/** What `dir` names, never following a link. */
export async function folderState(dir: string): Promise<FolderState> {
  const info = await lstat(dir).catch(() => null);
  if (!info) return FolderState.Missing;
  return info.isDirectory() && !info.isSymbolicLink() ? FolderState.Folder : FolderState.Other;
}

/** A file as it is on disk: the device and inode it lives at, so a swap since it was read shows. */
export interface FileId {
  dev: number;
  ino: number;
}

/** What a copy wrote: its size and the sha256 of its bytes. */
export interface Written {
  size: number;
  sha256: string;
}

/** A file being written takes this name first, then is renamed into place. */
const PART_SUFFIX = ".genex-part";

/** Why a copy refused its source: it is no regular file, or no longer the file that was checked. */
export class SourceChanged extends Error {}

/**
 * Copies one regular file to `target` through a temporary name beside it, and answers what it wrote.
 * The source is opened without following a link; with `expect`, it must still be that very file
 * (its device and inode), so a folder of the source swapped for a link since the check is refused.
 */
export async function copyInto(source: string, target: string, expect?: FileId): Promise<Written> {
  const input = await openNoFollow(source, FS.O_RDONLY);
  const info = await input.stat();
  const swapped = expect && (info.dev !== expect.dev || info.ino !== expect.ino);
  if (!info.isFile() || swapped) {
    await input.close();
    throw new SourceChanged(source);
  }
  const part = `${target}.${randomUUID().slice(0, 8)}${PART_SUFFIX}`;
  const output = await openNoFollow(part, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o644).catch(async (error) => {
    await input.close();
    throw error;
  });
  const hash = createHash("sha256");
  let size = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(input.createReadStream(), digest, output.createWriteStream());
    await chmod(part, info.mode & 0o777);
    await rename(part, target);
  } catch (error) {
    await unlink(part).catch(() => {});
    throw error;
  }
  return { size, sha256: hash.digest("hex") };
}

/** The sha256 of a regular file's bytes, read without following a link; null when it is no regular file. */
export async function digestOf(file: string): Promise<string | null> {
  const input = await openNoFollow(file, FS.O_RDONLY).catch(() => null);
  if (!input) return null;
  try {
    if (!(await input.stat()).isFile()) return null;
    const hash = createHash("sha256");
    for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await input.close();
  }
}
