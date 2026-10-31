/**
 * The game's Genex cover clip, the Genex plugin's half: a few seconds of real play that genex.games
 * runs over the cover on its cards. The game's agent makes it and hands its path to genex__cover
 * beside the picture; Studio checks it (`clip-file.ts`) and keeps a copy in this plugin's storage,
 * `covers/<project>/clip.*`. It is sent with the pinned CLI's
 * `genex cover --clip <file> --commit <sha> --json` after the cover, once a publish is recorded.
 * Genex decides what it keeps (the owner's clip outranks it, frozen or flashing footage is refused).
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
import { PluginClipMimeType } from "../../shared/plugins.ts";
import { atomicWriteText, isJsonObject, replaceFile } from "../../substrate/fsx.ts";
import { stripAnsi } from "./cli.ts";
import type { CoverClipFile } from "./cover.ts";

const CLIP_RECORD = "clip.json";
const CLIP_SENT_RECORD = "clip-sent.json";
const SEND_COPY_PREFIX = ".send-clip-";
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
const REASON_CHARS = 240;

/** Every sentence the clip speaks to the agent. */
export const CLIP_MESSAGE = {
  Kept: "The clip is kept: the next publish sends it after the cover; genex.games plays it over the cover on its cards.",
} as const;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const wholePixels = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const fraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const CLIP_TYPES = new Set<string>(Object.values(PluginClipMimeType));
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The kept clip's video file, by its type. */
export const clipPath = (dir: string, clip: Pick<GenexCoverClip, "mimeType">) =>
  path.join(dir, GENEX_COVER_CLIP_FILE[clip.mimeType as PluginClipMimeType] ?? GENEX_COVER_CLIP_FILE["video/webm"]);

/** Whether a kept clip record is whole: every field typed as written. */
function isClip(value: unknown): value is GenexCoverClip {
  if (!isJsonObject(value)) return false;
  const typed = typeof value.sha256 === "string" && typeof value.takenAt === "string";
  const sized = wholePixels(value.width) && wholePixels(value.height) && wholePixels(value.bytes);
  const motion = value.motion === undefined || fraction(value.motion);
  return typed && sized && motion && wholePixels(value.durationMs) && CLIP_TYPES.has(String(value.mimeType));
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

/** Keep a clip as the game's clip: its video, then its record, then drop a video of the other type. */
export async function saveClip(dir: string, take: CoverClipFile, takenAt: string): Promise<GenexCoverClip> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  const clip: GenexCoverClip = {
    sha256: sha256(take.video),
    mimeType: take.mimeType,
    bytes: take.video.byteLength,
    width: take.width,
    height: take.height,
    durationMs: take.durationMs,
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
