/**
 * The model check (owner decisions D10 and D12): after a playtest with AI, Genex replays the saved
 * AI moments on the creator's own models — their plans, their OpenRouter key, this Mac; never Genex
 * credits — and scores each model's fit (the game's shape, then a judge against the playtest),
 * its cost level and its reply time. The creator picks the recommended model; players then see
 * Best and may-struggle tags. The check is optional: Publish never waits for it.
 *
 * Also the counts-only fit-from-play row (D12's follow-up): with usage-stats consent the broker
 * reports, per game and model, how many replies fit and how many did not, and never any content.
 *
 * Browser-safe; pure.
 */
import { AiDoor, AiFunding, type AiGameKey, type AiModelRef, readAiGameKey, readMember } from "./game-ai.ts";

/** The standard panel's slots: two cheap cloud models, one strong one, two local sizes. Never rename one. */
export const AiPanelSlot = {
  CheapCloud: "cheap-cloud",
  StrongCloud: "strong-cloud",
  LocalSmall: "local-small",
  LocalLarge: "local-large",
} as const;
export type AiPanelSlot = (typeof AiPanelSlot)[keyof typeof AiPanelSlot];

/** The standard panel, slot by slot (D12); each slot is filled from what the creator can run. */
export const AI_CHECK_PANEL: readonly AiPanelSlot[] = [
  AiPanelSlot.CheapCloud,
  AiPanelSlot.CheapCloud,
  AiPanelSlot.StrongCloud,
  AiPanelSlot.LocalSmall,
  AiPanelSlot.LocalLarge,
];

/** The most models one check runs. */
export const AI_CHECK_MAX_MODELS = 12;
/** The fewest moments a model is scored on; fewer leaves it untested. */
export const AI_CHECK_MIN_MOMENTS = 3;
/** The share of moments a model must fit to count as fitting the game. */
export const AI_CHECK_FIT_SHARE = 0.8;
/** A moment's median cost at or under which a model's AI cost level is Low, in USD micros. */
export const AI_COST_LOW_MAX_MICROS = 1_000;
/** A moment's median cost at or under which it is Medium; above it is High. */
export const AI_COST_MEDIUM_MAX_MICROS = 10_000;
/** The longest judge note a row keeps (the creator reads it; players never do). */
export const AI_CHECK_NOTE_MAX_CHARS = 200;

/** How a model fits a game. Wire values: never rename one. */
export const AiCheckFit = {
  Fits: "fits",
  /** It answered outside the game's shape or the judge marked it weak: players get a may-struggle tag. */
  Struggles: "struggles",
  /** Too few moments to say. */
  Untested: "untested",
} as const;
export type AiCheckFit = (typeof AiCheckFit)[keyof typeof AiCheckFit];

/** What AI in a game costs players on a model: "Free", then `$`, `$$`, `$$$`. Wire values: never rename one. */
export const AiCostLevel = { Free: "free", Low: "low", Medium: "medium", High: "high" } as const;
export type AiCostLevel = (typeof AiCostLevel)[keyof typeof AiCostLevel];

/** Where a check stands. Wire values: never rename one. */
export const AiCheckState = {
  /** No playtest with AI yet: nothing to check. */
  Empty: "empty",
  /** Playtested; never checked, or the last check is done. */
  Ready: "ready",
  Checking: "checking",
  Done: "done",
  Failed: "failed",
} as const;
export type AiCheckState = (typeof AiCheckState)[keyof typeof AiCheckState];

/** One model's result. */
export interface AiCheckRow {
  model: AiModelRef;
  /** Its name as the person's model menu shows it. */
  label: string;
  funding: AiFunding;
  /** Moments replayed on it, and how many of its replies fit. */
  moments: number;
  fitted: number;
  fit: AiCheckFit;
  cost: AiCostLevel;
  medianLatencyMs: number | null;
  /** The judge's one line on a struggling model, for the creator. */
  note: string | null;
}

/** A game's check, as Create and Publish read it. */
export interface AiCheckResult {
  project: string;
  state: AiCheckState;
  /** Saved AI moments the check replays. */
  moments: number;
  /** While checking: models done of the set. */
  progress: { done: number; total: number } | null;
  rows: AiCheckRow[];
  /** The creator's pick, which players on Genex credits get. */
  recommended: AiModelRef | null;
  /** When the last check finished (ISO). */
  checkedAt: string | null;
}

/** Two model refs name the same model. */
export const sameModel = (a: AiModelRef, b: AiModelRef): boolean =>
  a.door === b.door && a.engine === b.engine && a.model === b.model;

/**
 * The dynamic check set (D12): the panel's models the creator can run, then every other model they
 * have connected, each once, at most {@link AI_CHECK_MAX_MODELS}. Genex credits are never in it.
 */
export function checkSet(panel: readonly AiModelRef[], connected: readonly AiModelRef[]): AiModelRef[] {
  const set: AiModelRef[] = [];
  for (const model of [...panel, ...connected]) {
    const platform = model.door === AiDoor.GenexCredits || model.door === AiDoor.GenexDev;
    if (platform || set.some((known) => sameModel(known, model))) continue;
    set.push(model);
    if (set.length >= AI_CHECK_MAX_MODELS) break;
  }
  return set;
}

/** How a model fits, from how many of its moments fit. */
export function fitOf(fitted: number, moments: number): AiCheckFit {
  if (!Number.isFinite(moments) || moments < AI_CHECK_MIN_MOMENTS) return AiCheckFit.Untested;
  return fitted / moments >= AI_CHECK_FIT_SHARE ? AiCheckFit.Fits : AiCheckFit.Struggles;
}

/** A model's cost level, from how it is paid and a moment's median cost in USD micros. */
export function costLevelOf(funding: AiFunding, medianMicros: number): AiCostLevel {
  if (funding === AiFunding.Free || funding === AiFunding.Plan || funding === AiFunding.Playtest)
    return AiCostLevel.Free;
  if (medianMicros <= AI_COST_LOW_MAX_MICROS) return AiCostLevel.Low;
  return medianMicros <= AI_COST_MEDIUM_MAX_MICROS ? AiCostLevel.Medium : AiCostLevel.High;
}

/** The models that fit, best first: the pick Publish offers when the creator has not chosen. */
export function bestFits(rows: readonly AiCheckRow[]): AiCheckRow[] {
  const order: readonly AiCostLevel[] = [AiCostLevel.Free, AiCostLevel.Low, AiCostLevel.Medium, AiCostLevel.High];
  return rows
    .filter((row) => row.fit === AiCheckFit.Fits)
    .sort((a, b) => b.fitted / b.moments - a.fitted / a.moments || order.indexOf(a.cost) - order.indexOf(b.cost));
}

/** What Publish shows of a game's AI: the requirement is chosen there, the rest is read. */
export interface AiPublishFacts {
  project: string;
  /** A playtest with AI exists. */
  playtested: boolean;
  /** The model the playtest ran on: "Best with" when there is no check. */
  playtestModel: AiModelRef | null;
  check: AiCheckResult | null;
  /** The model the listing names as best: the creator's pick, the best fit, else the playtest's. */
  bestWith: AiModelRef | null;
  /** How many checked models fit, of how many: null without a check. */
  fits: { fitted: number; of: number } | null;
  /** AI cost for players on credits; null without a check. */
  cost: AiCostLevel | null;
  /** The creator's share of credits players spend on AI in the game, in basis points; null until set (D4). */
  creatorShareBps: number | null;
}

// ── fit from real play (counts only) ───────────────────────────────────────────────────────

/** The longest model id a count row keeps. */
export const AI_FIT_MODEL_MAX_CHARS = 150;
/** A count row's week, ISO (`2026-W43`). */
export const AI_FIT_WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

/** One (game, model, week)'s counts: how many replies fit the game's shape and how many did not. */
export interface AiFitCountRow {
  game: AiGameKey;
  door: AiDoor;
  model: string;
  week: string;
  calls: number;
  fitted: number;
  /** Replies that failed the game's shape even after the one repair. */
  invalid: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const FIT_KEYS = ["game", "door", "model", "week", "calls", "fitted", "invalid"] as const;

/** A count row as main or the server accepts it, or null: exact keys, counts that add up. */
export function readAiFitCountRow(raw: unknown): AiFitCountRow | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields: Record<string, unknown> = { ...raw };
  if (Object.keys(fields).length !== FIT_KEYS.length || !FIT_KEYS.every((key) => Object.hasOwn(fields, key)))
    return null;
  const game = readAiGameKey(fields.game);
  const door = readMember(AiDoor, fields.door);
  const { model, week, calls, fitted, invalid } = fields;
  if (!game || !door || typeof model !== "string" || !model || model.length > AI_FIT_MODEL_MAX_CHARS) return null;
  if (typeof week !== "string" || !AI_FIT_WEEK_RE.test(week)) return null;
  if (!isCount(calls) || !isCount(fitted) || !isCount(invalid) || fitted + invalid > calls) return null;
  return { game, door, model, week, calls, fitted, invalid };
}

/** Rows of the same (game, door, model, week) added together. */
export function mergeFitCounts(rows: readonly AiFitCountRow[]): AiFitCountRow[] {
  const merged = new Map<string, AiFitCountRow>();
  for (const row of rows) {
    const key = JSON.stringify([row.game, row.door, row.model, row.week]);
    const known = merged.get(key);
    merged.set(
      key,
      known
        ? {
            ...known,
            calls: known.calls + row.calls,
            fitted: known.fitted + row.fitted,
            invalid: known.invalid + row.invalid,
          }
        : { ...row },
    );
  }
  return [...merged.values()];
}

// ── the harness bench (`ai.bench`) ─────────────────────────────────────────────────────────

/** The most samples one `ai.bench` takes of a site. */
export const AI_BENCH_MAX_SAMPLES = 5;

/** What `ai.bench` measured of one call site on this Mac's local models. */
export interface AiBenchResult {
  site: string;
  model: AiModelRef | null;
  samples: number;
  /** Samples whose reply fit the game's shape. */
  fitted: number;
  medianLatencyMs: number | null;
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
}
