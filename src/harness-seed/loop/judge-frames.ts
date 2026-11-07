/**
 * What a lead hands the Loop's judge (`second-opinion.ts`), read from inside the project's folder:
 * a motion strip's frames, then the pictures it names, each with its game time when it has one. A
 * sword duel's lead asked the judge about stills for 17 rounds while its fighters slid; frames in
 * order with their times are what let a model see a foot ride along with the body.
 *
 * A module of its own that takes only `picturesIn` from second-opinion.ts, a name every shipped
 * judge has, so the open lead's tools still load beside a second-opinion.ts the agent edited and
 * kept from an older seed (that judge then reads the frames without their times).
 */
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { picturesIn } from "./second-opinion.ts";
import { hasText } from "./text.ts";
import type { MessageImage } from "../types/host-api.d.ts";

/** The most frames one motion strip hands the judge: motion_strip's own most. */
const MAX_STRIP_FRAMES = 24;
/**
 * The most bytes a strip's frames and the pictures carry together: a model's API takes about 32 MB a
 * request and base64 adds a third. Frames past it are left out, the last ones first.
 */
const MAX_ASK_BYTES = 20 * 1024 * 1024;
/** The largest motion strip record read. */
const MAX_STRIP_RECORD_BYTES = 1024 * 1024;
/** A motion strip's record, by extension. */
const STRIP_RECORD = ".json";
/** What a missing file's stat fails with. */
const NO_SUCH_FILE = "ENOENT";
/** The frame files a strip can name, by extension: the pictures the judge reads. */
const FRAME_TYPES: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg"]);

/** The words a lead is told when a strip or its times can't be read. Model-facing. */
export const JUDGE_FRAMES_REFUSALS = {
  badTimes: (count: number, pictures: number) =>
    `times names ${count} times for ${pictures} pictures: give one game time (a number) per picture, or leave times out.`,
  badStrip: (rel: string, why: string) => `${JSON.stringify(rel)} is not a motion strip judge can read (${why}).`,
} as const;

/** Why a strip can't be read, in the words of badStrip. */
const STRIP_WHY = {
  notRecord: "not a motion strip's .json poses file",
  outside: "not a file in the project's folder",
  unreadable: "it could not be read as a motion strip's record",
  badFrame: "a frame's file is not one picture's path",
  empty: "it holds no frames yet: wait for the strip's answer",
  tooLarge: "its first frame alone is too large to send",
} as const;

/** What a lead hands the judge: the pictures in order, each one's name and game time, and the strip's frames left out. */
export interface JudgedPictures {
  images: MessageImage[];
  names: string[];
  /** Each picture's game time, null for one without. */
  times: (number | null)[];
  leftOut: number;
}

/** Whether `full` lies under `top` by its path alone. */
const under = (top: string, full: string) => full.startsWith(`${top}${path.sep}`);

/** A file's real path when it is inside `top` (by its real path too), else null. */
async function fileInside(top: string, rel: string): Promise<string | null> {
  const full = await realpath(path.resolve(top, rel)).catch(() => null);
  return full !== null && under(top, full) ? full : null;
}

/**
 * Whether a strip's frame is one that never landed: a picture whose folder is inside `top` by its real
 * path (Unreal spells a game folder reached through a link as it was opened) and nothing is there.
 */
async function neverLanded(top: string, rel: string): Promise<boolean> {
  const full = path.resolve(top, rel);
  if (!FRAME_TYPES.has(path.extname(full).toLowerCase())) return false;
  const folder = await realpath(path.dirname(full)).catch(() => null);
  if (folder === null || (folder !== top && !under(top, folder))) return false;
  return lstat(path.join(folder, path.basename(full))).then(
    () => false,
    (err: { code?: unknown }) => err?.code === NO_SUCH_FILE,
  );
}

/** A strip's poses file inside `top`: its frame files (at most MAX_STRIP_FRAMES) and poses; or why it can't be read. */
async function stripRecord(
  top: string,
  rel: string,
): Promise<{ files: unknown[]; poses: unknown[] } | { why: string }> {
  if (path.extname(rel).toLowerCase() !== STRIP_RECORD) return { why: STRIP_WHY.notRecord };
  const full = await fileInside(top, rel);
  if (!full) return { why: STRIP_WHY.outside };
  const size = await stat(full).then(
    (info) => (info.isFile() ? info.size : -1),
    () => -1,
  );
  if (size < 0 || size > MAX_STRIP_RECORD_BYTES) return { why: STRIP_WHY.unreadable };
  const record = await readFile(full, "utf8")
    .then((text) => JSON.parse(text) as { files?: unknown; frames?: unknown } | null)
    .catch(() => null);
  if (!Array.isArray(record?.files)) return { why: STRIP_WHY.unreadable };
  if (!record.files.length) return { why: STRIP_WHY.empty };
  const poses = Array.isArray(record.frames) ? record.frames : [];
  return { files: record.files.slice(0, MAX_STRIP_FRAMES), poses };
}

/** One frame of a strip inside `top`: its picture, null for a frame that never landed, or why it can't be read. */
async function stripFrame(
  top: string,
  file: unknown,
  refused: (why: string) => { refused: string },
): Promise<MessageImage | null | { refused: string }> {
  // picturesIn reads a comma-separated list: a frame's path names one picture.
  if (typeof file !== "string" || !file.trim() || file.includes(",")) return refused(STRIP_WHY.badFrame);
  if (await neverLanded(top, file)) return null;
  const read = await picturesIn(top, file);
  if ("refused" in read) return read;
  return read.images[0] ?? refused(STRIP_WHY.badFrame);
}

/**
 * A strip's frames that fit in `budget` bytes, each with its name and game time; or why the strip
 * can't be read. A frame that never landed (the strip's last, when play ended) is left out.
 */
async function stripFrames(top: string, rel: string, budget: number): Promise<JudgedPictures | { refused: string }> {
  const refused = (why: string) => ({ refused: JUDGE_FRAMES_REFUSALS.badStrip(rel, why) });
  const record = await stripRecord(top, rel);
  if ("why" in record) return refused(record.why);
  const { files, poses } = record;
  const out: JudgedPictures = { images: [], names: [], times: [], leftOut: 0 };
  let used = 0;
  for (const [index, file] of files.entries()) {
    const image = await stripFrame(top, file, refused);
    if (image === null) continue;
    if ("refused" in image) return image;
    const bytes = Buffer.byteLength(image.data, "base64");
    if (used + bytes > budget) {
      out.leftOut = files.length - index;
      break;
    }
    used += bytes;
    const at = Number((poses[index] as { gameSeconds?: unknown } | undefined)?.gameSeconds);
    out.images.push(image);
    out.names.push(`frame ${index} of the strip`);
    out.times.push(Number.isFinite(at) ? at : null);
  }
  if (out.images.length) return out;
  return refused(out.leftOut ? STRIP_WHY.tooLarge : STRIP_WHY.empty);
}

/** The game times a lead gives its pictures, one each, listed as the pictures are; null for none given, or why they don't fit. */
function timesOf(named: unknown, count: number): (number | null)[] | { refused: string } {
  if (!hasText(named)) return Array.from({ length: count }, () => null);
  const times = named
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number);
  if (times.length !== count || !times.every(Number.isFinite))
    return { refused: JUDGE_FRAMES_REFUSALS.badTimes(times.length, count) };
  return times;
}

/**
 * Everything a lead hands the judge, read from inside `root`: a motion strip's frames first (as many
 * as fit beside the pictures), then the pictures, each with its game time; or why one can't be read.
 */
export async function judgedPictures(
  root: string,
  args: { pictures?: unknown; times?: unknown; strip?: unknown },
): Promise<JudgedPictures | { refused: string }> {
  const pictures = await picturesIn(root, args.pictures);
  if ("refused" in pictures) return pictures;
  const times = timesOf(args.times, pictures.images.length);
  if (!Array.isArray(times)) return times;
  const own: JudgedPictures = {
    images: pictures.images,
    names: pictures.images.map((image) => image.label ?? ""),
    times,
    leftOut: 0,
  };
  if (!hasText(args.strip)) return own;
  const top = await realpath(root).catch(() => path.resolve(root));
  const taken = own.images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
  const strip = await stripFrames(top, args.strip.trim(), Math.max(0, MAX_ASK_BYTES - taken));
  if ("refused" in strip) return strip;
  return {
    images: [...strip.images, ...own.images],
    names: [...strip.names, ...own.names],
    times: [...strip.times, ...own.times],
    leftOut: strip.leftOut,
  };
}
