/**
 * A native game's play-time AI bridge (`main/game-ai/bridge-native.ts`) over a scripted client and
 * a scripted service: each `ai` line becomes one service call under main's caller, its answer goes
 * back once with its rid, on step boundaries while the clock is held, and every refusal (a fifth
 * line, a repeated rid, AI off) is answered at once without reaching the service.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiBridgeOp,
  AiErrorCode,
  AiOp,
  AiSource,
  AiProvenance,
  type AiCallAnswer,
  createGameKey,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import type { AiBridgeMessage } from "../../src/shared/game-ai-bridge.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { type PlayAiLine, PlayAiOp, type PlayHello } from "../../src/shared/play-protocol.ts";
import type { PlayDeadlines } from "../../src/substrate/play-protocol-client.ts";
import {
  type AiBridgeAnswer,
  bridgeMessageOf,
  NATIVE_AI_REPLAY_WAIT_MS,
  type NativeAiService,
  nativeAiBridge,
  refusedBridgeAnswer,
} from "../../src/main/game-ai/bridge-native.ts";
import type { GameAiCaller } from "../../src/main/game-ai/types.ts";

const HELLO: PlayHello = {
  protocol: 3,
  name: "pax",
  view: { width: 64, height: 40 },
  capabilities: {
    pointer: "absolute",
    clock: "replayable",
    state: "game",
    seed: true,
    actions: [],
    screenshot: ["png"],
    ai: true,
  },
  ops: [],
  unsupported: [],
  build: null,
};

const CALLER: GameAiCaller = {
  game: createGameKey("pax"),
  title: "Pax",
  context: AiContext.Native,
  ownGame: true,
  replaying: false,
  channel: "native:41",
};

/** A call line of the given rid and ticket. */
function callLine(rid: string, ticket = `ticket-${rid}`, op: AiOp = AiOp.Ask): PlayAiLine {
  return {
    rid,
    op: AiBridgeOp.Call,
    body: {
      v: GAME_AI_WIRE_VERSION,
      op,
      site: "turn.resolve",
      ticket,
      grantId: "no-grant",
      system: null,
      prompt: "Resolve the turn.",
      untrusted: {},
      memory: null,
      schema: op === AiOp.Say ? null : { type: "boolean" },
      tier: "fast",
      authority: "local",
      maxOutputTokens: 64,
      stream: op === AiOp.Say,
    },
  };
}

const answerOf = (ticket: string, value: unknown = true): AiCallAnswer => ({
  v: GAME_AI_WIRE_VERSION,
  ok: true,
  ticket,
  value,
  source: AiSource.Tape,
  provenance: AiProvenance.Replay,
  latencyMs: 3,
  cached: false,
});

/** A service whose answers the test settles by hand, recording every call and every abandon. */
function scriptedService() {
  const calls: Array<{ caller: GameAiCaller; message: AiBridgeMessage; onDelta?: (text: string) => void }> = [];
  const waiting: Array<{ resolve: (value: AiBridgeAnswer) => void; reject: (error: Error) => void }> = [];
  const abandoned: string[] = [];
  const service: NativeAiService = {
    handle: (caller, message, onDelta) => {
      calls.push({ caller, message, ...(onDelta ? { onDelta } : {}) });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    abandon: (channel) => {
      abandoned.push(channel);
    },
  };
  return { service, calls, waiting, abandoned };
}

/** A client that records what was sent and acknowledges it, or refuses when told. */
function recordingClient() {
  const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
  let refuse = false;
  return {
    sent,
    refuseFromNowOn: () => {
      refuse = true;
    },
    client: {
      send: (op: string, args: Record<string, unknown>) => {
        sent.push({ op, args });
        return refuse ? Promise.reject(new Error("unknown-op")) : Promise.resolve({});
      },
    },
  };
}

/** Deadlines that fire only when the test moves time. */
function manualDeadlines(): PlayDeadlines & { advance(ms: number): void } {
  let now = 0;
  const timers = new Set<{ at: number; fire: () => void }>();
  return {
    after(ms, fire) {
      const timer = { at: now + ms, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.fire();
      }
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A bridge over the scripted parts; `held` is the clock the test holds or lets run. */
function bridgeOver(options: { held?: boolean; caller?: GameAiCaller | null; hello?: PlayHello } = {}) {
  const service = scriptedService();
  const client = recordingClient();
  const clock = { held: options.held ?? false };
  const deadlines = manualDeadlines();
  const logs: string[] = [];
  const caller = options.caller === undefined ? CALLER : options.caller;
  const bridge = nativeAiBridge(
    client.client,
    { cwd: "/games/pax", channel: CALLER.channel, hello: options.hello ?? HELLO },
    { service: service.service, callerFor: () => caller, deadlines, log: (line) => logs.push(line) },
    () => clock.held,
  );
  return { bridge, service, client, clock, deadlines, logs };
}

describe("a native game's AI bridge", () => {
  it("is not there for a game whose hello did not declare ai", () => {
    const { bridge } = bridgeOver({ hello: { ...HELLO, capabilities: { ...HELLO.capabilities, ai: false } } });
    assert.equal(bridge, null);
  });

  it("hands the service the line's message under main's caller, and echoes its rid on the reply", async () => {
    const { bridge, service, client } = bridgeOver();
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    assert.equal(service.calls.length, 1);
    assert.deepEqual(service.calls[0]?.caller, CALLER);
    assert.deepEqual(service.calls[0]?.message, bridgeMessageOf(callLine("rid-00001")));
    assert.equal("rid" in (service.calls[0]?.message ?? {}), false, "the rid stays the bridge's");
    service.waiting[0]?.resolve(answerOf("ticket-rid-00001"));
    await settle();
    assert.deepEqual(client.sent, [
      { op: PlayAiOp.Reply, args: { rid: "rid-00001", reply: answerOf("ticket-rid-00001") } },
    ]);
    assert.equal(bridge.inFlight(), 0);
  });

  it("holds an answer while the studio holds the clock, and delivers it at the next step boundary", async () => {
    const { bridge, service, client } = bridgeOver({ held: true });
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    service.waiting[0]?.resolve(answerOf("ticket-rid-00001"));
    await settle();
    assert.equal(client.sent.length, 0, "nothing is written between steps");
    await bridge.boundary();
    assert.deepEqual(
      client.sent.map((item) => item.op),
      [PlayAiOp.Reply],
    );
  });

  it("makes a replay's step wait for the answers its tape holds, so they land on the same tick", async () => {
    const { bridge, service, client } = bridgeOver({ held: true, caller: { ...CALLER, replaying: true } });
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    const step = bridge.boundary();
    setImmediate(() => service.waiting[0]?.resolve(answerOf("ticket-rid-00001")));
    await step;
    assert.equal(client.sent.length, 1, "the answer went out before the step ran");
  });

  it("gives up waiting for a replay's answer at its deadline, and delivers it at a later boundary", async () => {
    const { bridge, service, client, deadlines } = bridgeOver({ held: true, caller: { ...CALLER, replaying: true } });
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    const step = bridge.boundary();
    deadlines.advance(NATIVE_AI_REPLAY_WAIT_MS);
    await step;
    assert.deepEqual(client.sent, []);
    service.waiting[0]?.resolve(answerOf("ticket-rid-00001"));
    await settle();
    await bridge.boundary();
    assert.equal(client.sent.length, 1);
  });

  it("does not make a live step wait for a model still answering", async () => {
    const { bridge, client } = bridgeOver({ held: true });
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    await bridge.boundary();
    assert.deepEqual(client.sent, []);
    assert.equal(bridge.inFlight(), 1);
  });

  it("refuses a fifth unanswered line at once with grant_concurrency, never asking the service", async () => {
    const { bridge, service, client } = bridgeOver();
    assert.ok(bridge);
    for (let i = 1; i <= 5; i++) bridge.hear(callLine(`rid-0000${i}`));
    assert.equal(service.calls.length, 4);
    await settle();
    assert.deepEqual(client.sent, [
      {
        op: PlayAiOp.Reply,
        args: { rid: "rid-00005", reply: refusedBridgeAnswer(callLine("rid-00005"), AiErrorCode.Concurrency) },
      },
    ]);
  });

  it("drops a line repeating a rid still unanswered", () => {
    const { bridge, service, logs } = bridgeOver();
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    bridge.hear(callLine("rid-00001", "ticket-other"));
    assert.equal(service.calls.length, 1);
    assert.ok(logs.some((line) => line.includes("rid-00001")));
  });

  it("answers ai_off for a process AI is off for, never asking the service", async () => {
    const { bridge, service, client } = bridgeOver({ caller: null });
    assert.ok(bridge);
    bridge.hear({ rid: "rid-00001", op: AiBridgeOp.Hello, body: null });
    bridge.hear(callLine("rid-00002"));
    await settle();
    assert.equal(service.calls.length, 0);
    assert.deepEqual(
      client.sent.map((item) => item.args.reply),
      [{ v: GAME_AI_WIRE_VERSION, on: false }, refusedBridgeAnswer(callLine("rid-00002"), AiErrorCode.Off)],
    );
  });

  it("streams a say's newest text as ai.delta, coalesced, and never after its reply", async () => {
    const { bridge, service, client } = bridgeOver({ held: true });
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001", "ticket-say-1", AiOp.Say));
    const onDelta = service.calls[0]?.onDelta;
    assert.ok(onDelta);
    onDelta("Once");
    onDelta("Once upon");
    await bridge.boundary();
    await bridge.boundary();
    service.waiting[0]?.resolve(answerOf("ticket-say-1", "Once upon a time"));
    await settle();
    onDelta("late text");
    await bridge.boundary();
    assert.deepEqual(client.sent, [
      { op: PlayAiOp.Delta, args: { rid: "rid-00001", text: "Once upon" } },
      { op: PlayAiOp.Reply, args: { rid: "rid-00001", reply: answerOf("ticket-say-1", "Once upon a time") } },
    ]);
  });

  it("answers provider when the service throws, and logs why", async () => {
    const { bridge, service, client, logs } = bridgeOver();
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    service.waiting[0]?.reject(new Error("door exploded"));
    await settle();
    assert.deepEqual(client.sent[0]?.args.reply, refusedBridgeAnswer(callLine("rid-00001"), AiErrorCode.Provider));
    assert.ok(logs.some((line) => line.includes("door exploded")));
  });

  it("logs a game that refuses an ai op and keeps going", async () => {
    const { bridge, service, client, logs } = bridgeOver();
    assert.ok(bridge);
    client.refuseFromNowOn();
    bridge.hear(callLine("rid-00001"));
    service.waiting[0]?.resolve(answerOf("ticket-rid-00001"));
    await settle();
    await settle();
    assert.ok(logs.some((line) => line.includes(PlayAiOp.Reply)));
    bridge.hear(callLine("rid-00002"));
    assert.equal(service.calls.length, 2);
  });

  it("abandons the process's calls when it goes away, and writes nothing after", async () => {
    const { bridge, service, client } = bridgeOver();
    assert.ok(bridge);
    bridge.hear(callLine("rid-00001"));
    bridge.close();
    bridge.close();
    assert.deepEqual(service.abandoned, [CALLER.channel]);
    service.waiting[0]?.resolve(answerOf("ticket-rid-00001"));
    bridge.hear(callLine("rid-00002"));
    await settle();
    assert.deepEqual(client.sent, []);
    assert.equal(service.calls.length, 1);
  });
});

describe("refusedBridgeAnswer: what a bridge answers a message it will not run", () => {
  const rows: Array<[AiBridgeMessage, unknown]> = [
    [
      { op: AiBridgeOp.Hello, body: null },
      { v: GAME_AI_WIRE_VERSION, on: false },
    ],
    [
      { op: AiBridgeOp.Doors, body: null },
      { on: false, door: null },
    ],
    [bridgeMessageOf(callLine("rid-00001")), refusedBridgeAnswer(callLine("rid-00001"), AiErrorCode.Off)],
    [{ op: AiBridgeOp.Cancel, body: { ticket: "ticket-0001" } }, { canceled: false }],
    [
      { op: AiBridgeOp.BudgetActive, body: null },
      { view: null, code: AiErrorCode.Off },
    ],
    [
      { op: AiBridgeOp.BudgetRequest, body: { v: GAME_AI_WIRE_VERSION, requires: "ai", tiers: ["fast"] } },
      { view: null, code: AiErrorCode.Off },
    ],
    [{ op: AiBridgeOp.BudgetStop, body: null }, { stopped: false }],
  ];
  for (const [message, answer] of rows) {
    it(`answers ${message.op}`, () => {
      assert.deepEqual(refusedBridgeAnswer(message, AiErrorCode.Off), answer);
    });
  }

  it("refuses a call by its own ticket", () => {
    assert.deepEqual(refusedBridgeAnswer(callLine("rid-00001", "ticket-abc1"), AiErrorCode.Off), {
      v: GAME_AI_WIRE_VERSION,
      ok: false,
      ticket: "ticket-abc1",
      code: AiErrorCode.Off,
      retryAfterMs: null,
    });
  });
});
