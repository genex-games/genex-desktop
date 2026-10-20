/**
 * Two things a harness replay and recording need of `genex-ai` in Studio's preview:
 *  - the edge lane (`ai.replay` with `answers: "edge"`): every call answered with the worst value its
 *    schema admits — odd seeds the largest, even seeds the smallest — on a fixed frame, so a seed
 *    replays the same frames and the game's clamps are what is tested;
 *  - the calls a saved playtest had no answer for (`ai.record`): kept with the key and occurrence a
 *    tape line answers them by and the request itself, read by the studio contract
 *    (`__genexAi.missed()`) so the host answers the first one and plays the demo again, and
 *    forgotten on a reset.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiProvenance } from "../../src/shared/game-ai.ts";
import { AiLane, aiLaneHintAttribute, readAiLaneHint } from "../../src/shared/game-ai-lane.ts";
import { AI_EDGE_MAX_CHARS, canonicalJson, edgeAnswer, AiEdge } from "../../src/shared/game-ai-schema.ts";
import { AI_MISSES_KEPT, tapeFile } from "../../src/shared/game-ai-tape.ts";
import { laneSource, type PageEnv } from "../../src/page/ai/lanes/choose.ts";
import { edgeLane, replayLane } from "../../src/page/ai/lanes/replay.ts";
import { createRuntime } from "../../src/page/ai/runtime.ts";
import { s } from "../../src/page/ai/schema.ts";
import { aiOn, fakeFetch, lineFor, tapeText } from "../helpers/genex-ai-fakes.ts";

const Turn = s.object({ dx: s.int(-3, 3), say: s.string({ max: 12 }), tags: s.list(s.string({ max: 4 }), 3) });

describe("the edge lane", () => {
  it("answers each call with the largest values its schema allows on an odd seed, the smallest on an even one", async () => {
    for (const [seed, edge] of [
      [1, AiEdge.Max],
      [2, AiEdge.Min],
    ] as const) {
      const { ai, handle } = aiOn(edgeLane());
      await ai.ready();
      handle.reset?.(seed);
      ai.ask({ site: "turn.resolve", prompt: "Move.", schema: Turn });
      let result = null;
      for (let frame = 0; frame < 20 && !result; frame += 1) [result = null] = ai.drain();
      assert.equal(result?.ok, true, `seed ${seed}`);
      assert.deepEqual(result?.value, edgeAnswer(Turn, edge), `seed ${seed}`);
      assert.equal(result?.provenance, AiProvenance.Fixture);
    }
  });

  it("answers a say with the longest text, or none, and never misses", async () => {
    const { ai, handle } = aiOn(edgeLane());
    await ai.ready();
    handle.reset?.(3);
    ai.say({ site: "npc.line", prompt: "Speak." });
    let result = null;
    for (let frame = 0; frame < 20 && !result; frame += 1) [result = null] = ai.drain();
    assert.equal(result?.value, "W".repeat(AI_EDGE_MAX_CHARS));
    assert.equal(ai.status().misses, 0);
    assert.equal(ai.status().lane, AiLane.Edge);
  });

  it("replays the same frames for a seed every run", async () => {
    const run = async (seed: number) => {
      const { ai, handle } = aiOn(edgeLane());
      await ai.ready();
      handle.reset?.(seed);
      const seen: string[] = [];
      for (let frame = 0; frame < 120; frame += 1) {
        if (frame % 30 === 0) ai.ask({ site: "turn.resolve", prompt: `Turn ${frame}`, schema: Turn });
        for (const result of ai.drain()) seen.push(`${frame}:${canonicalJson(result.value)}`);
      }
      return seen.join("|");
    };
    assert.equal(await run(5), await run(5));
    assert.notEqual(await run(5), await run(6));
  });

  it("is what Studio's hint names, and a hint may name it", async () => {
    const hint = aiLaneHintAttribute({ lane: AiLane.Edge, tape: null });
    assert.deepEqual(readAiLaneHint(hint), { lane: AiLane.Edge, tape: null });
    const files = fakeFetch({});
    const page: PageEnv = {
      scope: {},
      fetch: files.fetch,
      hint: () => hint,
      embedSdk: () => null,
      session: () => "s",
    };
    const ai = createRuntime({}, { lanes: laneSource(page), gesture: () => false, register: () => {} });
    await ai.ready();
    assert.equal(ai.status().lane, AiLane.Edge);
    assert.equal(files.seen.length, 0, "the edge lane asks nothing of the network");
  });
});

/** A tape lane over `lines`, served as the game's own `ai/tapes/<demo>.jsonl`. */
function tapeOf(lines: Parameters<typeof tapeText>[0]) {
  const files = fakeFetch({ [`/${tapeFile("walk")}`]: () => new Response(tapeText(lines)) });
  return replayLane({ lane: AiLane.Tape, demo: "walk", fetch: files.fetch, seed: 1 });
}

describe("the calls a saved playtest had no answer for", () => {
  it("are kept with their key, occurrence and request, in the order they were made", async () => {
    const first = { site: "turn.resolve", prompt: "Move north.", schema: Turn };
    const second = { site: "turn.resolve", prompt: "Move south.", schema: Turn };
    const { ai, handle } = aiOn(tapeOf([lineFor(first, { dx: 1, say: "ok", tags: [] })]));
    await ai.ready();
    handle.reset?.(1);
    ai.ask(first);
    ai.ask(second);
    ai.ask(second);
    for (let frame = 0; frame < 5; frame += 1) ai.drain();
    const missed = handle.missed?.() ?? [];
    assert.equal(missed.length, 2, "the covered call is not a miss");
    const expected = lineFor(second, null);
    assert.equal(missed[0]?.key, expected.key, "the key a tape line for the same call carries");
    assert.deepEqual(
      missed.map((miss) => miss.n),
      [0, 1],
    );
    assert.equal(missed[0]?.request.prompt, "Move south.");
    assert.equal(missed[0]?.request.site, "turn.resolve");
    assert.deepEqual(missed[0]?.request.schema, Turn);
  });

  it("are forgotten on a reset, and kept at most AI_MISSES_KEPT", async () => {
    const { ai, handle } = aiOn(tapeOf([]));
    await ai.ready();
    for (let turn = 0; turn < AI_MISSES_KEPT + 5; turn += 1)
      ai.ask({ site: "turn.resolve", prompt: `T${turn}`, schema: Turn });
    for (let frame = 0; frame < 5; frame += 1) ai.drain();
    assert.equal(handle.missed?.().length, AI_MISSES_KEPT);
    assert.equal(ai.status().misses, AI_MISSES_KEPT + 5, "every miss is still counted");
    handle.reset?.(2);
    assert.deepEqual(handle.missed?.(), []);
  });

  it("are none on a lane that answers every call", async () => {
    const { ai, handle } = aiOn(edgeLane());
    await ai.ready();
    ai.ask({ site: "turn.resolve", prompt: "Move.", schema: Turn });
    for (let frame = 0; frame < 20; frame += 1) ai.drain();
    assert.deepEqual(handle.missed?.(), []);
  });
});
