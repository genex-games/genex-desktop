/**
 * The facet loop's thresholds: the eight a director may set per worker, and the harness's own
 * patience with a judge and a clock that no plan chooses.
 */
import { CheckOrigin } from "../spec.ts";
import { MINUTE_MS } from "../time.ts";
import { clip, CLIP_QUOTE, CLIP_REASON } from "../text.ts";
import { isPlainRecord } from "../json.ts";
import { polishEscalates } from "./stage.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** Frames an evidence pass takes along its drive, so a judge sees the game move, not one still. */
export const MOTION_FRAMES = 6;

/** How long a follow-up turn on the same session (a review fix, a regression fix) may take. */
export const FOLLOWUP_MS = 12 * MINUTE_MS;

/** What is held back so a build turn about to outrun the clock can be asked to end tidily instead. */
export const WIND_DOWN_MS = 3 * MINUTE_MS;

/** How much of an unknown threshold, or of its value, a refusal quotes. */
const QUOTED_KEY_CHARS = 40;
/** The retired checks a loop state keeps, the latest. */
const RETIRED_CHECKS_KEPT = 12;

/**
 * THE POLICY (M4.10): the eight thresholds a director may set for one worker, and nothing else.
 * They are the shape of the work — how many questions a judge may grow, how long a gap stands
 * before the brief makes it mandatory, how many polished builds pass before the move is —
 * and a run on a game the harness has never seen is exactly when they are wrong. What is NOT
 * here is deliberate: MAX_WOBBLES, MAX_STUCK_ANSWERS, FIX_STUCK_LOSSES, RUNG_MISSES
 * (round-judgement.ts), ITERATION_HEADROOM and MAX_PROMPT_IMAGES are the harness's patience with
 * a judge and a clock, not a plan's choice.
 *
 *  - defectChecksPerIteration: judge defects turned into vision checks per judged round (WP2e)
 *  - maxJudgeChecks: the live cap of judge-grown checks on one facet's board
 *  - fixAfterSameGap: judged builds naming the same biggest gap before it becomes THE FIX
 *    (HARNESS-POSTMORTEM-TREES.md — the trees were "boulders on posts" five rounds running
 *    while every build was accepted on some other flip)
 *  - fixLosesAfter: from this repeat on, a build whose fix check still fails loses
 *  - brokenStreakLimit: unjudgeable builds with one cause before the facet stops (WP1d)
 *  - polishStreakEscalate: accepted builds that only polished before the brief escalates
 *    (HARNESS-POSTMORTEM-VILLAGE.md §5)
 *  - judgeCheckRetirePasses: passes after which a judge-grown check has done its job
 *  - moveAttempts: attempts a planner-written move stands before a fresh one is asked for
 */
export const FACET_POLICY = Object.freeze({
  defectChecksPerIteration: 2,
  maxJudgeChecks: 4,
  fixAfterSameGap: 2,
  fixLosesAfter: 3,
  brokenStreakLimit: 2,
  polishStreakEscalate: 2,
  judgeCheckRetirePasses: 2,
  moveAttempts: 2,
});

/** What each threshold may be set to, inclusive. Outside it the value is clamped, with a warning. */
/** The loop's thresholds, as numbers (a director may set each within its range). */
export type FacetPolicy = { readonly [K in keyof typeof FACET_POLICY]: number };

export const FACET_POLICY_RANGE = Object.freeze({
  defectChecksPerIteration: [0, 4],
  maxJudgeChecks: [0, 12],
  fixAfterSameGap: [1, 6],
  fixLosesAfter: [1, 12],
  brokenStreakLimit: [1, 6],
  polishStreakEscalate: [1, 6],
  judgeCheckRetirePasses: [1, 6],
  moveAttempts: [1, 6],
});

/** A vision check that wobbled this often without settling is marked unmeasured — the judge cannot decide. */
export const MAX_WOBBLES = 2;

/** A judge-grown question hedged this many times running is unanswerable by a picture: it retires (M3.2). */
export const MAX_STUCK_ANSWERS = 2;

/** A fix that lost this many builds is handed to the planner (replan or spike) instead of being asked again. */
export const FIX_STUCK_LOSSES = 2;

/**
 * A director's policy for one worker, read from the string its tool carries. An unknown key is
 * refused by name (a typo that silently did nothing would be worse than a refusal), a
 * non-integer is refused, a value outside its range is clamped with a warning, and a
 * fixLosesAfter below fixAfterSameGap is raised to it — a fix that loses the round before it
 * has ever been asked for is not a policy, it is a contradiction.
 *
 * Returns `{ policy, overrides, warnings }`, or `{ error }` with the sentence the director reads.
 */
export function normalizeFacetPolicy(
  raw: unknown,
):
  | { policy: FacetPolicy; overrides: Record<string, number>; warnings: string[]; error?: undefined }
  | { error: string; policy?: undefined; overrides?: undefined; warnings?: undefined } {
  const warnings: string[] = [];
  const overrides: Record<string, number> = {};
  const read = readPolicyObject(raw);
  if ("error" in read) return { error: read.error };
  if (!read.given) return { policy: FACET_POLICY, overrides, warnings };
  const policy: Record<string, number> = { ...FACET_POLICY };
  for (const [key, value] of Object.entries(read.given)) {
    const threshold = policyThreshold(key, value);
    if ("error" in threshold) return { error: threshold.error };
    if (threshold.warning) warnings.push(threshold.warning);
    policy[key] = threshold.value;
    overrides[key] = threshold.value;
  }
  if (policy.fixLosesAfter < policy.fixAfterSameGap) {
    warnings.push(
      `fixLosesAfter ${policy.fixLosesAfter} is below fixAfterSameGap ${policy.fixAfterSameGap}; using ${policy.fixAfterSameGap}`,
    );
    policy.fixLosesAfter = policy.fixAfterSameGap;
    overrides.fixLosesAfter = policy.fixLosesAfter;
  }
  return { policy: Object.freeze(policy) as FacetPolicy, overrides, warnings };
}

/** The policy as an object of thresholds: none given (null), the object, or why it is not one. */
function readPolicyObject(raw: unknown): { given: object | null } | { error: string } {
  const blank = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (blank) return { given: null };
  let given = raw;
  if (typeof raw === "string") {
    try {
      given = JSON.parse(raw);
    } catch (err: any) {
      return { error: `policy: not JSON — ${String(err?.message ?? err).slice(0, CLIP_QUOTE)}` };
    }
  }
  if (!isPlainRecord(given)) return { error: `policy: a JSON object of thresholds, e.g. {"maxJudgeChecks":6}` };
  return { given };
}

/** One threshold: a known key, a whole number, clamped into its range (with a warning when it was outside). */
function policyThreshold(key: string, value: unknown): { value: number; warning: string | null } | { error: string } {
  if (!Object.hasOwn(FACET_POLICY, key)) {
    return {
      error: `policy: "${String(key).slice(0, QUOTED_KEY_CHARS)}" is not one of this loop's thresholds — ${Object.keys(FACET_POLICY).join(", ")}`,
    };
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n))
    return { error: `policy: ${key} must be a whole number, not "${String(value).slice(0, QUOTED_KEY_CHARS)}"` };
  const [min, max] = FACET_POLICY_RANGE[key as keyof FacetPolicy];
  const clamped = Math.min(max, Math.max(min, n));
  const warning = clamped === n ? null : `${key} ${n} is outside ${min}–${max}; using ${clamped}`;
  return { value: clamped, warning };
}

/**
 * What the loop is doing, as the director can read it (M4.10). A director hands out workers and
 * then goes blind to the machinery deciding their run: which round they are in, whether a gap
 * has become mandatory, how much of the judge-check budget is spent, what a round costs. This is
 * that, as one flat record, emitted at three points of every round.
 */
export function loopStateOf({
  phase = "building",
  round = 0,
  polishStreak = 0,
  loseStreak = 0,
  brokenStreak = null,
  fix = null,
  spec = null,
  retiredChecks = [],
  policy = FACET_POLICY,
  emaBuildMs = null,
  emaAfterMs = null,
  minIterationMs = null,
}: {
  phase?: string;
  round?: number;
  polishStreak?: number;
  loseStreak?: number;
  brokenStreak?: { reason?: string | null; count?: number } | null;
  fix?: AnyRecord | null;
  spec?: { checks?: Array<{ origin?: string } | null>; moveOwner?: unknown; stage?: unknown } | null;
  retiredChecks?: Iterable<string>;
  policy?: FacetPolicy;
  emaBuildMs?: number | null;
  emaAfterMs?: number | null;
  minIterationMs?: number | null;
} = {}) {
  const live = (spec?.checks ?? []).filter((c) => c?.origin === CheckOrigin.Judge).length;
  const estimate = emaBuildMs === null ? minIterationMs : emaBuildMs + (emaAfterMs ?? 0);
  return {
    phase,
    round,
    polishStreak,
    // Whether a polish streak can make this worker's move mandatory at all: never for a
    // director-owned or a finishing worker, so nobody is woken with an escalation that will not come.
    escalates: polishEscalates(spec),
    loseStreak,
    brokenStreak: { reason: brokenStreak?.reason ?? null, count: brokenStreak?.count ?? 0 },
    fix: fix
      ? {
          what: clip(fix.what, CLIP_REASON),
          streak: fix.streak ?? 0,
          mandatory: fix.mandatory === true,
          losses: fix.losses ?? 0,
        }
      : null,
    judgeChecks: {
      live,
      max: policy.maxJudgeChecks,
      perRound: policy.defectChecksPerIteration,
      retired: [...retiredChecks].slice(-RETIRED_CHECKS_KEPT),
    },
    estimateMs: Number.isFinite(estimate) && estimate! > 0 ? Math.round(estimate!) : null,
    emaBuildMs,
    emaAfterMs,
    policy,
  };
}
