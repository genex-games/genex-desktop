/**
 * A chunked build put together on disk, in a work folder that outlives a failed try
 * (`<downloads>/<slug>-<sha16>.chunked/`): the game's files laid out at their sizes under `game/`,
 * each chunk's bytes written to the runs of files it covers, and a record of the chunks finished
 * (`done.log`) so a later try does only the rest. A chunk the installed version already holds is
 * rebuilt from its files and downloaded only when that fails; either way its sha256 is checked
 * before a byte is written. The record is a hint, never trusted: every chunk it names is read back
 * and checked when a try starts, since a power loss can leave it ahead of the disk.
 * Nothing is written outside the work folder: every path comes from a manifest found sound
 * (`native-chunks.ts`), files exist before any link does, and links are made last.
 */
import { constants as FS } from "node:fs";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { type ChunkedBuild, InstallFailure, InstallPhase } from "../../shared/play-native.ts";
import { atomicWriteText, openNoFollow } from "../../substrate/fsx.ts";
import {
  type ChunkManifest,
  fetchChunk,
  type ManifestChunk,
  ManifestEntryKind,
  type ManifestFile,
  sha256Hex,
  slicesOf,
} from "./native-chunks.ts";
import { DOWNLOAD_CONNECTIONS, type DownloadDeps, InstallError } from "./native-download.ts";

/** The game's folder inside a work folder, and the record of its finished chunks beside it. */
const GAME = "game";
const DONE = "done.log";
/** The record's first line, before the manifest's sha256: another format is not read. */
const DONE_HEADER = "genex-chunks-done 1";
/** The longest record read: one short line a chunk, and a few tries' worth of them. */
const DONE_MAX_BYTES = 4 * 1024 ** 2;
const CHUNK_INDEX = /^\d{1,6}$/;
/** How many times one chunk is asked for, and the wait before the second try (the third waits twice that). */
const CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_MS = SECOND_MS;
/** How many files are laid out at once. */
const LAYOUT_AT_ONCE = 16;
/** The modes a game's files get: a program, any other file, a folder. */
const PROGRAM_MODE = 0o755;
const FILE_MODE = 0o644;
const FOLDER_MODE = 0o755;
/** The unit `Stats.blocks` counts in. */
const BLOCK_BYTES = 512;
/** What the file system answers when two of a manifest's names clash on this disk (one name in two cases). */
const NAME_CLASH: ReadonlySet<string> = new Set(["EEXIST", "EISDIR", "ENOTDIR", "ELOOP"]);
/** The failures worth asking a chunk for again: a lost connection, an answer damaged on the way. */
const RETRIED: ReadonlySet<InstallFailure> = new Set([InstallFailure.Network, InstallFailure.Checksum]);

/** What assembling needs beyond a download: how the wait between two tries of a chunk passes. */
export interface ChunkDeps extends DownloadDeps {
  /** Waits `ms` (a timer unless a test says otherwise). */
  sleep?(ms: number): Promise<unknown>;
}

/** The version installed now, when its manifest was kept: where its files are and what they were. */
export interface InstalledSource {
  dir: string;
  manifest: ChunkManifest;
}

/** One chunked build being assembled. */
export interface ChunkWork {
  deps: ChunkDeps;
  build: ChunkedBuild;
  manifest: ChunkManifest;
  /** The work folder ({@link chunkWorkOf}). */
  dir: string;
  installed: InstalledSource | null;
  signal: AbortSignal;
  /** Where it stands: the phase, and the bytes of the game its finished chunks hold. */
  report(phase: InstallPhase, doneBytes: number): void;
}

/** Where `build` of `slug` is assembled, under the installer's downloads folder. */
export const chunkWorkOf = (downloads: string, slug: string, build: ChunkedBuild): string =>
  path.join(downloads, `${slug}-${build.sha256.slice(0, 16)}.chunked`);

/** The game's folder inside the work folder `dir`. */
export const chunkGameOf = (dir: string): string => path.join(dir, GAME);

/** Throw away a work folder and everything assembled in it. */
export const discardChunkWork = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/**
 * The bytes of the game the work folder `dir` already takes on disk: each file's blocks, never more
 * than its size. A file only laid out takes none where the disk keeps holes, and its whole size
 * where it does not, so what is left of the game's size is what the disk must still give.
 */
export async function chunkWorkBytes(dir: string): Promise<number> {
  let bytes = 0;
  const pending = [chunkGameOf(dir)];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const at = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(at);
      if (!entry.isFile()) continue;
      const found = await lstat(at).catch(() => null);
      if (found?.isFile()) bytes += Math.min(found.size, (found.blocks || 0) * BLOCK_BYTES);
    }
  }
  return bytes;
}

const stopped = (): InstallError => new InstallError(InstallFailure.Failed, "stopped");

/** Where a manifest's path is under `root` on this computer. */
const diskPath = (root: string, at: string): string => path.join(root, ...at.split("/"));

/** Run `run` over `items`, `limit` at a time, until all are done or one throws: the first throw, once the rest stop. */
async function pooled<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  // One iterator for every worker: each takes the next item nobody has.
  const queue = items.values();
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (const item of queue) {
      if (failed) return;
      try {
        await run(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

/** What `step` answers, or `unsafe-archive` when two of the manifest's names clash on this disk. */
async function layoutStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!NAME_CLASH.has(code)) throw error;
    throw new InstallError(InstallFailure.UnsafeArchive, `names clash: ${code}`);
  }
}

/** The chunk indexes the record in `dir` names for the manifest `sha256`, or null when it is no record of it. */
async function readDone(dir: string, sha256: string, count: number): Promise<number[] | null> {
  const file = path.join(dir, DONE);
  const found = await lstat(file).catch(() => null);
  if (!found?.isFile() || found.size > DONE_MAX_BYTES) return null;
  const lines = (await readFile(file, "utf8").catch(() => "")).split("\n");
  if (lines[0] !== `${DONE_HEADER} ${sha256}`) return null;
  const done = new Set<number>();
  // A line cut short by a quit names no chunk, or one checked again like the rest.
  for (const line of lines.slice(1)) {
    if (CHUNK_INDEX.test(line) && Number(line) < count) done.add(Number(line));
  }
  return [...done];
}

/** Write the record in `dir` anew: the manifest it is about and the chunks finished, whole or not at all. */
const writeDone = (dir: string, sha256: string, done: readonly number[]): Promise<void> =>
  atomicWriteText(path.join(dir, DONE), [`${DONE_HEADER} ${sha256}`, ...done, ""].join("\n"));

/** One of the game's files at its size: made when missing, cut or grown when another size, never through a link. */
async function layFile(game: string, file: ManifestFile): Promise<void> {
  const target = diskPath(game, file.path);
  const found = await lstat(target).catch(() => null);
  if (found?.isFile() && found.size === file.size) return;
  const handle = await openNoFollow(target, FS.O_WRONLY | FS.O_CREAT, file.exec ? PROGRAM_MODE : FILE_MODE);
  try {
    await handle.truncate(file.size);
  } finally {
    await handle.close();
  }
}

/**
 * Make the folder a manifest names as `at` under `game`, part by part: each must be a folder of its
 * own, so a link or a file standing where a folder should be is refused before anything is made or
 * written through it. `made` holds the folders already found sound.
 */
async function makeFolder(game: string, at: string, made: Set<string>): Promise<void> {
  let dir = game;
  let below = "";
  for (const part of at.split("/")) {
    dir = path.join(dir, part);
    below = `${below}/${part}`;
    if (made.has(below)) continue;
    await mkdir(dir, { mode: FOLDER_MODE }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(dir)).isDirectory()) throw new InstallError(InstallFailure.UnsafeArchive, "not a folder");
    made.add(below);
  }
}

/** The folder a manifest's path sits in, or null for one at the game's root. */
const folderOf = (at: string): string | null => (at.includes("/") ? path.posix.dirname(at) : null);

/**
 * Lay the game out under `game`: every link an earlier try made removed first (so no write can go
 * through one), then every folder a file sits in, then every file at its size.
 */
async function layOut(game: string, manifest: ChunkManifest): Promise<void> {
  const files: ManifestFile[] = [];
  const made = new Set<string>();
  await mkdir(game, { recursive: true, mode: FOLDER_MODE });
  for (const own of [path.dirname(game), game]) {
    if (!(await lstat(own)).isDirectory()) throw new InstallError(InstallFailure.UnsafeArchive, "not a folder");
  }
  for (const entry of manifest.entries) {
    const target = diskPath(game, entry.path);
    if (entry.kind === ManifestEntryKind.Link) {
      if ((await lstat(target).catch(() => null))?.isSymbolicLink()) await rm(target, { force: true });
    } else if (entry.kind === ManifestEntryKind.File) {
      files.push(entry);
    }
  }
  for (const file of files) {
    const folder = folderOf(file.path);
    if (folder) await makeFolder(game, folder, made);
  }
  await pooled(files, LAYOUT_AT_ONCE, (file) => layFile(game, file));
}

/** Read `length` bytes of the open `handle` from `position` into `into` at `offset`; false when the file ends first. */
async function readFully(
  handle: Awaited<ReturnType<typeof openNoFollow>>,
  into: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<boolean> {
  for (let read = 0; read < length; ) {
    const { bytesRead } = await handle.read(into, offset + read, length - read, position + read);
    if (bytesRead === 0) return false;
    read += bytesRead;
  }
  return true;
}

/**
 * The bytes of `span` of `manifest`'s stream, read from the files under `root`, or null: a file
 * missing, a link in its place, a size other than the manifest's, or any read that fails.
 */
async function readSpan(
  root: string,
  manifest: ChunkManifest,
  span: Pick<ManifestChunk, "offset" | "size">,
): Promise<Buffer | null> {
  const bytes = Buffer.allocUnsafe(span.size);
  try {
    for (const slice of slicesOf(manifest, span)) {
      const handle = await openNoFollow(diskPath(root, slice.file.path), FS.O_RDONLY);
      try {
        const found = await handle.stat();
        if (!found.isFile() || found.size !== slice.file.size) return null;
        if (!(await readFully(handle, bytes, slice.spanOffset, slice.length, slice.fileOffset))) return null;
      } finally {
        await handle.close();
      }
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Write a chunk's `bytes` to the runs of the game's files it covers. */
async function writeChunk(game: string, manifest: ChunkManifest, chunk: ManifestChunk, bytes: Buffer): Promise<void> {
  for (const slice of slicesOf(manifest, chunk)) {
    const handle = await openNoFollow(diskPath(game, slice.file.path), FS.O_WRONLY);
    try {
      for (let written = 0; written < slice.length; ) {
        const from = slice.spanOffset + written;
        const result = await handle.write(bytes, from, slice.length - written, slice.fileOffset + written);
        written += result.bytesWritten;
      }
    } finally {
      await handle.close();
    }
  }
}

/** Whether the files under `root` hold `chunk`: its bytes read back by `manifest` and its sha256 the same. */
async function holdsChunk(root: string, manifest: ChunkManifest, chunk: ManifestChunk): Promise<boolean> {
  const bytes = await readSpan(root, manifest, chunk);
  return bytes !== null && (await sha256Hex(bytes)) === chunk.hash;
}

/**
 * The chunks of `recorded` the work folder really holds, each read back and checked: what a record
 * ahead of the disk named too early is left out, and done again.
 */
async function verifiedChunks(work: ChunkWork, recorded: readonly number[]): Promise<Set<number>> {
  const { manifest, signal, report } = work;
  const game = chunkGameOf(work.dir);
  const held = new Set<number>();
  let doneBytes = 0;
  if (recorded.length > 0) report(InstallPhase.Verifying, 0);
  await pooled(recorded, DOWNLOAD_CONNECTIONS, async (index) => {
    signal.throwIfAborted();
    const chunk = manifest.chunks[index];
    if (!chunk || !(await holdsChunk(game, manifest, chunk))) return;
    held.add(index);
    doneBytes += chunk.size;
    report(InstallPhase.Verifying, doneBytes);
  });
  return held;
}

/** The installed version's chunks by hash (the first of each): what a new chunk may be rebuilt from. */
function chunksByHash(installed: InstalledSource | null): Map<string, ManifestChunk> {
  const known = new Map<string, ManifestChunk>();
  for (const chunk of installed?.manifest.chunks ?? []) {
    if (!known.has(chunk.hash)) known.set(chunk.hash, chunk);
  }
  return known;
}

/**
 * `chunk`'s bytes rebuilt from the installed version's files, or null: it has no such chunk, a file
 * of it changed size, or what was read is not the chunk (a file changed since it was installed, as a
 * Mac app's programs and Info.plist are when Genex signs it again).
 */
async function reusedChunk(
  installed: InstalledSource | null,
  known: ReadonlyMap<string, ManifestChunk>,
  chunk: ManifestChunk,
): Promise<Buffer | null> {
  const old = known.get(chunk.hash);
  if (!installed || !old || old.size !== chunk.size) return null;
  const bytes = await readSpan(installed.dir, installed.manifest, old);
  return bytes !== null && (await sha256Hex(bytes)) === chunk.hash ? bytes : null;
}

/** `chunk` downloaded and decoded, asked for again after a wait when the connection or the answer failed. */
async function downloadedChunk(work: ChunkWork, chunk: ManifestChunk, signal: AbortSignal): Promise<Buffer> {
  const wait = work.deps.sleep ?? ((ms: number) => sleep(ms, undefined, { signal }));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchChunk(work.deps, work.build, chunk, signal);
    } catch (error) {
      const again = error instanceof InstallError && RETRIED.has(error.failure) && attempt < CHUNK_ATTEMPTS;
      if (!again || signal.aborted) throw error;
      await wait(CHUNK_RETRY_MS * attempt);
    }
  }
}

/**
 * Finish every chunk not in `held`, {@link DOWNLOAD_CONNECTIONS} at once: rebuilt from the installed
 * version or downloaded, written, and only then recorded. The first failure stops the rest and is
 * thrown; the chunks finished stay recorded for the next try.
 */
async function finishChunks(work: ChunkWork, held: ReadonlySet<number>): Promise<void> {
  const { manifest, report } = work;
  const game = chunkGameOf(work.dir);
  const known = chunksByHash(work.installed);
  const group = new AbortController();
  const signal = AbortSignal.any([work.signal, group.signal]);
  let doneBytes = [...held].reduce((sum, index) => sum + (manifest.chunks[index]?.size ?? 0), 0);
  report(InstallPhase.Downloading, doneBytes);
  const lacking = manifest.chunks.map((_, index) => index).filter((index) => !held.has(index));
  const finish = async (index: number): Promise<void> => {
    const chunk = manifest.chunks[index];
    if (!chunk) return;
    signal.throwIfAborted();
    const bytes = (await reusedChunk(work.installed, known, chunk)) ?? (await downloadedChunk(work, chunk, signal));
    signal.throwIfAborted();
    await writeChunk(game, manifest, chunk, bytes);
    await appendFile(path.join(work.dir, DONE), `${index}\n`);
    doneBytes += chunk.size;
    report(InstallPhase.Downloading, doneBytes);
  };
  try {
    await pooled(lacking, DOWNLOAD_CONNECTIONS, (index) =>
      finish(index).catch((error: unknown) => {
        group.abort();
        throw error;
      }),
    );
  } catch (error) {
    throw work.signal.aborted ? stopped() : error;
  }
}

/** Every path `manifest` lists and every folder those sit in, spelled one way (a disk may spell an accent another). */
function listedPaths(manifest: ChunkManifest): Set<string> {
  const listed = new Set<string>();
  for (const { path: at } of manifest.entries) {
    listed.add(at.normalize());
    for (let slash = at.indexOf("/"); slash >= 0; slash = at.indexOf("/", slash + 1)) {
      listed.add(at.slice(0, slash).normalize());
    }
  }
  return listed;
}

/**
 * Remove from `game` whatever `manifest` does not list, so what is installed is the manifest's
 * files and nothing an earlier try or anything else left in the work folder.
 */
async function removeUnlisted(game: string, manifest: ChunkManifest): Promise<void> {
  const listed = listedPaths(manifest);
  const pending = [""];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of await readdir(path.join(game, folder), { withFileTypes: true })) {
      const at = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (!listed.has(at.normalize())) await rm(path.join(game, at), { recursive: true, force: true });
      else if (entry.isDirectory()) pending.push(at);
    }
  }
}

/** What the files alone do not carry, set once every chunk is in: empty folders, programs' modes, and links last. */
async function finishTree(game: string, manifest: ChunkManifest): Promise<void> {
  const made = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.kind === ManifestEntryKind.Dir) await makeFolder(game, entry.path, made);
    else if (entry.kind === ManifestEntryKind.File && entry.exec) await chmod(diskPath(game, entry.path), PROGRAM_MODE);
  }
  for (const entry of manifest.entries) {
    if (entry.kind !== ManifestEntryKind.Link) continue;
    const folder = folderOf(entry.path);
    if (folder) await makeFolder(game, folder, made);
    await symlink(entry.link, diskPath(game, entry.path));
  }
}

/**
 * Assemble `work.build` in its work folder and answer the game's folder there, whole: what an
 * earlier try finished is checked and kept, the rest rebuilt from the installed version or
 * downloaded, anything the manifest does not list removed, then folders, modes and links set. A record that is not this manifest's starts the
 * folder afresh. A stop or a failure throws {@link InstallError} and leaves the folder for the next
 * try ({@link discardChunkWork} throws it away).
 */
export async function assembleChunks(work: ChunkWork): Promise<string> {
  const { dir, build, manifest, signal } = work;
  const game = chunkGameOf(dir);
  if (signal.aborted) throw stopped();
  const recorded = await readDone(dir, build.sha256, manifest.chunks.length);
  if (!recorded) await discardChunkWork(dir);
  await layoutStep(() => layOut(game, manifest));
  const held = await verifiedChunks(work, recorded ?? []).catch((error: unknown) => {
    throw signal.aborted ? stopped() : error;
  });
  await writeDone(dir, build.sha256, [...held]);
  await finishChunks(work, held);
  if (signal.aborted) throw stopped();
  work.report(InstallPhase.Verifying, manifest.streamBytes);
  await removeUnlisted(game, manifest);
  work.report(InstallPhase.Unpacking, manifest.streamBytes);
  await layoutStep(() => finishTree(game, manifest));
  return game;
}
