/**
 * The host-level download cache: every profile's store installs its pinned archives through one
 * cache of verified downloads, named by their sha256, so a second profile (a developer profile
 * beside the normal one) never downloads an archive again. Only the archives are shared: each
 * profile still extracts, probes and prewarms into its own store, because prewarm outputs are
 * executables no receipt covers. The cache sits in every profile's base `denyWrite`
 * (`layout.ts`), so no sandboxed process writes it; the host verifies an entry's size and sha256
 * every time it is used, removes one that differs and downloads it again.
 *
 * ```
 * <cache>/
 *   sha256/<sha256>          one verified archive, read-only
 *   .incoming/<sha256>-<pid>-<uuid>
 *                            a download in progress; linked into `sha256/` only once verified
 * ```
 *
 * Two profiles installing at once may both download an archive; the first to finish links its
 * copy in, the other finds the entry there, verifies it and uses it, so one entry remains.
 */
import { randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { chmod, link, lstat, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { StudioPlatform } from "../../shared/boot.ts";
import { type ToolchainArchive, ToolchainError, ToolchainProblem } from "../../shared/toolchain.ts";
import { openNoFollow } from "../fsx.ts";

const MESSAGE = {
  Unpinned: (url: string) => `${url} has no recorded sha256: it is never cached.`,
  LinkedFolder: (folder: string) => `The download cache folder ${folder} is a link or not a folder; nothing is cached.`,
  Unverified: (url: string) => `The cached copy of ${url} does not match its pinned size and sha256.`,
} as const;

/** The cache's folder name under the host's cache directory. */
export const DOWNLOAD_CACHE_NAME = "toolchain-downloads";
/** The folder of verified archives, each named by its sha256. */
const ENTRIES_FOLDER = "sha256";
/** Downloads in progress, linked into {@link ENTRIES_FOLDER} once verified. */
const INCOMING_FOLDER = ".incoming";
/** A cached archive is read-only for everyone. */
const ENTRY_MODE = 0o444;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The host-level cache folder every profile shares, outside any profile's own data: macOS's
 * `~/Library/Caches/Genex`, Windows's `%LOCALAPPDATA%\Genex`, and Linux's `$XDG_CACHE_HOME/genex`
 * (`~/.cache/genex` when unset or relative).
 */
export function hostDownloadCache(
  platform: NodeJS.Platform | string = process.platform,
  home: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform === StudioPlatform.Mac) return path.join(home, "Library", "Caches", "Genex", DOWNLOAD_CACHE_NAME);
  if (platform === StudioPlatform.Windows) {
    const local = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : null;
    return path.win32.join(local ?? path.win32.join(home, "AppData", "Local"), "Genex", DOWNLOAD_CACHE_NAME);
  }
  const xdg = env.XDG_CACHE_HOME && path.posix.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : null;
  return path.posix.join(xdg ?? path.posix.join(home, ".cache"), "genex", DOWNLOAD_CACHE_NAME);
}

/** The entry `sha256` names in `cache`; throws for anything but a lowercase hex sha256. */
export function cacheEntryPath(cache: string, sha256: string | null): string {
  if (sha256 === null || !SHA256.test(sha256))
    throw new ToolchainError(ToolchainProblem.Unpinned, MESSAGE.Unpinned(String(sha256)));
  return path.join(cache, ENTRIES_FOLDER, sha256);
}

/** `folder` made when missing, refused when it is a link or not a folder. */
async function ownFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.LinkedFolder(folder));
}

/** The cache root, realpath'd, with its two folders present and neither a link. */
async function preparedCache(cache: string): Promise<string> {
  await ownFolder(cache);
  const root = await realpath(cache);
  await ownFolder(path.join(root, ENTRIES_FOLDER));
  await ownFolder(path.join(root, INCOMING_FOLDER));
  return root;
}

/** The size and sha256 of the regular file at `file`, read without following a link; null when it is not one. */
async function fileDigest(file: string): Promise<{ bytes: number; sha256: string } | null> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const data = chunk as Buffer;
      bytes += data.length;
      hash.update(data);
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/**
 * The cached copy of `archive` when it is there and still matches its pinned size and sha256;
 * anything else at its name (another file, a link, a folder) is removed and null answered, so the
 * caller downloads it again.
 */
export async function verifiedCacheEntry(cache: string, archive: ToolchainArchive): Promise<string | null> {
  const entry = cacheEntryPath(cache, archive.sha256);
  const info = await lstat(entry).catch(() => null);
  if (!info) return null;
  const digest = info.isFile() ? await fileDigest(entry) : null;
  if (digest && digest.bytes === archive.bytes && digest.sha256 === archive.sha256) return entry;
  await rm(entry, { recursive: true, force: true });
  return null;
}

/** Links a verified download into place; one another profile linked first is verified and kept instead. */
async function adopt(incoming: string, entry: string, archive: ToolchainArchive, root: string): Promise<void> {
  try {
    await link(incoming, entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await verifiedCacheEntry(root, archive)) return;
    await link(incoming, entry);
  }
}

/**
 * The verified cached copy of `archive`, downloading it first when the cache has none. `download`
 * writes a new file at the path it is given and checks it against the pin (the install's own
 * download, `install.ts`); the copy is linked into the cache only after that, made read-only, and
 * verified once more where it lies before its path is answered.
 */
export async function cachedDownload(
  cache: string,
  archive: ToolchainArchive,
  download: (file: string) => Promise<void>,
): Promise<{ file: string; hit: boolean }> {
  const root = await preparedCache(cache);
  const hit = await verifiedCacheEntry(root, archive);
  if (hit) return { file: hit, hit: true };
  const entry = cacheEntryPath(root, archive.sha256);
  const incoming = path.join(root, INCOMING_FOLDER, `${archive.sha256}-${process.pid}-${randomUUID()}`);
  try {
    await download(incoming);
    await chmod(incoming, ENTRY_MODE);
    await adopt(incoming, entry, archive, root);
  } finally {
    await rm(incoming, { force: true });
  }
  const verified = await verifiedCacheEntry(root, archive);
  if (!verified) throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.Unverified(archive.url));
  return { file: verified, hit: false };
}
