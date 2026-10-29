/**
 * Play-time AI's boundaries into main: the IPC registrar (`main/ipc/game-ai.ts`) driven through the
 * real typed `handle()` with a recording host, the fixture policy of its channels and native
 * steps, and the harness's `ai.*` RPC (`main/harness-rpc/ai.ts`) on a real core. Every hostile
 * payload is refused before the host hears anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerGameAiIpc } from "../../src/main/ipc/game-ai.ts";
import { GameAiNativeStep, type GameAiHarnessHost, type GameAiIpcHost } from "../../src/main/game-ai/types.ts";
import {
  assertNativeActionAllowed,
  ChannelClass,
  classifyChannel,
  FIXTURE_NATIVE_STEPS,
} from "../../src/main/dev/native-policy.ts";
import { STUDIO_INVOKE_CHANNELS } from "../../src/shared/ipc-channels.ts";
import { HostMethod, harnessParamsProblem } from "../../src/shared/harness-api.ts";
import { AiSchemaProblem } from "../../src/shared/game-ai-schema.ts";
import { PLAY_BAR_CALLS } from "../../src/shared/play-bar.ts";
import { coreLite } from "../helpers/core-lite.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const studio = { sender: "studio", senderFrame: "main-frame" };

/** A host that records each call it hears and answers its arguments back. */
function recordingHost() {
  const heard: Array<[string, unknown[]]> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      heard.push([name, args]);
      return { echoed: name };
    };
  const methods = [
    "menu",
    "pick",
    "answer",
    "enable",
    "activity",
    "settings",
    "saveSettings",
    "tapes",
    "reportPreview",
    "report",
    "check",
    "checkState",
    "checkStop",
    "recommend",
    "publishFacts",
    "credits",
    "checkout",
  ] as const satisfies readonly (keyof GameAiIpcHost)[];
  const host = Object.fromEntries(methods.map((name) => [name, record(name)])) as unknown as GameAiIpcHost;
  return { host, heard };
}

function registered() {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  const { host, heard } = recordingHost();
  registerGameAiIpc(handle, host);
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(studio, payload);
  };
  return { listeners, invoke, heard };
}

const HAIKU = { door: "plan", engine: "claude-code", model: "claude-haiku-4-5" };
const AI_CHANNELS = Object.keys(STUDIO_INVOKE_CHANNELS).filter((channel) => channel.startsWith("studio:game-ai."));

describe("the game-ai registrar", () => {
  it("registers every studio:game-ai channel of the map", () => {
    const { listeners } = registered();
    assert.deepEqual([...listeners.keys()].sort(), [...AI_CHANNELS].sort());
  });

  it("hands the host the payloads it read", async () => {
    const { invoke, heard } = registered();
    const ok = [
      ["studio:game-ai.menu", { game: "play:p1" }],
      ["studio:game-ai.pick", { game: "play:p1", model: HAIKU }],
      ["studio:game-ai.answer", { ticket: "ticket-0001", approve: true, model: null, unranked: false }],
      ["studio:game-ai.enable", { game: "create:Lantern Run", enabled: false }],
      ["studio:game-ai.settings.save", { patch: { keepForBuildingPercent: 60 } }],
      ["studio:game-ai.tapes", { project: "lantern-run" }],
      ["studio:game-ai.report", { game: "play:p1", reason: "other", note: "odd reply" }],
      ["studio:game-ai.recommend", { project: "lantern-run", model: null }],
      ["studio:game-ai.checkout", { product: { kind: "pro" } }],
    ] as const;
    for (const [channel, payload] of ok) {
      const answer = await invoke(channel, payload);
      assert.equal(answer.ok, true, `${channel}: ${JSON.stringify(answer)}`);
    }
    assert.deepEqual(heard, [
      ["menu", ["play:p1"]],
      ["pick", ["play:p1", HAIKU]],
      ["answer", [{ ticket: "ticket-0001", approve: true, model: null, unranked: false }]],
      ["enable", ["create:Lantern Run", false]],
      ["saveSettings", [{ keepForBuildingPercent: 60 }]],
      ["tapes", ["lantern-run"]],
      ["report", [{ game: "play:p1", reason: "other", note: "odd reply" }]],
      ["recommend", ["lantern-run", null]],
      ["checkout", [{ kind: "pro" }]],
    ]);
  });

  const hostile: Array<[string, unknown]> = [
    ["studio:game-ai.menu", { game: "pong" }],
    ["studio:game-ai.menu", undefined],
    ["studio:game-ai.pick", { game: "play:p1", model: { ...HAIKU, door: "wallet" } }],
    ["studio:game-ai.pick", { game: "play:p1" }],
    ["studio:game-ai.answer", { ticket: "ticket-0001", approve: "yes", model: null, unranked: false }],
    ["studio:game-ai.answer", { ticket: "ticket-0001", approve: true, model: null, unranked: false, spend: 1 }],
    ["studio:game-ai.enable", { game: "play:p1", enabled: "off" }],
    ["studio:game-ai.settings.save", { patch: { balanceCredits: 5000 } }],
    ["studio:game-ai.settings.save", { patch: {} }],
    ["studio:game-ai.tapes", { project: "../other" }],
    ["studio:game-ai.tapes", { project: "a/b" }],
    ["studio:game-ai.tapes", { project: ".." }],
    ["studio:game-ai.tapes", { project: " padded" }],
    ["studio:game-ai.tapes", { project: "x\u0000" }],
    ["studio:game-ai.tapes", { project: 42 }],
    ["studio:game-ai.check", { project: "/Users/me/AI Games/pong" }],
    ["studio:game-ai.check.state", { project: "" }],
    ["studio:game-ai.recommend", { project: "pong", model: { door: "plan" } }],
    ["studio:game-ai.publish-facts", { project: "..\\x" }],
    ["studio:game-ai.report", { game: "play:p1", reason: "spam", note: null }],
    ["studio:game-ai.report.preview", { game: "create:" }],
    ["studio:game-ai.checkout", { product: { kind: "pack", packId: "p1", priceCents: 1 } }],
    ["studio:game-ai.checkout", { product: "pro" }],
  ];
  for (const [channel, payload] of hostile) {
    it(`refuses ${channel} ${JSON.stringify(payload)} before the host hears it`, async () => {
      const { invoke, heard } = registered();
      const answer = await invoke(channel, payload);
      assert.equal(answer.ok, false);
      assert.deepEqual(heard, []);
    });
  }
});

describe("the fixture policy of play-time AI", () => {
  it("keeps the spending and network channels native and the rest fixture-safe", () => {
    const native = [
      "studio:game-ai.settings.save",
      "studio:game-ai.report",
      "studio:game-ai.check",
      "studio:game-ai.checkout",
      "studio:game-ai.resume",
    ];
    for (const channel of AI_CHANNELS) {
      const expected = native.includes(channel) ? ChannelClass.Native : ChannelClass.FixtureSafe;
      assert.equal(classifyChannel(channel), expected, channel);
    }
  });

  it("refuses a card's yes on plan or money in a fixture profile, by its native step", () => {
    for (const step of Object.values(GameAiNativeStep)) {
      assert.ok(FIXTURE_NATIVE_STEPS.has(step), step);
      assert.throws(() => assertNativeActionAllowed(true, step), /unsupported-in-fixture/);
      assert.doesNotThrow(() => assertNativeActionAllowed(false, step));
    }
  });

  it("gives the Play bar the pill's calls and Get credits', and nothing that spends without a card", () => {
    const bar: readonly string[] = PLAY_BAR_CALLS;
    const pill = ["gameAiMenu", "gameAiPick", "gameAiAnswer", "gameAiEnable", "gameAiReport", "gameAiCheckout"];
    // Get credits reads the packs and auto top-up, and saves its switch (D11: a tap on Genex's own card).
    for (const call of [...pill, "gameAiCredits", "gameAiSettings", "gameAiSettingsSave"])
      assert.ok(bar.includes(call), call);
    for (const call of ["gameAiCheck", "gameAiRecommend", "gameAiActivity", "gameAiTapes"])
      assert.ok(!bar.includes(call), call);
  });
});

describe("the harness's ai.* calls", () => {
  it("checks a schema without play-time AI running, and refuses the rest with why", async () => {
    const { api, close } = await coreLite({ init: false });
    try {
      const table = api();
      assert.deepEqual(await table[HostMethod.AiSchemaCheck]({ schema: { type: "string" } }), { ok: true });
      assert.deepEqual(await table[HostMethod.AiSchemaCheck]({ schema: { type: "string", pattern: "x" } }), {
        ok: false,
        problem: AiSchemaProblem.UnknownKeyword,
      });
      await assert.rejects(table[HostMethod.AiTapes]({ project: "pong" }), /isn't running/);
    } finally {
      await close();
    }
  });

  it("refuses path-bearing params of the wrong shape before a handler runs", () => {
    const refused: Array<[string, unknown]> = [
      [HostMethod.AiReplay, { project: "pong", demo: "../../etc/passwd", seeds: [1] }],
      [HostMethod.AiReplay, { project: "pong", demo: "first", seeds: [] }],
      [HostMethod.AiReplay, { project: "pong", demo: "first", seeds: Array.from({ length: 9 }, (_, i) => i) }],
      [HostMethod.AiReplay, { project: "pong", demo: "first", seeds: [1.5] }],
      [HostMethod.AiRecord, { project: "pong", demo: "First Turn", seed: 1 }],
      [HostMethod.AiRecord, { project: "pong", demo: "first", seed: -1 }],
      [HostMethod.AiBench, { project: "pong", site: "a/b" }],
      [HostMethod.AiBench, { project: "pong", site: "turn", samples: 6 }],
      [HostMethod.AiTapes, { project: 3 }],
      [HostMethod.AiModelCheck, {}],
    ];
    for (const [method, params] of refused)
      assert.ok(harnessParamsProblem(method, params), `${method} ${JSON.stringify(params)}`);
    assert.equal(
      harnessParamsProblem(HostMethod.AiReplay, { project: "pong", demo: "first-turn", seeds: [1, 2] }),
      null,
    );
    assert.equal(harnessParamsProblem(HostMethod.AiBench, { project: "pong", site: "turn.resolve" }), null);
  });

  it("hands a game in the library to the host, and refuses one outside it", async () => {
    const heard: unknown[][] = [];
    const host: GameAiHarnessHost = {
      tapes: async (...args) => {
        heard.push(["tapes", ...args]);
        return [];
      },
      replay: async (...args) => {
        heard.push(["replay", ...args]);
        return { demo: args[1], deterministic: true, stateDigests: [], misses: 0, fallbacks: 0, rejected: 0 };
      },
      record: async () => assert.fail("not asked"),
      bench: async (...args) => {
        heard.push(["bench", ...args]);
        return {
          site: args[1],
          model: null,
          samples: 0,
          fitted: 0,
          medianLatencyMs: null,
          medianInputTokens: null,
          medianOutputTokens: null,
        };
      },
      modelCheck: async () => assert.fail("not asked"),
    };
    const { core, api, close } = await coreLite({ gameAi: host });
    try {
      const game = await core.games.create("Lantern Run");
      const table = api();
      await table[HostMethod.AiTapes]({ project: game.name });
      await table[HostMethod.AiReplay]({ project: game.name, demo: "first-turn", seeds: [1, 2] });
      await table[HostMethod.AiBench]({ project: game.name, site: "npc.greet" });
      await assert.rejects(table[HostMethod.AiTapes]({ project: "someone-elses" }));
      // The game's own folder is no root; a bench also carries the run budget the host made for it.
      assert.deepEqual(
        heard.map((call) => call.slice(0, 4)),
        [
          ["tapes", game.name, { root: null }],
          ["replay", game.name, "first-turn", [1, 2]],
          ["bench", game.name, "npc.greet", 5],
        ],
      );
      assert.deepEqual(heard[1]?.[4], { root: null, answers: "tape" });
    } finally {
      await close();
    }
  });
});
