/**
 * The scripted Anthropic stand-in the Claude worker checks run the real CLI against
 * (`tests/helpers/fake-anthropic.ts`): one call to the session's shell, the studio's preferred over
 * Bash, then done once its result came back; a short text to every side request; and the Messages
 * API's stream shape, so a CLI that parses it reads the call whole.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FakeAnthropic, startFakeAnthropic } from "../helpers/fake-anthropic.ts";

const COMMAND = "printf ok > proof.txt";

async function post(fake: FakeAnthropic, path: string, body: unknown): Promise<Response> {
  return fetch(`${fake.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The stream's events, in order, each with its data parsed. */
async function events(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [eventLine = "", dataLine = ""] = frame.split("\n");
      return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) };
    });
}

describe("the scripted Anthropic stand-in", () => {
  it("calls the studio's shell when offered, preferring it to Bash, with the command as input", async () => {
    const fake = await startFakeAnthropic({ command: COMMAND });
    try {
      const tools = [{ name: "Bash" }, { name: "mcp__studio__run_command" }];
      const reply = await (await post(fake, "/v1/messages", { tools, messages: [] })).json();
      assert.equal(reply.stop_reason, "tool_use");
      assert.deepEqual(reply.content[0].name, "mcp__studio__run_command");
      assert.deepEqual(reply.content[0].input, { command: COMMAND });
      assert.equal(fake.calledShell(), "mcp__studio__run_command");
    } finally {
      await fake.close();
    }
  });

  it("falls back to Bash, answers side requests with text, and ends once the call's result came back", async () => {
    const fake = await startFakeAnthropic({ command: COMMAND });
    try {
      const side = await (await post(fake, "/v1/messages", { tools: [{ name: "Read" }], messages: [] })).json();
      assert.equal(side.stop_reason, "end_turn", "no shell offered: a side request");
      assert.equal(fake.calledShell(), null);
      const call = await (await post(fake, "/v1/messages", { tools: [{ name: "Bash" }], messages: [] })).json();
      const id = call.content[0].id;
      const result = [
        { role: "assistant", content: call.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "done" }] }],
        },
      ];
      const done = await (await post(fake, "/v1/messages", { tools: [{ name: "Bash" }], messages: result })).json();
      assert.equal(done.stop_reason, "end_turn");
      assert.equal(fake.calledShell(), "Bash");
      assert.equal(fake.shellResult(), "done");
      const count = await (await post(fake, "/v1/messages/count_tokens", {})).json();
      assert.equal(typeof count.input_tokens, "number");
    } finally {
      await fake.close();
    }
  });

  it("streams the call as the Messages API does: start, the block's start, its JSON input, stops", async () => {
    const fake = await startFakeAnthropic({ command: COMMAND });
    try {
      const response = await post(fake, "/v1/messages", { stream: true, tools: [{ name: "Bash" }], messages: [] });
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const stream = await events(response);
      assert.deepEqual(
        stream.map((e) => e.event),
        [
          "message_start",
          "content_block_start",
          "content_block_delta",
          "content_block_stop",
          "message_delta",
          "message_stop",
        ],
      );
      const [, , input, , end] = stream;
      assert.ok(input && end, "every event arrived");
      assert.deepEqual(JSON.parse((input.data.delta as { partial_json: string }).partial_json), { command: COMMAND });
      assert.equal((end.data.delta as { stop_reason: string }).stop_reason, "tool_use");
    } finally {
      await fake.close();
    }
  });
});
