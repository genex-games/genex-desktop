/**
 * Recording a game's canvas for a plugin's clip. The page half is one self-contained function
 * ({@link installClipRecorder}) evaluated in the game's page: it records the canvas a still reads
 * with `MediaRecorder` over `canvas.captureStream(fps)`, at two bitrates at once (so a recording
 * that runs over the byte limit has a smaller twin of the same moment, never a second take of a
 * later one), keeps the first frame as the poster and hands out small frames for the motion score.
 * The host half ({@link recordClip}) holds the clock, asks for the samples, keeps the best take that
 * fits and reads it back in bounded chunks, then checks the bytes are the container they claim.
 * Everything the page answers is untrusted data: it is checked before anything is kept.
 */
import { SECOND_MS } from "../shared/duration.ts";
import { PluginClipMimeType } from "../shared/plugins.ts";
import { clipMotion, type MotionFrame } from "../substrate/clip-motion.ts";
import type { PreviewClipAnswer, PreviewClipRequest } from "../substrate/preview-port.ts";
import { sniffClipContainer } from "../substrate/video-sniff.ts";

/** The recordings the page tries, best first: H.264 in MP4 where Chromium can, else VP9 or VP8 in WebM. */
export const CLIP_MIME_PREFERENCES = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8"];
/** The share of the byte limit a recording's bitrate is chosen to fill: the rest is the container's and the encoder's overshoot. */
const CLIP_BYTES_MARGIN = 0.8;
/** The second, smaller take's bitrate as a share of the first's. */
const CLIP_FALLBACK_SHARE = 0.4;
/** No take is asked to record above this many bits a second, whatever its byte limit allows. */
const CLIP_MAX_BITS_PER_SECOND = 20_000_000;
/** How many frames are sampled for the motion score, spread over the recording. */
const CLIP_MOTION_SAMPLES = 8;
/** The long side of a frame sampled for the motion score. */
const CLIP_MOTION_SAMPLE_PX = 96;
/** How much of the video one read brings back from the page. */
export const CLIP_READ_CHUNK_BYTES = 512 * 1024;

const MESSAGE = {
  noRecorder: "the page could not install the clip recorder",
  refused: (reason: string) => reason.slice(0, 240),
  silent: "the page's recorder gave no answer",
  container: (type: string) => `the page recorded ${type.slice(0, 80)}, which is no clip container`,
  size: "the recorded canvas has no size",
  takes: "the page's recorder answered takes it was never asked for",
  noFrame: "the recording holds no frame: the game drew nothing while it recorded",
  notContainer: (type: string) => `the recorded bytes are not the ${type} the recorder said`,
  chunk: (offset: number) => `the page answered no chunk of the recording at byte ${offset}`,
} as const;

/** What the page's recorder is told when it starts. */
export interface ClipStartOptions {
  fps: number;
  mimeTypes: readonly string[];
  bitrates: readonly number[];
  posterMaxPx: number;
}

/** The page's recorder, as the host reaches it: every answer is the page's, unchecked. */
export interface ClipPage {
  install(): Promise<unknown>;
  start(options: ClipStartOptions): Promise<unknown>;
  sample(token: string, maxPx: number): Promise<unknown>;
  stop(token: string): Promise<unknown>;
  read(token: string, take: number, offset: number, length: number): Promise<unknown>;
  discard(token: string): Promise<unknown>;
}

/** Everything the host half needs: the page, the clock, and two decoders of the page's pictures. */
export interface ClipRecorderDeps {
  page: ClipPage;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  /** A picture's data URL as a small BGRA bitmap, or null when it is none. */
  bitmap: (dataUrl: string) => MotionFrame | null;
  /** A picture's data URL as a JPEG at most `maxPx` on its long side, or null when it is none. */
  jpeg: (dataUrl: string, maxPx: number) => Buffer | null;
}

/** The page's recorder reached through `run` (`executeJavaScript(…, true)`), one expression per call. */
export function clipPageOn(run: (expression: string) => Promise<unknown>): ClipPage {
  const call = (method: string, ...args: unknown[]) =>
    run(`window.__studioClipRecorder.${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
  return {
    install: () => run(`(${installClipRecorder.toString()})()`),
    start: (options) => call("start", options),
    sample: (token, maxPx) => call("sample", token, maxPx),
    stop: (token) => call("stop", token),
    read: (token, take, offset, length) => call("read", token, take, offset, length),
    discard: (token) => call("discard", token),
  };
}

/** The bitrates of a clip's two takes: the first fills `maxBytes` with room to spare, the second is smaller. */
export function clipBitrates(seconds: number, maxBytes: number): number[] {
  const fitting = Math.floor((maxBytes * 8 * CLIP_BYTES_MARGIN) / seconds);
  const first = Math.min(CLIP_MAX_BITS_PER_SECOND, fitting);
  return [first, Math.floor(first * CLIP_FALLBACK_SHARE)];
}

/** A recording the page started: its token, its container and the canvas's size. */
interface Started {
  token: string;
  mimeType: PluginClipMimeType;
  width: number;
  height: number;
}

const isPositiveWhole = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const CLIP_CONTAINERS = new Set<string>(Object.values(PluginClipMimeType));
const isClipContainer = (value: string): value is PluginClipMimeType => CLIP_CONTAINERS.has(value);

/** The recording a page's answer to `start` names, checked or not: what the page is told to forget. */
function tokenOf(answer: unknown): string | null {
  const token = answer !== null && typeof answer === "object" ? (answer as { token?: unknown }).token : null;
  return typeof token === "string" ? token : null;
}

/** The page's answer to `start`, checked: a token, a clip container and a canvas size. */
function startedFrom(answer: unknown): Started {
  if (answer === null || typeof answer !== "object") throw new Error(MESSAGE.noRecorder);
  const said = answer as Record<string, unknown>;
  if (said.ok !== true)
    throw new Error(MESSAGE.refused(typeof said.reason === "string" ? said.reason : MESSAGE.silent));
  if (typeof said.token !== "string" || typeof said.mimeType !== "string") throw new Error(MESSAGE.noRecorder);
  const container = said.mimeType.split(";")[0]?.trim() ?? "";
  if (!isClipContainer(container)) throw new Error(MESSAGE.container(said.mimeType));
  if (!isPositiveWhole(said.width) || !isPositiveWhole(said.height)) throw new Error(MESSAGE.size);
  return { token: said.token, mimeType: container, width: said.width, height: said.height };
}

/** The page's answer to `stop`, checked: one whole size per take it was asked for, and its poster. */
function stoppedFrom(answer: unknown, takes: number): { sizes: number[]; poster: string | null } {
  const said = answer !== null && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  const sizes = Array.isArray(said.takes) ? said.takes : [];
  const whole = sizes.every((size) => typeof size === "number" && Number.isInteger(size) && size >= 0);
  if (sizes.length !== takes || !whole) throw new Error(MESSAGE.takes);
  return { sizes: sizes as number[], poster: typeof said.poster === "string" ? said.poster : null };
}

/** `seconds` of the game running, with a small frame sampled now and then for the motion score. */
async function runFor(deps: ClipRecorderDeps, token: string, seconds: number): Promise<number> {
  const startedAt = deps.now();
  const ms = seconds * SECOND_MS;
  const frames: MotionFrame[] = [];
  for (let i = 1; i <= CLIP_MOTION_SAMPLES; i++) {
    await deps.sleep(Math.max(0, startedAt + (i * ms) / (CLIP_MOTION_SAMPLES + 1) - deps.now()));
    const url = await deps.page.sample(token, CLIP_MOTION_SAMPLE_PX);
    const frame = typeof url === "string" ? deps.bitmap(url) : null;
    if (frame) frames.push(frame);
  }
  await deps.sleep(Math.max(0, startedAt + ms - deps.now()));
  return clipMotion(frames);
}

/** One take's bytes, read back in chunks of at most {@link CLIP_READ_CHUNK_BYTES}, each the length asked. */
async function readTake(page: ClipPage, token: string, take: number, bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes; offset += CLIP_READ_CHUNK_BYTES) {
    const length = Math.min(CLIP_READ_CHUNK_BYTES, bytes - offset);
    const text = await page.read(token, take, offset, length);
    const chunk = typeof text === "string" ? Buffer.from(text, "base64") : null;
    if (!chunk || chunk.length !== length) throw new Error(MESSAGE.chunk(offset));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The best take that fits the byte limit (the first one asked is the best), or -1. */
const fittingTake = (sizes: number[], maxBytes: number) => sizes.findIndex((size) => size > 0 && size <= maxBytes);

/** Stop the recording and keep the best take that fits, or say how small the smallest was. */
async function keep(
  deps: ClipRecorderDeps,
  started: Started,
  request: PreviewClipRequest,
  takes: number,
): Promise<{ video: Buffer; poster: Buffer } | { tooLarge: { smallestBytes: number } }> {
  const stopped = stoppedFrom(await deps.page.stop(started.token), takes);
  if (stopped.sizes.every((size) => size === 0)) throw new Error(MESSAGE.noFrame);
  const take = fittingTake(stopped.sizes, request.maxBytes);
  if (take < 0) return { tooLarge: { smallestBytes: Math.min(...stopped.sizes.filter((size) => size > 0)) } };
  const poster = stopped.poster ? deps.jpeg(stopped.poster, request.posterMaxPx) : null;
  if (!poster) throw new Error(MESSAGE.noFrame);
  const video = await readTake(deps.page, started.token, take, stopped.sizes[take] ?? 0);
  if (sniffClipContainer(video) !== started.mimeType) throw new Error(MESSAGE.notContainer(started.mimeType));
  return { video, poster };
}

/**
 * `request.seconds` of the page's canvas as the game draws it, recorded in real time: the best take
 * under the byte limit with its poster and motion score, or the smallest take's size when none fits.
 * The page forgets the recording however this ends. Throws when the page cannot record.
 */
export async function recordClip(deps: ClipRecorderDeps, request: PreviewClipRequest): Promise<PreviewClipAnswer> {
  if ((await deps.page.install()) !== true) throw new Error(MESSAGE.noRecorder);
  const bitrates = clipBitrates(request.seconds, request.maxBytes);
  const answer = await deps.page.start({
    fps: request.fps,
    mimeTypes: CLIP_MIME_PREFERENCES,
    bitrates,
    posterMaxPx: request.posterMaxPx,
  });
  const token = tokenOf(answer);
  try {
    const started = startedFrom(answer);
    const startedAt = deps.now();
    const motion = await runFor(deps, started.token, request.seconds);
    const durationMs = Math.round(deps.now() - startedAt);
    const kept = await keep(deps, started, request, bitrates.length);
    if ("tooLarge" in kept) return kept;
    const { mimeType, width, height } = started;
    return { clip: { video: kept.video, mimeType, width, height, durationMs, poster: kept.poster, motion } };
  } finally {
    if (token !== null) await deps.page.discard(token).catch(() => null);
  }
}

/**
 * Installs `window.__studioClipRecorder` in the game's page: `start` records the canvas a still
 * reads (the one the hook saw the world drawn on, else the largest 3D canvas the shim saw, else the
 * largest other canvas), `sample` draws the stream's current frame small, `stop` ends every take
 * and answers their sizes and the first frame, `read` answers a slice of one take as base64, and
 * `discard` forgets it all. It runs from its own source text, so everything it uses is declared
 * inside it, and it never touches the page's timers: the host holds the clock.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: evaluated in the page from its own source, so it stays one self-contained function
export function installClipRecorder(): boolean {
  type Take = { recorder: MediaRecorder; chunks: Blob[]; done: Promise<void>; blob: Blob | null };
  type Recording = { stream: MediaStream; video: HTMLVideoElement; takes: Take[]; poster: string | null };
  type Options = { fps: number; mimeTypes: string[]; bitrates: number[]; posterMaxPx: number };
  const page = window as unknown as Record<string, unknown>;
  const recordings = new Map<string, Recording>();
  const THREE_KINDS = ["webgl", "webgl2", "webgpu"];
  const attempt = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  const usable = (canvas: unknown): canvas is HTMLCanvasElement => {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) return false;
    const box = canvas.getBoundingClientRect();
    return canvas.width > 0 && canvas.height > 0 && box.width > 0 && box.height > 0;
  };
  const area = (canvas: HTMLCanvasElement) => canvas.width * canvas.height;
  const largest = (canvases: unknown[], wanted: (index: number) => boolean): HTMLCanvasElement | null => {
    let best: HTMLCanvasElement | null = null;
    for (const [index, canvas] of canvases.entries()) {
      if (!usable(canvas) || !wanted(index)) continue;
      if (!best || area(canvas) > area(best)) best = canvas;
    }
    return best;
  };
  const pickCanvas = (): HTMLCanvasElement | null => {
    const hook = page.__studioHook as { current?: () => { canvas?: unknown } | null } | undefined;
    const own = attempt(() => hook?.current?.()?.canvas);
    if (usable(own)) return own;
    const clock = page.__studioClock as
      | { canvases?: () => { elements?: unknown[]; descriptors?: Array<{ kind?: unknown } | null> } }
      | undefined;
    const seen = attempt(() => clock?.canvases?.());
    const elements = Array.isArray(seen?.elements) ? seen.elements : [];
    const descriptors = Array.isArray(seen?.descriptors) ? seen.descriptors : [];
    const kind = (index: number) => String(descriptors[index]?.kind ?? "");
    const listed =
      largest(elements, (index) => THREE_KINDS.includes(kind(index))) ??
      largest(elements, (index) => kind(index) !== "2d");
    return listed ?? largest([...document.querySelectorAll("canvas")], () => true);
  };
  const drawn = (video: HTMLVideoElement, maxPx: number, type: string): string | null => {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const scale = Math.min(1, maxPx / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type);
  };
  const nudge = (stream: MediaStream) => {
    const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    attempt(() => track?.requestFrame?.());
  };
  const takeOf = (stream: MediaStream, mimeType: string, bitrate: number): Take => {
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    const take: Take = { recorder, chunks: [], done: Promise.resolve(), blob: null };
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) take.chunks.push(event.data);
    };
    take.done = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        take.blob = new Blob(take.chunks, { type: mimeType });
        resolve();
      };
    });
    return take;
  };
  const start = (options: Options) => {
    const canvas = pickCanvas();
    if (!canvas) return { ok: false, reason: "this page has no canvas to record" };
    if (typeof MediaRecorder !== "function" || typeof canvas.captureStream !== "function")
      return { ok: false, reason: "this page cannot record its canvas" };
    const mimeType = options.mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return { ok: false, reason: "this page can record no clip container" };
    const stream = canvas.captureStream(options.fps);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const recording: Recording = { stream, video, takes: [], poster: null };
    video.addEventListener(
      "loadeddata",
      () => {
        recording.poster = drawn(video, options.posterMaxPx, "image/jpeg");
      },
      { once: true },
    );
    void video.play().catch(() => null);
    recording.takes = options.bitrates.map((bitrate) => takeOf(stream, mimeType, bitrate));
    for (const take of recording.takes) take.recorder.start();
    // A canvas stream sends a frame only when the canvas changes: one asked for now means a game
    // that stands still still records the picture it shows (and scores no motion).
    nudge(stream);
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    recordings.set(token, recording);
    return { ok: true, token, mimeType, width: canvas.width, height: canvas.height };
  };
  const sample = (token: string, maxPx: number) => {
    const recording = recordings.get(token);
    if (!recording) return null;
    nudge(recording.stream);
    return drawn(recording.video, maxPx, "image/png");
  };
  const stop = async (token: string) => {
    const recording = recordings.get(token);
    if (!recording) return null;
    for (const take of recording.takes) if (take.recorder.state !== "inactive") take.recorder.stop();
    await Promise.all(recording.takes.map((take) => take.done));
    recording.poster ??= drawn(recording.video, 1280, "image/jpeg");
    return { takes: recording.takes.map((take) => take.blob?.size ?? 0), poster: recording.poster };
  };
  const read = async (token: string, take: number, offset: number, length: number) => {
    const blob = recordings.get(token)?.takes[take]?.blob;
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const discard = (token: string) => {
    const recording = recordings.get(token);
    if (!recording) return true;
    for (const take of recording.takes) if (take.recorder.state !== "inactive") take.recorder.stop();
    for (const track of recording.stream.getTracks()) track.stop();
    recording.video.srcObject = null;
    recordings.delete(token);
    return true;
  };
  Object.defineProperty(window, "__studioClipRecorder", {
    value: Object.freeze({ start, sample, stop, read, discard }),
    configurable: true,
  });
  return true;
}
