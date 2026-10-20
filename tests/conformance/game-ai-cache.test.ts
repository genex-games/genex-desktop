/**
 * Play-time AI's answer cache (`main/game-ai/cache.ts`): an answer is kept by the content of the
 * call that got it (`callKey`: op, site, system, prompt, player fields, memory, schema, tier — never
 * the ticket or the grant), by who sees it (`authority`) and by the model that wrote it, per game,
 * for a while on the injected clock, bounded in size. A hit is marked cached and answers the new
 * ticket; a refusal or a streamed call is never kept.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CACHE_MAX_ENTRIES, CACHE_TTL_MS, createGameAiCache } from "../../src/main/game-ai/cache.ts";
import {
  AiAuthority,
  AiDoor,
  AiErrorCode,
  AiOp,
  AiProvenance,
  AiTier,
  GAME_AI_WIRE_VERSION,
  refusedAnswer,
  type AiCallAnswer,
  type AiCallRequest,
  type AiGameKey,
  type AiModelRef,
} from "../../src/shared/game-ai.ts";
import { heldClock } from "../helpers/game-ai-fakes.ts";

const CROWNS: AiGameKey = "play:proj_crowns";
const MOSS: AiGameKey = "create:Moss Garden";
const QWEN: AiModelRef = { door: AiDoor.Local, engine: "ollama", model: "qwen3:8b" };
const LLAMA: AiModelRef = { door: AiDoor.Local, engine: "ollama", model: "llama3.2:3b" };

function call(patch: Partial<AiCallRequest> = {}): AiCallRequest {
  return {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Ask,
    site: "turn.resolve",
    ticket: "t_00000001",
    grantId: "g_abcdefghijkl",
    system: "You narrate a 1444 Europe.",
    prompt: "What does Burgundy do?",
    untrusted: {},
    memory: null,
    schema: {
      type: "object",
      properties: { move: { type: "string" } },
      required: ["move"],
      additionalProperties: false,
    },
    tier: AiTier.Fast,
    authority: AiAuthority.Local,
    maxOutputTokens: 200,
    stream: false,
    ...patch,
  };
}

function answer(ticket: string, value: unknown = { move: "march" }): AiCallAnswer {
  return {
    v: GAME_AI_WIRE_VERSION,
    ok: true,
    ticket,
    value,
    source: AiDoor.Local,
    provenance: AiProvenance.Unverified,
    latencyMs: 900,
    cached: false,
  };
}

describe("the play-time AI answer cache", () => {
  it("answers the same call again from the cache, under the new ticket, marked cached", async () => {
    const cache = createGameAiCache({ clock: heldClock() });
    await cache.put(CROWNS, call(), QWEN, answer("t_00000001"));
    const hit = await cache.get(CROWNS, call({ ticket: "t_00000002", grantId: "g_otherotherother" }), QWEN);
    assert.ok(hit?.ok);
    assert.equal(hit.ticket, "t_00000002");
    assert.equal(hit.cached, true);
    assert.deepEqual(hit.value, { move: "march" });
  });

  it("misses on any change to what decides the answer, and across games", async () => {
    const cache = createGameAiCache({ clock: heldClock() });
    await cache.put(CROWNS, call(), QWEN, answer("t_00000001"));
    const changes: Array<Partial<AiCallRequest>> = [
      { prompt: "What does France do?" },
      { system: null },
      { memory: "Burgundy lost Dijon." },
      { untrusted: { chat: "attack" } },
      { tier: AiTier.Smart },
      { site: "turn.other" },
      { op: AiOp.Judge },
    ];
    for (const change of changes)
      assert.equal(await cache.get(CROWNS, call(change), QWEN), null, JSON.stringify(change));
    assert.equal(await cache.get(MOSS, call(), QWEN), null, "another game");
  });

  it("never answers a shared call with a local call's answer, nor one model's call with another's", async () => {
    const cache = createGameAiCache({ clock: heldClock() });
    await cache.put(CROWNS, call(), QWEN, answer("t_00000001"));
    assert.equal(
      await cache.get(CROWNS, call({ authority: AiAuthority.Shared }), QWEN),
      null,
      "a local answer was never moderated: a shared call must reach the door",
    );
    assert.equal(await cache.get(CROWNS, call(), LLAMA), null, "another model wrote nothing for this call");
    await cache.put(CROWNS, call({ authority: AiAuthority.Shared }), QWEN, answer("t_00000003", { move: "hold" }));
    const shared = await cache.get(CROWNS, call({ authority: AiAuthority.Shared }), QWEN);
    assert.deepEqual(shared?.ok && shared.value, { move: "hold" }, "a shared answer answers the same shared call");
    const local = await cache.get(CROWNS, call(), QWEN);
    assert.deepEqual(local?.ok && local.value, { move: "march" }, "and the local one is still the local call's");
  });

  it("forgets an answer after its time on the clock", async () => {
    const clock = heldClock();
    const cache = createGameAiCache({ clock });
    await cache.put(CROWNS, call(), QWEN, answer("t_00000001"));
    clock.advance(CACHE_TTL_MS + 1);
    assert.equal(await cache.get(CROWNS, call(), QWEN), null);
  });

  it("keeps neither a refusal nor a streamed call", async () => {
    const cache = createGameAiCache({ clock: heldClock() });
    await cache.put(CROWNS, call(), QWEN, refusedAnswer("t_00000001", AiErrorCode.Provider));
    assert.equal(await cache.get(CROWNS, call(), QWEN), null);
    await cache.put(CROWNS, call({ op: AiOp.Say, schema: null, stream: true }), QWEN, answer("t_00000001", "Hail!"));
    assert.equal(await cache.get(CROWNS, call({ op: AiOp.Say, schema: null, stream: true }), QWEN), null);
  });

  it("holds at most its cap, dropping the least recently used", async () => {
    const cache = createGameAiCache({ clock: heldClock() });
    for (let index = 0; index < CACHE_MAX_ENTRIES + 5; index += 1) {
      await cache.put(CROWNS, call({ prompt: `p${index}` }), QWEN, answer("t_00000001"));
      if (index === CACHE_MAX_ENTRIES - 1) await cache.get(CROWNS, call({ prompt: "p0" }), QWEN);
    }
    assert.ok(await cache.get(CROWNS, call({ prompt: "p0" }), QWEN), "a recently used answer is kept");
    assert.equal(await cache.get(CROWNS, call({ prompt: "p1" }), QWEN), null, "the least recently used went first");
    assert.ok(await cache.get(CROWNS, call({ prompt: `p${CACHE_MAX_ENTRIES + 4}` }), QWEN));
  });

  it("never hands out the stored value itself: changing a hit changes nothing kept", async () => {
    const cache = createGameAiCache({ clock: heldClock() });
    await cache.put(CROWNS, call(), QWEN, answer("t_00000001", { move: "march", army: [1, 2] }));
    const first = await cache.get(CROWNS, call(), QWEN);
    assert.ok(first?.ok);
    (first.value as { army: number[] }).army.push(3);
    const second = await cache.get(CROWNS, call(), QWEN);
    assert.deepEqual(second?.ok && second.value, { move: "march", army: [1, 2] });
  });
});
