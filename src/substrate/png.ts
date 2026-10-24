/**
 * PNG pictures read and written with node:zlib alone, for the plugins that judge a capture: 8-bit
 * (or 16-bit, read at 8) grey, grey with alpha, RGB, RGBA and palette images, not interlaced. A
 * picture is decoded whole or not at all, and one larger than {@link MAX_PIXELS} is refused before
 * it is inflated.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** A decoded image: 8-bit RGB samples row by row, three per pixel. */
export type RgbImage = { width: number; height: number; rgb: Uint8Array };

/** The largest image decoded: a 4K capture is about 8.3 million pixels. */
const MAX_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per chunk header (length + type) and trailer (CRC). */
const CHUNK_HEAD = 8;
const CHUNK_CRC = 4;
/** PNG colour types, by their number in IHDR. */
const ColorType = { Grey: 0, Rgb: 2, Palette: 3, GreyAlpha: 4, Rgba: 6 } as const;
type ColorType = (typeof ColorType)[keyof typeof ColorType];
const CHANNELS: Record<ColorType, number> = {
  [ColorType.Grey]: 1,
  [ColorType.Rgb]: 3,
  [ColorType.Palette]: 1,
  [ColorType.GreyAlpha]: 2,
  [ColorType.Rgba]: 4,
};

const MESSAGE = {
  NotPng: "The file is not a PNG.",
  Truncated: "The PNG is cut short.",
  NoHeader: "The PNG has no header.",
  Unsupported: (what: string) => `This PNG is not one the bridge reads: ${what}.`,
  TooLarge: "The PNG is too large to read.",
  BadFilter: (filter: number) => `The PNG has an unknown row filter ${filter}.`,
  NoPalette: "The palette PNG has no palette.",
} as const;

type Header = { width: number; height: number; depth: number; colorType: ColorType };

function isColorType(value: number): value is ColorType {
  return (Object.values(ColorType) as number[]).includes(value);
}

/** The IHDR fields this decoder reads, or an error naming what it can't. */
function readHeader(data: Buffer): Header {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const [depth = 0, colorType = 0, , , interlace = 0] = data.subarray(8, 13);
  if (!isColorType(colorType)) throw new Error(MESSAGE.Unsupported(`colour type ${colorType}`));
  if (interlace !== 0) throw new Error(MESSAGE.Unsupported("interlaced"));
  const depthOk = depth === 8 || (depth === 16 && colorType !== ColorType.Palette);
  if (!depthOk) throw new Error(MESSAGE.Unsupported(`${depth}-bit samples`));
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(MESSAGE.TooLarge);
  return { width, height, depth, colorType };
}

type Chunks = { header: Header; palette: Buffer | undefined; data: Buffer };
type Chunk = { type: string; body: Buffer; next: number };

/** The chunk starting at `at`, and where the next one starts. */
function chunkAt(file: Buffer, at: number): Chunk {
  if (at + CHUNK_HEAD > file.length) throw new Error(MESSAGE.Truncated);
  const length = file.readUInt32BE(at);
  const end = at + CHUNK_HEAD + length;
  if (end + CHUNK_CRC > file.length) throw new Error(MESSAGE.Truncated);
  return {
    type: file.toString("latin1", at + 4, at + CHUNK_HEAD),
    body: file.subarray(at + CHUNK_HEAD, end),
    next: end + CHUNK_CRC,
  };
}

/** The PNG's header, palette and joined image data. */
function readChunks(png: Uint8Array): Chunks {
  const file = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const signed = file.length >= PNG_SIGNATURE.length && file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  if (!signed) throw new Error(MESSAGE.NotPng);
  let header: Header | undefined;
  let palette: Buffer | undefined;
  const data: Buffer[] = [];
  for (let chunk = chunkAt(file, PNG_SIGNATURE.length); chunk.type !== "IEND"; chunk = chunkAt(file, chunk.next)) {
    if (chunk.type === "IHDR") header = readHeader(chunk.body);
    else if (chunk.type === "PLTE") palette = chunk.body;
    else if (chunk.type === "IDAT") data.push(chunk.body);
  }
  if (!header) throw new Error(MESSAGE.NoHeader);
  if (data.length === 0) throw new Error(MESSAGE.Truncated);
  return { header, palette, data: Buffer.concat(data) };
}

/** The predictor a row filter adds back to a sample. */
function predicted(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      if (pa <= pb && pa <= pc) return left;
      return pb <= pc ? up : upLeft;
    }
    default:
      throw new Error(MESSAGE.BadFilter(filter));
  }
}

/** Undoes one row's filter in place: `out` holds the rows above it already undone. */
function unfilterRow(raw: Buffer, out: Uint8Array, y: number, stride: number, bytesPerPixel: number): void {
  const filter = raw[y * (stride + 1)] ?? 0;
  const row = y * stride;
  for (let x = 0; x < stride; x++) {
    const hasLeft = x >= bytesPerPixel;
    const left = hasLeft ? (out[row + x - bytesPerPixel] ?? 0) : 0;
    const up = y > 0 ? (out[row - stride + x] ?? 0) : 0;
    const upLeft = hasLeft && y > 0 ? (out[row - stride + x - bytesPerPixel] ?? 0) : 0;
    out[row + x] = ((raw[y * (stride + 1) + 1 + x] ?? 0) + predicted(filter, left, up, upLeft)) & 0xff;
  }
}

/** The image's samples with every row's filter undone. */
function unfilter(raw: Buffer, height: number, stride: number, bytesPerPixel: number): Uint8Array {
  if (raw.length < height * (stride + 1)) throw new Error(MESSAGE.Truncated);
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) unfilterRow(raw, out, y, stride, bytesPerPixel);
  return out;
}

/** The RGB of one pixel of unfiltered samples. */
function pixelRgb(samples: Uint8Array, index: number, chunks: Chunks): [number, number, number] {
  const { colorType, depth } = chunks.header;
  const step = depth / 8;
  const at = index * CHANNELS[colorType] * step;
  const sample = (channel: number) => samples[at + channel * step] ?? 0;
  if (colorType === ColorType.Palette) {
    const entry = (samples[index] ?? 0) * 3;
    const palette = chunks.palette;
    if (!palette) throw new Error(MESSAGE.NoPalette);
    return [palette[entry] ?? 0, palette[entry + 1] ?? 0, palette[entry + 2] ?? 0];
  }
  if (colorType === ColorType.Grey || colorType === ColorType.GreyAlpha) return [sample(0), sample(0), sample(0)];
  return [sample(0), sample(1), sample(2)];
}

/** Decodes a PNG (see the module notes); throws for anything it can't read, never answers a partial picture. */
export function decodePng(png: Uint8Array): RgbImage {
  const chunks = readChunks(png);
  const { width, height, depth, colorType } = chunks.header;
  const bytesPerPixel = Math.max(1, (CHANNELS[colorType] * depth) / 8);
  const stride = width * bytesPerPixel;
  const raw = inflateSync(chunks.data, { maxOutputLength: height * (stride + 1) });
  const samples = unfilter(raw, height, stride, bytesPerPixel);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(pixelRgb(samples, i, chunks), i * 3);
  return { width, height, rgb };
}

/** CRC-32 of a chunk's type and data, as PNG requires. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(CHUNK_CRC);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGB PNG of the image, rows unfiltered. */
export function encodePng(image: RgbImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, ColorType.Rgb, 0, 0, 0], 8);
  const stride = image.width * 3;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++)
    raw.set(image.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
