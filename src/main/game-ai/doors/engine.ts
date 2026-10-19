/**
 * What the doors over Studio's engines share (`substrate/engines/*`): a game's call as one
 * completion with `CompletePurpose.Game` (no tools, no judge framing; the engine holds the reply to
 * the schema where it can), the engine's answer as a door's, and the readiness and model reads every
 * such door makes. A door never names an engine the person has not set up, and never starts a
 * download: a model that is not installed is not offered.
 */
import { SECOND_MS } from "../../../shared/duration.ts";
import { EngineStatusCode } from "../../../shared/engine-descriptor.ts";
import type { Usage } from "../../../shared/event-log.ts";
import {
  AiDoor,
  AiErrorCode,
  AI_DEFAULT_OUTPUT_TOKENS,
  type AiModelRef,
  type AiUsage,
} from "../../../shared/game-ai.ts";
import type { DoorReadiness } from "../../../shared/game-ai-route.ts";
import { CompletePurpose, type Engine, type EngineModel } from "../../../substrate/engines/types.ts";
import { gameMessages, gameSystemPrompt } from "../game-ai-prompts.ts";
import { AiRefusal } from "../refusal.ts";
import type { AiDoorAnswer, AiDoorRequest } from "../types.ts";

/** The longest one game's call may run on an engine before it is a timeout. */
export const GAME_CALL_TIMEOUT_MS = 60 * SECOND_MS;
/** How long an engine's status may take before the door reads as not ready. */
const STATUS_DEADLINE_MS = 3 * SECOND_MS;
/** How long a door keeps an engine's model list before it asks again. */
export const MODELS_TTL_MS = 30 * SECOND_MS;

/** Studio's engines by id; null for an engine this build or profile does not have. */
export type EngineSource = (id: string) => Engine | null;

/** Whether an engine answers ready within the deadline; a status that throws or hangs is not ready. */
export async function engineReady(engine: Engine | null): Promise<boolean> {
  if (!engine) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STATUS_DEADLINE_MS);
  });
  try {
    const status = await Promise.race([engine.status().catch(() => null), late]);
    return status?.code === EngineStatusCode.Ready;
  } finally {
    clearTimeout(timer);
  }
}

/** The rows of an engine a game may use: installed, and listed once (an alias names another row). */
export async function usableModels(engine: Engine): Promise<EngineModel[]> {
  const rows = await engine.models().catch(() => []);
  return rows.filter((row) => row.installed !== false && !row.aliasOf);
}

/** A model ref on `door` for an engine's row. */
export const refOf = (door: AiDoor, engine: string, row: EngineModel): AiModelRef => ({ door, engine, model: row.id });

/** A door's readiness from the rows it offers: the longest prompt the roomiest of them takes. */
export function readinessOf(door: AiDoor, rows: readonly EngineModel[], json = true): DoorReadiness {
  const windows = rows.map((row) => row.contextWindow - Math.min(row.maxTokens, AI_DEFAULT_OUTPUT_TOKENS));
  return { door, ready: rows.length > 0, json, loading: false, maxInputTokens: Math.max(0, ...windows) };
}

/** A provider's usage as a game's: the two counts, or null when it reported neither. */
export function usageOf(usage: Usage | undefined): AiUsage | null {
  if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined)) return null;
  return { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
}

/**
 * Run one game's call on an engine: the host's framing, the game's schema, the call's output
 * budget, its signal and (for a streamed `say`) the text as it arrives. An engine that cannot
 * complete is a door that is down.
 */
export async function runOnEngine(
  engine: Engine,
  call: AiDoorRequest,
  signal: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<{ answer: AiDoorAnswer; usage: Usage }> {
  if (!engine.complete) throw new AiRefusal(AiErrorCode.DoorUnavailable);
  const { request } = call;
  const response = await engine.complete({
    model: call.model.model,
    systemPrompt: gameSystemPrompt(call),
    messages: gameMessages(call),
    maxTokens: request.maxOutputTokens,
    purpose: CompletePurpose.Game,
    signal,
    timeoutMs: GAME_CALL_TIMEOUT_MS,
    ...(request.schema === null ? {} : { responseSchema: request.schema }),
    ...(request.stream && onDelta ? { onDelta } : {}),
  });
  const text = typeof response.message.content === "string" ? response.message.content : "";
  return {
    answer: { text, model: response.model || null, usage: usageOf(response.usage), costMicros: 0 },
    usage: response.usage,
  };
}

/** A model list read at most every {@link MODELS_TTL_MS}, on the door's clock. */
export function cachedRows(now: () => number, read: () => Promise<EngineModel[]>) {
  let kept: { at: number; rows: EngineModel[] } | null = null;
  return async (): Promise<EngineModel[]> => {
    if (kept && now() - kept.at < MODELS_TTL_MS) return kept.rows;
    const rows = await read();
    kept = { at: now(), rows };
    return rows;
  };
}

/** The call's model must be one the door offers now; anything else is a door that is down. */
export function assertOffered(rows: readonly EngineModel[], model: string): void {
  if (!rows.some((row) => row.id === model)) throw new AiRefusal(AiErrorCode.DoorUnavailable);
}
