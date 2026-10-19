/**
 * The lane a page's `genex-ai` (`src/page/ai`) answers on, and the hint Studio's preview gives a
 * page about it. A lane is where answers come from: nowhere (`off`), a saved playtest (`tape`),
 * values made up from the schema (`mock`), main on this Mac (`host`: the Create Live route in
 * Create, the Play view's bridge in Play) or genex.games through `@genex-ai/embed-sdk`
 * (`platform`).
 *
 * The hint only spares a page calls main would refuse: main enforces its own context whatever a
 * page says, so a page that ignores or forges its hint gains nothing. It rides on the shim's script
 * tag (`data-genex-ai`), as JSON {@link AiLaneHint}, and the page reads it through
 * {@link readAiLaneHint} as hostile input (the game's own page could write the attribute).
 *
 * Browser-safe; pure.
 */
import { hasExactKeys, isPlainRecord, readMember } from "./game-ai.ts";
import { isTapeName } from "./game-ai-tape.ts";

/** Where a page's answers come from. Wire values: never rename one. */
export const AiLane = {
  /** No answers: every call fails `ai_off`, and the game plays its fallbacks. */
  Off: "off",
  /** A saved playtest only; a call it does not cover fails `ai_unrecorded`. */
  Tape: "tape",
  /** The saved playtest where it covers the call, else values made up from the schema. */
  Mock: "mock",
  /** Main on this Mac: the Create Live route in Create, the Play view's bridge in Play. */
  Host: "host",
  /** genex.games through `@genex-ai/embed-sdk`: a published game's Genex credits or the player's plan. */
  Platform: "platform",
} as const;
export type AiLane = (typeof AiLane)[keyof typeof AiLane];

/** The shim tag's attribute that carries Studio's lane hint to a preview page ({@link AiLaneHint} as JSON). */
export const AI_LANE_ATTRIBUTE = "data-genex-ai";

/** The lanes Studio's preview may hint; the platform lane is a published game's alone. */
export const PREVIEW_LANES: readonly AiLane[] = [AiLane.Off, AiLane.Tape, AiLane.Mock, AiLane.Host];

/** Studio's hint to a preview page: the lane, and the demo whose saved playtest answers (`ai/tapes/<demo>.jsonl`). */
export interface AiLaneHint {
  lane: AiLane;
  tape: string | null;
}

const HINT_KEYS = ["lane", "tape"] as const satisfies readonly (keyof AiLaneHint)[];
/** The longest hint attribute a page reads. */
export const AI_LANE_HINT_MAX_CHARS = 256;

/** The hint as the shim tag's attribute carries it. */
export const aiLaneHintAttribute = (hint: AiLaneHint): string => JSON.stringify(hint);

function parsedHint(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The shim tag's hint as a page accepts it, or null: exact keys, a preview lane, a demo's name or null. Never throws. */
export function readAiLaneHint(raw: unknown): AiLaneHint | null {
  if (typeof raw !== "string" || raw.length > AI_LANE_HINT_MAX_CHARS) return null;
  const parsed = parsedHint(raw);
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, HINT_KEYS)) return null;
  const lane = readMember(AiLane, parsed.lane);
  const tape = parsed.tape;
  if (!lane || !PREVIEW_LANES.includes(lane)) return null;
  if (tape !== null && !isTapeName(tape)) return null;
  return { lane, tape };
}
