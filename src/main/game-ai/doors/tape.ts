/**
 * The door to a saved playtest: a harness replay, or Create on a covered demo. It answers a call
 * from the loaded tape line whose key (`callKey`) and occurrence match, and nothing else: a call the
 * tape does not cover is `ai_unrecorded`, never a live call. A tape is agent-writable, so its answers
 * are never verified (`replay`), cost nothing and reach no network.
 */
import { AiDoor, AiErrorCode, type AiGameKey, AiOp } from "../../../shared/game-ai.ts";
import {
  callKey,
  callKeyInput,
  readTape,
  tapeLineText,
  tapeSlot,
  type TapeLine,
} from "../../../shared/game-ai-tape.ts";
import { AiRefusal } from "../refusal.ts";
import type { GameAiDoorImpl } from "../types.ts";

/** The tape door, with the tapes a replay loads for its game. */
export interface TapeDoor extends GameAiDoorImpl {
  /** Replay `lines` for `game` from its first call; a load replaces the game's last one. */
  load(game: AiGameKey, lines: readonly TapeLine[]): void;
  unload(game: AiGameKey): void;
  /** Calls of `game` the loaded tape did not cover. */
  misses(game: AiGameKey): number;
}

/** One game's loaded tape: its lines by slot, and how often each key was asked so far. */
interface Loaded {
  bySlot: ReadonlyMap<string, TapeLine>;
  asked: Map<string, number>;
  misses: number;
}

/** A tape's line as the model's text: a said string as it is, anything else as JSON. */
const textOf = (line: TapeLine): string =>
  line.op === AiOp.Say && typeof line.value === "string" ? line.value : JSON.stringify(line.value);

/** A new tape door with nothing loaded. */
export function createTapeDoor(): TapeDoor {
  const loaded = new Map<AiGameKey, Loaded>();
  const miss = (tape: Loaded): never => {
    tape.misses += 1;
    throw new AiRefusal(AiErrorCode.Unrecorded);
  };
  return {
    door: AiDoor.Tape,
    readiness: async () => ({
      door: AiDoor.Tape,
      ready: true,
      json: true,
      loading: false,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
    }),
    // A tape answers only the calls it covers: it is never a model to pick.
    models: async () => [],
    worstCaseMicros: () => 0,
    load(game, lines) {
      // Read again as hostile input: a line a reader would refuse is never replayed.
      const read = readTape(lines.map(tapeLineText).join(""));
      loaded.set(game, { bySlot: read.bySlot, asked: new Map(), misses: 0 });
    },
    unload(game) {
      loaded.delete(game);
    },
    misses: (game) => loaded.get(game)?.misses ?? 0,
    run: async (call) => {
      const tape = loaded.get(call.game);
      if (!tape) throw new AiRefusal(AiErrorCode.Unrecorded);
      // A tape holds the answer that was used; a repair of it has nothing to replay.
      if (call.repair) return miss(tape);
      const key = await callKey(callKeyInput(call.request));
      const n = tape.asked.get(key) ?? 0;
      tape.asked.set(key, n + 1);
      const line = tape.bySlot.get(tapeSlot(key, n));
      if (!line || line.op !== call.request.op || line.site !== call.request.site) return miss(tape);
      return { text: textOf(line), model: line.model, usage: line.usage, costMicros: 0 };
    },
  };
}
