/**
 * Local-model engine conformance.
 *
 * Runs pi-ai against a real HTTP server, so streaming, tool-call assembly, usage accounting and
 * the message conversion in both directions are exercised for real. The last test additionally
 * talks to the user's own Ollama when a tool-capable model happens to be installed.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  OLLAMA_COMPLETION_TIMEOUT_MS,
  OllamaClient,
  OllamaEngine,
  OllamaSidecar,
  fromPiAssistant,
  toPiMessages,
} from "../../src/substrate/engines/ollama.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { startFakeOllama, type FakeOllama } from "../helpers/fake-ollama.ts";
import { cliName, writeCliLauncher } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const servers: FakeOllama[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function fake(options?: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> {
  const server = await startFakeOllama(options);
  servers.push(server);
  return server;
}

describe("ollama management API", () => {
  it("refuses tools when the model does not report tool capability", async () => {
    const server = await fake({
      models: [{ name: "plain", size: 100, capabilities: ["completion"], contextLength: 4096 }],
    });
    const engine = new OllamaEngine({ host: server.host });
    await assert.rejects(
      engine.complete({
        model: "plain",
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "probe", description: "probe", parameters: { type: "object", properties: {} } }],
      }),
      /tool.*not supported/,
    );
    assert.equal(server.requests.filter((request) => request.path.includes("chat/completions")).length, 0);
  });
  it("detects a running server, lists models and reads capabilities", async () => {
    const server = await fake();
    const client = new OllamaClient(server.host);
    assert.equal(await client.version(), "0.32.14");
    const tags = await client.tags();
    assert.equal(tags[0]?.name, "qwen3.6:27b");
    const shown = await client.show("qwen3.6:27b");
    assert.ok(shown.capabilities.includes("tools"));
    assert.equal(shown.contextLength, 262144);
  });

  it("reports no server rather than throwing when nothing is listening", async () => {
    const client = new OllamaClient("http://127.0.0.1:1");
    assert.equal(await client.version(), null);
  });

  it("says Ollama is not running when a download finds no server, instead of a bare fetch failure", async () => {
    const client = new OllamaClient("http://127.0.0.1:1");
    await assert.rejects(
      client.pull("qwen3.5:4b").next(),
      (err) =>
        err instanceof EngineError &&
        err.kind === EngineFailureKind.Unavailable &&
        err.message.includes("http://127.0.0.1:1"),
    );
  });

  it("keeps a download's own failure when Ollama still answers", async () => {
    const server = await fake();
    const client = new OllamaClient(server.host);
    const pull = client.pull("qwen3.6:27b", AbortSignal.abort());
    await assert.rejects(
      pull.next(),
      (err) => !(err instanceof EngineError),
      "an aborted pull is not a missing Ollama",
    );
  });

  it("streams pull progress", async () => {
    const server = await fake();
    const client = new OllamaClient(server.host);
    const updates = [];
    for await (const progress of client.pull("qwen3.6:27b")) updates.push(progress);
    assert.equal(updates.at(0)?.status, "pulling manifest");
    assert.equal(updates.at(-1)?.status, "success");
    assert.equal(updates.filter((u) => u.status === "downloading").at(-1)?.completed, 100);
  });

  it("surfaces engine status the UI can act on", async () => {
    const empty = await fake({ models: [] });
    const engineEmpty = new OllamaEngine({ host: empty.host });
    const statusEmpty = await engineEmpty.status();
    assert.equal(statusEmpty.code, "not_installed");
    assert.match(statusEmpty.remedy ?? "", /Models tab/);

    const offline = new OllamaEngine({ host: "http://127.0.0.1:1" });
    assert.equal((await offline.status()).code, "not_running");

    const server = await fake();
    assert.equal((await new OllamaEngine({ host: server.host }).status()).code, "ready");
  });

  it("flags stale installs against the curated catalog", async () => {
    const server = await fake({
      models: [
        { name: "qwen2.5-coder:32b", size: 20_000_000_000, capabilities: ["completion", "tools"] },
        { name: "qwen3.8:27b", size: 17_700_000_000, capabilities: ["completion", "tools"], contextLength: 262144 },
      ],
    });
    const models = await new OllamaEngine({ host: server.host }).models();
    const stale = models.find((m) => m.id === "qwen2.5-coder:32b");
    assert.equal(stale?.stale, true);
    assert.match(stale?.note ?? "", /superseded by qwen3\.8:27b/);
    assert.equal(models.find((m) => m.id === "qwen3.8:27b")?.stale, undefined, "the current default is not stale");
  });

  it("prefers a tool-capable model as the default (the loop needs tool calls)", async () => {
    const server = await fake({
      models: [
        { name: "gemma-chat:2b", size: 1_000_000_000, capabilities: ["completion"] },
        { name: "qwen3.6:27b", size: 17_000_000_000, capabilities: ["completion", "tools"] },
      ],
    });
    assert.equal(await new OllamaEngine({ host: server.host }).defaultModel(), "qwen3.6:27b");
  });

  it("deletes only a model Ollama lists, and the default moves to one still installed", async () => {
    const server = await fake({
      models: [
        { name: "qwen3.8:27b", size: 17_700_000_000, capabilities: ["completion", "tools"] },
        { name: "gemma4:12b", size: 7_600_000_000, capabilities: ["completion", "tools", "vision"] },
      ],
    });
    const engine = new OllamaEngine({ host: server.host });
    const deletes = () => server.requests.filter((request) => request.path === "/api/delete").map((r) => r.body);
    assert.equal(await engine.defaultModel(), "qwen3.8:27b");
    for (const name of ["", "missing:1b", "../qwen3.8:27b", "QWEN3.8:27B", "qwen3.8"]) {
      await assert.rejects(engine.removeModel(name), /not installed in Ollama/, JSON.stringify(name));
    }
    assert.deepEqual(deletes(), [], "a name Ollama does not list never reaches its delete");
    await engine.removeModel("qwen3.8:27b");
    assert.deepEqual(deletes(), [{ model: "qwen3.8:27b" }]);
    assert.deepEqual(
      (await engine.models()).map((model) => model.id),
      ["gemma4:12b"],
    );
    assert.equal(await engine.defaultModel(), "gemma4:12b", "the deleted default is not offered again");
  });
});

describe("ollama engine completions (real pi-ai over real HTTP)", () => {
  it("streams text deltas and returns an appendable assistant message", async () => {
    const server = await fake({ replies: [{ text: "Here is a three.js pong game." }] });
    const engine = new OllamaEngine({ host: server.host });
    const deltas: string[] = [];
    const response = await engine.complete({
      model: "qwen3.6:27b",
      systemPrompt: "You are the studio.",
      messages: [{ role: "user", content: "make pong" }],
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(response.message.role, "assistant");
    assert.equal(response.message.content, "Here is a three.js pong game.");
    assert.ok(deltas.length > 1, "text arrived as a stream, not one blob");
    assert.equal(deltas.join(""), "Here is a three.js pong game.");
    assert.equal(response.usage.input_tokens, 11);
    assert.equal(response.usage.output_tokens, 5);
    assert.equal(response.usage.cost_usd, 0, "local inference must be recorded as free");
    assert.equal(response.engine, "ollama");

    const sent = server.requests.find((r) => r.path.startsWith("/v1/chat/completions"))?.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    assert.equal(sent.messages[0]?.role, "system");
    assert.equal(sent.messages.at(-1)?.role, "user");
  });

  it("sends attached stills as OpenAI image_url parts, not as paths in the prompt", async () => {
    const server = await fake({
      models: [{ name: "qwen3.6:27b", size: 100, capabilities: ["completion", "tools", "vision"] }],
      replies: [{ text: '{"pick":"A","biggest_gap":"contrast","reason":"the picture"}' }],
    });
    const engine = new OllamaEngine({ host: server.host });
    await engine.complete({
      model: "qwen3.6:27b",
      messages: [
        {
          role: "user",
          content: "BUILD A vs BUILD B",
          images: [{ mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64") }],
        },
      ],
    });
    const sent = server.requests.find((r) => r.path.startsWith("/v1/chat/completions"))?.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const user = sent.messages.find((m) => m.role === "user");
    assert.ok(Array.isArray(user?.content), "vision messages must be a content array");
    const parts = user?.content as Array<{ type: string; image_url?: { url?: string }; text?: string }>;
    assert.equal(parts[0]?.type, "text");
    assert.equal(parts[0]?.text, "BUILD A vs BUILD B");
    assert.equal(parts[1]?.type, "image_url");
    assert.match(parts[1]?.image_url?.url ?? "", /^data:image\/jpeg;base64,/);
    assert.ok(!JSON.stringify(sent).includes(".jpg"), "file paths must not stand in for pixels");
  });

  it("refuses image requests to a model without declared vision before inference", async () => {
    const server = await fake({ models: [{ name: "qwen3.6:27b", size: 100, capabilities: ["completion", "tools"] }] });
    const engine = new OllamaEngine({ host: server.host });
    await assert.rejects(
      engine.complete({
        model: "qwen3.6:27b",
        messages: [{ role: "user", content: "Judge this frame", images: [{ mimeType: "image/png", data: "AA==" }] }],
      }),
      /vision.*not supported/i,
    );
    assert.equal(server.requests.filter((r) => r.path.startsWith("/v1/chat/completions")).length, 0);
  });

  it("uses loaded runtime context and a conservative unloaded context rather than the model maximum", async () => {
    const server = await fake({
      loaded: [{ name: "qwen3.6:27b", context_length: 4096 }],
    });
    const engine = new OllamaEngine({ host: server.host });
    assert.equal((await engine.models())[0]?.contextWindow, 4096);
    assert.equal((await engine.models())[0]?.contextSource, "configured");
    const unloaded = await fake();
    assert.equal((await new OllamaEngine({ host: unloaded.host }).models())[0]?.contextWindow, 8192);
    assert.equal((await new OllamaEngine({ host: unloaded.host }).models())[0]?.contextSource, "unknown");
  });

  it("an abort signal stops a completion mid-generation as 'stopped by the user'", async () => {
    const server = await fake({ replies: [{ hangAfter: "let me write the whole game—" }] });
    const engine = new OllamaEngine({ host: server.host });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const started = Date.now();
    await assert.rejects(
      engine.complete({
        model: "qwen3.6:27b",
        messages: [{ role: "user", content: "make doom" }],
        signal: abort.signal,
      }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError, `an EngineError, got: ${(err as Error).message}`);
        assert.equal(err.kind, "aborted");
        assert.match(err.message, /stopped by the user/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, "the abort landed promptly, not at some timeout");
  });

  it("gives every completion an hours-scale timeout, not the client's 10-minute default", async () => {
    // The 01:26 build turn died at exactly 600s: the underlying OpenAI-compatible client
    // times requests out after 10 minutes unless told otherwise. The client advertises the
    // timeout it was built with on the wire (in whole seconds), so the request itself is the
    // proof it got the hours-scale one.
    assert.equal(OLLAMA_COMPLETION_TIMEOUT_MS, 60 * 60 * 1000);
    const server = await fake({ replies: [{ text: "ok" }] });
    await new OllamaEngine({ host: server.host }).complete({
      model: "qwen3.6:27b",
      messages: [{ role: "user", content: "build for 43 minutes" }],
    });
    const sent = server.requests.find((r) => r.path.startsWith("/v1/chat/completions"));
    assert.equal(sent?.headers["x-stainless-timeout"], String(OLLAMA_COMPLETION_TIMEOUT_MS / 1000));
  });

  it("honors a shorter request deadline without expanding the engine timeout", async () => {
    const server = await fake({ replies: [{ text: "ok" }, { text: "ok" }] });
    const engine = new OllamaEngine({ host: server.host, timeoutMs: 8_000 });
    for (const timeoutMs of [2_000, 20_000]) {
      await engine.complete({ model: "qwen3.6:27b", messages: [{ role: "user", content: "check" }], timeoutMs });
    }
    const deadlines = server.requests
      .filter((r) => r.path.startsWith("/v1/chat/completions"))
      .map((r) => r.headers["x-stainless-timeout"]);
    assert.deepEqual(deadlines, ["2", "8"]);
  });

  it("a server that never answers surfaces the clear connection error, not silence", async () => {
    // The production shape: a Stop signal is attached (it always is), the server accepts the
    // request and goes quiet before headers. The client's timeout must still fire and land
    // as the actionable chat error, never a silence the watchdog rewinds.
    const server = await fake({ replies: [{ stall: true }] });
    const engine = new OllamaEngine({ host: server.host, timeoutMs: 400 });
    const abort = new AbortController();
    const started = Date.now();
    await assert.rejects(
      engine.complete({
        model: "qwen3.6:27b",
        messages: [{ role: "user", content: "make pong" }],
        signal: abort.signal,
      }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError, `an EngineError, got: ${(err as Error).message}`);
        assert.notEqual(err.kind, "aborted", "a timeout is a failure, never billed as a user stop");
        assert.match(err.message, /cut mid-generation/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 10_000, "the timeout fired on the configured clock");
  });

  it("explains a connection cut mid-generation instead of the bare 'terminated'", async () => {
    const server = await fake({ replies: [{ cutAfter: "half a game and then—" }] });
    const engine = new OllamaEngine({ host: server.host });
    await assert.rejects(
      engine.complete({ model: "qwen3.6:27b", messages: [{ role: "user", content: "make pong" }] }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError, `an EngineError, got: ${(err as Error).message}`);
        assert.match(err.message, /cut mid-generation/);
        return true;
      },
    );
  });

  it("returns tool calls in the substrate's own message shape", async () => {
    const server = await fake({
      replies: [
        {
          text: "Scaffolding.",
          toolCalls: [{ id: "call_1", name: "write_file", arguments: { path: "src/main.js", contents: "//" } }],
        },
      ],
    });
    const response = await new OllamaEngine({ host: server.host }).complete({
      model: "qwen3.6:27b",
      messages: [{ role: "user", content: "scaffold" }],
      tools: [
        {
          name: "write_file",
          description: "Write a file in the game workspace",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, contents: { type: "string" } },
            required: ["path", "contents"],
          },
        },
      ],
    });
    assert.equal(response.message.tool_calls?.length, 1);
    assert.deepEqual(response.message.tool_calls?.[0], {
      id: "call_1",
      name: "write_file",
      arguments: { path: "src/main.js", contents: "//" },
    });
    assert.equal(response.stopReason, "toolUse");

    const sent = server.requests.find((r) => r.path.startsWith("/v1/chat/completions"))?.body as {
      tools?: Array<{ function: { name: string } }>;
    };
    assert.equal(sent.tools?.[0]?.function.name, "write_file");
  });

  it("round-trips a tool result back into the next request", async () => {
    const server = await fake({ replies: [{ text: "Done." }] });
    await new OllamaEngine({ host: server.host }).complete({
      model: "qwen3.6:27b",
      messages: [
        { role: "user", content: "scaffold" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", name: "write_file", arguments: { path: "a.js" } }],
        },
        { role: "tool", content: "wrote a.js", tool_call_id: "call_1", name: "write_file" },
      ],
    });
    const sent = server.requests.find((r) => r.path.startsWith("/v1/chat/completions"))?.body as {
      messages: Array<{ role: string; tool_call_id?: string; tool_calls?: unknown[] }>;
    };
    assert.ok(sent.messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls)));
    assert.ok(sent.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1"));
  });

  it("classifies a rate limit as a retryable engine failure, not a crash", async () => {
    const server = await fake({
      replies: [{ httpStatus: 429, body: JSON.stringify({ error: { message: "slow down, retry-after: 30" } }) }],
    });
    await assert.rejects(
      () =>
        new OllamaEngine({ host: server.host }).complete({
          model: "qwen3.6:27b",
          messages: [{ role: "user", content: "hi" }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.engine, "ollama");
        // The 429 arrives through the stream, and must still read as a rate limit with the
        // server's own wait — that is what the run loop's backoff policy keys on.
        assert.equal(err.kind, "rate_limit");
        assert.equal(err.retryAfterMs, 30_000);
        return true;
      },
    );
  });

  it("says Ollama is not running when nothing answers, as a failure a fallback can take over", async () => {
    const server = await fake();
    const host = server.host;
    await server.close();
    await assert.rejects(
      () => new OllamaEngine({ host }).complete({ model: "qwen3.6:27b", messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.kind, "unavailable");
        assert.match(err.message, /not running/i);
        return true;
      },
    );
  });

  it("says the chosen model is not installed, not that the engine failed", async () => {
    // What Ollama answers for a model it does not have.
    const server = await fake({
      replies: [
        {
          httpStatus: 404,
          body: JSON.stringify({ error: { message: 'model "missing:7b" not found, try pulling it first' } }),
        },
      ],
    });
    await assert.rejects(
      () =>
        new OllamaEngine({ host: server.host }).complete({
          model: "missing:7b",
          messages: [{ role: "user", content: "hi" }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.kind, "unavailable");
        assert.match(err.message, /missing:7b/);
        assert.match(err.message, /not installed/i);
        return true;
      },
    );
  });

  it("fails with a clear error when no model is installed", async () => {
    const server = await fake({ models: [] });
    await assert.rejects(
      () => new OllamaEngine({ host: server.host }).complete({ messages: [{ role: "user", content: "hi" }] }),
      /no local model is installed/,
    );
  });
});

describe("message conversion", () => {
  it("folds system messages into the pi-ai system prompt", () => {
    const { systemPrompt, piMessages } = toPiMessages([
      { role: "system", content: "rule one" },
      { role: "system", content: "rule two" },
      { role: "user", content: "go" },
    ]);
    assert.equal(systemPrompt, "rule one\n\nrule two");
    assert.equal(piMessages.length, 1);
  });

  it("names a tool call the model left without an id, uniquely across rounds", () => {
    const unnamed = { content: [{ type: "toolCall", name: "list_games", arguments: {} }] };
    const first = fromPiAssistant(unnamed).message.tool_calls![0]!.id;
    const second = fromPiAssistant(unnamed).message.tool_calls![0]!.id;
    assert.ok(first, "a result can only be bound to a call with an id");
    assert.notEqual(first, second, "the next round's call is a different call");
  });

  it("preserves thinking traces separately from the answer", () => {
    const { message } = fromPiAssistant({
      content: [
        { type: "thinking", text: "the reference has screen shake" },
        { type: "text", text: "Adding screen shake." },
      ],
    });
    assert.equal(message.content, "Adding screen shake.");
    assert.equal(message.reasoning, "the reference has screen shake");
  });

  it("turns attached stills into pi-ai image blocks, not file paths", () => {
    const { piMessages } = toPiMessages([
      {
        role: "user",
        content: "BUILD A vs BUILD B",
        images: [{ mimeType: "image/jpeg", data: "abc123", label: "BUILD A / default" }],
      },
    ]);
    const user = piMessages[0] as {
      role: string;
      content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    };
    assert.equal(user.role, "user");
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[0]?.type, "text");
    assert.equal(user.content[0]?.text, "BUILD A vs BUILD B");
    assert.equal(user.content[1]?.type, "image");
    assert.equal(user.content[1]?.data, "abc123");
    assert.equal(user.content[1]?.mimeType, "image/jpeg");
  });
});

describe("ollama sidecar (detect-first)", () => {
  it("uses the server that is already running instead of starting another", async () => {
    const server = await fake();
    const sidecar = new OllamaSidecar({ host: server.host });
    assert.equal(await sidecar.ensureRunning(), true);
    const status = await sidecar.status();
    assert.equal(status.managed, false, "must not claim ownership of the user's server");
    assert.match(status.detail, /already running/);
    await sidecar.stop(); // no-op: we did not start it
    assert.equal((await sidecar.status()).running, true);
  });

  it("reports honestly when nothing is running and no bundled binary exists", async () => {
    const sidecar = new OllamaSidecar({ host: "http://127.0.0.1:1", binary: null });
    assert.equal(await sidecar.ensureRunning(1_000), false);
    assert.equal((await sidecar.status()).running, false);
  });

  it("stopping a server it started ends everything that server started too", async () => {
    const dir = await tmpDir("ollama-tree-");
    const pidFile = path.join(dir, "worker.pid");
    const binary = path.join(dir, cliName("ollama"));
    // `ollama serve` runs its model runners as children: the fixture starts one and waits.
    const js = `const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));
setInterval(() => {}, 1000);\n`;
    await writeCliLauncher(binary, `#!${process.execPath}\n${js}`, js);
    const sidecar = new OllamaSidecar({ host: "http://127.0.0.1:9", binary });
    assert.equal(await sidecar.ensureRunning(300), false, "nothing answers on port 9");
    let worker = 0;
    for (let i = 0; i < 300 && !worker; i++) {
      worker = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (!worker) await delay(10);
    }
    assert.ok(worker, "the server started its worker");
    await sidecar.stop();
    let alive = true;
    for (let i = 0; i < 300 && alive; i++) {
      try {
        process.kill(worker, 0);
        await delay(10);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the worker ended with the server");
  });
});

describe("live check against the user's Ollama", () => {
  it("completes a real turn when a tool-capable model is installed", async (t) => {
    // Opt-in only: the studio's builders are the subscription engines (Codex, Claude Code); a
    // full `npm test` must never spend minutes on whatever local model happens to be installed.
    if (process.env.STUDIO_LIVE_OLLAMA !== "1") return t.skip("set STUDIO_LIVE_OLLAMA=1 to run the live Ollama check");
    const client = new OllamaClient();
    const version = await client.version();
    if (!version) return t.skip("no Ollama running on this machine");
    const tags = await client.tags();
    let usable: string | null = null;
    for (const tag of tags) {
      const shown = await client.show(tag.name).catch(() => null);
      if (shown?.capabilities.includes("tools")) {
        usable = tag.name;
        break;
      }
    }
    if (!usable) {
      return t.skip(
        `Ollama ${version} is running but has no tool-capable model installed — pull one to enable this check`,
      );
    }
    const response = await new OllamaEngine().complete({
      model: usable,
      systemPrompt: "Answer with a single word.",
      messages: [{ role: "user", content: "Say the word: ready" }],
      maxTokens: 32,
    });
    assert.equal(response.message.role, "assistant");
    assert.ok(response.message.content.length > 0);
  });
});
