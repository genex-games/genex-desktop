/**
 * `genex-ai` keys a call in the call itself, synchronously (`src/page/ai/sha256.ts`), so a replay
 * can hold each answer for exactly the frames it took live. The host keys the same call through
 * WebCrypto (`callKey` in `shared/game-ai-tape.ts`). Both must give the same key for every call,
 * or a tape recorded by the host never answers a page.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { AiOp, AiTier } from "../../src/shared/game-ai.ts";
import { type CallKeyInput, callKey } from "../../src/shared/game-ai-tape.ts";
import { callKeyNow, sha256, sha256Hex } from "../../src/page/ai/sha256.ts";

const nodeHex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Lengths around every padding edge: 55 and 56 bytes straddle the one-block limit, 64 fills a block. */
const LENGTHS = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 4097];

describe("sha256 in the page", () => {
  it("matches Node's SHA-256 at every padding edge", () => {
    for (const length of LENGTHS) {
      const bytes = Uint8Array.from({ length }, (_, at) => (at * 131 + 7) % 256);
      assert.equal(Buffer.from(sha256(bytes)).toString("hex"), nodeHex(bytes), `length ${length}`);
    }
  });

  it("hashes text as its UTF-8, multibyte and astral characters included", () => {
    for (const text of ["", "abc", "héllo wörld", "日本語のテキスト", "🐉 dragon 🐉", "\u0000￿"]) {
      assert.equal(sha256Hex(text), nodeHex(new TextEncoder().encode(text)), JSON.stringify(text));
    }
  });

  it("gives the published vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

const CALLS: CallKeyInput[] = [
  {
    op: AiOp.Ask,
    site: "turn.resolve",
    system: "You resolve turns.",
    prompt: "Turn 1.",
    untrusted: { order: "Send envoys 🕊️" },
    memory: null,
    schema: { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false },
    tier: AiTier.Smart,
  },
  {
    op: AiOp.Say,
    site: "npc.reply",
    system: null,
    prompt: "Hi",
    untrusted: {},
    memory: "player: hi",
    schema: null,
    tier: AiTier.Fast,
  },
  {
    op: AiOp.Judge,
    site: "mood",
    system: null,
    prompt: "x".repeat(5000),
    untrusted: { b: "2", a: "1" },
    memory: null,
    schema: { type: "number", minimum: 0, maximum: 1 },
    tier: AiTier.Fast,
  },
];

describe("a call's key in the page", () => {
  it("is the host's WebCrypto key for the same call", async () => {
    for (const call of CALLS) assert.equal(callKeyNow(call), await callKey(call), call.site);
  });

  it("does not depend on the order the game wrote its fields in", () => {
    const [first] = CALLS;
    assert.ok(first);
    const reordered: CallKeyInput = {
      tier: first.tier,
      schema: first.schema,
      memory: first.memory,
      untrusted: first.untrusted,
      prompt: first.prompt,
      system: first.system,
      site: first.site,
      op: first.op,
    };
    assert.equal(callKeyNow(reordered), callKeyNow(first));
  });
});
