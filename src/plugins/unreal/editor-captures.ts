/**
 * The Genex editor helper's eyes (genex_build's capture_shot, capture_play and motion_strip, and
 * character_check's picture sheet) answer at once with the files Unreal writes a frame or more
 * later. The bridge waits for those files and hands the agent the picture itself, with the tone
 * numbers it can't judge by eye: a still or a play shot as its PNG, a motion strip as one contact
 * sheet with each frame's pose and how far it moved, a character sheet as one contact sheet with
 * each shot's view.
 *
 * A file is read only when its real path is a regular file inside the project's own
 * Saved/Genex/captures folder: an answer naming anything else (another folder, a link out, a path
 * that climbs out) gets words, never its bytes.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  BLACK_POINT_MAX,
  CONTRAST_MIN,
  contactSheet,
  decodePng,
  encodePng,
  frameDifference,
  type RgbImage,
  type Tone,
  toneGate,
  looksUnlit,
  UNLIT_WHITE_MAX,
  toneOf,
} from "./tone.ts";

/** The helper's build toolset, by its wire name. */
export const BUILD_TOOLSET = "genex_build.tools.GenexBuildTools";
/** The build tools that answer with files to wait for, by their wire names. */
export const CaptureTool = {
  Shot: "capture_shot",
  Play: "capture_play",
  Strip: "motion_strip",
  Character: "character_check",
} as const;
export type CaptureTool = (typeof CaptureTool)[keyof typeof CaptureTool];

/** Where a project's captures land, below its folder. */
const CAPTURES = ["Saved", "Genex", "captures"] as const;
/** How often a pending capture's file is looked for. */
const POLL_MS = 250;
/** How long a still or a play shot may take to land (a still waits out its own delay first). */
const SHOT_WAIT_MS = 45 * SECOND_MS;
/** The longest a strip is waited for, whatever it asks. */
const STRIP_WAIT_MAX_MS = 150 * SECOND_MS;
/**
 * Unreal's automation screenshot writes its file a second time about a second after the first, so a
 * still is read again once this long has passed since it first decoded, when the file changed.
 */
export const SHOT_SETTLE_MS = 1500;
/** The largest capture file read. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** A strip's contact sheet: frames to a row and each frame's width. */
const SHEET_COLUMNS = 3;
const SHEET_CELL_WIDTH = 480;
/** Consecutive frames closer than this (mean abs difference, 0 to 1) show the same picture. */
const SAME_FRAME = 8 / 255;

/** The bridge's clock for waits: `sleep` ends early, without throwing, once the call is cancelled. */
export type CaptureClock = { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> };

const MESSAGE = {
  Unlit: (max: number) =>
    `nearly black (white point under ${max.toFixed(2)}): unless the scene is meant to be this dark, the editor may be rendering it wrong rather than the grade being off; compare it with capture_play, and when play looks different, rebuild_unreal restarts Unreal`,
  NotRead: (file: string, why: string) => `[no image: ${file} ${why}]`,
  Outside: "is not a file in this project's Saved/Genex/captures folder",
  NeverCame: "never arrived",
  Unreadable: (why: string) => `could not be read (${why})`,
  ShotHeader: (name: string, image: RgbImage) => `[capture ${name}, ${image.width}x${image.height}, attached]`,
  StripHeader: (count: number, interval: unknown) =>
    `[motion strip: ${count} frames, ${interval} game s apart, attached as one sheet, left to right then down]`,
  StripError: (why: string) => `The strip stopped early: ${why}.`,
  SheetHeader: (count: number) =>
    `[character sheet: ${count} shots of a copy of the character, attached as one sheet, left to right then down]`,
  SheetLine: (index: number, label: string) => `shot ${index}: ${label}`,
  SheetError: (why: string) => `The sheet stopped early: ${why}.`,
  Fps: (fps: number) => ` at ${fps} fps`,
} as const;

/** The capture tool a forwarded call is, resolved the way Unreal does: case-insensitively, short or qualified. */
export function captureTool(args: Record<string, unknown> | undefined): CaptureTool | undefined {
  const toolset = String(args?.toolset_name ?? "").toLowerCase();
  const tool = String(args?.tool_name ?? "").toLowerCase();
  return Object.values(CaptureTool).find((name) => {
    const short = toolset === BUILD_TOOLSET.toLowerCase() && tool === name;
    return short || tool === `${BUILD_TOOLSET}.${name}`.toLowerCase();
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The helper's answer inside Epic's `{returnValue}` text part (the helper answers JSON text), or undefined. */
export function helperAnswer(parts: Array<{ type: string; text?: unknown }>): Record<string, unknown> | undefined {
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const outer: unknown = JSON.parse(part.text);
      const value = isRecord(outer) ? outer.returnValue : undefined;
      const inner: unknown = typeof value === "string" ? JSON.parse(value) : value;
      if (isRecord(inner)) return inner;
    } catch {
      // Not the helper's JSON: no capture to wait for.
    }
  }
  return undefined;
}

/**
 * The path, when its folder is, by its real path, the project's captures folder, itself reached
 * through no link below the project's folder; else undefined.
 */
async function inCaptures(projectFile: string, file: unknown): Promise<string | undefined> {
  if (typeof file !== "string" || !path.isAbsolute(file)) return undefined;
  const [project, folder, parent] = await Promise.all([
    realpath(path.dirname(projectFile)).catch(() => undefined),
    realpath(path.join(path.dirname(projectFile), ...CAPTURES)).catch(() => undefined),
    realpath(path.dirname(file)).catch(() => undefined),
  ]);
  const own = project !== undefined && folder === path.join(project, ...CAPTURES);
  return own && folder === parent ? file : undefined;
}

/**
 * The full path of a capture in the project's captures folder: a plain file (never a link) of at
 * most MAX_FILE_BYTES; undefined for anything else, a file still missing included.
 */
export async function captureFile(projectFile: string, file: unknown): Promise<string | undefined> {
  const inside = await inCaptures(projectFile, file);
  if (!inside) return undefined;
  const stats = await lstat(inside).catch(() => undefined);
  return stats?.isFile() && stats.size <= MAX_FILE_BYTES ? inside : undefined;
}

/** The file named once it lands in the captures folder, or why it never will be read. */
async function awaitFile(
  projectFile: string,
  file: unknown,
  clock: CaptureClock,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ file: string } | { why: string }> {
  const inside = await inCaptures(projectFile, file);
  if (!inside) return { why: MESSAGE.Outside };
  const ends = clock.now() + waitMs;
  for (;;) {
    const stats = await lstat(inside).catch(() => undefined);
    if (stats) return stats.isFile() && stats.size <= MAX_FILE_BYTES ? { file: inside } : { why: MESSAGE.Outside };
    if (clock.now() >= ends || signal.aborted) return { why: MESSAGE.NeverCame };
    await clock.sleep(POLL_MS, signal);
  }
}

/** A capture file decoded, waiting through a write still in progress; the bytes too. */
async function readFrame(
  file: string,
  clock: CaptureClock,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; image: RgbImage } | { why: string }> {
  const ends = clock.now() + waitMs;
  for (;;) {
    try {
      const bytes = await readFile(file);
      return { bytes, image: decodePng(bytes) };
    } catch (failure) {
      if (clock.now() >= ends || signal.aborted) return { why: MESSAGE.Unreadable(String(failure)) };
      await clock.sleep(POLL_MS, signal);
    }
  }
}

const fixed = (value: number) => value.toFixed(3);
const verdict = (pass: boolean) => (pass ? "pass" : "FAIL");

/** The tone numbers as one line the agent reads beside the picture. */
export function toneLine(tone: Tone): string {
  const gate = toneGate(tone);
  return [
    `tone: black point p2 ${fixed(tone.p2)} (at most ${BLACK_POINT_MAX}: ${verdict(tone.p2 <= BLACK_POINT_MAX)})`,
    `white point p98 ${fixed(tone.p98)}`,
    `contrast std ${fixed(tone.std)} (at least ${CONTRAST_MIN}: ${verdict(tone.std >= CONTRAST_MIN)})`,
    `far std ${fixed(tone.farStd)} against near std ${fixed(tone.nearStd)} (air: ${verdict(tone.farStd < tone.nearStd)})`,
    `saturation ${fixed(tone.saturation)}`,
    `clipped ${fixed(tone.clipped)}`,
    `gate ${gate.pass ? "passed" : `failed on ${gate.fails.join(", ")}`}`,
    ...(looksUnlit(tone) ? [MESSAGE.Unlit(UNLIT_WHITE_MAX)] : []),
  ].join("; ");
}

type Lifted = Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;

const notRead = (file: unknown, why: string): Lifted => [{ type: "text", text: MESSAGE.NotRead(String(file), why) }];

/**
 * A still or a play shot the helper queued, once it landed: its file, its PNG bytes and the picture,
 * or why there is none. `ends` (on the clock), when given, ends every wait of it: a caller with a
 * deadline of its own (`hero-shots`) never waits past it.
 */
export async function landedShot(
  tool: CaptureTool,
  answer: Record<string, unknown>,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
  ends?: number,
): Promise<{ file: string; bytes: Buffer; image: RgbImage } | { why: string }> {
  const waitMs = () => (ends === undefined ? SHOT_WAIT_MS : Math.max(0, Math.min(SHOT_WAIT_MS, ends - clock.now())));
  const landed = await awaitFile(projectFile, answer.file, clock, waitMs(), signal);
  if ("why" in landed) return landed;
  let read = await readFrame(landed.file, clock, waitMs(), signal);
  if (tool === CaptureTool.Shot && "bytes" in read) {
    await clock.sleep(SHOT_SETTLE_MS, signal);
    const again = await readFrame(landed.file, clock, waitMs(), signal);
    if ("bytes" in again) read = again;
  }
  return "why" in read ? read : { file: landed.file, ...read };
}

/** A still or a play shot: its PNG and its tone line. */
async function liftShot(
  tool: CaptureTool,
  answer: Record<string, unknown>,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
): Promise<Lifted> {
  const read = await landedShot(tool, answer, projectFile, clock, signal);
  if ("why" in read) return notRead(answer.file, read.why);
  const fps = typeof answer.fps === "number" ? MESSAGE.Fps(answer.fps) : "";
  const header = `${MESSAGE.ShotHeader(path.basename(read.file), read.image)}${fps}`;
  return [
    { type: "image", mimeType: "image/png", data: read.bytes.toString("base64") },
    { type: "text", text: `${header}\n${toneLine(toneOf(read.image))}` },
  ];
}

type Pose = { gameSeconds?: unknown; fps?: unknown; pawn?: unknown; view?: unknown; pawnYaw?: unknown };

const position = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number") ? value : undefined;

/** How far the pawn moved between two poses, in whole cm, or undefined. */
function moved(before: Pose | undefined, after: Pose): number | undefined {
  const [a, b] = [position(before?.pawn), position(after.pawn)];
  if (!a || !b) return undefined;
  return Math.round(Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0)));
}

const listed = (value: unknown) => {
  const point = position(value);
  return point ? `[${point.join(", ")}]` : "unknown";
};

/** One frame's line: its game time, poses, how far it moved and how much its picture changed. */
function frameLine(index: number, pose: Pose, before: Pose | undefined, difference: number | undefined): string {
  const parts = [
    `frame ${index} at ${pose.gameSeconds} game s`,
    `pawn ${listed(pose.pawn)}`,
    `view ${listed(pose.view)}`,
  ];
  parts.push(`${pose.fps} fps`);
  const distance = moved(before, pose);
  if (distance !== undefined) parts.push(`moved ${distance} cm`);
  if (difference !== undefined) {
    const change = (difference * 255).toFixed(1);
    parts.push(
      difference < SAME_FRAME ? `same picture as the frame before (${change}/255)` : `picture changed ${change}/255`,
    );
  }
  return parts.join(", ");
}

/** A strip's record as the helper writes it: the poses, the frames' files, its interval and why it stopped early. */
type StripRecord = { poses: Pose[]; files: unknown[]; intervalS: unknown; error: string | undefined };

function stripRecord(text: string): StripRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const record = isRecord(parsed) ? parsed : {};
  return {
    poses: Array.isArray(record.frames) ? record.frames : [],
    files: Array.isArray(record.files) ? record.files : [],
    intervalS: record.intervalS,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

/** A frame's line from its index, its record entry and how much it differs from the frame before. */
type FrameLine = (index: number, entry: Pose, difference: number | undefined) => string;

/** The record's frames that could be read, and one line per frame. */
async function recordFrames(
  record: StripRecord,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
  line: FrameLine,
) {
  const frames: RgbImage[] = [];
  const lines: string[] = [];
  for (const [index, entry] of record.poses.entries()) {
    const landed = await awaitFile(projectFile, record.files[index], clock, SHOT_WAIT_MS, signal);
    const read = "file" in landed ? await readFrame(landed.file, clock, SHOT_WAIT_MS, signal) : landed;
    if ("why" in read) {
      lines.push(MESSAGE.NotRead(String(record.files[index]), read.why));
      continue;
    }
    const previous = frames.at(-1);
    lines.push(line(index, entry, previous ? frameDifference(previous, read.image) : undefined));
    frames.push(read.image);
  }
  return { frames, lines };
}

/** The record a strip or a sheet names, once it lands, or why it never will be read. */
async function landedRecord(
  file: unknown,
  waitS: unknown,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
): Promise<{ record: StripRecord } | { why: string }> {
  const waitMs = Math.min(STRIP_WAIT_MAX_MS, Number(waitS ?? 0) * SECOND_MS || STRIP_WAIT_MAX_MS);
  const landed = await awaitFile(projectFile, file, clock, waitMs, signal);
  if ("why" in landed) return landed;
  return { record: stripRecord(await readFile(landed.file, "utf8").catch(() => "")) };
}

/** One contact sheet of the frames and the text beside it. */
function sheetParts(frames: RgbImage[], text: string[]): Lifted {
  if (frames.length === 0) return [{ type: "text", text: text.join("\n") }];
  const sheet = encodePng(contactSheet(frames, SHEET_COLUMNS, SHEET_CELL_WIDTH)).toString("base64");
  return [
    { type: "image", mimeType: "image/png", data: sheet },
    { type: "text", text: text.join("\n") },
  ];
}

/** A strip's frames and poses, read once its record lands: one contact sheet and its lines. */
async function liftStrip(
  answer: Record<string, unknown>,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
): Promise<Lifted> {
  const landed = await landedRecord(answer.poses, answer.waitS, projectFile, clock, signal);
  if ("why" in landed) return notRead(answer.poses, landed.why);
  const { record } = landed;
  const { frames, lines } = await recordFrames(record, projectFile, clock, signal, (index, pose, difference) =>
    frameLine(index, pose, record.poses[index - 1], difference),
  );
  const [first] = frames;
  const text = [MESSAGE.StripHeader(frames.length, record.intervalS ?? answer.intervalS), ...lines];
  if (record.error) text.push(MESSAGE.StripError(record.error));
  if (first) text.push(`first frame ${toneLine(toneOf(first))}`);
  return sheetParts(frames, text);
}

/** A character sheet's shots, read once its record lands: one contact sheet and each shot's view. */
async function liftSheet(
  pictures: Record<string, unknown>,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
): Promise<Lifted> {
  const landed = await landedRecord(pictures.record, pictures.waitS, projectFile, clock, signal);
  if ("why" in landed) return notRead(pictures.record, landed.why);
  const { record } = landed;
  const label = (entry: unknown, index: number) => {
    const named = isRecord(entry) ? entry.label : undefined;
    return typeof named === "string" ? named : `shot ${index}`;
  };
  const { frames, lines } = await recordFrames(record, projectFile, clock, signal, (index, entry) =>
    MESSAGE.SheetLine(index, label(entry, index)),
  );
  const text = [MESSAGE.SheetHeader(frames.length), ...lines];
  if (record.error) text.push(MESSAGE.SheetError(record.error));
  return sheetParts(frames, text);
}

/**
 * The pictures a capture tool's answer promised, as MCP parts to add to the answer: the image (one
 * contact sheet for a strip or a character sheet) and the lines that go with it, or words saying why
 * there is none.
 * Nothing for an answer that queued nothing (a refusal).
 */
export async function liftCapture(
  tool: CaptureTool,
  answer: Record<string, unknown> | undefined,
  projectFile: string,
  clock: CaptureClock,
  signal: AbortSignal,
): Promise<Lifted> {
  if (!answer || answer.error !== undefined) return [];
  if (tool === CaptureTool.Strip)
    return answer.poses === undefined ? [] : liftStrip(answer, projectFile, clock, signal);
  if (tool === CaptureTool.Character)
    return isRecord(answer.pictures) ? liftSheet(answer.pictures, projectFile, clock, signal) : [];
  return answer.queued === true ? liftShot(tool, answer, projectFile, clock, signal) : [];
}
