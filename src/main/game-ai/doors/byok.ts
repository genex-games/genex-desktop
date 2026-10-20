/**
 * The door to the person's own OpenRouter key, billed by OpenRouter, unverified. The key never
 * leaves main (the engine reads it from the OS secret store per request). A call reserves its worst
 * case from the model's catalog price — the framed prompt's ceiling in tokens plus the call's whole
 * output budget — and a model whose price the catalog does not quote in full cannot be reserved, so
 * it is never run: an unknown price is never free. What a call cost is OpenRouter's own figure when
 * it reports one, else its tokens at the catalog price. The engine sends OpenRouter's no-fallback,
 * no-data-collection routing for a game's call.
 */
import { AiDoor, AiErrorCode, type AiCallRequest, type AiModelRef, type AiUsage } from "../../../shared/game-ai.ts";
import { EngineId } from "../../../shared/providers.ts";
import type { EngineModel } from "../../../substrate/engines/types.ts";
import { promptTokensOf } from "../game-ai-prompts.ts";
import { AiRefusal } from "../refusal.ts";
import type { GameAiDoorImpl } from "../types.ts";
import {
  assertOffered,
  cachedRows,
  type EngineSource,
  engineReady,
  readinessOf,
  refOf,
  runOnEngine,
  usableModels,
} from "./engine.ts";

/** USD micros in a dollar: a price per million tokens is micros per token. */
const MICROS_PER_USD = 1_000_000;

/** A row's price, when the catalog quotes both. */
type Price = NonNullable<EngineModel["pricePerMillion"]>;

/** What `tokens` cost at `price`, in micros, rounded up. */
const costOf = (price: Price, input: number, output: number): number =>
  Math.ceil(input * price.input + output * price.output);

/**
 * What a call cost: OpenRouter's own figure when it reports one, else its tokens at the catalog
 * price, else (no usage at all) the worst case it reserved, so a silent provider is never free.
 */
function billedMicros(
  reported: number | undefined,
  price: Price,
  usage: AiUsage | null,
  request: AiCallRequest,
): number {
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return Math.ceil(reported * MICROS_PER_USD);
  }
  if (usage) return costOf(price, usage.inputTokens, usage.outputTokens);
  return costOf(price, promptTokensOf(request), request.maxOutputTokens);
}

/** The person's OpenRouter key's door over `engines`. */
export function createByokDoor(options: { engines: EngineSource; now?: () => number }): GameAiDoorImpl {
  /** The last prices read, by model id: the worst case is a synchronous read. */
  let prices = new Map<string, Price>();
  const rows = cachedRows(options.now ?? Date.now, async () => {
    const engine = options.engines(EngineId.OpenRouter);
    const listed = engine && (await engineReady(engine)) ? await usableModels(engine) : [];
    // Only a fully priced model is offered: its worst case can be held against the person's limit.
    const priced = listed.filter((row) => row.pricePerMillion !== undefined);
    prices = new Map(priced.flatMap((row) => (row.pricePerMillion ? [[row.id, row.pricePerMillion]] : [])));
    return priced;
  });
  const worstCaseMicros = (request: AiCallRequest, model: AiModelRef): number => {
    const price = prices.get(model.model);
    if (!price || model.door !== AiDoor.Byok) return Number.POSITIVE_INFINITY;
    return costOf(price, promptTokensOf(request), request.maxOutputTokens);
  };
  return {
    door: AiDoor.Byok,
    readiness: async () => readinessOf(AiDoor.Byok, await rows()),
    models: async () => (await rows()).map((row) => refOf(AiDoor.Byok, EngineId.OpenRouter, row)),
    worstCaseMicros,
    run: async (call, signal, onDelta) => {
      const engine = call.model.engine === EngineId.OpenRouter ? options.engines(EngineId.OpenRouter) : null;
      if (!engine) throw new AiRefusal(AiErrorCode.DoorUnavailable);
      assertOffered(await rows(), call.model.model);
      const price = prices.get(call.model.model);
      if (!price) throw new AiRefusal(AiErrorCode.DoorUnavailable);
      const { answer, usage } = await runOnEngine(engine, call, signal, onDelta);
      return { ...answer, costMicros: billedMicros(usage.cost_usd, price, answer.usage, call.request) };
    },
  };
}
