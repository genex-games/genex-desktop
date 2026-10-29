/**
 * The store's own archive reader. Entries are listed **before** anything is extracted, and an
 * unsafe one (absolute, `..`, a link out of the root, an entry through a link, a device, an
 * overlong name or link target) refuses the whole archive. Where the filesystem folds case and
 * Unicode normalization (APFS, NTFS), names are compared folded, so `C/x` counts as written
 * through the link `c`. One pure-TS tar header reader serves every platform
 * (ustar, pax and GNU long names): `.tar.gz` is gunzipped by zlib, `.tar.xz` is first turned into
 * a plain tar stream by darwin `/usr/bin/tar -cf - --format pax @<archive>` or linux `xz -dc`, so
 * no parser ever reads `tar -tv` text. Zip entries come from a pure-TS central-directory reader,
 * their types from the Unix external attributes.
 *
 * Extraction writes with the same readers that listed, so what was checked is what lands (no
 * second parser to disagree with the first). It creates every folder itself, one level at a time,
 * refusing an existing one that is a link, and creates the archive's symlinks only after every
 * file and folder is written, so no write can pass through a link even where a spelling the plan
 * did not fold reaches one. Then it `lstat`s every entry and `realpath`s every link against the
 * root. Every failure is a `ToolchainError` with `ToolchainProblem.Archive`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readdir, readlink, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createGunzip, createInflateRaw, inflateRawSync } from "node:zlib";
import { StudioPlatform } from "../../shared/boot.ts";
import { ArchiveFormat, ToolchainError, ToolchainProblem } from "../../shared/toolchain.ts";
import { openNoFollow } from "../fsx.ts";
import { isInside } from "../paths.ts";

const MESSAGE = {
  Truncated: "The archive ends before its end-of-archive marker.",
  BadChecksum: (offset: number) => `A tar header at byte ${offset} has a wrong checksum.`,
  BadNumber: "A tar header holds a malformed number.",
  BadPax: "A pax extended header is malformed.",
  MetaTooLarge: "A pax or GNU long-name header is larger than any real name.",
  Absolute: (name: string) => `The archive names an absolute path: ${name}`,
  Parent: (name: string) => `The archive climbs out of its folder: ${name}`,
  Backslash: (name: string) => `The archive names a path with a backslash: ${name}`,
  TooLong: (bytes: number) => `The archive names a ${bytes}-byte path; the limit is ${ARCHIVE_NAME_MAX_BYTES}.`,
  LinkTooLong: (name: string, bytes: number) =>
    `The link ${name} has a ${bytes}-byte target; the limit is ${ARCHIVE_NAME_MAX_BYTES}.`,
  Special: (name: string) => `The archive holds a device, FIFO or other special file: ${name}`,
  Duplicate: (name: string) => `The archive names ${name} twice as different kinds of entry.`,
  Through: (name: string) => `The archive writes through a link: ${name}`,
  NotFolder: (name: string) => `The archive writes into ${name}, which is not a folder.`,
  LinkOut: (name: string, target: string) => `The link ${name} points out of the archive: ${target}`,
  HardlinkTarget: (name: string, target: string) => `The hard link ${name} does not name an earlier file: ${target}`,
  Escaped: (name: string) => `After extraction, ${name} resolves outside the install folder.`,
  Changed: "The archive changed between listing and extraction.",
  NoXz: (platform: string) => `No .tar.xz reader on ${platform}.`,
  XzFailed: (detail: string) => `The .tar.xz could not be read: ${detail}`,
  NotZip: "The zip has no end-of-central-directory record.",
  Zip64: "Zip64 archives are not supported.",
  ZipEntry: (name: string) => `The zip entry ${name} is encrypted, uses an unknown method or is malformed.`,
  ZipCrc: (name: string) => `The zip entry ${name} does not match its checksum.`,
  TreeNotRegular: (rel: string) => `${rel} is a link or a special file; a pinned tree holds only files and folders.`,
} as const;

/** What an archive entry is. */
export const ArchiveEntryType = {
  File: "file",
  Dir: "dir",
  Symlink: "symlink",
  Hardlink: "hardlink",
  /** A device, FIFO or anything else: always refused. */
  Other: "other",
} as const;
export type ArchiveEntryType = (typeof ArchiveEntryType)[keyof typeof ArchiveEntryType];

/** One entry as the archive's own headers state it. */
export interface ArchiveEntry {
  /** The path inside the archive, as written (before `strip`). */
  name: string;
  type: ArchiveEntryType;
  /** A link's target; null for everything else. */
  linkTarget: string | null;
  size: number;
  mode: number;
}

/** The longest entry or link name, in UTF-8 bytes, an archive may hold. */
export const ARCHIVE_NAME_MAX_BYTES = 1024;
const BLOCK = 512;
/** A pax record set or GNU long name bigger than this is no real name. */
const META_MAX_BYTES = 64 * 1024;
/** How many links one link target may pass through before it counts as a loop. */
const LINK_DEPTH_MAX = 40;
/** A zip symlink's target is its data; anything longer is refused as a name. */
const ZIP_LINK_MAX_BYTES = ARCHIVE_NAME_MAX_BYTES;
const XZ_STDERR_MAX_BYTES = 4096;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_EOCD_BYTES = 22;
const ZIP_CENTRAL_BYTES = 46;
const ZIP_LOCAL_BYTES = 30;
const ZIP_MAX_COMMENT = 0xffff;
const ZIP_UNIX = 3;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

const refuse = (message: string) => new ToolchainError(ToolchainProblem.Archive, message);

// ---------- a byte source over a stream ----------

interface ByteSource {
  /** Exactly `length` bytes; null at a clean end before any byte. */
  read(length: number): Promise<Buffer | null>;
  /** Hands the next `length` bytes to `sink`, chunk by chunk. */
  pipe(length: number, sink: (chunk: Buffer) => Promise<void>): Promise<void>;
}

function byteSource(input: AsyncIterable<Buffer | string>): ByteSource {
  const iterator = input[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let buffered = 0;
  const fill = async (length: number): Promise<boolean> => {
    while (buffered < length) {
      const next = await iterator.next();
      if (next.done) return false;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      chunks.push(chunk);
      buffered += chunk.length;
    }
    return true;
  };
  const take = (length: number): Buffer => {
    const first = chunks[0] ?? Buffer.alloc(0);
    if (first.length > length) {
      chunks[0] = first.subarray(length);
      buffered -= length;
      return first.subarray(0, length);
    }
    chunks.shift();
    buffered -= first.length;
    return first;
  };
  const pipe = async (length: number, sink: (chunk: Buffer) => Promise<void>) => {
    let left = length;
    while (left > 0) {
      if (buffered === 0 && !(await fill(1))) throw refuse(MESSAGE.Truncated);
      const part = take(left);
      left -= part.length;
      await sink(part);
    }
  };
  const read = async (length: number): Promise<Buffer | null> => {
    if (!(await fill(length))) {
      if (buffered === 0) return null;
      throw refuse(MESSAGE.Truncated);
    }
    const parts: Buffer[] = [];
    await pipe(length, async (part) => {
      parts.push(part);
    });
    return parts.length === 1 ? (parts[0] ?? Buffer.alloc(0)) : Buffer.concat(parts);
  };
  return { read, pipe };
}

// ---------- tar ----------

interface TarHeader {
  name: string;
  type: string;
  size: number;
  linkname: string;
  mode: number;
}

/** What pax and GNU long-name headers say about the entry after them. */
interface Pending {
  path?: string;
  linkpath?: string;
  size?: number;
}

const TAR_TYPES: Readonly<Record<string, ArchiveEntryType>> = {
  "0": ArchiveEntryType.File,
  "\0": ArchiveEntryType.File,
  "7": ArchiveEntryType.File,
  "1": ArchiveEntryType.Hardlink,
  "2": ArchiveEntryType.Symlink,
  "5": ArchiveEntryType.Dir,
};
/** Header types that describe the next entry instead of being one. */
const TAR_META = new Set(["x", "g", "L", "K"]);

function cString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

/** A tar number: octal text, or GNU base-256 when the first byte's high bit is set. */
function tarNumber(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    let value = (field[0] ?? 0) & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw refuse(MESSAGE.BadNumber);
    return value;
  }
  const text = field
    .toString("latin1")
    .replace(/[\0 ]+$/, "")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw refuse(MESSAGE.BadNumber);
  return Number.parseInt(text, 8);
}

function checksumMatches(block: Buffer): boolean {
  const stored = tarNumber(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index++) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

/** A header block, or null for the end-of-archive zero block. */
function parseHeader(block: Buffer, offset: number): TarHeader | null {
  if (block.every((byte) => byte === 0)) return null;
  if (!checksumMatches(block)) throw refuse(MESSAGE.BadChecksum(offset));
  const posix = block.toString("latin1", 257, 263) === "ustar\0";
  const name = cString(block, 0, 100);
  const prefix = posix ? cString(block, 345, 155) : "";
  return {
    name: prefix ? `${prefix}/${name}` : name,
    type: String.fromCharCode(block[156] ?? 0),
    size: tarNumber(block, 124, 12),
    linkname: cString(block, 157, 100),
    mode: tarNumber(block, 100, 8),
  };
}

/** pax records: `<length> <key>=<value>\n`, each length counting its whole record. */
function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const length = Number.parseInt(body.toString("latin1", at, space), 10);
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0 || at + length > body.length)
      throw refuse(MESSAGE.BadPax);
    const record = body.toString("utf8", space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (equals < 0 || body[at + length - 1] !== 0x0a) throw refuse(MESSAGE.BadPax);
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** Folds one pax (`x`, `g`) or GNU (`L`, `K`) header into what applies to the next entry. */
function applyMeta(header: TarHeader, body: Buffer, pending: Pending): Pending {
  if (header.type === "L") return { ...pending, path: cString(body, 0, body.length) };
  if (header.type === "K") return { ...pending, linkpath: cString(body, 0, body.length) };
  const records = parsePax(body);
  if (header.type === "g") return pending;
  const size = records.get("size");
  const next: Pending = { ...pending };
  const recordPath = records.get("path");
  const recordLink = records.get("linkpath");
  if (recordPath !== undefined) next.path = recordPath;
  if (recordLink !== undefined) next.linkpath = recordLink;
  if (size !== undefined) {
    if (!/^[0-9]+$/.test(size)) throw refuse(MESSAGE.BadPax);
    next.size = Number(size);
  }
  return next;
}

function toEntry(header: TarHeader, pending: Pending): ArchiveEntry {
  const name = pending.path ?? header.name;
  const known = TAR_TYPES[header.type];
  const type =
    known === ArchiveEntryType.File && name.endsWith("/") ? ArchiveEntryType.Dir : (known ?? ArchiveEntryType.Other);
  const isLink = type === ArchiveEntryType.Symlink || type === ArchiveEntryType.Hardlink;
  return {
    name,
    type,
    linkTarget: isLink ? (pending.linkpath ?? header.linkname) : null,
    size: pending.size ?? header.size,
    mode: header.mode,
  };
}

/** One entry and, for a file, a way to read its bytes (skipped when the visitor does not). */
type TarVisitor = (
  entry: ArchiveEntry,
  body: (sink: (chunk: Buffer) => Promise<void>) => Promise<void>,
) => Promise<void>;

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;
const skipTo = async (source: ByteSource, length: number) => source.pipe(length, async () => {});

/** A pax or GNU long-name header's body, folded into what applies to the next entry. */
async function readMeta(source: ByteSource, header: TarHeader, pending: Pending): Promise<Pending> {
  if (header.size > META_MAX_BYTES) throw refuse(MESSAGE.MetaTooLarge);
  const body = header.size ? await source.read(header.size) : null;
  return applyMeta(header, body ?? Buffer.alloc(0), pending);
}

/** One entry handed to `visit`; its bytes are skipped when the visitor does not read them. */
async function readEntry(source: ByteSource, entry: ArchiveEntry, size: number, visit: TarVisitor): Promise<void> {
  let consumed = false;
  await visit(entry, (sink) => {
    consumed = true;
    return source.pipe(size, sink);
  });
  if (!consumed) await skipTo(source, size);
}

/** Reads a tar stream header by header until its end marker, calling `visit` for every entry. */
async function readTar(source: ByteSource, visit: TarVisitor, signal?: AbortSignal): Promise<void> {
  let pending: Pending = {};
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const block = await source.read(BLOCK);
    if (!block) throw refuse(MESSAGE.Truncated);
    const header = parseHeader(block, offset);
    if (!header) return;
    const meta = TAR_META.has(header.type);
    const size = meta ? header.size : dataSize(header, pending);
    if (meta) pending = await readMeta(source, header, pending);
    else {
      await readEntry(source, toEntry(header, pending), size, visit);
      pending = {};
    }
    await skipTo(source, padding(size));
    offset += BLOCK + size + padding(size);
  }
}

/** Bytes that follow a header: a regular file's, never a link's or a folder's. */
function dataSize(header: TarHeader, pending: Pending): number {
  const type = TAR_TYPES[header.type];
  const carriesData = type === ArchiveEntryType.File || type === undefined;
  return carriesData ? (pending.size ?? header.size) : 0;
}

/** The command that turns a `.tar.xz` into a plain tar stream on `platform`. */
export function xzTarCommand(platform: NodeJS.Platform | string, archive: string): { file: string; args: string[] } {
  if (platform === StudioPlatform.Mac)
    return { file: "/usr/bin/tar", args: ["-cf", "-", "--format", "pax", `@${archive}`] };
  if (platform === StudioPlatform.Linux) return { file: "xz", args: ["-dc", archive] };
  throw refuse(MESSAGE.NoXz(platform));
}

/** A plain tar stream of `file`, and how to stop whatever produces it. */
interface TarStream {
  bytes: Readable;
  close(): Promise<void>;
  failure(): string;
}

function gunzipStream(file: string): TarStream {
  const bytes = new PassThrough();
  pipeline(createReadStream(file), createGunzip(), bytes).catch((error: unknown) => bytes.destroy(error as Error));
  return { bytes, close: async () => void bytes.destroy(), failure: () => "" };
}

function xzStream(file: string, platform: string, signal?: AbortSignal): TarStream {
  const command = xzTarCommand(platform, file);
  const child = spawn(command.file, command.args, { stdio: ["ignore", "pipe", "pipe"], signal });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < XZ_STDERR_MAX_BYTES) stderr += chunk.toString("utf8");
  });
  child.on("error", () => {});
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // The reader stops at the end marker; whatever the producer wrote after it (record padding)
    // stays unread in the pipe, and the child never closes until that pipe is let go.
    child.stdout.destroy();
    await exited;
  };
  return { bytes: child.stdout, close, failure: () => stderr.trim() };
}

function openTar(file: string, format: ArchiveFormat, options: ReadOptions): TarStream {
  if (format === ArchiveFormat.TarXz) return xzStream(file, options.platform ?? process.platform, options.signal);
  return gunzipStream(file);
}

/** Runs `visit` over every entry of a tar archive, always stopping its producer. */
async function walkTar(file: string, format: ArchiveFormat, visit: TarVisitor, options: ReadOptions): Promise<void> {
  const stream = openTar(file, format, options);
  try {
    await readTar(byteSource(stream.bytes), visit, options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    const detail = stream.failure();
    throw refuse(detail ? `${message} ${MESSAGE.XzFailed(detail)}` : message);
  } finally {
    await stream.close();
  }
}

// ---------- zip ----------

interface ZipEntry extends ArchiveEntry {
  method: number;
  crc: number;
  compressedSize: number;
  localOffset: number;
}

function zipType(madeBy: number, external: number, name: string): { type: ArchiveEntryType; mode: number } {
  const unixMode = external >>> 16;
  const byName = name.endsWith("/") ? ArchiveEntryType.Dir : ArchiveEntryType.File;
  if (madeBy >> 8 !== ZIP_UNIX || unixMode === 0)
    return { type: byName, mode: byName === ArchiveEntryType.Dir ? 0o755 : 0o644 };
  const kind = unixMode & S_IFMT;
  const types: Record<number, ArchiveEntryType> = {
    [S_IFLNK]: ArchiveEntryType.Symlink,
    [S_IFDIR]: ArchiveEntryType.Dir,
    [S_IFREG]: byName,
    0: byName,
  };
  return { type: types[kind] ?? ArchiveEntryType.Other, mode: unixMode & 0o7777 };
}

/** One central-directory record at `at`, and where the next one starts. */
function centralRecord(directory: Buffer, at: number): { entry: ZipEntry; next: number } {
  if (at + ZIP_CENTRAL_BYTES > directory.length || directory.readUInt32LE(at) !== ZIP_CENTRAL)
    throw refuse(MESSAGE.NotZip);
  const nameLength = directory.readUInt16LE(at + 28);
  const next = at + ZIP_CENTRAL_BYTES + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
  const name = directory.toString("utf8", at + ZIP_CENTRAL_BYTES, at + ZIP_CENTRAL_BYTES + nameLength);
  const flags = directory.readUInt16LE(at + 8);
  const method = directory.readUInt16LE(at + 10);
  const compressedSize = directory.readUInt32LE(at + 20);
  const size = directory.readUInt32LE(at + 24);
  const localOffset = directory.readUInt32LE(at + 42);
  const unsupported = (flags & 1) !== 0 || (method !== ZIP_STORED && method !== ZIP_DEFLATED);
  if (unsupported) throw refuse(MESSAGE.ZipEntry(name));
  if ([compressedSize, size, localOffset].includes(0xffffffff)) throw refuse(MESSAGE.Zip64);
  const { type, mode } = zipType(directory.readUInt16LE(at + 4), directory.readUInt32LE(at + 38), name);
  const crc = directory.readUInt32LE(at + 16);
  return { entry: { name, type, linkTarget: null, size, mode, method, crc, compressedSize, localOffset }, next };
}

/** Where an entry's compressed bytes start, from its local header. */
async function zipDataStart(handle: import("node:fs/promises").FileHandle, entry: ZipEntry): Promise<number> {
  const local = Buffer.alloc(ZIP_LOCAL_BYTES);
  await handle.read(local, 0, ZIP_LOCAL_BYTES, entry.localOffset);
  if (local.readUInt32LE(0) !== ZIP_LOCAL) throw refuse(MESSAGE.ZipEntry(entry.name));
  return entry.localOffset + ZIP_LOCAL_BYTES + local.readUInt16LE(26) + local.readUInt16LE(28);
}

/** A small entry's bytes (a symlink's target), checked against its CRC. */
async function readSmallZipEntry(handle: import("node:fs/promises").FileHandle, entry: ZipEntry): Promise<Buffer> {
  if (entry.size > ZIP_LINK_MAX_BYTES || entry.compressedSize > ZIP_LINK_MAX_BYTES * 2)
    throw refuse(MESSAGE.TooLong(entry.size));
  const raw = Buffer.alloc(entry.compressedSize);
  await handle.read(raw, 0, entry.compressedSize, await zipDataStart(handle, entry));
  const data = entry.method === ZIP_DEFLATED ? inflateRawSync(raw) : raw;
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw refuse(MESSAGE.ZipCrc(entry.name));
  return data;
}

async function listZip(file: string): Promise<ZipEntry[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, ZIP_EOCD_BYTES + ZIP_MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const signature = Buffer.alloc(4);
    signature.writeUInt32LE(ZIP_EOCD);
    const at = tail.lastIndexOf(signature);
    if (at < 0 || at + ZIP_EOCD_BYTES > tail.length) throw refuse(MESSAGE.NotZip);
    const count = tail.readUInt16LE(at + 10);
    const directorySize = tail.readUInt32LE(at + 12);
    const directoryOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || directoryOffset === 0xffffffff) throw refuse(MESSAGE.Zip64);
    if (directoryOffset + directorySize > size) throw refuse(MESSAGE.NotZip);
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    for (let index = 0, offset = 0; index < count; index++) {
      const { entry, next } = centralRecord(directory, offset);
      if (entry.type === ArchiveEntryType.Symlink)
        entry.linkTarget = (await readSmallZipEntry(handle, entry)).toString("utf8");
      entries.push(entry);
      offset = next;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

// ---------- listing ----------

/** How an archive is read: cancellation, and the platform whose `.tar.xz` command to use. */
export interface ReadOptions {
  signal?: AbortSignal;
  platform?: NodeJS.Platform | string;
}

/** Every entry of `file`, read from its headers without extracting anything. */
export async function listArchive(
  file: string,
  format: ArchiveFormat,
  options: ReadOptions = {},
): Promise<ArchiveEntry[]> {
  if (format === ArchiveFormat.Zip) {
    const entries = await listZip(file).catch(asArchiveError);
    return entries.map(({ name, type, linkTarget, size, mode }) => ({ name, type, linkTarget, size, mode }));
  }
  const entries: ArchiveEntry[] = [];
  await walkTar(file, format, async (entry) => void entries.push(entry), options);
  return entries;
}

function asArchiveError(error: unknown): never {
  if (error instanceof ToolchainError) throw error;
  throw refuse(error instanceof Error ? error.message : String(error));
}

// ---------- the plan: every entry checked before any is written ----------

/** One entry that will be written: where (relative to the destination, `/`-separated) and, for a hard link, what to. */
export interface PlannedEntry {
  /** The entry's position in the listing. */
  index: number;
  entry: ArchiveEntry;
  path: string;
  /** A hard link's destination-relative target; null otherwise. */
  linkPath: string | null;
}

/** How an archive is planned: its strip and subfolder, and the platform whose filesystem it lands on. */
export interface PlanOptions {
  strip: number;
  into: string;
  /** Where names differ only in case or normalization, APFS (darwin) and NTFS (win32) name one file. Default: this one. */
  platform?: NodeJS.Platform | string;
}

/** A name as the plan compares it: folded on a filesystem that folds case and Unicode normalization. */
type NameKey = (rel: string) => string;

const foldedName: NameKey = (rel) => rel.normalize("NFD").toLowerCase().normalize("NFC");
const exactName: NameKey = (rel) => rel;

/** APFS and NTFS resolve names that differ only in case (APFS: or normalization) to one file. */
function nameKeyFor(platform: NodeJS.Platform | string): NameKey {
  const folds = platform === StudioPlatform.Mac || platform === StudioPlatform.Windows;
  return folds ? foldedName : exactName;
}

/** A name's segments with empty and `.` ones dropped; refused when absolute, climbing or overlong. */
function safeSegments(name: string): string[] {
  const bytes = Buffer.byteLength(name);
  if (bytes > ARCHIVE_NAME_MAX_BYTES) throw refuse(MESSAGE.TooLong(bytes));
  if (name.startsWith("/")) throw refuse(MESSAGE.Absolute(name));
  if (name.includes("\\")) throw refuse(MESSAGE.Backslash(name));
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw refuse(MESSAGE.Parent(name));
  return segments;
}

/** The archive's own symlinks, by their key, and how names are keyed. */
interface LinkTable {
  targets: ReadonlyMap<string, string>;
  key: NameKey;
}

/**
 * Where a link at `parent` pointing to `target` lands, following the archive's own links; null
 * when it climbs above the archive's root or loops.
 */
function resolveInside(parent: readonly string[], target: string, links: LinkTable, depth = 0): string[] | null {
  if (depth > LINK_DEPTH_MAX || target.startsWith("/")) return null;
  let at = [...parent];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (at.length === 0) return null;
      at.pop();
      continue;
    }
    at.push(part);
    const next = links.targets.get(links.key(at.join("/")));
    if (next === undefined) continue;
    const resolved = resolveInside(at.slice(0, -1), next, links, depth + 1);
    if (!resolved) return null;
    at = resolved;
  }
  return at;
}

interface Kept {
  index: number;
  entry: ArchiveEntry;
  segments: string[];
}

/** Pass one: every name shaped safely, no special file, no path (as `key` compares it) twice as different kinds. */
function keptEntries(
  entries: readonly ArchiveEntry[],
  strip: number,
  key: NameKey,
): { kept: Kept[]; links: LinkTable } {
  const kept: Kept[] = [];
  const targets = new Map<string, string>();
  const types = new Map<string, ArchiveEntryType>();
  entries.forEach((entry, index) => {
    const segments = safeSegments(entry.name).slice(strip);
    if (entry.type === ArchiveEntryType.Other) throw refuse(MESSAGE.Special(entry.name));
    if (segments.length === 0) return;
    const rel = key(segments.join("/"));
    const earlier = types.get(rel);
    if (earlier !== undefined && (earlier !== ArchiveEntryType.Dir || entry.type !== ArchiveEntryType.Dir))
      throw refuse(MESSAGE.Duplicate(entry.name));
    types.set(rel, entry.type);
    if (entry.type === ArchiveEntryType.Symlink) targets.set(rel, entry.linkTarget ?? "");
    kept.push({ index, entry, segments });
  });
  return { kept, links: { targets, key } };
}

/** A hard link's target, stripped like every name: it must be a file listed earlier. */
function hardlinkTarget(item: Kept, strip: number, files: ReadonlySet<string>, key: NameKey): string[] {
  const target = item.entry.linkTarget ?? "";
  const segments = safeSegments(target).slice(strip);
  if (segments.length === 0 || !files.has(key(segments.join("/"))))
    throw refuse(MESSAGE.HardlinkTarget(item.entry.name, target));
  return segments;
}

/** A symlink's target is no longer than a name may be, and resolves inside the archive's root. */
function assertLinkInside(item: Kept, links: LinkTable): void {
  const target = item.entry.linkTarget ?? "";
  const bytes = Buffer.byteLength(target);
  if (bytes > ARCHIVE_NAME_MAX_BYTES) throw refuse(MESSAGE.LinkTooLong(item.entry.name, bytes));
  if (!resolveInside(item.segments.slice(0, -1), target || "/", links))
    throw refuse(MESSAGE.LinkOut(item.entry.name, target));
}

/**
 * Checks every entry before anything is written and answers where each lands under
 * `<dest>/<into>` after dropping `strip` leading components (entries stripped away entirely are
 * skipped, as `tar --strip-components` does). Refuses, with a typed archive error, absolute and
 * climbing names, names and link targets over {@link ARCHIVE_NAME_MAX_BYTES}, devices, FIFOs and
 * other special files, a path listed twice as different kinds, any entry written through a link, a
 * link whose target leaves the archive's root, and a hard link to anything but an earlier file.
 * On a platform whose filesystem folds names, every comparison is between folded names.
 */
export function planExtraction(entries: readonly ArchiveEntry[], options: PlanOptions): PlannedEntry[] {
  const into = safeSegments(options.into);
  const key = nameKeyFor(options.platform ?? process.platform);
  const { kept, links } = keptEntries(entries, options.strip, key);
  const files = new Set<string>();
  return kept.map((item) => {
    const { entry, segments } = item;
    assertNotThroughLink(item, links);
    if (entry.type === ArchiveEntryType.Symlink) assertLinkInside(item, links);
    const hardlink = entry.type === ArchiveEntryType.Hardlink;
    const linkSegments = hardlink ? hardlinkTarget(item, options.strip, files, key) : null;
    if (entry.type === ArchiveEntryType.File) files.add(key(segments.join("/")));
    return {
      index: item.index,
      entry,
      path: [...into, ...segments].join("/"),
      linkPath: linkSegments ? [...into, ...linkSegments].join("/") : null,
    };
  });
}

/** No folder above an entry is a link: extraction never writes through one. */
function assertNotThroughLink(item: Kept, links: LinkTable): void {
  for (let depth = 1; depth < item.segments.length; depth++)
    if (links.targets.has(links.key(item.segments.slice(0, depth).join("/"))))
      throw refuse(MESSAGE.Through(item.entry.name));
}

// ---------- extraction ----------

/** A file's mode on disk: readable, owner-writable, its executable bits kept, nothing special. */
const fileMode = (mode: number) => 0o644 | (mode & 0o111);
const EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** A file entry's bytes, handed chunk by chunk to `sink`. */
type EntryBody = (sink: (chunk: Buffer) => Promise<void>) => Promise<void>;

/** Where an extraction writes, and the folders under it already checked to be real folders. */
interface TreeWriter {
  root: string;
  /** Absolute paths checked (or made) as folders, never links; a symlink can never replace one. */
  folders: Set<string>;
}

function treeWriter(root: string): TreeWriter {
  return { root, folders: new Set([root]) };
}

/**
 * The folder `segments` names under the writer's root, made one level at a time: an existing
 * level must be a real folder, never a link (whatever spelling reached it) or a file.
 */
async function realFolder(writer: TreeWriter, segments: readonly string[]): Promise<string> {
  let at = writer.root;
  for (const segment of segments) {
    at = path.join(at, segment);
    if (writer.folders.has(at)) continue;
    const info = await lstat(at).catch(() => null);
    const rel = path.relative(writer.root, at);
    if (info?.isSymbolicLink()) throw refuse(MESSAGE.Through(rel));
    if (info && !info.isDirectory()) throw refuse(MESSAGE.NotFolder(rel));
    if (!info) await mkdir(at, { mode: 0o755 });
    writer.folders.add(at);
  }
  return at;
}

/** Where `rel` lands: its folder made or checked by {@link realFolder}, joined with its last segment. */
async function placeUnder(writer: TreeWriter, rel: string): Promise<string> {
  const segments = rel.split("/");
  return path.join(await realFolder(writer, segments.slice(0, -1)), segments.at(-1) ?? "");
}

/** A hard link's source: the earlier file itself, never a link to one. */
async function hardlinkSource(writer: TreeWriter, item: PlannedEntry): Promise<string> {
  const source = await placeUnder(writer, item.linkPath ?? "");
  const info = await lstat(source).catch(() => null);
  if (!info?.isFile()) throw refuse(MESSAGE.HardlinkTarget(item.entry.name, item.entry.linkTarget ?? ""));
  return source;
}

/** Writes one planned entry; a file's bytes come from `body`. Symlinks are written by {@link writeLinks}. */
async function writeEntry(writer: TreeWriter, item: PlannedEntry, body?: EntryBody): Promise<void> {
  const { entry } = item;
  if (entry.type === ArchiveEntryType.Dir) {
    await realFolder(writer, item.path.split("/"));
    return;
  }
  const target = await placeUnder(writer, item.path);
  if (entry.type === ArchiveEntryType.Hardlink) await link(await hardlinkSource(writer, item), target);
  else await writeFileEntry(target, entry, body);
}

/** The archive's symlinks, written after every file and folder, so nothing is ever written through one. */
async function writeLinks(writer: TreeWriter, links: readonly PlannedEntry[], signal?: AbortSignal): Promise<void> {
  for (const item of links) {
    signal?.throwIfAborted();
    await symlink(item.entry.linkTarget ?? "", await placeUnder(writer, item.path));
  }
}

async function writeFileEntry(target: string, entry: ArchiveEntry, body?: EntryBody): Promise<void> {
  const handle = await open(target, EXCLUSIVE, fileMode(entry.mode));
  try {
    await body?.(async (chunk) => {
      await handle.write(chunk);
    });
  } finally {
    await handle.close();
  }
}

const isSymlink = (item: PlannedEntry) => item.entry.type === ArchiveEntryType.Symlink;

async function extractTar(
  file: string,
  format: ArchiveFormat,
  writer: TreeWriter,
  plan: readonly PlannedEntry[],
  options: ReadOptions,
): Promise<void> {
  const byIndex = new Map(plan.map((item) => [item.index, item]));
  let index = 0;
  await walkTar(
    file,
    format,
    async (entry, body) => {
      const item = byIndex.get(index);
      index += 1;
      if (!item) return;
      if (item.entry.name !== entry.name || item.entry.type !== entry.type) throw refuse(MESSAGE.Changed);
      if (!isSymlink(item)) await writeEntry(writer, item, body);
    },
    options,
  );
  await writeLinks(writer, plan.filter(isSymlink), options.signal);
}

async function extractZip(
  file: string,
  writer: TreeWriter,
  plan: readonly PlannedEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const entries = await listZip(file);
  const handle = await open(file, "r");
  try {
    for (const item of plan) {
      signal?.throwIfAborted();
      const entry = entries[item.index];
      if (!entry || entry.name !== item.entry.name) throw refuse(MESSAGE.Changed);
      if (isSymlink(item)) continue;
      if (entry.type !== ArchiveEntryType.File) {
        await writeEntry(writer, item);
        continue;
      }
      const start = await zipDataStart(handle, entry);
      await writeEntry(writer, item, (sink) => zipBody(file, entry, start, sink));
    }
  } finally {
    await handle.close();
  }
  await writeLinks(writer, plan.filter(isSymlink), signal);
}

/** Streams one zip entry's inflated bytes to `sink`, checking its size and CRC. */
async function zipBody(
  file: string,
  entry: ZipEntry,
  start: number,
  sink: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  if (entry.compressedSize === 0 && entry.size === 0) return;
  const raw = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  const bytes: Readable = entry.method === ZIP_DEFLATED ? raw.pipe(createInflateRaw()) : raw;
  let crc = 0;
  let size = 0;
  for await (const chunk of bytes) {
    const data = chunk as Buffer;
    crc = crc32(data, crc);
    size += data.length;
    await sink(data);
  }
  if (size !== entry.size || crc !== entry.crc) throw refuse(MESSAGE.ZipCrc(entry.name));
}

/** After extraction: every entry is a file, folder or link, and every link resolves inside `root`. */
async function verifyTree(root: string, folder: string): Promise<void> {
  for (const name of await readdir(folder)) {
    const full = path.join(folder, name);
    const info = await lstat(full);
    if (info.isDirectory()) await verifyTree(root, full);
    else if (info.isSymbolicLink()) {
      const real = await realpath(full).catch(() => null);
      if (real !== null && !isInside(root, real)) throw refuse(MESSAGE.Escaped(path.relative(root, full)));
    } else if (!info.isFile()) throw refuse(MESSAGE.Special(path.relative(root, full)));
  }
}

/**
 * Extracts `file` into `dest/into`, dropping `strip` leading path components, after
 * {@link planExtraction} found every entry safe for `platform`'s filesystem; a refused archive
 * writes nothing, and no entry is ever written outside `dest/into`.
 */
export async function extractArchive(
  file: string,
  format: ArchiveFormat,
  dest: string,
  options: PlanOptions & { signal?: AbortSignal },
): Promise<void> {
  const read = { signal: options.signal, platform: options.platform };
  const plan = planExtraction(await listArchive(file, format, read), options);
  await mkdir(dest, { recursive: true });
  const writer = treeWriter(await realpath(dest));
  try {
    const archiveRoot = await realpath(await realFolder(writer, safeSegments(options.into)));
    if (format === ArchiveFormat.Zip) await extractZip(file, writer, plan, options.signal);
    else await extractTar(file, format, writer, plan, read);
    await verifyTree(archiveRoot, archiveRoot);
  } catch (error) {
    options.signal?.throwIfAborted();
    asArchiveError(error);
  }
}

// ---------- tree digests ----------

/** What a pinned folder holds, as one digest (the vendored crate tree's pin, `rust-install.ts`). */
export interface TreeDigest {
  /** sha256 over one line per regular file, in byte order of its `/`-separated path: path, size, executable bit, sha256. */
  sha256: string;
  files: number;
  bytes: number;
}

/** Any execute bit: what a build script or a tool needs, and what a tampered tree might add. */
const EXECUTABLE_BITS = 0o111;
const TREE_READ_CHUNK_BYTES = 1024 * 1024;

/** Byte order of two path segments: never the locale's. */
const byteOrder = (a: string, b: string) => (a < b ? -1 : Number(a > b));

/** The sha256 of the regular file `file`, read without following a link; null when it is not one. */
async function regularFileSha256(file: string): Promise<{ size: number; sha256: string; mode: number } | null> {
  const handle = await openNoFollow(file, constants.O_RDONLY).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(TREE_READ_CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { size, sha256: hash.digest("hex"), mode: info.mode };
  } finally {
    await handle.close();
  }
}

/** A link inside a tree: where it is (`/`-separated) and its relative target, as written. */
export interface TreeLink {
  rel: string;
  target: string;
}

/** What a tree holds: its folders and regular files, and the links of its own it may keep. */
export interface TreeEntries {
  folders: string[];
  files: string[];
  links: TreeLink[];
}

/**
 * Whether the link at `rel` under `root` is one of the tree's own: a relative target that stays
 * inside the tree as written and, followed, still lands inside it (no chain out, nothing dangling).
 */
async function ownLink(root: string, rel: string): Promise<TreeLink | null> {
  const target = await readlink(path.join(root, ...rel.split("/"))).catch(() => null);
  if (target === null || path.isAbsolute(target) || target.includes("\\")) return null;
  const written = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
  if (written === ".." || written.startsWith("../")) return null;
  const real = await realpath(path.join(root, ...rel.split("/"))).catch(() => null);
  const realRoot = await realpath(root);
  const inside = real !== null && (real === realRoot || real.startsWith(`${realRoot}${path.sep}`));
  return inside ? { rel, target } : null;
}

/**
 * Everything under `root`, `/`-separated and in byte order. A special file throws, and so does a
 * link, unless `links` keeps the tree's own ({@link ownLink}): the relative links an archive made
 * inside its component (llvm-mingw's shared include folders). A link is never followed.
 */
export async function treeEntries(root: string, options: { links?: boolean } = {}, rel = ""): Promise<TreeEntries> {
  const at = rel ? path.join(root, ...rel.split("/")) : root;
  const found: TreeEntries = { folders: [], files: [], links: [] };
  const entries = (await readdir(at, { withFileTypes: true })).sort((a, b) => byteOrder(a.name, b.name));
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const inner = await treeEntries(root, options, child);
      found.folders.push(child, ...inner.folders);
      found.files.push(...inner.files);
      found.links.push(...inner.links);
      continue;
    }
    if (entry.isFile()) {
      found.files.push(child);
      continue;
    }
    const own = entry.isSymbolicLink() && options.links ? await ownLink(root, child) : null;
    if (!own) throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.TreeNotRegular(child));
    found.links.push(own);
  }
  return found;
}

/**
 * The digest of everything under `root`: each regular file's path, size, executable bit and
 * sha256. Folders count only through the files in them. A link or a special file anywhere refuses
 * the tree (`ToolchainProblem.Integrity`): a pinned tree is never read through one. With `links`,
 * the tree's own relative links ({@link treeEntries}) count too, each by its path and target after
 * the files, so a tree without links digests exactly as before.
 */
export async function treeDigest(root: string, options: { links?: boolean } = {}): Promise<TreeDigest> {
  const outer = createHash("sha256");
  let bytes = 0;
  const { files, links } = await treeEntries(root, options);
  for (const rel of files) {
    const file = await regularFileSha256(path.join(root, ...rel.split("/")));
    if (!file) throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.TreeNotRegular(rel));
    const executable = process.platform !== StudioPlatform.Windows && (file.mode & EXECUTABLE_BITS) !== 0;
    outer.update(`${rel}\0${file.size}\0${executable ? "x" : "-"}\0${file.sha256}\n`);
    bytes += file.size;
  }
  for (const link of links) outer.update(`${link.rel}\0link\0${link.target}\n`);
  return { sha256: outer.digest("hex"), files: files.length, bytes };
}
