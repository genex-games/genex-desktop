/**
 * A game played in its engine's editor reaches the AI service through its editor's own channel
 * (`main/game-ai/bridge-editor.ts`): Studio pulls the lines the game queued and pushes the answers
 * back, no port of its own. Each pull is read as Play Protocol `ai` lines; anything else is dropped
 * without reaching the service, a play that ended abandons its calls, and the caller is the
 * creator's own game: Create Live while a person plays, a harness run while the agent does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  AiAuthority,
  AiBridgeOp,
  AiErrorCode,
  AiOp,
  AiTier,
  GAME_AI_WIRE_VERSION,
  createGameKey,
  refusedAnswer,
} from "../../src/shared/game-ai.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { PLAY_AI_MAX_IN_FLIGHT, PLAY_AI_MAX_LINE_CHARS, PlayAiOp, PlayEvent } from "../../src/shared/play-protocol.ts";
import {
  EDITOR_AI_MAX_PULL,
  type EditorAiChannel,
  editorAiRelay,
  editorCaller,
  runEditorAiRelay,
} from "../../src/main/game-ai/bridge-editor.ts";
import type { AiOutgoing } from "../../src/main/game-ai/bridge-native.ts";
import { fixtureAiService } from "../helpers/ai-fixture-service.ts";

const GAME = { name: "pax", title: "Pax" };
const PLACE = { cwd: "/games/pax/godot", channel: "editor:godot:pax" };

const helloLine = (rid: string) => ({ event: PlayEvent.Ai, rid, op: AiBridgeOp.Hello, body: null });

/** A call line, as a game queues it. */
const callLine = (rid: string, ticket: string) => ({
  event: PlayEvent.Ai,
  rid,
  op: AiBridgeOp.Call,
  body: {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Ask,
    site: "turn.resolve",
    ticket,
    grantId: "no-grant",
    system: null,
    prompt: "Resolve the turn.",
    untrusted: {},
    memory: null,
    schema: { type: "boolean" },
    tier: AiTier.Fast,
    authority: AiAuthority.Local,
    maxOutputTokens: 64,
    stream: false,
  },
});

/** A channel the test fills: what the game queued for the next pull, and every push it was handed. */
function scriptedChannel() {
  const queued: unknown[][] = [];
  const pushed: AiOutgoing[][] = [];
  const state = { playing: true, pushOk: true, pullThrows: false };
  const channel: EditorAiChannel = {
    pull: async () => {
      if (state.pullThrows) throw new Error("editor went away mid-read");
      return state.playing ? (queued.shift() ?? []) : null;
    },
    push: async (items) => {
      pushed.push([...items]);
      return state.pushOk;
    },
  };
  return { channel, queued, pushed, state };
}

function relayOver(agent = false, createRoute = true) {
  const fixture = fixtureAiService();
  const scripted = scriptedChannel();
  const logs: string[] = [];
  const relay = editorAiRelay(scripted.channel, {
    service: fixture.service,
    game: GAME,
    place: PLACE,
    agentPlaying: () => agent,
    createRouteEnabled: () => createRoute,
    log: (line) => logs.push(line),
  });
  return { relay, fixture, logs, ...scripted };
}

/** One pull, then one more after the fixture service answered: the answers ride the second push. */
async function twoTicks(relay: ReturnType<typeof editorAiRelay>) {
  const signal = new AbortController().signal;
  await relay.tick(signal);
  await nextTurn();
  await nextTurn();
  await relay.tick(signal);
}

describe("an engine editor's AI relay", () => {
  it("asks the service each line the game queued, and pushes its answer back by its rid", async () => {
    const { relay, fixture, queued, pushed } = relayOver();
    queued.push([helloLine("rid-00001")]);
    await twoTicks(relay);
    assert.equal(fixture.asked.length, 1);
    assert.deepEqual(pushed.flat(), [
      { op: PlayAiOp.Reply, args: { rid: "rid-00001", reply: { v: GAME_AI_WIRE_VERSION, on: true } } },
    ]);
  });

  it("asks as the creator's own game in Create Live while a person plays", async () => {
    const { relay, fixture, queued } = relayOver(false);
    queued.push([helloLine("rid-00001")]);
    await twoTicks(relay);
    assert.deepEqual(fixture.asked[0]?.caller, {
      game: createGameKey("pax"),
      title: "Pax",
      context: AiContext.CreateLive,
      ownGame: true,
      replaying: false,
      channel: PLACE.channel,
    });
  });

  it("answers ai_off to a person's editor play while Settings' AI in your playtests is off (D1)", async () => {
    const { relay, fixture, queued, pushed } = relayOver(false, false);
    queued.push([helloLine("rid-00001"), callLine("rid-00002", "t_00000002")]);
    await twoTicks(relay);
    assert.equal(fixture.asked.length, 0, "the service is never asked: nothing can spend");
    const replies = pushed
      .flat()
      .map((item) => ("reply" in item.args ? item.args.reply : null) as { code?: string; on?: boolean });
    assert.equal(replies.length, 2);
    for (const reply of replies) assert.ok(reply.code === AiErrorCode.Off || reply.on === false, JSON.stringify(reply));
  });

  it("still relays the agent's play while the switch is off: a harness run never spends", async () => {
    const { relay, fixture, queued } = relayOver(true, false);
    queued.push([helloLine("rid-00001")]);
    await twoTicks(relay);
    assert.equal(fixture.asked[0]?.caller.context, AiContext.HarnessRun);
  });

  it("asks as a harness run while the agent plays", async () => {
    const { relay, fixture, queued } = relayOver(true);
    queued.push([helloLine("rid-00001")]);
    await twoTicks(relay);
    assert.equal(fixture.asked[0]?.caller.context, AiContext.HarnessRun);
  });

  it("pushes nothing when nothing settled", async () => {
    const { relay, pushed } = relayOver();
    await relay.tick(new AbortController().signal);
    assert.deepEqual(pushed, []);
  });

  const hostile: Array<[string, unknown]> = [
    ["a line of another event", { ...helloLine("rid-00001"), event: PlayEvent.Ready }],
    ["a line with an extra key", { ...helloLine("rid-00001"), grant: "all" }],
    ["a rid too short", helloLine("r1")],
    ["an unknown op", { ...helloLine("rid-00001"), op: "spend" }],
    ["a body on hello", { ...helloLine("rid-00001"), body: { on: true } }],
    ["a call that is not one", { ...helloLine("rid-00001"), op: AiBridgeOp.Call, body: { prompt: 1 } }],
    ["a string", JSON.stringify(helloLine("rid-00001"))],
    ["an array", [helloLine("rid-00001")]],
    ["null", null],
    [
      "a line over the cap",
      { ...helloLine("rid-00001"), op: AiBridgeOp.Cancel, body: { ticket: "t".repeat(PLAY_AI_MAX_LINE_CHARS) } },
    ],
  ];
  for (const [name, raw] of hostile) {
    it(`drops ${name} without asking the service or answering`, async () => {
      const { relay, fixture, queued, pushed, logs } = relayOver();
      queued.push([raw]);
      await twoTicks(relay);
      assert.equal(fixture.asked.length, 0);
      assert.deepEqual(pushed, []);
      assert.ok(logs.some((line) => line.includes("dropped")));
    });
  }

  it("reads at most its cap of lines from one pull and drops the rest", async () => {
    const { relay, fixture, queued, logs } = relayOver();
    const many = Array.from({ length: EDITOR_AI_MAX_PULL + 3 }, (_, i) =>
      helloLine(`rid-${String(i).padStart(5, "0")}`),
    );
    queued.push(many);
    await relay.tick(new AbortController().signal);
    assert.ok(fixture.asked.length <= PLAY_AI_MAX_IN_FLIGHT);
    assert.ok(logs.some((line) => line.includes("more than")));
  });

  it("refuses a fifth unanswered line with grant_concurrency, never asking the service", async () => {
    const { relay, fixture, queued, pushed } = relayOver();
    const fifth = `rid-0000${PLAY_AI_MAX_IN_FLIGHT}`;
    queued.push([
      ...Array.from({ length: PLAY_AI_MAX_IN_FLIGHT }, (_, i) => helloLine(`rid-0000${i}`)),
      callLine(fifth, "ticket-fifth"),
    ]);
    await relay.tick(new AbortController().signal);
    assert.equal(fixture.asked.length, PLAY_AI_MAX_IN_FLIGHT);
    assert.deepEqual(
      pushed.flat().find((item) => item.args.rid === fifth),
      { op: PlayAiOp.Reply, args: { rid: fifth, reply: refusedAnswer("ticket-fifth", AiErrorCode.Concurrency) } },
    );
  });

  it("abandons the play's calls when the editor stops playing, and starts afresh on the next play", async () => {
    const { relay, fixture, queued, state } = relayOver();
    queued.push([helloLine("rid-00001")]);
    await relay.tick(new AbortController().signal);
    state.playing = false;
    await relay.tick(new AbortController().signal);
    assert.deepEqual(fixture.abandoned, [PLACE.channel]);
    state.playing = true;
    queued.push([helloLine("rid-00001")]);
    await relay.tick(new AbortController().signal);
    assert.equal(fixture.asked.length, 2, "the same rid in a new play is a new line");
  });

  it("treats a pull that throws as the play gone, and logs why", async () => {
    const { relay, fixture, queued, state, logs } = relayOver();
    queued.push([helloLine("rid-00001")]);
    await relay.tick(new AbortController().signal);
    state.pullThrows = true;
    await relay.tick(new AbortController().signal);
    assert.deepEqual(fixture.abandoned, [PLACE.channel]);
    assert.ok(logs.some((line) => line.includes("mid-read")));
  });

  it("logs a push the editor did not take, and keeps relaying", async () => {
    const { relay, fixture, queued, state, logs } = relayOver();
    state.pushOk = false;
    queued.push([helloLine("rid-00001")]);
    await twoTicks(relay);
    assert.ok(logs.some((line) => line.includes("did not take")));
    queued.push([helloLine("rid-00002")]);
    await relay.tick(new AbortController().signal);
    assert.equal(fixture.asked.length, 2);
  });

  it("abandons on close and reads nothing after", async () => {
    const { relay, fixture, queued } = relayOver();
    queued.push([helloLine("rid-00001")]);
    await relay.tick(new AbortController().signal);
    relay.close();
    relay.close();
    queued.push([helloLine("rid-00002")]);
    await relay.tick(new AbortController().signal);
    assert.deepEqual(fixture.abandoned, [PLACE.channel]);
    assert.equal(fixture.asked.length, 1);
  });
});

describe("the editor relay's loop", () => {
  it("ticks on its cadence until stopped, then closes the relay", async () => {
    const ticks: number[] = [];
    let closed = 0;
    const controller = new AbortController();
    const slept: number[] = [];
    await runEditorAiRelay(
      {
        tick: async () => {
          ticks.push(ticks.length);
          if (ticks.length === 3) controller.abort();
        },
        close: () => {
          closed += 1;
        },
      },
      {
        pollMs: 250,
        signal: controller.signal,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    assert.equal(ticks.length, 3);
    assert.deepEqual(slept, [250, 250]);
    assert.equal(closed, 1);
  });
});

describe("editorCaller", () => {
  it("is the creator's own game, never replaying, on the editor's channel", () => {
    assert.deepEqual(editorCaller(GAME, PLACE, false), {
      game: createGameKey("pax"),
      title: "Pax",
      context: AiContext.CreateLive,
      ownGame: true,
      replaying: false,
      channel: PLACE.channel,
    });
  });
});
