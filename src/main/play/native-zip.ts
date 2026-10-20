/**
 * What a native build's zip holds, read from its central directory before anything is unpacked: each
 * entry's name, size and kind, and where a link points. The archive is hostile input; an entry that
 * would land outside the game, a link that points out of it or a file written through a link is
 * refused here, so `ditto` only ever unpacks an archive already found sound. ZIP64 is read: a game
 * may be larger than 4 GiB.
 */
import { open } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/** The signatures and sizes of the records read, as the ZIP format names them. */
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const ZIP64_EXTRA = 0x0001;
/** A 16- or 32-bit field that says "see the ZIP64 record". */
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** The most the end record's comment may run to. */
const COMMENT_MAX = 0xffff;
/** Entries unpacked with no compression, or deflated: the two methods ditto reads. */
const STORED = 0;
const DEFLATED = 8;
/** The unix file kind in an entry's external attributes, and the two kinds that matter. */
const KIND_MASK = 0o170000;
const KIND_LINK = 0o120000;
const KIND_DIRECTORY = 0o040000;
const KIND_FILE = 0o100000;
/** Unix attributes live in the upper 16 bits when the entry was made on unix. */
const MADE_ON_UNIX = 3;
/** The longest link target the app reads. */
const LINK_MAX = 4096;
/** The most entries one archive may have. */
export const ZIP_ENTRIES_MAX = 500_000;

/** Why an archive is refused. */
export const ZipRefusal = {
  /** Not a zip the app can read: no end record, a broken directory, an unknown method. */
  Unreadable: "unreadable",
  /** An entry or a link that would land outside the archive's folder. */
  Unsafe: "unsafe",
  /** More entries or more unpacked bytes than allowed. */
  TooLarge: "too-large",
} as const;
export type ZipRefusal = (typeof ZipRefusal)[keyof typeof ZipRefusal];

/** A refused archive and why. */
export class ZipError extends Error {
  readonly refusal: ZipRefusal;
  constructor(refusal: ZipRefusal, detail: string) {
    super(`Refused archive (${refusal}): ${detail}`);
    this.refusal = refusal;
  }
}

/** The kind of thing an entry unpacks to. */
export const ZipEntryKind = { File: "file", Directory: "directory", Link: "link" } as const;
export type ZipEntryKind = (typeof ZipEntryKind)[keyof typeof ZipEntryKind];

/** One entry of the central directory. */
export interface ZipEntry {
  /** Its path in the archive, `/`-separated, without a trailing slash. */
  name: string;
  kind: ZipEntryKind;
  /** Its unpacked size. */
  size: number;
  /** For a link, where it points as stored; otherwise null. */
  target: string | null;
}

/** What the central directory says about an archive. */
export interface ZipListing {
  entries: ZipEntry[];
  /** Every entry's unpacked size together. */
  unpackedBytes: number;
}

/** One central directory record, before its link target is read. */
interface CentralRecord {
  name: string;
  kind: ZipEntryKind;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const unreadable = (detail: string) => new ZipError(ZipRefusal.Unreadable, detail);
const unsafe = (detail: string) => new ZipError(ZipRefusal.Unsafe, detail);

/** Read `length` bytes at `position`, all of them, or throw. */
async function readAt(file: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw unreadable("truncated");
  return buffer;
}

/** Where the central directory starts and how many entries it has, from the end records. */
async function directoryOf(
  file: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<{ offset: number; count: number }> {
  const tail = Math.min(size, EOCD_SIZE + COMMENT_MAX);
  const end = await readAt(file, size - tail, tail);
  let at = end.length - EOCD_SIZE;
  while (at >= 0 && end.readUInt32LE(at) !== EOCD_SIGNATURE) at--;
  if (at < 0) throw unreadable("no end of central directory");
  const count = end.readUInt16LE(at + 10);
  const offset = end.readUInt32LE(at + 16);
  if (count !== MAX16 && offset !== MAX32) return { offset, count };
  const locatorAt = size - tail + at - ZIP64_LOCATOR_SIZE;
  if (locatorAt < 0) throw unreadable("no ZIP64 locator");
  const locator = await readAt(file, locatorAt, ZIP64_LOCATOR_SIZE);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) throw unreadable("no ZIP64 locator");
  const record = await readAt(file, Number(locator.readBigUInt64LE(8)), 56);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw unreadable("no ZIP64 end record");
  return { offset: Number(record.readBigUInt64LE(48)), count: Number(record.readBigUInt64LE(32)) };
}

/** The ZIP64 values an entry's extra field carries for each 32-bit field that is full. */
function zip64Values(extra: Buffer, wanted: { size: boolean; compressed: boolean; offset: boolean }) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === ZIP64_EXTRA) {
      let field = at + 4;
      const next = () => {
        if (field + 8 > at + 4 + length) throw unreadable("short ZIP64 field");
        const value = Number(extra.readBigUInt64LE(field));
        field += 8;
        return value;
      };
      const size = wanted.size ? next() : undefined;
      const compressed = wanted.compressed ? next() : undefined;
      const offset = wanted.offset ? next() : undefined;
      return { size, compressed, offset };
    }
    at += 4 + length;
  }
  throw unreadable("missing ZIP64 field");
}

/** The kind an entry unpacks to, from its unix mode (else its trailing slash). */
function kindOf(name: string, madeBy: number, external: number): ZipEntryKind {
  const mode = madeBy >> 8 === MADE_ON_UNIX ? (external >>> 16) & KIND_MASK : 0;
  if (mode === KIND_LINK) return ZipEntryKind.Link;
  if (mode === KIND_DIRECTORY || name.endsWith("/")) return ZipEntryKind.Directory;
  if (mode === 0 || mode === KIND_FILE) return ZipEntryKind.File;
  // A device, a pipe or a socket has no place in a game.
  throw unsafe(`special file ${JSON.stringify(name)}`);
}

/** One central record at `at` in `directory`, and where the next one starts. */
function centralRecord(directory: Buffer, at: number): { record: CentralRecord; next: number } {
  if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw unreadable("broken central directory");
  const madeBy = directory.readUInt16LE(at + 4);
  const method = directory.readUInt16LE(at + 10);
  let compressedSize = directory.readUInt32LE(at + 20);
  let size = directory.readUInt32LE(at + 24);
  const nameLength = directory.readUInt16LE(at + 28);
  const extraLength = directory.readUInt16LE(at + 30);
  const commentLength = directory.readUInt16LE(at + 32);
  const external = directory.readUInt32LE(at + 38);
  let localOffset = directory.readUInt32LE(at + 42);
  const nameStart = at + CENTRAL_SIZE;
  const raw = directory.subarray(nameStart, nameStart + nameLength).toString("utf8");
  const extra = directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
  const wanted = { size: size === MAX32, compressed: compressedSize === MAX32, offset: localOffset === MAX32 };
  if (wanted.size || wanted.compressed || wanted.offset) {
    const values = zip64Values(extra, wanted);
    size = values.size ?? size;
    compressedSize = values.compressed ?? compressedSize;
    localOffset = values.offset ?? localOffset;
  }
  if (method !== STORED && method !== DEFLATED) throw unreadable(`method ${method}`);
  const kind = kindOf(raw, madeBy, external);
  const name = raw.replace(/\/+$/, "");
  return {
    record: { name, kind, method, compressedSize, size, localOffset },
    next: nameStart + nameLength + extraLength + commentLength,
  };
}

/**
 * Whether `name` stays inside the archive's folder, spelled plainly: `/`-separated, not absolute,
 * no drive, backslash or control character, and no empty, `.` or `..` part.
 */
export function isPlainZipName(name: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (!name || name.startsWith("/") || /[\0-\x1f\x7f\\]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Where a link at `name` pointing to `target` lands, inside the archive's folder or null. */
function linkLands(name: string, target: string): string | null {
  if (!target || target.startsWith("/") || target.includes("\\")) return null;
  const landed = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
  return landed === ".." || landed.startsWith("../") ? null : landed;
}

/** The target a link entry stores: its data, inflated when it was deflated. */
async function linkTarget(file: Awaited<ReturnType<typeof open>>, record: CentralRecord): Promise<string> {
  if (record.compressedSize > LINK_MAX || record.size > LINK_MAX) throw unsafe(`long link ${record.name}`);
  const header = await readAt(file, record.localOffset, LOCAL_SIZE);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw unreadable("broken local header");
  const dataAt = record.localOffset + LOCAL_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = await readAt(file, dataAt, record.compressedSize);
  const bytes = record.method === DEFLATED ? inflateRawSync(data, { maxOutputLength: LINK_MAX }) : data;
  return bytes.toString("utf8");
}

/** Refuse an entry written through a link: `a/b` when `a` is a link. */
function refuseWritesThroughLinks(entries: readonly ZipEntry[]): void {
  const links = new Set(entries.filter((entry) => entry.kind === ZipEntryKind.Link).map((entry) => entry.name));
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      if (links.has(parts.slice(0, depth).join("/"))) throw unsafe(`${entry.name} is inside a link`);
    }
  }
}

/**
 * The entries of the zip at `archive`, each checked: a plain name inside the archive, a link only
 * to somewhere inside it, nothing written through a link, at most {@link ZIP_ENTRIES_MAX} entries
 * and `maxUnpackedBytes` unpacked. Throws {@link ZipError} for anything else.
 */
export async function listZip(archive: string, maxUnpackedBytes: number): Promise<ZipListing> {
  const file = await open(archive, "r");
  try {
    const { size } = await file.stat();
    if (size < EOCD_SIZE) throw unreadable("too short");
    const { offset, count } = await directoryOf(file, size);
    if (count > ZIP_ENTRIES_MAX) throw new ZipError(ZipRefusal.TooLarge, `${count} entries`);
    if (offset >= size) throw unreadable("directory past the end");
    const directory = await readAt(file, offset, size - offset);
    const entries: ZipEntry[] = [];
    let unpackedBytes = 0;
    let at = 0;
    for (let index = 0; index < count; index++) {
      const { record, next } = centralRecord(directory, at);
      at = next;
      if (!isPlainZipName(record.name)) throw unsafe(`entry ${JSON.stringify(record.name)}`);
      unpackedBytes += record.size;
      if (unpackedBytes > maxUnpackedBytes) throw new ZipError(ZipRefusal.TooLarge, `${unpackedBytes} bytes`);
      const target = record.kind === ZipEntryKind.Link ? await linkTarget(file, record) : null;
      if (target !== null && linkLands(record.name, target) === null) throw unsafe(`link ${record.name} -> ${target}`);
      entries.push({ name: record.name, kind: record.kind, size: record.size, target });
    }
    refuseWritesThroughLinks(entries);
    return { entries, unpackedBytes };
  } finally {
    await file.close();
  }
}
