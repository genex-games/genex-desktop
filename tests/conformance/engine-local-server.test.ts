/**
 * A local server: a model server the person runs (TabbyAPI, llama.cpp, LM Studio, vLLM, KoboldCpp,
 * an Ollama elsewhere), reached through its OpenAI-compatible API on the studio's own pi-ai loop.
 *
 * Runs pi-ai against a real local HTTP server playing each server's dialect
 * (`helpers/fake-local-server.ts`), so connecting, keys, discovery, streaming, tool calls and every
 * failure's mapping are exercised for real, with no network and no model.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LocalServerEngine } from "../../src/substrate/engines/local-server.ts";
import { EngineRegistry } from "../../src/substrate/engines/registry.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import {
  memoryServerSettings,
  serverSettings,
  type ServerSettings,
} from "../../src/substrate/local-server/settings.ts";
import { memoryKeyStore, type ApiKeyStore } from "../../src/substrate/provider-keys.ts";
import { SecretStorageUnavailableError } from "../../src/substrate/secrets.ts";
import { SecretStorageIssue } from "../../src/shared/secret-storage.ts";
import {
  FAKE_MODEL,
  type FakeLocalServer,
  type FakeLocalServerOptions,
  SERVER_KEY,
  startFakeLocalServer,
} from "../helpers/fake-local-server.ts";
import type { FakeReply } from "../helpers/fake-ollama.ts";
import { tmpDir } from "../helpers/tmp.ts";

const servers: FakeLocalServer[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function fake(options?: FakeLocalServerOptions): Promise<FakeLocalServer> {
  const server = await startFakeLocalServer(options);
  servers.push(server);
  return server;
}

/** No test asks the real network: a name resolves only from this table. */
const lookup = async (host: string) => {
  const table: Record<string, string[]> = { "api.openai.com": ["104.18.33.45"], localhost: ["127.0.0.1"] };
  const found = table[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found.map((address) => ({ address, family: 4 }));
};

interface Setup {
  settings?: ServerSettings;
  keys?: ApiKeyStore;
  ollamaHost?: string;
  findPorts?: number[];
}

async function engine(setup: Setup = {}) {
  const root = await tmpDir("local-server-");
  return new LocalServerEngine({
    root: path.join(root, "engine"),
    settings: setup.settings ?? memoryServerSettings(),
    keys: setup.keys ?? memoryKeyStore(),
    lookup,
    ...(setup.ollamaHost ? { ollamaHost: setup.ollamaHost } : {}),
    ...(setup.findPorts ? { findPorts: setup.findPorts } : {}),
  });
}

/** An engine already connected to `server`. */
async function connected(server: FakeLocalServer, setup: Setup & { key?: string } = {}) {
  const local = await engine(setup);
  const result = await local.connect({ url: server.url, ...(setup.key ? { key: setup.key } : {}) });
  assert.equal(result.ok, true, JSON.stringify(result));
  return local;
}

const chatCalls = (server: FakeLocalServer) =>
  server.requests.filter((request) => request.path === "/v1/chat/completions");

describe("connecting a local server", () => {
  it("saves a server that lists its models, names its software and lists them for the picker", async () => {
    const server = await fake({ flavor: "vllm" });
    const settings = memoryServerSettings();
    const local = await engine({ settings });
    assert.equal((await local.status()).code, "not_installed", "nothing is connected yet");
    assert.equal(await local.server(), null);

    const result = await local.connect({ url: `127.0.0.1:${server.port}` });
    assert.deepEqual(result, {
      ok: true,
      status: { code: "ready", detail: `vLLM at 127.0.0.1:${server.port}, 1 model` },
    });
    assert.deepEqual(await local.server(), { url: server.url, kind: "vllm", hasKey: false });
    assert.deepEqual(await settings.read(), { url: server.url, kind: "vllm" });
    const [row] = await local.models();
    assert.equal(row?.id, "Qwen/Qwen3.8-27B");
    assert.equal(row?.contextWindow, 40_960, "vLLM's max_model_len");
    assert.equal(row?.contextSource, "configured");
    assert.equal(row?.maxTokens, 10_240, "a quarter of the context");
    assert.equal(row?.supportsTools, true);
    assert.equal(row?.supportsVision, false);
    assert.equal(await local.defaultModel(), "Qwen/Qwen3.8-27B", "a free local model may be picked for the person");
  });

  it("asks for a key a server wants, refuses a wrong one, and keeps a right one without ever showing it", async () => {
    const server = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY] });
    const keys = memoryKeyStore();
    const settings = memoryServerSettings();
    const local = await engine({ keys, settings });

    assert.deepEqual(
      await local.connect({ url: server.url }),
      { ok: false, problem: "needs_key", kind: "tabbyapi" },
      "the server says which it is without a key, so Settings can say where its key is kept",
    );
    assert.deepEqual(await local.connect({ url: server.url, key: "wrong-key" }), {
      ok: false,
      problem: "key_refused",
      kind: "tabbyapi",
    });
    assert.equal(await settings.read(), null, "a refused connection saves nothing");
    assert.equal(await keys.read(), null);

    const result = await local.connect({ url: server.url, key: ` ${SERVER_KEY} ` });
    assert.equal(result.ok, true);
    assert.equal(await keys.read(), SERVER_KEY, "the pasted key, trimmed, is kept in the secret store");
    const info = await local.server();
    assert.deepEqual(info, { url: server.url, kind: "tabbyapi", hasKey: true });
    assert.doesNotMatch(JSON.stringify(info), /0123456789abcdef/, "Settings is told a key is kept, never the key");
  });

  it("reconnects the same server with the key it keeps when none is pasted", async () => {
    const server = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY] });
    const settings = memoryServerSettings({ url: server.url, kind: "tabbyapi" });
    const local = await engine({ settings, keys: memoryKeyStore(SERVER_KEY) });
    assert.equal((await local.connect({ url: `localhost:${server.port}` })).ok, true, "localhost is the same server");
  });

  it("never sends a kept key to another server, and forgets it once another is connected", async () => {
    const first = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY] });
    const other = await fake({ flavor: "lm-studio" });
    const keys = memoryKeyStore(SERVER_KEY);
    const local = await engine({ settings: memoryServerSettings({ url: first.url, kind: "tabbyapi" }), keys });
    assert.equal((await local.connect({ url: other.url })).ok, true);
    const sentKeys = other.requests.filter((request) => request.authorization?.includes(SERVER_KEY) || request.apiKey);
    assert.deepEqual(sentKeys, [], "the other server never saw the first one's key");
    assert.equal(await keys.read(), null, "a key belongs to its server");
    assert.deepEqual(await local.server(), { url: other.url, kind: "lm-studio", hasKey: false });
  });

  it("refuses what cannot be a key before asking the server", async () => {
    const server = await fake({ keys: [SERVER_KEY] });
    const local = await engine();
    for (const key of ["has space", "line\nbreak", "x".repeat(513), 42]) {
      assert.deepEqual(await local.connect({ url: server.url, key }), { ok: false, problem: "bad_key" }, String(key));
    }
    assert.equal(server.requests.length, 0, "the server was never asked about a value that cannot be a key");
  });

  it("refuses an address off this network, or not an address, and reaches nothing (hostile input)", async () => {
    const server = await fake();
    const settings = memoryServerSettings();
    const local = await engine({ settings });
    const rows: Array<[unknown, string]> = [
      ["https://api.openai.com/v1", "not_local"],
      ["http://8.8.8.8:5000/v1", "not_local"],
      [`ftp://127.0.0.1:${server.port}/v1`, "scheme"],
      [`http://user:pass@127.0.0.1:${server.port}/v1`, "credentials"],
      [`${server.url}?x=1`, "malformed"],
      ["", "empty"],
      [{ toString: () => server.url }, "empty"],
      ["http://nowhere.invalid:5000", "not_found"],
    ];
    for (const [url, problem] of rows)
      assert.deepEqual(await local.connect({ url, key: SERVER_KEY }), { ok: false, problem }, String(url));
    assert.equal(server.requests.length, 0, "a refused address is never reached");
    assert.equal(await settings.read(), null);
  });

  it("says when nothing answers, and when what answers is not a model server", async () => {
    const gone = await fake();
    const goneUrl = gone.url;
    await gone.close();
    const local = await engine();
    assert.deepEqual(await local.connect({ url: goneUrl }), { ok: false, problem: "not_answering" });
    const airplay = await fake({ flavor: "airplay" });
    assert.deepEqual(
      await local.connect({ url: airplay.url }),
      { ok: false, problem: "not_openai" },
      "macOS's AirPlay receiver answers 403 on port 5000, which is no request for a key",
    );
  });

  it("refuses the Ollama the app already uses, and connects one elsewhere", async () => {
    const ollama = await fake({ flavor: "ollama" });
    const own = await engine({ ollamaHost: `http://localhost:${ollama.port}` });
    assert.deepEqual(await own.connect({ url: ollama.url }), { ok: false, problem: "own_ollama" });

    const elsewhere = await engine({ ollamaHost: "http://127.0.0.1:11434" });
    assert.equal((await elsewhere.connect({ url: ollama.url })).ok, true);
    const [row] = await elsewhere.models();
    assert.equal(row?.id, "qwen3.8:27b");
    assert.equal(row?.contextWindow, 16_384, "the loaded context Ollama reports");
    assert.equal(row?.supportsVision, true);
    assert.equal(row?.supportsTools, true);
  });

  it("forgets the server and its key", async () => {
    const server = await fake({ keys: [SERVER_KEY] });
    const keys = memoryKeyStore();
    const local = await connected(server, { keys, key: SERVER_KEY });
    assert.equal((await local.forget()).code, "not_installed");
    assert.equal(await local.server(), null);
    assert.equal(await keys.read(), null);
    assert.deepEqual(await local.models(), []);
  });

  it("keeps the address in its own file, and reads back nothing from a file that is not one", async () => {
    const server = await fake();
    const file = path.join(await tmpDir("local-server-settings-"), "server.json");
    const settings = serverSettings(file);
    await connected(server, { settings });
    assert.deepEqual(await serverSettings(file).read(), { url: server.url, kind: null });
    const { writeFile } = await import("node:fs/promises");
    for (const bad of ['{"url":"https://api.openai.com/v1?x"}', '{"url":"javascript:alert(1)"}', "not json", "[]"]) {
      await writeFile(file, bad);
      assert.equal(await serverSettings(file).read(), null, bad);
    }
  });
});

describe("reading each server's models", () => {
  it("TabbyAPI: the loaded model's runtime context and vision from /props", async () => {
    const server = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY], props: { nCtx: 131_072, vision: true } });
    const local = await connected(server, { key: SERVER_KEY });
    const [row] = await local.models();
    assert.equal(row?.id, FAKE_MODEL);
    assert.equal(row?.contextWindow, 131_072, "the full context the card holds, as TabbyAPI loaded it");
    assert.equal(row?.contextSource, "configured");
    assert.equal(row?.supportsVision, true);
    const props = server.requests.find((request) => request.path === "/props");
    assert.equal(props?.authorization, `Bearer ${SERVER_KEY}`, "the key reaches the server's own endpoints too");
    assert.equal(props?.apiKey, SERVER_KEY);
  });

  it("llama.cpp: known by its header; its template's tool support decides whether it can build", async () => {
    const server = await fake({ flavor: "llama.cpp", props: { nCtx: 65_536, vision: true, tools: false } });
    const local = await connected(server);
    assert.equal((await local.server())?.kind, "llama-cpp");
    const [row] = await local.models();
    assert.equal(row?.contextWindow, 65_536);
    assert.equal(row?.supportsVision, true, "its list names image input");
    assert.equal(row?.supportsTools, false, "a template that cannot call tools is listed, not offered for builds");
  });

  it("LM Studio: its own names, loaded context and vision; embedding models are left out", async () => {
    const server = await fake({ flavor: "lm-studio" });
    const local = await connected(server);
    assert.equal((await local.server())?.kind, "lm-studio");
    const rows = await local.models();
    assert.deepEqual(
      rows.map((row) => [row.id, row.label, row.contextWindow, row.supportsVision]),
      [["qwen/qwen3.8-27b", "Qwen3.8 27B", 32_768, true]],
    );
  });

  it("KoboldCpp is known by its version endpoint, not taken for llama.cpp by its /props", async () => {
    const server = await fake({ flavor: "koboldcpp", props: { nCtx: 8_192 } });
    const local = await connected(server);
    assert.equal((await local.server())?.kind, "koboldcpp");
    assert.equal((await local.models())[0]?.contextWindow, 8_192);
  });

  it("an unknown server: its models, planned for 32K and never refused for size before it is asked", async () => {
    const server = await fake({ flavor: "generic" });
    const local = await connected(server);
    assert.equal((await local.server())?.kind, null);
    const [row] = await local.models();
    assert.equal(row?.contextWindow, 32_768);
    assert.equal(row?.contextSource, "unknown");
    assert.ok(row?.note, "the row says its context is a plan, not a report");
    const response = await local.complete({
      model: "my-model",
      messages: [{ role: "user", content: "w ".repeat(60_000) }],
    });
    assert.equal(response.message.content, "ok", "the server's own limit decides");
  });
});

describe("local server completions", () => {
  it("streams a reply with the key, the plain OpenAI request shape, and no cost", async () => {
    const server = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY], replies: [{ text: "Hello from the card" }] });
    const local = await connected(server, { key: SERVER_KEY });
    const deltas: string[] = [];
    const response = await local.complete({
      model: FAKE_MODEL,
      systemPrompt: "You build games.",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1_000,
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(response.message.content, "Hello from the card");
    assert.equal(deltas.join(""), "Hello from the card");
    assert.equal(response.engine, "local-server");
    assert.equal(response.usage.cost_usd, 0);
    const [call] = chatCalls(server);
    assert.equal(call?.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(call?.apiKey, SERVER_KEY);
    const body = call?.body as Record<string, unknown>;
    assert.equal(body.model, FAKE_MODEL);
    assert.equal(body.max_tokens, 1_000, "the field every local server reads");
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.store, undefined);
    assert.equal((body.messages as Array<{ role: string }>)[0]?.role, "system", "never the developer role");
  });

  it("runs tool calls, and refuses a picture for a model that cannot see before asking the server", async () => {
    const server = await fake({
      flavor: "vllm",
      replies: [{ toolCalls: [{ id: "c1", name: "probe", arguments: { depth: 2 } }] }],
    });
    const local = await connected(server);
    const tools = [{ name: "probe", description: "probe", parameters: { type: "object", properties: {} } }];
    const response = await local.complete({
      model: "Qwen/Qwen3.8-27B",
      messages: [{ role: "user", content: "go" }],
      tools,
    });
    assert.deepEqual(response.message.tool_calls, [{ id: "c1", name: "probe", arguments: { depth: 2 } }]);
    const sentBody = chatCalls(server)[0]?.body as { tools?: Array<{ function: { strict?: boolean } }> } | undefined;
    const tool = sentBody?.tools?.[0];
    assert.equal(tool?.function.strict, undefined, "no strict schemas, which local servers reject");
    const sent = chatCalls(server).length;
    await assert.rejects(
      local.complete({
        model: "Qwen/Qwen3.8-27B",
        messages: [{ role: "user", content: "look", images: [{ data: "aGk=", mimeType: "image/png" }] }],
      }),
      /cannot see images/,
    );
    assert.equal(chatCalls(server).length, sent);
  });

  it("keeps a reasoning model's thinking out of the answer, whether the server separates it or not", async () => {
    const server = await fake({
      replies: [{ reasoning: "Plan the level.", text: "Built." }, { text: "<think>Plan the boss.</think>\n\nDone." }],
    });
    const local = await connected(server);
    const separated = await local.complete({ model: "my-model", messages: [{ role: "user", content: "a" }] });
    assert.equal(separated.message.content, "Built.");
    assert.equal(separated.message.reasoning, "Plan the level.");
    const deltas: string[] = [];
    const inline = await local.complete({
      model: "my-model",
      messages: [{ role: "user", content: "b" }],
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(inline.message.content, "Done.");
    assert.equal(inline.message.reasoning, "Plan the boss.");
    assert.equal(deltas.join(""), "Done.", "the stream never shows the thought");
  });

  it("maps failures: too long for the context, refused, down, the server gone", async () => {
    const overflow =
      '{"error":{"code":400,"message":"request exceeds the available context size","type":"exceed_context_size_error"}}';
    const rows: Array<[FakeReply, string]> = [
      [{ httpStatus: 400, body: overflow }, "context_overflow"],
      [{ httpStatus: 401, body: '{"detail":"bad key"}' }, "auth"],
      [{ httpStatus: 503, body: '{"detail":"loading model"}' }, "unavailable"],
      [{ cutAfter: "half a rep" }, "other"],
    ];
    for (const [reply, kind] of rows) {
      const local = await connected(await fake({ replies: [reply] }));
      await assert.rejects(
        local.complete({ model: "my-model", messages: [{ role: "user", content: "x" }] }),
        (err) => err instanceof EngineError && err.kind === kind && err.engine === "local-server",
        JSON.stringify(reply),
      );
    }
  });

  it("says the server stopped when a cut leaves nothing answering, so another engine may take over", async () => {
    const alive = await connected(await fake({ replies: [{ cutAfter: "half" }] }));
    await assert.rejects(
      alive.complete({ model: "my-model", messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof EngineError && err.kind === "other" && /was cut mid-reply/.test(err.message),
      "a cut while the server still answers loses the turn, nothing more",
    );
    const server = await fake({ replies: [{ cutAfter: "half" }], stopOnCut: true });
    const stopped = await connected(server);
    await assert.rejects(
      stopped.complete({ model: "my-model", messages: [{ role: "user", content: "x" }] }),
      (err) =>
        err instanceof EngineError &&
        err.kind === "unavailable" &&
        err.message.startsWith(`Nothing answers at 127.0.0.1:${server.port}.`),
    );
  });

  it("never puts the key in an error, even when the server echoes it back", async () => {
    const echo = `{"detail":"bad header x-api-key: ${SERVER_KEY}"}`;
    const server = await fake({ keys: [SERVER_KEY], replies: [{ httpStatus: 400, body: echo }] });
    const local = await connected(server, { key: SERVER_KEY });
    const error = await local.complete({ model: "my-model", messages: [{ role: "user", content: "x" }] }).then(
      () => assert.fail("the request was refused"),
      (err: Error) => err,
    );
    assert.doesNotMatch(`${error.message} ${error.stack ?? ""}`, /0123456789abcdef/);
  });

  it("compacts at the threshold, and refuses what cannot fit a context the server reported", async () => {
    const local = await connected(await fake({ flavor: "vllm" }));
    await assert.rejects(
      local.complete({ model: "Qwen/Qwen3.8-27B", messages: [{ role: "user", content: "word ".repeat(40_000) }] }),
      (err) => err instanceof EngineError && err.kind === "context_overflow",
    );
    await assert.rejects(
      local.complete({
        model: "Qwen/Qwen3.8-27B",
        messages: [{ role: "user", content: "word ".repeat(12_000) }],
        contextPolicy: { mode: "custom", thresholdPercent: 50 },
      }),
      (err) => err instanceof EngineError && err.kind === "context_threshold",
    );
  });

  it("asks to connect a server, or to load a model, before sending anything", async () => {
    const local = await engine();
    await assert.rejects(
      local.complete({ messages: [{ role: "user", content: "x" }] }),
      /No local server is connected/,
    );
    const server = await fake();
    const ready = await connected(server);
    await assert.rejects(
      ready.complete({ model: "not-loaded", messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof EngineError && err.kind === "unavailable" && /does not list not-loaded/.test(err.message),
    );
    assert.equal(chatCalls(server).length, 0);
  });
});

describe("local server status", () => {
  it("says what to do at each step: not set up, stopped, wants a key, no models, ready, locked store", async () => {
    const server = await fake({ keys: [SERVER_KEY] });
    const settings = memoryServerSettings({ url: server.url, kind: "tabbyapi" });
    assert.equal((await (await engine({ settings: memoryServerSettings() })).status()).code, "not_installed");
    assert.equal((await (await engine({ settings })).status()).code, "needs_login");
    assert.equal((await (await engine({ settings, keys: memoryKeyStore(SERVER_KEY) })).status()).code, "ready");
    const empty = await fake({ models: [] });
    const none = await engine({ settings: memoryServerSettings({ url: empty.url, kind: null }) });
    assert.match((await none.status()).detail, /lists no models/);
    assert.equal((await none.status()).code, "not_installed");
    const stopped = await fake();
    const stoppedUrl = stopped.url;
    await stopped.close();
    const down = await engine({ settings: memoryServerSettings({ url: stoppedUrl, kind: null }) });
    assert.equal((await down.status()).code, "not_running");
    const locked: ApiKeyStore = {
      read: async () => {
        throw new SecretStorageUnavailableError(SecretStorageIssue.NoKeyring);
      },
      write: async () => {},
      clear: async () => {},
    };
    assert.equal((await (await engine({ settings, keys: locked })).status()).code, "error");
  });
});

describe("finding servers on this computer", () => {
  it("lists the servers answering on the usual ports, what they are and whether they want a key", async () => {
    const tabby = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY] });
    const lm = await fake({ flavor: "lm-studio" });
    const airplay = await fake({ flavor: "airplay" });
    const closed = await fake();
    const closedPort = closed.port;
    await closed.close();
    const local = await engine({ findPorts: [tabby.port, lm.port, airplay.port, closedPort] });
    assert.deepEqual(await local.find(), [
      { url: tabby.url, kind: "tabbyapi", needsKey: true, models: 0 },
      { url: lm.url, kind: "lm-studio", needsKey: false, models: 2 },
    ]);
  });

  it("leaves out the Ollama the app already uses", async () => {
    const ollama = await fake({ flavor: "ollama" });
    const local = await engine({ findPorts: [ollama.port], ollamaHost: `http://127.0.0.1:${ollama.port}` });
    assert.deepEqual(await local.find(), []);
  });
});

describe("local server sessions", () => {
  it("runs a Genex session on the picked model: its tools, its events and its result are the server's", async () => {
    const server = await fake({
      replies: [{ toolCalls: [{ id: "look-1", name: "inspect", arguments: {} }] }, { text: "Looked." }],
    });
    const local = await connected(server);
    const cwd = await tmpDir("local-server-game-");
    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await local.delegate({
      cwd,
      model: "my-model",
      prompt: "Inspect the game",
      readOnly: true,
      liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
      onLiveTool: async () => ({ text: "observed" }),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "local-server");
    assert.equal(result.summary, "Looked.");
    const activity = events.filter((event) => event.type === "activity").map((event) => event.payload);
    assert.ok(activity.every((payload) => (payload as { engine: string }).engine === "local-server"));
  });
});

describe("a local server in the registry", () => {
  it("is a local session engine, says which server it reaches, and may take over a throttled run", async () => {
    const server = await fake({ flavor: "tabbyapi", keys: [SERVER_KEY] });
    const registry = new EngineRegistry();
    registry.register(await connected(server, { key: SERVER_KEY }));
    const [described] = await registry.describe();
    assert.equal(described?.id, "local-server");
    assert.equal(described?.kind, "direct");
    assert.equal(described?.supportsSessions, true);
    assert.equal(described?.provider?.billing, "local");
    assert.deepEqual(described?.server, { url: server.url, kind: "tabbyapi", hasKey: true });
    assert.doesNotMatch(JSON.stringify(described), /0123456789abcdef/, "the descriptor never carries the key");
    assert.deepEqual(await registry.fallbackFor("claude-code", { kind: "rate_limit" }), ["local-server"]);
  });
});
