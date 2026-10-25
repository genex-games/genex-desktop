import { t } from "./i18n.ts";

/** Sanitized account usage. It never contains account identifiers or credentials. */
export interface ProviderUsage {
  measuredAt: string;
  plan?: string;
  windows: Array<{ id: string; label: string; percent: number | null; resetsAt?: string }>;
}
/** Where a subscription's plan limits stand: the one answer the panel, the picker and Settings show. */
export const UsageState = {
  /** A reading is on its way; `usage` is the last one of this same account, if any. */
  Checking: "checking",
  Ready: "ready",
  /** The provider answered and shares no limits for this plan. */
  NotShared: "not_shared",
  /** The read failed or ran out of time; Try again asks once more. */
  Failed: "failed",
  /** The account in use is signed out; Sign in again brings it back. */
  SignedOut: "signed_out",
} as const;
export type UsageState = (typeof UsageState)[keyof typeof UsageState];

/**
 * One subscription and where its plan limits stand. `usage` always belongs to `account`, the
 * account in use: a switch never shows the last account's numbers.
 */
export interface ProviderUsageReport {
  engine: string;
  state: UsageState;
  /** The account in use (`terminal`, `studio`, `account-N`), or null when the engine names none. */
  account: string | null;
  usage: ProviderUsage | null;
}

/**
 * Codex's own id for its main rate-limit bucket (a `rateLimitsByLimitId` key, not a Studio engine
 * id: Codex names the bucket after itself). A bucket without an id reads as that one.
 */
const CODEX_MAIN_LIMIT = "codex";
/** The id prefix of a model-scoped weekly limit (`model_scoped`), such as `model:fable`. */
export const MODEL_LIMIT_PREFIX = "model:";

const percentOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
const resetOf = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? { resetsAt: value } : {};

export function normalizeClaudeUsage(value: unknown, measuredAt = new Date().toISOString()): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  type Window = { utilization?: unknown; resets_at?: unknown };
  const data = value as {
    subscription_type?: unknown;
    rate_limits_available?: boolean;
    rate_limits?: Record<string, unknown> & { model_scoped?: unknown };
  };
  if (!data.rate_limits_available || !data.rate_limits) return null;
  const names: Record<string, string> = {
    five_hour: t("5-hour limit"),
    seven_day: t("Weekly · all models"),
    seven_day_opus: t("Weekly · {model}", { model: "Opus" }),
    seven_day_sonnet: t("Weekly · {model}", { model: "Sonnet" }),
    seven_day_oauth_apps: t("Weekly · connected apps"),
  };
  const windows: ProviderUsage["windows"] = Object.entries(data.rate_limits).flatMap(([id, raw]) => {
    const window = raw as Window | null;
    if (!window || typeof window !== "object" || !names[id]) return [];
    return [{ id, label: names[id], percent: percentOf(window.utilization), ...resetOf(window.resets_at) }];
  });
  // Per-model weekly buckets (for example Fable) arrive only when the plan meters that model.
  const scoped = Array.isArray(data.rate_limits.model_scoped)
    ? (data.rate_limits.model_scoped as Array<Window & { display_name?: unknown }>)
    : [];
  for (const window of scoped) {
    const name = typeof window?.display_name === "string" ? window.display_name.trim() : "";
    const label = t("Weekly · {model}", { model: name });
    if (!name || windows.some((row) => row.label === label)) continue;
    windows.push({
      id: `${MODEL_LIMIT_PREFIX}${name.toLowerCase()}`,
      label,
      percent: percentOf(window.utilization),
      ...resetOf(window.resets_at),
    });
  }
  return {
    measuredAt,
    ...(typeof data.subscription_type === "string" ? { plan: data.subscription_type } : {}),
    windows,
  };
}

function windowName(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return t("Usage limit");
  if (minutes === 10_080) return t("Weekly limit");
  if (minutes % 1_440 === 0) return t("{count, plural, other {#-day limit}}", { count: minutes / 1_440 });
  if (minutes % 60 === 0) return t("{count, plural, other {#-hour limit}}", { count: minutes / 60 });
  return t("{count, plural, other {#-minute limit}}", { count: minutes });
}

/** Codex app-server `account/rateLimits/read`: one bucket per metered limit, each with up to two windows. */
export function normalizeCodexUsage(value: unknown, measuredAt = new Date().toISOString()): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  type Snapshot = {
    limitId?: unknown;
    limitName?: unknown;
    primary?: Window | null;
    secondary?: Window | null;
    planType?: unknown;
  };
  const data = value as {
    rateLimits?: Snapshot | null;
    rateLimitsByLimitId?: Record<string, Snapshot | null | undefined> | null;
  };
  const byId = Object.values(data.rateLimitsByLimitId ?? {}).filter((bucket): bucket is Snapshot =>
    Boolean(bucket && typeof bucket === "object"),
  );
  const single = data.rateLimits && typeof data.rateLimits === "object" ? [data.rateLimits] : [];
  const buckets = byId.length ? byId : single;
  if (!buckets.length) return null;
  const plan = buckets
    .map((bucket) => bucket.planType)
    .find((type): type is string => typeof type === "string" && type.length > 0);
  const windows = buckets.flatMap((bucket) => {
    const id = typeof bucket.limitId === "string" && bucket.limitId ? bucket.limitId : CODEX_MAIN_LIMIT;
    const name = typeof bucket.limitName === "string" ? bucket.limitName.trim() : "";
    const scope = id !== CODEX_MAIN_LIMIT && name ? ` · ${name}` : "";
    return [bucket.primary, bucket.secondary]
      .flatMap((window, slot) => {
        if (!window || typeof window !== "object") return [];
        const minutes =
          typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins)
            ? window.windowDurationMins
            : null;
        const reset =
          typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
            ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() }
            : {};
        return [
          {
            id: `${id}:${minutes ?? slot}`,
            label: `${windowName(minutes)}${scope}`,
            percent: percentOf(window.usedPercent),
            minutes: minutes ?? Infinity,
            ...reset,
          },
        ];
      })
      .sort((a, b) => a.minutes - b.minutes)
      .map(({ minutes: _, ...window }) => window);
  });
  return { measuredAt, ...(plan ? { plan } : {}), windows };
}
