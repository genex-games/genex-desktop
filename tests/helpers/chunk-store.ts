/**
 * Chunked native builds made by hand, for the native installer's tests: a game's files cut into
 * chunks of a fixed size (a real publish cuts by content; the installer only reads the manifest),
 * its manifest and stored chunks as a chunk folder holds them, and a fetch that serves such folders
 * and keeps what it was asked. A manifest can also be sealed from any value, including the hostile
 * ones a real publish would never write.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

/** One entry of a game: a file (its bytes, a string as UTF-8), a link, or an empty folder. */
export interface ChunkItem {
  path: string;
  data?: string | Uint8Array;
  /** The file is a program. */
  exec?: boolean;
  /** A link's target: the entry is a link. */
  link?: string;
  /** The entry is an empty folder. */
  dir?: true;
}

/** One chunk as a manifest names it. */
export interface WireChunk {
  hash: string;
  size: number;
}

/** A manifest as the wire spells it. */
export interface WireManifest {
  format: string;
  version: number;
  files: Array<Record<string, unknown>>;
  chunks: WireChunk[];
}

/** A chunked game as its chunk folder holds it. */
export interface ChunkedGame {
  manifest: WireManifest;
  /** The manifest's exact bytes and their sha256: what a build row names. */
  manifestBytes: Buffer;
  sha256: string;
  /** Every regular file's size together. */
  installedBytes: number;
  /** The stored manifest and distinct chunks together: a fresh install's download. */
  sizeBytes: number;
  /** Every stored object by its name in the folder (`<hash>.bin`, `<sha256>.manifest.json`). */
  objects: Map<string, Buffer>;
}

const RAW = 0;
const DEFLATE = 1;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const bytesOf = (data: string | Uint8Array | undefined): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data ?? new Uint8Array());

/** `raw` as a chunk folder stores it: deflated when that is smaller (or when told to), else as it is. */
export function storedChunk(raw: Uint8Array, codec?: "raw" | "deflate"): Buffer {
  const deflated = deflateRawSync(raw);
  const deflate = codec ? codec === "deflate" : deflated.length < raw.length;
  return Buffer.concat([Buffer.from([deflate ? DEFLATE : RAW]), deflate ? deflated : raw]);
}

/** A manifest's bytes and the sha256 that names them, for any value: a sound manifest or a hostile one. */
export function sealManifest(manifest: unknown): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return { bytes, sha256: sha256(bytes) };
}

const EXECUTE_BITS = 0o111;

/**
 * Everything under the folder `root` as a game's entries, as a publish reads a build: each file
 * with its bytes and whether it is a program, each link with its target, each empty folder.
 */
export async function itemsOf(root: string, under = ""): Promise<ChunkItem[]> {
  const items: ChunkItem[] = [];
  const names = await readdir(path.join(root, under));
  if (names.length === 0 && under !== "") return [{ path: under, dir: true }];
  for (const name of names) {
    const at = under === "" ? name : `${under}/${name}`;
    const file = path.join(root, at);
    const found = await lstat(file);
    if (found.isDirectory()) items.push(...(await itemsOf(root, at)));
    else if (found.isSymbolicLink()) items.push({ path: at, link: await readlink(file) });
    else items.push({ path: at, data: await readFile(file), exec: (found.mode & EXECUTE_BITS) !== 0 });
  }
  return items;
}

/** A manifest entry for `item`, as the contract spells each kind. */
function wireEntry(item: ChunkItem): Record<string, unknown> {
  if (item.link !== undefined) return { path: item.path, link: item.link };
  if (item.dir) return { path: item.path, dir: true };
  return { path: item.path, size: bytesOf(item.data).length, ...(item.exec ? { exec: true } : {}) };
}

/** `items` as a chunked game: sorted as a manifest must be, the stream of its files cut every `chunkBytes`. */
export function chunkedGame(items: readonly ChunkItem[], chunkBytes = 64): ChunkedGame {
  // The comparison a manifest's order is checked by: JavaScript's own, by UTF-16 code unit.
  const sorted = [...items].sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
  const regular = sorted.filter((item) => item.link === undefined && !item.dir);
  const stream = Buffer.concat(regular.map((item) => bytesOf(item.data)));
  const objects = new Map<string, Buffer>();
  const chunks: WireChunk[] = [];
  for (let at = 0; at < stream.length; at += chunkBytes) {
    const raw = stream.subarray(at, at + chunkBytes);
    const hash = sha256(raw);
    chunks.push({ hash, size: raw.length });
    objects.set(`${hash}.bin`, storedChunk(raw));
  }
  const manifest: WireManifest = { format: "genex-chunks", version: 1, files: sorted.map(wireEntry), chunks };
  const sealed = sealManifest(manifest);
  let sizeBytes = sealed.bytes.length;
  for (const stored of objects.values()) sizeBytes += stored.length;
  objects.set(`${sealed.sha256}.manifest.json`, sealed.bytes);
  return {
    manifest,
    manifestBytes: sealed.bytes,
    sha256: sealed.sha256,
    installedBytes: stream.length,
    sizeBytes,
    objects,
  };
}

/** What a chunk folder's fetch may answer in a stored object's place; nothing answers the object itself. */
export type ChunkAnswer = (
  name: string,
  signal: AbortSignal | null | undefined,
) => Response | undefined | Promise<Response | undefined>;

/**
 * A fetch serving chunk folders by address (`folders`: each folder's address, ending in `/`, and
 * its objects), a 404 for anything else. `asked` keeps every address it was asked, in order;
 * `answer` may answer in an object's place (a failure, a held response).
 */
export function chunkFetch(folders: ReadonlyMap<string, ReadonlyMap<string, Buffer>>, answer?: ChunkAnswer) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    // As a real fetch does, a stopped request goes no further.
    init?.signal?.throwIfAborted();
    const folder = [...folders.keys()].find((address) => url.startsWith(address));
    const name = folder === undefined ? "" : url.slice(folder.length);
    const instead = await answer?.(name, init?.signal);
    if (instead) return instead;
    const stored = folder === undefined ? undefined : folders.get(folder)?.get(name);
    if (!stored) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(stored), { headers: { "content-length": String(stored.length) } });
  }) as typeof fetch;
  /** The names of the chunks asked for, in order, without their folder or `.bin`. */
  const askedChunks = (): string[] =>
    asked.filter((url) => url.endsWith(".bin")).map((url) => url.slice(url.lastIndexOf("/") + 1, -".bin".length));
  return { fetchImpl, asked, askedChunks };
}
