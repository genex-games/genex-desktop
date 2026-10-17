/**
 * The game's Genex cover clip, the Genex plugin's half: five seconds of real play that genex.games
 * runs over the cover on its cards. The game stages the start of the moment as its demo named
 * `genex-clip` (`config.demos`) and plays itself from there; the host records it through
 * `observe` with a `clip` into this plugin's storage, `covers/<project>/clip.*`. It is sent with
 * the pinned CLI's `genex cover --clip <file> --commit <sha> --json` after the cover, once a
 * publish is recorded. Genex decides what it keeps (the owner's clip outranks it, frozen or
 * flashing footage is refused); every threshold here is an advisory mirror.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  GENEX_COVER_CLIP_FILE,
  type GenexCoverClip,
  GenexCoverOutcome,
  type GenexCoverSent,
} from "../../shared/genex.ts";
import { PluginClipMimeType, PluginStillProblemCode, type PluginStillProblem } from "../../shared/plugins.ts";
import { atomicWriteText, isJsonObject, replaceFile } from "../../substrate/fsx.ts";
import { stripAnsi } from "./cli.ts";

/** The demo a game stages its clip's first moment in (`config.demos`). */
export const CLIP_VIEW = "genex-clip";
/** What the host is asked for: Genex's stored clip size and length, within its upload limit. */
export const COVER_CLIP = {
  demo: CLIP_VIEW,
  width: 960,
  height: 540,
  seconds: 5,
  fps: 30,
  maxBytes: 8 * 1024 * 1024,
} as const;
/** Under this share of moving frame pairs, Genex will likely refuse the clip as frozen. Advisory. */
const FROZEN_MOTION = 0.1;
const CLIP_RECORD = "clip.json";
const CLIP_SENT_RECORD = "clip-sent.json";
const SEND_COPY_PREFIX = ".send-clip-";
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
const REASON_CHARS = 240;

/** Every sentence the clip speaks to the agent. */
export const CLIP_MESSAGE = {
  PosterLabel: "The genex-clip recording's first frame",
  Frozen:
    "Almost nothing moves in this clip, so Genex will likely refuse it as frozen: the genex-clip demo must start a moment the game then plays by itself (its own scripted input), not a paused frame.",
  Kept: "The clip is kept: the next publish sends it after the cover; genex.games plays it over the cover on its cards.",
  NoDemo:
    'The game has no demo named genex-clip. Add one to config.demos that starts a moment the game then plays by itself for five seconds; read genex__skill {"name":"genex-cover"} first.',
  Unavailable: "This Studio window cannot record a clip right now. The last clip, if any, is kept.",
  Failed: (code: string, reason?: string) =>
    `The clip was not recorded (${code}${reason ? `: ${reason}` : ""}). The last clip, if any, is kept.`,
} as const;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
const wholePixels = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const fraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const CLIP_TYPES = new Set<string>(Object.values(PluginClipMimeType));
const PROBLEM_CODES = new Set<string>(Object.values(PluginStillProblemCode));
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A clip the host recorded, checked: the video, its type, size, length, poster and motion. */
export interface CoverClipTake {
  video: Buffer;
  mimeType: PluginClipMimeType;
  width: number;
  height: number;
  durationMs: number;
  poster: Buffer;
  motion: number;
}

/** A well-formed clip from the host's answer, or null. */
function clipOf(raw: unknown): CoverClipTake | null {
  if (!isJsonObject(raw)) return null;
  const { video, mimeType, width, height, durationMs, poster, motion } = raw;
  const sized = wholePixels(width) && wholePixels(height) && wholePixels(durationMs);
  const known = isBytes(video) && video.byteLength > 0 && video.byteLength <= COVER_CLIP.maxBytes;
  if (!(known && sized && CLIP_TYPES.has(String(mimeType)) && isBytes(poster) && fraction(motion))) return null;
  return {
    video: asBuffer(video),
    mimeType: mimeType as PluginClipMimeType,
    width,
    height,
    durationMs,
    poster: asBuffer(poster),
    motion,
  };
}

/** The host's answer to a clip: the recording, or the problem it named; anything else is `unavailable`. */
export function readClipAnswer(answer: unknown): { clip: CoverClipTake } | { problem: PluginStillProblem } {
  const record = isJsonObject(answer) ? answer : {};
  const clip = clipOf(record.clip);
  if (clip) return { clip };
  const raw = isJsonObject(record.clipProblem) ? record.clipProblem : null;
  if (!raw || !PROBLEM_CODES.has(String(raw.code))) return { problem: { code: PluginStillProblemCode.Unavailable } };
  const problem: PluginStillProblem = { code: raw.code as PluginStillProblem["code"] };
  if (typeof raw.reason === "string") problem.reason = raw.reason.slice(0, REASON_CHARS);
  return { problem };
}

/** What the agent is told about a recording: its motion, and when it is sent. */
export const clipGuidance = (clip: Pick<GenexCoverClip, "motion">) =>
  clip.motion < FROZEN_MOTION ? CLIP_MESSAGE.Frozen : CLIP_MESSAGE.Kept;

/** What the agent is told about a clip the host did not record. */
export function clipProblemGuidance(problem: PluginStillProblem): string {
  if (problem.code === PluginStillProblemCode.ViewUnknown) return CLIP_MESSAGE.NoDemo;
  if (problem.code === PluginStillProblemCode.Unavailable) return CLIP_MESSAGE.Unavailable;
  return CLIP_MESSAGE.Failed(problem.code, problem.reason);
}

/** The kept clip's video file, by its type. */
export const clipPath = (dir: string, clip: Pick<GenexCoverClip, "mimeType">) =>
  path.join(dir, GENEX_COVER_CLIP_FILE[clip.mimeType as PluginClipMimeType] ?? GENEX_COVER_CLIP_FILE["video/webm"]);

/** Whether a kept clip record is whole: every field typed as written. */
function isClip(value: unknown): value is GenexCoverClip {
  if (!isJsonObject(value)) return false;
  const typed = typeof value.sha256 === "string" && typeof value.takenAt === "string";
  const sized = wholePixels(value.width) && wholePixels(value.height) && wholePixels(value.bytes);
  return (
    typed && sized && wholePixels(value.durationMs) && fraction(value.motion) && CLIP_TYPES.has(String(value.mimeType))
  );
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The clip kept for a game, or null when there is none or its video is gone. */
export async function readClip(dir: string): Promise<GenexCoverClip | null> {
  const clip = await readJsonFile(path.join(dir, CLIP_RECORD));
  if (!isClip(clip)) return null;
  const video = await lstat(clipPath(dir, clip)).catch(() => null);
  return video?.isFile() && video.size === clip.bytes ? clip : null;
}

/** The last clip send for a game, or null. */
export async function readClipSent(dir: string): Promise<GenexCoverSent | null> {
  const sent = await readJsonFile(path.join(dir, CLIP_SENT_RECORD));
  const kinds = new Set<string>(Object.values(GenexCoverOutcome));
  const valid = isJsonObject(sent) && kinds.has(String(sent.kind)) && typeof sent.at === "string";
  return valid ? (sent as unknown as GenexCoverSent) : null;
}

/** Write bytes beside their final name, private, then put them in place in one rename. */
async function writePrivateFile(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(path.dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const handle = await open(temporary, "wx", PRIVATE_FILE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Keep a recording as the game's clip: its video, then its record, then drop a video of the other type. */
export async function saveClip(dir: string, take: CoverClipTake, takenAt: string): Promise<GenexCoverClip> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  const clip: GenexCoverClip = {
    sha256: sha256(take.video),
    mimeType: take.mimeType,
    bytes: take.video.byteLength,
    width: take.width,
    height: take.height,
    durationMs: take.durationMs,
    motion: take.motion,
    takenAt,
  };
  await writePrivateFile(clipPath(dir, clip), take.video);
  await atomicWriteText(path.join(dir, CLIP_RECORD), `${JSON.stringify(clip, null, 2)}\n`, { mode: PRIVATE_FILE });
  for (const [type, name] of Object.entries(GENEX_COVER_CLIP_FILE))
    if (type !== clip.mimeType) await rm(path.join(dir, name), { force: true });
  return clip;
}

/** The kept clip copied to a private file of its own for one send; null when the video is not the one recorded. */
export async function freezeClip(dir: string, clip: GenexCoverClip): Promise<string | null> {
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (name.startsWith(SEND_COPY_PREFIX)) await rm(path.join(dir, name), { force: true });
  const bytes = await readFile(clipPath(dir, clip)).catch(() => null);
  if (!bytes || sha256(bytes) !== clip.sha256) return null;
  const file = path.join(dir, `${SEND_COPY_PREFIX}${randomUUID()}${path.extname(clipPath(dir, clip))}`);
  await writePrivateFile(file, bytes);
  return file;
}

/** Keep the last clip send. */
export async function writeClipSent(dir: string, sent: GenexCoverSent): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await atomicWriteText(path.join(dir, CLIP_SENT_RECORD), `${JSON.stringify(sent, null, 2)}\n`, { mode: PRIVATE_FILE });
}

/** Answers that settle a clip: sending the same bytes again would only get the same answer. */
const SETTLED = new Set<GenexCoverOutcome>([
  GenexCoverOutcome.Applied,
  GenexCoverOutcome.Outranked,
  GenexCoverOutcome.Rejected,
  GenexCoverOutcome.Invalid,
  GenexCoverOutcome.Unchanged,
]);

/** Whether a kept clip goes to Genex: one is kept, and Genex has not settled these bytes. */
export const clipToSend = (clip: GenexCoverClip | null, sent: GenexCoverSent | null): boolean =>
  clip !== null && !(sent?.sha256 === clip.sha256 && SETTLED.has(sent.kind));

/** The last line of the CLI's output that is a JSON object. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stripAnsi(stdout).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isJsonObject(value)) return value;
    } catch {}
  }
  return null;
}

/** `genex cover --clip <file> --json`: the send's record, read by its fields; anything unknown is `failed`. */
export function clipSentRecord(stdout: string, clip: GenexCoverClip, at: string, jobId?: string): GenexCoverSent {
  const value = lastJsonObject(stdout);
  const kind = value?.kind;
  const base = { at, sha256: clip.sha256, ...(jobId ? { jobId } : {}) };
  if (kind === GenexCoverOutcome.Applied || kind === GenexCoverOutcome.Outranked)
    return { ...base, kind, coverUrl: text(value?.clipUrl), coverSource: text(value?.clipSource) };
  if (kind === GenexCoverOutcome.Rejected)
    return { ...base, kind, reason: (text(value?.reason) ?? GenexCoverOutcome.Rejected).slice(0, REASON_CHARS) };
  const message = text(value?.message)?.slice(0, REASON_CHARS);
  const answered = kind === GenexCoverOutcome.Invalid ? GenexCoverOutcome.Invalid : GenexCoverOutcome.Failed;
  return { ...base, kind: answered, ...(message ? { reason: message } : {}) };
}
