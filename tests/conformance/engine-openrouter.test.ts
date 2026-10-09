/**
 * OpenRouter: a metered API engine on the studio's own pi-ai loop, its key kept in the secret store.
 *
 * Runs pi-ai against a real local HTTP server (`helpers/fake-openrouter.ts`), so the provider wiring,
 * the key in the Authorization header, streaming, tool calls, usage and every failure's mapping are
 * exercised for real, with no network and no account.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { EngineRegistry } from "../../src/substrate/engines/registry.ts";
import { OpenRouterEngine, cleanApiKey, openRouterModels } from "../../src/substrate/engines/openrouter.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import { memoryKeyStore, type ApiKeyStore } from "../../src/substrate/provider-keys.ts";
import { SecretStorageUnavailableError } from "../../src/substrate/secrets.ts";
import { SecretStorageIssue } from "../../src/shared/secret-storage.ts";
import { CATALOG, GOOD_KEY, startFakeOpenRouter, type FakeOpenRouter } from "../helpers/fake-openrouter.ts";
import type { FakeReply } from "../helpers/fake-ollama.ts";
import { tmpDir } from "../helpers/tmp.ts";

const servers: FakeOpenRouter[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function fake(options?: Parameters<typeof startFakeOpenRouter>[0]): Promise<FakeOpenRouter> {
  const server = await startFakeOpenRouter(options);
  servers.push(server);
  return server;
}

async function engineFor(server: FakeOpenRouter, keys: ApiKeyStore = memoryKeyStore(GOOD_KEY)) {
  const root = await tmpDir("openrouter-");
  return new OpenRouterEngine({ root: path.join(root, "engine"), keys, baseUrl: server.baseUrl });
}

const SONNET = "anthropic/claude-sonnet-4.5";
const QWEN = "qwen/qwen3-coder";

describe("OpenRouter's catalog", () => {
  it("lists only models that call tools, with their context, reply cap, vision, thinking and price", () => {
    const rows = openRouterModels({ data: CATALOG });
    assert.deepEqual(
      rows.map((row) => row.id),
      [SONNET, QWEN],
      "a model without tool calling cannot run the studio's loop",
    );
    const [sonnet, qwen] = rows;
    assert.equal(sonnet?.label, "Claude Sonnet 4.5", "the model's name, without OpenRouter's vendor prefix");
    assert.equal(sonnet?.contextWindow, 200_000);
    assert.equal(sonnet?.maxTokens, 32_768, "the reply cap is the studio's, under the provider's own");
    assert.equal(sonnet?.supportsVision, true);
    assert.equal(sonnet?.supportsThinking, true);
    assert.deepEqual(sonnet?.efforts, ["low", "medium", "high"]);
    assert.equal(sonnet?.note, "$3.00 in / $15.00 out per M tokens");
    assert.equal(qwen?.maxTokens, 10_000, "a quarter of a small context");
    assert.equal(qwen?.supportsVision, false);
    assert.equal(qwen?.efforts, undefined, "a model that does not think has no dial");
    assert.equal(qwen?.note, "Free");
  });

  it("names a model without its vendor, and keeps a name that has none", () => {
    const named = (name: string) =>
      openRouterModels({ data: [{ id: "v/m", name, supported_parameters: ["tools"] }] })[0]?.label;
    assert.equal(named("OpenAI: GPT-6.1 Sol"), "GPT-6.1 Sol");
    assert.equal(named("Google: Gemini 3.1 Pro: Preview"), "Gemini 3.1 Pro: Preview", "only the vendor goes");
    assert.equal(named("Grok 4"), "Grok 4");
    assert.equal(named("Weird:"), "Weird:", "a name that would be left empty stays whole");
  });

  it("leaves out models that answer with images or audio, though they call tools", () => {
    const entry = (id: string, output?: string[]) => ({
      id,
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], ...(output ? { output_modalities: output } : {}) },
    });
    const rows = openRouterModels({
      data: [
        entry("google/gemini-nano-banana-2.1", ["image", "text"]),
        entry("openai/gpt-audio", ["text", "audio"]),
        entry("openrouter/auto", ["text", "image"]),
        entry("openai/gpt-6-luna", ["text"]),
        entry("vendor/older-listing"),
      ],
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["openai/gpt-6-luna", "vendor/older-listing"],
      "only text comes back into a build; a listing that names no output is taken as text",
    );
  });

  it("refuses a catalog that is not one, and skips entries it cannot read", () => {
    for (const body of [null, {}, { data: "x" }, "[]"])
      assert.throws(() => openRouterModels(body), /could not be read/, JSON.stringify(body));
    const rows = openRouterModels({ data: [null, 7, { id: 3, supported_parameters: ["tools"] }, CATALOG[1]] });
    assert.deepEqual(
      rows.map((row) => row.id),
      [QWEN],
    );
  });

  it("is read from the provider without a key, and a failed read keeps nothing stale as fresh", async () => {
    const server = await fake();
    const engine = await engineFor(server, memoryKeyStore(null));
    await engine.refreshModels(true);
    assert.deepEqual(
      (await engine.models()).map((row) => row.id),
      [SONNET, QWEN],
    );
    assert.equal(server.requests.find((request) => request.path === "/api/v1/models")?.authorization, undefined);

    const broken = await fake({ catalog: { status: 200, body: "{not json" } });
    const engineBroken = await engineFor(broken);
    await engineBroken.refreshModels(true);
    assert.deepEqual(await engineBroken.models(), []);
    assert.equal(engineBroken.catalogSnapshot().state, "unavailable");
    assert.equal(engineBroken.catalogSnapshot().problem?.code, "malformed");
  });
});

describe("OpenRouter's key", () => {
  it("says what to do at each step: no key, a refused key, a good key, a locked store", async () => {
    const server = await fake();
    const none = await engineFor(server, memoryKeyStore(null));
    const missing = await none.status();
    assert.equal(missing.code, "needs_login");
    assert.match(missing.remedy ?? "", /Settings › Model Providers/);

    const refused = await (await engineFor(server, memoryKeyStore("sk-or-v1-not-a-key-this-server-takes"))).status();
    assert.equal(refused.code, "needs_login");
    assert.match(refused.detail, /did not accept/);

    assert.equal((await (await engineFor(server)).status()).code, "ready");

    const locked: ApiKeyStore = {
      read: async () => {
        throw new SecretStorageUnavailableError(SecretStorageIssue.NoKeyring);
      },
      write: async () => {},
      clear: async () => {},
    };
    const lockedStatus = await (await engineFor(server, locked)).status();
    assert.equal(lockedStatus.code, "error");
    assert.match(lockedStatus.detail, /secret store is locked/);
  });

  it("saves a pasted key only when OpenRouter takes it, and forgets it on request", async () => {
    const server = await fake();
    const keys = memoryKeyStore(null);
    const engine = await engineFor(server, keys);
    assert.equal((await engine.saveKey("sk-or-v1-wrong-key-0000000000000")).code, "needs_login");
    assert.equal(await keys.read(), null, "a refused key is not kept");
    assert.equal((await engine.saveKey(`  ${GOOD_KEY}\n`)).code, "ready");
    assert.equal(await keys.read(), GOOD_KEY, "kept trimmed");
    assert.equal((await engine.clearKey()).code, "needs_login");
    assert.equal(await keys.read(), null);
  });

  it("refuses what cannot be a key before asking anyone, and stores nothing (hostile input)", async () => {
    const server = await fake();
    const keys = memoryKeyStore(null);
    const engine = await engineFor(server, keys);
    const hostile: unknown[] = [
      "",
      "   ",
      "short",
      `${GOOD_KEY}\nX-Injected: 1`,
      `${GOOD_KEY} ${GOOD_KEY}`,
      "k".repeat(4096),
      42,
      null,
      { key: GOOD_KEY },
      [GOOD_KEY],
    ];
    for (const value of hostile) {
      assert.equal(cleanApiKey(value), null, JSON.stringify(value)?.slice(0, 40));
      const status = await engine.saveKey(value);
      assert.equal(status.code, "needs_login");
      assert.doesNotMatch(JSON.stringify(status), /sk-or-v1-0123/, "the answer never carries a key");
    }
    assert.equal(await keys.read(), null);
    assert.equal(
      server.requests.filter((request) => request.path === "/api/v1/key").length,
      0,
      "OpenRouter was never asked about a value that cannot be a key",
    );
  });
});

describe("OpenRouter completions", () => {
  it("streams a reply with the key as a bearer, the model's own id, and the price pi-ai computes", async () => {
    const server = await fake({
      replies: [{ text: "Hello from the cloud", usage: { prompt: 1_000_000, completion: 0 } }],
    });
    const engine = await engineFor(server);
    const deltas: string[] = [];
    const response = await engine.complete({
      model: SONNET,
      messages: [{ role: "user", content: "hi" }],
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(response.message.content, "Hello from the cloud");
    assert.equal(deltas.join(""), "Hello from the cloud");
    assert.equal(response.engine, "openrouter");
    assert.equal(response.usage.engine, "openrouter");
    assert.equal(response.usage.cost_usd, 3, "a million prompt tokens at $3 per million");
    const call = server.requests.find((request) => request.path === "/api/v1/chat/completions");
    assert.equal(call?.authorization, `Bearer ${GOOD_KEY}`);
    assert.equal((call?.body as { model?: string } | undefined)?.model, SONNET);
  });

  it("runs tool calls and refuses what the model cannot do before paying for a request", async () => {
    const server = await fake({
      replies: [{ toolCalls: [{ id: "call-1", name: "probe", arguments: { depth: 2 } }] }],
    });
    const engine = await engineFor(server);
    const tools = [{ name: "probe", description: "probe", parameters: { type: "object", properties: {} } }];
    const response = await engine.complete({ model: QWEN, messages: [{ role: "user", content: "go" }], tools });
    assert.deepEqual(response.message.tool_calls, [{ id: "call-1", name: "probe", arguments: { depth: 2 } }]);

    const completions = () => server.requests.filter((request) => request.path === "/api/v1/chat/completions").length;
    const sent = completions();
    await assert.rejects(
      engine.complete({
        model: QWEN,
        messages: [{ role: "user", content: "look", images: [{ data: "aGk=", mimeType: "image/png" }] }],
      }),
      /cannot see images/,
    );
    await assert.rejects(
      engine.complete({ model: "some/chat-only", messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof EngineError && err.kind === "unavailable",
    );
    await assert.rejects(engine.complete({ messages: [{ role: "user", content: "x" }] }), /Pick an OpenRouter model/);
    assert.equal(completions(), sent, "no refused request reached the provider");
  });

  it("maps every failure by its status: throttled, refused, out of credits, down", async () => {
    const rows: Array<[FakeReply, string]> = [
      [{ httpStatus: 429, body: '{"error":{"message":"Rate limit exceeded"}}' }, "rate_limit"],
      [{ httpStatus: 401, body: '{"error":{"message":"bad key"}}' }, "auth"],
      [{ httpStatus: 402, body: '{"error":{"message":"Insufficient credits"}}' }, "usage_limit"],
      [{ httpStatus: 502, body: '{"error":{"message":"upstream"}}' }, "unavailable"],
      [{ cutAfter: "half a rep" }, "unavailable"],
    ];
    for (const [reply, kind] of rows) {
      const engine = await engineFor(await fake({ replies: [reply] }));
      await assert.rejects(
        engine.complete({ model: QWEN, messages: [{ role: "user", content: "x" }] }),
        (err) => err instanceof EngineError && err.kind === kind && err.engine === "openrouter",
        JSON.stringify(reply),
      );
    }
  });

  it("never puts the key in an error, even when the provider echoes it back", async () => {
    const echo = `{"error":{"message":"bad header Bearer ${GOOD_KEY}"}}`;
    const engine = await engineFor(await fake({ replies: [{ httpStatus: 400, body: echo }] }));
    const error = await engine.complete({ model: QWEN, messages: [{ role: "user", content: "x" }] }).then(
      () => assert.fail("the request was refused"),
      (err: Error) => err,
    );
    assert.doesNotMatch(`${error.message} ${error.stack ?? ""}`, /0123456789abcdef0123456789abcdef/);
  });

  it("says the key is missing as a sign-in failure, without sending anything", async () => {
    const server = await fake();
    const engine = await engineFor(server, memoryKeyStore(null));
    await engine.refreshModels(true);
    await assert.rejects(
      engine.complete({ model: QWEN, messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof EngineError && err.kind === "auth",
    );
    assert.equal(server.requests.filter((request) => request.path.includes("chat/completions")).length, 0);
  });

  it("compacts before a request that would not fit, from an estimate it reports as one", async () => {
    const engine = await engineFor(await fake());
    const readings: unknown[] = [];
    const long = "word ".repeat(30_000);
    await assert.rejects(
      engine.complete({
        model: QWEN,
        messages: [{ role: "user", content: long }],
        contextPolicy: { mode: "default" },
        onContext: (reading) => readings.push(reading),
      }),
      (err) => err instanceof EngineError && err.kind === "context_overflow",
    );
    assert.equal((readings[0] as { source?: string }).source, "estimated");
    await assert.rejects(
      engine.complete({
        model: QWEN,
        messages: [{ role: "user", content: "word ".repeat(12_000) }],
        contextPolicy: { mode: "custom", thresholdPercent: 50 },
      }),
      (err) => err instanceof EngineError && err.kind === "context_threshold",
    );
  });
});

describe("OpenRouter sessions", () => {
  it("runs a Genex session on the picked model: its tools, its events and its result are OpenRouter's", async () => {
    const server = await fake({
      replies: [{ toolCalls: [{ id: "look-1", name: "inspect", arguments: {} }] }, { text: "Looked." }],
    });
    const engine = await engineFor(server);
    const cwd = await tmpDir("openrouter-game-");
    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await engine.delegate({
      cwd,
      model: QWEN,
      prompt: "Inspect the game",
      readOnly: true,
      liveTools: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } }],
      onLiveTool: async () => ({ text: "observed" }),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "openrouter");
    assert.equal(result.model, QWEN);
    assert.equal(result.summary, "Looked.");
    const activity = events.filter((event) => event.type === "activity").map((event) => event.payload);
    assert.ok(activity.length > 0);
    assert.ok(activity.every((payload) => (payload as { engine: string }).engine === "openrouter"));
    await assert.rejects(engine.delegate({ cwd, prompt: "x" }), /Pick an OpenRouter model/);
  });
});

describe("OpenRouter in the registry", () => {
  it("is described as a session engine that needs its key, and is never a fallback", async () => {
    const server = await fake();
    const registry = new EngineRegistry();
    registry.register(await engineFor(server, memoryKeyStore(null)));
    const [described] = await registry.describe();
    assert.equal(described?.id, "openrouter");
    assert.equal(described?.kind, "direct");
    assert.equal(described?.supportsSessions, true);
    assert.equal(described?.status.code, "needs_login");
    assert.equal(described?.provider?.billing, "metered");
    assert.equal(described?.defaultModel, null, "no model is picked for the person");

    const ready = new EngineRegistry();
    ready.register(await engineFor(server));
    assert.deepEqual(await ready.fallbackFor("claude-code", { kind: "rate_limit" }), []);
    assert.equal(await ready.firstReady(), null);
  });
});
