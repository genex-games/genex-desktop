/**
 * Radiance `.hdr` environment maps at import: the header read and the size checked against the
 * renderer's caps, so a map the Rust runtime would refuse is refused here, typed, before it is
 * shipped. The file itself is kept as delivered; the runtime decodes it (`genex-render`'s
 * `hdri.rs`, which holds the same caps and the same layout rules, so a change to one is a change
 * to both). Nothing here decodes pixels.
 */

/** The widest map (an equirectangular map is twice as wide as tall). */
export const HDRI_MAX_WIDTH = 4096;
/** The tallest map. */
export const HDRI_MAX_HEIGHT = 2048;
/** The most bytes a decoded map holds (`rgba16float`: 8 bytes a texel). */
export const HDRI_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const HDRI_TEXEL_BYTES = 8;
/** The header (magic, lines, blank line, resolution line) may not be longer than this. */
const HEADER_MAX_BYTES = 4096;
/** Run-length rows exist only for widths in this range; narrower or wider maps are flat. */
const RLE_MIN_WIDTH = 8;
const RLE_MAX_WIDTH = 32767;
/** The longest run a new-style run-length row encodes in two bytes. */
const RLE_RUN_MAX = 127;
const MAGICS = ["#?RADIANCE", "#?RGBE"] as const;
const SUPPORTED_FORMAT = "32-bit_rle_rgbe";

/** Why a map is refused. The detail is for the log, never shown as copy. */
export class HdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HdrError";
  }
}

/** What the header says. */
export interface RadianceHeader {
  width: number;
  height: number;
  /** Where the pixel data starts. */
  pixelOffset: number;
}

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** A side of the resolution line: digits only, saturating past 2^32 so the caps refuse it. */
function side(text: string | undefined): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new HdrError("bad resolution line");
  return Math.min(Number(text), 0xffffffff);
}

/** The next line (without its CR/LF) from `at`, and where the one after starts. */
function nextLine(bytes: Uint8Array, at: number): { text: string; next: number } {
  const limit = Math.min(bytes.byteLength, HEADER_MAX_BYTES);
  for (let i = at; i < limit; i++) {
    if (bytes[i] === 0x0a) return { text: ascii(bytes, at, i).replace(/\r$/, ""), next: i + 1 };
  }
  throw new HdrError(bytes.byteLength >= HEADER_MAX_BYTES ? "header too long" : "truncated header");
}

/** The resolution line `-Y h +X w` (either sign on either axis) as its two sides. */
function parseResolution(line: string): { width: number; height: number } {
  const parts = line.trim().split(/\s+/);
  const [yAxis, h, xAxis, w] = parts;
  const axes = parts.length === 4 && /^[+-]Y$/.test(yAxis ?? "") && /^[+-]X$/.test(xAxis ?? "");
  if (!axes) throw new HdrError("unsupported resolution line");
  return { height: side(h), width: side(w) };
}

/** The header of a Radiance map, checked against the caps; throws {@link HdrError}. */
export function readRadianceHeader(bytes: Uint8Array): RadianceHeader {
  const first = nextLineAfterMagic(bytes);
  let at = first;
  for (;;) {
    const line = nextLine(bytes, at);
    at = line.next;
    if (line.text === "") break;
    if (line.text.startsWith("FORMAT=") && line.text.slice("FORMAT=".length) !== SUPPORTED_FORMAT) {
      throw new HdrError(`format ${line.text.slice("FORMAT=".length)} is not ${SUPPORTED_FORMAT}`);
    }
  }
  const resolution = nextLine(bytes, at);
  const { width, height } = parseResolution(resolution.text);
  if (width === 0 || height === 0) throw new HdrError("empty map");
  const tooBig = width > HDRI_MAX_WIDTH || height > HDRI_MAX_HEIGHT;
  if (tooBig || width * height * HDRI_TEXEL_BYTES > HDRI_MAX_DECODED_BYTES) {
    throw new HdrError(`${width}x${height} is over ${HDRI_MAX_WIDTH}x${HDRI_MAX_HEIGHT}`);
  }
  return { width, height, pixelOffset: resolution.next };
}

/** Checks the magic and returns where the first header line after it starts. */
function nextLineAfterMagic(bytes: Uint8Array): number {
  const magic = MAGICS.find((candidate) => ascii(bytes, 0, candidate.length) === candidate);
  if (!magic) throw new HdrError("not a Radiance file");
  return nextLine(bytes, 0).next;
}

/** The fewest pixel bytes a map of this size can hold, flat or run-length encoded. */
function minimumPixelBytes(header: RadianceHeader, pixels: Uint8Array): number {
  const { width, height } = header;
  const mayBeRle = width >= RLE_MIN_WIDTH && width <= RLE_MAX_WIDTH;
  const rle = mayBeRle && pixels[0] === 2 && pixels[1] === 2 && ((pixels[2] ?? 0) & 0x80) === 0;
  if (!rle) return width * height * 4;
  // A scanline header, then four channels each at least one two-byte run per 127 texels.
  return height * (4 + 4 * 2 * Math.ceil(width / RLE_RUN_MAX));
}

/** Checks a whole file: its header, the caps, and that the pixel data is not shorter than any encoding allows. */
export function checkRadiance(bytes: Uint8Array): RadianceHeader {
  const header = readRadianceHeader(bytes);
  const pixels = bytes.subarray(header.pixelOffset);
  if (pixels.byteLength < minimumPixelBytes(header, pixels)) throw new HdrError("truncated pixel data");
  return header;
}

/** Whether `bytes` read as a Radiance map within the caps (the host re-checks every kept output). */
export function looksLikeRadiance(bytes: Uint8Array): boolean {
  try {
    checkRadiance(bytes);
    return true;
  } catch {
    return false;
  }
}
