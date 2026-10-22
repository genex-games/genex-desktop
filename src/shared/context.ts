import { CustomEvent, customPayload, type CustomEventData } from "./custom-events.ts";
import { EngineId } from "./providers.ts";
import { t } from "./i18n.ts";
/** Where a context reading came from, most trustworthy first. Recorded in logs: never rename a value. */
export const ContextSource = {
  Provider: "provider",
  ProviderSession: "provider-session",
  NativeTokenizer: "native-tokenizer",
  Estimated: "estimated",
  Unavailable: "unavailable",
} as const;
export type ContextSource = (typeof ContextSource)[keyof typeof ContextSource];

/** Context is scoped to a selected provider/model and a specific measured session. */
export interface ContextPolicy {
  mode: "default" | "custom";
  thresholdPercent?: number;
}
export interface ContextMeasurement {
  engine: string;
  requestedModel?: string | null;
  model?: string | null;
  sessionId?: string;
  role?: "planner" | "builder" | "judge";
  percent?: number | null;
  promptTokens?: number;
  contextWindow?: number | null;
  hardLimitTokens?: number;
  reservedOutputTokens?: number;
  imageReserveTokens?: number;
  source?: ContextSource;
  phase?: string;
  thresholdTokens?: number;
  compacted?: boolean;
  measuredAt?: string;
  lastCompactedAt?: string;
}
/** A context meter's reading: how full a session's window is, and whose session it is. */
export type ContextUsage = Partial<
  Pick<
    ContextMeasurement,
    | "promptTokens"
    | "contextWindow"
    | "percent"
    | "model"
    | "engine"
    | "requestedModel"
    | "source"
    | "sessionId"
    | "compacted"
    | "role"
  >
>;
export interface ContextSettings {
  policy: ContextPolicy;
  inherited: boolean;
  owner: "provider" | "studio";
  configurable: boolean;
  reason?: string;
  defaultPercent?: number;
}
/** The auto-compaction threshold a custom policy may choose, in percent of the window. */
const MIN_THRESHOLD_PERCENT = 5;
const MAX_THRESHOLD_PERCENT = 95;

export function validateContextPolicy(input: unknown): ContextPolicy {
  const p = input as ContextPolicy;
  if (p?.mode === "default") return { mode: "default" };
  const threshold = p?.thresholdPercent;
  const inRange =
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    threshold >= MIN_THRESHOLD_PERCENT &&
    threshold <= MAX_THRESHOLD_PERCENT;
  if (p?.mode !== "custom" || !inRange) throw new Error(t("Choose an auto-compaction threshold between 5% and 95%."));
  return { mode: "custom", thresholdPercent: p.thresholdPercent };
}

/** The model id that stands for the engine's own default: the pick that sends no model. Recorded in logs: never rename. */
export const DEFAULT_MODEL_ID = "default";

type ContextEvent = { created_at?: string; data: CustomEventData };
type MeasurementKey = { engine?: string; role?: string; requestedModel?: string | null; model?: string | null };
type Matches = (p: MeasurementKey) => p is ContextMeasurement;

/**
 * Whether a reading was taken for the chat's picked model, the one rule every context meter
 * applies. A pick of "" is the default pick. A reading belongs to the pick it was recorded for,
 * else to the model it measured, else (naming neither) to the engine's default.
 */
export function measuresPick(
  reading: Pick<MeasurementKey, "requestedModel" | "model">,
  pick: string | undefined,
): boolean {
  return (pick || DEFAULT_MODEL_ID) === (reading.requestedModel ?? reading.model ?? DEFAULT_MODEL_ID);
}

/** The session a delegated engine last started for this conversation, if its trace says so. */
function expectedSessionOf(events: readonly ContextEvent[], engine: string, matches: Matches): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const p = event ? customPayload(event.data, `delegated.${engine}`) : null;
    if (p?.kind === "system" && p.data?.subtype === "init" && matches({ ...p, engine })) return p.data.session_id;
  }
  return undefined;
}

/** Does this record end what an older reading measured: a compaction, a rewind, or a fresh session? */
function resetsMeasurement(data: CustomEventData, engine: string, model: string, matches: Matches): boolean {
  // A rewind drops the measured session; the next turn starts a fresh one.
  if (customPayload(data, CustomEvent.ConversationRewound)) return true;
  const compacted = customPayload(data, CustomEvent.Compacted);
  if (compacted) {
    const sameEngine = compacted.engine === engine || (!compacted.engine && engine === EngineId.Ollama);
    if (sameEngine && (!compacted.requestedModel || compacted.requestedModel === model)) return true;
  }
  const delegated = customPayload(data, `delegated.${engine}`);
  return Boolean(
    delegated?.kind === "system" && delegated.data?.subtype === "init" && matches({ ...delegated, engine }),
  );
}

/**
 * The last compaction before reading `i`. A later usage sample must not erase a known checkpoint.
 * Link only the same measured session; a missing identity is not permission to borrow another
 * conversation's history.
 */
function lastCompactionBefore(
  events: readonly ContextEvent[],
  i: number,
  reading: ContextMeasurement,
  matches: Matches,
): string | undefined {
  for (let j = i; j >= 0; j--) {
    const e = events[j];
    const prior = e ? customPayload(e.data, CustomEvent.ContextUsage) : null;
    if (!prior?.compacted || !matches(prior)) continue;
    if (j !== i && (!reading.sessionId || prior.sessionId !== reading.sessionId)) continue;
    const at = prior.lastCompactedAt ?? prior.measuredAt ?? e?.created_at;
    if (at) return at;
  }
  return undefined;
}

/** A reading as the meter shows it: tokens only when valid, and the share of the window they fill. */
function measurement(p: ContextMeasurement, lastCompactedAt: string | undefined): ContextMeasurement {
  const promptTokens = p.compacted ? undefined : p.promptTokens;
  const valid = typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens >= 0;
  const capacity = typeof p.contextWindow === "number" && p.contextWindow > 0 ? p.contextWindow : null;
  return {
    ...p,
    ...(lastCompactedAt ? { lastCompactedAt } : {}),
    promptTokens: valid ? promptTokens : undefined,
    contextWindow: capacity,
    source: p.source ?? ContextSource.Estimated,
    percent: valid && capacity ? (100 * promptTokens) / capacity : null,
  };
}

/** Last measurement from the selected orchestration session. Workers cannot replace it. */
export function measuredContext(
  events: readonly ContextEvent[],
  engine: string,
  model: string,
  resolvedModel?: string,
): ContextMeasurement | null {
  const matches = (p: MeasurementKey): p is ContextMeasurement =>
    p.engine === engine && (!p.role || p.role === "planner") && measuresPick(p, model);
  const expectedSession = expectedSessionOf(events, engine, matches);
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i]?.data;
    if (!d) continue;
    if (resetsMeasurement(d, engine, model, matches)) return null;
    const p = customPayload(d, CustomEvent.ContextUsage);
    if (!p || !matches(p)) continue;
    if (resolvedModel && p.model !== resolvedModel) return null;
    if (expectedSession && p.sessionId !== expectedSession) continue;
    return measurement(p, p.lastCompactedAt || lastCompactionBefore(events, i, p, matches));
  }
  return null;
}
