/**
 * Play-time AI for an Unreal game playing in the person's own editor (PIE): the game's GenexAI
 * plugin queues each `ai` line, and Studio's relay channel (`unrealAiChannel` in `ai-relay.ts`)
 * pulls them and pushes the answers through the Genex editor helper's relay toolset on the editor's
 * own port. Answers travel as base64 only; a project without the plugin, an editor that is not
 * playing or one that does not answer is no play.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiBridgeOp, GAME_AI_WIRE_VERSION } from "../../src/shared/game-ai.ts";
import { PLAY_AI_MAX_LINE_CHARS, PlayAiOp, type PlayAiOutgoing, PlayEvent } from "../../src/shared/play-protocol.ts";
import {
  AI_RELAY_MAX_LINES,
  AI_RELAY_MAX_PULL_CHARS,
  AI_RELAY_MAX_PUSH_CHARS,
  AiRelayTool,
  unrealAiChannel,
} from "../../src/plugins/unreal/ai-relay.ts";

const signal = new AbortController().signal;
const helloLine = (rid: string) => ({ event: PlayEvent.Ai, rid, op: AiBridgeOp.Hello, body: null });
const reply = (rid: string, text = "ok"): PlayAiOutgoing => ({
  op: PlayAiOp.Reply,
  args: {
    rid,
    reply: {
      v: GAME_AI_WIRE_VERSION,
      ok: true,
      ticket: "uetk-00000001",
      value: text,
      source: "local",
      provenance: "unverified",
      latencyMs: 1,
      cached: false,
    },
  },
});

/** The helper's relay tools as the editor answers them: each call recorded, each answer scripted. */
function helper(answers: Array<unknown | Error>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call = async (tool: AiRelayTool, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { call, calls };
}

describe("the Unreal editor's AI relay channel", () => {
  it("pulls the lines the playing game queued, each read from its JSON text", async () => {
    const stand = helper([JSON.stringify({ playing: true, lines: [JSON.stringify(helloLine("ueai-00000001"))] })]);
    assert.deepEqual(await unrealAiChannel(stand.call).pull(signal), [helloLine("ueai-00000001")]);
    assert.deepEqual(stand.calls, [{ tool: AiRelayTool.Pull, args: {} }]);
  });

  const nothing: Array<[string, unknown | Error]> = [
    ["an editor that plays nothing", JSON.stringify({ playing: false, lines: [] })],
    ["an editor that does not answer", new Error("Unreal is not answering on its port")],
    ["an answer that is not text", { playing: true, lines: [] }],
    ["an answer that is not JSON", "{playing"],
    ["an answer over the cap", JSON.stringify({ playing: true, lines: ["x".repeat(AI_RELAY_MAX_PULL_CHARS)] })],
  ];
  for (const [name, answer] of nothing) {
    it(`answers no play for ${name}`, async () => {
      assert.equal(await unrealAiChannel(helper([answer]).call).pull(signal), null);
    });
  }

  const unread: Array<[string, unknown, unknown[]]> = [
    ["lines that are not a list", { playing: true, lines: "{}" }, []],
    ["a line that is not text", { playing: true, lines: [helloLine("ueai-00000001")] }, []],
    ["a line that is not JSON", { playing: true, lines: ["{nope"] }, []],
    ["a line over the cap", { playing: true, lines: [`"${"x".repeat(PLAY_AI_MAX_LINE_CHARS + 1)}"`] }, []],
    [
      "more lines than one pull takes",
      {
        playing: true,
        lines: Array.from({ length: AI_RELAY_MAX_LINES + 2 }, () => JSON.stringify(helloLine("ueai-00000001"))),
      },
      Array.from({ length: AI_RELAY_MAX_LINES }, () => helloLine("ueai-00000001")),
    ],
  ];
  for (const [name, said, expected] of unread) {
    it(`reads ${name} as no lines`, async () => {
      assert.deepEqual(await unrealAiChannel(helper([JSON.stringify(said)]).call).pull(signal), expected);
    });
  }

  it("pushes the answers as base64 only, whatever text a model wrote, split under its cap", async () => {
    const big = "y".repeat(Math.floor(AI_RELAY_MAX_PUSH_CHARS / 2));
    const items = [
      reply("ueai-00000001", "'); import os; os.remove('/') #"),
      reply("ueai-00000002", big),
      reply("ueai-00000003", big),
    ];
    const taken = JSON.stringify({ taken: true });
    const stand = helper([taken, taken, taken]);
    assert.equal(await unrealAiChannel(stand.call).push(items, signal), true);
    assert.ok(stand.calls.length >= 2, "more than one call");
    const sent = stand.calls.flatMap(({ tool, args }) => {
      assert.equal(tool, AiRelayTool.Push);
      const answers = String(args.answers);
      assert.match(answers, /^[A-Za-z0-9+/=]+$/);
      return JSON.parse(Buffer.from(answers, "base64").toString("utf8"));
    });
    assert.deepEqual(sent, items);
  });

  it("says the editor did not take a push it refused, could not read or never answered", async () => {
    for (const answer of [JSON.stringify({ taken: false }), "{taken", new Error("gone")])
      assert.equal(await unrealAiChannel(helper([answer]).call).push([reply("ueai-00000001")], signal), false);
  });
});
