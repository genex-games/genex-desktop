/**
 * The cover picture an agent hands genex__cover, read the way Studio needs it before keeping it:
 * its type by its bytes (PNG or JPEG, what Genex takes), its size, and its exposure, the numbers
 * Genex's dark and flat gate reads (`StillExposure`). A PNG is decoded whole (`substrate/png.ts`).
 * A JPEG's exposure comes from the mean light of its 8×8 luma blocks, which their DC coefficients
 * carry, so nothing past the entropy decoding runs; that is close enough for an advisory mirror,
 * since Genex judges the picture itself. Nothing here trusts a file name or a declared type.
 */
import { NEAR_BLACK_LUMA, LUMA_THRESHOLD, exposureStats } from "../../substrate/pixel-stats.ts";
import { decodePng } from "../../substrate/png.ts";
import { StillMimeType, type StillExposure } from "../../shared/preview-contract.ts";

/** The smallest cover Genex stores without scaling it up: 1280×720. */
export const COVER_MIN_SIZE = { Width: 1280, Height: 720 } as const;
/** The most pixels a cover may have: a 4K picture is about 8.3 million. */
const COVER_MAX_PIXELS = 40_000_000;
/** How many pixels of a decoded PNG the exposure reads at most, spread evenly over it. */
const EXPOSURE_SAMPLES = 250_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** Where a PNG's IHDR keeps its width and height. */
const PNG_WIDTH_AT = 16;
const PNG_HEIGHT_AT = 20;
const PNG_HEADER_BYTES = 24;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
/** The coefficients of one 8×8 block, and the most bits one Huffman code takes. */
const BLOCK_COEFFICIENTS = 64;
const BLOCK_SIDE = 8;
const MAX_CODE_BITS = 16;
/** A JPEG sample's midpoint: a block's DC coefficient is its mean light below this, times eight. */
const SAMPLE_MIDPOINT = 128;
const SAMPLE_MAX = 255;

/** The JPEG markers the reader acts on (ITU T.81, table B.1). */
const Marker = {
  Baseline: 0xc0,
  ExtendedSequential: 0xc1,
  Progressive: 0xc2,
  HuffmanTable: 0xc4,
  FirstRestart: 0xd0,
  LastRestart: 0xd7,
  StartOfImage: 0xd8,
  EndOfImage: 0xd9,
  StartOfScan: 0xda,
  QuantizationTable: 0xdb,
  RestartInterval: 0xdd,
} as const;
/** Frame markers of the kinds Studio cannot read: lossless, hierarchical and arithmetic-coded. */
const UNREAD_FRAMES = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Why a picture cannot be the cover. Agent-facing English: the tool's refusal names it. */
export const COVER_IMAGE_MESSAGE = {
  NotPicture: "The cover must be a PNG or a JPEG; this file is neither.",
  TooSmall: (width: number, height: number) =>
    `The cover picture is ${width}×${height}: Genex needs at least ${COVER_MIN_SIZE.Width}×${COVER_MIN_SIZE.Height}.`,
  TooManyPixels: "The cover picture is too large to read: keep it at 4K or below.",
  UnreadablePng:
    "Studio could not read this PNG's pixels (it may be interlaced or damaged): save it as an ordinary PNG or a JPEG.",
  UnreadableJpeg:
    "Studio could not read this JPEG (it may be damaged, lossless or arithmetic-coded): save it as an ordinary JPEG or a PNG.",
} as const;

/** A cover picture as Studio read it. */
export interface CoverImage {
  mimeType: StillMimeType;
  width: number;
  height: number;
  stats: StillExposure;
}

/** A picture Studio cannot keep as the cover, and why. */
export interface CoverImageRefusal {
  refused: string;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

/** Read a cover picture's bytes: its type, size and exposure, or why it cannot be the cover. */
export function readCoverImage(bytes: Uint8Array): CoverImage | CoverImageRefusal {
  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes);
  if (startsWith(bytes, JPEG_SIGNATURE)) return readJpeg(bytes);
  return { refused: COVER_IMAGE_MESSAGE.NotPicture };
}

/** The refusal of a picture too small or too large, before anything is decoded; null when it fits. */
function sizeRefusal(width: number, height: number): CoverImageRefusal | null {
  if (width * height > COVER_MAX_PIXELS) return { refused: COVER_IMAGE_MESSAGE.TooManyPixels };
  if (width < COVER_MIN_SIZE.Width || height < COVER_MIN_SIZE.Height)
    return { refused: COVER_IMAGE_MESSAGE.TooSmall(width, height) };
  return null;
}

function readPng(bytes: Uint8Array): CoverImage | CoverImageRefusal {
  if (bytes.byteLength < PNG_HEADER_BYTES) return { refused: COVER_IMAGE_MESSAGE.UnreadablePng };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(PNG_WIDTH_AT);
  const height = view.getUint32(PNG_HEIGHT_AT);
  const refusal = sizeRefusal(width, height);
  if (refusal) return refusal;
  try {
    const image = decodePng(bytes);
    return { mimeType: StillMimeType.Png, width, height, stats: rgbExposure(image.rgb, width, height) };
  } catch {
    return { refused: COVER_IMAGE_MESSAGE.UnreadablePng };
  }
}

/** The exposure of RGB samples, read on an even grid of at most {@link EXPOSURE_SAMPLES} pixels. */
function rgbExposure(rgb: Uint8Array, width: number, height: number): StillExposure {
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / EXPOSURE_SAMPLES)));
  const columns = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const bgra = Buffer.alloc(columns * rows * 4);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const from = (row * step * width + column * step) * 3;
      const to = (row * columns + column) * 4;
      bgra[to] = rgb[from + 2] ?? 0;
      bgra[to + 1] = rgb[from + 1] ?? 0;
      bgra[to + 2] = rgb[from] ?? 0;
      bgra[to + 3] = SAMPLE_MAX;
    }
  return exposureStats(bgra, columns, rows);
}

function readJpeg(bytes: Uint8Array): CoverImage | CoverImageRefusal {
  try {
    const { width, height, lumas } = jpegBlockLumas(bytes);
    return sizeRefusal(width, height) ?? { mimeType: StillMimeType.Jpeg, width, height, stats: lumaExposure(lumas) };
  } catch {
    return { refused: COVER_IMAGE_MESSAGE.UnreadableJpeg };
  }
}

/** The exposure of block means (0–255), each block weighed alike, on the same terms as `exposureStats`. */
function lumaExposure(lumas: readonly number[]): StillExposure {
  if (lumas.length === 0) return { lumaMean: 0, lumaStdDev: 0, nearBlackFraction: 1, litFraction: 0 };
  let sum = 0;
  let squares = 0;
  let nearBlack = 0;
  let lit = 0;
  for (const luma of lumas) {
    const unit = luma / SAMPLE_MAX;
    sum += unit;
    squares += unit * unit;
    if (unit < NEAR_BLACK_LUMA) nearBlack++;
    if (luma > LUMA_THRESHOLD) lit++;
  }
  const lumaMean = sum / lumas.length;
  const lumaStdDev = Math.sqrt(Math.max(0, squares / lumas.length - lumaMean * lumaMean));
  return { lumaMean, lumaStdDev, nearBlackFraction: nearBlack / lumas.length, litFraction: lit / lumas.length };
}

// ── JPEG: the luma blocks' DC coefficients ─────────────────────────────────────────────────────

/** A canonical Huffman table as T.81 F.2.2.3 decodes it: per code length, its codes' range and first value. */
interface HuffmanTable {
  maxCode: Int32Array;
  minCode: Int32Array;
  firstValue: Int32Array;
  values: Uint8Array;
}

interface FrameComponent {
  id: number;
  h: number;
  v: number;
  table: number;
}

interface Frame {
  width: number;
  height: number;
  progressive: boolean;
  components: FrameComponent[];
  hMax: number;
  vMax: number;
}

/** What the reader has learned of the file so far. */
interface JpegState {
  frame?: Frame;
  quantDc: Map<number, number>;
  dcTables: Map<number, HuffmanTable>;
  acTables: Map<number, HuffmanTable>;
  restartInterval: number;
}

/** One component of a scan, with its tables. */
interface ScanComponent {
  index: number;
  dc: HuffmanTable;
  ac: HuffmanTable | undefined;
}

interface Scan {
  components: ScanComponent[];
  start: number;
  end: number;
  approximationHigh: number;
  approximationLow: number;
}

const corrupt = () => new Error("corrupt JPEG");
const byteAt = (bytes: Uint8Array, at: number) => {
  const value = bytes[at];
  if (value === undefined) throw corrupt();
  return value;
};
const wordAt = (bytes: Uint8Array, at: number) => (byteAt(bytes, at) << 8) | byteAt(bytes, at + 1);

function huffmanTable(counts: Uint8Array, values: Uint8Array): HuffmanTable {
  const maxCode = new Int32Array(MAX_CODE_BITS + 1).fill(-1);
  const minCode = new Int32Array(MAX_CODE_BITS + 1);
  const firstValue = new Int32Array(MAX_CODE_BITS + 1);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= MAX_CODE_BITS; length++) {
    const count = counts[length - 1] ?? 0;
    firstValue[length] = index;
    minCode[length] = code;
    if (count > 0) maxCode[length] = code + count - 1;
    code = (code + count) << 1;
    index += count;
  }
  return { maxCode, minCode, firstValue, values };
}

/** The bits of one entropy-coded segment: byte stuffing undone, a marker read as the end of the data. */
function bitReader(bytes: Uint8Array, start: number) {
  let at = start;
  let buffer = 0;
  let left = 0;
  const nextByte = (): number => {
    const value = bytes[at];
    if (value === undefined) return 0;
    if (value !== 0xff) {
      at++;
      return value;
    }
    if (bytes[at + 1] === 0) {
      at += 2;
      return 0xff;
    }
    return 0;
  };
  const bit = (): number => {
    if (left === 0) {
      buffer = nextByte();
      left = 8;
    }
    left--;
    return (buffer >> left) & 1;
  };
  const receive = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | bit();
    return value;
  };
  return {
    bit,
    receive,
    /** A Huffman-coded symbol. */
    decode(table: HuffmanTable): number {
      let code = bit();
      let length = 1;
      while (code > (table.maxCode[length] ?? -1)) {
        length++;
        if (length > MAX_CODE_BITS) throw corrupt();
        code = (code << 1) | bit();
      }
      const value = table.values[(table.firstValue[length] ?? 0) + code - (table.minCode[length] ?? 0)];
      if (value === undefined) throw corrupt();
      return value;
    },
    /** Past a restart marker: the bits start afresh on the next byte. */
    restart(): void {
      left = 0;
      const marker = bytes[at + 1] ?? 0;
      if (bytes[at] === 0xff && marker >= Marker.FirstRestart && marker <= Marker.LastRestart) at += 2;
    },
  };
}
type BitReader = ReturnType<typeof bitReader>;

/** A difference coded in `size` bits, signed (T.81 F.2.2.1, EXTEND). */
const extend = (value: number, size: number) => (value < 1 << (size - 1) ? value - (1 << size) + 1 : value);

/** One block's DC difference; the AC coefficients after it are read past, never kept. */
function readBlock(reader: BitReader, component: ScanComponent, dcOnly: boolean): number {
  const size = reader.decode(component.dc);
  const difference = size === 0 ? 0 : extend(reader.receive(size), size);
  if (dcOnly || !component.ac) return difference;
  for (let k = 1; k < BLOCK_COEFFICIENTS; k++) {
    const symbol = reader.decode(component.ac);
    const run = symbol >> 4;
    const bits = symbol & 0x0f;
    if (bits === 0) {
      if (run !== 15) break;
      k += 15;
      continue;
    }
    k += run;
    reader.receive(bits);
  }
  return difference;
}

/** How many blocks wide and high a component is. */
function componentBlocks(frame: Frame, component: FrameComponent) {
  return {
    across: Math.ceil(Math.ceil((frame.width * component.h) / frame.hMax) / BLOCK_SIDE),
    down: Math.ceil(Math.ceil((frame.height * component.v) / frame.vMax) / BLOCK_SIDE),
  };
}

/** The blocks of one MCU, in coding order: each scan component's, with where the block sits. */
function* mcuBlocks(frame: Frame, scan: Scan, mcu: number) {
  if (scan.components.length === 1) {
    const only = scan.components[0];
    const component = only ? frame.components[only.index] : undefined;
    if (!only || !component) throw corrupt();
    const { across } = componentBlocks(frame, component);
    yield { scan: only, column: mcu % across, row: Math.floor(mcu / across) };
    return;
  }
  const across = Math.ceil(frame.width / (BLOCK_SIDE * frame.hMax));
  const mcuColumn = mcu % across;
  const mcuRow = Math.floor(mcu / across);
  for (const scanComponent of scan.components) {
    const component = frame.components[scanComponent.index];
    if (!component) throw corrupt();
    for (let v = 0; v < component.v; v++)
      for (let h = 0; h < component.h; h++)
        yield { scan: scanComponent, column: mcuColumn * component.h + h, row: mcuRow * component.v + v };
  }
}

/** How many MCUs a scan codes. */
function mcuCount(frame: Frame, scan: Scan): number {
  const only = scan.components.length === 1 ? scan.components[0] : undefined;
  const component = only ? frame.components[only.index] : undefined;
  if (component) {
    const { across, down } = componentBlocks(frame, component);
    return across * down;
  }
  return Math.ceil(frame.width / (BLOCK_SIDE * frame.hMax)) * Math.ceil(frame.height / (BLOCK_SIDE * frame.vMax));
}

/** The luma blocks' mean light from one scan that carries the luma's DC coefficients. */
function lumaFromScan(bytes: Uint8Array, at: number, state: JpegState, frame: Frame, scan: Scan): number[] {
  const luma = frame.components[0];
  if (!luma) throw corrupt();
  const quant = state.quantDc.get(luma.table);
  if (quant === undefined) throw corrupt();
  const { across, down } = componentBlocks(frame, luma);
  const reader = bitReader(bytes, at);
  const predictions = new Map<number, number>();
  const lumas: number[] = [];
  const total = mcuCount(frame, scan);
  for (let mcu = 0; mcu < total; mcu++) {
    const restart = state.restartInterval > 0 && mcu > 0 && mcu % state.restartInterval === 0;
    if (restart) {
      reader.restart();
      predictions.clear();
    }
    for (const block of mcuBlocks(frame, scan, mcu)) {
      const prediction = (predictions.get(block.scan.index) ?? 0) + readBlock(reader, block.scan, frame.progressive);
      predictions.set(block.scan.index, prediction);
      const inside = block.column < across && block.row < down;
      if (block.scan.index !== 0 || !inside) continue;
      const dc = prediction * 2 ** scan.approximationLow * quant;
      lumas.push(Math.min(SAMPLE_MAX, Math.max(0, SAMPLE_MIDPOINT + dc / BLOCK_SIDE)));
    }
  }
  return lumas;
}

/** Whether a scan carries the luma's DC coefficients whole: baseline, or progressive's first DC scan. */
const carriesLumaDc = (frame: Frame, scan: Scan) =>
  scan.components.some((component) => component.index === 0) &&
  (!frame.progressive || (scan.start === 0 && scan.approximationHigh === 0));

function readFrame(bytes: Uint8Array, at: number, marker: number): Frame {
  if (byteAt(bytes, at) !== 8) throw corrupt();
  const height = wordAt(bytes, at + 1);
  const width = wordAt(bytes, at + 3);
  const count = byteAt(bytes, at + 5);
  const components: FrameComponent[] = [];
  for (let i = 0; i < count; i++) {
    const base = at + 6 + i * 3;
    const sampling = byteAt(bytes, base + 1);
    components.push({ id: byteAt(bytes, base), h: sampling >> 4, v: sampling & 0x0f, table: byteAt(bytes, base + 2) });
  }
  const hMax = Math.max(...components.map((c) => c.h));
  const vMax = Math.max(...components.map((c) => c.v));
  if (!components.length || !width || !height || !hMax || !vMax) throw corrupt();
  return { width, height, progressive: marker === Marker.Progressive, components, hMax, vMax };
}

function readHuffmanTables(bytes: Uint8Array, at: number, end: number, state: JpegState): void {
  let cursor = at;
  while (cursor < end) {
    const kind = byteAt(bytes, cursor);
    const counts = bytes.subarray(cursor + 1, cursor + 1 + MAX_CODE_BITS);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const valuesAt = cursor + 1 + MAX_CODE_BITS;
    const table = huffmanTable(counts, bytes.slice(valuesAt, valuesAt + total));
    (kind >> 4 === 0 ? state.dcTables : state.acTables).set(kind & 0x0f, table);
    cursor = valuesAt + total;
  }
}

function readQuantizationTables(bytes: Uint8Array, at: number, end: number, state: JpegState): void {
  let cursor = at;
  while (cursor < end) {
    const kind = byteAt(bytes, cursor);
    const wide = kind >> 4 === 1;
    state.quantDc.set(kind & 0x0f, wide ? wordAt(bytes, cursor + 1) : byteAt(bytes, cursor + 1));
    cursor += 1 + BLOCK_COEFFICIENTS * (wide ? 2 : 1);
  }
}

function readScan(bytes: Uint8Array, at: number, state: JpegState, frame: Frame): Scan {
  const count = byteAt(bytes, at);
  const components: ScanComponent[] = [];
  for (let i = 0; i < count; i++) {
    const id = byteAt(bytes, at + 1 + i * 2);
    const tables = byteAt(bytes, at + 2 + i * 2);
    const index = frame.components.findIndex((component) => component.id === id);
    const dc = state.dcTables.get(tables >> 4);
    if (index < 0 || !dc) throw corrupt();
    components.push({ index, dc, ac: state.acTables.get(tables & 0x0f) });
  }
  const tail = at + 1 + count * 2;
  const approximation = byteAt(bytes, tail + 2);
  return {
    components,
    start: byteAt(bytes, tail),
    end: byteAt(bytes, tail + 1),
    approximationHigh: approximation >> 4,
    approximationLow: approximation & 0x0f,
  };
}

/** Where the next marker after an entropy-coded segment starts. */
function afterEntropy(bytes: Uint8Array, at: number): number {
  for (let cursor = at; cursor < bytes.length - 1; cursor++) {
    const next = bytes[cursor + 1] ?? 0;
    const restart = next >= Marker.FirstRestart && next <= Marker.LastRestart;
    if (bytes[cursor] === 0xff && next !== 0 && !restart) return cursor;
  }
  return bytes.length;
}

/** Act on one marker segment; the luma's blocks once its DC scan is read, else null. */
function readSegment(bytes: Uint8Array, marker: number, at: number, state: JpegState): number[] | null {
  const length = wordAt(bytes, at);
  const body = at + 2;
  const end = at + length;
  if (UNREAD_FRAMES.has(marker)) throw corrupt();
  const isFrame = marker === Marker.Baseline || marker === Marker.ExtendedSequential || marker === Marker.Progressive;
  if (isFrame) state.frame = readFrame(bytes, body, marker);
  else if (marker === Marker.HuffmanTable) readHuffmanTables(bytes, body, end, state);
  else if (marker === Marker.QuantizationTable) readQuantizationTables(bytes, body, end, state);
  else if (marker === Marker.RestartInterval) state.restartInterval = wordAt(bytes, body);
  else if (marker === Marker.StartOfScan) {
    const frame = state.frame;
    if (!frame) throw corrupt();
    const scan = readScan(bytes, body, state, frame);
    if (carriesLumaDc(frame, scan)) return lumaFromScan(bytes, end, state, frame, scan);
  }
  return null;
}

/**
 * A JPEG's size and its luma blocks' mean light (0–255), from the first scan that carries them. A
 * frame of a size the cover refuses answers no blocks: nothing past its header is decoded.
 */
function jpegBlockLumas(bytes: Uint8Array): { width: number; height: number; lumas: number[] } {
  const state: JpegState = { quantDc: new Map(), dcTables: new Map(), acTables: new Map(), restartInterval: 0 };
  let at = 2;
  while (at < bytes.length) {
    if (byteAt(bytes, at) !== 0xff) throw corrupt();
    const marker = byteAt(bytes, at + 1);
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === Marker.EndOfImage) break;
    const lumas = readSegment(bytes, marker, at + 2, state);
    const frame = state.frame;
    if (frame && sizeRefusal(frame.width, frame.height)) return { width: frame.width, height: frame.height, lumas: [] };
    if (lumas && frame) return { width: frame.width, height: frame.height, lumas };
    const next = at + 2 + wordAt(bytes, at + 2);
    at = marker === Marker.StartOfScan ? afterEntropy(bytes, next) : next;
  }
  throw corrupt();
}
