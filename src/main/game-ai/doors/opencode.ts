/**
 * The door to OpenCode: its free models cost nothing, its others bill the person's OpenCode
 * account. Unverified. It runs one call at a time (a CLI), yields to builds, and offers only the
 * models OpenCode lists for the signed-in account.
 */
import { AiDoor, AiErrorCode } from "../../../shared/game-ai.ts";
import { EngineId } from "../../../shared/providers.ts";
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

/** OpenCode's door over `engines`. */
export function createOpenCodeDoor(options: { engines: EngineSource; now?: () => number }): GameAiDoorImpl {
  const rows = cachedRows(options.now ?? Date.now, async () => {
    const engine = options.engines(EngineId.OpenCode);
    return engine && (await engineReady(engine)) ? usableModels(engine) : [];
  });
  return {
    door: AiDoor.OpenCode,
    readiness: async () => readinessOf(AiDoor.OpenCode, await rows()),
    models: async () => (await rows()).map((row) => refOf(AiDoor.OpenCode, EngineId.OpenCode, row)),
    // OpenCode's account bills by its own plan; nothing is reserved here.
    worstCaseMicros: () => 0,
    run: async (call, signal, onDelta) => {
      const engine = call.model.engine === EngineId.OpenCode ? options.engines(EngineId.OpenCode) : null;
      if (!engine) throw new AiRefusal(AiErrorCode.DoorUnavailable);
      assertOffered(await rows(), call.model.model);
      return (await runOnEngine(engine, call, signal, onDelta)).answer;
    },
  };
}
