/**
 * Saved playtests (`src/shared/game-ai-tape.ts`): the key a replay finds an answer by is the same
 * for the same request whatever its key order, and never depends on the ticket or the grant; a
 * tape is agent-writable game content, read line by line as hostile input under hard caps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type AiCallRequest, AiOp, AiSource, readAiCallRequest } from "../../src/shared/game-ai.ts";
import {
  AI_TAPE_MAX_LINES,
  callKey,
  callKeyInput,
  isTapeName,
  MAX_REPLAY_LATENCY_FRAMES,
  readTape,
  readTapeLine,
  type TapeLine,
  tapeFile,
  tapeLineText,
  tapeSlot,
} from "../../src/shared/game-ai-tape.ts";

const request = (more: Partial<AiCallRequest> = {}): AiCallRequest => {
  const read = readAiCallRequest({
    v: 1,
    op: AiOp.Say,
    site: "npc.greet",
    ticket: "ticket-0001",
    grantId: "grant-0001",
    system: "You are the innkeeper.",
    prompt: "Greet the player.",
    untrusted: { said: "hi" },
    memory: null,
    schema: null,
    tier: "fast",
    authority: "local",
    maxOutputTokens: 128,
    stream: true,
    ...more,
  });
  assert.ok(read);
  return read;
};

const LINE: TapeLine = {
  v: 1,
  key: "a".repeat(64),
  n: 0,
  site: "npc.greet",
  op: AiOp.Say,
  value: "Welcome to the Lantern.",
  source: AiSource.Local,
  model: "qwen3:8b",
  latencyFrames: 12,
  usage: { inputTokens: 40, outputTokens: 9 },
};

describe("callKey", () => {
  it("is 64 hex characters, the same for the same request, whatever the ticket, grant or stream", async () => {
    const a = await callKey(callKeyInput(request()));
    const b = await callKey(callKeyInput(request({ ticket: "ticket-9999", grantId: "grant-9999", stream: false })));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
  });

  it("does not depend on key order inside the request", async () => {
    const one = await callKey({ ...callKeyInput(request()), untrusted: { a: "1", b: "2" } });
    const two = await callKey({ ...callKeyInput(request()), untrusted: { b: "2", a: "1" } });
    assert.equal(one, two);
  });

  it("changes with anything that decides the answer", async () => {
    const base = await callKey(callKeyInput(request()));
    for (const change of [
      { prompt: "Wave." },
      { untrusted: { said: "hello" } },
      { site: "npc.farewell" },
      { tier: "smart" as const },
    ]) {
      assert.notEqual(await callKey(callKeyInput(request(change))), base, JSON.stringify(change));
    }
  });
});

describe("readTapeLine: one saved answer", () => {
  it("takes a well-formed line, a null model and null usage", () => {
    assert.deepEqual(readTapeLine(LINE), LINE);
    assert.deepEqual(readTapeLine({ ...LINE, model: null, usage: null }), { ...LINE, model: null, usage: null });
  });
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["another version", { v: 2 }],
    ["a short key", { key: "abc" }],
    ["an uppercase key", { key: "A".repeat(64) }],
    ["a negative occurrence", { n: -1 }],
    ["a fractional occurrence", { n: 0.5 }],
    ["a site with a path", { site: "../x" }],
    ["an unknown op", { op: "exec" }],
    ["an unknown source", { source: "openai" }],
    ["an empty model", { model: "" }],
    ["a long model id", { model: "m".repeat(151) }],
    ["zero latency", { latencyFrames: 0 }],
    ["latency past the cap", { latencyFrames: MAX_REPLAY_LATENCY_FRAMES + 1 }],
    ["usage with a negative count", { usage: { inputTokens: -1, outputTokens: 0 } }],
    ["a value with Infinity", { value: { n: Number.POSITIVE_INFINITY } }],
    ["an extra key", { prompt: "the prompt never goes in a tape" }],
  ];
  for (const [what, change] of hostile)
    it(`refuses ${what}`, () => assert.equal(readTapeLine({ ...LINE, ...change }), null));
});

describe("readTape: a whole tape as hostile input", () => {
  it("keeps good lines by slot, counts bad ones, and keeps the first of a repeated slot", () => {
    const second = { ...LINE, value: "Again?" };
    const text = [
      tapeLineText(LINE),
      "{not json",
      "",
      "[]",
      tapeLineText(second),
      tapeLineText({ ...LINE, n: 1 }),
    ].join("\n");
    const read = readTape(text);
    assert.equal(read.lines.length, 3);
    assert.equal(read.rejected, 2);
    assert.equal(read.truncated, false);
    assert.equal(read.bySlot.get(tapeSlot(LINE.key, 0))?.value, "Welcome to the Lantern.");
    assert.equal(read.bySlot.get(tapeSlot(LINE.key, 1))?.n, 1);
  });

  it("stops at the line cap and says so", () => {
    const text = Array.from({ length: AI_TAPE_MAX_LINES + 5 }, (_, n) => tapeLineText({ ...LINE, n })).join("");
    const read = readTape(text);
    assert.equal(read.lines.length, AI_TAPE_MAX_LINES);
    assert.equal(read.truncated, true);
  });

  it("names demos plainly and keeps their tapes under ai/tapes", () => {
    assert.equal(tapeFile("first-turn"), "ai/tapes/first-turn.jsonl");
    for (const name of ["first-turn", "a", "demo_2"]) assert.equal(isTapeName(name), true, name);
    for (const name of ["", "../x", "a/b", ".hidden", "Upper", "x".repeat(65), "a.jsonl", 3]) {
      assert.equal(isTapeName(name), false, String(name));
    }
  });
});
