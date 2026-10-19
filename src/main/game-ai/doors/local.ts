/**
 * The door to a model on this Mac: Bonsai, Ollama or a local server, free and unverified. It offers
 * only models already installed — a game never starts a download — and runs a call only on a model
 * it offers now. The queue holds it while a build runs (the build shares the GPU).
 */
import { AiDoor, AiErrorCode } from "../../../shared/game-ai.ts";
import { EngineId } from "../../../shared/providers.ts";
import type { EngineModel } from "../../../substrate/engines/types.ts";
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

/** The engines that run a model on this Mac, in the order the menu lists them. */
export const LOCAL_ENGINES: readonly string[] = [EngineId.Bonsai, EngineId.Ollama, EngineId.LocalServer];

/** This Mac's door over `engines`. */
export function createLocalDoor(options: { engines: EngineSource; now?: () => number }): GameAiDoorImpl {
  const now = options.now ?? Date.now;
  /** Per engine, its installed rows while it is ready. */
  const rowsOf = new Map(
    LOCAL_ENGINES.map((id) => [
      id,
      cachedRows(now, async () => {
        const engine = options.engines(id);
        return engine && (await engineReady(engine)) ? usableModels(engine) : [];
      }),
    ]),
  );
  const allRows = async (): Promise<Array<{ engine: string; row: EngineModel }>> => {
    const lists = await Promise.all(
      LOCAL_ENGINES.map(async (id) => ((await rowsOf.get(id)?.()) ?? []).map((row) => ({ engine: id, row }))),
    );
    return lists.flat();
  };
  return {
    door: AiDoor.Local,
    readiness: async () =>
      readinessOf(
        AiDoor.Local,
        (await allRows()).map((entry) => entry.row),
      ),
    models: async () => (await allRows()).map((entry) => refOf(AiDoor.Local, entry.engine, entry.row)),
    worstCaseMicros: () => 0,
    run: async (call, signal, onDelta) => {
      const engine = LOCAL_ENGINES.includes(call.model.engine) ? options.engines(call.model.engine) : null;
      if (!engine) throw new AiRefusal(AiErrorCode.DoorUnavailable);
      assertOffered((await rowsOf.get(call.model.engine)?.()) ?? [], call.model.model);
      return (await runOnEngine(engine, call, signal, onDelta)).answer;
    },
  };
}
