/**
 * Where a verdict came from: which rubric the judge read, which side the challenger sat on, whether
 * its answer could be read at all, and which model gave it. A verdict without these cannot be
 * compared with another one — a judge that answered prose was recorded as a tie, and the A/B
 * placement was a coin nobody wrote down.
 *
 * Also the pin an evaluation profile puts on the judge (`judge/pin.json` in the harness
 * workspace): the engine and model every verdict is asked of, and whether a throttled judge may
 * move to a fallback engine at all. A workspace without the file judges as it always has.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { EngineId } from "./model-roles.ts";
import { isPlainRecord } from "./json.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/**
 * Who asked for a direct model call (`provenance.role` on `engine.complete`, recorded on the
 * host's `completion_call`). The app's copy is `CompletionRole` in `shared/custom-events.ts`
 * (tests/conformance/seed-contracts.test.ts). Persisted: never rename a value.
 */
export const CompletionRole = {
  Judge: "judge",
} as const;
export type CompletionRole = (typeof CompletionRole)[keyof typeof CompletionRole];

/** Whether a judge's answer could be read as the JSON it was asked for. Persisted: never rename a value. */
export const JudgeParse = {
  Valid: "valid",
  Invalid: "invalid",
} as const;
export type JudgeParse = (typeof JudgeParse)[keyof typeof JudgeParse];

/** Which side the build under test was shown on in a blind A/B call. Persisted: never rename a value. */
export const JudgePlacement = {
  ChallengerA: "challenger-a",
  ChallengerB: "challenger-b",
} as const;
export type JudgePlacement = (typeof JudgePlacement)[keyof typeof JudgePlacement];

/** Where the pin lives, relative to the harness workspace. */
export const JUDGE_PIN_FILE = path.join("judge", "pin.json");
/** The largest pin file read; anything bigger is not a pin. */
const JUDGE_PIN_MAX_BYTES = 4096;
/** A model id as a pin may name it: an id, never a sentence or a path outside the id's own shape. */
const PINNED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
/** How many closing braces a judge's JSON may carry past its end and still be read (`readJudgeJson`). */
const STRAY_BRACES = 3;

/** The engine and model every verdict is asked of, and whether a failing judge may fall back. */
export interface JudgePin {
  engine: EngineId | null;
  model: string | null;
  fallback: boolean;
}

/** What one verdict records of its own making. */
export interface JudgeRecord {
  promptSha256: string;
  parse: JudgeParse;
  placement?: JudgePlacement;
  engine: string;
  requestedModel: string | null;
  model: string | null;
  fellBack: boolean;
}

/** The SHA-256 of a prompt's text, hex. */
export function promptSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The placement a shuffle chose: the challenger shown as A, or as B. */
export function placementOf(challengerIsA: boolean): JudgePlacement {
  return challengerIsA ? JudgePlacement.ChallengerA : JudgePlacement.ChallengerB;
}

/** Every fenced block's body, in reply order. */
const FENCED_BLOCK = /```[^\n`]*\n?([\s\S]*?)```/g;

/**
 * The JSON object a judge's reply carries, tolerating prose and a fence around it, and a few stray
 * closing braces after it (golden-boot-glory: a playtester's "yes" closed with one too many and was
 * recorded as no answer); null when there is none. The first fence is read first, as it always
 * was; then the whole reply, for a JSON answer whose own text carries a fence, and each later
 * fence, for a reply that echoed a file in a fence before its answer.
 */
export function readJudgeJson(text: string): AnyRecord | null {
  const first = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const fenced = [...text.matchAll(FENCED_BLOCK)].map((match) => match[1] ?? "");
  for (const candidate of [first, text, ...fenced]) {
    const parsed = objectIn(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/** The object from the first `{` of `candidate` to its last `}`, or to one of the few before it, when that is JSON. */
function objectIn(candidate: string): AnyRecord | null {
  const start = candidate.indexOf("{");
  let end = candidate.lastIndexOf("}");
  for (let tries = 0; start >= 0 && end > start && tries <= STRAY_BRACES; tries++) {
    const parsed = parsedRecord(candidate.slice(start, end + 1));
    if (parsed) return parsed;
    end = candidate.lastIndexOf("}", end - 1);
  }
  return null;
}

/** A plain JSON object, or null for anything else or text that is not JSON. */
function parsedRecord(text: string): AnyRecord | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isEngineId = (value: unknown): value is EngineId =>
  typeof value === "string" && (Object.values(EngineId) as string[]).includes(value);

/** A pin's fields, or null when any field it names is not one a pin may carry. */
export function judgePinOf(value: unknown): JudgePin | null {
  if (!isPlainRecord(value)) return null;
  const { engine, model, fallback } = value;
  if (engine !== undefined && !isEngineId(engine)) return null;
  if (model !== undefined && !(typeof model === "string" && PINNED_MODEL.test(model))) return null;
  if (fallback !== undefined && typeof fallback !== "boolean") return null;
  return { engine: engine ?? null, model: model ?? null, fallback: fallback ?? true };
}

/**
 * The workspace's judge pin, or null when it has none. Read-only: a pin that is a link, a folder,
 * oversized, not JSON or naming anything a pin may not carry is no pin, and judging goes on as
 * the run configured it.
 */
export async function readJudgePin(workspace: string | null | undefined): Promise<JudgePin | null> {
  if (!workspace) return null;
  const file = path.join(workspace, JUDGE_PIN_FILE);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > JUDGE_PIN_MAX_BYTES) return null;
    return judgePinOf(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}
