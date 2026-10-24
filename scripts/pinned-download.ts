/**
 * A build-time download pinned by SHA-256: the archive is fetched once into a cache, and bytes
 * whose digest differs from the pin are refused before anything unpacks them. Shared by the
 * vendoring scripts that bring a third-party binary into a package (`vendor-cua-driver.ts`,
 * `vendor-git-for-windows.ts`).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Where a pinned file is downloaded from, and its SHA-256. */
export interface PinnedFile {
  url: string;
  sha256: string;
}

/** Write what `url` answers to `file`. */
export type Download = (url: string, file: string) => Promise<void>;

const MESSAGE = {
  digest: (what: string, url: string, got: string, want: string) =>
    `${what} archive ${url} has SHA-256 ${got}, not the pinned ${want}: refusing it`,
  download: (url: string, status: number) => `downloading ${url} failed: HTTP ${status}`,
} as const;

/** Download with Node's own fetch, streamed to disk. */
export async function fetchTo(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(MESSAGE.download(url, response.status));
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(file));
}

/** A file's SHA-256, streamed (an archive can be hundreds of megabytes), or null when there is no file. */
async function digestOf(file: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch {
    return null;
  }
  return hash.digest("hex");
}

/**
 * The pinned file in `cacheDir` (named by its URL's last segment), downloaded when missing or not
 * the pinned bytes. `what` names it in the refusal.
 */
export async function verifiedArchive(
  what: string,
  pinned: PinnedFile,
  cacheDir: string,
  download: Download,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, path.basename(new URL(pinned.url).pathname));
  if ((await digestOf(archive)) === pinned.sha256) return archive;
  const partial = `${archive}.part`;
  await rm(partial, { force: true });
  await download(pinned.url, partial);
  const got = await digestOf(partial);
  if (got !== pinned.sha256) {
    await rm(partial, { force: true });
    throw new Error(MESSAGE.digest(what, pinned.url, got ?? "none", pinned.sha256));
  }
  await rename(partial, archive);
  return archive;
}
