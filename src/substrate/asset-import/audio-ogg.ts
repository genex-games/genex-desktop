/**
 * Opus and AAC to Ogg Vorbis at 48 kHz (game systems AU-6, owner call AQ2): the `audio-to-ogg`
 * import step. The Rust runtime decodes Ogg Vorbis, MP3, FLAC and WAV (`genex-audio`'s
 * `decode_sound`); an Opus or AAC file is converted once, here, by a pinned host tool,
 * {@link AUDIO_OGG_TOOL} (opus-decoder decodes Opus, symphonia's AAC decoder reads ADTS and MP4,
 * vorbis_rs encodes through libvorbis), so no Opus or AAC decoder ships in a game.
 *
 * The step, in order:
 * 1. finds the tool in the importer tools folder, held to its pin for this platform
 *    ({@link AUDIO_OGG_TOOL_PINS}); a platform with none, or a missing file, is `converter-missing`;
 * 2. checks the input's container ({@link sniffAudio}): a truncated Ogg page, an ADTS frame cut
 *    short or an MP4 with no audio track is `malformed`, before anything is written;
 * 3. writes the input into a fresh folder under its TMPDIR (inside the importer's sandbox, the
 *    job's `tmp/`) and runs the tool there with only that folder's input and output names
 *    ({@link runAudioTool}). The tool is the importer's child, so it inherits the importer's
 *    sandbox: no network, writes only the job's `out/` and `tmp/`. Its environment is empty;
 * 4. holds what it wrote to Ogg Vorbis at 48 kHz, mono or stereo ({@link vorbisHeader}), and
 *    hands the bytes on. The folder is removed either way.
 *
 * The tool's contract: `genex-audio-ogg --from <ogg-opus|adts|mp4> <input> <output>`; exit 0 when
 * it wrote `<output>`, 65 when the input is damaged, 66 when it has no audio track to decode, 67
 * when it is longer than the tool converts (15 minutes). The tool creates `<output>` new and
 * removes it again when it fails after that.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type ImporterToolFile, importerToolsDir } from "./decoders.ts";
import { AssetImportRefusal } from "./import-plan.ts";

/** The host tool the step runs, and the crates it is built from (THIRD-PARTY-NOTICES.md). */
export const AUDIO_OGG_TOOL = {
  name: "genex-audio-ogg",
  version: "0.1.0",
  /** Its folder under the importer tools folder, or under `.studio-dev/tools/` in a checkout. */
  folder: "audio-ogg-0.1.0",
  crates: [
    {
      name: "vorbis_rs",
      version: "0.5.6",
      license: "BSD-3-Clause",
      builds: "aoTuV libvorbis (aotuv_lancer_vorbis_sys 0.1.6) and libogg (ogg_next_sys 0.1.5), BSD-3-Clause",
    },
    { name: "opus-decoder", version: "0.1.1", license: "MIT OR Apache-2.0" },
    { name: "symphonia", version: "0.6.1", license: "MPL-2.0", features: "aac, isomp4" },
  ],
} as const;

/**
 * The tool's build per `<platform>-<arch>` (Node's names), by size and sha256. A platform with no
 * pin refuses Opus and AAC `converter-missing`, as a build without the tool always did.
 */
export const AUDIO_OGG_TOOL_PINS: Readonly<Record<string, ImporterToolFile>> = {};

/** The container the tool is told to read. Wire values in its `--from` argument: never rename one. */
export const AudioSource = {
  /** An Ogg stream whose first packet is `OpusHead` (RFC 7845). */
  OggOpus: "ogg-opus",
  /** Raw AAC in ADTS frames (`.aac`). */
  Adts: "adts",
  /** An ISO base media file with an AAC (`mp4a`) audio track (`.m4a`). */
  Mp4: "mp4",
} as const;
export type AudioSource = (typeof AudioSource)[keyof typeof AudioSource];

/** Why the step refused, finer than the receipt's refusal. Wire values in its detail: never rename one. */
export const AudioOggFault = {
  /** The file ends inside a page, a frame or a box, or before the stream's first audio. */
  Truncated: "truncated",
  /** Not an Ogg stream. */
  NotOgg: "not-ogg",
  /** An Ogg stream whose first packet is not `OpusHead`. */
  NotOpus: "not-opus",
  /** Not ADTS frames. */
  NotAdts: "not-adts",
  /** Not an ISO base media file. */
  NotMp4: "not-mp4",
  /** An MP4 with no sound track, or a tool that found none. */
  NoAudioTrack: "no-audio-track",
  /** An MP4 whose sound track is not AAC. */
  NotAac: "not-aac",
  /** An extension the step does not convert. */
  UnknownExtension: "unknown-extension",
  /** No tool pin for this platform. */
  ToolUnpinned: "tool-unpinned",
  /** The pinned tool is not there, or is not a regular file. */
  ToolMissing: "tool-missing",
  /** The tool is there but not the pinned bytes. */
  ToolMismatch: "tool-mismatch",
  /** An input or output name that is not a plain file in the work folder. */
  PathOutsideJob: "path-outside-job",
  /** The tool exited 65: the input is damaged. */
  ToolRefusedInput: "tool-refused-input",
  /** The tool exited 67: the input is longer than it converts. */
  TooLong: "too-long",
  /** The tool exited with another code, by a signal, or did not start. */
  ToolFailed: "tool-failed",
  /** The tool ran past its deadline and was killed. */
  ToolTimedOut: "tool-timed-out",
  /** The tool exited 0 without writing a regular file. */
  NoOutput: "no-output",
  /** The tool wrote more than the runtime decodes. */
  OutputTooLarge: "output-too-large",
  /** What the tool wrote is not Ogg Vorbis at 48 kHz, mono or stereo. */
  NotVorbis48k: "not-vorbis-48k",
} as const;
export type AudioOggFault = (typeof AudioOggFault)[keyof typeof AudioOggFault];

/** The receipt's refusal for each fault. */
const FAULT_REFUSAL = {
  [AudioOggFault.Truncated]: AssetImportRefusal.Malformed,
  [AudioOggFault.NotOgg]: AssetImportRefusal.Malformed,
  [AudioOggFault.NotOpus]: AssetImportRefusal.Malformed,
  [AudioOggFault.NotAdts]: AssetImportRefusal.Malformed,
  [AudioOggFault.NotMp4]: AssetImportRefusal.Malformed,
  [AudioOggFault.NoAudioTrack]: AssetImportRefusal.Malformed,
  [AudioOggFault.NotAac]: AssetImportRefusal.Malformed,
  [AudioOggFault.UnknownExtension]: AssetImportRefusal.Malformed,
  [AudioOggFault.ToolUnpinned]: AssetImportRefusal.ConverterMissing,
  [AudioOggFault.ToolMissing]: AssetImportRefusal.ConverterMissing,
  [AudioOggFault.ToolMismatch]: AssetImportRefusal.ImporterFailed,
  [AudioOggFault.PathOutsideJob]: AssetImportRefusal.UnsafePath,
  [AudioOggFault.ToolRefusedInput]: AssetImportRefusal.Malformed,
  [AudioOggFault.TooLong]: AssetImportRefusal.TooLarge,
  [AudioOggFault.ToolFailed]: AssetImportRefusal.ImporterFailed,
  [AudioOggFault.ToolTimedOut]: AssetImportRefusal.ImporterFailed,
  [AudioOggFault.NoOutput]: AssetImportRefusal.ImporterFailed,
  [AudioOggFault.OutputTooLarge]: AssetImportRefusal.ImporterFailed,
  [AudioOggFault.NotVorbis48k]: AssetImportRefusal.ImporterFailed,
} as const satisfies Record<AudioOggFault, AssetImportRefusal>;

/** The tool's exit codes (sysexits). */
export const AudioToolExit = {
  Written: 0,
  /** EX_DATAERR: the input is damaged. */
  DataError: 65,
  /** EX_NOINPUT: the input has no audio track to decode. */
  NoInput: 66,
  /** The input is longer than the tool converts. */
  TooLong: 67,
} as const;

/** How long one conversion may run: well inside the importer job's own deadline. */
const AUDIO_TOOL_TIMEOUT_MS = 2 * MINUTE_MS;
/** The largest Ogg the step hands on: `genex-audio`'s whole-file decode cap. */
const AUDIO_OGG_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** What the step keeps of the tool's stdout and stderr: it reads neither. */
const AUDIO_TOOL_OUTPUT_KEEP_BYTES = 64 * 1024;
/** The only rate the runtime's mixer runs at. */
const OGG_RATE_HZ = 48_000;
const OGG_CHANNELS_MAX = 2;

const OGG_CAPTURE = [0x4f, 0x67, 0x67, 0x53];
const OGG_HEADER_BYTES = 27;
const OGG_BOS = 0x02;
const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];
const OPUS_HEAD_BYTES = 19;
const OPUS_MAJOR_VERSION_MASK = 0xf0;
/** Header, tags and at least one audio page: RFC 7845 puts each on a page of its own. */
const OPUS_PAGES_MIN = 3;
const VORBIS_ID = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73];
const VORBIS_ID_BYTES = 30;
const ADTS_HEADER_BYTES = 7;
const ADTS_CRC_BYTES = 2;
const ADTS_RATE_INDEX_MAX = 12;
const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_FLAG = 0x10;
const BOX_HEADER_BYTES = 8;
const BOX_LARGE_HEADER_BYTES = 16;
/** A full box's version and flags. */
const FULL_BOX_BYTES = 4;

/** This checkout's root (audio-ogg.ts is `src/substrate/asset-import/`). */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** A check's answer: what it found, or why not. */
type Found<T> = ({ ok: true } & T) | { ok: false; fault: AudioOggFault };
const fault = (code: AudioOggFault): { ok: false; fault: AudioOggFault } => ({ ok: false, fault: code });

/** The step's result: the Ogg bytes, or a typed refusal (`convert.ts`'s shape) with its fault. */
export type AudioOggResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; refusal: AssetImportRefusal; detail: string; fault: AudioOggFault };

const refused = (code: AudioOggFault, detail?: string): AudioOggResult => ({
  ok: false,
  refusal: FAULT_REFUSAL[code],
  detail: detail ? `audio-ogg ${code}: ${detail}` : `audio-ogg ${code}`,
  fault: code,
});

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length - at >= prefix.length && prefix.every((value, index) => bytes[at + index] === value);
const u32be = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
const u32le = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** One Ogg page: its flags, where its body starts and where the next page starts. */
interface OggPage {
  headerType: number;
  bodyAt: number;
  end: number;
}

/** The Ogg page at `at`, whole, or why not. */
function oggPage(bytes: Uint8Array, at: number): Found<{ page: OggPage }> {
  if (bytes.length - at < OGG_HEADER_BYTES) return fault(AudioOggFault.Truncated);
  if (!startsWith(bytes, OGG_CAPTURE, at) || bytes[at + 4] !== 0) return fault(AudioOggFault.NotOgg);
  const segments = bytes[at + OGG_HEADER_BYTES - 1] ?? 0;
  const bodyAt = at + OGG_HEADER_BYTES + segments;
  if (bodyAt > bytes.length) return fault(AudioOggFault.Truncated);
  let body = 0;
  for (let index = at + OGG_HEADER_BYTES; index < bodyAt; index += 1) body += bytes[index] ?? 0;
  if (bodyAt + body > bytes.length) return fault(AudioOggFault.Truncated);
  return { ok: true, page: { headerType: bytes[at + 5] ?? 0, bodyAt, end: bodyAt + body } };
}

/** Every page of an Ogg stream, each whole. */
function oggPages(bytes: Uint8Array): Found<{ pages: OggPage[] }> {
  if (bytes.length === 0) return fault(AudioOggFault.Truncated);
  const pages: OggPage[] = [];
  for (let at = 0; at < bytes.length; ) {
    const found = oggPage(bytes, at);
    if (!found.ok) return found;
    pages.push(found.page);
    at = found.page.end;
  }
  return { ok: true, pages };
}

/** An Ogg Opus stream: whole pages, `OpusHead` first (version 0.x, at least one channel), then tags and audio. */
function sniffOpus(bytes: Uint8Array): Found<{ source: AudioSource }> {
  const found = oggPages(bytes);
  if (!found.ok) return found;
  const [head] = found.pages;
  if (!head || (head.headerType & OGG_BOS) === 0) return fault(AudioOggFault.NotOpus);
  if (head.end - head.bodyAt < OPUS_HEAD_BYTES || !startsWith(bytes, OPUS_HEAD, head.bodyAt)) {
    return fault(AudioOggFault.NotOpus);
  }
  const version = bytes[head.bodyAt + 8] ?? 0;
  const channels = bytes[head.bodyAt + 9] ?? 0;
  if ((version & OPUS_MAJOR_VERSION_MASK) !== 0 || channels === 0) return fault(AudioOggFault.NotOpus);
  if (found.pages.length < OPUS_PAGES_MIN) return fault(AudioOggFault.Truncated);
  return { ok: true, source: AudioSource.OggOpus };
}

/** Where the audio starts after an ID3v2 tag (some encoders put one before ADTS frames). */
function afterId3(bytes: Uint8Array): number {
  if (bytes.length < ID3_HEADER_BYTES || fourcc(bytes, 0).slice(0, 3) !== "ID3") return 0;
  // A synchsafe size: seven bits per byte.
  const size = [6, 7, 8, 9].reduce((sum, at) => sum * 128 + ((bytes[at] ?? 0) & 0x7f), 0);
  const footer = ((bytes[5] ?? 0) & ID3_FOOTER_FLAG) === 0 ? 0 : ID3_HEADER_BYTES;
  return ID3_HEADER_BYTES + size + footer;
}

/** The length of the ADTS frame at `at`, or why there is none. */
function adtsFrame(bytes: Uint8Array, at: number): Found<{ length: number }> {
  if (bytes.length - at < ADTS_HEADER_BYTES) return fault(AudioOggFault.Truncated);
  // Twelve sync bits, then the MPEG version bit (either), the layer (always 00) and protection_absent.
  const synced = bytes[at] === 0xff && ((bytes[at + 1] ?? 0) & 0xf6) === 0xf0;
  const rateIndex = ((bytes[at + 2] ?? 0) >> 2) & 0x0f;
  if (!synced || rateIndex > ADTS_RATE_INDEX_MAX) return fault(AudioOggFault.NotAdts);
  const b3 = bytes[at + 3] ?? 0;
  const b4 = bytes[at + 4] ?? 0;
  const b5 = bytes[at + 5] ?? 0;
  const length = ((b3 & 0x03) << 11) | (b4 << 3) | (b5 >> 5);
  const crc = ((bytes[at + 1] ?? 0) & 0x01) === 0 ? ADTS_CRC_BYTES : 0;
  if (length < ADTS_HEADER_BYTES + crc) return fault(AudioOggFault.NotAdts);
  if (at + length > bytes.length) return fault(AudioOggFault.Truncated);
  return { ok: true, length };
}

/** Raw AAC: ADTS frames end to end, each whole, at least one. */
function sniffAdts(bytes: Uint8Array): Found<{ source: AudioSource }> {
  const start = afterId3(bytes);
  if (start >= bytes.length) return fault(AudioOggFault.Truncated);
  for (let at = start; at < bytes.length; ) {
    const frame = adtsFrame(bytes, at);
    if (!frame.ok) return frame;
    at += frame.length;
  }
  return { ok: true, source: AudioSource.Adts };
}

/** One ISO BMFF box: its type, and its payload's span. */
interface Box {
  type: string;
  start: number;
  end: number;
}

/** A box's whole size: its 32-bit size, its 64-bit `largesize` (size 1), or the rest of its parent (size 0). */
function boxSize(bytes: Uint8Array, at: number, end: number, declared: number): number {
  if (declared === 0) return end - at;
  if (declared !== 1) return declared;
  return Number(new DataView(bytes.buffer, bytes.byteOffset + at + BOX_HEADER_BYTES, 8).getBigUint64(0));
}

/** The boxes between `start` and `end`, each inside it. */
function boxes(bytes: Uint8Array, start: number, end: number): Found<{ boxes: Box[] }> {
  const found: Box[] = [];
  for (let at = start; at < end; ) {
    if (end - at < BOX_HEADER_BYTES) return fault(AudioOggFault.Truncated);
    const declared = u32be(bytes, at);
    const header = declared === 1 ? BOX_LARGE_HEADER_BYTES : BOX_HEADER_BYTES;
    if (end - at < header) return fault(AudioOggFault.Truncated);
    const size = boxSize(bytes, at, end, declared);
    if (size < header) return fault(AudioOggFault.NotMp4);
    if (at + size > end) return fault(AudioOggFault.Truncated);
    found.push({ type: fourcc(bytes, at + 4), start: at + header, end: at + size });
    at += size;
  }
  return { ok: true, boxes: found };
}

/** The first child of `parent` of `type`, or null (a malformed child list is none). */
function child(bytes: Uint8Array, parent: Box, type: string, skip = 0): Box | null {
  const found = boxes(bytes, parent.start + skip, parent.end);
  return found.ok ? (found.boxes.find((entry) => entry.type === type) ?? null) : null;
}

/** A track's handler type (`soun`, `vide`), or null. */
function handler(bytes: Uint8Array, trak: Box): string | null {
  const mdia = child(bytes, trak, "mdia");
  const hdlr = mdia && child(bytes, mdia, "hdlr");
  if (!hdlr || hdlr.end - hdlr.start < FULL_BOX_BYTES + 8) return null;
  return fourcc(bytes, hdlr.start + FULL_BOX_BYTES + 4);
}

/** A track's first sample entry type (`mp4a`, `alac`), or null. */
function sampleEntry(bytes: Uint8Array, trak: Box): string | null {
  let box: Box | null = trak;
  for (const type of ["mdia", "minf", "stbl", "stsd"]) box = box && child(bytes, box, type);
  if (!box) return null;
  const entry = boxes(bytes, box.start + FULL_BOX_BYTES + 4, box.end);
  return entry.ok ? (entry.boxes[0]?.type ?? null) : null;
}

/** An MP4: `ftyp` first, a movie box and media data, and a sound track whose samples are AAC. */
function sniffMp4(bytes: Uint8Array): Found<{ source: AudioSource }> {
  // The file type box comes first: anything else is another format, however its bytes parse as boxes.
  if (bytes.length < BOX_HEADER_BYTES || fourcc(bytes, 4) !== "ftyp") return fault(AudioOggFault.NotMp4);
  const top = boxes(bytes, 0, bytes.length);
  if (!top.ok) return top;
  const moov = top.boxes.find((entry) => entry.type === "moov");
  const hasMedia = top.boxes.some((entry) => entry.type === "mdat" || entry.type === "moof");
  if (!moov || !hasMedia) return fault(AudioOggFault.Truncated);
  const tracks = boxes(bytes, moov.start, moov.end);
  if (!tracks.ok) return tracks;
  const sound = tracks.boxes.filter((entry) => entry.type === "trak" && handler(bytes, entry) === "soun");
  if (sound.length === 0) return fault(AudioOggFault.NoAudioTrack);
  const aac = sound.some((trak) => sampleEntry(bytes, trak) === "mp4a");
  return aac ? { ok: true, source: AudioSource.Mp4 } : fault(AudioOggFault.NotAac);
}

/** The container each extension the step converts must be. */
const SNIFF_BY_EXTENSION: Readonly<Record<string, (bytes: Uint8Array) => Found<{ source: AudioSource }>>> = {
  opus: sniffOpus,
  aac: sniffAdts,
  m4a: sniffMp4,
};

/** The container of an input the step converts, checked whole before anything runs. */
export function sniffAudio(bytes: Uint8Array, ext: string): Found<{ source: AudioSource }> {
  const sniff = Object.hasOwn(SNIFF_BY_EXTENSION, ext) ? SNIFF_BY_EXTENSION[ext] : undefined;
  return sniff ? sniff(bytes) : fault(AudioOggFault.UnknownExtension);
}

/** An Ogg Vorbis file's channel count and rate from its identification header, or null when it is not one. */
export function vorbisHeader(bytes: Uint8Array): { channels: number; rate: number } | null {
  const found = oggPage(bytes, 0);
  if (!found.ok || (found.page.headerType & OGG_BOS) === 0) return null;
  const { bodyAt, end } = found.page;
  if (end - bodyAt < VORBIS_ID_BYTES || !startsWith(bytes, VORBIS_ID, bodyAt)) return null;
  if (u32le(bytes, bodyAt + 7) !== 0) return null;
  return { channels: bytes[bodyAt + 11] ?? 0, rate: u32le(bytes, bodyAt + 12) };
}

/** Whether a Vorbis header is one the runtime's mixer takes without resampling. */
const isVorbis48k = (header: { channels: number; rate: number } | null): boolean =>
  header !== null && header.rate === OGG_RATE_HZ && header.channels >= 1 && header.channels <= OGG_CHANNELS_MAX;

/** The tool's file name on this platform. */
const toolFileName = (platform: NodeJS.Platform) =>
  platform === "win32" ? `${AUDIO_OGG_TOOL.name}.exe` : AUDIO_OGG_TOOL.name;

/** Where to look for the tool, and against which pins. */
export interface LocateAudioToolOptions {
  env?: NodeJS.ProcessEnv;
  pins?: Readonly<Record<string, ImporterToolFile>>;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * The tool's absolute path, held to this platform's pin: in the importer tools folder the
 * environment names, else this checkout's `.studio-dev/tools/`. Never follows a link.
 */
export async function locateAudioTool(options: LocateAudioToolOptions = {}): Promise<Found<{ path: string }>> {
  const { env = process.env, pins = AUDIO_OGG_TOOL_PINS, platform = process.platform, arch = process.arch } = options;
  const key = `${platform}-${arch}`;
  const pin = Object.hasOwn(pins, key) ? pins[key] : undefined;
  if (!pin) return fault(AudioOggFault.ToolUnpinned);
  const root = importerToolsDir(env) ?? path.join(REPO, ".studio-dev", "tools");
  const file = path.join(root, AUDIO_OGG_TOOL.folder, toolFileName(platform));
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return fault(AudioOggFault.ToolMissing);
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== pin.bytes || sha256 !== pin.sha256) return fault(AudioOggFault.ToolMismatch);
  return { ok: true, path: file };
}

/** How a run of the tool ended. */
export interface AudioToolExitStatus {
  /** The exit code, or null when it was killed or never started. */
  code: number | null;
  timedOut: boolean;
}

/** Starts the tool (`execFile`'s shape); tests pass a recorder. */
export type AudioToolRun = (
  tool: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<AudioToolExitStatus>;

/** The tool as a child of this process: empty environment, no shell, killed at its deadline. */
const execTool: AudioToolRun = (tool, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    const options = {
      cwd,
      env: {},
      timeout: timeoutMs,
      killSignal: "SIGKILL" as const,
      maxBuffer: AUDIO_TOOL_OUTPUT_KEEP_BYTES,
      windowsHide: true,
    };
    execFile(tool, [...args], options, (error) => {
      if (!error) return resolve({ code: AudioToolExit.Written, timedOut: false });
      const timedOut = error.killed === true && error.signal === "SIGKILL";
      resolve({ code: typeof error.code === "number" ? error.code : null, timedOut });
    });
  });

/** A plain name's absolute path in `dir` (already real), or null for anything that could leave it. */
function inFolder(dir: string, name: string): string | null {
  const plain = name.length > 0 && name !== "." && name !== ".." && !/[/\\]/.test(name) && !path.isAbsolute(name);
  return plain ? path.join(dir, name) : null;
}

/** Whether `input` is a regular file and `output` is nothing yet, both plain names in `dir`. */
async function containedPair(dir: string, input: string, output: string): Promise<boolean> {
  const from = inFolder(dir, input);
  const to = inFolder(dir, output);
  if (!from || !to) return false;
  const [source, target] = await Promise.all([lstat(from).catch(() => null), lstat(to).catch(() => null)]);
  return source?.isFile() === true && target === null;
}

/** One run of the tool. */
export interface AudioToolRequest {
  /** The tool's absolute path ({@link locateAudioTool}). */
  tool: string;
  /** The work folder: the tool's working directory, holding the input. */
  workDir: string;
  /** The input's name in the work folder. */
  input: string;
  /** The output's name in the work folder: nothing may be there yet. */
  output: string;
  source: AudioSource;
  run?: AudioToolRun;
  timeoutMs?: number;
}

/**
 * Run the tool on `input`, writing `output`, both plain names in the work folder: a name that
 * climbs, is absolute or has a folder, an input that is a link or not there, and an output that
 * is already there (a planted link included) are refused before anything starts.
 */
export async function runAudioTool(request: AudioToolRequest): Promise<Found<{ output: string }>> {
  const dir = await realpath(request.workDir);
  if (!(await containedPair(dir, request.input, request.output))) return fault(AudioOggFault.PathOutsideJob);
  const run = request.run ?? execTool;
  const args = ["--from", request.source, request.input, request.output];
  const status = await run(request.tool, args, { cwd: dir, timeoutMs: request.timeoutMs ?? AUDIO_TOOL_TIMEOUT_MS });
  if (status.timedOut) return fault(AudioOggFault.ToolTimedOut);
  if (status.code === AudioToolExit.DataError) return fault(AudioOggFault.ToolRefusedInput);
  if (status.code === AudioToolExit.NoInput) return fault(AudioOggFault.NoAudioTrack);
  if (status.code === AudioToolExit.TooLong) return fault(AudioOggFault.TooLong);
  if (status.code !== AudioToolExit.Written) return fault(AudioOggFault.ToolFailed);
  return { ok: true, output: path.join(dir, request.output) };
}

/** The tool's output, held to the cap and to Ogg Vorbis at 48 kHz. */
async function readOutput(file: string): Promise<AudioOggResult> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return refused(AudioOggFault.NoOutput);
  if (info.size > AUDIO_OGG_OUTPUT_MAX_BYTES) return refused(AudioOggFault.OutputTooLarge, `${info.size} bytes`);
  const bytes = new Uint8Array(await readFile(file));
  const header = vorbisHeader(bytes);
  if (!isVorbis48k(header)) return refused(AudioOggFault.NotVorbis48k, JSON.stringify(header));
  return { ok: true, bytes };
}

/** What the step converts. */
export interface AudioOggInput {
  bytes: Uint8Array;
  /** The input's lowercase extension: `opus`, `aac` or `m4a`. */
  ext: string;
}

/** Where the step finds its tool and works; the defaults are the importer's. */
export interface AudioOggOptions {
  /** The tool's path, already held to its pin; found with {@link locateAudioTool} when absent. */
  tool?: string;
  env?: NodeJS.ProcessEnv;
  /** The folder the step's own work folder is made in: the importer's TMPDIR. */
  workDir?: string;
  run?: AudioToolRun;
  timeoutMs?: number;
}

/**
 * Convert an Opus or AAC file to Ogg Vorbis at 48 kHz. Never throws for a bad input or tool; a
 * work folder it cannot make or write throws, which `convertAsset` answers `importer-failed`.
 */
export async function audioToOgg(input: AudioOggInput, options: AudioOggOptions = {}): Promise<AudioOggResult> {
  const located = options.tool
    ? { ok: true as const, path: options.tool }
    : await locateAudioTool({ env: options.env });
  if (!located.ok) return refused(located.fault);
  const sniffed = sniffAudio(input.bytes, input.ext);
  if (!sniffed.ok) return refused(sniffed.fault, input.ext);
  const work = await mkdtemp(path.join(options.workDir ?? os.tmpdir(), "audio-ogg-"));
  try {
    const name = `in.${input.ext}`;
    await writeFile(path.join(work, name), input.bytes, { flag: "wx" });
    const ran = await runAudioTool({
      tool: located.path,
      workDir: work,
      input: name,
      output: "out.ogg",
      source: sniffed.source,
      ...(options.run ? { run: options.run } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!ran.ok) return refused(ran.fault);
    return await readOutput(ran.output);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
