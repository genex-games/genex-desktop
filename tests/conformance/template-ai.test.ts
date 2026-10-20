/**
 * The template's studio contract and `genex-ai` (src/game-template/src/studio.js). A game that
 * started its AI is reported in `state().ai` without the game copying anything, and
 * `__studio.seed()` resets the AI with the world, so a seed and the same steps replay the same
 * frames. A game with no AI reports no `ai` at all, and a game's own `ai` probe still wins.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installStudio } from "../../src/game-template/src/studio.js";
import { AiLane, GENEX_AI_STUDIO_GLOBAL } from "../../src/shared/game-ai-lane.ts";
import { offLane } from "../../src/page/ai/lanes/replay.ts";
import { createRuntime } from "../../src/page/ai/runtime.ts";

type StudioApi = Record<string, (...args: unknown[]) => unknown>;

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  for (const name of ["window", "document", "requestAnimationFrame"]) saved[name] = globals[name];
  globals.window = { addEventListener: () => {}, __studio_error: null };
  globals.document = { addEventListener: () => {}, pointerLockElement: null, querySelector: () => null, body: null };
  globals.requestAnimationFrame = () => 0;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
  Reflect.deleteProperty(globalThis, GENEX_AI_STUDIO_GLOBAL);
});

/** What `state()` reports, as JSON fields. */
const stateOf = (studio: StudioApi): Record<string, unknown> => (studio.state?.() ?? {}) as Record<string, unknown>;

/** A game whose update drains its AI once per frame, as docs/AI.md asks. */
async function gameWithAi(probes?: () => Record<string, unknown>) {
  const ai = createRuntime(
    {},
    {
      lanes: { first: async () => offLane(), platform: null },
      gesture: () => false,
      register: (handle) =>
        Object.defineProperty(globalThis, GENEX_AI_STUDIO_GLOBAL, { value: handle, configurable: true }),
    },
  );
  await ai.ready();
  const results: unknown[] = [];
  const studio = installStudio({
    fixedStepMs: 10,
    update: () => {
      results.push(...ai.drain());
    },
    reset: () => {},
    ...(probes ? { probes } : {}),
  } as never) as unknown as StudioApi;
  return { ai, studio, results };
}

describe("the studio contract and genex-ai", () => {
  it("reports the game's AI in state().ai", async () => {
    const { ai, studio } = await gameWithAi();
    ai.disclosure();
    const state = stateOf(studio) as { ai?: { lane: string; disclosed: boolean } };
    assert.equal(state.ai?.lane, AiLane.Off);
    assert.equal(state.ai?.disclosed, true);
  });

  it("resets the AI with the world on seed(): nothing waiting carries over", async () => {
    const { ai, studio } = await gameWithAi();
    ai.ask({ site: "npc.reply", prompt: "Hi", schema: { type: "boolean" } });
    studio.step?.(30);
    ai.ask({ site: "npc.reply", prompt: "Hi", schema: { type: "boolean" } });
    studio.seed?.(4);
    const state = stateOf(studio) as { ai?: { pending: number; frame: number; calls: number } };
    assert.deepEqual([state.ai?.pending, state.ai?.frame, state.ai?.calls], [0, 0, 0]);
  });

  it("leaves a game's own ai probe in place", async () => {
    const { studio } = await gameWithAi(() => ({ ai: { mine: true } }));
    assert.deepEqual((stateOf(studio) as { ai?: unknown }).ai, { mine: true });
  });

  it("reports no ai for a game that started none", () => {
    const studio = installStudio({ fixedStepMs: 10, update: () => {} } as never) as unknown as StudioApi;
    assert.equal(Object.hasOwn(stateOf(studio) as object, "ai"), false);
  });
});
