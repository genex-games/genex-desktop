/**
 * The studio's MCP shim: the stdio MCP server OpenCode starts inside its own sandbox, relaying
 * every call over the studio's file bridge. Run for real — `node mcp.mjs` against a real bridge —
 * so the handshake, the tool list and a call that answers with a picture are what OpenCode sees;
 * and against a hand-driven bridge folder for what a contractor could plant there.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BRIDGE_DIR, StudioBridge } from "../../src/substrate/engines/studio-bridge.ts";
import { MCP_SHIM_FILE } from "../../src/substrate/engines/studio-mcp-shim.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A 1×1 PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** An MCP client over the shim's stdio: one request at a time by id, every line it printed kept. */
function client(child: ChildProcessWithoutNullStreams) {
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) waiting.get(id)?.(message);
  });
  let next = 0;
  return {
    send: (raw: string) => child.stdin.write(`${raw}\n`),
    request: (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
  };
}

/** The shim started the way OpenCode starts it: `node <bridge>/mcp.mjs`, stdio piped. */
function start(dir: string, env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [path.join(dir, MCP_SHIM_FILE)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  after(() => child.kill());
  return child;
}

describe("the studio's MCP shim, over a real bridge", () => {
  it("shakes hands, lists the studio's tools with their schemas, and answers a call with its picture", async () => {
    const cwd = await tmpDir("mcp-shim-");
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge = await StudioBridge.open({
      cwd,
      mcp: true,
      pollMs: 20,
      tools: [
        {
          name: "computer",
          description: "hands and eyes",
          parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
        },
      ],
      onCall: async (name, args) => {
        calls.push({ name, args });
        return { text: "looked", images: [{ mimeType: "image/png", data: PIXEL, label: "screen" }] };
      },
    });
    after(() => bridge.close());
    const mcp = client(start(path.join(cwd, BRIDGE_DIR)));
    const hello = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode", version: "test" },
    });
    assert.deepEqual((hello.result as { capabilities: unknown }).capabilities, { tools: { listChanged: false } });
    mcp.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const listed = (await mcp.request("tools/list")).result as { tools: Array<Record<string, unknown>> };
    assert.equal(listed.tools[0]?.name, "computer");
    const schema = listed.tools[0]?.inputSchema as { required?: string[] } | undefined;
    assert.deepEqual(schema?.required, ["action"]);
    const called = (await mcp.request("tools/call", { name: "computer", arguments: { action: "screenshot" } }))
      .result as { content: Array<Record<string, unknown>>; isError?: boolean };
    assert.deepEqual(calls, [{ name: "computer", args: { action: "screenshot" } }]);
    assert.equal(called.isError, false);
    assert.equal(called.content[0]?.type, "text");
    assert.match(String(called.content[0]?.text), /looked/);
    assert.deepEqual(called.content[1], { type: "image", data: PIXEL, mimeType: "image/png" });
    assert.deepEqual((await mcp.request("ping")).result, {});
  });

  it("answers what it cannot run with an error, never a crash: an unknown tool, an unknown method, a broken line", async () => {
    const cwd = await tmpDir("mcp-shim-");
    const bridge = await StudioBridge.open({
      cwd,
      mcp: true,
      pollMs: 20,
      tools: [{ name: "computer", description: "hands", parameters: { type: "object", properties: {} } }],
      onCall: async () => "fine",
    });
    after(() => bridge.close());
    const mcp = client(start(path.join(cwd, BRIDGE_DIR)));
    mcp.send("{ not json");
    mcp.send(JSON.stringify([1, 2, 3]));
    const unknownTool = (await mcp.request("tools/call", { name: "rm_rf", arguments: {} })).result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(unknownTool.isError, true);
    assert.match(unknownTool.content[0]!.text, /no studio tool called 'rm_rf'/);
    const unknownMethod = await mcp.request("resources/list");
    assert.equal((unknownMethod.error as { code: number }).code, -32601);
    const badArgs = (await mcp.request("tools/call", { name: "computer", arguments: "nope" })).result as {
      isError: boolean;
    };
    assert.equal(badArgs.isError, true);
    const still = (await mcp.request("tools/call", { name: "computer", arguments: {} })).result as {
      content: Array<{ text: string }>;
    };
    assert.equal(still.content[0]!.text, "fine", "it kept serving after every refusal");
  });
});

describe("the studio's MCP shim, against what a contractor could plant", () => {
  /** A bridge folder driven by hand: the shim, its manifest, and answers the test writes itself. */
  async function plantedBridge(): Promise<string> {
    const cwd = await tmpDir("mcp-shim-planted-");
    // The studio's side never looks (an hour between polls): the test answers the requests itself.
    const bridge = await StudioBridge.open({
      cwd,
      mcp: true,
      pollMs: 3_600_000,
      tools: [{ name: "computer", description: "hands", parameters: { type: "object", properties: {} } }],
      onCall: async () => "unused",
    });
    after(() => bridge.close());
    return path.join(cwd, BRIDGE_DIR);
  }

  /** The id of the next request the shim writes, once it has. */
  async function nextRequest(dir: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const files = (await readdir(path.join(dir, "req")).catch(() => [])).filter((f) => f.endsWith(".json"));
      if (files[0]) return files[0].replace(/\.json$/, "");
      await sleep(10);
    }
    throw new Error("the shim wrote no request");
  }

  const PLANTED: Array<{ name: string; images: unknown }> = [
    { name: "a path out of res/", images: [{ file: "../tools.json", mimeType: "image/png" }] },
    { name: "an absolute path", images: [{ file: "/etc/passwd", mimeType: "image/png" }] },
    { name: "a type that is not a picture", images: [{ file: "x.png", mimeType: "text/html" }] },
    { name: "not a list", images: "x.png" },
    { name: "a missing file", images: [{ file: "gone.png", mimeType: "image/png" }] },
  ];
  for (const row of PLANTED) {
    it(`never reads past its own res/ folder: ${row.name}`, async () => {
      const dir = await plantedBridge();
      const mcp = client(start(dir));
      const answer = mcp.request("tools/call", { name: "computer", arguments: {} });
      const id = await nextRequest(dir);
      await writeFile(
        path.join(dir, "res", `${id}.json`),
        JSON.stringify({ ok: true, text: "done", images: row.images }),
      );
      const result = (await answer).result as { content: Array<{ type: string; text?: string }> };
      assert.deepEqual(
        result.content.map((item) => item.type),
        ["text"],
        "no picture was read",
      );
      assert.equal(result.content[0]!.text, "done");
      assert.ok((await readFile(path.join(dir, "tools.json"), "utf8")).length > 0, "nothing was touched");
    });
  }
});
