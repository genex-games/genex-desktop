/**
 * Small zip archives written by hand, for the native installer's tests: stored (or deflated)
 * files, folders and links with any name, including the hostile ones a real tool would refuse to
 * write (`../x`, `/etc/x`, a link out of the archive), and the ZIP64 end records a large game has.
 */
import { deflateRawSync } from "node:zlib";

/** One entry to write. */
export interface ZipItem {
  name: string;
  /** A file's bytes (a string as UTF-8); omitted for a folder. */
  data?: string | Uint8Array;
  /** A link's target: the entry is a unix link. */
  link?: string;
  /** A unix mode to store instead (a device, a pipe). */
  mode?: number;
  /** Deflate the data instead of storing it. */
  deflate?: boolean;
}

const UNIX_FILE = 0o100644;
const UNIX_EXECUTABLE = 0o100755;
const UNIX_DIRECTORY = 0o040755;
const UNIX_LINK = 0o120777;
const MADE_BY_UNIX = (3 << 8) | 63;

/** The CRC-32 of `bytes`, as zip stores it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const bytesOf = (data: string | Uint8Array | undefined): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data ?? new Uint8Array());

/** A zip of `items`, in order; `zip64` writes the ZIP64 end records with the 32-bit fields full. */
export function writeZip(items: readonly ZipItem[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, "utf8");
    const folder = item.data === undefined && item.link === undefined;
    const raw = item.link !== undefined ? Buffer.from(item.link, "utf8") : bytesOf(item.data);
    const packed = item.deflate ? deflateRawSync(raw) : raw;
    const method = item.deflate ? 8 : 0;
    const crc = crc32(raw);
    const kind = item.link !== undefined ? UNIX_LINK : folder ? UNIX_DIRECTORY : UNIX_FILE;
    const mode = item.mode ?? (item.name.endsWith(".exe") || item.name.includes("/MacOS/") ? UNIX_EXECUTABLE : kind);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const extra = options.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (options.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(packed.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(options.zip64 ? 45 : 20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(options.zip64 ? 0xffffffff : packed.length, 20);
    central.writeUInt32LE(options.zip64 ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(items.length), 24);
    record.writeBigUInt64LE(BigInt(items.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.zip64 ? 0xffff : items.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : items.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, end]);
}
