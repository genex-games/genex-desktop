/**
 * An engine game's cover reel: the cover picture and the five seconds of play its agent rendered
 * from inside the engine (Unity, Godot, Unreal) into the game's `.studio/cover/` folder, played on
 * a page of the host's own so a plugin's still or clip of the game (`observe` with `still` or
 * `clip`) is taken of it exactly as of a web game's demo. A web page of the game would show nothing
 * of a game that runs as an app; the reel is what stands in for it.
 *
 * The folder is written by agents and by the engine they drive, so nothing in it is trusted: no
 * link is followed on the way or at the end, every file is read as a regular file under a cap, and
 * only bytes that are the picture or the video they claim to be are copied, under names the host
 * chooses, into a folder of the host's own. The page is served from there and never from the game.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { type PluginStillProblem, PluginStillProblemCode } from "../../shared/plugins.ts";
import { CoreFact, type GameKind, hasFact, servedAsWebGame } from "../../shared/project-facts.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { sniffImage } from "../../substrate/image-sniff.ts";
import { sniffClipContainer } from "../../substrate/video-sniff.ts";
import type { ViewOpener } from "./view-still.ts";

/** Where in a game folder its agent leaves the cover media, as path parts (`.studio/cover`). */
export const GAME_COVER_FOLDER = [".studio", "cover"] as const;
/** The picture's names in that folder, in the order they are looked for. */
export const COVER_PICTURE_NAMES = ["cover.png", "cover.jpg", "cover.jpeg", "cover.webp"] as const;
/** The folder of the clip's numbered frames, inside the cover folder. */
export const CLIP_FRAMES_FOLDER = "clip";
/** The clip as one video instead of frames, in the order they are looked for. */
export const CLIP_VIDEO_NAMES = ["clip.mp4", "clip.webm"] as const;
/** The rate the frames were rendered at and are played back at. */
export const CLIP_FRAMES_FPS = 30;

/** The most frames a reel plays: ten seconds at the frames' rate. */
export const CLIP_FRAMES_MAX = 300;
/** The largest picture a reel takes. */
export const COVER_PICTURE_MAX_BYTES = 16 * 1024 * 1024;
/** The largest single frame, and all of them together. */
export const CLIP_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const CLIP_FRAMES_MAX_BYTES = 128 * 1024 * 1024;
/** The largest clip video a reel takes. */
export const CLIP_VIDEO_MAX_BYTES = 64 * 1024 * 1024;

/** The engines whose players get the game as an app: their agent renders the cover in the engine. */
export const APP_ENGINE_FACTS = [CoreFact.UnityProject, CoreFact.GodotProject, CoreFact.UnrealProject] as const;
export type AppEngineFact = (typeof APP_ENGINE_FACTS)[number];

/** The engine of a game made as an app, by its facts; null for a web game or any other kind. */
export const appEngineOf = (game: GameKind): AppEngineFact | null =>
  APP_ENGINE_FACTS.find((fact) => hasFact(game.facts, fact)) ?? null;

/**
 * Whether a still or clip of this game is taken of its cover reel, when it has one: a game made in
 * an app engine (a Godot game's web export too), or any game not served as a web page.
 */
export const takenFromReel = (game: GameKind): boolean => appEngineOf(game) !== null || !servedAsWebGame(game);

/** The page the reel is played on, in its own folder. */
const REEL_ENTRY = "index.html";
/** Where the copied frames go in the reel's folder. */
const REEL_FRAMES = "frames";
/** The prefix of a reel's folder in the host's scratch. */
const REEL_PREFIX = "cover-reel-";
/** A frame's file, as the frames folder may name it. */
const FRAME_FILE = /\.(png|jpe?g|webp)$/i;

const MESSAGE = {
  notLoaded: "the cover reel did not load",
  title: "Cover reel",
} as const;

/** What the agent left: the picture, the frames in order or the video, each an absolute path. */
export interface CoverMedia {
  picture: string | null;
  frames: string[];
  video: string | null;
}

/** What a reel shows, by the names its page reads, and the views a plugin may ask of it. */
export interface ReelConfig {
  picture: string | null;
  frames: string[];
  video: string | null;
  fps: number;
  /** The demo whose still is the picture; null where there is none. */
  stillDemo: string | null;
  /** The demo whose clip is the frames or the video; null where there are none. */
  clipDemo: string | null;
}

/** A reel staged in the host's scratch: its folder, the page it serves, and its removal. */
export interface CoverReel {
  dir: string;
  config: ReelConfig;
  dispose: () => Promise<void>;
}

/** The view a reel is staged for: the demo a still or a clip asks for, if any. */
export interface ReelView {
  stillDemo?: string;
  clipDemo?: string;
}

/** Whether `dir` is a folder of its own: never a link, to anywhere. */
async function isRealFolder(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => null);
  return info?.isDirectory() === true;
}

/** The cover folder of a game, when every part on the way is a folder of its own; null otherwise. */
async function coverFolder(gameDir: string): Promise<string | null> {
  let dir = gameDir;
  for (const part of GAME_COVER_FOLDER) {
    dir = path.join(dir, part);
    if (!(await isRealFolder(dir))) return null;
  }
  return dir;
}

/** The first of `names` in `dir` that is a regular file (never a link), or null. */
async function firstFile(dir: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (info?.isFile()) return file;
  }
  return null;
}

/** The frames folder's frame files in play order (numbers as numbers), at most {@link CLIP_FRAMES_MAX}. */
async function frameFiles(dir: string): Promise<string[]> {
  const folder = path.join(dir, CLIP_FRAMES_FOLDER);
  if (!(await isRealFolder(folder))) return [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && FRAME_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .slice(0, CLIP_FRAMES_MAX)
    .map((name) => path.join(folder, name));
}

/** The cover media a game's agent left in its folder, by their names alone: nothing is read yet. */
export async function findCoverMedia(gameDir: string): Promise<CoverMedia> {
  const dir = await coverFolder(gameDir);
  if (!dir) return { picture: null, frames: [], video: null };
  const [picture, frames, video] = await Promise.all([
    firstFile(dir, COVER_PICTURE_NAMES),
    frameFiles(dir),
    firstFile(dir, CLIP_VIDEO_NAMES),
  ]);
  return { picture, frames, video };
}

/** Whether a game's folder holds any cover media at all. */
export const hasCoverMedia = (media: CoverMedia): boolean =>
  media.picture !== null || media.frames.length > 0 || media.video !== null;

/** A file's bytes when they are a picture under `maxBytes`, with the extension they really are; else null. */
async function readPicture(file: string, maxBytes: number): Promise<{ data: Buffer; ext: string } | null> {
  const data = await readRegularFile(file, maxBytes).catch(() => null);
  const sniffed = data ? sniffImage(data) : null;
  return data && sniffed ? { data, ext: sniffed.ext } : null;
}

/** Copy the picture into the reel as `picture.<ext>`; its name in the reel, or null when it is none. */
async function copyPicture(file: string | null, reel: string): Promise<string | null> {
  if (!file) return null;
  const picture = await readPicture(file, COVER_PICTURE_MAX_BYTES);
  if (!picture) return null;
  const name = `picture${picture.ext}`;
  await writeFile(path.join(reel, name), picture.data);
  return name;
}

/** Copy the frames that are pictures, in order, until the frames' cap; their names in the reel. */
async function copyFrames(files: readonly string[], reel: string): Promise<string[]> {
  if (files.length === 0) return [];
  await mkdir(path.join(reel, REEL_FRAMES));
  const names: string[] = [];
  let total = 0;
  for (const file of files) {
    const frame = await readPicture(file, CLIP_FRAME_MAX_BYTES);
    if (!frame) continue;
    total += frame.data.byteLength;
    if (total > CLIP_FRAMES_MAX_BYTES) break;
    const name = `${REEL_FRAMES}/${String(names.length).padStart(4, "0")}${frame.ext}`;
    await writeFile(path.join(reel, name), frame.data);
    names.push(name);
  }
  return names;
}

/** Copy the video when its bytes are the MP4 or WebM they claim; its name in the reel, or null. */
async function copyVideo(file: string | null, reel: string): Promise<string | null> {
  if (!file) return null;
  const data = await readRegularFile(file, CLIP_VIDEO_MAX_BYTES).catch(() => null);
  const type = data ? sniffClipContainer(data) : null;
  if (!data || !type) return null;
  const name = `clip${path.extname(file).toLowerCase()}`;
  await writeFile(path.join(reel, name), data);
  return name;
}

/**
 * Stage a game's cover reel in a new folder under `scratch`: its media copied, checked, and the page
 * that plays them. Null, with nothing left behind, when the game left no media the reel can show.
 */
export async function stageCoverReel(gameDir: string, scratch: string, view: ReelView): Promise<CoverReel | null> {
  const media = await findCoverMedia(gameDir);
  if (!hasCoverMedia(media)) return null;
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(path.join(scratch, REEL_PREFIX));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const picture = await copyPicture(media.picture, dir);
    const frames = await copyFrames(media.frames, dir);
    // Frames come first: they are what the engine rendered frame by frame, at the rate the reel plays.
    const video = frames.length > 0 ? null : await copyVideo(media.video, dir);
    const moving = frames.length > 0 || video !== null;
    const config: ReelConfig = {
      picture,
      frames,
      video,
      fps: CLIP_FRAMES_FPS,
      stillDemo: picture && view.stillDemo ? view.stillDemo : null,
      clipDemo: moving && view.clipDemo ? view.clipDemo : null,
    };
    if (!picture && !moving) {
      await dispose();
      return null;
    }
    await writeFile(path.join(dir, REEL_ENTRY), reelPage(config));
    return { dir, config, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** JSON that may sit inside a `<script>`: no `<` can close it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** The reel's page: one full-window canvas and the script that plays the media on it. */
export function reelPage(config: ReelConfig): string {
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><title>${MESSAGE.title}</title>`,
    "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style>",
    "</head><body><canvas></canvas>",
    `<script>(${runReel.toString()})(${scriptJson(config)});</script>`,
    "</body></html>",
  ].join("\n");
}

/**
 * The reel's player, run in its page from its own source text: `window.__studio` answers the views
 * a still or a clip asks for. A demo puts its first frame up and holds it; `start` plays the frames
 * (or the video) from there, looping, and `pause` holds them again; the camera `default` shows the
 * picture, else a frame from the middle of the clip. Every frame of the page draws the current
 * picture over the whole canvas, cropped to fill it.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: evaluated in the page from its own source, so it stays one self-contained function
export function runReel(config: ReelConfig): void {
  type Source = HTMLImageElement | HTMLVideoElement;
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const images = new Map<string, Promise<HTMLImageElement>>();
  let frames: HTMLImageElement[] = [];
  let video: HTMLVideoElement | null = null;
  let shown: Source | null = null;
  let playingSince: number | null = null;
  const ok = { ok: true };
  const image = (src: string): Promise<HTMLImageElement> => {
    const known = images.get(src);
    if (known) return known;
    const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`could not load ${src}`));
      element.src = src;
    });
    images.set(src, loaded);
    return loaded;
  };
  const clip = async (): Promise<void> => {
    if (config.frames.length > 0) {
      frames = await Promise.all(config.frames.map(image));
      return;
    }
    if (!config.video || video) return;
    const element = document.createElement("video");
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.src = config.video;
    await new Promise<void>((resolve, reject) => {
      element.onloadeddata = () => resolve();
      element.onerror = () => reject(new Error(`could not load ${config.video}`));
    });
    video = element;
  };
  const size = (source: Source) =>
    source instanceof HTMLVideoElement
      ? { width: source.videoWidth, height: source.videoHeight }
      : { width: source.naturalWidth, height: source.naturalHeight };
  const draw = (): void => {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(window.innerWidth * ratio));
    const height = Math.max(1, Math.round(window.innerHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (playingSince !== null && frames.length > 0) {
      const index = Math.floor(((performance.now() - playingSince) * config.fps) / 1000) % frames.length;
      shown = frames[index] ?? shown;
    }
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    if (shown) {
      const own = size(shown);
      if (own.width > 0 && own.height > 0) {
        const scale = Math.max(width / own.width, height / own.height);
        const w = own.width * scale;
        const h = own.height * scale;
        context.drawImage(shown, (width - w) / 2, (height - h) / 2, w, h);
      }
    }
    requestAnimationFrame(draw);
  };
  const firstOfClip = async (): Promise<Source | null> => {
    await clip();
    if (frames.length > 0) return frames[0] ?? null;
    if (!video) return null;
    video.pause();
    video.currentTime = 0;
    return video;
  };
  const middleOfClip = async (): Promise<Source | null> => {
    await clip();
    if (frames.length > 0) return frames[Math.floor(frames.length / 2)] ?? null;
    if (!video) return null;
    video.pause();
    video.currentTime = Number.isFinite(video.duration) ? video.duration / 2 : 0;
    await new Promise((resolve) => {
      if (video) video.onseeked = resolve;
    });
    return video;
  };
  const hold = (source: Source | null) => {
    playingSince = null;
    shown = source;
    return source ? ok : { ok: false, reason: "nothing to show" };
  };
  const demos = () => [config.stillDemo, config.clipDemo].filter((name): name is string => name !== null);
  const studio = {
    demos,
    demo: async (name: string) => {
      if (name === config.stillDemo && config.picture) return hold(await image(config.picture));
      if (name === config.clipDemo) return hold(await firstOfClip());
      return { ok: false, available: demos() };
    },
    cameras: () => [],
    eyes: () => [],
    debugCamera: async (name: string) => {
      if (name !== "default") return { ok: false, available: [] };
      if (config.picture) return hold(await image(config.picture));
      return hold(await middleOfClip());
    },
    start: () => {
      if (video && shown === video) void video.play();
      playingSince = performance.now();
      return ok;
    },
    pause: () => {
      video?.pause();
      playingSince = null;
      return ok;
    },
  };
  (window as unknown as { __studio: unknown }).__studio = studio;
  requestAnimationFrame(draw);
}

/** The reel's opener: its page loaded in the leased window, served from the reel's own folder. */
export function reelOpener(reel: Pick<CoverReel, "dir">): ViewOpener {
  return async (port, binding, abandoned) => {
    try {
      await port.load(binding.project, REEL_ENTRY, reel.dir);
    } catch (error) {
      return { code: PluginStillProblemCode.LoadFailed, reason: errorMessage(error) };
    }
    abandoned.throwIfAborted();
    const loadError = port.status().loadError;
    return loadError ? notLoaded(loadError) : null;
  };
}

const notLoaded = (reason: string): PluginStillProblem => ({
  code: PluginStillProblemCode.LoadFailed,
  reason: reason || MESSAGE.notLoaded,
});

/** Where a still or clip is taken: the game's kind, its folder, and the host's scratch for a reel. */
export interface ReelPlace {
  game: GameKind | null;
  gameDir: string;
  scratch: string;
}

/**
 * Take a still or a clip (`take`) of a game, of its cover reel when it is one {@link takenFromReel}
 * and left media to show, else of the game served (`take` handed no opener). The reel's folder is
 * removed however the take ends.
 */
export async function throughCoverReel<A>(
  place: ReelPlace,
  view: ReelView,
  take: (open: ViewOpener | undefined) => Promise<A>,
): Promise<A> {
  if (!place.game || !takenFromReel(place.game)) return take(undefined);
  const reel = await stageCoverReel(place.gameDir, place.scratch, view).catch(() => null);
  if (!reel) return take(undefined);
  try {
    return await take(reelOpener(reel));
  } finally {
    await reel.dispose();
  }
}
