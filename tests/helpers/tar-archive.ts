/**
 * Hand-built `.tar.gz` archives for the store's hostile-archive tables: ustar headers with a
 * correct checksum, so a climbing name, an absolute name, a symlink, a hard link or an oversized
 * file reaches the store's checks exactly as written.
 */
import { gzipSync } from "node:zlib";

const BLOCK = 512;

/** One archive entry: a file with its bytes, a folder (name ends in `/`), or a symlink or hard link. */
export type TarEntry = { name: string; data?: Buffer | string; link?: string; hard?: string };

const octal = (value: number, digits: number) => `${value.toString(8).padStart(digits, "0")}\0`;

/** One ustar header with a correct checksum. */
export function tarHeader(name: string, type: string, size: number, linkname = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(type === "5" ? 0o755 : 0o644, 7), 100, "latin1");
  block.write(octal(0, 7), 108, "latin1");
  block.write(octal(0, 7), 116, "latin1");
  block.write(octal(size, 11), 124, "latin1");
  block.write(octal(0, 11), 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(type, 156, "latin1");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

/** `entries` as a `.tar.gz`. */
export function tarGz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.link !== undefined) parts.push(tarHeader(entry.name, "2", 0, entry.link));
    else if (entry.hard !== undefined) parts.push(tarHeader(entry.name, "1", 0, entry.hard));
    else if (entry.name.endsWith("/")) parts.push(tarHeader(entry.name, "5", 0));
    else {
      const data = Buffer.from(entry.data ?? "");
      const rest = data.length % BLOCK;
      parts.push(tarHeader(entry.name, "0", data.length), data, Buffer.alloc(rest === 0 ? 0 : BLOCK - rest));
    }
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]));
}
