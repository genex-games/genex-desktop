import { mkdir, open, readdir, lstat, type FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import path from "node:path";
import { assertRelativePath } from "../paths.ts";

const END_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const MAX_COMMENT_BYTES = 65535;
const MAX_CENTRAL_BYTES = 32 * 1024 ** 2;
const ZIP_SIGNATURE = { End: 0x06054b50, Central: 0x02014b50, Local: 0x04034b50 } as const;
const ZIP_METHOD = { Stored: 0, Deflate: 8 } as const;
const UNIX_TYPE = { Regular: 0o100000, Directory: 0o040000 } as const;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i;
const MESSAGE = {
  Unsafe: "Unsafe or unsupported runtime ZIP archive",
  Corrupt: "Corrupt runtime ZIP archive",
} as const;

interface ZipEntry {
  name: string;
  nameBytes: Buffer;
  directory: boolean;
  method: number;
  flags: number;
  crc: number;
  bytes: number;
  compressedBytes: number;
  offset: number;
  dataOffset: number;
}

/** An exact bounded archive read; a truncated header is never silently accepted. */
async function readBytes(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let completed = 0;
  while (completed < length) {
    const result = await file.read(buffer, completed, length - completed, position + completed);
    if (!result.bytesRead) throw new Error(MESSAGE.Corrupt);
    completed += result.bytesRead;
  }
  return buffer;
}

/** Refuse traversal, Windows aliases, streams, device names and names that normalize differently. */
function safeName(bytes: Buffer): { name: string; directory: boolean } {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(MESSAGE.Unsafe);
  }
  const directory = raw.endsWith("/");
  const name = directory ? raw.slice(0, -1) : raw;
  try {
    assertRelativePath(name);
  } catch {
    throw new Error(MESSAGE.Unsafe);
  }
  const unsafe = name
    .split("/")
    .some((part) => /[:*?"<>|]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED_NAME.test(part));
  if (unsafe) throw new Error(MESSAGE.Unsafe);
  return { name, directory };
}

/** Read classic ZIP's single-disk central directory; ZIP64 and unknown encodings fail closed. */
async function centralDirectory(file: FileHandle): Promise<{ buffer: Buffer; count: number; offset: number }> {
  const size = (await file.stat()).size;
  if (size < END_BYTES) throw new Error(MESSAGE.Corrupt);
  const tail = await readBytes(
    file,
    Math.max(0, size - END_BYTES - MAX_COMMENT_BYTES),
    Math.min(size, END_BYTES + MAX_COMMENT_BYTES),
  );
  let index = tail.length - END_BYTES;
  while (index >= 0) {
    if (
      tail.readUInt32LE(index) === ZIP_SIGNATURE.End &&
      index + END_BYTES + tail.readUInt16LE(index + 20) === tail.length
    )
      break;
    index--;
  }
  if (index < 0) throw new Error(MESSAGE.Corrupt);
  const end = tail.subarray(index);
  const count = end.readUInt16LE(10),
    bytes = end.readUInt32LE(12),
    offset = end.readUInt32LE(16);
  const singleDisk = end.readUInt16LE(4) === 0 && end.readUInt16LE(6) === 0 && end.readUInt16LE(8) === count;
  const valid =
    singleDisk &&
    count > 0 &&
    count < 65535 &&
    bytes <= MAX_CENTRAL_BYTES &&
    offset + bytes === size - tail.length + index;
  if (!valid) throw new Error(MESSAGE.Unsafe);
  return { buffer: await readBytes(file, offset, bytes), count, offset };
}

/** One central record, bounded before accessing its variable fields. */
function centralEntry(buffer: Buffer, cursor: number): { entry: ZipEntry; next: number } {
  if (cursor + CENTRAL_BYTES > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_SIGNATURE.Central)
    throw new Error(MESSAGE.Corrupt);
  const header = buffer.subarray(cursor, cursor + CENTRAL_BYTES);
  const flags = header.readUInt16LE(8),
    method = header.readUInt16LE(10),
    nameLength = header.readUInt16LE(28);
  const next = cursor + CENTRAL_BYTES + nameLength + header.readUInt16LE(30) + header.readUInt16LE(32);
  if (next > buffer.length || flags & ~0x080e || flags & 1 || header.readUInt16LE(34)) throw new Error(MESSAGE.Unsafe);
  if (method !== ZIP_METHOD.Stored && method !== ZIP_METHOD.Deflate) throw new Error(MESSAGE.Unsafe);
  const nameBytes = buffer.subarray(cursor + CENTRAL_BYTES, cursor + CENTRAL_BYTES + nameLength);
  const named = safeName(nameBytes),
    unixType = (header.readUInt32LE(38) >>> 16) & 0o170000;
  const knownType = unixType === 0 || unixType === UNIX_TYPE.Regular || unixType === UNIX_TYPE.Directory;
  if (!knownType || (unixType === UNIX_TYPE.Directory && !named.directory)) throw new Error(MESSAGE.Unsafe);
  const entry: ZipEntry = {
    ...named,
    nameBytes,
    flags,
    method,
    crc: header.readUInt32LE(16),
    compressedBytes: header.readUInt32LE(20),
    bytes: header.readUInt32LE(24),
    offset: header.readUInt32LE(42),
    dataOffset: 0,
  };
  if (entry.directory && entry.bytes) throw new Error(MESSAGE.Unsafe);
  return { entry, next };
}

/** Validate the complete extraction plan before creating files, including case-insensitive collisions. */
function planEntries(buffer: Buffer, count: number, maxBytes: number): ZipEntry[] {
  const entries: ZipEntry[] = [],
    names = new Map<string, boolean>();
  let cursor = 0,
    total = 0;
  for (let index = 0; index < count; index++) {
    const parsed = centralEntry(buffer, cursor),
      entry = parsed.entry;
    cursor = parsed.next;
    const key = entry.name.normalize("NFC").toLowerCase();
    if (names.has(key)) throw new Error(MESSAGE.Unsafe);
    names.set(key, entry.directory);
    total += entry.bytes;
    if (total > maxBytes) throw new Error(MESSAGE.Unsafe);
    entries.push(entry);
  }
  if (cursor !== buffer.length) throw new Error(MESSAGE.Corrupt);
  for (const entry of entries) {
    const segments = entry.name.normalize("NFC").toLowerCase().split("/");
    for (let i = 1; i < segments.length; i++)
      if (names.get(segments.slice(0, i).join("/")) === false) throw new Error(MESSAGE.Unsafe);
  }
  return entries;
}

/** Match local metadata to the central record before any extraction, and bound every data range. */
async function validateLocal(file: FileHandle, entry: ZipEntry, centralOffset: number): Promise<void> {
  if (entry.offset + LOCAL_BYTES > centralOffset) throw new Error(MESSAGE.Corrupt);
  const local = await readBytes(file, entry.offset, LOCAL_BYTES);
  const matching =
    local.readUInt32LE(0) === ZIP_SIGNATURE.Local &&
    local.readUInt16LE(6) === entry.flags &&
    local.readUInt16LE(8) === entry.method;
  if (!matching) throw new Error(MESSAGE.Corrupt);
  const nameLength = local.readUInt16LE(26),
    extraLength = local.readUInt16LE(28);
  entry.dataOffset = entry.offset + LOCAL_BYTES + nameLength + extraLength;
  if (entry.dataOffset + entry.compressedBytes > centralOffset) throw new Error(MESSAGE.Corrupt);
  const name = await readBytes(file, entry.offset + LOCAL_BYTES, nameLength);
  if (!name.equals(entry.nameBytes)) throw new Error(MESSAGE.Corrupt);
}

/** Stream one member with an independent size cap and checksum; never materialize an archive in memory. */
async function extractMember(file: FileHandle, entry: ZipEntry, stage: string, signal: AbortSignal): Promise<void> {
  const destination = path.join(stage, entry.name);
  if (entry.directory) {
    await mkdir(destination, { recursive: true });
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  let bytes = 0,
    checksum = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > entry.bytes) {
        done(new Error(MESSAGE.Corrupt));
        return;
      }
      checksum = crc32(chunk, checksum);
      done(null, chunk);
    },
  });
  if (entry.compressedBytes) {
    const input = createReadStream("", {
      fd: file.fd,
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedBytes - 1,
      autoClose: false,
    });
    const writable = createWriteStream(destination, { flags: "wx", mode: 0o644 });
    if (entry.method === ZIP_METHOD.Deflate) await pipeline(input, createInflateRaw(), verify, writable, { signal });
    else await pipeline(input, verify, writable, { signal });
  } else {
    await (await open(destination, "wx", 0o644)).close();
  }
  if (bytes !== entry.bytes || checksum !== entry.crc) throw new Error(MESSAGE.Corrupt);
}

/** Extract a verified portable runtime into fresh staging after validating every archive path and header. */
export async function extractRuntimeZip(
  archive: string,
  stage: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(MESSAGE.Unsafe);
  const stageInfo = await lstat(stage);
  if (!stageInfo.isDirectory() || (await readdir(stage)).length) throw new Error(MESSAGE.Unsafe);
  const file = await open(archive, "r");
  try {
    const central = await centralDirectory(file),
      entries = planEntries(central.buffer, central.count, maxBytes);
    for (const entry of entries) {
      signal.throwIfAborted();
      await validateLocal(file, entry, central.offset);
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      await extractMember(file, entry, stage, signal);
    }
  } finally {
    await file.close();
  }
}
