/**
 * CC0 assets fetched by sha256: renderer pass 2's showcase fetch rules (owner decision D6) as one
 * module, so `scripts/showcase-assets.ts` and a game-facing CC0 library share them.
 *
 * - A URL is https on an allowlisted CC0 host (Poly Haven's and ambientCG's download servers), with
 *   no credentials, port or redirect.
 * - An asset is CC0-1.0, and every asset id, file name and zip member name is a plain name.
 * - A download is checked against its manifest size, then its md5 where the source publishes one,
 *   then its sha256 pin (recorded only on an explicit pin), and only then written: beside its
 *   name, renamed into place.
 * - A zip lists the members it is fetched for, each pinned by size and sha256 like a file. The whole
 *   archive is read before anything is written: a member that is not a plain name, a link, a folder,
 *   a duplicate, an entry past the member-count or expanded-size cap, or one that inflates past its
 *   declared size refuses the zip with nothing written.
 *
 * A refusal is a {@link Cc0Error} with a typed {@link Cc0Refusal} code.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { Inflate } from "fflate";

/** The most entries a fetched zip may hold, folders and files alike. */
export const ZIP_MAX_ENTRIES = 256;
/** The most bytes a fetched zip's entries may declare when expanded, all together. */
export const ZIP_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
/** How much compressed data one inflate step reads, so a bomb is stopped within one step's output. */
const INFLATE_STEP_BYTES = 16 * 1024;

/** The hosts a manifest URL may name: Poly Haven's and ambientCG's official download servers. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["dl.polyhaven.org", "ambientcg.com"]);
/** The only licence a fetched asset may carry. */
export const CC0 = "CC0-1.0";
/** A plain file or folder name: no separators, no `.` or `..`, no leading dot. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_HEX = /^[0-9a-f]{32}$/;

/** Why a fetch refused. Wire values: the showcase script prints them and tests match them. */
export const Cc0Refusal = {
  ManifestInvalid: "manifest-invalid",
  HostNotAllowed: "host-not-allowed",
  NotCc0: "licence-not-cc0",
  UnsafeName: "unsafe-name",
  Unpinned: "unpinned",
  DownloadFailed: "download-failed",
  SizeMismatch: "size-mismatch",
  HashMismatch: "hash-mismatch",
  ZipInvalid: "zip-invalid",
  ZipUnsafeEntry: "zip-unsafe-entry",
  ZipTooManyEntries: "zip-too-many-entries",
  ZipTooLarge: "zip-too-large",
  ZipMemberMissing: "zip-member-missing",
} as const;
export type Cc0Refusal = (typeof Cc0Refusal)[keyof typeof Cc0Refusal];

/** A refusal with its typed code (a caller may widen the codes with its own, as the showcase script does). */
export class Cc0Error<Code extends string = Cc0Refusal> extends Error {
  readonly code: Code;
  constructor(code: Code, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** Bytes a manifest pins: a plain name, a size, a sha256 (null until a first fetch pins it), maybe an md5. */
export type PinnedBytes = { name: string; bytes: number; sha256: string | null; md5?: string };
/** One member of a fetched zip, written beside the zip under its own plain name. */
export type ZipMember = PinnedBytes & { map: string };
/** One file of an asset: a map of a texture set, the sky map, a model, or a zip with its members. */
export type ManifestFile = ZipMember & { url: string; members?: ZipMember[] };
/** One fetched asset. */
export type ManifestAsset = { id: string; kind: string; licence: string; files: ManifestFile[] };
/** A manifest (only the fields the fetch reads are typed). */
export type Manifest = { assets: ManifestAsset[] };

/** The caps a zip is read under; tests pass small ones. */
export type ZipLimits = { maxEntries: number; maxExpandedBytes: number };
/** The caps every fetch uses. */
export const ZIP_LIMITS: ZipLimits = { maxEntries: ZIP_MAX_ENTRIES, maxExpandedBytes: ZIP_MAX_EXPANDED_BYTES };

/** Fetches `url`, refusing a body longer than `maxBytes`. Tests pass a stub. */
export type Download = (url: URL, maxBytes: number) => Promise<Uint8Array>;

/** `url` if it is https on an allowlisted host, else a refusal. */
export function checkedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Cc0Error(Cc0Refusal.ManifestInvalid, `not a URL: ${url}`);
  }
  const plainHttps =
    parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "";
  if (!plainHttps || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Cc0Error(Cc0Refusal.HostNotAllowed, url);
  }
  return parsed;
}

/** Whether `name` is a plain file or folder name. */
export function isPlainName(name: string): boolean {
  return PLAIN_NAME.test(name) && !name.includes("..");
}

/** `name` if it is a plain name, else an `unsafe-name` refusal. */
export function checkedName(name: string): string {
  if (!isPlainName(name)) {
    throw new Cc0Error(Cc0Refusal.UnsafeName, name);
  }
  return name;
}

function checkPinned(entry: PinnedBytes): void {
  checkedName(entry.name);
  const sized = Number.isSafeInteger(entry.bytes) && entry.bytes > 0;
  const pinned = entry.sha256 === null || SHA256_HEX.test(entry.sha256);
  const published = entry.md5 === undefined || MD5_HEX.test(entry.md5);
  const wellFormed = sized && pinned && published;
  if (!wellFormed) {
    throw new Cc0Error(Cc0Refusal.ManifestInvalid, `${entry.name}: bytes, sha256 or md5`);
  }
}

function checkFile(file: ManifestFile): void {
  checkedName(file.name);
  checkedUrl(file.url);
  checkPinned(file);
  if (file.members === undefined) {
    return;
  }
  if (!Array.isArray(file.members) || file.members.length === 0) {
    throw new Cc0Error(Cc0Refusal.ManifestInvalid, `${file.name}: a zip lists the members it is fetched for`);
  }
  for (const member of file.members) {
    checkPinned(member);
  }
}

/** Refuses two names of one asset folder that are the same file on a case-insensitive disk. */
function checkDistinct(asset: ManifestAsset): void {
  const names = asset.files.flatMap((file) => [file.name, ...(file.members ?? []).map((member) => member.name)]);
  const folded = new Set(names.map((name) => name.toLowerCase()));
  if (folded.size !== names.length) {
    throw new Cc0Error(Cc0Refusal.ManifestInvalid, `${asset.id}: two files share a name`);
  }
}

/** Check every asset of `manifest` (names, hosts, licence, sizes, digests) before anything runs. */
export function checkManifest(manifest: Manifest): void {
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Cc0Error(Cc0Refusal.ManifestInvalid, "no assets");
  }
  for (const asset of manifest.assets) {
    checkedName(asset.id);
    if (asset.licence !== CC0) {
      throw new Cc0Error(Cc0Refusal.NotCc0, `${asset.id}: ${asset.licence}`);
    }
    for (const file of asset.files) {
      checkFile(file);
    }
    checkDistinct(asset);
  }
}

/** The sha256 of `bytes`, lowercase hex. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The md5 of `bytes`, lowercase hex: only to cross-check a source's published md5, never as a pin. */
export function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

/**
 * `bytes` checked against `entry`: its size, its md5 where one is published, and its sha256
 * against the pin (or, when `pin` allows and none is pinned yet, unchecked). Answers the sha256;
 * a refusal otherwise.
 */
export function verified(entry: PinnedBytes, bytes: Uint8Array, pin: boolean): string {
  if (bytes.byteLength !== entry.bytes) {
    throw new Cc0Error(Cc0Refusal.SizeMismatch, `${entry.name}: ${bytes.byteLength} bytes, manifest ${entry.bytes}`);
  }
  if (entry.md5 !== undefined && md5(bytes) !== entry.md5) {
    throw new Cc0Error(Cc0Refusal.HashMismatch, `${entry.name}: md5 differs from the published ${entry.md5}`);
  }
  const digest = sha256(bytes);
  if (entry.sha256 === null && !pin) {
    throw new Cc0Error(Cc0Refusal.Unpinned, `${entry.name}: run with --pin to record ${digest}`);
  }
  if (entry.sha256 !== null && entry.sha256 !== digest) {
    throw new Cc0Error(Cc0Refusal.HashMismatch, `${entry.name}: ${digest}, pinned ${entry.sha256}`);
  }
  return digest;
}

/** Where `file` of `asset` is cached under `raw`. */
export function cachedPath(raw: string, asset: ManifestAsset, file: ManifestFile): string {
  return path.join(raw, checkedName(asset.id), checkedName(file.name));
}

/** The bytes at `target` when they are `sha256`'s, else null (missing, unpinned or changed). */
async function cachedBytes(target: string, pinned: string | null): Promise<Uint8Array | null> {
  if (pinned === null || !existsSync(target)) {
    return null;
  }
  const bytes = new Uint8Array(await readFile(target));
  return sha256(bytes) === pinned ? bytes : null;
}

/**
 * Writes `bytes` beside `target` and renames them into place. The folder must be a real folder,
 * not a link out of the cache, and the side file is created fresh, so a link planted there is
 * replaced, never written through.
 */
async function writeAtomically(target: string, bytes: Uint8Array): Promise<void> {
  const folder = path.dirname(target);
  await mkdir(folder, { recursive: true });
  if ((await lstat(folder)).isSymbolicLink()) {
    throw new Cc0Error(Cc0Refusal.UnsafeName, `${folder} is a link`);
  }
  const partial = `${target}.partial`;
  try {
    await rm(partial, { force: true });
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

/** A member read out of a zip and verified, with the sha256 it is pinned to. */
type VerifiedMember = { member: ZipMember; bytes: Uint8Array; digest: string };

/**
 * Download `file` into `target` (verified, written beside it, renamed into place); a file already
 * there with the pinned sha256 is kept. A zip's listed members are then written beside it, each
 * verified, and nothing at all is written when the zip or any member is refused.
 */
export async function fetchFile(file: ManifestFile, target: string, pin: boolean, download: Download): Promise<void> {
  const cached = await cachedBytes(target, file.sha256);
  if (cached !== null && file.members === undefined) {
    return;
  }
  const bytes = cached ?? (await download(checkedUrl(file.url), file.bytes));
  const digest = cached === null ? verified(file, bytes, pin) : file.sha256;
  const members = file.members === undefined ? [] : unpackedMembers(bytes, file.members, pin, ZIP_LIMITS);
  if (cached === null) {
    file.sha256 = digest;
    await writeAtomically(target, bytes);
  }
  for (const { member, bytes: memberBytes, digest: memberDigest } of members) {
    member.sha256 = memberDigest;
    const memberTarget = path.join(path.dirname(target), checkedName(member.name));
    if ((await cachedBytes(memberTarget, memberDigest)) === null) {
      await writeAtomically(memberTarget, memberBytes);
    }
  }
}

/** Every listed member of `zip`, read and verified; the zip is refused whole on any hostile entry. */
export function unpackedMembers(
  zip: Uint8Array,
  members: readonly ZipMember[],
  pin: boolean,
  limits: ZipLimits,
): VerifiedMember[] {
  const entries = new Map(zipEntries(zip, limits).map((entry) => [entry.name, entry]));
  return members.map((member) => {
    const entry = entries.get(member.name);
    if (entry === undefined) {
      throw new Cc0Error(Cc0Refusal.ZipMemberMissing, member.name);
    }
    const bytes = entryBytes(zip, entry);
    return { member, bytes, digest: verified(member, bytes, pin) };
  });
}

// The zip format (PKWARE APPNOTE 6.3.10): the end-of-central-directory record, then one central
// header per entry, each pointing at a local header followed by the entry's data.
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
/** Sizes and counts at their maximum mean a ZIP64 record, which no CC0 source ships. */
const ZIP64_MARK = 0xffffffff;
const ZIP64_COUNT_MARK = 0xffff;
const FLAG_ENCRYPTED = 0x1;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/** `version made by`'s high byte: 3 is Unix, whose external attributes carry a file mode. */
const HOST_UNIX = 3;
const MODE_TYPE_MASK = 0o170000;
const MODE_REGULAR = 0o100000;

/** One entry of a zip's central directory. */
type ZipEntry = {
  name: string;
  method: number;
  crc: number;
  compressedBytes: number;
  expandedBytes: number;
  localOffset: number;
};

function invalid(detail: string): Cc0Error {
  return new Cc0Error(Cc0Refusal.ZipInvalid, detail);
}

/** The end-of-central-directory record's offset, searched back over a trailing comment. */
function eocdOffset(view: DataView): number {
  const last = view.byteLength - EOCD_BYTES;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      return at;
    }
  }
  throw invalid("no end-of-central-directory record");
}

/** The central directory's offset and entry count, refusing multi-disk, ZIP64 and a count past the cap. */
function centralDirectory(view: DataView, limits: ZipLimits): { offset: number; count: number; end: number } {
  const eocd = eocdOffset(view);
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  const multiDisk = view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0;
  const zip64 = count === ZIP64_COUNT_MARK || offset === ZIP64_MARK || size === ZIP64_MARK;
  if (multiDisk || zip64) {
    throw invalid("a multi-disk or ZIP64 archive");
  }
  if (view.getUint16(eocd + 8, true) !== count || offset + size > eocd) {
    throw invalid("the central directory disagrees with its end record");
  }
  if (count > limits.maxEntries) {
    throw new Cc0Error(Cc0Refusal.ZipTooManyEntries, `${count} entries, at most ${limits.maxEntries}`);
  }
  return { offset, count, end: offset + size };
}

/** Whether the entry's mode (Unix zips only) is anything but a regular file: a link, a folder, a device. */
function isSpecial(view: DataView, at: number): boolean {
  const unix = view.getUint8(at + 5) === HOST_UNIX;
  const type = (view.getUint32(at + 38, true) >>> 16) & MODE_TYPE_MASK;
  return unix && type !== 0 && type !== MODE_REGULAR;
}

/** The central header at `at`, checked: a plain name, a regular file, not encrypted, stored or deflated. */
function centralEntry(zip: Uint8Array, view: DataView, at: number, end: number): { entry: ZipEntry; next: number } {
  if (at + CENTRAL_BYTES > end || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
    throw invalid(`no central header at ${at}`);
  }
  const flags = view.getUint16(at + 8, true);
  const nameBytes = view.getUint16(at + 28, true);
  const next = at + CENTRAL_BYTES + nameBytes + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  if (next > end) {
    throw invalid(`central header at ${at} runs past the directory`);
  }
  // Read as UTF-8 whatever the name's flag says: a plain name is ASCII, which both encodings share.
  const name = new TextDecoder().decode(zip.subarray(at + CENTRAL_BYTES, at + CENTRAL_BYTES + nameBytes));
  if (!isPlainName(name) || isSpecial(view, at)) {
    throw new Cc0Error(Cc0Refusal.ZipUnsafeEntry, JSON.stringify(name));
  }
  const method = view.getUint16(at + 10, true);
  if ((flags & FLAG_ENCRYPTED) !== 0 || (method !== METHOD_STORED && method !== METHOD_DEFLATED)) {
    throw invalid(`${name}: encrypted or compressed by method ${method}`);
  }
  const entry: ZipEntry = {
    name,
    method,
    crc: view.getUint32(at + 16, true),
    compressedBytes: view.getUint32(at + 20, true),
    expandedBytes: view.getUint32(at + 24, true),
    localOffset: view.getUint32(at + 42, true),
  };
  return { entry, next };
}

/** Every entry of `zip`, refused whole on an unsafe or duplicate name, a special file or a cap. */
function zipEntries(zip: Uint8Array, limits: ZipLimits): ZipEntry[] {
  if (zip.byteLength < EOCD_BYTES) {
    throw invalid("too short for a zip");
  }
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const directory = centralDirectory(view, limits);
  const entries: ZipEntry[] = [];
  let at = directory.offset;
  for (let index = 0; index < directory.count; index += 1) {
    const { entry, next } = centralEntry(zip, view, at, directory.end);
    entries.push(entry);
    at = next;
  }
  checkEntrySet(entries, limits);
  return entries;
}

/** Refuses duplicate names (case-insensitively, as the cache's disk compares them) and too many expanded bytes. */
function checkEntrySet(entries: readonly ZipEntry[], limits: ZipLimits): void {
  const folded = new Set(entries.map((entry) => entry.name.toLowerCase()));
  if (folded.size !== entries.length) {
    throw new Cc0Error(Cc0Refusal.ZipUnsafeEntry, "two entries share a name");
  }
  const expanded = entries.reduce((sum, entry) => sum + entry.expandedBytes, 0);
  if (expanded > limits.maxExpandedBytes) {
    throw new Cc0Error(Cc0Refusal.ZipTooLarge, `${expanded} bytes expanded, at most ${limits.maxExpandedBytes}`);
  }
}

/** The entry's compressed data, located through its local header. */
function entryData(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.localOffset;
  if (at + LOCAL_BYTES > zip.byteLength || view.getUint32(at, true) !== LOCAL_SIGNATURE) {
    throw invalid(`${entry.name}: no local header`);
  }
  const start = at + LOCAL_BYTES + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedBytes;
  if (end > zip.byteLength) {
    throw invalid(`${entry.name}: data runs past the archive`);
  }
  return zip.subarray(start, end);
}

/** The entry's expanded bytes, checked against its declared size and CRC-32. */
function entryBytes(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const data = entryData(zip, entry);
  const bytes = entry.method === METHOD_STORED ? data.slice() : inflated(data, entry);
  if (bytes.byteLength !== entry.expandedBytes || crc32(bytes) !== entry.crc) {
    throw invalid(`${entry.name}: size or CRC-32 differs from its header`);
  }
  return bytes;
}

/** Inflates `data` a step at a time into the entry's declared size, stopping as soon as it would pass it. */
function inflated(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const out = new Uint8Array(entry.expandedBytes);
  let written = 0;
  const inflate = new Inflate((chunk) => {
    if (written + chunk.byteLength > out.byteLength) {
      throw new Cc0Error(Cc0Refusal.ZipTooLarge, `${entry.name}: expands past its declared ${out.byteLength} bytes`);
    }
    out.set(chunk, written);
    written += chunk.byteLength;
  });
  const steps = Math.max(1, Math.ceil(data.byteLength / INFLATE_STEP_BYTES));
  try {
    for (let step = 0; step < steps; step += 1) {
      const at = step * INFLATE_STEP_BYTES;
      inflate.push(data.subarray(at, at + INFLATE_STEP_BYTES), step === steps - 1);
    }
  } catch (error) {
    if (error instanceof Cc0Error) {
      throw error;
    }
    throw invalid(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out.subarray(0, written);
}

/** `response`'s body, refusing one longer than `maxBytes` (declared or streamed) before reading past it. */
async function cappedBody(response: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  const tooLong = (bytes: number) =>
    new Cc0Error(Cc0Refusal.SizeMismatch, `${url.href}: more than the manifest's ${maxBytes} bytes (${bytes})`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLong(declared);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw tooLong(total);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetches `url` with no redirect, naming the caller in `userAgent` (Poly Haven's API terms ask
 * every client to name its software), refusing a body past `maxBytes`.
 */
export async function httpsDownload(url: URL, maxBytes: number, userAgent: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", headers: { "user-agent": userAgent } });
  } catch (error) {
    throw new Cc0Error(Cc0Refusal.DownloadFailed, `${url.href}: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Cc0Error(Cc0Refusal.DownloadFailed, `${url.href}: HTTP ${response.status}`);
  }
  return new Uint8Array(await cappedBody(response, url, maxBytes));
}
