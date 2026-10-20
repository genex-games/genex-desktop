/**
 * Play-time AI for a Unity game in Play mode in the person's own editor: the game's `com.genex.ai`
 * package queues each `ai` line in `Genex.AI.GenexAiRelay`, and Studio's relay channel
 * (`unityAiChannel` in `ai-relay.ts`) pulls them and pushes the answers through the editor's
 * existing Pipeline server, with host-owned C# only: nothing the game or a model wrote ever becomes
 * code, an answer travels as base64. An editor that is closed, not playing or without the package
 * is no play.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiBridgeOp, GAME_AI_WIRE_VERSION } from "../../src/shared/game-ai.ts";
import { PLAY_AI_MAX_LINE_CHARS, PlayAiOp, type PlayAiOutgoing, PlayEvent } from "../../src/shared/play-protocol.ts";
import {
  AI_RELAY_MAX_LINES,
  AI_RELAY_MAX_PUSH_CHARS,
  AiRelayCode,
  unityAiChannel,
} from "../../src/plugins/unity/ai-relay.ts";
import { editor, json, openProject, unityProject } from "../helpers/unity-editor-stand-in.ts";

const signal = new AbortController().signal;
const helloLine = (rid: string) => ({ event: PlayEvent.Ai, rid, op: AiBridgeOp.Hello, body: null });
/** The editor's answer to an `eval`, as Pipeline 0.8 wraps it. */
const evaluated = (result: unknown) => json(200, { success: true, result });
const reply = (rid: string, text = "ok"): PlayAiOutgoing => ({
  op: PlayAiOp.Reply,
  args: {
    rid,
    reply: {
      v: GAME_AI_WIRE_VERSION,
      ok: true,
      ticket: "untk-00000001",
      value: text,
      source: "local",
      provenance: "unverified",
      latencyMs: 1,
      cached: false,
    },
  },
});

/** The C# an eval request carried. */
const codeOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null && "parameters" in body
    ? (body.parameters as { code?: unknown }).code
    : undefined;

describe("the Unity editor's AI relay channel", () => {
  it("pulls the lines the playing game queued with the host's own C#, each line read from its JSON", async () => {
    const root = await openProject();
    const stand = editor([evaluated({ playing: true, lines: [JSON.stringify(helloLine("unai-00000001"))] })]);
    const channel = unityAiChannel(root, stand.deps);
    assert.deepEqual(await channel.pull(signal), [helloLine("unai-00000001")]);
    assert.equal(stand.seen.length, 1);
    assert.match(stand.seen[0]?.url ?? "", /\/api\/exec$/);
    assert.deepEqual(stand.seen[0]?.body, { command: "eval", parameters: { code: AiRelayCode.Pull } });
  });

  it("answers no play while the editor plays nothing, is closed, or has no Genex AI package", async () => {
    const idle = editor([evaluated({ playing: false, lines: [] })]);
    assert.equal(await unityAiChannel(await openProject(), idle.deps).pull(signal), null);
    const closed = editor([]);
    assert.equal(await unityAiChannel(await unityProject(), closed.deps).pull(signal), null);
    assert.deepEqual(closed.seen, [], "a closed project is asked nothing");
    const missing = editor([
      json(200, { success: false, error: "The name 'Genex' does not exist in the current context" }),
    ]);
    assert.equal(await unityAiChannel(await openProject(), missing.deps).pull(signal), null);
  });

  const hostile: Array<[string, unknown, unknown[] | null]> = [
    ["a result that is not an object", "lines", null],
    ["lines that are not a list", { playing: true, lines: "{}" }, []],
    ["a line that is not text", { playing: true, lines: [helloLine("unai-00000001")] }, []],
    ["a line that is not JSON", { playing: true, lines: ["{nope"] }, []],
    ["a line over the cap", { playing: true, lines: [`"${"x".repeat(PLAY_AI_MAX_LINE_CHARS + 1)}"`] }, []],
    [
      "more lines than one pull takes",
      {
        playing: true,
        lines: Array.from({ length: AI_RELAY_MAX_LINES + 3 }, () => JSON.stringify(helloLine("unai-00000001"))),
      },
      Array.from({ length: AI_RELAY_MAX_LINES }, () => helloLine("unai-00000001")),
    ],
  ];
  for (const [name, result, expected] of hostile) {
    it(`reads ${name} as no lines`, async () => {
      const stand = editor([evaluated(result)]);
      assert.deepEqual(await unityAiChannel(await openProject(), stand.deps).pull(signal), expected);
    });
  }

  it("pushes the answers as base64 into host-owned C#, whatever text a model wrote", async () => {
    const root = await openProject();
    const stand = editor([evaluated(true)]);
    const items = [reply("unai-00000001", '"); System.IO.File.Delete("/"); //'), reply("unai-00000002")];
    assert.equal(await unityAiChannel(root, stand.deps).push(items, signal), true);
    const code = String(codeOf(stand.seen[0]?.body));
    const match = /^return Genex\.AI\.GenexAiRelay\.Push\("([A-Za-z0-9+/=]*)"\);$/.exec(code);
    assert.ok(match, `only base64 rides in the code: ${code.slice(0, 120)}`);
    assert.deepEqual(JSON.parse(Buffer.from(match[1] ?? "", "base64").toString("utf8")), items);
  });

  it("splits a large push so no request carries more than its cap", async () => {
    const root = await openProject();
    const big = "y".repeat(Math.floor(AI_RELAY_MAX_PUSH_CHARS / 2));
    const stand = editor([evaluated(true), evaluated(true), evaluated(true)]);
    const items = [reply("unai-00000001", big), reply("unai-00000002", big), reply("unai-00000003", big)];
    assert.equal(await unityAiChannel(root, stand.deps).push(items, signal), true);
    assert.ok(stand.seen.length >= 2, "more than one request");
    const sent = stand.seen.flatMap((seen) => {
      const code = String(codeOf(seen.body));
      assert.ok(code.length <= AI_RELAY_MAX_PUSH_CHARS + AiRelayCode.push("").length, "each within its cap");
      const base64 = /Push\("([^"]*)"\)/.exec(code)?.[1] ?? "";
      return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    });
    assert.deepEqual(sent, items, "every answer once, in order");
  });

  it("says the editor did not take a push it refused or could not run", async () => {
    const refused = editor([evaluated(false)]);
    assert.equal(await unityAiChannel(await openProject(), refused.deps).push([reply("unai-00000001")], signal), false);
    const failed = editor([json(200, { success: false, error: "not playing" })]);
    assert.equal(await unityAiChannel(await openProject(), failed.deps).push([reply("unai-00000001")], signal), false);
    const closed = editor([]);
    assert.equal(await unityAiChannel(await unityProject(), closed.deps).push([reply("unai-00000001")], signal), false);
  });
});
