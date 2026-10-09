/**
 * The game's Genex cover, the Genex plugin's half: the one real 16:9 frame genex.games shows for a
 * game (its gallery card, its page, every shared link). Not Studio's own sidebar look
 * (`set_game_cover`), which never leaves this Mac.
 *
 * The frame is the game's own demo named `genex-cover` (`config.demos`), photographed by the host
 * through `observe` with a `still` into this plugin's storage, `covers/<project>/`. It is sent with
 * the pinned CLI's `genex cover <file> --json` after a publish is recorded, or at once by
 * genex__cover-set. Studio never sends a frame nobody staged and never reads the game folder for
 * one; Genex decides everything that matters (who outranks whom, the dark and flat gate, the
 * stored size), so every threshold here is an advisory mirror.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { GenexHostedStatus, GenexPublishKind, type GenexPublishState } from "../../shared/genex.ts";
import { PluginStillProblemCode, type PluginStillProblem } from "../../shared/plugins.ts";
import { CaptureSource, type StillExposure, StillMimeType } from "../../shared/preview-contract.ts";
import { atomicWriteText, isJsonObject, replaceFile } from "../../substrate/fsx.ts";
import { stripAnsi } from "./cli.ts";

/** The demo a game stages its cover in (`config.demos`). */
export const COVER_VIEW = "genex-cover";
/** Mirror of Genex's cover upload limit (the CLI's `COVER_MAX_BYTES`, the API's `COVER_MAX_UPLOAD_BYTES`). */
export const COVER_MAX_BYTES = 8 * 1024 * 1024;
/** What the host is asked for: the genex-cover demo at Genex's recommended 1920×1080, within its limit. */
export const COVER_STILL = { demo: COVER_VIEW, width: 1920, height: 1080, maxBytes: COVER_MAX_BYTES } as const;
/** Mirror of the host's ceiling for one backend call (`CALL_TIMEOUT_MS` in the plugin registry). */
export const INVOCATION_BUDGET_MS = 190 * SECOND_MS;
/** A publish shoots again only with this much of its call left, so its own answer still arrives. */
export const MIN_REMAINING_FOR_SHOT_MS = 75 * SECOND_MS;
/** How long a publish waits for its shot; past it, the last shot is the one sent. */
export const PUBLISH_SHOT_TIMEOUT_MS = 30 * SECOND_MS;
/** How long one cover upload (the CLI's grant, PUT and commit) may take. */
export const COVER_SEND_TIMEOUT_MS = 90 * SECOND_MS;
/** How long asking Genex for the game's current cover may take. */
export const COVER_VIEW_TIMEOUT_MS = 30 * SECOND_MS;

/** Advisory mirror of Genex's gate on a cover's luma (0–1): the server decides, on the encoded frame. */
const GATE = { MinMean: 0.12, MaxNearBlack: 0.85, MinSpread: 0.04 } as const;
/** The cover card's comfort line: a frame that only just clears the gate reads murky on a card. */
const COMFORT = { MinMean: 0.2, MinSpread: 0.08, MaxNearBlack: 0.7 } as const;
/** Mirror of the size Genex stores a cover at: a smaller frame is scaled up and goes soft. */
const STORED = { Width: 1280, Height: 720 } as const;
const WIDE = 16 / 9;
/** How far from 16:9 a frame may be before Genex's centre crop takes a visible slice off it. */
const WIDE_TOLERANCE = 0.01;
/** How much of the page's or the CLI's own words a record keeps. */
const REASON_CHARS = 240;
const AVAILABLE_MAX = 32;
const SHOT_FILE = "shot";
const SHOT_RECORD = "shot.json";
const SENT_RECORD = "sent.json";
/** A send's own copy of the shot it uploads, beside the shot: removed when the send ends. */
const SEND_COPY_PREFIX = ".send-";
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

/** What genex__cover does. */
export const CoverOperation = { Shoot: "shoot", Status: "status" } as const;
export type CoverOperation = (typeof CoverOperation)[keyof typeof CoverOperation];

/**
 * How a cover send ended. The first five are the CLI's own answers (`genex cover <file> --json`
 * `kind`); the rest are Studio's: no shot to send, a frame Genex already answered for, the owner's
 * own pick holding, no hosted project yet, and a publish in the way. Persisted: never rename one.
 */
export const CoverOutcomeKind = {
  Applied: "applied",
  Outranked: "outranked",
  Rejected: "rejected",
  Invalid: "invalid",
  Failed: "failed",
  None: "none",
  Unchanged: "unchanged",
  KeptOwner: "kept_owner",
  NotHosted: "not_hosted",
  Busy: "busy",
} as const;
export type CoverOutcomeKind = (typeof CoverOutcomeKind)[keyof typeof CoverOutcomeKind];
const OUTCOME_KINDS = new Set<string>(Object.values(CoverOutcomeKind));
/** Answers that settle a frame: sending the same bytes again would only get the same answer. */
const FINAL_OUTCOMES = new Set<CoverOutcomeKind>([
  CoverOutcomeKind.Applied,
  CoverOutcomeKind.Outranked,
  CoverOutcomeKind.Rejected,
  CoverOutcomeKind.Invalid,
  CoverOutcomeKind.KeptOwner,
  CoverOutcomeKind.Unchanged,
]);
/** Answers about a frame that was sent, which therefore carry its size advice. */
const SENT_OUTCOMES = new Set<CoverOutcomeKind>([
  CoverOutcomeKind.Applied,
  CoverOutcomeKind.Outranked,
  CoverOutcomeKind.Rejected,
  CoverOutcomeKind.Invalid,
  CoverOutcomeKind.Failed,
]);

/** What a shot's numbers and size suggest before Genex sees it. Advisory: the server decides. */
export const CoverAdvice = {
  TooDark: "too_dark",
  Flat: "flat",
  Dim: "dim",
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

/** The shot kept in `covers/<project>/shot.json`, beside its image. */
export interface CoverShot {
  sha256: string;
  width: number;
  height: number;
  mimeType: StillMimeType;
  bytes: number;
  source: CaptureSource;
  stats: StillExposure;
  takenAt: string;
}

/** Genex's luma numbers on a refused frame, as the CLI reports them (0–1). */
export interface CoverFrameStats {
  mean: number;
  std: number;
  darkShare: number;
}

/** The last send, kept in `covers/<project>/sent.json`: what decides whether a frame is sent again. */
export interface CoverSent {
  kind: CoverOutcomeKind;
  at: string;
  /** The frame this answer is about; absent when there was none. */
  sha256?: string;
  /** The publish whose trailing step sent it; absent for genex__cover-set. */
  jobId?: string;
  coverUrl?: string | null;
  coverSource?: string | null;
  reason?: string;
  stats?: CoverFrameStats | null;
  /** What the person and the agent are told about it: a publish shows these as its warnings. */
  lines?: string[];
  /** For `unchanged`: the answer Genex gave these bytes when they were sent. */
  settled?: CoverOutcomeKind;
}

/** The cover as publish-status, publish.html and genex__cover report it. */
export interface GenexCoverRecord {
  shot: CoverShot | null;
  last: CoverSent | null;
  /** A send is running for this game right now. */
  sending: boolean;
}

/** Publish state as the plugin answers it: the shared record plus this plugin's cover. */
export type GenexPublishView = GenexPublishState & { cover?: GenexCoverRecord };

/**
 * The host's camera for one invocation: a still of the genex-cover demo through `observe`, and
 * when the invocation began on the tools' clock, since host services answer only inside it.
 */
export interface CoverCamera {
  invokedAt: number;
  shoot(): Promise<unknown>;
}

/** The CLI's answer to an upload. */
export type CoverAnswer =
  | {
      kind: typeof CoverOutcomeKind.Applied | typeof CoverOutcomeKind.Outranked;
      coverUrl: string | null;
      coverSource: string | null;
    }
  | { kind: typeof CoverOutcomeKind.Rejected; reason: string; stats: CoverFrameStats | null }
  | { kind: typeof CoverOutcomeKind.Invalid | typeof CoverOutcomeKind.Failed; message: string | null };

/** The game's current cover on Genex and who chose it (`genex cover --json` with no file). */
export interface CoverView {
  coverUrl: string | null;
  coverSource: string | null;
}

/** A still the host took, checked: the encoded image, its numbers and its JPEG preview. */
export interface CoverStill {
  image: Buffer;
  mimeType: StillMimeType;
  width: number;
  height: number;
  source: CaptureSource;
  stats: StillExposure;
  preview: Buffer;
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

/** Every sentence the cover speaks: to the agent in tool answers, and to both in publish warnings. */
export const MESSAGE = {
  PreviewLabel: "The genex-cover shot (preview)",
  BadOperation: "Cover operation must be shoot or status",
  NoShotSent: "No cover frame was sent: this game has no genex-cover shot, so Genex keeps the cover it has.",
  NoTimeToShoot:
    "There was not enough time left in this request to shoot the cover again, so the last genex-cover shot was sent.",
  ShotSkipped: (code: string) =>
    `The cover was not shot again (${code}), so the last genex-cover shot, if any, was sent.`,
  ShotTimedOut: "The cover shot did not finish in time, so the last genex-cover shot, if any, was sent.",
  ShotNotKept: "The new cover shot could not be kept, so the last genex-cover shot, if any, was sent.",
  NoDemoAtPublish:
    "This game has no demo named genex-cover, so no new cover frame was taken; the last genex-cover shot, if any, was sent.",
  Small: (w: number, h: number) =>
    `The cover frame is ${w}×${h}: Genex stores covers at 1280×720 and scales a smaller one up, so it looks soft.`,
  NotWide: (w: number, h: number) => `The cover frame is ${w}×${h}, not 16:9: Genex crops it to its middle 16:9.`,
  TooDark:
    "Genex will likely refuse this frame as too dark (mean brightness under 0.12, or over 85% near-black). Find the game's best-lit honest moment; if it is dark by design, stop: never relight the game for a cover.",
  Flat: "Genex will likely refuse this frame as one flat colour (contrast under 0.04): the canvas may not have drawn, or a fade, a loading screen, sky or fog fills it.",
  Dim: "This frame only just clears Genex's gate and will read murky on a card: where the game's own light allows, aim for brightness 0.2 or more, contrast 0.08 or more and under 70% near-black.",
  Rejected: (reason: string, stats: CoverFrameStats | null) => {
    const numbers = stats
      ? ` (brightness ${percent(stats.mean)}, contrast ${percent(stats.std)}, ${percent(stats.darkShare)} near-black)`
      : "";
    return `Genex did not use the cover frame: it is ${rejectedAs(reason)}${numbers}. The game keeps the cover it had.`;
  },
  Invalid: (message: string | null) =>
    `Genex could not take the cover frame${message ? `: ${message}` : ""}. The game keeps the cover it had.`,
  Failed: (message: string | null) =>
    `The cover frame was not sent${message ? `: ${message}` : ""}. The next publish tries again.`,
  SendTimedOut: "Genex did not answer about the cover in time",
  OwnerHolds:
    "The owner chose this game's cover on genex.games and that choice stands: send nothing, and never ask them to clear it.",
  TermsFirst: "Genex's terms have changed: the user must accept them on genex.games before the cover can be set.",
} as const;

/** What the agent is told about each send outcome. */
export const OUTCOME_GUIDANCE: Record<CoverOutcomeKind, string> = {
  [CoverOutcomeKind.Applied]:
    "Genex uses this frame as the game's cover now. Record the shot in the project's design notes if it keeps them.",
  [CoverOutcomeKind.Outranked]:
    "The owner chose this game's cover on genex.games and that choice stands. Never send another or ask them to clear it.",
  [CoverOutcomeKind.KeptOwner]:
    "The owner chose this game's cover on genex.games, so nothing was uploaded. Never send another or ask them to clear it.",
  [CoverOutcomeKind.Rejected]:
    "Genex refused the frame. Too dark: only if the game has a brighter honest moment, stage that and shoot again; if it is dark by design, stop and never relight it. Flat: wait for the render or reframe. Otherwise fix the file, not the game.",
  [CoverOutcomeKind.Invalid]: "The frame was refused before sending: fix the shot, not the game.",
  [CoverOutcomeKind.Failed]:
    "The frame did not reach Genex (sign-in, the hourly limit or the network). Nothing is wrong with it; the next publish tries again.",
  [CoverOutcomeKind.None]:
    'There is no genex-cover shot to send. Stage the cover as a demo named genex-cover and check it with genex__cover {"operation":"shoot"} first.',
  [CoverOutcomeKind.Unchanged]: "Genex already has this exact frame; nothing was sent.",
  [CoverOutcomeKind.NotHosted]:
    "This game has no hosted Genex project yet, so nothing was sent: the shot goes with the first publish.",
  [CoverOutcomeKind.Busy]:
    'A publish is running for this game, so nothing was sent now. When genex__publish-status says it is done, check genex__cover {"operation":"status"} before sending again.',
};

/** What the agent is told about each still problem the host can answer. */
export const PROBLEM_GUIDANCE: Record<PluginStillProblem["code"], string> = {
  [PluginStillProblemCode.Unavailable]:
    "This Studio window cannot take a cover shot right now. The last shot, if any, is kept.",
  [PluginStillProblemCode.LoadFailed]: "The game did not load for the shot: fix the build, then shoot again.",
  [PluginStillProblemCode.ViewUnknown]:
    'The game has no demo named genex-cover. Add one to config.demos, read genex__skill {"name":"genex-cover"} first.',
  [PluginStillProblemCode.ViewFailed]: "The genex-cover demo failed (reason says how). Fix the demo, then shoot again.",
  [PluginStillProblemCode.CaptureFailed]: "The frame could not be read from the game's window. Shoot again.",
  [PluginStillProblemCode.TooLarge]:
    "Even a JPEG of the frame is over Genex's 8 MB limit: lower the detail the demo stages, then shoot again.",
  [PluginStillProblemCode.Timeout]:
    "The shot did not finish in time: make the genex-cover demo stage faster (no long waits), then shoot again.",
};

/** What the agent is told about when the current shot is sent. */
export const DELIVERY_GUIDANCE: Record<CoverDelivery, string> = {
  [CoverDelivery.FirstPublish]:
    "The first publish (a first draft too) shoots the genex-cover demo again and sends it as the game's Genex cover.",
  [CoverDelivery.NextPublish]:
    "The next publish (a draft too, until the game is public) shoots it again and sends it; genex__cover-set sends this shot now.",
  [CoverDelivery.NextGalleryPublish]:
    "The next Publish shoots it again and sends it (a draft never does); genex__cover-set sends this shot now.",
};

const ADVICE_LINE: Record<CoverAdvice, (shot: Pick<CoverShot, "width" | "height">) => string> = {
  [CoverAdvice.TooDark]: () => MESSAGE.TooDark,
  [CoverAdvice.Flat]: () => MESSAGE.Flat,
  [CoverAdvice.Dim]: () => MESSAGE.Dim,
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
function stillOf(raw: unknown): CoverStill | null {
  if (!isJsonObject(raw)) return null;
  const { image, mimeType, width, height, source, preview } = raw;
  const stats = exposure(raw.stats);
  const sized = wholePixels(width) && wholePixels(height);
  const valid = fitsCover(image, mimeType) && sized && SOURCES.has(String(source)) && isBytes(preview) && stats;
  if (!valid) return null;
  return {
    image: asBuffer(image),
    mimeType: mimeType as StillMimeType,
    width,
    height,
    source: source as CaptureSource,
    stats,
    preview: asBuffer(preview),
  };
}

/** A problem the host named, kept to its typed fields. */
function problemOf(raw: unknown): PluginStillProblem | null {
  if (!isJsonObject(raw) || !PROBLEM_CODES.has(String(raw.code))) return null;
  const problem: PluginStillProblem = { code: raw.code as PluginStillProblem["code"] };
  if (typeof raw.reason === "string") problem.reason = raw.reason.slice(0, REASON_CHARS);
  if (Array.isArray(raw.available))
    problem.available = raw.available
      .filter((name): name is string => typeof name === "string")
      .slice(0, AVAILABLE_MAX);
  return problem;
}

/**
 * The host's answer to a still: the picture, or the problem it named. A host older than stills
 * answers an ordinary observation instead, and a malformed answer is no picture either: both read
 * as `unavailable`, this window cannot take a cover shot.
 */
export function readStillAnswer(answer: unknown): { still: CoverStill } | { problem: PluginStillProblem } {
  const record = isJsonObject(answer) ? answer : {};
  const picture = stillOf(record.still);
  if (picture) return { still: picture };
  return { problem: problemOf(record.stillProblem) ?? { code: PluginStillProblemCode.Unavailable } };
}

/** What a shot's numbers and size suggest, in the order they matter. */
export function coverAdvice(shot: Pick<CoverShot, "width" | "height" | "stats">): CoverAdvice[] {
  const { lumaMean, lumaStdDev, nearBlackFraction } = shot.stats;
  const advice: CoverAdvice[] = [];
  const dark = lumaMean < GATE.MinMean || nearBlackFraction > GATE.MaxNearBlack;
  const flat = lumaStdDev < GATE.MinSpread;
  const dim = lumaMean < COMFORT.MinMean || lumaStdDev < COMFORT.MinSpread || nearBlackFraction >= COMFORT.MaxNearBlack;
  if (dark) advice.push(CoverAdvice.TooDark);
  if (flat) advice.push(CoverAdvice.Flat);
  if (dim && !dark && !flat) advice.push(CoverAdvice.Dim);
  if (shot.width < STORED.Width || shot.height < STORED.Height) advice.push(CoverAdvice.Small);
  if (Math.abs(shot.width / shot.height - WIDE) > WIDE * WIDE_TOLERANCE) advice.push(CoverAdvice.NotWide);
  return advice;
}

/** The sentences for a shot's advice. */
export const adviceLines = (shot: Pick<CoverShot, "width" | "height" | "stats">): string[] =>
  coverAdvice(shot).map((advice) => ADVICE_LINE[advice](shot));

/** A frame Genex has already answered for in a way sending it again cannot change. */
export const isFinalOutcome = (kind: CoverOutcomeKind) => FINAL_OUTCOMES.has(kind);

/** Whether a frame goes to Genex: one is staged, and Genex has not settled these exact bytes. */
export function decideSend(
  shot: CoverShot | null,
  sent: CoverSent | null,
): { send: true } | { send: false; kind: typeof CoverOutcomeKind.None | typeof CoverOutcomeKind.Unchanged } {
  if (!shot) return { send: false, kind: CoverOutcomeKind.None };
  const settled = sent?.sha256 === shot.sha256 && isFinalOutcome(sent.kind);
  return settled ? { send: false, kind: CoverOutcomeKind.Unchanged } : { send: true };
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
function frameStats(value: unknown): CoverFrameStats | null {
  if (!isJsonObject(value)) return null;
  const { mean, std, darkShare } = value;
  const numbers = [mean, std, darkShare].every((n) => typeof n === "number" && Number.isFinite(n));
  return numbers ? ({ mean, std, darkShare } as CoverFrameStats) : null;
}

/**
 * `genex cover <file> --json`: one object whose `kind` is the answer. Read by its fields only; an
 * answer with no known kind, or none at all, is `failed`.
 */
export function parseCoverAnswer(stdout: string): CoverAnswer {
  const value = lastJsonObject(stdout);
  const kind = value?.kind;
  if (!value) return { kind: CoverOutcomeKind.Failed, message: null };
  if (kind === CoverOutcomeKind.Applied || kind === CoverOutcomeKind.Outranked)
    return { kind, coverUrl: text(value.coverUrl), coverSource: text(value.coverSource) };
  if (kind === CoverOutcomeKind.Rejected)
    return { kind, reason: text(value.reason) || CoverOutcomeKind.Rejected, stats: frameStats(value.stats) };
  if (kind === CoverOutcomeKind.Invalid || kind === CoverOutcomeKind.Failed)
    return { kind, message: text(value.message) };
  return { kind: CoverOutcomeKind.Failed, message: null };
}

/** `genex cover --json` with no file: the game's cover and who chose it, or null when the CLI could not say. */
export function parseCoverView(stdout: string): CoverView | null {
  const value = lastJsonObject(stdout);
  if (!value || "kind" in value) return null;
  return { coverUrl: text(value.coverUrl), coverSource: text(value.coverSource) };
}

const jobOf = (jobId: string | undefined) => (jobId ? { jobId } : {});

/** The record of one send, with the lines a publish shows for it. */
export function sentRecord(answer: CoverAnswer, shot: CoverShot, at: string, jobId?: string): CoverSent {
  const record: CoverSent = { kind: answer.kind, at, sha256: shot.sha256, ...jobOf(jobId) };
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
  if (answer.kind === CoverOutcomeKind.Rejected) return [MESSAGE.Rejected(answer.reason, answer.stats)];
  if (answer.kind === CoverOutcomeKind.Invalid) return [MESSAGE.Invalid(message)];
  if (answer.kind === CoverOutcomeKind.Failed) return [MESSAGE.Failed(message)];
  return [];
}

/** A send that found no shot: Genex keeps the cover it has. */
export const noneRecord = (at: string, jobId?: string): CoverSent => ({
  kind: CoverOutcomeKind.None,
  at,
  ...jobOf(jobId),
  lines: [MESSAGE.NoShotSent],
});

/** A send of bytes Genex already settled: nothing goes out, and the answer they got stands. */
export function unchangedRecord(last: CoverSent, at: string, jobId?: string): CoverSent {
  const record: CoverSent = { ...last, kind: CoverOutcomeKind.Unchanged, settled: last.settled ?? last.kind, at };
  delete record.jobId;
  return { ...record, ...jobOf(jobId) };
}

/** The owner's own pick is the cover: nothing was uploaded over it. */
export const keptOwnerRecord = (shot: CoverShot, view: CoverView, at: string, jobId?: string): CoverSent => ({
  kind: CoverOutcomeKind.KeptOwner,
  at,
  sha256: shot.sha256,
  ...jobOf(jobId),
  coverUrl: view.coverUrl,
  coverSource: view.coverSource,
});

/** Why a publish took no new shot, from the problem the host named. */
export function reshootLine(code: PluginStillProblem["code"]): string {
  if (code === PluginStillProblemCode.ViewUnknown) return MESSAGE.NoDemoAtPublish;
  if (code === PluginStillProblemCode.Timeout) return MESSAGE.ShotTimedOut;
  return MESSAGE.ShotSkipped(code);
}

/** What genex__cover status tells the agent to do next. */
export function statusGuidance(shot: CoverShot | null, hosted: CoverView | null, delivery: CoverDelivery): string {
  if (ownerHolds(hosted)) return MESSAGE.OwnerHolds;
  if (!shot) return OUTCOME_GUIDANCE[CoverOutcomeKind.None];
  return DELIVERY_GUIDANCE[delivery];
}

/** The size advice of a frame that went out. */
const sentSizeLines = (kind: CoverOutcomeKind, shot: CoverShot) =>
  SENT_OUTCOMES.has(kind)
    ? coverAdvice(shot)
        .filter((advice) => SIZE_ADVICE.has(advice))
        .map((advice) => ADVICE_LINE[advice](shot))
    : [];

/** One shot's image file, by its type. */
export const shotPath = (dir: string, shot: Pick<CoverShot, "mimeType">) =>
  path.join(dir, `${SHOT_FILE}.${shot.mimeType === StillMimeType.Png ? "png" : "jpg"}`);

/** Whether a kept shot record is whole: every field typed as written. */
function isShot(value: unknown): value is CoverShot {
  if (!isJsonObject(value)) return false;
  const typed = typeof value.sha256 === "string" && typeof value.takenAt === "string";
  const sized = wholePixels(value.width) && wholePixels(value.height) && wholePixels(value.bytes);
  const known = STILL_TYPES.has(String(value.mimeType)) && SOURCES.has(String(value.source));
  return typed && sized && known && exposure(value.stats) !== null;
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The shot kept for a game, or null when there is none or its image is gone. */
export async function readShot(dir: string): Promise<CoverShot | null> {
  const shot = await readJsonFile(path.join(dir, SHOT_RECORD));
  if (!isShot(shot)) return null;
  const image = await lstat(shotPath(dir, shot)).catch(() => null);
  return image?.isFile() && image.size === shot.bytes ? shot : null;
}

/** The last send for a game, or null. */
export async function readSent(dir: string): Promise<CoverSent | null> {
  const sent = await readJsonFile(path.join(dir, SENT_RECORD));
  const valid = isJsonObject(sent) && OUTCOME_KINDS.has(String(sent.kind)) && typeof sent.at === "string";
  return valid ? (sent as unknown as CoverSent) : null;
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

/** Keep a still as the game's shot: its image, then its record, then drop an image of the other type. */
export async function saveShot(dir: string, still: CoverStill, takenAt: string): Promise<CoverShot> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  const shot: CoverShot = {
    sha256: sha256(still.image),
    width: still.width,
    height: still.height,
    mimeType: still.mimeType,
    bytes: still.image.byteLength,
    source: still.source,
    stats: still.stats,
    takenAt,
  };
  await writePrivateFile(shotPath(dir, shot), still.image);
  await atomicWriteText(path.join(dir, SHOT_RECORD), `${JSON.stringify(shot, null, 2)}\n`, { mode: PRIVATE_FILE });
  const other = shot.mimeType === StillMimeType.Png ? StillMimeType.Jpeg : StillMimeType.Png;
  await rm(shotPath(dir, { mimeType: other }), { force: true });
  return shot;
}

/**
 * The kept shot's image, copied to a private file of its own for one send, so a shot taken while
 * the send runs never changes what it uploads or the hash it records. Null when the image on disk
 * is not the one its record names. A copy a stopped Studio left behind is cleared first: one send
 * runs per game at a time.
 */
export async function freezeShot(dir: string, shot: CoverShot): Promise<string | null> {
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (name.startsWith(SEND_COPY_PREFIX)) await rm(path.join(dir, name), { force: true });
  const bytes = await readFile(shotPath(dir, shot)).catch(() => null);
  if (!bytes || sha256(bytes) !== shot.sha256) return null;
  const file = path.join(dir, `${SEND_COPY_PREFIX}${randomUUID()}${path.extname(shotPath(dir, shot))}`);
  await writePrivateFile(file, bytes);
  return file;
}

/** Keep the last send. */
export async function writeSent(dir: string, sent: CoverSent): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await atomicWriteText(path.join(dir, SENT_RECORD), `${JSON.stringify(sent, null, 2)}\n`, { mode: PRIVATE_FILE });
}
