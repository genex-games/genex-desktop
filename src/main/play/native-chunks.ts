/**
 * A chunked native build (`genex-chunks` version 1): a manifest that lists the game's files, links
 * and empty folders, and the chunks that tile the stream of its regular files' bytes in manifest
 * order. The catalog's row pins the manifest by sha256 and the manifest pins every chunk, so both
 * are hostile input until they match: a manifest is refused whole unless every rule of the contract
 * holds (plain paths, sorted, no duplicate or parent clash in any case, links that stay inside lexically, sizes
 * that add up), and a stored chunk is decoded only by a codec this app knows, never past its stated
 * size, and kept only when its sha256 is the one the manifest names.
 * Electron-free and file-free: the fetch is a dep, and nothing here writes.
 */
import { webcrypto } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import {
  type ChunkedBuild,
  InstallFailure,
  NATIVE_INSTALL_MAX_BYTES,
  NativePlatform,
} from "../../shared/play-native.ts";
import { checkedBuildUrl, type DownloadDeps, downloadBytes, InstallError } from "./native-download.ts";

/** The most one chunk holds, and the most a stored chunk is: its codec byte and its bytes as they are. */
export const CHUNK_MAX_BYTES = 16 * 1024 ** 2;
/** The largest manifest read, and the most files and chunks one may list. */
export const MANIFEST_MAX_BYTES = 64 * 1024 ** 2;
export const MANIFEST_FILES_MAX = 200_000;
export const MANIFEST_CHUNKS_MAX = 100_000;
/** The longest path and link target a manifest may name. */
const PATH_MAX_CHARS = 1024;
const LINK_MAX_CHARS = 1024;
/** What a manifest this app reads says it is. */
const MANIFEST_FORMAT = "genex-chunks";
const MANIFEST_VERSION = 1;
/** The keys a manifest and each kind of entry may carry: anything else is a later format. */
const MANIFEST_KEYS: ReadonlySet<string> = new Set(["format", "version", "files", "chunks"]);
const FILE_KEYS: ReadonlySet<string> = new Set(["path", "size", "exec"]);
const LINK_KEYS: ReadonlySet<string> = new Set(["path", "link"]);
const DIR_KEYS: ReadonlySet<string> = new Set(["path", "dir"]);
const CHUNK_KEYS: ReadonlySet<string> = new Set(["hash", "size"]);

/** How a stored chunk's payload is packed: its first byte. Wire values: never renumber one. */
export const ChunkCodec = {
  /** The payload is the chunk's bytes. */
  Raw: 0,
  /** The payload inflates (raw deflate, no header) to the chunk's bytes. */
  Deflate: 1,
} as const;
export type ChunkCodec = (typeof ChunkCodec)[keyof typeof ChunkCodec];

/** What a manifest entry is. */
export const ManifestEntryKind = { File: "file", Link: "link", Dir: "dir" } as const;
export type ManifestEntryKind = (typeof ManifestEntryKind)[keyof typeof ManifestEntryKind];

/** A regular file: its bytes are part of the stream. */
export interface ManifestFile {
  kind: typeof ManifestEntryKind.File;
  path: string;
  size: number;
  /** It is a program: mode 0755, else 0644. */
  exec: boolean;
  /** Where its bytes start in the stream. */
  offset: number;
}

/** A link and where it points, as written. */
export interface ManifestLink {
  kind: typeof ManifestEntryKind.Link;
  path: string;
  link: string;
}

/** A folder with nothing in it; every other folder is implied by the paths under it. */
export interface ManifestDir {
  kind: typeof ManifestEntryKind.Dir;
  path: string;
}

export type ManifestEntry = ManifestFile | ManifestLink | ManifestDir;

/** One chunk of the stream: its raw bytes' sha256, how many they are and where they start. */
export interface ManifestChunk {
  hash: string;
  size: number;
  offset: number;
}

/** A manifest found sound. */
export interface ChunkManifest {
  /** Every entry, in the manifest's (sorted) order. */
  entries: ManifestEntry[];
  /** The regular files that hold bytes, in stream order. */
  stream: ManifestFile[];
  chunks: ManifestChunk[];
  /** The stream's length: every regular file's size together, and every chunk's. */
  streamBytes: number;
}

/** A run of one file's bytes that a span of the stream covers. */
export interface FileSlice {
  file: ManifestFile;
  /** Where the run starts in the file, and in the span. */
  fileOffset: number;
  spanOffset: number;
  length: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const UNSAFE_PATH_CHARACTER = /[\0-\x1f\x7f\\:*?"<>|]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const UNSAFE_LINK_CHARACTER = /[\0-\x1f\x7f\\]/;
const DRIVE = /^[A-Za-z]:/;

const inflate = promisify(inflateRaw);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refusedManifest = (detail: string) => new InstallError(InstallFailure.UnsafeArchive, `manifest: ${detail}`);

/** A count of bytes a manifest may state: a whole number from `min` up. */
const isByteCount = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

/** The lowercase hex sha256 of `bytes`, hashed off the main thread. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

/** Throw unless `value` carries only `keys`: an unknown key is a later format, never half understood. */
function assertOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, what: string): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown !== undefined) throw refusedManifest(`unknown key in ${what}`);
}

/** Whether `value` is a path a manifest may name: `/`-separated and plain, as a build's entry is, up to the cap. */
function isPlainPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > PATH_MAX_CHARS) return false;
  if (value.startsWith("/") || UNSAFE_PATH_CHARACTER.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Whether a link at `at` pointing to `link` is written relatively and stays inside the build's root, read as text. */
function linkStaysInside(at: string, link: unknown): link is string {
  if (typeof link !== "string" || link.length < 1 || link.length > LINK_MAX_CHARS) return false;
  if (link.startsWith("/") || DRIVE.test(link) || UNSAFE_LINK_CHARACTER.test(link)) return false;
  const landed = path.posix.normalize(path.posix.join(path.posix.dirname(at), link));
  // Only a `..` part leaves: a sibling named `..data` stays inside.
  return landed !== "" && landed !== "." && landed !== ".." && !landed.startsWith("../");
}

/** One entry as exactly one of the three kinds, a file's place in the stream not yet known. */
function entryOf(value: unknown): ManifestEntry {
  if (!isRecord(value) || !isPlainPath(value.path)) throw refusedManifest("an entry's path");
  const { path: at, size, exec, link, dir } = value;
  if (link !== undefined) {
    assertOnlyKeys(value, LINK_KEYS, "a link");
    if (!linkStaysInside(at, link)) throw refusedManifest(`link ${at}`);
    return { kind: ManifestEntryKind.Link, path: at, link };
  }
  if (dir !== undefined) {
    assertOnlyKeys(value, DIR_KEYS, "a folder");
    if (dir !== true) throw refusedManifest(`folder ${at}`);
    return { kind: ManifestEntryKind.Dir, path: at };
  }
  assertOnlyKeys(value, FILE_KEYS, "a file");
  const sized = isByteCount(size, 0) && (exec === undefined || typeof exec === "boolean");
  if (!sized) throw refusedManifest(`file ${at}`);
  return { kind: ManifestEntryKind.File, path: at, size, exec: exec === true, offset: 0 };
}

/**
 * Throw unless `entries` are sorted strictly ascending (as JavaScript compares strings), no two are
 * the same name in another case, and none sits under a file, a link or an empty folder, in any
 * case: on a Mac's or a Windows disk `Game/Lib` and `game/lib/x.so` are the same place.
 */
function assertPathsDistinct(entries: readonly ManifestEntry[]): void {
  const folded = new Set<string>();
  let before: string | null = null;
  for (const { path: at } of entries) {
    if (before !== null && !(before < at)) throw refusedManifest(`not sorted at ${at}`);
    const low = at.toLowerCase();
    if (folded.has(low)) throw refusedManifest(`twice in another case: ${at}`);
    folded.add(low);
    before = at;
  }
  for (const low of folded) {
    for (let slash = low.indexOf("/"); slash >= 0; slash = low.indexOf("/", slash + 1)) {
      if (folded.has(low.slice(0, slash))) throw refusedManifest(`${low} is inside another entry`);
    }
  }
}

/** The manifest's entries, each checked, the files placed in the stream. */
function entriesOf(value: unknown): { entries: ManifestEntry[]; streamBytes: number } {
  if (!Array.isArray(value) || value.length < 1) throw refusedManifest("no files");
  if (value.length > MANIFEST_FILES_MAX) throw new InstallError(InstallFailure.TooLarge, "manifest: too many files");
  const entries = value.map(entryOf);
  assertPathsDistinct(entries);
  let streamBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== ManifestEntryKind.File) continue;
    entry.offset = streamBytes;
    streamBytes += entry.size;
  }
  return { entries, streamBytes };
}

/** The manifest's chunks, each checked and placed in the stream. */
function chunksOf(value: unknown): { chunks: ManifestChunk[]; chunkBytes: number } {
  if (!Array.isArray(value) || value.length < 1) throw refusedManifest("no chunks");
  if (value.length > MANIFEST_CHUNKS_MAX) throw new InstallError(InstallFailure.TooLarge, "manifest: too many chunks");
  const chunks: ManifestChunk[] = [];
  let chunkBytes = 0;
  for (const chunk of value) {
    if (!isRecord(chunk)) throw refusedManifest("a chunk");
    assertOnlyKeys(chunk, CHUNK_KEYS, "a chunk");
    const { hash, size } = chunk;
    const named = typeof hash === "string" && SHA256.test(hash);
    if (!named || !isByteCount(size, 1) || size > CHUNK_MAX_BYTES) throw refusedManifest("a chunk's hash or size");
    chunks.push({ hash, size, offset: chunkBytes });
    chunkBytes += size;
  }
  return { chunks, chunkBytes };
}

/** A manifest's JSON, or a throw: its bytes are UTF-8 with no byte-order mark. */
function manifestJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw refusedManifest("not JSON");
  }
}

/**
 * The manifest in `bytes`, found sound by every rule of the contract, or a throw: `needs-update`
 * for a later version of the format (this app is too old to read it), `too-large` for one past a
 * cap, `unsafe-archive` for anything else.
 */
export function parseManifest(bytes: Uint8Array): ChunkManifest {
  if (bytes.byteLength > MANIFEST_MAX_BYTES) throw new InstallError(InstallFailure.TooLarge, "manifest");
  const value = manifestJson(bytes);
  if (!isRecord(value) || value.format !== MANIFEST_FORMAT) throw refusedManifest("not a genex-chunks manifest");
  const { version } = value;
  if (isByteCount(version, MANIFEST_VERSION + 1))
    throw new InstallError(InstallFailure.NeedsUpdate, "manifest version");
  if (version !== MANIFEST_VERSION) throw refusedManifest("version");
  assertOnlyKeys(value, MANIFEST_KEYS, "the manifest");
  const { entries, streamBytes } = entriesOf(value.files);
  const { chunks, chunkBytes } = chunksOf(value.chunks);
  if (streamBytes > NATIVE_INSTALL_MAX_BYTES) throw new InstallError(InstallFailure.TooLarge, "manifest: the game");
  if (streamBytes < 1 || streamBytes !== chunkBytes) throw refusedManifest("its files and chunks differ in size");
  const stream = entries.filter(
    (entry): entry is ManifestFile => entry.kind === ManifestEntryKind.File && entry.size > 0,
  );
  return { entries, stream, chunks, streamBytes };
}

/** Whether the manifest holds what `build` launches: something inside a Mac's app bundle, else a regular file at the entry. */
function holdsEntry(manifest: ChunkManifest, build: ChunkedBuild): boolean {
  if (build.platform === NativePlatform.Mac) {
    return manifest.entries.some((entry) => entry.path.startsWith(`${build.entry}/`));
  }
  return manifest.entries.some((entry) => entry.kind === ManifestEntryKind.File && entry.path === build.entry);
}

/** Throw unless `manifest` is the game `build`'s row describes: exactly its unpacked size, and holding its entry. */
export function assertManifestOf(manifest: ChunkManifest, build: ChunkedBuild): void {
  if (manifest.streamBytes > build.installedBytes) throw new InstallError(InstallFailure.TooLarge, "manifest");
  if (manifest.streamBytes !== build.installedBytes) throw refusedManifest("smaller than the catalog states");
  if (!holdsEntry(manifest, build)) throw new InstallError(InstallFailure.EntryMissing, build.entry);
}

/** Where `name` is in a chunked build's folder, as an address a download may follow. */
const storedUrl = (deps: DownloadDeps, build: ChunkedBuild, name: string): URL =>
  checkedBuildUrl(`${build.chunksUrl}${name}`, deps.hosts);

/**
 * `build`'s manifest, downloaded from its chunk folder and found to be the one the catalog names
 * (its sha256), sound, and this build's: with its exact bytes, for the next update to read.
 */
export async function fetchManifest(
  deps: DownloadDeps,
  build: ChunkedBuild,
  signal: AbortSignal,
): Promise<{ manifest: ChunkManifest; bytes: Buffer }> {
  const url = storedUrl(deps, build, `${build.sha256}.manifest.json`);
  const bytes = await downloadBytes(deps, url, MANIFEST_MAX_BYTES, signal);
  if ((await sha256Hex(bytes)) !== build.sha256) throw new InstallError(InstallFailure.Checksum, "manifest");
  const manifest = parseManifest(bytes);
  assertManifestOf(manifest, build);
  return { manifest, bytes };
}

/** A stored chunk's payload unpacked by its codec, never to more than `size` bytes. */
async function unpacked(stored: Uint8Array, size: number): Promise<Uint8Array> {
  const payload = stored.subarray(1);
  if (stored[0] === ChunkCodec.Raw) return payload;
  if (stored[0] !== ChunkCodec.Deflate) throw new InstallError(InstallFailure.NeedsUpdate, "unknown chunk codec");
  try {
    return await inflate(payload, { maxOutputLength: size });
  } catch (error) {
    // Node refuses output past `maxOutputLength` with this code: a chunk that inflates past its size.
    const tooLong = error instanceof RangeError || (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
    throw new InstallError(tooLong ? InstallFailure.TooLarge : InstallFailure.Checksum, "chunk does not inflate");
  }
}

/**
 * The raw bytes of `chunk` from its stored object (a codec byte, then the payload): exactly `size`
 * of them with the sha256 the manifest names, or a throw. `needs-update` for a codec this app does
 * not know, `too-large` for one that inflates past its size, `checksum` for any other mismatch.
 */
export async function decodeChunk(stored: Uint8Array, chunk: Pick<ManifestChunk, "hash" | "size">): Promise<Buffer> {
  if (stored.byteLength < 1) throw new InstallError(InstallFailure.Checksum, "empty chunk");
  const bytes = await unpacked(stored, chunk.size);
  if (bytes.byteLength !== chunk.size) throw new InstallError(InstallFailure.Checksum, "chunk of another size");
  if ((await sha256Hex(bytes)) !== chunk.hash) throw new InstallError(InstallFailure.Checksum, "chunk");
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `chunk` of `build`, downloaded from its chunk folder (never more than its size and a codec byte) and decoded. */
export async function fetchChunk(
  deps: DownloadDeps,
  build: ChunkedBuild,
  chunk: ManifestChunk,
  signal: AbortSignal,
): Promise<Buffer> {
  const stored = await downloadBytes(deps, storedUrl(deps, build, `${chunk.hash}.bin`), chunk.size + 1, signal);
  return decodeChunk(stored, chunk);
}

/** The index in `stream` of the file that holds the stream's byte `offset`. */
function fileAt(stream: readonly ManifestFile[], offset: number): number {
  let low = 0;
  let high = stream.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((stream[middle]?.offset ?? Number.POSITIVE_INFINITY) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The runs of files' bytes that `span` of the stream covers, in order: a chunk may cross file boundaries. */
export function slicesOf(manifest: ChunkManifest, span: Pick<ManifestChunk, "offset" | "size">): FileSlice[] {
  const slices: FileSlice[] = [];
  const end = span.offset + span.size;
  let at = span.offset;
  for (let index = fileAt(manifest.stream, at); at < end; index++) {
    const file = manifest.stream[index];
    if (!file) throw refusedManifest("a chunk past the stream");
    const fileOffset = at - file.offset;
    const length = Math.min(file.size - fileOffset, end - at);
    slices.push({ file, fileOffset, spanOffset: at - span.offset, length });
    at += length;
  }
  return slices;
}
