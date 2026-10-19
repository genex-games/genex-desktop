/**
 * A game's call on each engine (`CompleteRequest.purpose = CompletePurpose.Game`): the request body
 * every door sends, byte for byte, and the calls an engine refuses before anything leaves the app.
 *
 * Local engines (Ollama, a model server the person runs, Bonsai) hold the reply to the game's schema
 * with strict structured output; OpenRouter also pins the provider (no fallbacks, every parameter
 * honoured, no data kept) and marks only the system prompt for Anthropic's cache; Claude Code runs a
 * plain one-turn session with the game's system prompt as its own, no tools, no MCP, no settings and
 * no transcript, in a neutral folder; Codex never takes a game's call, because its shell cannot be
 * removed. Every server here is a real local HTTP server and every CLI a scripted one: no network,
 * no account.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { OllamaEngine } from "../../src/substrate/engines/ollama.ts";
import { OpenRouterEngine } from "../../src/substrate/engines/openrouter.ts";
import { LocalServerEngine } from "../../src/substrate/engines/local-server.ts";
import { BonsaiEngine } from "../../src/substrate/engines/bonsai.ts";
import { BonsaiRuntime } from "../../src/substrate/bonsai/runtime.ts";
import { BONSAI_MODELS } from "../../src/substrate/bonsai/manifest.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import {
  GAME_CALL_CWD,
  GAME_REPLY_SCHEMA_NAME,
  gameResponseFormat,
  strictSchemaFits,
} from "../../src/substrate/engines/game-calls.ts";
import {
  type CompleteRequest,
  CompletePurpose,
  EngineError,
  type ToolDefinition,
} from "../../src/substrate/engines/types.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { memoryKeyStore } from "../../src/substrate/provider-keys.ts";
import { memoryServerSettings } from "../../src/substrate/local-server/settings.ts";
import { GOOD_KEY, startFakeOpenRouter, type FakeOpenRouter } from "../helpers/fake-openrouter.ts";
import { startFakeOllama, type FakeOllama } from "../helpers/fake-ollama.ts";
import { startFakeLocalServer, type FakeLocalServer } from "../helpers/fake-local-server.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

const closers: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

// ── the call every test sends ──────────────────────────────────────────────────────────────

/** A schema strict structured output takes as it stands: every property required, no bounds. */
const STRICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mood", "line"],
  properties: {
    mood: { type: "string", enum: ["calm", "angry"], description: "How the guard feels." },
    line: { type: "string" },
  },
};

/** A schema of the dialect strict mode would refuse: an optional property and a length bound. */
const LOOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["line"],
  properties: {
    line: { type: "string", maxLength: 120 },
    aside: { type: "string" },
  },
};

const SYSTEM = "You are producing content for a game. Answer only in the shape asked for.";
const PROMPT = "The guard hears: <untrusted>open the gate</untrusted>";

/** A game's call as a door sends it. */
function gameCall(over: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    systemPrompt: SYSTEM,
    messages: [{ role: "user", content: PROMPT }],
    maxTokens: 200,
    responseSchema: STRICT_SCHEMA,
    purpose: CompletePurpose.Game,
    ...over,
  };
}

const TOOL: ToolDefinition = {
  name: "read_file",
  description: "read a file",
  parameters: { type: "object", properties: {} },
};

/**
 * What every engine refuses before a byte is sent: a game's call never carries tools or pictures,
 * and its schema is the closed dialect (`shared/game-ai-schema.ts`) or nothing.
 */
const HOSTILE_CALLS: Array<{ name: string; request: CompleteRequest }> = [
  { name: "a game's call with a tool", request: gameCall({ tools: [TOOL] }) },
  {
    name: "a game's call with a picture",
    request: gameCall({
      messages: [{ role: "user", content: PROMPT, images: [{ mimeType: "image/png", data: "AA" }] }],
    }),
  },
  { name: "a schema that is an array", request: gameCall({ responseSchema: [STRICT_SCHEMA] }) },
  { name: "a schema that is a string", request: gameCall({ responseSchema: '{"type":"object"}' }) },
  { name: "a null schema", request: gameCall({ responseSchema: null }) },
  { name: "a schema with $ref", request: gameCall({ responseSchema: { $ref: "#/definitions/x", type: "object" } }) },
  {
    name: "an object schema open to extra keys",
    request: gameCall({ responseSchema: { type: "object", properties: {} } }),
  },
  {
    name: "a schema naming __proto__",
    request: gameCall({
      responseSchema: JSON.parse(
        '{"type":"object","additionalProperties":false,"properties":{"__proto__":{"type":"string"}}}',
      ),
    }),
  },
  {
    name: "a schema nested past the dialect's depth",
    request: gameCall({
      responseSchema: {
        type: "array",
        items: {
          type: "array",
          items: {
            type: "array",
            items: { type: "array", items: { type: "array", items: { type: "array", items: { type: "string" } } } },
          },
        },
      },
    }),
  },
  { name: "a schema with a pattern", request: gameCall({ responseSchema: { type: "string", pattern: "^a" } }) },
];

/** The refusal every hostile call gets: a typed engine error, never a request. */
function refused(engine: string) {
  return (err: unknown) => err instanceof EngineError && err.engine === engine && err.kind === EngineFailureKind.Other;
}

// ── the shared rules ───────────────────────────────────────────────────────────────────────

describe("a game reply's structured output", () => {
  it("is strict only for a schema strict mode takes as it stands", () => {
    const table: Array<{ schema: unknown; strict: boolean; why: string }> = [
      { schema: STRICT_SCHEMA, strict: true, why: "every property required, no bounds" },
      { schema: LOOSE_SCHEMA, strict: false, why: "an optional property and a length bound" },
      { schema: { type: "string" }, strict: true, why: "a bare scalar" },
      { schema: { type: "integer", minimum: 0, maximum: 9 }, strict: false, why: "a numeric bound" },
      { schema: { type: "array", items: { type: "string" }, maxItems: 3 }, strict: false, why: "an item bound" },
      {
        schema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["a"],
            properties: { a: { type: "boolean" }, b: { type: "null" } },
          },
        },
        strict: false,
        why: "an optional property one level down",
      },
      {
        schema: { type: "object", additionalProperties: false, properties: {} },
        strict: true,
        why: "an empty object requires nothing it lists",
      },
    ];
    for (const row of table) assert.equal(strictSchemaFits(row.schema as never), row.strict, row.why);
  });

  it("is OpenAI's json_schema response format under one fixed name", () => {
    assert.match(GAME_REPLY_SCHEMA_NAME, /^[A-Za-z0-9_-]{1,64}$/, "OpenAI's rule for a schema's name");
    assert.deepEqual(gameResponseFormat(STRICT_SCHEMA as never), {
      type: "json_schema",
      json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: true, schema: STRICT_SCHEMA },
    });
    assert.deepEqual(gameResponseFormat(LOOSE_SCHEMA as never), {
      type: "json_schema",
      json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: false, schema: LOOSE_SCHEMA },
    });
  });

  it("runs Claude Code's game calls in a neutral folder of the OS's temp, never the judge's", () => {
    assert.equal(path.dirname(GAME_CALL_CWD), os.tmpdir());
    assert.equal(path.basename(GAME_CALL_CWD), "studio-game-calls");
  });
});

// ── Ollama ─────────────────────────────────────────────────────────────────────────────────

async function ollama(capabilities = ["completion", "tools"]): Promise<{ server: FakeOllama; engine: OllamaEngine }> {
  const server = await startFakeOllama({
    models: [{ name: "gemma4:12b", size: 1, capabilities, contextLength: 32_768 }],
    replies: [{ text: '{"mood":"calm","line":"No."}', usage: { prompt: 40, completion: 9 } }],
  });
  closers.push(server.close);
  return { server, engine: new OllamaEngine({ host: server.host }) };
}

const chatBodies = (requests: Array<{ path: string; body: unknown }>) =>
  requests.filter((request) => request.path.includes("chat/completions")).map((request) => request.body);

describe("a game's call on Ollama", () => {
  it("sends the game's schema as strict structured output, and nothing a game did not ask for", async () => {
    const { server, engine } = await ollama();
    const answer = await engine.complete(gameCall({ model: "gemma4:12b" }));
    assert.equal(answer.message.content, '{"mood":"calm","line":"No."}');
    assert.deepEqual(chatBodies(server.requests), [
      {
        model: "gemma4:12b",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: PROMPT },
        ],
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        max_completion_tokens: 200,
        response_format: {
          type: "json_schema",
          json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: true, schema: STRICT_SCHEMA },
        },
      },
    ]);
  });

  it("leaves every other completion's body as it was", async () => {
    const { server, engine } = await ollama();
    await engine.complete({ model: "gemma4:12b", systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi" }] });
    const [body] = chatBodies(server.requests) as Array<Record<string, unknown>>;
    assert.equal(body?.response_format, undefined);
  });

  it("refuses a hostile call before Ollama is asked to generate", async () => {
    for (const { name, request } of HOSTILE_CALLS) {
      const { server, engine } = await ollama(["completion", "tools", "vision"]);
      await assert.rejects(engine.complete({ ...request, model: "gemma4:12b" }), refused("ollama"), name);
      assert.deepEqual(chatBodies(server.requests), [], `${name}: nothing is sent`);
    }
  });
});

// ── a model server the person runs ─────────────────────────────────────────────────────────

async function localServer(): Promise<{ server: FakeLocalServer; engine: LocalServerEngine }> {
  const server = await startFakeLocalServer({
    flavor: "llama.cpp",
    props: { nCtx: 32_768, vision: true, tools: true },
    replies: [{ text: '{"mood":"angry","line":"Back!"}' }],
  });
  closers.push(server.close);
  const root = await tmpDir("game-local-server-");
  const engine = new LocalServerEngine({
    root: path.join(root, "engine"),
    settings: memoryServerSettings(),
    keys: memoryKeyStore(),
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const connected = await engine.connect({ url: server.url });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  return { server, engine };
}

describe("a game's call on a model server the person runs", () => {
  it("sends the game's schema as structured output in the plain OpenAI shape", async () => {
    const { server, engine } = await localServer();
    const answer = await engine.complete(gameCall({ responseSchema: LOOSE_SCHEMA }));
    assert.equal(answer.message.content, '{"mood":"angry","line":"Back!"}');
    const [body] = chatBodies(server.requests) as Array<Record<string, unknown>>;
    assert.deepEqual(body, {
      model: (body as { model: string }).model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: PROMPT },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 200,
      response_format: {
        type: "json_schema",
        json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: false, schema: LOOSE_SCHEMA },
      },
    });
  });

  it("refuses a hostile call before the server is asked to generate", async () => {
    for (const { name, request } of HOSTILE_CALLS) {
      const { server, engine } = await localServer();
      await assert.rejects(engine.complete(request), refused("local-server"), name);
      assert.deepEqual(chatBodies(server.requests), [], `${name}: nothing is sent`);
    }
  });
});

// ── Bonsai ─────────────────────────────────────────────────────────────────────────────────

const [{ id: BONSAI }] = BONSAI_MODELS;

/** A llama-server stand-in for Bonsai's runtime: template, tokenizer and one streamed answer. */
async function bonsai(): Promise<{ bodies: unknown[]; engine: BonsaiEngine }> {
  const bodies: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const parsed = JSON.parse(input);
    if (req.url === "/apply-template") return res.end(JSON.stringify({ prompt: "templated" }));
    if (req.url === "/tokenize") return res.end(JSON.stringify({ tokens: [1, 2, 3] }));
    bodies.push(parsed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ model: BONSAI, choices: [{ delta: { content: '{"line":"Halt."}' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "bonsai-game-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const runtime = new BonsaiRuntime(root);
  runtime.start = async () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { bodies, engine: new BonsaiEngine({ root, runtime }) };
}

describe("a game's call on Bonsai", () => {
  it("sends the game's schema as structured output and does not think unless the door asks", async () => {
    const { bodies, engine } = await bonsai();
    const answer = await engine.complete(gameCall({ model: BONSAI, responseSchema: LOOSE_SCHEMA }));
    assert.equal(answer.message.content, '{"line":"Halt."}');
    assert.deepEqual(bodies, [
      {
        model: BONSAI,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: PROMPT },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 200,
        temperature: 1,
        top_p: 0.95,
        top_k: 20,
        min_p: 0,
        reasoning_budget_tokens: 0,
        response_format: {
          type: "json_schema",
          json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: false, schema: LOOSE_SCHEMA },
        },
      },
    ]);
  });

  it("thinks for the budget the door names", async () => {
    const { bodies, engine } = await bonsai();
    await engine.complete(gameCall({ model: BONSAI, effort: "medium" }));
    assert.equal((bodies[0] as { reasoning_budget_tokens: number }).reasoning_budget_tokens, 2048);
  });

  it("keeps a build's default thinking budget and sends it no response format", async () => {
    const { bodies, engine } = await bonsai();
    await engine.complete({ model: BONSAI, messages: [{ role: "user", content: "hi" }] });
    const body = bodies[0] as Record<string, unknown>;
    assert.equal(body.reasoning_budget_tokens, 512);
    assert.equal(body.response_format, undefined);
  });

  it("refuses a hostile call before the runtime is asked to generate", async () => {
    for (const { name, request } of HOSTILE_CALLS) {
      const { bodies, engine } = await bonsai();
      await assert.rejects(engine.complete({ ...request, model: BONSAI }), refused("bonsai"), name);
      assert.deepEqual(bodies, [], `${name}: nothing is sent`);
    }
  });
});

// ── OpenRouter ─────────────────────────────────────────────────────────────────────────────

const SONNET = "anthropic/claude-sonnet-4.5";
const GPT = "openai/gpt-6-luna";
const PLAIN = "vendor/no-structured";

/** Catalog rows: two models that take a JSON schema, one that does not. */
const GAME_CATALOG = [
  {
    id: SONNET,
    name: "Anthropic: Claude Sonnet 4.5",
    context_length: 200_000,
    supported_parameters: ["tools", "max_tokens", "response_format", "structured_outputs"],
    pricing: { prompt: "0.000003", completion: "0.000015" },
  },
  {
    id: GPT,
    name: "OpenAI: GPT-6 Luna",
    context_length: 128_000,
    supported_parameters: ["tools", "max_tokens", "response_format", "structured_outputs"],
    pricing: { prompt: "0.000001", completion: "0.000004" },
  },
  {
    id: PLAIN,
    name: "Vendor: Plain",
    context_length: 32_000,
    supported_parameters: ["tools", "max_tokens"],
    pricing: { prompt: "0", completion: "0" },
  },
];

async function openRouter(): Promise<{ server: FakeOpenRouter; engine: OpenRouterEngine }> {
  const server = await startFakeOpenRouter({
    models: GAME_CATALOG,
    replies: [{ text: '{"mood":"calm","line":"Hm."}' }],
  });
  closers.push(server.close);
  const root = await tmpDir("game-openrouter-");
  const engine = new OpenRouterEngine({
    root: path.join(root, "engine"),
    keys: memoryKeyStore(GOOD_KEY),
    baseUrl: server.baseUrl,
  });
  return { server, engine };
}

/** The provider routing every game call on OpenRouter pins. */
const GAME_PROVIDER = { allow_fallbacks: false, require_parameters: true, data_collection: "deny" };

describe("a game's call on OpenRouter", () => {
  it("pins the provider, holds the reply to the schema and caches only Anthropic's system prompt", async () => {
    const { server, engine } = await openRouter();
    await engine.complete(gameCall({ model: SONNET }));
    const [body] = chatBodies(server.requests) as Array<Record<string, unknown>>;
    assert.deepEqual(body?.provider, GAME_PROVIDER);
    assert.deepEqual(body?.response_format, {
      type: "json_schema",
      json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: true, schema: STRICT_SCHEMA },
    });
    assert.deepEqual(body?.messages, [
      { role: "system", content: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] },
      { role: "user", content: PROMPT },
    ]);
    assert.equal(body?.tools, undefined);
  });

  it("marks nothing for the cache on a model that is not Anthropic's", async () => {
    const { server, engine } = await openRouter();
    await engine.complete(gameCall({ model: GPT }));
    const [body] = chatBodies(server.requests) as Array<Record<string, unknown>>;
    assert.deepEqual(body?.provider, GAME_PROVIDER);
    assert.equal(JSON.stringify(body?.messages).includes("cache_control"), false);
  });

  it("sends no response format a model or its providers would refuse", async () => {
    const table = [
      { model: PLAIN, schema: STRICT_SCHEMA, why: "the model takes no JSON schema" },
      { model: GPT, schema: { type: "string" }, why: "a hosted provider's schema root must be an object" },
      { model: GPT, schema: { type: "array", items: { type: "string" } }, why: "an array root as well" },
    ];
    for (const row of table) {
      const { server, engine } = await openRouter();
      await engine.complete(gameCall({ model: row.model, responseSchema: row.schema }));
      const [body] = chatBodies(server.requests) as Array<Record<string, unknown>>;
      assert.equal(body?.response_format, undefined, row.why);
      assert.deepEqual(body?.provider, GAME_PROVIDER, `${row.why}: the routing still holds`);
    }
  });

  it("leaves a build's completion as it was: no routing, pi-ai's own cache marks", async () => {
    const { server, engine } = await openRouter();
    await engine.complete({ model: SONNET, systemPrompt: SYSTEM, messages: [{ role: "user", content: "hi" }] });
    const [body] = chatBodies(server.requests) as Array<Record<string, unknown>>;
    assert.equal(body?.provider, undefined);
    assert.equal(body?.response_format, undefined);
    const messages = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const user = messages[1];
    assert.deepEqual(user?.content, [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });

  it("refuses a hostile call before OpenRouter is asked to generate", async () => {
    for (const { name, request } of HOSTILE_CALLS) {
      const { server, engine } = await openRouter();
      await assert.rejects(engine.complete({ ...request, model: SONNET }), refused("openrouter"), name);
      assert.deepEqual(chatBodies(server.requests), [], `${name}: nothing is sent`);
    }
  });
});

// ── Claude Code ────────────────────────────────────────────────────────────────────────────

/** A Claude Code engine on a scripted CLI that records every session it is asked to open. */
async function claude() {
  const sessions: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const queryFn = ((params: { prompt: unknown; options: Record<string, unknown> }) => {
    sessions.push({ prompt: params.prompt, options: { ...params.options } });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", model: "claude-sonnet-5" };
        yield { type: "assistant", message: { content: [{ type: "text", text: '{"mood":"calm","line":"No."}' }] } };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: '{"mood":"calm","line":"No."}',
          usage: {},
        };
      },
    };
  }) as never;
  const root = await tmpDir("game-claude-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  const gameCwd = path.join(root, "game-calls");
  const judgeCwd = path.join(root, "judge");
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "none"),
    queryFn,
    judgeCwd,
    gameCwd,
  });
  return { engine, sessions, gameCwd, judgeCwd, home };
}

describe("a game's call on Claude Code", () => {
  it("is a plain one-turn session: the game's system prompt, no tools, no MCP, no settings, no transcript", async () => {
    const { engine, sessions, gameCwd, judgeCwd } = await claude();
    const answer = await engine.complete(gameCall());
    assert.equal(answer.message.content, '{"mood":"calm","line":"No."}');
    assert.equal(answer.model, "claude-sonnet-5");
    const [session] = sessions;
    assert.equal(session?.prompt, PROMPT, "the player's turn alone: the host's framing is the system prompt");
    const options = session?.options ?? {};
    assert.equal(options.systemPrompt, SYSTEM, "the game's own system prompt, not Claude Code's");
    assert.equal(options.cwd, gameCwd);
    assert.notEqual(options.cwd, judgeCwd, "a game's call never sits in the judge's folder");
    assert.equal((await stat(gameCwd)).isDirectory(), true);
    assert.deepEqual(await readdir(gameCwd), [], "nothing of a game or a home is in reach");
    assert.equal(options.maxTurns, 1);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.allowedTools, []);
    assert.deepEqual(options.skills, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.settings, { disableAllHooks: true });
    assert.equal(options.persistSession, false, "no transcript of a player's words is kept");
    assert.equal(options.resume, undefined);
    assert.equal(options.permissionMode, "default");
    assert.ok(Array.isArray(options.disallowedTools) && options.disallowedTools.includes("Bash"));
  });

  it("keeps a repair turn's earlier answer in the prompt, after the player's turn", async () => {
    const { engine, sessions } = await claude();
    await engine.complete(
      gameCall({
        messages: [
          { role: "user", content: PROMPT },
          { role: "assistant", content: '{"mood":' },
          { role: "user", content: "Your last answer was not JSON. Return only the corrected JSON." },
        ],
      }),
    );
    assert.equal(
      sessions[0]?.prompt,
      [PROMPT, '{"mood":', "Your last answer was not JSON. Return only the corrected JSON."].join("\n\n"),
    );
  });

  it("keeps the judge's framing for a verdict", async () => {
    const { engine, sessions, judgeCwd } = await claude();
    await engine.complete({ systemPrompt: "RUBRIC", messages: [{ role: "user", content: "is it lit?" }] });
    const options = sessions[0]?.options ?? {};
    assert.equal(options.cwd, judgeCwd);
    assert.equal(options.systemPrompt, undefined);
    assert.equal(sessions[0]?.prompt, "RUBRIC\n\nis it lit?");
  });

  it("refuses a hostile call before a session is opened", async () => {
    for (const { name, request } of HOSTILE_CALLS) {
      const { engine, sessions } = await claude();
      await assert.rejects(engine.complete(request), refused("claude-code"), name);
      assert.deepEqual(sessions, [], `${name}: no session`);
    }
  });
});

// ── Codex ──────────────────────────────────────────────────────────────────────────────────

describe("a game's call on Codex", () => {
  it("is refused as unavailable before anything runs: its shell cannot be removed", async () => {
    const root = await tmpDir("game-codex-");
    const home = path.join(root, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    const runs: unknown[] = [];
    const execFn: CodexExec = (invocation) => {
      runs.push(invocation);
      return { async *[Symbol.asyncIterator]() {} };
    };
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn,
    });
    const tmpBefore = await readdir(os.tmpdir());
    await assert.rejects(
      engine.complete(gameCall()),
      (err) => err instanceof EngineError && err.engine === "codex" && err.kind === EngineFailureKind.Unavailable,
    );
    assert.deepEqual(runs, [], "no CLI is started");
    const made = (await readdir(os.tmpdir())).filter(
      (name) => !tmpBefore.includes(name) && name.startsWith("studio-judge-"),
    );
    assert.deepEqual(made, [], "no judge folder is made");
  });
});
