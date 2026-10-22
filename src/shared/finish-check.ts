/**
 * The finish check of a Loop: when the lead claims the goal is reached, a reviewer that did none of
 * the work reads the proof and the captures and answers yes or no. Each step of a check is one
 * `finish_check` record of the run, written by the app alone (`main/core/finish-review.ts`, from the
 * reviewer session it seated: the harness asks and settles, never records); the Builds graph and
 * the chat read them. The seed keeps copies of these names (`loop/finish-contract.ts`), held equal
 * by `seed-contracts.test.ts`.
 *
 * Renderer-safe: no Node.
 */
import type { RunScope } from "./custom-events.ts";
import { MINUTE_MS } from "./duration.ts";

/** Where one round of a finish check stands (`finish_check.step`). Persisted: never rename a value. */
export const FinishCheckStep = {
  Checking: "checking",
  Accepted: "accepted",
  Rejected: "rejected",
  Unanswered: "unanswered",
} as const;
export type FinishCheckStep = (typeof FinishCheckStep)[keyof typeof FinishCheckStep];

/**
 * Why a Loop that closed with something still to fix stopped (`run_finished.stillToFix.why`), as its
 * result card tells the person. The seed's copy is in `loop/finish-contract.ts`. Persisted: never
 * rename a value.
 */
export const StopWhy = {
  /** Its hours ran out. */
  Time: "time",
  /** The reviewer's no's in a row stopped it. */
  Stuck: "stuck",
  /** The person stopped it. */
  Person: "person",
  /** It ended some other way. */
  Ended: "ended",
} as const;
export type StopWhy = (typeof StopWhy)[keyof typeof StopWhy];

const STOP_WHYS: ReadonlySet<unknown> = new Set(Object.values(StopWhy));

/**
 * What a Loop that closed without its yes leaves for its result card (`run_finished.stillToFix`,
 * written by the harness at the close): the last no's lists, why it stopped, and its hours.
 */
export interface StillToFix {
  done: string[];
  notDone: string[];
  why: StopWhy;
  /** A timed Loop's hours; null for an ∞ or goal Loop. */
  hours: number | null;
}

/** The words a reviewer's JSON `verdict` answers with (lower-cased). */
const FINISH_VERDICT = { Yes: "yes", No: "no" } as const;

const FINISH_CHECK_STEPS: ReadonlySet<unknown> = new Set(Object.values(FinishCheckStep));

/** Whether a record's `step` is one Genex knows; a reader ignores a record with any other. */
export const isFinishCheckStep = (value: unknown): value is FinishCheckStep => FINISH_CHECK_STEPS.has(value);

/** The reviewer's no's in a row that stop a Loop; an unanswered check neither counts nor breaks the row. */
export const MAX_FINISH_REJECTIONS = 3;
/** The reasons a reviewer's answer keeps at most. */
export const MAX_FINISH_REASONS = 6;
/** How long one reason (or why a check got no answer) reads, in characters. */
export const FINISH_REASON_CHARS = 300;
/**
 * With more of a timed Loop's working time left than this, no row of the reviewer's no's stops it:
 * its lead keeps working on what isn't done. An ∞ Loop names no time left, and its no's stop it.
 */
export const FINISH_TIME_LEFT_MS = 20 * MINUTE_MS;
/** A clip ends at the last space within its cap, when that space leaves at least this share of the cap. */
const CLIP_AT_WORD_SHARE = 0.8;
/** How many `{` of a reply the verdict reader tries as an answer's start, and how many stray `}` after one it skips. */
const VERDICT_STARTS_MAX = 64;
const STRAY_BRACES = 3;

/** Why a reviewer's answer counts as none: persisted in records' `why`, so worded once here. */
const MESSAGE = {
  noVerdict: "its answer said neither yes nor no",
  noReason: "the reviewer named nothing concrete",
} as const;

/** One step of a finish check: the round, where it stands, and what the reviewer read and answered. */
export interface FinishCheckPayload extends RunScope {
  runId: string;
  round: number;
  step: FinishCheckStep;
  /** The lead's claim, clipped. */
  claim?: string;
  /** The names of the files the lead gave as proof. */
  proof?: string[];
  /** The observers whose captures the reviewer read. */
  observers?: string[];
  /** What the reviewer checked and found, met or not (why it said yes, or no). */
  reasons?: string[];
  /** On a no: each thing asked for that the proof doesn't show yet, as the reviewer named it. */
  notDone?: string[];
  /** Each thing asked for that the proof shows, in a few words, as the reviewer named it. */
  done?: string[];
  /** The no's in a row so far. */
  rejections?: number;
  /** This no was the last one the Loop takes: it stops. */
  stopped?: boolean;
  /** On a no: the timed Loop had more than `FINISH_TIME_LEFT_MS` left, so no row of no's stopped it. */
  timeLeft?: boolean;
  /** Why the reviewer could not answer. */
  why?: string;
  reviewer?: { engine: string; model?: string };
  at?: string;
}

/** One `finish_check` record as a reader can place it: its run, round and step, and what it says. */
export interface FinishRecord {
  runId: string;
  round: number;
  step: FinishCheckStep;
  claim: string | null;
  reasons: string[];
  /** What the reviewer found not done; empty for a record that names none (older records name reasons alone). */
  notDone: string[];
  /** What the reviewer found done, in a few words each; empty for a record that names none. */
  done: string[];
  why: string | null;
  stopped: boolean;
  /** A no the Loop had time left at: it went on whatever the row of no's. */
  timeLeft: boolean;
  rejections: number | null;
}

const isRound = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** A record's reasons: none when absent, null when they are not a list of strings. */
function reasonsOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((reason) => typeof reason === "string")) return null;
  return value.filter((reason) => reason.trim());
}

/**
 * A close's `stillToFix` as the chat reads it: null unless its why is known and it names something
 * left; a Loop whose time ran out before any final look lists nothing and still says so.
 */
export function stillToFixOf(value: unknown): StillToFix | null {
  if (typeof value !== "object" || value === null) return null;
  const { done, notDone, why, hours } = value as Record<string, unknown>;
  const left = reasonsOf(notDone);
  if (!left || !STOP_WHYS.has(why)) return null;
  if (!left.length && why !== StopWhy.Time) return null;
  const timed = typeof hours === "number" && Number.isFinite(hours) && hours > 0;
  return { done: reasonsOf(done) ?? [], notDone: left, why: why as StopWhy, hours: timed ? hours : null };
}

/**
 * A `finish_check` record's payload as the Builds graph and the chat read it; null for one they
 * cannot place (no run, a round that is no count from 1, an unknown step, reasons that are not
 * strings). The harness writes these records, so nothing in them is trusted further.
 */
export function finishRecordOf(payload: Record<string, unknown>): FinishRecord | null {
  const { runId, round, step } = payload;
  const reasons = reasonsOf(payload.reasons);
  const placed = typeof runId === "string" && runId !== "" && isRound(round) && isFinishCheckStep(step);
  if (!placed || !reasons) return null;
  return {
    runId,
    round,
    step,
    claim: textOrNull(payload.claim),
    reasons,
    notDone: reasonsOf(payload.notDone) ?? [],
    done: reasonsOf(payload.done) ?? [],
    why: textOrNull(payload.why),
    stopped: payload.stopped === true,
    timeLeft: payload.timeLeft === true,
    rejections: isCount(payload.rejections) ? payload.rejections : null,
  };
}

/** A reviewer's answer read from its reply: yes or no with its reasons and what isn't done, or no answer and why. */
export type ReviewerVerdict =
  | {
      step: typeof FinishCheckStep.Accepted | typeof FinishCheckStep.Rejected;
      reasons: string[];
      notDone: string[];
      done: string[];
    }
  | { step: typeof FinishCheckStep.Unanswered; why: string };

/** A text clipped to `max` characters at a word (inside a long one when none ends near the cap), marked when cut. */
export function clipReason(value: string, max = FINISH_REASON_CHARS): string {
  if (value.length <= max) return value;
  const space = value.lastIndexOf(" ", max);
  const end = space >= max * CLIP_AT_WORD_SHARE ? space : max;
  return `${value.slice(0, end).trimEnd()}…`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A plain JSON object, or null for anything else or text that is not JSON. */
function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The object from `start` to the last `}` of `candidate`, or to one of the few before it, when that is JSON. */
function objectFrom(candidate: string, start: number): Record<string, unknown> | null {
  let end = candidate.lastIndexOf("}");
  for (let tries = 0; end > start && tries <= STRAY_BRACES; tries++) {
    const parsed = parsedObject(candidate.slice(start, end + 1));
    if (parsed) return parsed;
    end = candidate.lastIndexOf("}", end - 1);
  }
  return null;
}

/** The first JSON object in `candidate` that names a `verdict`, trying each `{` in turn; null when none does. */
function verdictObjectIn(candidate: string): Record<string, unknown> | null {
  let start = candidate.indexOf("{");
  for (let tries = 0; start >= 0 && tries < VERDICT_STARTS_MAX; tries++) {
    const parsed = objectFrom(candidate, start);
    if (parsed && "verdict" in parsed) return parsed;
    start = candidate.indexOf("{", start + 1);
  }
  return null;
}

/** The answer in a reviewer's reply: its last fenced block that holds one, else the reply's trailing JSON. */
function answerIn(reply: string): Record<string, unknown> | null {
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? "").reverse();
  for (const candidate of [...fenced, reply]) {
    const answer = verdictObjectIn(candidate);
    if (answer) return answer;
  }
  return null;
}

/** One list of an answer's (its `reasons` or its `notDone`), one line each, at most `MAX_FINISH_REASONS`, each clipped. */
function answerLines(value: unknown): string[] {
  const texts = Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
  return texts
    .map((reason) => clipReason(reason.replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .slice(0, MAX_FINISH_REASONS);
}

/**
 * A reviewer's yes or no from its reply: the JSON `verdict` its brief asks for (fenced or trailing),
 * with its reasons, what isn't done and what is, each a list of its own; a no that names neither of the first two says so.
 * Anything else is no answer.
 */
export function reviewerVerdict(summary: string): ReviewerVerdict {
  const answer = answerIn(String(summary ?? ""));
  const word = typeof answer?.verdict === "string" ? answer.verdict.trim().toLowerCase() : "";
  const reasons = answerLines(answer?.reasons);
  const notDone = answerLines(answer?.notDone);
  const done = answerLines(answer?.done);
  if (word === FINISH_VERDICT.Yes) return { step: FinishCheckStep.Accepted, reasons, notDone, done };
  if (word !== FINISH_VERDICT.No) return { step: FinishCheckStep.Unanswered, why: MESSAGE.noVerdict };
  const named = reasons.length || notDone.length;
  return { step: FinishCheckStep.Rejected, reasons: named ? reasons : [MESSAGE.noReason], notDone, done };
}

/**
 * The reviewer's no's in a row for `runId`, oldest record first: a yes clears the row, a no adds to
 * it, and a check with no answer (or one still checking) neither counts nor breaks it.
 */
export function rejectionsInRow(records: readonly FinishRecord[], runId: string): number {
  let row = 0;
  for (const record of records) {
    if (record.runId !== runId) continue;
    if (record.step === FinishCheckStep.Accepted) row = 0;
    if (record.step === FinishCheckStep.Rejected) row += 1;
  }
  return row;
}
