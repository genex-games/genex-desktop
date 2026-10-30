/**
 * The game's Genex cover, the Genex plugin's half: the one 16:9 picture genex.games shows for a
 * game (its gallery card, its page, every shared link), and the optional clip it plays over it. Not
 * Studio's own sidebar look (`set_game_cover`), which never leaves this Mac.
 *
 * The game's agent makes the picture (and the clip) of its real game by any means and hands their
 * paths to genex__cover; Studio checks them (`cover-image.ts`, `clip-file.ts`) and copies them into
 * this plugin's storage, `covers/<project>/`. The picture is sent with the pinned CLI's
 * `genex cover <file> --json` after a publish is recorded, or at once by genex__cover-set; a publish
 * never takes a new one. Until the agent hands one, Studio keeps a plain frame of the game as it
 * loads (`GenexCoverOrigin.Studio`), so Publish always shows a cover; the recent pictures are kept
 * as candidates the person flips between. Genex decides everything that matters (who outranks whom,
 * the dark and flat gate, the stored size), so every threshold here but the size is an advisory mirror.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";
import {
  GENEX_COVER_CANDIDATES_DIR,
  GENEX_COVER_MAX_BYTES,
  GENEX_COVER_SHOT_FILE,
  type GenexCoverAgentTook,
  GenexCoverOrigin,
  type GenexCoverFrameStats,
  GenexCoverOutcome,
  type GenexCoverSent,
  type GenexCoverShot,
  GenexHostedStatus,
  GenexPublishKind,
  type GenexPublishState,
} from "../../shared/genex.ts";
import { PluginStillProblemCode, type PluginStillProblem } from "../../shared/plugins.ts";
import {
  CaptureSource,
  isFlatStill,
  isTooDarkStill,
  type StillExposure,
  StillMimeType,
} from "../../shared/preview-contract.ts";
import {
  atomicWriteText,
  isJsonObject,
  NotARegularFileError,
  readRegularFile,
  replaceFile,
} from "../../substrate/fsx.ts";
import { containedReal } from "../../substrate/paths.ts";
import { stripAnsi } from "./cli.ts";
import { type ClipFile, readClipFile } from "./clip-file.ts";
import { COVER_MIN_SIZE, readCoverImage } from "./cover-image.ts";

/** Mirror of Genex's cover upload limit (the CLI's `COVER_MAX_BYTES`, the API's `COVER_MAX_UPLOAD_BYTES`). */
export const COVER_MAX_BYTES = GENEX_COVER_MAX_BYTES;
/** The largest clip Genex takes beside the cover. */
export const COVER_CLIP_MAX_BYTES = 8 * 1024 * 1024;
/**
 * What the host is asked for when Studio takes its own plain frame of a game whose agent made no
 * cover: the view the game renders itself, at Genex's recommended 1920×1080, within its limit.
 */
export const COVER_FRAME = { camera: "default", width: 1920, height: 1080, maxBytes: COVER_MAX_BYTES } as const;
/** How soon after its last one Studio may take a game's plain frame again on its own. */
export const COVER_AUTO_GAP_MS = 2 * MINUTE_MS;
/** Mirror of the host's ceiling for one backend call (`CALL_TIMEOUT_MS` in the plugin registry). */
export const INVOCATION_BUDGET_MS = 190 * SECOND_MS;
/** How long Studio waits for its own plain frame of a game. */
export const COVER_FRAME_TIMEOUT_MS = 30 * SECOND_MS;
/** How long one cover upload (the CLI's grant, PUT and commit) may take. */
export const COVER_SEND_TIMEOUT_MS = 90 * SECOND_MS;
/** How long asking Genex for the game's current cover may take. */
export const COVER_VIEW_TIMEOUT_MS = 30 * SECOND_MS;

const WIDE = 16 / 9;
/** How far from 16:9 a frame may be before Genex's centre crop takes a visible slice off it. */
const WIDE_TOLERANCE = 0.01;
/** How much of the page's or the CLI's own words a record keeps. */
const REASON_CHARS = 240;
const SHOT_RECORD = "shot.json";
const CANDIDATES_RECORD = "candidates.json";
/** How many recent frames the person can flip between in Publish. */
export const COVER_CANDIDATES_MAX = 4;
/** A candidate's name: the sha256 of its image bytes, nothing a path could hide in. */
const CANDIDATE_SHA = /^[0-9a-f]{64}$/;
const SENT_RECORD = "sent.json";
/** When the agent itself last kept a picture and a clip (`GenexCoverAgentTook`). */
const AGENT_RECORD = "agent.json";
/** A send's own copy of the shot it uploads, beside the shot: removed when the send ends. */
const SEND_COPY_PREFIX = ".send-";
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

const OUTCOME_KINDS = new Set<string>(Object.values(GenexCoverOutcome));
/** Answers that settle a frame: sending the same bytes again would only get the same answer. */
const FINAL_OUTCOMES = new Set<GenexCoverOutcome>([
  GenexCoverOutcome.Applied,
  GenexCoverOutcome.Outranked,
  GenexCoverOutcome.Rejected,
  GenexCoverOutcome.Invalid,
  GenexCoverOutcome.KeptOwner,
  GenexCoverOutcome.Unchanged,
]);
/** Answers about a frame that was sent, which therefore carry its size advice. */
const SENT_OUTCOMES = new Set<GenexCoverOutcome>([
  GenexCoverOutcome.Applied,
  GenexCoverOutcome.Outranked,
  GenexCoverOutcome.Rejected,
  GenexCoverOutcome.Invalid,
  GenexCoverOutcome.Failed,
]);

/** What a picture's numbers and size suggest before Genex sees it. Advisory: the server decides. */
export const CoverAdvice = {
  TooDark: "too_dark",
  Flat: "flat",
  Small: "small",
  NotWide: "not_16_9",
} as const;
export type CoverAdvice = (typeof CoverAdvice)[keyof typeof CoverAdvice];

/** When the current shot reaches Genex. */
export const CoverDelivery = {
  /** No hosted project yet: the first publish, a draft too. */
  FirstPublish: "first_publish",
  /** Hosted but never public: the next publish, a draft too, or genex__cover-set now. */
  NextPublish: "next_publish",
  /** Public: the next gallery publish (never a draft), or genex__cover-set now. */
  NextGalleryPublish: "next_gallery_publish",
} as const;
export type CoverDelivery = (typeof CoverDelivery)[keyof typeof CoverDelivery];

/** The host's camera on the bound game for one invocation: Studio's own plain frame of it, through `observe`. */
export interface CoverCamera {
  shoot(): Promise<unknown>;
}

/** The CLI's answer to an upload. */
export type CoverAnswer =
  | {
      kind: typeof GenexCoverOutcome.Applied | typeof GenexCoverOutcome.Outranked;
      coverUrl: string | null;
      coverSource: string | null;
    }
  | { kind: typeof GenexCoverOutcome.Rejected; reason: string; stats: GenexCoverFrameStats | null }
  | { kind: typeof GenexCoverOutcome.Invalid | typeof GenexCoverOutcome.Failed; message: string | null };

/** The game's current cover on Genex and who chose it (`genex cover --json` with no file). */
export interface CoverView {
  coverUrl: string | null;
  coverSource: string | null;
}

/** A picture to keep as the cover: its encoded bytes and what was read of them. */
export interface CoverFrame {
  image: Buffer;
  mimeType: StillMimeType;
  width: number;
  height: number;
  stats: StillExposure;
  /** How Studio's capture read it; absent for the agent's own picture. */
  source?: CaptureSource;
}

/** A clip to keep beside the cover: its video bytes and what was read of them. */
export type CoverClipFile = ClipFile & { video: Buffer };

/** What genex__cover was handed, read and checked: the picture, and the clip when there is one. */
export interface CoverFiles {
  picture: CoverFrame;
  clip: CoverClipFile | null;
}

/** Who chose a cover, in Genex's words (`coverSource`): the owner's pick outranks every other. */
const OWNER_SOURCE = "owner";

/** Genex's refusal reasons (`cover_rejected`) Studio puts in words; any other is named as it came. */
const REJECTED_AS: Readonly<Record<string, string>> = {
  too_dark: "too dark to read as the game on a gallery card",
  flat: "almost one flat colour",
};
const rejectedAs = (reason: string) =>
  Object.hasOwn(REJECTED_AS, reason) ? REJECTED_AS[reason] : `refused (${reason})`;

const percent = (n: number) => `${Math.round(n * 100)}%`;
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Every sentence the cover speaks: to the agent in tool answers, and to both in publish warnings. */
export const MESSAGE = {
  NoShotSent: "No cover picture was sent: this game has none kept, so Genex keeps the cover it has.",
  /** genex__cover's refusals of what it was handed; nothing is kept when one is refused. */
  NoImage: "Pass image: the path of the cover picture inside this game's folder.",
  NotPath: (field: string) => `${field} must be a path inside this game's folder.`,
  Outside: (field: string) =>
    `${field} must name a file inside this game's folder, not outside it or through a link out.`,
  Missing: (field: string, given: string) => `There is no file at ${given} in this game's folder (${field}).`,
  NotFile: (field: string) => `${field} must name a file, not a folder or anything else.`,
  TooLarge: (field: string, limit: number) => `The ${field} file is over Genex's ${megabytes(limit)} limit.`,
  Small: (w: number, h: number) =>
    `The cover is ${w}×${h}: Genex stores covers at ${COVER_MIN_SIZE.Width}×${COVER_MIN_SIZE.Height} and scales a smaller one up, so it looks soft.`,
  NotWide: (w: number, h: number) => `The cover is ${w}×${h}, not 16:9: Genex crops it to its middle 16:9.`,
  TooDark: "Genex will likely refuse this picture as too dark (mean brightness under 0.11, or over 85% near-black).",
  Flat: "Genex will likely refuse this picture as one flat colour (contrast under 0.04): it may be blank, or a fade or a loading screen.",
  Rejected: (reason: string, stats: GenexCoverFrameStats | null) => {
    const numbers = stats
      ? ` (brightness ${percent(stats.mean)}, contrast ${percent(stats.std)}, ${percent(stats.darkShare)} near-black)`
      : "";
    return `Genex did not use the cover picture: it is ${rejectedAs(reason)}${numbers}. The game keeps the cover it had.`;
  },
  Invalid: (message: string | null) =>
    `Genex could not take the cover picture${message ? `: ${message}` : ""}. The game keeps the cover it had.`,
  Failed: (message: string | null) =>
    `The cover picture was not sent${message ? `: ${message}` : ""}. The next publish tries again.`,
  SendTimedOut: "Genex did not answer about the cover in time",
  OwnerHolds:
    "The owner chose this game's cover on genex.games and that choice stands: send nothing, and never ask them to clear it.",
  /** Publish's refusal of a pick, in the person's words. */
  NoSuchCandidate: () => t("That cover is no longer among this game's recent frames."),
  TermsFirst: "Genex's terms have changed: the user must accept them on genex.games before the cover can be set.",
} as const;

/** What the agent is told about each send outcome. */
export const OUTCOME_GUIDANCE: Record<GenexCoverOutcome, string> = {
  [GenexCoverOutcome.Applied]: "Genex uses this picture as the game's cover now.",
  [GenexCoverOutcome.Outranked]:
    "The owner chose this game's cover on genex.games and that choice stands. Never send another or ask them to clear it.",
  [GenexCoverOutcome.KeptOwner]:
    "The owner chose this game's cover on genex.games, so nothing was uploaded. Never send another or ask them to clear it.",
  [GenexCoverOutcome.Rejected]:
    "Genex refused the picture (its reason and numbers are in the answer); the game keeps the cover it had.",
  [GenexCoverOutcome.Invalid]: "The picture was refused before sending: the answer says why.",
  [GenexCoverOutcome.Failed]:
    "The picture did not reach Genex (sign-in, the hourly limit or the network). Nothing is wrong with it; the next publish tries again.",
  [GenexCoverOutcome.None]:
    'There is no cover picture to send: hand one to genex__cover {"image":"<path in the game folder>"} first.',
  [GenexCoverOutcome.Unchanged]: "Genex already has this exact picture; nothing was sent.",
  [GenexCoverOutcome.NotHosted]:
    "This game has no hosted Genex project yet, so nothing was sent: the picture goes with the first publish.",
  [GenexCoverOutcome.Busy]:
    "A publish is running for this game, so nothing was sent now. When genex__publish-status says it is done, look at its cover before sending again.",
};

/** What the agent is told about when the current shot is sent. */
export const DELIVERY_GUIDANCE: Record<CoverDelivery, string> = {
  [CoverDelivery.FirstPublish]: "The first publish (a first draft too) sends this picture as the game's Genex cover.",
  [CoverDelivery.NextPublish]:
    "The next publish (a draft too, until the game is public) sends it; genex__cover-set sends it now.",
  [CoverDelivery.NextGalleryPublish]: "The next Publish sends it (a draft never does); genex__cover-set sends it now.",
};

const ADVICE_LINE: Record<CoverAdvice, (shot: Pick<GenexCoverShot, "width" | "height">) => string> = {
  [CoverAdvice.TooDark]: () => MESSAGE.TooDark,
  [CoverAdvice.Flat]: () => MESSAGE.Flat,
  [CoverAdvice.Small]: (shot) => MESSAGE.Small(shot.width, shot.height),
  [CoverAdvice.NotWide]: (shot) => MESSAGE.NotWide(shot.width, shot.height),
};
/** Advice a publish's warnings repeat: the size of a frame that went out. Light is Genex's to judge. */
const SIZE_ADVICE = new Set<CoverAdvice>([CoverAdvice.Small, CoverAdvice.NotWide]);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const fraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const wholePixels = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const STILL_TYPES = new Set<string>(Object.values(StillMimeType));
const PROBLEM_CODES = new Set<string>(Object.values(PluginStillProblemCode));
const SOURCES = new Set<string>(Object.values(CaptureSource));
const ORIGINS = new Set<string>(Object.values(GenexCoverOrigin));
const optionalFlag = (value: unknown) => value === undefined || typeof value === "boolean";

/** The exposure numbers of a still or a kept shot, or null when any is missing or out of range. */
function exposure(value: unknown): StillExposure | null {
  if (!isJsonObject(value)) return null;
  const { lumaMean, lumaStdDev, nearBlackFraction, litFraction } = value;
  const all = [lumaMean, lumaStdDev, nearBlackFraction, litFraction].every(fraction);
  return all ? ({ lumaMean, lumaStdDev, nearBlackFraction, litFraction } as StillExposure) : null;
}

/** Whether a still's encoded image fits what was asked: a known type within Genex's limit. */
const fitsCover = (image: unknown, mimeType: unknown): image is Uint8Array =>
  isBytes(image) && image.byteLength > 0 && image.byteLength <= COVER_MAX_BYTES && STILL_TYPES.has(String(mimeType));

/** A well-formed still from the host's answer, or null. */
function stillOf(raw: unknown): CoverFrame | null {
  if (!isJsonObject(raw)) return null;
  const { image, mimeType, width, height, source } = raw;
  const stats = exposure(raw.stats);
  const sized = wholePixels(width) && wholePixels(height);
  const valid = fitsCover(image, mimeType) && sized && SOURCES.has(String(source)) && stats;
  if (!valid) return null;
  return {
    image: asBuffer(image),
    mimeType: mimeType as StillMimeType,
    width,
    height,
    source: source as CaptureSource,
    stats,
  };
}

/** A problem the host named, kept to its code and reason. */
function problemOf(raw: unknown): PluginStillProblem | null {
  if (!isJsonObject(raw) || !PROBLEM_CODES.has(String(raw.code))) return null;
  const problem: PluginStillProblem = { code: raw.code as PluginStillProblem["code"] };
  if (typeof raw.reason === "string") problem.reason = raw.reason.slice(0, REASON_CHARS);
  return problem;
}

/**
 * The host's answer to Studio's plain frame: the picture, or the problem it named. A host older
 * than stills answers an ordinary observation instead, and a malformed answer is no picture either:
 * both read as `unavailable`, this window cannot take a frame.
 */
export function readStillAnswer(answer: unknown): { still: CoverFrame } | { problem: PluginStillProblem } {
  const record = isJsonObject(answer) ? answer : {};
  const picture = stillOf(record.still);
  if (picture) return { still: picture };
  return { problem: problemOf(record.stillProblem) ?? { code: PluginStillProblemCode.Unavailable } };
}

/** What a shot's numbers and size suggest, in the order they matter. */
export function coverAdvice(shot: Pick<GenexCoverShot, "width" | "height" | "stats">): CoverAdvice[] {
  const advice: CoverAdvice[] = [];
  // Advisory: Genex's own gate decides, on the encoded picture.
  if (isTooDarkStill(shot.stats)) advice.push(CoverAdvice.TooDark);
  if (isFlatStill(shot.stats)) advice.push(CoverAdvice.Flat);
  if (shot.width < COVER_MIN_SIZE.Width || shot.height < COVER_MIN_SIZE.Height) advice.push(CoverAdvice.Small);
  if (Math.abs(shot.width / shot.height - WIDE) > WIDE * WIDE_TOLERANCE) advice.push(CoverAdvice.NotWide);
  return advice;
}

/** The sentences for a shot's advice. */
export const adviceLines = (shot: Pick<GenexCoverShot, "width" | "height" | "stats">): string[] =>
  coverAdvice(shot).map((advice) => ADVICE_LINE[advice](shot));

/** A frame Genex has already answered for in a way sending it again cannot change. */
export const isFinalOutcome = (kind: GenexCoverOutcome) => FINAL_OUTCOMES.has(kind);

/** Whether a frame goes to Genex: one is staged, and Genex has not settled these exact bytes. */
export function decideSend(
  shot: GenexCoverShot | null,
  sent: GenexCoverSent | null,
): { send: true } | { send: false; kind: typeof GenexCoverOutcome.None | typeof GenexCoverOutcome.Unchanged } {
  if (!shot) return { send: false, kind: GenexCoverOutcome.None };
  const settled = sent?.sha256 === shot.sha256 && isFinalOutcome(sent.kind);
  return settled ? { send: false, kind: GenexCoverOutcome.Unchanged } : { send: true };
}

/** Whether the owner's own pick is the game's cover: then nothing is uploaded over it. */
export const ownerHolds = (view: CoverView | null) => view?.coverSource === OWNER_SOURCE;

/** Whether a game was ever public on Genex: listed now, or published by Studio before. */
const everPublic = (state: Pick<GenexPublishState, "status" | "lastPublishAt">) =>
  state.status === GenexHostedStatus.Published || state.lastPublishAt !== undefined;

/** Whether a publish shoots and sends the cover: a gallery publish, or a draft of a game never public. */
export const coverRides = (kind: GenexPublishKind, state: Pick<GenexPublishState, "status" | "lastPublishAt">) =>
  kind === GenexPublishKind.Gallery || !everPublic(state);

/** When the current shot reaches Genex, from what Studio knows of the game's pages. */
export function coverDelivery(state: Pick<GenexPublishState, "slug" | "status" | "lastPublishAt">): CoverDelivery {
  if (!state.slug) return CoverDelivery.FirstPublish;
  return everPublic(state) ? CoverDelivery.NextGalleryPublish : CoverDelivery.NextPublish;
}

/** The last line of the CLI's output that is a JSON object; log lines and anything else are skipped. */
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

/** Genex's luma numbers on a refused frame, or null when they are missing or malformed. */
function frameStats(value: unknown): GenexCoverFrameStats | null {
  if (!isJsonObject(value)) return null;
  const { mean, std, darkShare } = value;
  const numbers = [mean, std, darkShare].every((n) => typeof n === "number" && Number.isFinite(n));
  return numbers ? ({ mean, std, darkShare } as GenexCoverFrameStats) : null;
}

/**
 * `genex cover <file> --json`: one object whose `kind` is the answer. Read by its fields only; an
 * answer with no known kind, or none at all, is `failed`.
 */
export function parseCoverAnswer(stdout: string): CoverAnswer {
  const value = lastJsonObject(stdout);
  const kind = value?.kind;
  if (!value) return { kind: GenexCoverOutcome.Failed, message: null };
  if (kind === GenexCoverOutcome.Applied || kind === GenexCoverOutcome.Outranked)
    return { kind, coverUrl: text(value.coverUrl), coverSource: text(value.coverSource) };
  if (kind === GenexCoverOutcome.Rejected)
    return { kind, reason: text(value.reason) || GenexCoverOutcome.Rejected, stats: frameStats(value.stats) };
  if (kind === GenexCoverOutcome.Invalid || kind === GenexCoverOutcome.Failed)
    return { kind, message: text(value.message) };
  return { kind: GenexCoverOutcome.Failed, message: null };
}

/** `genex cover --json` with no file: the game's cover and who chose it, or null when the CLI could not say. */
export function parseCoverView(stdout: string): CoverView | null {
  const value = lastJsonObject(stdout);
  if (!value || "kind" in value) return null;
  return { coverUrl: text(value.coverUrl), coverSource: text(value.coverSource) };
}

const jobOf = (jobId: string | undefined) => (jobId ? { jobId } : {});

/** The record of one send, with the lines a publish shows for it. */
export function sentRecord(answer: CoverAnswer, shot: GenexCoverShot, at: string, jobId?: string): GenexCoverSent {
  const record: GenexCoverSent = { kind: answer.kind, at, sha256: shot.sha256, ...jobOf(jobId) };
  if ("coverUrl" in answer) Object.assign(record, { coverUrl: answer.coverUrl, coverSource: answer.coverSource });
  if ("reason" in answer) Object.assign(record, { reason: answer.reason, stats: answer.stats });
  const message = "message" in answer ? (answer.message?.slice(0, REASON_CHARS) ?? null) : null;
  if (message) record.reason = message;
  const lines = [...outcomeLine(answer, message), ...sentSizeLines(record.kind, shot)];
  if (lines.length) record.lines = lines;
  return record;
}

/** The warning an answer earns: a refusal, a file Genex could not take, or a send that did not land. */
function outcomeLine(answer: CoverAnswer, message: string | null): string[] {
  if (answer.kind === GenexCoverOutcome.Rejected) return [MESSAGE.Rejected(answer.reason, answer.stats)];
  if (answer.kind === GenexCoverOutcome.Invalid) return [MESSAGE.Invalid(message)];
  if (answer.kind === GenexCoverOutcome.Failed) return [MESSAGE.Failed(message)];
  return [];
}

/** A send that found no shot: Genex keeps the cover it has. */
export const noneRecord = (at: string, jobId?: string): GenexCoverSent => ({
  kind: GenexCoverOutcome.None,
  at,
  ...jobOf(jobId),
  lines: [MESSAGE.NoShotSent],
});

/** A send of bytes Genex already settled: nothing goes out, and the answer they got stands. */
export function unchangedRecord(last: GenexCoverSent, at: string, jobId?: string): GenexCoverSent {
  const record: GenexCoverSent = { ...last, kind: GenexCoverOutcome.Unchanged, settled: last.settled ?? last.kind, at };
  delete record.jobId;
  return { ...record, ...jobOf(jobId) };
}

/** The owner's own pick is the cover: nothing was uploaded over it (the kept shot, when there was one). */
export const keptOwnerRecord = (
  shot: GenexCoverShot | null,
  view: CoverView,
  at: string,
  jobId?: string,
): GenexCoverSent => ({
  kind: GenexCoverOutcome.KeptOwner,
  at,
  ...(shot ? { sha256: shot.sha256 } : {}),
  ...jobOf(jobId),
  coverUrl: view.coverUrl,
  coverSource: view.coverSource,
});

/** Genex's view when it says the owner's own pick is the cover, else null. */
export const ownerPick = (view: CoverView | null): CoverView | null => (ownerHolds(view) ? view : null);

/** What genex__cover tells the agent about the kept picture: who holds the cover, else when it goes. */
export function statusGuidance(shot: GenexCoverShot | null, hosted: CoverView | null, delivery: CoverDelivery): string {
  if (ownerHolds(hosted)) return MESSAGE.OwnerHolds;
  if (!shot) return OUTCOME_GUIDANCE[GenexCoverOutcome.None];
  return DELIVERY_GUIDANCE[delivery];
}

/** The size advice of a frame that went out. */
const sentSizeLines = (kind: GenexCoverOutcome, shot: GenexCoverShot) =>
  SENT_OUTCOMES.has(kind)
    ? coverAdvice(shot)
        .filter((advice) => SIZE_ADVICE.has(advice))
        .map((advice) => ADVICE_LINE[advice](shot))
    : [];

/** One shot's image file, by its type (the names Studio's chat card reads it by, `GENEX_COVER_SHOT_FILE`). */
export const shotPath = (dir: string, shot: Pick<GenexCoverShot, "mimeType">) =>
  path.join(dir, GENEX_COVER_SHOT_FILE[shot.mimeType]);

/** Whether a kept shot record is whole: every field typed as written. */
function isShot(value: unknown): value is GenexCoverShot {
  if (!isJsonObject(value)) return false;
  const typed = typeof value.sha256 === "string" && typeof value.takenAt === "string";
  const sized = wholePixels(value.width) && wholePixels(value.height) && wholePixels(value.bytes);
  const sourced = value.source === undefined || SOURCES.has(String(value.source));
  const known = STILL_TYPES.has(String(value.mimeType)) && sourced;
  const marks = (value.origin === undefined || ORIGINS.has(String(value.origin))) && optionalFlag(value.pinned);
  return typed && sized && known && marks && exposure(value.stats) !== null;
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The shot kept for a game, or null when there is none or its image is gone. */
export async function readShot(dir: string): Promise<GenexCoverShot | null> {
  const shot = await readJsonFile(path.join(dir, SHOT_RECORD));
  if (!isShot(shot)) return null;
  const image = await lstat(shotPath(dir, shot)).catch(() => null);
  return image?.isFile() && image.size === shot.bytes ? shot : null;
}

/** The last send for a game, or null. */
export async function readSent(dir: string): Promise<GenexCoverSent | null> {
  const sent = await readJsonFile(path.join(dir, SENT_RECORD));
  const valid = isJsonObject(sent) && OUTCOME_KINDS.has(String(sent.kind)) && typeof sent.at === "string";
  return valid ? (sent as unknown as GenexCoverSent) : null;
}

/** A time the agent record keeps, when it is one. */
const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** When the agent itself last kept a shot and a clip; anything unsound in the record is left out. */
export async function readAgentTook(dir: string): Promise<GenexCoverAgentTook> {
  const kept = await readJsonFile(path.join(dir, AGENT_RECORD));
  if (!isJsonObject(kept)) return {};
  return {
    ...(isTime(kept.shot) ? { shot: kept.shot } : {}),
    ...(isTime(kept.clip) ? { clip: kept.clip } : {}),
  };
}

/** Note that the agent itself kept a shot or a clip at these times; the other kind's time stays. */
export async function noteAgentTook(dir: string, took: GenexCoverAgentTook): Promise<void> {
  const next = { ...(await readAgentTook(dir)), ...took };
  await atomicWriteText(path.join(dir, AGENT_RECORD), `${JSON.stringify(next, null, 2)}\n`, { mode: PRIVATE_FILE });
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

/** Put a shot's image and then its record in place as the kept shot, and drop an image of the other type. */
async function keepShot(dir: string, shot: GenexCoverShot, image: Uint8Array): Promise<GenexCoverShot> {
  await writePrivateFile(shotPath(dir, shot), image);
  await atomicWriteText(path.join(dir, SHOT_RECORD), `${JSON.stringify(shot, null, 2)}\n`, { mode: PRIVATE_FILE });
  const other = shot.mimeType === StillMimeType.Png ? StillMimeType.Jpeg : StillMimeType.Png;
  await rm(shotPath(dir, { mimeType: other }), { force: true });
  return shot;
}

/**
 * Keep a picture as the game's shot, and as the newest of its candidates. `origin` says who made
 * it: a new shot is never pinned, so the person's earlier pick gives way to it.
 */
export async function saveShot(
  dir: string,
  frame: CoverFrame,
  takenAt: string,
  origin: GenexCoverOrigin = GenexCoverOrigin.Demo,
): Promise<GenexCoverShot> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  const shot: GenexCoverShot = {
    sha256: sha256(frame.image),
    width: frame.width,
    height: frame.height,
    mimeType: frame.mimeType,
    bytes: frame.image.byteLength,
    ...(frame.source ? { source: frame.source } : {}),
    stats: frame.stats,
    takenAt,
    ...(origin === GenexCoverOrigin.Studio ? { origin } : {}),
  };
  await keepShot(dir, shot, frame.image);
  await addCandidate(dir, shot, frame.image);
  return shot;
}

/** Where a game's candidates live, and one candidate's image by its type. */
const candidatesDir = (dir: string) => path.join(dir, GENEX_COVER_CANDIDATES_DIR);
const candidatePath = (dir: string, shot: Pick<GenexCoverShot, "sha256" | "mimeType">) =>
  path.join(candidatesDir(dir), `${shot.sha256}${path.extname(GENEX_COVER_SHOT_FILE[shot.mimeType])}`);

/** The recorded candidates, newest first: whole records named by a sha256 only, the pin left off. */
async function candidateRecords(dir: string): Promise<GenexCoverShot[]> {
  const listed = await readJsonFile(path.join(dir, CANDIDATES_RECORD));
  if (!Array.isArray(listed)) return [];
  return listed
    .filter((entry): entry is GenexCoverShot => isShot(entry) && CANDIDATE_SHA.test(entry.sha256))
    .map(({ pinned: _pinned, ...shot }) => shot)
    .slice(0, COVER_CANDIDATES_MAX);
}

/** Add a kept shot to the front of the candidates; the oldest past {@link COVER_CANDIDATES_MAX} goes, image and all. */
async function addCandidate(dir: string, shot: GenexCoverShot, image: Uint8Array): Promise<void> {
  await mkdir(candidatesDir(dir), { recursive: true, mode: PRIVATE_DIR });
  const before = await candidateRecords(dir);
  const { pinned: _pinned, ...entry } = shot;
  const listed = [entry, ...before.filter((c) => c.sha256 !== shot.sha256)];
  const kept = listed.slice(0, COVER_CANDIDATES_MAX);
  await writePrivateFile(candidatePath(dir, shot), image);
  await atomicWriteText(path.join(dir, CANDIDATES_RECORD), `${JSON.stringify(kept, null, 2)}\n`, {
    mode: PRIVATE_FILE,
  });
  for (const gone of listed.slice(COVER_CANDIDATES_MAX)) await rm(candidatePath(dir, gone), { force: true });
}

/** The candidates whose images are still there as recorded, newest first. */
export async function readCandidates(dir: string): Promise<GenexCoverShot[]> {
  const records = await candidateRecords(dir);
  const present = await Promise.all(
    records.map(async (shot) => {
      const image = await lstat(candidatePath(dir, shot)).catch(() => null);
      return image?.isFile() && image.size === shot.bytes ? shot : null;
    }),
  );
  return present.filter((shot) => shot !== null);
}

/**
 * Make one candidate the kept shot, pinned: the person chose it, so neither Studio nor a publish
 * shoots a new frame over it. Null when no candidate by that sha256 is whole on disk.
 */
export async function pickCandidate(dir: string, sha: unknown): Promise<GenexCoverShot | null> {
  if (typeof sha !== "string" || !CANDIDATE_SHA.test(sha)) return null;
  const candidate = (await readCandidates(dir)).find((shot) => shot.sha256 === sha);
  if (!candidate) return null;
  const image = await readFile(candidatePath(dir, candidate)).catch(() => null);
  if (!image || sha256(image) !== candidate.sha256) return null;
  return keepShot(dir, { ...candidate, pinned: true }, image);
}

/**
 * The kept shot's image, copied to a private file of its own for one send, so a shot taken while
 * the send runs never changes what it uploads or the hash it records. Null when the image on disk
 * is not the one its record names. A copy a stopped Studio left behind is cleared first: one send
 * runs per game at a time.
 */
export async function freezeShot(dir: string, shot: GenexCoverShot): Promise<string | null> {
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (name.startsWith(SEND_COPY_PREFIX)) await rm(path.join(dir, name), { force: true });
  const bytes = await readFile(shotPath(dir, shot)).catch(() => null);
  if (!bytes || sha256(bytes) !== shot.sha256) return null;
  const file = path.join(dir, `${SEND_COPY_PREFIX}${randomUUID()}${path.extname(shotPath(dir, shot))}`);
  await writePrivateFile(file, bytes);
  return file;
}

/** Keep the last send. */
export async function writeSent(dir: string, sent: GenexCoverSent): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await atomicWriteText(path.join(dir, SENT_RECORD), `${JSON.stringify(sent, null, 2)}\n`, { mode: PRIVATE_FILE });
}

// ── what genex__cover is handed ──────────────────────────────────────────────────────────────

/** A path the agent gave, as one relative to the game folder: an absolute one inside it is taken too. */
function gameRelative(directory: string, given: string): string {
  const relative = path.isAbsolute(given) ? path.relative(directory, given) : given.replace(/^(\.\/)+/, "");
  return relative.split(path.sep).join("/");
}

/** Why a file named for genex__cover could not be read, in the agent's words. */
function readRefusal(error: unknown, field: string, given: string, limit: number): string {
  if (error instanceof NotARegularFileError)
    return error.code === "EFBIG" ? MESSAGE.TooLarge(field, limit) : MESSAGE.NotFile(field);
  const code = isJsonObject(error) ? error.code : undefined;
  return code === "ENOENT" ? MESSAGE.Missing(field, given) : MESSAGE.Outside(field);
}

/**
 * The bytes of the file `given` names inside the game folder `directory`: a regular file reached
 * through no link out of the folder, at most `limit` bytes. Throws the agent's refusal otherwise.
 */
async function gameFile(directory: string, field: string, given: unknown, limit: number): Promise<Buffer> {
  if (typeof given !== "string" || !given.trim()) throw new Error(MESSAGE.NotPath(field));
  try {
    return await readRegularFile(await containedReal(directory, gameRelative(directory, given)), limit);
  } catch (error) {
    throw new Error(readRefusal(error, field, given, limit));
  }
}

/**
 * What genex__cover was handed, read from the game folder and checked whole before anything is
 * kept: the picture (PNG or JPEG, at least 1280×720, within Genex's limit) and the optional clip
 * (WebM or MP4, at least five seconds). Any refusal throws, and nothing has been written.
 */
export async function readCoverFiles(
  directory: string,
  args: { image?: unknown; clip?: unknown },
): Promise<CoverFiles> {
  if (args.image === undefined) throw new Error(MESSAGE.NoImage);
  const image = await gameFile(directory, "image", args.image, COVER_MAX_BYTES);
  const picture = readCoverImage(image);
  if ("refused" in picture) throw new Error(picture.refused);
  if (args.clip === undefined || args.clip === null) return { picture: { image, ...picture }, clip: null };
  const video = await gameFile(directory, "clip", args.clip, COVER_CLIP_MAX_BYTES);
  const clip = readClipFile(video);
  if ("refused" in clip) throw new Error(clip.refused);
  return { picture: { image, ...picture }, clip: { video, ...clip } };
}
