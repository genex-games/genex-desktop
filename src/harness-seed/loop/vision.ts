/**
 * The run's vision: what the whole world is meant to grow into, kept apart from the module contract.
 * A world laid out inside the contract (its loop, scale and corners) is frozen with it and never
 * grows, however often the critic asks for a skyline; the contract freezes interfaces and ranges,
 * and the vision holds the ambition ("a skyline far away") the world's builder designs toward.
 *
 * The lead gives it with `plan vision=` (four sections: the world's scale, what the player sees past
 * the nearest building, two or three set-pieces, the headroom it could grow into); the harness holds it
 * to that shape, commits it as docs/VISION.md beside the contract (contract-gate.ts), and every worker
 * brief and every judge of the game reads a bounded excerpt (vision-prompts.ts). It rides on the plan
 * and on the run (`run.vision`), so the journal keeps it and a Resume reads it back.
 *
 * Pure, and a new module: a kept older sibling can never shadow these names.
 */
import { clipWords } from "./word-clip.ts";

/** Where the harness writes the vision, relative to the game: a name of its own, never a game's doc. */
export const VISION_FILE = "docs/VISION.md";

/** The vision's sections, by the key the plan's JSON names them with. Never rename a value. */
export const VisionSection = {
  Scale: "scale",
  Far: "far",
  SetPieces: "set_pieces",
  Headroom: "headroom",
} as const;
export type VisionSection = (typeof VisionSection)[keyof typeof VisionSection];

/** Why a plan's vision was refused: the code the plan's answer is worded from. Never rename a value. */
export const VisionRefusal = {
  NotJson: "not-json",
  NotObject: "not-object",
  Missing: "missing",
} as const;
export type VisionRefusal = (typeof VisionRefusal)[keyof typeof VisionRefusal];

/**
 * How much of each section the vision keeps, cut at a word: the four together stay under
 * `VISION_CHARS` once vision-prompts.ts renders them with their headings.
 */
const SCALE_CHARS = 1_000;
const FAR_CHARS = 1_300;
const SET_PIECE_CHARS = 700;
const HEADROOM_CHARS = 1_100;
/** At most this many set-pieces. */
const MAX_SET_PIECES = 3;
/** The whole docs/VISION.md, at most. */
export const VISION_CHARS = 6_000;

/** The vision as the harness holds it: each section trimmed and cut at a word. */
export interface RunVision {
  scale: string;
  far: string;
  setPieces: string[];
  headroom: string;
}

/** A refused vision: the code, and the sections it lacks (for `missing`). */
export interface VisionProblem {
  code: VisionRefusal;
  missing: VisionSection[];
}

/** A section's text, trimmed and cut at a word; "" when it is not text. */
function sectionText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return clipWords(String(value).trim(), max);
}

/** The set-pieces: one string or a list of them, each trimmed and cut, empty ones dropped, at most three. */
function setPiecesOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((entry) => sectionText(entry, SET_PIECE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SET_PIECES);
}

/** The vision an object carries, every section read whether or not it is there. */
function visionOf(raw: Record<string, unknown>): RunVision {
  return {
    scale: sectionText(raw[VisionSection.Scale], SCALE_CHARS),
    far: sectionText(raw[VisionSection.Far], FAR_CHARS),
    setPieces: setPiecesOf(raw[VisionSection.SetPieces]),
    headroom: sectionText(raw[VisionSection.Headroom], HEADROOM_CHARS),
  };
}

/** The sections a vision leaves empty, in the order the file lists them. */
function missingSections(vision: RunVision): VisionSection[] {
  const missing: VisionSection[] = [];
  if (!vision.scale) missing.push(VisionSection.Scale);
  if (!vision.far) missing.push(VisionSection.Far);
  if (!vision.setPieces.length) missing.push(VisionSection.SetPieces);
  if (!vision.headroom) missing.push(VisionSection.Headroom);
  return missing;
}

/** A JSON field as its value: null when blank, the value when it already is one, undefined when it does not parse. */
function jsonOf(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Is this a plain object (not an array, not null)? */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A plan's `vision`, held to its shape: null when the plan gave none, the vision, or the problem
 * with it — a section left empty is named, never guessed.
 */
export function parseVision(
  raw: unknown,
): { vision: RunVision | null; problem?: undefined } | { problem: VisionProblem; vision?: undefined } {
  const parsed = jsonOf(raw);
  if (parsed === null) return { vision: null };
  if (parsed === undefined) return { problem: { code: VisionRefusal.NotJson, missing: [] } };
  if (!isObject(parsed)) return { problem: { code: VisionRefusal.NotObject, missing: [] } };
  const vision = visionOf(parsed);
  const missing = missingSections(vision);
  if (missing.length) return { problem: { code: VisionRefusal.Missing, missing } };
  return { vision };
}

/** A vision as a journal or a run kept it, held to its shape again; null when it is not a whole one. */
export function restoreVision(value: unknown): RunVision | null {
  if (!isObject(value)) return null;
  const vision = visionOf({
    [VisionSection.Scale]: value.scale,
    [VisionSection.Far]: value.far,
    [VisionSection.SetPieces]: value.setPieces,
    [VisionSection.Headroom]: value.headroom,
  });
  return missingSections(vision).length ? null : vision;
}

/** Anything that may carry a vision: a run, or a record shaped like one. */
export type VisionCarrier = { readonly vision?: unknown; readonly [field: string]: unknown } | null | undefined;

/** The vision a run carries (`run.vision`, set from the plan), or null. */
export function runVision(run: VisionCarrier): RunVision | null {
  return restoreVision(run?.vision);
}

/** Are two visions the same (a re-plan that repeats it commits nothing)? */
export function sameVision(a: RunVision | null | undefined, b: RunVision | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
