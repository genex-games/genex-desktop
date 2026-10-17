/**
 * A real HTTP server speaking the parts of a local model server's API the local server engine
 * reads: the OpenAI-compatible model list and `chat/completions` SSE stream, plus each server's own
 * endpoints (TabbyAPI's service info and `/props`, llama.cpp's header and `/props`, LM Studio's
 * greeting and `/api/v1/models`, KoboldCpp's version, Ollama's root and `/api/show`). pi-ai does
 * real HTTP and SSE against it, so discovery, keys, streaming and failures are exercised for real,
 * with no network and no model. Field names follow each project's source.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type FakeReply, writeChatCompletion } from "./fake-ollama.ts";

/** Which server software the fake plays. */
export type FakeFlavor =
  | "generic"
  | "tabbyapi"
  | "llama.cpp"
  | "lm-studio"
  | "vllm"
  | "koboldcpp"
  | "ollama"
  /** macOS's AirPlay receiver on port 5000: a bare 403 to everything. */
  | "airplay";

/** A key this server accepts when it asks for one. */
export const SERVER_KEY = "tabby-0123456789abcdef0123456789abcdef";

/** A reply whose thinking arrives apart, as `reasoning_content`, then its answer. */
export type ReasonedReply = { reasoning: string; text: string };

export interface FakeLocalServerOptions {
  flavor?: FakeFlavor;
  /** Keys it accepts; with none it asks for no key. */
  keys?: string[];
  /** The model list's `data`; each flavor has its own default. */
  models?: unknown[];
  /** `/props`: its runtime context, vision and tool calling, for the flavors that have it. */
  props?: { nCtx?: number; vision?: boolean; tools?: boolean };
  replies?: Array<FakeReply | ReasonedReply>;
  /** Stop the whole server when a reply is cut: the server died mid-reply, not just the connection. */
  stopOnCut?: boolean;
}

export interface FakeLocalServer {
  /** The API's base URL (`http://127.0.0.1:<port>/v1`). */
  url: string;
  port: number;
  requests: Array<{ method: string; path: string; body: unknown; authorization?: string; apiKey?: string }>;
  close: () => Promise<void>;
}

/** The model a fake lists by default. */
export const FAKE_MODEL = "Qwen3.8-27B-exl3";

/** Each flavor's model list, in its own spelling. */
function defaultModels(flavor: FakeFlavor): unknown[] {
  const created = 1_760_000_000;
  switch (flavor) {
    case "tabbyapi":
      return [
        {
          id: FAKE_MODEL,
          object: "model",
          created,
          owned_by: "tabbyAPI",
          meta: { n_ctx_train: 262_144, n_ctx: 131_072, n_vocab: 151_936 },
        },
      ];
    case "llama.cpp":
      return [
        {
          id: "qwen3.8-27b-q4_k_m.gguf",
          object: "model",
          created,
          owned_by: "llamacpp",
          meta: { n_ctx: 65_536, n_ctx_train: 262_144 },
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        },
      ];
    case "lm-studio":
      return [
        { id: "qwen/qwen3.8-27b", object: "model", owned_by: "organization_owner" },
        { id: "text-embedding-nomic-embed-text-v1.5", object: "model", owned_by: "organization_owner" },
      ];
    case "vllm":
      return [
        { id: "Qwen/Qwen3.8-27B", object: "model", owned_by: "vllm", max_model_len: 40_960, root: "Qwen/Qwen3.8-27B" },
      ];
    case "koboldcpp":
      return [{ id: "koboldcpp/Qwen3.8-27B", object: "model", owned_by: "koboldcpp" }];
    case "ollama":
      return [{ id: "qwen3.8:27b", object: "model", created, owned_by: "library" }];
    default:
      return [{ id: "my-model", object: "model", owned_by: "me" }];
  }
}

/** LM Studio 0.4's own model list for the default models. */
const LM_STUDIO_MODELS = {
  models: [
    {
      type: "llm",
      key: "qwen/qwen3.8-27b",
      display_name: "Qwen3.8 27B",
      max_context_length: 262_144,
      loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 32_768 } }],
      capabilities: { vision: true, trained_for_tool_use: true },
    },
    { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5", display_name: "Nomic Embed" },
  ],
};

/** The server's key as a request carries it: TabbyAPI and llama.cpp read either header. */
function givenKey(req: IncomingMessage): string {
  const bearer = req.headers.authorization?.replace(/^Bearer /, "");
  const header = req.headers["x-api-key"];
  return bearer || (typeof header === "string" ? header : "");
}

function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

/** One reasoned reply on the SSE stream: its thinking as `reasoning_content`, then its answer. */
function writeReasoned(res: ServerResponse, body: unknown, reply: ReasonedReply): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: (body as { model?: string })?.model,
  };
  const send = (delta: unknown, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  send({ role: "assistant" });
  send({ reasoning_content: reply.reasoning });
  send({ content: reply.text });
  send({}, "stop");
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

/** The endpoints a flavor answers without a key: its signature. Null when the path is not one. */
function signature(flavor: FakeFlavor, path: string): { status: number; body: unknown; text?: string } | null {
  if (flavor === "tabbyapi" && path === "/.well-known/serviceinfo")
    return { status: 200, body: { software: { name: "TabbyAPI", version: "1.0" } } };
  if (flavor === "koboldcpp" && path === "/api/extra/version")
    return { status: 200, body: { result: "KoboldCpp", version: "1.122.1", vision: false } };
  if (flavor === "lm-studio" && path === "/lmstudio-greeting") return { status: 200, body: { lmstudio: true } };
  if (flavor === "ollama" && path === "/") return { status: 200, body: null, text: "Ollama is running" };
  return null;
}

/** `/props` as llama.cpp, TabbyAPI and KoboldCpp answer it. */
function props(options: FakeLocalServerOptions): unknown {
  const given = options.props ?? {};
  return {
    default_generation_settings: { n_ctx: given.nCtx ?? 65_536 },
    modalities: { vision: given.vision ?? false, audio: false },
    ...(given.tools === undefined ? {} : { chat_template_caps: { supports_tools: given.tools } }),
    total_slots: 1,
  };
}

const PROPS_FLAVORS: ReadonlySet<FakeFlavor> = new Set(["llama.cpp", "tabbyapi", "koboldcpp"]);

/** The request's body: JSON when it parses, its text when it does not. */
function bodyOf(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

/** A server's own endpoint that wants its key: the model list, `/props`, LM Studio's and Ollama's lists. */
function ownEndpoint(flavor: FakeFlavor, path: string, options: FakeLocalServerOptions): unknown {
  if (path === "/v1/models") return { object: "list", data: options.models ?? defaultModels(flavor) };
  if (path === "/props" && PROPS_FLAVORS.has(flavor)) return props(options);
  if (path === "/api/v1/models" && flavor === "lm-studio") return LM_STUDIO_MODELS;
  if (path === "/api/show" && flavor === "ollama")
    return { capabilities: ["completion", "tools", "vision"], model_info: { "qwen3.context_length": 262_144 } };
  if (path === "/api/ps" && flavor === "ollama")
    return { models: [{ name: "qwen3.8:27b", context_length: 16_384, size_vram: 1, expires_at: "" }] };
  return undefined;
}

/** Answer an endpoint any client may ask without a key; false when the path is not one. */
function answerOpen(flavor: FakeFlavor, path: string, res: ServerResponse, headers: Record<string, string>): boolean {
  if (flavor === "airplay") {
    res.writeHead(403, { server: "AirTunes/870.14.1" });
    res.end();
    return true;
  }
  const sign = signature(flavor, path);
  if (!sign) return false;
  if (sign.text === undefined) {
    json(res, sign.body, sign.status, headers);
    return true;
  }
  res.writeHead(sign.status, { "content-type": "text/plain" });
  res.end(sign.text);
  return true;
}

export async function startFakeLocalServer(options: FakeLocalServerOptions = {}): Promise<FakeLocalServer> {
  const flavor = options.flavor ?? "generic";
  const replies = [...(options.replies ?? [])];
  const requests: FakeLocalServer["requests"] = [];
  const headers: Record<string, string> = flavor === "llama.cpp" ? { server: "llama.cpp" } : {};
  /** One chat completion: the next scripted reply, and the whole server stopped after a cut when asked. */
  const complete = (res: ServerResponse, body: unknown): void => {
    const reply = replies.shift() ?? { text: "ok" };
    if ("reasoning" in reply) {
      writeReasoned(res, body, reply);
      return;
    }
    writeChatCompletion(res, body, reply);
    if ("cutAfter" in reply && options.stopOnCut) {
      server.close();
      server.closeAllConnections?.();
    }
  };
  const answer = (req: IncomingMessage, res: ServerResponse, body: unknown): void => {
    const path = req.url ?? "/";
    const apiKey = req.headers["x-api-key"];
    requests.push({
      method: req.method ?? "GET",
      path,
      body,
      authorization: req.headers.authorization,
      ...(typeof apiKey === "string" ? { apiKey } : {}),
    });
    if (answerOpen(flavor, path, res, headers)) return;
    const keys = options.keys ?? [];
    const own = ownEndpoint(flavor, path, options);
    if (keys.length > 0 && !keys.includes(givenKey(req)))
      json(res, { detail: "Please provide an API key" }, 401, headers);
    else if (path === "/v1/chat/completions") complete(res, body);
    else if (own === undefined) json(res, { error: `unhandled ${path}` }, 404, headers);
    else json(res, own, 200, headers);
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => answer(req, res, bodyOf(Buffer.concat(chunks).toString("utf8"))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
