/**
 * `genex-ai` on the lanes that never reach a model, over a fake fetch: a saved playtest answers
 * each call after exactly the frames it took live, a miss is a typed failure that plays the
 * game's fallback, the mock lane fills what the tape lacks with values of the right shape, and a
 * seed with the same steps replays the same frames every run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiErrorCode, AiOp, AiProvenance, AiRequirement, AiSource, AiTier } from "../../src/shared/game-ai.ts";
import { AiLane } from "../../src/shared/game-ai-lane.ts";
import { canonicalJson, validateValue } from "../../src/shared/game-ai-schema.ts";
import { AI_TAPE_MAX_BYTES, tapeFile } from "../../src/shared/game-ai-tape.ts";
import { offLane, replayLane } from "../../src/page/ai/lanes/replay.ts";
import { s } from "../../src/page/ai/schema.ts";
import type { AiResult, GameAi } from "../../src/page/ai/types.ts";
import { aiOn, fakeFetch, lineFor, settled, tapeText } from "../helpers/genex-ai-fakes.ts";

const Move = s.object({ dx: s.int(-3, 3), say: s.string({ max: 40 }) });
const DEMO = "walk";
const TAPE_URL = `/${tapeFile(DEMO)}`;

/** The call a turn makes: what it says depends on the turn only, never on the seed. */
const turnCall = (turn: number) => ({ site: "bot.move", prompt: `Turn ${turn}. Where next?`, schema: Move });

/** A tape answering turns 0–9 (10 and 11 are left out), each after a different number of frames. */
const TAPE = tapeText(
  Array.from({ length: 10 }, (_, turn) =>
    lineFor(turnCall(turn), { dx: (turn % 7) - 3, say: `step ${turn}` }, { latencyFrames: 1 + turn * 3 }),
  ),
);

function tapeLane(lane: typeof AiLane.Tape | typeof AiLane.Mock, tape = TAPE, seed = 1) {
  const files = fakeFetch({ [TAPE_URL]: () => new Response(tape) });
  return { lane: replayLane({ lane, demo: DEMO, fetch: files.fetch, seed }), seen: files.seen };
}

/** A small game: a call every 40 frames, answers applied in update, a seeded wander the AI never reads. */
function walker(ai: GameAi, seed: number) {
  let x = 0;
  let turn = 0;
  let rng = seed >>> 0;
  const log: string[] = [];
  return {
    step(frame: number) {
      if (frame % 40 === 0 && turn < 12) {
        ai.ask({ ...turnCall(turn), fallback: { dx: 0, say: "..." } });
        turn += 1;
      }
      rng = (rng * 1664525 + 1013904223) >>> 0;
      for (const result of ai.drain()) {
        const value = result.value as { dx: number; say: string } | null;
        x += value?.dx ?? 0;
        log.push(`${ai.status().frame}:${result.ok}:${result.code}:${value?.say}`);
      }
    },
    digest: () => canonicalJson({ x, turn, rng, log, ai: ai.status() }),
  };
}

async function play(seed: number, frames: number): Promise<string> {
  const { ai, handle } = aiOn(tapeLane(AiLane.Tape).lane);
  await ai.ready();
  handle.reset?.(seed);
  const game = walker(ai, seed);
  for (let frame = 0; frame < frames; frame += 1) game.step(frame);
  return game.digest();
}

describe("the tape lane", () => {
  it("answers a call after exactly the frames it took live", async () => {
    const { ai } = aiOn(tapeLane(AiLane.Tape).lane);
    await ai.ready();
    ai.ask(turnCall(3)); // recorded at 1 + 3 * 3 = 10 frames
    const seenOn: number[] = [];
    for (let frame = 1; frame <= 12; frame += 1) {
      for (const result of ai.drain()) {
        seenOn.push(frame);
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, { dx: 0, say: "step 3" });
        assert.equal(result.provenance, AiProvenance.Replay);
        assert.equal(result.source, AiSource.Local);
      }
    }
    assert.deepEqual(seenOn, [10]);
  });

  it("replays the same frames for a seed and the same steps, every run (20 seeds, twice, 600 steps)", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const first = await play(seed, 600);
      assert.equal(await play(seed, 600), first, `seed ${seed}`);
    }
  });

  it("holds a call made before the tape loaded to the frame it was asked on", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const files = fakeFetch({
      [TAPE_URL]: async () => {
        await gate;
        return new Response(TAPE);
      },
    });
    const { ai } = aiOn(replayLane({ lane: AiLane.Tape, demo: DEMO, fetch: files.fetch, seed: 1 }));
    ai.ask(turnCall(1)); // due at frame 0 + 4
    ai.drain();
    open();
    await settled();
    const frames: number[] = [];
    for (let frame = 2; frame <= 6; frame += 1) if (ai.drain().length) frames.push(frame);
    assert.deepEqual(frames, [4]);
  });

  it("fails a call the tape does not cover as ai_unrecorded, plays the fallback and counts the miss", async () => {
    const { ai } = aiOn(tapeLane(AiLane.Tape).lane);
    await ai.ready();
    ai.ask({ ...turnCall(11), fallback: (failure) => ({ dx: 0, say: failure.code }) });
    ai.ask(turnCall(10));
    const [withFallback, without] = ai.drain();
    assert.equal(withFallback?.ok, false);
    assert.equal(withFallback?.code, AiErrorCode.Unrecorded);
    assert.equal(withFallback?.fallback, true);
    assert.deepEqual(withFallback?.value, { dx: 0, say: AiErrorCode.Unrecorded });
    assert.equal(without?.fallback, false);
    assert.equal(without?.value, null);
    const status = ai.status();
    assert.equal(status.misses, 2);
    assert.equal(status.fallbacks, 1);
    assert.equal(status.refused[AiErrorCode.Unrecorded], 2);
    assert.equal(status.lane, AiLane.Tape);
    assert.equal(status.tape, DEMO);
  });

  it("answers the second occurrence of a call from its own line", async () => {
    const tape = tapeText([
      lineFor(turnCall(0), { dx: 1, say: "first" }, { n: 0 }),
      lineFor(turnCall(0), { dx: 2, say: "second" }, { n: 1 }),
    ]);
    const { ai } = aiOn(tapeLane(AiLane.Tape, tape).lane);
    await ai.ready();
    ai.ask(turnCall(0));
    ai.ask(turnCall(0));
    ai.ask(turnCall(0));
    const results = ai.drain();
    assert.deepEqual(
      results.map((result) => (result.value as { say: string } | null)?.say ?? result.code),
      ["first", "second", AiErrorCode.Unrecorded],
    );
  });

  it("forgets every call on a reset, so occurrences count from the first again", async () => {
    const { ai, handle } = aiOn(tapeLane(AiLane.Tape).lane);
    await ai.ready();
    ai.ask(turnCall(9)); // due after 28 frames
    handle.reset?.(7);
    assert.equal(ai.status().pending, 0);
    for (let frame = 0; frame < 40; frame += 1) assert.deepEqual(ai.drain(), []);
    ai.ask(turnCall(0));
    assert.equal(ai.drain()[0]?.ok, true);
  });
});

describe("a tape is hostile input", () => {
  const good = lineFor(turnCall(0), { dx: 1, say: "ok" });
  const ROWS: Array<[string, string]> = [
    ["a value its call's schema refuses", tapeText([{ ...good, value: { dx: 99, say: "too far" } }])],
    ["a line for another op", tapeText([{ ...good, op: AiOp.Judge }])],
    ["a line for another site", tapeText([{ ...good, site: "other.site" }])],
    ["a line that is not JSON", "{not json\n"],
    ["a line with an extra key", `${JSON.stringify({ ...good, extra: 1 })}\n`],
    ["a line whose latency is zero", tapeText([{ ...good, latencyFrames: 0 }])],
    ["a line with a prototype key", `${JSON.stringify(good).replace('{"v"', '{"__proto__":{"x":1},"v"')}\n`],
  ];
  for (const [name, tape] of ROWS) {
    it(`never answers from ${name}`, async () => {
      const { ai } = aiOn(tapeLane(AiLane.Tape, tape).lane);
      await ai.ready();
      ai.ask(turnCall(0));
      const [result] = ai.drain();
      assert.equal(result?.code, AiErrorCode.Unrecorded);
      assert.equal(({} as Record<string, unknown>).x, undefined);
    });
  }

  it("treats a tape the server says is past its cap as empty, without reading it", async () => {
    let read = false;
    const files = fakeFetch({
      [TAPE_URL]: () => {
        const response = new Response(TAPE, { headers: { "content-length": String(AI_TAPE_MAX_BYTES + 1) } });
        response.text = async () => {
          read = true;
          return TAPE;
        };
        return response;
      },
    });
    const { ai } = aiOn(replayLane({ lane: AiLane.Tape, demo: DEMO, fetch: files.fetch, seed: 1 }));
    await ai.ready();
    ai.ask(turnCall(0));
    assert.equal(ai.drain()[0]?.code, AiErrorCode.Unrecorded);
    assert.equal(read, false);
  });

  it("asks only for the game's own tape file", async () => {
    const { lane, seen } = tapeLane(AiLane.Tape);
    const { ai } = aiOn(lane);
    await ai.ready();
    assert.deepEqual(
      seen.map((request) => [request.url, request.method]),
      [[TAPE_URL, "GET"]],
    );
  });
});

describe("the mock lane", () => {
  it("answers from the tape where it covers the call, and makes up a value of the right shape where it does not", async () => {
    const { ai } = aiOn(tapeLane(AiLane.Mock).lane);
    await ai.ready();
    ai.ask(turnCall(0));
    ai.ask(turnCall(11));
    const results: AiResult[] = [];
    for (let frame = 0; frame < 10; frame += 1) results.push(...ai.drain());
    const [taped, made] = results;
    assert.equal(taped?.provenance, AiProvenance.Replay);
    assert.equal(made?.ok, true);
    assert.equal(made?.provenance, AiProvenance.Fixture);
    assert.equal(validateValue(Move, made?.value), true);
    assert.equal(ai.status().misses, 1);
  });

  it("makes the same values for the same seed, and others for another", async () => {
    const values = async (seed: number) => {
      const { ai, handle } = aiOn(tapeLane(AiLane.Mock, "", seed).lane);
      await ai.ready();
      handle.reset?.(seed);
      const asked = Array.from({ length: 6 }, (_, turn) => ai.ask(turnCall(turn)));
      for (let frame = 0; frame < 10; frame += 1) ai.drain();
      return asked.map((ticket) => ticket.result()?.value);
    };
    assert.deepEqual(await values(3), await values(3));
    assert.notDeepEqual(await values(3), await values(4));
  });

  it("writes text for say, within the game's length", async () => {
    const { ai } = aiOn(tapeLane(AiLane.Mock, "").lane);
    await ai.ready();
    const ticket = ai.say({ site: "npc.line", prompt: "Greet the player.", maxChars: 10 });
    for (let frame = 0; frame < 10; frame += 1) ai.drain();
    const value = ticket.result()?.value;
    assert.equal(typeof value, "string");
    assert.ok(typeof value === "string" && value.length > 0 && value.length <= 10);
  });
});

describe("the off lane", () => {
  it("fails every call ai_off on the next drain, with the fallback, and holds no grant", async () => {
    const { ai, gesture } = aiOn(offLane(), { requires: AiRequirement.Optional });
    await ai.ready();
    ai.ask({ ...turnCall(0), fallback: { dx: 0, say: "quiet" } });
    const [result] = ai.drain();
    assert.equal(result?.code, AiErrorCode.Off);
    assert.deepEqual(result?.value, { dx: 0, say: "quiet" });
    gesture.active = true;
    assert.equal(await ai.requestBudget(), null);
    assert.equal(await ai.activeBudget(), null);
    assert.equal(ai.status().on, false);
  });

  it("puts an AI-only game in the needs-AI state when a call it cannot play past is refused", async () => {
    const { ai } = aiOn(offLane(), { requires: AiRequirement.Ai });
    await ai.ready();
    ai.ask(turnCall(0));
    ai.drain();
    assert.equal(ai.status().needsAi, AiErrorCode.Off);
  });
});

describe("the game's own calls", () => {
  it("refuses a call that does not compile on the next drain, before any lane hears of it", async () => {
    const { lane, seen } = tapeLane(AiLane.Tape);
    const { ai } = aiOn(lane, { sites: ["bot.move"] });
    await ai.ready();
    const before = seen.length;
    ai.ask({ site: "undeclared", prompt: "p", schema: Move, fallback: { dx: 0, say: "" } });
    ai.ask({ site: "bot.move", prompt: "p", schema: { type: "object" } as never });
    const results = ai.drain();
    assert.deepEqual(
      results.map((result) => result.code),
      [AiErrorCode.BadRequest, AiErrorCode.InvalidSchema],
    );
    assert.equal(results[0]?.fallback, true);
    assert.equal(seen.length, before);
  });

  it("refuses a grant asked for outside a click or key, and counts it", async () => {
    const { ai, gesture } = aiOn(tapeLane(AiLane.Tape).lane);
    await ai.ready();
    assert.equal(await ai.requestBudget(), null);
    assert.equal(ai.status().refused[AiErrorCode.NoGesture], 1);
    gesture.active = true;
    assert.notEqual(await ai.requestBudget({ tiers: [AiTier.Smart] }), null);
  });

  it("delivers a canceled call as canceled, with no fallback, and ignores its answer", async () => {
    const { ai } = aiOn(tapeLane(AiLane.Tape).lane);
    await ai.ready();
    const ticket = ai.ask({ ...turnCall(9), fallback: { dx: 1, say: "x" } });
    assert.equal(ticket.cancel(), true);
    assert.equal(ai.status().pending, 1);
    const [result] = ai.drain();
    assert.equal(result?.code, AiErrorCode.Canceled);
    assert.equal(result?.fallback, false);
    assert.equal(ticket.cancel(), false);
    for (let frame = 0; frame < 40; frame += 1) assert.deepEqual(ai.drain(), []);
  });

  it("reports the disclosure once the game drew it, and forgets it on a reset", async () => {
    const { ai, handle } = aiOn(tapeLane(AiLane.Tape).lane);
    await ai.ready();
    assert.equal(ai.status().disclosed, false);
    assert.deepEqual(ai.disclosure(), { text: "AI-generated", anchor: "top-right" });
    assert.equal(handle.status?.().disclosed, true);
    handle.reset?.(2);
    assert.equal(ai.status().disclosed, false);
  });

  it("compacts a memory into one summary line, applied on the drain that releases it", async () => {
    const summary = "The king went to war.";
    const { ai } = aiOn(tapeLane(AiLane.Mock, "").lane);
    await ai.ready();
    const memory = ai.memory("chronicle", { keep: 5 });
    memory.remember("king", "declared war");
    memory.remember("queen", "agreed");
    memory.compact("chronicle.compact");
    memory.remember("king", "marched");
    for (let frame = 0; frame < 10; frame += 1) ai.drain();
    const lines = memory.lines();
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.role, "summary");
    assert.notEqual(lines[0]?.text, summary, "a mock writes its own words");
    assert.deepEqual(lines[1], { role: "king", text: "marched" });
  });

  it("refuses a memory name that is not one", () => {
    const { ai } = aiOn(offLane());
    assert.throws(() => ai.memory("bad name!"), TypeError);
  });
});
