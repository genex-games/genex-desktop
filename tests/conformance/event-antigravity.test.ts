/**
 * Antigravity's ACP session updates as the studio's log reads them, and the ACP wire itself.
 * The build is replayed from a turn recorded from Antigravity CLI 1.5.7 (`agy acp`), with the
 * account's name taken out of the command's output and the session's command list shortened.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AcpConnection, AcpError, AcpErrorCode, AcpMethod } from "../../src/substrate/engines/acp.ts";
import {
  antigravityStream,
  flushAntigravityStream,
  translateAntigravityUpdate,
} from "../../src/substrate/engines/antigravity-events.ts";
import { ChatActivityPhase } from "../../src/shared/chat-activity.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");

type Json = Record<string, unknown>;

/** The recorded turn's `session/update` bodies, in order. */
async function recordedUpdates(): Promise<Json[]> {
  const lines = (await readFile(path.join(FIXTURES, "antigravity-build-1.5.7.jsonl"), "utf8")).split("\n");
  return lines
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { dir: string; message: { method?: string; params?: { update?: Json } } })
    .filter((entry) => entry.dir === "in" && entry.message.method === AcpMethod.SessionUpdate)
    .map((entry) => entry.message.params?.update ?? {});
}

const parts = (event: { payload: unknown }) => (event.payload as { parts: Json[] }).parts;

describe("Antigravity's session updates", () => {
  it("mirrors a recorded build: the thought, each tool once with its result, the reply as one stretch", async () => {
    const stream = antigravityStream();
    const translated = (await recordedUpdates()).map((update) => translateAntigravityUpdate(update, stream));
    const end = flushAntigravityStream(stream);
    const mirrored = [...translated, end].flatMap((step) => step.events).flatMap(parts);
    assert.deepEqual(
      mirrored.map((part) => [part.type, part.name ?? part.tool_use_id ?? ""]),
      [
        ["thinking", ""],
        ["tool_use", "Write"],
        ["tool_result", "call_4368293378861202772"],
        ["tool_use", "Bash"],
        ["tool_result", "call_14585907665356211524"],
        ["text", ""],
      ],
      "four states of one call are one start and one result",
    );
    assert.equal(mirrored[1]?.input, "/private/tmp/agy-probe/ws/hello.txt", "a file tool shows its file");
    assert.equal(mirrored[3]?.input, "ls -la", "a command shows its command line");
    assert.equal(mirrored[4]?.is_error, false);
    assert.match(String(mirrored[4]?.content), /hello\.txt/, "the command's output is its result");
    assert.equal(
      end.text,
      'I have created [hello.txt](file:///private/tmp/agy-probe/ws/hello.txt) with the word "hi" and confirmed its presence using `ls -la`.',
      "the last stretch of words is the build's summary",
    );
    const turns = [...translated, end].reduce((sum, step) => sum + (step.turns ?? 0), 0);
    assert.equal(turns, 3, "two tool calls and the reply");
  });

  it("streams the reply's pieces under one stretch, and the words after a tool call under the next", () => {
    const stream = antigravityStream();
    const chunk = (words: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
    const first = translateAntigravityUpdate(chunk("Looking"), stream);
    const second = translateAntigravityUpdate(chunk(" now."), stream);
    assert.deepEqual(
      [first.delta, second.delta],
      [
        { streamId: "stretch-0", text: "Looking" },
        { streamId: "stretch-0", text: " now." },
      ],
    );
    const call = translateAntigravityUpdate(
      { sessionUpdate: "tool_call", toolCallId: "c1", name: "read_file", kind: "read", status: "in_progress" },
      stream,
    );
    assert.equal(call.text, "Looking now.", "the words before a tool call are recorded when it starts");
    assert.equal(call.activity, ChatActivityPhase.Working);
    assert.equal(translateAntigravityUpdate(chunk("Done."), stream).delta?.streamId, "stretch-1");
  });

  it("reads a studio bridge command as the studio tool, a non-zero exit as a failure, and an unknown tool by its own name", () => {
    const stream = antigravityStream();
    const bridge = translateAntigravityUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "b1",
        name: "run_command",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "node .studio/bridge/tool.mjs capture --page index.html" },
      },
      stream,
    );
    assert.equal(parts(bridge.events[0] ?? { payload: { parts: [] } })[0]?.name, "mcp__studio__capture");
    const failed = translateAntigravityUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "b1",
        status: "completed",
        rawOutput: { output: "zsh:1: operation not permitted: inside.txt", exit_code: 1 },
      },
      stream,
    );
    assert.equal(parts(failed.events[0] ?? { payload: { parts: [] } })[0]?.is_error, true);
    const own = translateAntigravityUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "m1",
        name: "mcp_probe_echo_probe",
        kind: "other",
        status: "in_progress",
      },
      stream,
    );
    assert.equal(parts(own.events[0] ?? { payload: { parts: [] } })[0]?.name, "mcp_probe_echo_probe");
  });

  it("says nothing for the updates the studio has no use for", () => {
    const stream = antigravityStream();
    for (const kind of [
      "user_message_chunk",
      "session_info_update",
      "available_commands_update",
      "config_option_update",
    ])
      assert.deepEqual(translateAntigravityUpdate({ sessionUpdate: kind, title: "x" }, stream), { events: [] });
  });
});

describe("the ACP wire", () => {
  function wire() {
    const sent: Json[] = [];
    const notes: Array<[string, Json]> = [];
    const connection = new AcpConnection((line) => sent.push(JSON.parse(line) as Json), {
      notification: (method, params) => notes.push([method, params]),
      request: async (method, params) => {
        if (method !== AcpMethod.RequestPermission) throw new AcpError(AcpErrorCode.MethodNotFound, "no such method");
        return { outcome: { outcome: "selected", optionId: (params.options as Json[])[0]?.optionId } };
      },
    });
    return { connection, sent, notes };
  }

  it("pairs each answer with its question, by id, in any order", async () => {
    const { connection, sent } = wire();
    const first = connection.request(AcpMethod.Initialize, { protocolVersion: 1 });
    const second = connection.request(AcpMethod.SessionNew, { cwd: "/game" });
    assert.deepEqual(
      sent.map((message) => [message.id, message.method]),
      [
        [1, "initialize"],
        [2, "session/new"],
      ],
    );
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } }));
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }));
    assert.deepEqual(await second, { sessionId: "s" });
    assert.deepEqual(await first, { protocolVersion: 1 });
  });

  it("rejects with the agent's error code: a signed-out session is -32000, not words to match", async () => {
    const { connection } = wire();
    const asked = connection.request(AcpMethod.SessionNew, { cwd: "/game" });
    const refusal = JSON.parse(
      await readFile(path.join(FIXTURES, "antigravity-session-new-signed-out-1.5.7.json"), "utf8"),
    ) as Json;
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, error: refusal }));
    await assert.rejects(asked, (err: unknown) => err instanceof AcpError && err.code === AcpErrorCode.AuthRequired);
  });

  it("answers the agent's questions under the agent's own id, a string or a number, and refuses what it does not know", async () => {
    const { connection, sent, notes } = wire();
    const options = [{ optionId: "allow", kind: "allow_once" }];
    connection.receive(
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "session/request_permission", params: { options } }),
    );
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: {} }));
    connection.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { a: 1 } } }));
    connection.receive("a stray log line");
    await setImmediate();
    assert.deepEqual(sent, [
      { jsonrpc: "2.0", id: "1", result: { outcome: { outcome: "selected", optionId: "allow" } } },
      { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "no such method" } },
    ]);
    assert.deepEqual(notes, [["session/update", { update: { a: 1 } }]]);
  });

  it("fails every open question once the agent is gone, and sends nothing after", async () => {
    const { connection, sent } = wire();
    const asked = connection.request(AcpMethod.SessionPrompt, { sessionId: "s" });
    connection.close(new Error("agy exited with 1"));
    await assert.rejects(asked, /agy exited with 1/);
    connection.tell(AcpMethod.SessionCancel, { sessionId: "s" });
    await assert.rejects(connection.request(AcpMethod.SessionNew, {}), /agy exited with 1/);
    assert.equal(sent.length, 1, "only the prompt was sent");
  });
});
