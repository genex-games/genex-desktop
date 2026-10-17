/**
 * What the composer's context and usage panel says: how full the chat's context is, each
 * subscription's plan by name, when its limits reset, and how close each is to its limit.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import { type ContextUsage, measuresPick } from "../../shared/context.ts";
import { EngineId } from "../../shared/providers.ts";
import { MODEL_KEY_SEPARATOR } from "../model-key.ts";
import { formatDuration, MINUTES_PER_HOUR } from "./loop-duration.ts";

/** A plan's own names, and where its usage lives. */
export const PLAN_PROVIDERS: Readonly<Record<string, { brand: string; usagePage: string }>> = {
  [EngineId.ClaudeCode]: { brand: "Claude", usagePage: "https://claude.ai/settings/usage" },
  [EngineId.Codex]: { brand: "ChatGPT", usagePage: "https://chatgpt.com/codex/settings/usage" },
};

/** A limit this full shows as full, this high as high (percent). */
const LIMIT_FULL = 90;
const LIMIT_HIGH = 75;
/** A reset further off than this is said as a day and time, not a countdown. */
const COUNTDOWN_MINUTES = 24 * MINUTES_PER_HOUR;

/**
 * The plans to draw while usage is still being read: each subscription this setup uses, by name,
 * the main agent's first (its roles keyed by engine id); one unnamed plan when none is known.
 */
export function pendingPlans(usedBy: Readonly<Record<string, readonly string[]>>): Array<string | null> {
  const engines = Object.keys(PLAN_PROVIDERS).filter((engine) => usedBy[engine]?.length);
  const leadFirst = (engine: string): number => (usedBy[engine]?.includes("planner") ? 0 : 1);
  return engines.length ? [...engines].sort((a, b) => leadFirst(a) - leadFirst(b)) : [null];
}

/** "Claude Max plan", "ChatGPT Plus plan", or the brand alone when the plan is not reported. */
export function planWords(engine: string, plan?: string): string {
  const brand = PLAN_PROVIDERS[engine]?.brand ?? engine;
  const word = plan
    ?.replace(/^claude[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return word ? `${brand} ${word.charAt(0).toUpperCase()}${word.slice(1)} plan` : `${brand} plan`;
}

/** "Resets in 2 h 30 m" within a day, "Resets Tue 9:00 AM" after, or null without a reset time. */
export function resetWords(resetsAt: string | undefined, now = Date.now()): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - now) / MINUTE_MS);
  if (minutes < COUNTDOWN_MINUTES) return `Resets in ${formatDuration(Math.max(1, minutes))}`;
  return `Resets ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/** How close a limit is: full, high, or unremarkable (undefined). */
export function limitLevel(percent: number | null): "full" | "high" | undefined {
  if (percent === null) return undefined;
  if (percent >= LIMIT_FULL) return "full";
  return percent >= LIMIT_HIGH ? "high" : undefined;
}

/** How much of the context the chat's orchestrator has used, as the panel reads it. */
export interface ContextReading {
  /** The chat's engine, from the model key. */
  engine: string | undefined;
  used: number | null | undefined;
  capacity: number | undefined;
  /** Percent used, 0–100, or null while nothing was measured. */
  percent: number | null;
  /** The meter's words: how full, or why there is no number yet. */
  summary: string;
}

/**
 * The context reading for the chat's model: the orchestrator's newest measure of that model on
 * that engine, against the window it measured, else the model's own.
 */
export function contextReading(input: {
  modelKey: string | null;
  usage?: ContextUsage | null;
  contexts: ContextUsage[];
  modelWindow?: number;
}): ContextReading {
  const [engine, model] = input.modelKey?.split(MODEL_KEY_SEPARATOR) ?? [];
  /** The planner's reading of the picked model (`measuresPick`), on this engine when the reading names one. */
  const plannerOnModel = (context: ContextUsage): boolean =>
    (!context.role || context.role === "planner") &&
    measuresPick(context, model) &&
    (!context.engine || context.engine === engine);
  const measured = (input.usage ? [input.usage, ...input.contexts] : input.contexts).find(plannerOnModel);
  const capacity = measured?.contextWindow ?? input.modelWindow;
  const used = measured?.promptTokens;
  if (used == null) {
    const summary = measured?.compacted ? "Compacted · measured again after the next reply" : "Not measured yet";
    return { engine, used, capacity, percent: null, summary };
  }
  const share = measured?.percent ?? (capacity ? (used / capacity) * 100 : 0);
  const percent = Math.round(Math.max(0, Math.min(100, share)));
  const about = measured?.source === "estimated" ? "About " : "";
  return { engine, used, capacity, percent, summary: `${about}${percent}% used` };
}
