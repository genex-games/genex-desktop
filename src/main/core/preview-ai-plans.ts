/**
 * A person's own AI plan answering a game's play-time model calls in Live
 * (`PreviewAiService`, docs/product/builds-live.md). The practice helper runs in host mode
 * (`genex llm practice --host`): it keeps the lane a game talks to and asks the app for the words
 * of each call. The app answers with one prompt to a subscription engine it is already signed in
 * to (`Engine.complete`, the isolated no-tools completion the judges use), so no Genex credit is
 * spent and no credential leaves the engine that holds it.
 */
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import type { PreviewAiPlan } from "../../shared/preview-ai.ts";
import { EngineId, providerInfo } from "../../shared/providers.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type Engine, EngineError } from "../../substrate/engines/types.ts";

/** How long one call may wait for the plan's answer: a game's own patience is far shorter. */
const PLAN_ANSWER_TIMEOUT_MS = 2 * MINUTE_MS;
/** The most models of a plan a game is offered: a budget names at most eight. */
const PLAN_MAX_MODELS = 6;

/** Why the app has no answer, in the helper's words (`genex llm practice --host`). Wire values: never rename one. */
export const HostError = {
  RateLimited: "rate_limited",
  SignedOut: "signed_out",
  Unavailable: "unavailable",
  Failed: "failed",
} as const;
export type HostError = (typeof HostError)[keyof typeof HostError];

/** One model of a plan as the helper's catalog lists it. */
export interface HostModel {
  id: string;
  label: string;
  /** The catalog's vendor: a game picks who plays whom by it. */
  vendor: string;
}

/** One call the helper asks the app to answer. */
export interface HostAsk {
  id: string;
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}

/** The app's answer to one call. */
export type HostAnswer = { id: string; text: string } | { id: string; error: HostError };

/** The catalog vendor of each plan's models; an engine not listed answers under its own id. */
const PLAN_VENDOR: Readonly<Record<string, string>> = {
  [EngineId.ClaudeCode]: "anthropic",
  [EngineId.Codex]: "openai",
};

/** The registry's engines, as much as the plans read. */
export interface PlanEngines {
  ids(): string[];
  get(id: string): Engine;
}

/** A subscription the app can ask one prompt of. */
const isPlanEngine = (engine: Engine): boolean =>
  providerInfo(engine.id)?.subscription === true && typeof engine.complete === "function";

/** The person's plans that are signed in and ready now, in the registry's order. */
export async function readyPlans(engines: PlanEngines): Promise<PreviewAiPlan[]> {
  const candidates = engines
    .ids()
    .map((id) => engines.get(id))
    .filter(isPlanEngine);
  const ready = await Promise.all(
    candidates.map((engine) =>
      engine.status().then(
        (status) => status.code === EngineStatusCode.Ready,
        () => false,
      ),
    ),
  );
  return candidates
    .filter((_, index) => ready[index])
    .map((engine) => ({ engine: engine.id, label: providerInfo(engine.id)?.label ?? engine.label }));
}

/** The id a plan's model has in the helper's catalog, and back to the engine's own. */
const catalogId = (engine: string, model: string): string => `${engine}/${model}`;
const engineModel = (engine: string, id: string): string | null =>
  id.startsWith(`${engine}/`) ? id.slice(engine.length + 1) : null;

/** The plan's models a game is offered: the engine's own list, its default first, aliases left out. */
export async function planModels(engine: Engine): Promise<HostModel[]> {
  const listed = (await engine.models().catch(() => [])).filter((model) => !model.aliasOf && !model.stale);
  const preferred = (await engine.defaultModel?.().catch(() => null)) ?? null;
  const ordered = [...listed].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  const vendor = PLAN_VENDOR[engine.id] ?? engine.id;
  return ordered.slice(0, PLAN_MAX_MODELS).map((model) => ({
    id: catalogId(engine.id, model.id),
    label: model.label,
    vendor,
  }));
}

/** Why an engine's completion failed, in the helper's four words. */
export function hostErrorOf(error: unknown): HostError {
  if (!(error instanceof EngineError)) return HostError.Failed;
  const kinds: Partial<Record<EngineFailureKind, HostError>> = {
    [EngineFailureKind.RateLimit]: HostError.RateLimited,
    [EngineFailureKind.UsageLimit]: HostError.RateLimited,
    [EngineFailureKind.Auth]: HostError.SignedOut,
    [EngineFailureKind.Unavailable]: HostError.Unavailable,
  };
  return kinds[error.kind] ?? HostError.Failed;
}

/**
 * One call answered on the person's plan: the helper's framing as the system prompt, the game's
 * request as the one user message, no tools. A model the plan does not list is asked of the
 * engine's own default.
 */
export async function answerOnPlan(engine: Engine, ask: HostAsk, signal: AbortSignal): Promise<HostAnswer> {
  if (!engine.complete) return { id: ask.id, error: HostError.Unavailable };
  const model = engineModel(engine.id, ask.modelId);
  try {
    const response = await engine.complete({
      ...(model ? { model } : {}),
      systemPrompt: ask.system,
      messages: [{ role: "user", content: ask.user }],
      maxTokens: ask.maxOutputTokens,
      timeoutMs: PLAN_ANSWER_TIMEOUT_MS,
      signal,
    });
    const content = response.message.content;
    return { id: ask.id, text: typeof content === "string" ? content : "" };
  } catch (error) {
    return { id: ask.id, error: hostErrorOf(error) };
  }
}

/** The helper's question when `line` is one, else null. Nothing the helper prints is trusted beyond its shape. */
export function parseHostAsk(line: Record<string, unknown>): HostAsk | null {
  const { id, modelId, system, user, maxOutputTokens } = line;
  const texts = [id, modelId, system, user].every((value) => typeof value === "string");
  if (line.event !== "ask" || !texts || typeof maxOutputTokens !== "number") return null;
  return { id: String(id), modelId: String(modelId), system: String(system), user: String(user), maxOutputTokens };
}
