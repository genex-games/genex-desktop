/**
 * Play-time AI's wire (`src/shared/game-ai.ts`, `game-ai-bridge.ts`, `play-ai.ts`,
 * `genex-desktop-bridge.ts` and the Play Protocol's `ai` line): every message a game can send main
 * is read by one pure reader, and every hostile shape is refused as null with nothing kept.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_CODE_OF_FAILURE,
  AI_MAX_PROMPT_BYTES,
  AI_MAX_UNTRUSTED_BYTES,
  AiBridgeOp,
  AiDoor,
  AiErrorCode,
  AiFunding,
  AiOp,
  createGameKey,
  creditsOfMicros,
  fitsBytes,
  fundingOf,
  isBoundedJson,
  isPlatformDoor,
  microsOfCredits,
  needsConsent,
  PLATFORM_DOORS,
  playGameKey,
  readAiCallRequest,
  readAiGameKey,
  readAiGrantRequest,
} from "../../src/shared/game-ai.ts";
import { AI_ROUTE_PREFIX, aiRouteOp, readAiBridgeBody } from "../../src/shared/game-ai-bridge.ts";
import { PlayBridgeOp, readPlayAiEnvelope } from "../../src/shared/play-ai.ts";
import {
  GENEX_DESKTOP_BRIDGE_VERSION,
  GENEX_DESKTOP_GLOBAL,
  GenexConfirmKind,
  genexDesktopBridgeOf,
  readGenexConfirmAnswer,
  readGenexConfirmRequest,
} from "../../src/shared/genex-desktop-bridge.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { PlayAiOp, PlayEvent, readHello, readPlayAiLine, takesAiOp } from "../../src/shared/play-protocol.ts";

/** A call the reader takes, to vary one field at a time. */
const CALL = {
  v: 1,
  op: AiOp.Ask,
  site: "turn.resolve",
  ticket: "ticket-0001",
  grantId: "grant-0001",
  system: "You narrate a 1444 world.",
  prompt: "Resolve the turn.",
  untrusted: { order: "march on Paris" },
  memory: null,
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  tier: "fast",
  authority: "local",
  maxOutputTokens: 256,
  stream: false,
} as const;

const deep = (levels: number): unknown => {
  let value: unknown = "leaf";
  for (let i = 0; i < levels; i += 1) value = { next: value };
  return value;
};

describe("isBoundedJson: a game's message is plain JSON inside its bounds", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const sparse = [1, 2];
  sparse[5] = 3;
  const rows: Array<[string, unknown, boolean]> = [
    ["a plain tree", { a: [1, "x", null, true, { b: 2 }] }, true],
    ["Object.create(null)", Object.assign(Object.create(null), { a: 1 }), true],
    ["a cycle", cyclic, false],
    ["nesting past the depth", deep(40), false],
    ["a sparse array", sparse, false],
    ["NaN", { n: Number.NaN }, false],
    ["Infinity", [Number.POSITIVE_INFINITY], false],
    ["a Date", { at: new Date(0) }, false],
    ["a Map", new Map(), false],
    ["a class instance", new (class Box {})(), false],
    ["a function", { f: () => 1 }, false],
    ["an undefined field", { u: undefined }, false],
    ["a bigint", { b: 1n }, false],
    ["a __proto__ key", JSON.parse('{"__proto__": {"polluted": true}}'), false],
    ["a constructor key", { constructor: 1 }, false],
    ["a huge array", Array.from({ length: 10_000 }, () => 0), false],
    ["a huge string", "x".repeat(300 * 1024), false],
  ];
  for (const [what, value, ok] of rows) it(what, () => assert.equal(isBoundedJson(value), ok));
});

describe("fitsBytes counts UTF-8 bytes, not characters", () => {
  it("decides by lengths alone when it can, and encodes only a close call", () => {
    assert.equal(fitsBytes(["abc", null, "de"], 5), true);
    assert.equal(fitsBytes(["abc", "def"], 5), false);
    assert.equal(fitsBytes(["€€"], 6), true, "two 3-byte characters");
    assert.equal(fitsBytes(["€€"], 5), false);
    assert.equal(fitsBytes(["😀"], 4), true, "a surrogate pair is 4 bytes");
    assert.equal(fitsBytes(["😀"], 3), false);
  });
});

describe("readAiCallRequest: a call from game code", () => {
  it("rebuilds an accepted call field by field", () => {
    const read = readAiCallRequest(structuredClone(CALL));
    assert.deepEqual(read, CALL);
    assert.notEqual(read, CALL);
  });

  const hostile: Array<[string, Record<string, unknown>]> = [
    ["another wire version", { v: 2 }],
    ["an unknown op", { op: "eval" }],
    ["an unknown tier", { tier: "ultra" }],
    ["an unknown authority", { authority: "global" }],
    ["a site with a path in it", { site: "../tapes" }],
    ["a site starting with a digit", { site: "1turn" }],
    ["a short ticket", { ticket: "t1" }],
    ["a ticket with a slash", { ticket: "ticket/0001" }],
    ["a grant id with a newline", { grantId: "grant-0001\n" }],
    ["an empty prompt", { prompt: "   " }],
    ["a prompt that is not text", { prompt: 42 }],
    ["a prompt over the cap", { prompt: "x".repeat(AI_MAX_PROMPT_BYTES + 1) }],
    ["a system that is a number", { system: 7 }],
    ["memory that is an object", { memory: { text: "x" } }],
    ["untrusted that is a string", { untrusted: "march" }],
    ["an untrusted value that is a number", { untrusted: { order: 5 } }],
    ["an untrusted key with a space", { untrusted: { "my order": "x" } }],
    ["an untrusted value over its cap", { untrusted: { order: "x".repeat(AI_MAX_UNTRUSTED_BYTES + 1) } }],
    [
      "too many untrusted fields",
      { untrusted: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "x"])) },
    ],
    ["output tokens of zero", { maxOutputTokens: 0 }],
    ["fractional output tokens", { maxOutputTokens: 1.5 }],
    ["output tokens over the cap", { maxOutputTokens: 1_000_000 }],
    ["stream that is a string", { stream: "yes" }],
    ["say with a schema", { op: AiOp.Say }],
    ["ask without a schema", { schema: null }],
    ["a schema over its byte cap", { schema: { type: "string", description: "x".repeat(20 * 1024) } }],
    ["an extra key", { extra: true }],
  ];
  for (const [what, change] of hostile) {
    it(`refuses ${what}`, () => assert.equal(readAiCallRequest({ ...CALL, ...change }), null));
  }

  it("refuses a missing key, an array, null and a primitive", () => {
    const { stream: _stream, ...missing } = CALL;
    for (const raw of [missing, [CALL], null, "call", 1]) assert.equal(readAiCallRequest(raw), null);
  });

  it("takes say with no schema", () => {
    const say = { ...CALL, op: AiOp.Say, schema: null, stream: true };
    assert.deepEqual(readAiCallRequest(say), say);
  });
});

describe("readAiGrantRequest: a game asking to start AI", () => {
  it("takes a requirement and its tiers, each once", () => {
    assert.deepEqual(readAiGrantRequest({ v: 1, requires: "ai", tiers: ["fast", "smart"] }), {
      v: 1,
      requires: "ai",
      tiers: ["fast", "smart"],
    });
  });
  const hostile: unknown[] = [
    { v: 1, requires: "ai", tiers: [] },
    { v: 1, requires: "ai", tiers: ["fast", "fast"] },
    { v: 1, requires: "ai", tiers: ["fast", "smart", "fast"] },
    { v: 1, requires: "always", tiers: ["fast"] },
    { v: 1, requires: "ai", tiers: "fast" },
    { v: 1, requires: "ai", tiers: ["fast"], door: "byok" },
    { v: 1, requires: "ai", tiers: ["fast"], maxCredits: 5000 },
    { v: 0, requires: "ai", tiers: ["fast"] },
  ];
  for (const raw of hostile) it(`refuses ${JSON.stringify(raw)}`, () => assert.equal(readAiGrantRequest(raw), null));
});

describe("game keys: main's name for a game, never the page's", () => {
  it("reads play and create keys and builds them", () => {
    assert.equal(readAiGameKey("play:0b9f3c8e-11aa"), "play:0b9f3c8e-11aa");
    assert.equal(readAiGameKey("create:Lantern Run"), "create:Lantern Run");
    assert.equal(playGameKey("p1"), "play:p1");
    assert.equal(createGameKey("pong"), "create:pong");
  });
  const hostile = [
    "slug:pong",
    "play:",
    "play:..",
    "create:.",
    "create:a/b",
    "create:a\\b",
    "play:x\u0000",
    "create: padded",
    "PLAY:x",
    "play:".padEnd(140, "x"),
    42,
    null,
  ];
  for (const raw of hostile) it(`refuses ${JSON.stringify(raw)}`, () => assert.equal(readAiGameKey(raw), null));
});

describe("doors: who pays, and what needs a yes", () => {
  it("names how each door is paid, a free model costing nothing", () => {
    assert.equal(fundingOf(AiDoor.Local, true), AiFunding.Free);
    assert.equal(fundingOf(AiDoor.OpenCode, true), AiFunding.Free);
    assert.equal(fundingOf(AiDoor.OpenCode, false), AiFunding.Key);
    assert.equal(fundingOf(AiDoor.Byok, false), AiFunding.Key);
    assert.equal(fundingOf(AiDoor.Plan, false), AiFunding.Plan);
    assert.equal(fundingOf(AiDoor.PlanWatcher, false), AiFunding.Plan);
    assert.equal(fundingOf(AiDoor.GenexCredits, false), AiFunding.Credits);
    assert.equal(fundingOf(AiDoor.Tape, false), AiFunding.Playtest);
  });
  it("asks before plan or money, never before free", () => {
    assert.equal(needsConsent(AiDoor.Local, true), false);
    assert.equal(needsConsent(AiDoor.OpenCode, true), false);
    assert.equal(needsConsent(AiDoor.Tape, false), false);
    for (const door of [AiDoor.OpenCode, AiDoor.Byok, AiDoor.Plan, AiDoor.PlanWatcher, AiDoor.GenexCredits])
      assert.equal(needsConsent(door, false), true, door);
  });
  it("leaves Genex credits and the watcher's plan to genex.games", () => {
    assert.deepEqual([...PLATFORM_DOORS].sort(), [AiDoor.GenexCredits, AiDoor.PlanWatcher].sort());
    assert.equal(isPlatformDoor(AiDoor.Local), false);
  });
  it("maps every engine failure to a game's code", () => {
    for (const kind of Object.values(EngineFailureKind)) assert.ok(AI_CODE_OF_FAILURE[kind], kind);
    assert.equal(AI_CODE_OF_FAILURE[EngineFailureKind.UsageLimit], AiErrorCode.WaitingForPlan);
  });
});

describe("money: credits for people, micros for programs", () => {
  it("rounds a spend up, never down, and refuses nonsense", () => {
    assert.equal(creditsOfMicros(0), 0);
    assert.equal(creditsOfMicros(1), 1);
    assert.equal(creditsOfMicros(10_000), 1);
    assert.equal(creditsOfMicros(10_001), 2);
    assert.equal(creditsOfMicros(-5), 0);
    assert.equal(creditsOfMicros(Number.NaN), 0);
    assert.equal(microsOfCredits(12), 120_000);
    assert.equal(microsOfCredits(1.9), 10_000);
  });
});

describe("readAiBridgeBody: one reader for every lane", () => {
  it("takes the ops with no body only as null", () => {
    for (const op of [AiBridgeOp.Hello, AiBridgeOp.Doors, AiBridgeOp.BudgetActive, AiBridgeOp.BudgetStop]) {
      assert.deepEqual(readAiBridgeBody(op, null), { op, body: null });
      assert.equal(readAiBridgeBody(op, {}), null, op);
      assert.equal(readAiBridgeBody(op, undefined), null, op);
    }
  });
  it("reads a call, a cancel and a grant request with their own readers", () => {
    assert.deepEqual(readAiBridgeBody(AiBridgeOp.Call, CALL), { op: AiBridgeOp.Call, body: CALL });
    assert.deepEqual(readAiBridgeBody(AiBridgeOp.Cancel, { ticket: "ticket-0001" }), {
      op: AiBridgeOp.Cancel,
      body: { ticket: "ticket-0001" },
    });
    assert.equal(readAiBridgeBody(AiBridgeOp.Cancel, { ticket: "ticket-0001", all: true }), null);
    assert.equal(readAiBridgeBody(AiBridgeOp.BudgetRequest, { v: 1, requires: "ai", tiers: [] }), null);
  });
  it("refuses an op it does not know", () => {
    for (const op of ["budget.raise", "__proto__", "", 3, null]) assert.equal(readAiBridgeBody(op, null), null);
  });
  it("reads the Create Live route's op from its path only", () => {
    assert.equal(aiRouteOp(`${AI_ROUTE_PREFIX}call`), AiBridgeOp.Call);
    assert.equal(aiRouteOp(`${AI_ROUTE_PREFIX}budget.request`), AiBridgeOp.BudgetRequest);
    for (const path of [
      "/__genex/ai/v2/call",
      `${AI_ROUTE_PREFIX}call/x`,
      `${AI_ROUTE_PREFIX}`,
      "/call",
      "/__genex/ai/v1",
    ])
      assert.equal(aiRouteOp(path), null, path);
  });
});

describe("readPlayAiEnvelope: the Play view's numbered messages", () => {
  it("reads an AI op and the embed-sdk's confirm", () => {
    assert.deepEqual(readPlayAiEnvelope({ id: 1, op: AiBridgeOp.Hello, body: null }), {
      id: 1,
      op: AiBridgeOp.Hello,
      body: null,
    });
    assert.deepEqual(
      readPlayAiEnvelope({ id: 7, op: PlayBridgeOp.GenexConfirm, body: { kind: "grant", id: "g_123" } }),
      { id: 7, op: PlayBridgeOp.GenexConfirm, body: { kind: "grant", id: "g_123" } },
    );
  });
  const hostile: unknown[] = [
    { id: 0, op: "hello", body: null },
    { id: -1, op: "hello", body: null },
    { id: 1.5, op: "hello", body: null },
    { id: 2 ** 31, op: "hello", body: null },
    { id: "1", op: "hello", body: null },
    { id: 1, op: "hello" },
    { id: 1, op: "hello", body: null, game: "play:other" },
    { id: 1, op: "genex.confirm", body: { kind: "grant", id: "g_1", approved: true } },
    { id: 1, op: "genex.confirm", body: { kind: "spend", id: "g_1" } },
    { id: 1, op: "genex.approve", body: null },
    [1, "hello", null],
  ];
  for (const raw of hostile) it(`refuses ${JSON.stringify(raw)}`, () => assert.equal(readPlayAiEnvelope(raw), null));
});

describe("the embed-sdk desktop path (D3)", () => {
  it("reads exactly a kind and an id", () => {
    assert.deepEqual(readGenexConfirmRequest({ kind: GenexConfirmKind.Generate, id: "0b9f-11aa" }), {
      kind: "generate",
      id: "0b9f-11aa",
    });
    const hostile: unknown[] = [
      { kind: "grant" },
      { kind: "grant", id: "" },
      { kind: "grant", id: "a/b" },
      { kind: "grant", id: "x".repeat(101) },
      { kind: "grant", id: "g1", url: "https://evil.example" },
      { kind: "popup", id: "g1" },
      Object.assign(Object.create({ inherited: true }), { kind: "grant", id: "g1" }),
      null,
    ];
    for (const raw of hostile) assert.equal(readGenexConfirmRequest(raw), null, JSON.stringify(raw));
  });

  it("approves only on an exact true", () => {
    assert.deepEqual(readGenexConfirmAnswer({ approved: true }), { approved: true });
    for (const raw of [{ approved: "true" }, { approved: 1 }, {}, null, true]) {
      assert.deepEqual(readGenexConfirmAnswer(raw), { approved: false }, JSON.stringify(raw));
    }
  });

  it("finds the bridge only on its version, and passes the app's answer through the reader", async () => {
    assert.equal(genexDesktopBridgeOf({}), null);
    assert.equal(genexDesktopBridgeOf({ [GENEX_DESKTOP_GLOBAL]: { version: 2, confirm: () => null } }), null);
    assert.equal(genexDesktopBridgeOf({ [GENEX_DESKTOP_GLOBAL]: { version: 1, confirm: "no" } }), null);
    const asked: unknown[] = [];
    const bridge = genexDesktopBridgeOf({
      [GENEX_DESKTOP_GLOBAL]: {
        version: GENEX_DESKTOP_BRIDGE_VERSION,
        confirm: async (request: unknown) => {
          asked.push(request);
          return { approved: "yes" };
        },
      },
    });
    assert.ok(bridge);
    assert.deepEqual(await bridge.confirm({ kind: "grant", id: "g1" }), { approved: false });
    assert.deepEqual(asked, [{ kind: "grant", id: "g1" }]);
  });
});

describe("the Play Protocol's ai capability, line and ops", () => {
  const hello = (caps: Record<string, unknown>) =>
    readHello({ protocol: 3, view: { width: 8, height: 8 }, capabilities: caps });

  it("declares ai only on an exact true, and gates the AI ops on it", () => {
    const withAi = hello({ ai: true });
    const without = hello({ ai: "yes" });
    assert.ok(withAi && without);
    assert.equal(withAi.capabilities.ai, true);
    assert.equal(without.capabilities.ai, false);
    for (const op of Object.values(PlayAiOp)) {
      assert.equal(takesAiOp(withAi, op), true, op);
      assert.equal(takesAiOp(without, op), false, op);
    }
  });

  it("reads an ai line with its request id, and refuses everything else", () => {
    assert.deepEqual(readPlayAiLine({ event: PlayEvent.Ai, rid: "rid-00001", op: "hello", body: null }), {
      rid: "rid-00001",
      op: "hello",
      body: null,
    });
    const hostile: unknown[] = [
      { event: "ready", rid: "rid-00001", op: "hello", body: null },
      { event: "ai", rid: "r", op: "hello", body: null },
      { event: "ai", rid: "rid-00001", op: "hello", body: null, id: 3 },
      { event: "ai", rid: "rid-00001", op: "call", body: { ...CALL, v: 9 } },
      { event: "ai", rid: "rid-00001", op: "quit", body: null },
    ];
    for (const raw of hostile) assert.equal(readPlayAiLine(raw), null, JSON.stringify(raw));
  });
});
