import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { BonsaiEngine, InferenceQueue } from "../../src/substrate/engines/bonsai.ts";
import {
  BonsaiRuntime,
  IDLE_STOP_MS,
  bonsaiContextWindow,
  type BonsaiRuntimeOptions,
} from "../../src/substrate/bonsai/runtime.ts";
import {
  BONSAI_BINARY,
  BONSAI_MODELS,
  BONSAI_NOTICES,
  BONSAI_PROJECTOR,
  BONSAI_RUNTIME,
} from "../../src/substrate/bonsai/manifest.ts";
import { LocalSessions } from "../../src/substrate/engines/local-session.ts";
import { summarizeLocalCheckpoint } from "../../src/substrate/engines/local-checkpoint.ts";
import { download } from "../../src/substrate/bonsai/download.ts";
import { createHash } from "node:crypto";
import { EngineError, DelegateEventType, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { baseBrief } from "../../src/harness-seed/loop/autopilot.ts";
import type { CompleteRequest, CompleteResponse } from "../../src/substrate/engines/types.ts";
import { withRoles } from "../../src/harness-seed/loop/model-roles.ts";
import { running } from "../helpers/processes.ts";
const model = BONSAI_MODELS[0].id;
const reply = (
  content: string,
  calls?: Array<{
    id: string;
    name: string;
    arguments: unknown;
  }>,
): CompleteResponse => ({
  engine: "bonsai",
  model,
  usage: {},
  stopReason: calls ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});
it("local sessions emit chat text deltas with a fresh stream identity for each completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-deltas-"));
  const events: DelegateEvent[] = [];
  let rounds = 0;
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      rounds += 1;
      request.onDelta?.("Look");
      request.onDelta?.(" here");
      return rounds === 1 ? reply("Look here", [{ id: "look", name: "inspect", arguments: {} }]) : reply("Look here");
    },
  });
  try {
    await session.run(
      {
        cwd: root,
        prompt: "Inspect",
        readOnly: true,
        liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => ({ text: "observed" }),
        onEvent: (e) => events.push(e),
      },
      model,
    );
    const deltas = events.filter((e) => e.type === DelegateEventType.TextDelta);
    assert.equal(deltas.length, 4);
    assert.deepEqual(
      deltas.map((e) => e.payload.delta),
      ["Look", " here", "Look", " here"],
    );
    assert.equal(deltas[0]?.payload.streamId, deltas[1]?.payload.streamId);
    assert.notEqual(deltas[0]?.payload.streamId, deltas[2]?.payload.streamId);
    assert.equal(events.filter((e) => e.type === DelegateEventType.AssistantDelta).length, 0);
    assert.equal(events.filter((e) => e.type === DelegateEventType.Assistant).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("local inference queue releases aborted waiters and allows worker generation after director generation", async () => {
  const queue = new InferenceQueue(),
    first = await queue.acquire(new AbortController().signal),
    cancel = new AbortController();
  const cancelled = queue.acquire(cancel.signal);
  cancel.abort();
  await assert.rejects(cancelled);
  const worker = queue.acquire(new AbortController().signal);
  first();
  const release = await worker;
  release();
  (await queue.acquire(new AbortController().signal))();
});
it("Bonsai can direct subscription workers, or work and judge for either subscription", () => {
  for (const engine of ["bonsai", "claude-code", "codex"])
    for (const target of ["bonsai", "claude-code", "codex"]) {
      const run = withRoles({
        engine,
        model: engine === "bonsai" ? model : "default",
        roles: {
          planner: engine === "bonsai" ? model : "default",
          builder: target === "bonsai" ? model : "default",
          judge: target === "bonsai" ? model : "default",
          engines: { builder: target, judge: target },
        },
      });
      assert.equal(run.builderEngine ?? engine, target);
      assert.equal(run.judgeEngine, target);
    }
});
it("streamed Bonsai tools, images, reasoning and usage survive the wire", async () => {
  let body: any,
    truncated = false;
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const c of req) input += c;
    const parsed = JSON.parse(input);
    if (req.url === "/apply-template") {
      res.end(JSON.stringify({ prompt: JSON.stringify(parsed) }));
      return;
    }
    if (req.url === "/tokenize") {
      res.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }
    body = parsed;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (truncated) {
      res.write(
        `data: ${JSON.stringify({ model, choices: [{ delta: { tool_calls: [{ index: 0, id: "partial", function: { name: "inspect", arguments: '{"nested":"unfinished' } }] }, finish_reason: "length" }], usage: { prompt_tokens: 124, completion_tokens: 3072 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    for (const event of [
      {
        model,
        choices: [
          {
            delta: {
              reasoning_content: "checking",
              content: "Look",
              tool_calls: [{ index: 0, id: "t1", function: { name: "inspect", arguments: '{"nested":' } }],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}}' } }] }, finish_reason: "tool_calls" },
        ],
      },
      { choices: [], usage: { prompt_tokens: 123, completion_tokens: 17 } },
    ])
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-wire-"));
  try {
    const runtime = new BonsaiRuntime(root);
    runtime.start = async () => `http://127.0.0.1:${(server.address() as any).port}`;
    const engine = new BonsaiEngine({ root, runtime });
    let streamed = "";
    const r = await engine.complete({
      model,
      messages: [{ role: "user", content: "inspect", images: [{ mimeType: "image/png", data: "AAAA" }] }],
      tools: [
        {
          name: "inspect",
          description: "inspect",
          parameters: { type: "object", properties: { nested: { type: "object" } } },
        },
      ],
      onDelta: (s) => (streamed += s),
    });
    assert.equal(streamed, "Look");
    assert.equal(r.usage.input_tokens, 123);
    assert.deepEqual(r.message.tool_calls?.[0]?.arguments, { nested: { x: 1 } });
    assert.equal(body.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
    assert.equal(body.reasoning_budget_tokens, 512);
    truncated = true;
    const incomplete = await engine.complete({ model, messages: [{ role: "user", content: "inspect" }] });
    assert.equal(incomplete.stopReason, "length");
    assert.equal(incomplete.usage.output_tokens, 3072);
    assert.equal(incomplete.message.tool_calls, undefined, "truncated arguments never reach dispatch");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("read-only local sessions round-trip host images, save and resume without gaining write or shell tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-session-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  const seen: CompleteRequest[] = [];
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      seen.push(
        structuredClone({
          ...request,
          signal: undefined,
          onDelta: undefined,
          onContext: undefined,
          onActivity: undefined,
        }),
      );
      return seen.length === 1
        ? reply("", [
            { id: "look1", name: "computer", arguments: { action: "screenshot" } },
            { id: "look2", name: "computer", arguments: { action: "screenshot" } },
          ])
        : seen.length === 2
          ? reply("", [{ id: "look3", name: "computer", arguments: { action: "screenshot" } }])
          : reply("Observed game");
    },
  });
  try {
    const first = await sessions.run(
      {
        cwd,
        prompt: "Look at the game",
        images: [{ label: "Reference", mimeType: "image/png", data: "REFERENCE" }],
        readOnly: true,
        liveTools: [{ name: "computer", description: "look", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => ({ text: "actual capture", images: [{ mimeType: "image/png", data: "AAAA" }] }),
      },
      model,
    );
    assert.equal(first.ok, true);
    assert.ok(seen[1]!.messages.some((m) => m.images?.[0]?.data === "AAAA"));
    assert.deepEqual(
      seen[1]!.messages.slice(-3).map((m) => m.role),
      ["tool", "tool", "user"],
    );
    assert.equal(seen[1]!.messages.at(-1)!.images?.length, 2);
    assert.equal(
      seen[2]!.messages.filter((m) => m.images?.length).length,
      2,
      "keep the reference and newest observation only",
    );
    assert.equal(seen[2]!.messages[0]!.images?.[0]?.data, "REFERENCE");
    assert.equal(seen[2]!.messages.at(-1)!.images?.length, 1);
    assert.ok(!seen[0]!.tools?.some((t) => ["edit_file", "write_file", "run_command"].includes(t.name)));
    await sessions.run({ cwd, prompt: "Continue", readOnly: true, resume: first.sessionId }, model);
    assert.ok(seen[3]!.messages.some((m) => m.content === "Observed game"));
    const switched = await sessions.run(
      { cwd, prompt: "Continue", readOnly: true, resume: first.sessionId },
      BONSAI_MODELS[1].id,
    );
    assert.notEqual(switched.sessionId, first.sessionId);
    const child = JSON.parse(await readFile(path.join(root, "sessions", `${switched.sessionId}.json`), "utf8"));
    assert.equal(child.parentSession, first.sessionId);
    assert.equal(child.model, BONSAI_MODELS[1].id);
    assert.ok(child.messages.some((m: any) => m.content === "Observed game"));
    const original = JSON.parse(await readFile(path.join(root, "sessions", `${first.sessionId}.json`), "utf8"));
    assert.equal(original.model, model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("a resumed local session keeps its system prompt: each request's own turn and time budget rides its message", async () => {
  // The minutes left change on every request; in the system prompt they made a resumed session
  // re-read its whole history instead of reusing the model's cached prefix.
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-session-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  const seen: CompleteRequest[] = [];
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      seen.push(
        structuredClone({
          ...request,
          signal: undefined,
          onDelta: undefined,
          onContext: undefined,
          onActivity: undefined,
        }),
      );
      return reply("Done");
    },
  });
  try {
    const first = await sessions.run({ cwd, prompt: "Build the menu", maxTurns: 30, timeoutMs: 40 * 60_000 }, model);
    await sessions.run(
      { cwd, prompt: "Now the HUD", resume: first.sessionId, maxTurns: 12, timeoutMs: 7 * 60_000 },
      model,
    );
    assert.equal(seen.length, 2);
    assert.equal(
      seen[1]!.systemPrompt,
      seen[0]!.systemPrompt,
      "the resumed request starts from the same system prompt",
    );
    assert.doesNotMatch(seen[0]!.systemPrompt ?? "", /\d+ model turns|\d+ minutes/);
    const asked = (request: CompleteRequest) => String(request.messages.at(-1)?.content ?? "");
    assert.match(asked(seen[0]!), /Build the menu[\s\S]*at most 30 model turns and 40 minutes/);
    assert.match(asked(seen[1]!), /Now the HUD[\s\S]*at most 12 model turns and 7 minutes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("local file reads reject a symlink into an ungranted directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-path-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  await symlink(os.homedir(), path.join(cwd, "escape"));
  let count = 0;
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      if (count++ === 0) return reply("", [{ id: "r", name: "list_files", arguments: { path: "escape" } }]);
      assert.match(request.messages.at(-1)!.content, /outside this session/);
      return reply("Denied");
    },
  });
  try {
    await sessions.run({ cwd, prompt: "test boundary", readOnly: true }, model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("downloads resume, verify pinned digest, and never publish corrupt bytes", async () => {
  const bytes = Buffer.from("a complete model fixture");
  let range = "";
  const server = createServer((req, res) => {
    range = req.headers.range ?? "";
    const start = Number(/bytes=(\d+)/.exec(range)?.[1] ?? 0);
    res.writeHead(
      start ? 206 : 200,
      start ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {},
    );
    res.end(bytes.subarray(start));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-download-"));
  const spec = {
    name: "fixture.gguf",
    url: `http://127.0.0.1:${(server.address() as any).port}/weights`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(root, "fixture.gguf.part"), bytes.subarray(0, 5));
    await download(spec, root, new AbortController().signal, () => {});
    assert.equal(range, "bytes=5-");
    assert.deepEqual(await readFile(path.join(root, "fixture.gguf")), bytes);
    await assert.rejects(
      download({ ...spec, name: "bad.gguf", sha256: "0".repeat(64) }, root, new AbortController().signal, () => {}),
      /Integrity/,
    );
    await assert.rejects(readFile(path.join(root, "bad.gguf")));
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** A weights server that answers each request through `answer`, plus every Range it was asked for. */
async function weightsServer(answer: (res: ServerResponse, start: number, request: number) => void) {
  const ranges: string[] = [];
  const server = createServer((req, res) => {
    ranges.push(req.headers.range ?? "");
    answer(res, Number(/bytes=(\d+)/.exec(req.headers.range ?? "")?.[1] ?? 0), ranges.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/weights`;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { url, ranges, close };
}

/** Send `bytes` from `start` as a full or ranged answer; `upTo` cuts the connection after that many. */
function sendWeights(res: ServerResponse, bytes: Buffer, start: number, upTo = bytes.length - start) {
  res.writeHead(start ? 206 : 200, {
    "Content-Length": String(bytes.length - start),
    ...(start ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
  });
  if (upTo >= bytes.length - start) return void res.end(bytes.subarray(start));
  res.write(bytes.subarray(start, start + upTo), () => setTimeout(() => res.socket?.destroy(), 30));
}

const weightsSpec = (url: string, bytes: Buffer) => ({
  name: "fixture.gguf",
  url,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

it("a download whose connection drops mid-file resumes from the saved bytes and finishes", async () => {
  const bytes = Buffer.from("weights that arrive over a connection that keeps dropping");
  const server = await weightsServer((res, start, request) =>
    sendWeights(res, bytes, start, request < 3 ? 12 : undefined),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-dropped-"));
  const waits: number[] = [];
  try {
    const published = await download(weightsSpec(server.url, bytes), root, new AbortController().signal, () => {}, {
      wait: async (ms) => void waits.push(ms),
    });
    assert.deepEqual(await readFile(published), bytes);
    assert.equal(server.ranges.length, 3);
    assert.equal(server.ranges[0], "");
    for (const range of server.ranges.slice(1))
      assert.match(range, /^bytes=[1-9]\d*-$/, "each reconnect resumes from saved bytes instead of restarting");
    assert.equal(waits.length, 2, "one pause before each reconnect");
    await assert.rejects(readFile(`${published}.part`), "the partial file is published, not left beside it");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("a download that cannot get its bytes stops without losing or publishing any of them", async (t) => {
  const bytes = Buffer.from("weights the server never manages to send");
  const saved = bytes.subarray(0, 6);
  const rows: Array<{
    name: string;
    answer: (res: ServerResponse, start: number) => void;
    error: RegExp;
    reconnects: boolean;
    cancelWhileWaiting?: boolean;
  }> = [
    {
      name: "every connection drops before a byte",
      answer: (res) => res.socket?.destroy(),
      error: /lost the connection to the download server/i,
      reconnects: true,
    },
    {
      name: "the server goes quiet mid-file",
      answer: (res, start) => {
        res.writeHead(206, { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` });
        res.write(Buffer.alloc(0));
      },
      error: /lost the connection to the download server/i,
      reconnects: true,
    },
    {
      name: "the server refuses the file",
      answer: (res) => res.writeHead(404).end(),
      error: /HTTP 404/,
      reconnects: false,
    },
    {
      name: "the person cancels while it waits to reconnect",
      answer: (res) => res.socket?.destroy(),
      error: /cancelled by the test/,
      reconnects: false,
      cancelWhileWaiting: true,
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      const server = await weightsServer((res, start) => row.answer(res, start));
      const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-lost-"));
      const partial = path.join(root, "fixture.gguf.part");
      const controller = new AbortController();
      const waits: number[] = [];
      try {
        await writeFile(partial, saved);
        await assert.rejects(
          download(weightsSpec(server.url, bytes), root, controller.signal, () => {}, {
            stallMs: 50,
            wait: async (ms) => {
              waits.push(ms);
              if (row.cancelWhileWaiting) controller.abort(new Error("cancelled by the test"));
              controller.signal.throwIfAborted();
            },
          }),
          row.error,
        );
        assert.equal(server.ranges.length > 1, row.reconnects, "reconnects only after a lost connection");
        assert.ok(
          server.ranges.every((range) => range === `bytes=${saved.length}-`),
          "every try resumes",
        );
        assert.deepEqual(await readFile(partial), saved, "the saved bytes survive");
        await assert.rejects(readFile(path.join(root, "fixture.gguf")), "nothing unverified is published");
      } finally {
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
it("local worker writes obey ownership and shell execution stays inside the sandbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-worker-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  let round = 0;
  const seen: string[] = [];
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "sessions")],
    contextWindow: 16384,
    complete: async (request) => {
      const last = request.messages.at(-1);
      if (last?.role === "tool") seen.push(last.content);
      const steps = [
        { name: "write_file", arguments: { path: "src/other.js", content: "wrong" } },
        { name: "write_file", arguments: { path: "src/owned.js", content: "export const ok = true;" } },
        { name: "run_command", arguments: { command: "cat src/owned.js" } },
        { name: "run_command", arguments: { command: `echo denied > '${path.join(root, "outside.txt")}'` } },
      ];
      const step = steps[round++];
      return step ? reply("", [{ id: `w${round}`, ...step }]) : reply("Done");
    },
  });
  try {
    const result = await sessions.run(
      {
        cwd,
        prompt: "Build owned part",
        ownership: { facetId: "owned", owns: ["src/owned.js"], ownsMain: false, template: false },
      },
      model,
    );
    assert.equal(result.ok, true);
    assert.match(seen[0]!, /outside worker/);
    assert.equal(seen[1], "Written");
    assert.match(seen[2]!, /export const ok/);
    assert.match(seen[2]!, /"sandboxed":true/);
    await assert.rejects(readFile(path.join(root, "outside.txt")));
    await assert.rejects(readFile(path.join(cwd, "src/other.js")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("local text reads stay bounded and support reading the next section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-read-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "large.txt"), Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));
  let turn = 0;
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      if (turn++ === 0) return reply("", [{ id: "first", name: "read_file", arguments: { path: "large.txt" } }]);
      if (turn === 2) {
        const text = request.messages.at(-1)!.content;
        assert.match(text, /line 199/);
        assert.doesNotMatch(text, /line 200/);
        assert.match(text, /Partial file/);
        return reply("", [{ id: "next", name: "read_file", arguments: { path: "large.txt", offset: 200, limit: 2 } }]);
      }
      if (turn === 3) {
        assert.match(request.messages.at(-1)!.content, /line 200\nline 201/);
        assert.doesNotMatch(request.messages.at(-1)!.content, /line 202/);
        return reply("", [{ id: "eof", name: "read_file", arguments: { path: "large.txt", offset: 800 } }]);
      }
      assert.match(request.messages.at(-1)!.content, /End of file.*500 lines/);
      return reply("Read in sections");
    },
  });
  try {
    assert.equal((await sessions.run({ cwd, prompt: "read", readOnly: true }, model)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("checkpoint summaries preserve completed tool identities, original requirements and the latest image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-checkpoint-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  let modelCalls = 0,
    summaryCalls = 0,
    tools = 0;
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 2000,
    complete: async (request) => {
      if (!request.tools?.length) {
        summaryCalls++;
        assert.match(request.systemPrompt!, /checkpoint/);
        return {
          ...reply("Observed existing game. Keep blue sky and original controls. Tool inspect already completed."),
          usage: { input_tokens: 41, output_tokens: 7 },
        };
      }
      modelCalls++;
      if (modelCalls === 1) return reply("", [{ id: "inspect-once", name: "inspect", arguments: {} }]);
      if (request.messages.some((m) => m.role === "tool" && m.content.length > 2000))
        throw new EngineError("context_threshold", "bonsai", "selected threshold reached");
      const checkpoint = JSON.parse(request.messages[0]!.content);
      assert.match(checkpoint.instructionsInOrder[0], /keep blue sky/);
      assert.ok(checkpoint.completedActionIds.includes("inspect-once"));
      assert.match(checkpoint.checkpoint, /already completed/);
      assert.equal(request.messages.filter((m) => m.images?.length).length, 1, "latest inspection survives");
      return reply("Use existing result");
    },
  });
  try {
    const result = await session.run(
      {
        cwd,
        prompt: "inspect, keep blue sky",
        readOnly: true,
        liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => {
          tools++;
          return { text: "observed ".repeat(1000), images: [{ mimeType: "image/png", data: "fixture" }] };
        },
      },
      model,
    );
    assert.equal(result.ok, true);
    assert.equal(tools, 1);
    assert.ok(summaryCalls > 0);
    assert.equal(result.usage.input_tokens, 41 * summaryCalls, "checkpoint inference contributes to resource usage");
    assert.equal(result.usage.output_tokens, 7 * summaryCalls);
    const saved = JSON.parse(await readFile(path.join(root, "sessions", `${result.sessionId}.json`), "utf8"));
    const archive = JSON.parse(
      await readFile(
        path.join(root, "sessions", "checkpoints", result.sessionId!, `${saved.checkpoint.id}.json`),
        "utf8",
      ),
    );
    assert.ok(
      archive.messages.some((m: any) => m.content === "observed ".repeat(1000)),
      "full result retained outside prompt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("compaction eventually summarizes an oversized latest tool round without replaying it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-large-latest-"));
  let actions = 0,
    inference = 0,
    summaries = 0;
  const large = "latest result ".repeat(2000);
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      if (!request.tools?.length) {
        summaries++;
        return reply("Three inspections are complete; retain the original constraints and use the existing result.");
      }
      inference++;
      if (actions < 3) return reply("", [{ id: `inspection-${actions}`, name: "inspect", arguments: {} }]);
      if (request.messages.some((m) => m.role === "tool" && m.content === large))
        throw new EngineError("context_threshold", "bonsai", "latest tool round does not fit");
      const checkpoint = JSON.parse(request.messages[0]!.content);
      assert.equal(checkpoint.completedActionCount, 3);
      assert.match(checkpoint.instructionsInOrder[0], /keep original files/);
      return reply("Used the existing observations.");
    },
  });
  try {
    const result = await session.run(
      {
        cwd: root,
        prompt: "Inspect three things; keep original files",
        readOnly: true,
        liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => (++actions === 3 ? large : "small result"),
      },
      model,
    );
    assert.equal(result.ok, true);
    assert.equal(actions, 3, "completed tools are not replayed");
    assert.equal(inference, 7, "progressively compact two, one, then zero verbatim rounds");
    assert.equal(summaries, 4, "the large archived result is summarized in bounded chunks");
    const saved = JSON.parse(await readFile(path.join(root, "sessions", `${result.sessionId}.json`), "utf8"));
    const archive = JSON.parse(
      await readFile(
        path.join(root, "sessions", "checkpoints", result.sessionId!, `${saved.checkpoint.id}.json`),
        "utf8",
      ),
    );
    assert.ok(
      archive.messages.some((m: any) => m.content === large),
      "the complete result remains in the archive",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("an output-limited checkpoint never replaces the last complete checkpoint", async () => {
  const previous = {
    id: "complete-checkpoint",
    summary: "Keep the original requirement.",
    completedActions: [{ id: "already-done", name: "asset" }],
    createdAt: "2026-09-20T00:00:00Z",
  };
  const before = structuredClone(previous);
  await assert.rejects(
    summarizeLocalCheckpoint({
      previous,
      messages: [{ role: "assistant", content: "New observation" }],
      model,
      signal: new AbortController().signal,
      contextWindow: 102400,
      complete: async (request) => {
        assert.ok(request.maxTokens! >= 512 + 1024, "reasoning and summary both have output room");
        return { ...reply("unfinished checkpoint"), stopReason: "length" };
      },
    }),
    /incomplete; previous context is preserved/,
  );
  assert.deepEqual(previous, before);
});

it("local builder detects repeated inspection, warns, and stops without modifying the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-stall-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "main.js"), "// existing");
  let turns = 0;
  const seen: string[] = [];
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (r) => {
      seen.push(r.messages.map((m) => m.content).join("\n"));
      return reply("", [{ id: `r${turns++}`, name: "read_file", arguments: { path: "main.js" } }]);
    },
  });
  try {
    const result = await session.run({ cwd, prompt: "Implement a scene" }, model);
    assert.equal(result.stopReason, "no_progress");
    assert.equal(turns, 16);
    assert.ok(seen.some((s) => s.includes("Progress check: 6")));
    assert.ok(seen.some((s) => s.includes("unchanged section was already read")));
    assert.equal(await readFile(path.join(cwd, "main.js"), "utf8"), "// existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("two compactions never replay completed host actions and retain the checkpoint chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-retry-"));
  let calls = 0,
    modelTurns = 0,
    summaries = 0;
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (r) => {
      if (!r.tools?.length) {
        summaries++;
        return reply("Keep original requirement and completed assets. Inspect state before retry.");
      }
      modelTurns++;
      if (modelTurns === 1 || modelTurns === 3)
        return reply("", [{ id: `asset${modelTurns}`, name: "asset", arguments: {} }]);
      if (modelTurns === 2 || modelTurns === 4) throw new EngineError("context_threshold", "bonsai", "full");
      assert.match(r.messages[0]!.content, /preserve every requirement/);
      return reply("Done");
    },
  });
  try {
    const result = await session.run(
      {
        cwd: root,
        prompt: "preserve every requirement",
        readOnly: true,
        liveTools: [{ name: "asset", description: "fixture", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => {
          calls++;
          return "Created asset";
        },
      },
      model,
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(modelTurns, 5);
    assert.equal(summaries, 2);
    const saved = JSON.parse(await readFile(path.join(root, "sessions", `${result.sessionId}.json`), "utf8"));
    assert.ok(saved.checkpoint.parent);
    assert.deepEqual(
      saved.checkpoint.completedActions.map((a: any) => a.id),
      ["asset1", "asset3"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("Bonsai new-project base gets an actionable public API brief; imported projects keep their architecture", () => {
  const local = baseBrief({
    run: { engine: "bonsai", goal: "sword in ice" },
    plan: { facets: [] },
    projectLabel: "scene",
  } as never);
  assert.match(local, /visible, working first version/);
  assert.match(local, /do not study or rewrite/);
  assert.doesNotMatch(local, /Empty facet groups and empty renders are valid/);
  const own = baseBrief({
    run: { engine: "bonsai", goal: "improve existing" },
    plan: { facets: [] },
    projectLabel: "existing",
    ownShape: true,
    shape: { main: "app.ts", entry: "index.html" } as any,
  } as never);
  assert.match(own, /THIS GAME HAS ITS OWN SHAPE/);
  assert.doesNotMatch(own, /Read src.main.js first/);
});
it("native preflight counts chat template and tools and reserves output before generation", async () => {
  let generated = 0,
    templated: any;
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const c of req) input += c;
    const data = JSON.parse(input);
    if (req.url === "/apply-template") {
      templated = data;
      res.end(JSON.stringify({ prompt: "formatted with tool schemas" }));
    } else if (req.url === "/tokenize") {
      assert.equal(data.content, "formatted with tool schemas");
      res.end(JSON.stringify({ tokens: Array(bonsaiContextWindow() - 2000).fill(1) }));
    } else {
      generated++;
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-budget-"));
  try {
    const runtime = new BonsaiRuntime(root);
    runtime.start = async () => `http://127.0.0.1:${(server.address() as any).port}`;
    const engine = new BonsaiEngine({ root, runtime });
    await assert.rejects(
      () =>
        engine.complete({
          model,
          systemPrompt: "keep user data",
          messages: [{ role: "user", content: "build" }],
          tools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
        }),
      (e: unknown) => e instanceof EngineError && e.kind === "context_overflow",
    );
    assert.equal(generated, 0);
    assert.equal(templated.messages[0].content, "keep user data");
    assert.equal(templated.tools[0].function.name, "inspect");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("targeted edits refuse ambiguous matches and preserve the remainder of a file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-edit-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "main.js"), "prefix one two one suffix");
  let n = 0;
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (r) => {
      n++;
      if (n === 1)
        return reply("", [
          { id: "bad", name: "edit_file", arguments: { path: "main.js", oldText: "one", newText: "changed" } },
        ]);
      if (n === 2) {
        assert.match(r.messages.at(-1)!.content, /match exactly once/);
        assert.equal(await readFile(path.join(cwd, "main.js"), "utf8"), "prefix one two one suffix");
        return reply("", [
          { id: "good", name: "edit_file", arguments: { path: "main.js", oldText: "one two one", newText: "changed" } },
        ]);
      }
      return reply("Done");
    },
  });
  try {
    assert.equal((await session.run({ cwd, prompt: "edit" }, model)).ok, true);
    assert.equal(await readFile(path.join(cwd, "main.js"), "utf8"), "prefix changed suffix");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("context capacity follows host memory without restricting 32 GiB Macs to 16K", () => {
  assert.equal(bonsaiContextWindow(32 * 1024 ** 3), 102400);
  assert.equal(bonsaiContextWindow(64 * 1024 ** 3), 102400);
  assert.equal(bonsaiContextWindow(16 * 1024 ** 3), 16384);
});

it("install status reads a missing job as none, an active one as interrupted, and refuses an unreadable one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-install-status-"));
  try {
    assert.equal(await new BonsaiRuntime(root).installStatus(), null);
    const job = { id: "j", model, phase: "downloading", completed: 5, total: 10, location: root, active: true };
    await writeFile(path.join(root, "install-job.json"), JSON.stringify({ ...job, updatedAt: "t" }));
    const status = await new BonsaiRuntime(root).installStatus();
    assert.equal(status?.phase, "interrupted");
    assert.equal(status?.active, false);
    assert.match(status?.error ?? "", /Studio closed before this operation finished/);
    await writeFile(path.join(root, "install-job.json"), "{not json");
    await assert.rejects(new BonsaiRuntime(root).installStatus(), /Cannot read model installation status/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a runtime with no downloaded model is not installed and refuses to start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-not-installed-"));
  const runtime = new BonsaiRuntime(root);
  try {
    assert.equal(await runtime.installed(model), false);
    assert.equal(await runtime.binary(), null);
    await assert.rejects(runtime.start(model, new AbortController().signal), /Download this Bonsai model/);
    await runtime.dispose();
    await assert.rejects(runtime.start(model, new AbortController().signal), /Bonsai runtime is closed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A stand-in llama-server: it answers health, the chat template, the tokenizer and one streamed
 * reply, and notes its pid and each request path in files beside itself (its working folder).
 */
const FAKE_LLAMA_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
fs.appendFileSync("pids", process.pid + "\\n");
const answers = {
  "/health": '{"status":"ok"}',
  "/apply-template": '{"prompt":"p"}',
  "/tokenize": '{"tokens":[1,2,3]}',
  "/v1/chat/completions": 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n',
};
require("node:http")
  .createServer((req, res) => {
    fs.appendFileSync("requests", req.url + "\\n");
    req.resume().on("end", () => res.end(answers[req.url] ?? ""));
  })
  .listen(port, "127.0.0.1");
`;

/** The stand-in server is a POSIX script, and NTFS would write the 7 GB stand-ins out in full. */
const STAGED_RUNTIME = { skip: process.platform === "win32" && "the staged runtime is POSIX-only" };

/**
 * A runtime on a 16 GiB Apple Silicon Mac whose pinned files already sit in `root` as sparse
 * stand-ins of the exact size, with `server` as its llama-server. Its download only names the file.
 */
async function stagedRuntime(root: string, server = FAKE_LLAMA_SERVER, options: BonsaiRuntimeOptions = {}) {
  const models = [...BONSAI_NOTICES, BONSAI_MODELS[0].file, BONSAI_PROJECTOR];
  for (const [file, folder] of [[BONSAI_BINARY, "downloads"], ...models.map((f) => [f, "models"] as const)] as const) {
    const target = path.join(root, folder, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "");
    await truncate(target, file.bytes);
  }
  await mkdir(path.join(root, BONSAI_RUNTIME));
  await writeFile(path.join(root, BONSAI_RUNTIME, "llama-server"), server, { mode: 0o755 });
  return new BonsaiRuntime(root, {
    machine: { appleSilicon: true, memoryBytes: 16 * 1024 ** 3 },
    download: async (file, directory) => path.join(directory, file.name),
    ...options,
  });
}

/** The pids the fake server wrote, one per launch. */
async function serverPids(root: string): Promise<number[]> {
  const text = await readFile(path.join(root, BONSAI_RUNTIME, "pids"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(Number);
}

it("install proves the native server healthy, then stops it before reporting Ready", STAGED_RUNTIME, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-install-ready-"));
  const runtime = await stagedRuntime(root);
  const runningAtReady: Array<number | null> = [];
  runtime.onInstall((job) => {
    if (job.phase === "ready") runningAtReady.push(runtime.processId);
  });
  try {
    await runtime.install(model, () => {});
    const pids = await serverPids(root);
    assert.equal(pids.length, 1, "install launches the server once");
    const requests = await readFile(path.join(root, BONSAI_RUNTIME, "requests"), "utf8");
    assert.match(requests, /^\/health$/m, "Ready follows a successful native health check");
    assert.deepEqual(runningAtReady, [null], "no server is running when the job reports Ready");
    assert.equal(running(pids[0]), false, "the health-checked server has exited");
    assert.equal((await runtime.installStatus())?.phase, "ready");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it(
  "an unheld server stops after the idle period, never under a request, and the next request restarts it",
  STAGED_RUNTIME,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-idle-"));
    const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
    const schedule = (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    };
    const armed = () => timers.filter((t) => !t.cancelled);
    const runtime = await stagedRuntime(root, FAKE_LLAMA_SERVER, { schedule });
    const engine = new BonsaiEngine({ root, runtime });
    const ask = (onActivity?: CompleteRequest["onActivity"]) =>
      engine.complete({ model, messages: [{ role: "user", content: "hi" }], onActivity });
    try {
      await runtime.install(model, () => {});
      assert.equal(armed().length, 0, "install leaves nothing running to stop");

      assert.equal((await ask()).message.content, "ok");
      const loaded = runtime.processId;
      assert.ok(loaded, "the first request starts the server");
      assert.equal(armed().length, 1, "the idle clock starts once the request lets go");
      const [stale] = armed();
      assert.equal(stale.ms, IDLE_STOP_MS);

      let during: { pid: number | null; armed: number } | undefined;
      const held = await ask((phase) => {
        if (phase !== "thinking") return;
        during = { pid: runtime.processId, armed: armed().length };
        stale.run(); // A timer that fires late must still leave a held server alone.
      });
      assert.equal(held.message.content, "ok", "the request that held the queue finished on its server");
      assert.deepEqual(during, { pid: loaded, armed: 0 }, "no idle stop is armed while a request holds the queue");
      assert.equal(runtime.processId, loaded, "the server stays loaded between requests");

      const [idle] = armed();
      assert.equal(armed().length, 1);
      idle.run();
      assert.equal(runtime.processId, null, "an unheld server stops after the idle period");

      assert.equal((await ask()).message.content, "ok");
      const reloaded = runtime.processId;
      assert.ok(reloaded && reloaded !== loaded, "a later request starts the server again");
      assert.equal(running(loaded), false, "the stopped server exited before its replacement loaded");
      assert.deepEqual((await serverPids(root)).slice(1), [loaded, reloaded], "one launch per load, none extra");
    } finally {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("install never reports Ready when the native server fails its startup", STAGED_RUNTIME, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-install-broken-"));
  const runtime = await stagedRuntime(root, "#!/bin/sh\nexit 1\n");
  try {
    await assert.rejects(
      runtime.install(model, () => {}),
      /Bonsai stopped during startup/,
    );
    const job = await runtime.installStatus();
    assert.equal(job?.phase, "failed");
    assert.equal(runtime.processId, null);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

/** Every file under `root`, relative and sorted. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

it(
  "deleting the only downloaded model stops its server and frees the weights, projector and runtime",
  STAGED_RUNTIME,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-remove-last-"));
    const runtime = await stagedRuntime(root);
    try {
      await runtime.install(model, () => {});
      await runtime.start(model, new AbortController().signal);
      const pid = runtime.processId;
      assert.ok(pid, "the model is loaded before it is deleted");
      await runtime.remove(model);
      assert.equal(runtime.processId, null);
      assert.equal(running(pid), false, "its server exited before its files went");
      assert.equal(await runtime.installed(model), false);
      assert.equal(await runtime.binary(), null, "no model is left to need the runtime");
      assert.equal(await runtime.installStatus(), null, "the finished download's record goes with its model");
      assert.deepEqual(await filesUnder(root), ["runtime.log"], "only the last server's log is kept");
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("deleting one model keeps what another model's bytes still need", STAGED_RUNTIME, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-remove-shared-"));
  const runtime = await stagedRuntime(root);
  const other = BONSAI_MODELS[1].file.name;
  try {
    await runtime.install(model, () => {});
    // A stopped download of the other model, kept so Resume can continue from it.
    await writeFile(path.join(root, "models", `${other}.part`), "saved bytes");
    await runtime.remove(model);
    assert.equal(await runtime.installed(model), false);
    const kept = [
      `downloads/${BONSAI_BINARY.name}`,
      "models/LICENSE",
      "models/NOTICE.txt",
      `models/${BONSAI_PROJECTOR.name}`,
      `models/${other}.part`,
      `${BONSAI_RUNTIME}/llama-server`,
      `${BONSAI_RUNTIME}/pids`,
      `${BONSAI_RUNTIME}/requests`,
      "runtime.log",
    ];
    assert.deepEqual(await filesUnder(root), kept.sort());
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it(
  "a delete is refused, removing nothing, for an unknown model, during a download or while Bonsai answers",
  STAGED_RUNTIME,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-remove-refused-"));
    let downloadsHang = false;
    const runtime = await stagedRuntime(root, FAKE_LLAMA_SERVER, {
      download: (file, directory, signal) =>
        downloadsHang
          ? new Promise((_, reject) => {
              const stop = () => reject(signal.reason);
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
            })
          : Promise.resolve(path.join(directory, file.name)),
    });
    try {
      await runtime.install(model, () => {});
      const before = await filesUnder(root);
      const kept = async (why: string) => {
        assert.equal(await runtime.installed(model), true, why);
        assert.deepEqual(await filesUnder(root), before, why);
      };
      for (const id of ["", "bonsai-2:", `${model}/../../models`, `../${model}`, model.toUpperCase(), "gemma4:12b"]) {
        await assert.rejects(runtime.remove(id), /Unknown Bonsai model/, JSON.stringify(id));
        await kept(`an unknown id ${JSON.stringify(id)} removes nothing`);
      }

      downloadsHang = true;
      const download = runtime.install(BONSAI_MODELS[1].id, () => {});
      await assert.rejects(runtime.remove(model), /downloading/);
      runtime.cancelInstall();
      await assert.rejects(download);
      downloadsHang = false;
      await kept("a delete during a download removes nothing");

      const letGo = runtime.hold();
      await assert.rejects(runtime.remove(model), /answering/);
      await kept("a delete while a request holds Bonsai removes nothing");
      letGo();
      await runtime.remove(model);
      assert.equal(await runtime.installed(model), false, "once the request lets go the delete goes ahead");
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("local output-limit recovery is bounded and never executes an incomplete tool batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-output-limit-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  let turns = 0,
    calls = 0;
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      turns++;
      if (turns > 1)
        assert.match(request.messages.at(-1)!.content, /No tool from that incomplete response was executed/);
      return {
        ...reply("incomplete", [{ id: "never", name: "probe", arguments: {} }]),
        stopReason: "length",
        usage: { input_tokens: 5, output_tokens: 7 },
      };
    },
  });
  try {
    const result = await sessions.run(
      {
        cwd,
        prompt: "inspect",
        readOnly: true,
        liveTools: [{ name: "probe", description: "probe", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => {
          calls++;
          return "unexpected";
        },
      },
      model,
    );
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "length");
    assert.equal(turns, 3);
    assert.equal(calls, 0);
    assert.equal(result.usage!.output_tokens, 21, "all incomplete responses retain their usage");
    const saved = JSON.parse(await readFile(path.join(root, "sessions", result.sessionId + ".json"), "utf8"));
    assert.ok(!saved.messages.some((m: any) => m.tool_calls?.length), "no incomplete call is available for replay");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a local session never reads a coding CLI sign-in home, even inside a folder it may read (SEC-3)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-cred-"));
  const cwd = path.join(root, "game");
  const shared = path.join(root, "shared");
  await mkdir(cwd);
  await mkdir(path.join(shared, "codex-home"), { recursive: true });
  await writeFile(path.join(shared, "codex-home", "auth.json"), '{"refresh_token":"secret"}');
  await writeFile(path.join(shared, "notes.md"), "shared notes");
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(shared, "codex-home");
  const seen: string[] = [];
  let turn = 0;
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      const last = request.messages.at(-1);
      if (last?.role === "tool") seen.push(last.content);
      const steps = [path.join(shared, "notes.md"), path.join(shared, "codex-home", "auth.json")];
      const file = steps[turn++];
      return file ? reply("", [{ id: `r${turn}`, name: "read_file", arguments: { path: file } }]) : reply("Done");
    },
  });
  try {
    await session.run({ cwd, prompt: "Look around", readOnly: true, extraReads: [shared] }, model);
    assert.match(seen[0]!, /shared notes/);
    assert.doesNotMatch(seen[1]!, /refresh_token/);
    assert.match(seen[1]!, /not readable/);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    await rm(root, { recursive: true, force: true });
  }
});
/** The launch tool a Loop chat gets bridged in (the harness's own is `start_autopilot`). */
const launchTool = {
  name: "start_autopilot",
  description: "Launch a build.",
  parameters: {
    type: "object" as const,
    properties: { goal: { type: "string" as const }, direction: { type: "string" as const } },
    required: ["goal"],
  },
};
it("a local Loop chat keeps its contractor tools and records a launch for Studio", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-loop-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  let offered: string[] = [];
  let count = 0;
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      if (count++ === 0) {
        offered = (request.tools ?? []).map((t) => t.name);
        return reply("", [
          { id: "l", name: "start_autopilot", arguments: { goal: "a boxing game", direction: "toy" } },
        ]);
      }
      return reply("Starting the build.");
    },
  });
  try {
    const result = await sessions.run(
      { cwd, prompt: "Build the game from the plan", interviewTools: [launchTool] },
      model,
    );
    // A Loop chat is a full contractor: it may edit and run commands, not only talk.
    assert.ok(offered.includes("write_file") && offered.includes("run_command"), `offered: ${offered.join(", ")}`);
    assert.deepEqual(result.studioToolCalls, [
      { name: "start_autopilot", args: { goal: "a boxing game", direction: "toy" } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("a local Loop chat that keeps reading is told to finish or launch, not to implement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-loop-idle-"));
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "main.js"), "// existing");
  let turns = 0;
  const seen: string[] = [];
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (r) => {
      seen.push(r.messages.map((m) => m.content).join("\n"));
      return reply("", [{ id: `r${turns++}`, name: "read_file", arguments: { path: "main.js" } }]);
    },
  });
  try {
    await sessions.run({ cwd, prompt: "What engine should this use?", interviewTools: [launchTool] }, model);
    const nudge = seen.find((s) => s.includes("Progress check: 6")) ?? "";
    assert.match(nudge, /Finish now: answer, make the change, or launch the build with start_autopilot/);
    assert.doesNotMatch(nudge, /Implement the next concrete change/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a malformed tool call is a tool error the model can correct, not the end of the session", async () => {
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const c of req) input += c;
    if (req.url === "/apply-template") {
      res.end(JSON.stringify({ prompt: input }));
      return;
    }
    if (req.url === "/tokenize") {
      res.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const call = { index: 0, function: { name: "inspect", arguments: '{"path": "src/a.ts' } };
    res.write(
      `data: ${JSON.stringify({ model, choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-malformed-"));
  try {
    const runtime = new BonsaiRuntime(root);
    runtime.start = async () => `http://127.0.0.1:${(server.address() as any).port}`;
    const engine = new BonsaiEngine({ root, runtime });
    const ask = () => engine.complete({ model, messages: [{ role: "user", content: "inspect" }] });
    const [first, second] = [await ask(), await ask()];
    const [a, b] = [first.message.tool_calls?.[0], second.message.tool_calls?.[0]];
    assert.equal(a?.arguments, '{"path": "src/a.ts', "the reply keeps the call, its arguments as sent");
    assert.ok(a?.id && b?.id && a.id !== b.id, "calls the server left unnamed get ids no later round repeats");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }

  const sessions = await mkdtemp(path.join(os.tmpdir(), "bonsai-malformed-session-"));
  let rounds = 0;
  let toolRan = false;
  let answered = "";
  const session = new LocalSessions({
    root: path.join(sessions, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      rounds += 1;
      if (rounds === 1) return reply("", [{ id: "bad", name: "inspect", arguments: '{"path": "src/a.ts' }]);
      answered = String(request.messages.find((m) => m.role === "tool")?.content ?? "");
      return reply("Done.");
    },
  });
  try {
    const result = await session.run(
      {
        cwd: sessions,
        prompt: "Inspect",
        readOnly: true,
        liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
        onLiveTool: async () => {
          toolRan = true;
          return { text: "observed" };
        },
      },
      model,
    );
    assert.equal(rounds, 2, "the session went on after the malformed call");
    assert.equal(toolRan, false, "a call with unreadable arguments never runs");
    assert.match(answered, /not valid JSON/);
    assert.equal(result.summary, "Done.");
  } finally {
    await rm(sessions, { recursive: true, force: true });
  }
});

it("a cut-off reply's allowance is per stretch, not per session: good rounds between cuts reset it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-repairs-"));
  let rounds = 0;
  const cut = () => ({
    ...reply("half a file", [{ id: `cut-${rounds}`, name: "inspect", arguments: {} }]),
    stopReason: "length",
  });
  const session = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async () => {
      rounds += 1;
      if (rounds > 9) return reply("Done.");
      // Every other reply is cut off; the ones between finish a tool call.
      return rounds % 2 === 1 ? cut() : reply("Looking.", [{ id: `ok-${rounds}`, name: "inspect", arguments: {} }]);
    },
  });
  const result = await session.run(
    {
      cwd: root,
      prompt: "Inspect",
      readOnly: true,
      liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
      onLiveTool: async () => ({ text: "observed" }),
    },
    model,
  );
  assert.equal(
    result.ok,
    true,
    `five separate cuts, each after a good round, do not end the session: ${result.errorText}`,
  );
});
