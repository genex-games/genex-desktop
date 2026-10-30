/**
 * The cover clip an agent hands genex__cover, read the way Studio needs it before keeping it: its
 * container by its bytes (WebM or MP4, what Genex takes), its picture size and how long it plays,
 * from the container's own records. A WebM a browser recorded often names no duration; its length
 * is then its last frame's time. Nothing is decoded, and Genex judges the footage itself.
 */
import { PluginClipMimeType } from "../../shared/plugins.ts";
import { sniffClipContainer } from "../../substrate/video-sniff.ts";

/**
 * The least a clip may play: Genex keeps five seconds of it after trimming up to 300 ms of its start
 * (its encoder's cold start), and a clip a hair over five seconds loses its last frame to that trim.
 */
export const CLIP_MIN_MS = 5_300;
const MS_PER_SECOND = 1_000;
/** A WebM's default timestamp unit, in nanoseconds (one millisecond). */
const WEBM_DEFAULT_SCALE_NS = 1_000_000;
const NS_PER_MS = 1_000_000;
/** An MP4 track's width and height are 16.16 fixed point. */
const FIXED_POINT = 65_536;

/** Why a clip cannot go with the cover. Agent-facing English: the tool's refusal names it. */
export const CLIP_FILE_MESSAGE = {
  NotVideo: "The clip must be a WebM or an MP4; this file is neither.",
  Unreadable:
    "Studio could not read the clip's size or length from its container: save it again as an ordinary WebM or MP4.",
  TooShort: (ms: number) =>
    `The clip plays ${(ms / MS_PER_SECOND).toFixed(1)} s: Genex keeps five seconds after trimming up to 0.3 s of its start, so it needs at least ${(CLIP_MIN_MS / MS_PER_SECOND).toFixed(1)} s.`,
} as const;

/** A clip as Studio read it. */
export interface ClipFile {
  mimeType: PluginClipMimeType;
  width: number;
  height: number;
  durationMs: number;
}

/** Read a clip's bytes: its container, size and length, or why it cannot go with the cover. */
export function readClipFile(bytes: Uint8Array): ClipFile | { refused: string } {
  const mimeType = sniffClipContainer(bytes);
  if (!mimeType) return { refused: CLIP_FILE_MESSAGE.NotVideo };
  const info = mimeType === PluginClipMimeType.Mp4 ? mp4Info(bytes) : webmInfo(bytes);
  const whole = info && info.width > 0 && info.height > 0 && info.durationMs > 0;
  if (!info || !whole) return { refused: CLIP_FILE_MESSAGE.Unreadable };
  if (info.durationMs < CLIP_MIN_MS) return { refused: CLIP_FILE_MESSAGE.TooShort(info.durationMs) };
  return { mimeType, ...info };
}

type ClipInfo = Omit<ClipFile, "mimeType">;

// ── MP4: the movie header's length and the tracks' headers' sizes ────────────────────────────

/** The boxes an MP4's headers sit in. */
const MP4_CONTAINERS = new Set(["moov", "trak", "mvex"]);

interface Mp4Reading {
  timescale: number;
  duration: number;
  fragmentDuration: number;
  width: number;
  height: number;
}

/** A 64-bit field as a number; a length past 2^53 is no clip's. */
const uint64 = (view: DataView, at: number) => view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);

function readMp4Box(view: DataView, type: string, body: number, reading: Mp4Reading): void {
  const version = view.getUint8(body);
  if (type === "mvhd") {
    reading.timescale = view.getUint32(body + (version === 1 ? 20 : 12));
    reading.duration = version === 1 ? uint64(view, body + 24) : view.getUint32(body + 16);
  } else if (type === "mehd") {
    reading.fragmentDuration = version === 1 ? uint64(view, body + 4) : view.getUint32(body + 4);
  } else if (type === "tkhd") {
    const size = body + (version === 1 ? 88 : 76);
    reading.width = Math.max(reading.width, Math.round(view.getUint32(size) / FIXED_POINT));
    reading.height = Math.max(reading.height, Math.round(view.getUint32(size + 4) / FIXED_POINT));
  }
}

/** A box's whole size: 1 means a 64-bit size follows its type, 0 that it runs to the end of its parent. */
function boxSize(view: DataView, at: number, end: number, declared: number): number {
  if (declared === 1) return uint64(view, at + 8);
  if (declared === 0) return end - at;
  return declared;
}

/** Walk the boxes from `start` to `end`, into the containers that hold the headers. */
function walkMp4(view: DataView, start: number, end: number, reading: Mp4Reading): void {
  let at = start;
  while (at + 8 <= end) {
    const declared = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    const wide = declared === 1;
    const size = boxSize(view, at, end, declared);
    const body = at + (wide ? 16 : 8);
    if (size < body - at || at + size > end) return;
    if (MP4_CONTAINERS.has(type)) walkMp4(view, body, at + size, reading);
    else readMp4Box(view, type, body, reading);
    at += size;
  }
}

function mp4Info(bytes: Uint8Array): ClipInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reading: Mp4Reading = { timescale: 0, duration: 0, fragmentDuration: 0, width: 0, height: 0 };
  try {
    walkMp4(view, 0, bytes.byteLength, reading);
  } catch {
    return null;
  }
  const units = reading.duration || reading.fragmentDuration;
  if (!reading.timescale || !units) return null;
  return {
    width: reading.width,
    height: reading.height,
    durationMs: Math.round((units * MS_PER_SECOND) / reading.timescale),
  };
}

// ── WebM: the segment's info, the video track and the clusters' times ───────────────────────

/** The Matroska elements the reader acts on (their IDs keep their length marker). */
const Ebml = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  BlockGroup: 0xa0,
  Block: 0xa1,
  SimpleBlock: 0xa3,
} as const;
/** The elements read into rather than past: their children follow their header. */
const EBML_MASTERS = new Set<number>([
  Ebml.Segment,
  Ebml.Info,
  Ebml.Tracks,
  Ebml.TrackEntry,
  Ebml.Video,
  Ebml.Cluster,
  Ebml.BlockGroup,
]);
/** The longest ID and size an element header carries. */
const EBML_MAX_ID_BYTES = 4;
const EBML_MAX_SIZE_BYTES = 8;

interface WebmReading {
  scaleNs: number;
  duration: number;
  width: number;
  height: number;
  clusterTime: number;
  lastTime: number;
}

/** A variable-length integer at `at`: its value (the marker bit kept for an ID) and its length. */
function vint(bytes: Uint8Array, at: number, maxBytes: number, keepMarker: boolean) {
  const first = bytes[at] ?? 0;
  let length = 1;
  while (length <= maxBytes && !(first & (0x80 >> (length - 1)))) length++;
  if (length > maxBytes || at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i] ?? 0;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { value, length, unknown: !keepMarker && unknown };
}

/** An unsigned integer element's value. */
function uintAt(bytes: Uint8Array, at: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + (bytes[at + i] ?? 0);
  return value;
}

function readWebmLeaf(bytes: Uint8Array, id: number, at: number, size: number, reading: WebmReading): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, size);
  if (id === Ebml.TimecodeScale) reading.scaleNs = uintAt(bytes, at, size);
  else if (id === Ebml.Duration) reading.duration = size === 4 ? view.getFloat32(0) : view.getFloat64(0);
  else if (id === Ebml.PixelWidth) reading.width = Math.max(reading.width, uintAt(bytes, at, size));
  else if (id === Ebml.PixelHeight) reading.height = Math.max(reading.height, uintAt(bytes, at, size));
  else if (id === Ebml.Timecode) reading.clusterTime = uintAt(bytes, at, size);
  else if (id === Ebml.SimpleBlock || id === Ebml.Block) {
    const track = vint(bytes, at, EBML_MAX_SIZE_BYTES, false);
    if (!track || size < track.length + 2) return;
    const relative = view.getInt16(track.length);
    reading.lastTime = Math.max(reading.lastTime, reading.clusterTime + relative);
  }
}

/** Walk the elements in order, into the masters, past everything else. */
function walkWebm(bytes: Uint8Array, reading: WebmReading): void {
  let at = 0;
  while (at < bytes.length) {
    const id = vint(bytes, at, EBML_MAX_ID_BYTES, true);
    const size = id && vint(bytes, at + id.length, EBML_MAX_SIZE_BYTES, false);
    if (!id || !size) return;
    const data = at + id.length + size.length;
    if (EBML_MASTERS.has(id.value)) {
      at = data;
      continue;
    }
    // Only a master may be of unknown size: anything else so marked ends the reading.
    if (size.unknown || data + size.value > bytes.length) return;
    readWebmLeaf(bytes, id.value, data, size.value, reading);
    at = data + size.value;
  }
}

function webmInfo(bytes: Uint8Array): ClipInfo | null {
  const reading: WebmReading = {
    scaleNs: WEBM_DEFAULT_SCALE_NS,
    duration: 0,
    width: 0,
    height: 0,
    clusterTime: 0,
    lastTime: 0,
  };
  try {
    walkWebm(bytes, reading);
  } catch {
    return null;
  }
  const units = reading.duration > 0 ? reading.duration : reading.lastTime;
  return {
    width: reading.width,
    height: reading.height,
    durationMs: Math.round((units * reading.scaleNs) / NS_PER_MS),
  };
}
