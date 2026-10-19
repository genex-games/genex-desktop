/**
 * Whether an embedded PNG decodes, read the way the runtime's decoder reads it: every chunk's
 * CRC, the header, the deflate stream with its Adler-32, the size of the pixels it holds and each
 * row's filter. The Khronos validator reads only an image's header, so without this a damaged
 * image passes the import gate and the runtime refuses it `texture-invalid` (`validate.ts`
 * reports it as a warning on the image). Nothing is unfiltered or kept: the pixels are inflated
 * to a bounded buffer, checked and dropped.
 */
import { crc32, inflateSync } from "node:zlib";

/** The PNG signature. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** A chunk's length, type and CRC fields, in bytes. */
const CHUNK_OVERHEAD = 12;
/** The IHDR chunk's data length. */
const IHDR_LENGTH = 13;
/** The largest filter type a scanline may name (Paeth). */
const MAX_FILTER = 4;
/**
 * The most pixel bytes the check inflates: an 8192 x 8192 RGBA8 image and its row filter bytes.
 * A larger image is not checked here (the texture limits refuse it later).
 */
const INFLATE_MAX_BYTES = 8192 * (1 + 8192 * 4);
/** Adam7's passes: column start, row start, column step, row step. */
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
/** The bit depths each colour type allows, and its channel count. */
const COLOUR_TYPES: Readonly<Record<number, { channels: number; depths: readonly number[] }>> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

/** What the header says about the pixels. */
interface PngHeader {
  width: number;
  height: number;
  bitsPerPixel: number;
  interlaced: boolean;
}

/** Whether `bytes` start with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((byte, at) => bytes[at] === byte);
}

/** Whether the PNG `bytes` decodes: false for any damage the runtime's decoder would refuse. */
export function pngDecodes(bytes: Uint8Array): boolean {
  const chunks = readChunks(bytes);
  if (!chunks || chunks[0]?.type !== "IHDR" || chunks.at(-1)?.type !== "IEND") return false;
  const header = readHeader(chunks[0].data);
  const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  if (!header || !idat.length) return false;
  const expected = pixelBytes(header);
  if (expected > INFLATE_MAX_BYTES) return true;
  let pixels: Uint8Array;
  try {
    pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return false;
  }
  return pixels.length === expected && filtersValid(pixels, header);
}

/** The chunks after the signature, each CRC-checked; null for damage. */
function readChunks(bytes: Uint8Array): Array<{ type: string; data: Uint8Array }> | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  let at = SIGNATURE.length;
  while (at < bytes.length) {
    if (at + CHUNK_OVERHEAD > bytes.length) return null;
    const length = view.getUint32(at);
    const end = at + 8 + length;
    if (end + 4 > bytes.length) return null;
    if (crc32(bytes.subarray(at + 4, end)) !== view.getUint32(end)) return null;
    chunks.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), data: bytes.subarray(at + 8, end) });
    at = end + 4;
  }
  return chunks;
}

/** The header's facts; null for a header the format does not allow. */
function readHeader(data: Uint8Array): PngHeader | null {
  if (data.length !== IHDR_LENGTH) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [width, height] = [view.getUint32(0), view.getUint32(4)];
  const [depth = 0, colour = -1, compression, filter, interlace = -1] = data.subarray(8);
  const type = COLOUR_TYPES[colour];
  const known = type?.depths.includes(depth) && compression === 0 && filter === 0 && interlace <= 1;
  if (!type || !known || width === 0 || height === 0) return null;
  return { width, height, bitsPerPixel: type.channels * depth, interlaced: interlace === 1 };
}

/** One row's bytes after its filter byte. */
const rowBytes = (width: number, bitsPerPixel: number) => Math.ceil((width * bitsPerPixel) / 8);

/** The (width, height) of each image the pixels hold: the whole one, or Adam7's non-empty passes. */
function passes(header: PngHeader): Array<[number, number]> {
  if (!header.interlaced) return [[header.width, header.height]];
  return ADAM7.map(([x, y, dx, dy]): [number, number] => [
    Math.ceil(Math.max(0, header.width - x) / dx),
    Math.ceil(Math.max(0, header.height - y) / dy),
  ]).filter(([width, height]) => width > 0 && height > 0);
}

/** The inflated size the header promises: each row's filter byte and its bytes. */
function pixelBytes(header: PngHeader): number {
  return passes(header).reduce((sum, [width, height]) => sum + height * (1 + rowBytes(width, header.bitsPerPixel)), 0);
}

/** Whether every row names a filter that exists. */
function filtersValid(pixels: Uint8Array, header: PngHeader): boolean {
  let at = 0;
  for (const [width, height] of passes(header)) {
    const stride = 1 + rowBytes(width, header.bitsPerPixel);
    for (let row = 0; row < height; row++, at += stride) if ((pixels[at] ?? 0) > MAX_FILTER) return false;
  }
  return true;
}
