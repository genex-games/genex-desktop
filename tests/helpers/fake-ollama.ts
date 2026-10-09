/**
 * A real HTTP server speaking Ollama's management API and the OpenAI-compatible
 * `/v1/chat/completions` SSE stream.
 *
 * This is not a stub of our own code: pi-ai does real HTTP, real SSE parsing and real tool-call
 * assembly against it, so the engine wiring (provider config, message conversion, streaming,
 * tool calls, usage) is genuinely exercised. What it cannot tell us is whether a given *model*
 * is any good — that is what the live check against the user's Ollama is for.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeReply =
  | { text: string; usage?: { prompt: number; completion: number } }
  | { toolCalls: Array<{ id: string; name: string; arguments: unknown }>; text?: string }
  | { httpStatus: number; body: string }
  /** Send a few deltas, then destroy the socket — an Ollama that died mid-generation. */
  | { cutAfter: string }
  /** Send one delta, then hold the stream open forever — a model deep in a silent generation. */
  | { hangAfter: string }
  /** Accept the request but never answer, not even headers — prompt eval that never ends. */
  | { stall: true };

export function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const record = part as { type?: string; text?: string };
        if (record.type === "text") return record.text ?? "";
        if (record.type === "image_url" || record.type === "image") return "[image]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function countImages(messages: Array<{ content?: unknown }> | undefined): number {
  let n = 0;
  for (const message of messages ?? []) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "image_url") n++;
      if (part && typeof part === "object" && (part as { type?: string }).type === "image") n++;
    }
  }
  return n;
}

type FixtureImage = { data: string; label?: string };
type FixtureJudgeRequest = { messages: Array<{ content: string; images?: readonly FixtureImage[] }> };

/** Pick authored smoke-game state in a real screenshot run without exposing incumbent identity. */
export function stateFixtureBuild(request: FixtureJudgeRequest): "A" | "B" {
  const text = request.messages.map((message) => message.content).join("\n");
  const [, a = "", b = ""] = text.split(/\nBUILD [AB]\n/);
  const revision = (body: string) =>
    Math.max(0, ...[...body.matchAll(/"smokeRevision"\s*:\s*(\d+)/g)].map((match) => Number(match[1])));
  const left = revision(a);
  const right = revision(b);
  if (left === right) throw new Error("No distinct authored smoke state for the blind judge");
  return left > right ? "A" : "B";
}

/** Pick the newer synthetic capture by its embedded counter, never by leaked build history. */
export function newestFixtureBuild(request: FixtureJudgeRequest): "A" | "B" {
  const counters = { A: 0, B: 0 };
  for (const message of request.messages) {
    for (const image of message.images ?? []) {
      const side = /^BUILD ([AB])\b/.exec(image.label ?? "")?.[1];
      const bytes = Buffer.from(image.data, "base64");
      if ((side !== "A" && side !== "B") || bytes.length < 7 || bytes.readUIntBE(0, 3) !== 0xffd8ff) continue;
      counters[side] = Math.max(counters[side], bytes.readUInt32BE(3));
    }
  }
  if (counters.A === counters.B) throw new Error("No distinct fixture captures for the blind judge");
  return counters.A > counters.B ? "A" : "B";
}

export interface FakeOllamaOptions {
  version?: string;
  models?: Array<{ name: string; size: number; capabilities?: string[]; contextLength?: number }>;
  loaded?: Array<{ name: string; context_length?: number; size_vram?: number; expires_at?: string }>;
  /** Queue of scripted replies; each completion request consumes one. */
  replies?: FakeReply[];
  /**
   * Content-aware responder, consulted before the queue. Needed to script a *blind* judge: the
   * candidates are shuffled, so a fixed answer cannot express "pick the challenger" — the
   * responder has to read the prompt and answer accordingly, exactly like a real judge would.
   */
  respond?: (request: {
    messages: Array<{ role: string; content: string; images?: FixtureImage[] }>;
    tools?: unknown[];
  }) => FakeReply | null;
}

export interface FakeOllama {
  host: string;
  close: () => Promise<void>;
  requests: Array<{ path: string; body: unknown; headers: Record<string, string | string[] | undefined> }>;
  pushReply: (reply: NonNullable<FakeOllamaOptions["replies"]>[number]) => void;
}

export async function startFakeOllama(options: FakeOllamaOptions = {}): Promise<FakeOllama> {
  const version = options.version ?? "0.32.14";
  const models = [
    ...(options.models ?? [
      {
        name: "qwen3.6:27b",
        size: 17_000_000_000,
        capabilities: ["completion", "tools", "vision"],
        contextLength: 262144,
      },
    ]),
  ];
  const replies = [...(options.replies ?? [])];
  const requests: FakeOllama["requests"] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const url = req.url ?? "/";
      requests.push({ path: url, body, headers: req.headers });

      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      if (url === "/api/version") return json({ version });
      if (url === "/api/tags") {
        return json({ models: models.map((m) => ({ name: m.name, size: m.size, digest: "sha256:fake" })) });
      }
      if (url === "/api/ps") return json({ models: options.loaded ?? [] });
      if (url === "/api/show") {
        const name = (body as { model?: string } | null)?.model ?? "";
        const model = models.find((m) => m.name === name);
        if (!model) return json({ error: "model not found" }, 404);
        return json({
          capabilities: model.capabilities ?? ["completion"],
          model_info: { "qwen3.general.context_length": model.contextLength ?? 8192 },
        });
      }
      if (url === "/api/pull") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
        res.write(`${JSON.stringify({ status: "downloading", digest: "sha256:fake", total: 100, completed: 40 })}\n`);
        res.write(`${JSON.stringify({ status: "downloading", digest: "sha256:fake", total: 100, completed: 100 })}\n`);
        res.write(`${JSON.stringify({ status: "success" })}\n`);
        return res.end();
      }
      if (url === "/api/delete") {
        const name = (body as { model?: string } | null)?.model ?? "";
        const index = models.findIndex((m) => m.name === name);
        if (index < 0) return json({ error: `model '${name}' not found` }, 404);
        models.splice(index, 1);
        return json({ status: "ok" });
      }

      if (url.startsWith("/v1/chat/completions")) {
        const scripted = options.respond?.(
          flattenRequest(body as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }),
        );
        return writeChatCompletion(res, body, scripted ?? replies.shift() ?? { text: "ok" });
      }

      json({ error: `unhandled ${url}` }, 404);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    pushReply: (reply) => replies.push(reply),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * One scripted reply on the OpenAI-compatible `chat/completions` SSE stream, as Ollama and OpenRouter
 * both send it: text in pieces or tool calls, then usage, then `[DONE]`; or a failure, a cut or a stall.
 */
export function writeChatCompletion(res: ServerResponse, body: unknown, reply: FakeReply): void {
  if ("stall" in reply) return; // no headers, no body — only the client's own clock ends this
  if ("httpStatus" in reply) {
    res.writeHead(reply.httpStatus, { "content-type": "application/json" });
    res.end(reply.body);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const base = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: (body as { model?: string } | null)?.model ?? "fake",
  };
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  if ("cutAfter" in reply) {
    send({ ...base, choices: [{ index: 0, delta: { content: reply.cutAfter }, finish_reason: null }] });
    res.destroy();
    return;
  }
  if ("hangAfter" in reply) {
    // One delta, then silence with the connection held open — the shape of a local model
    // generating a huge tool call. Only a client abort (or server close) ends it.
    send({ ...base, choices: [{ index: 0, delta: { content: reply.hangAfter }, finish_reason: null }] });
    return;
  }
  if ("toolCalls" in reply) {
    if (reply.text) {
      send({ ...base, choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] });
    }
    reply.toolCalls.forEach((call, index) => {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    // Deltas arrive in pieces, like a real stream.
    for (const piece of chunkText(reply.text, 7)) {
      send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  send({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: "usage" in reply ? (reply.usage?.prompt ?? 11) : 11,
      completion_tokens: "usage" in reply ? (reply.usage?.completion ?? 5) : 5,
      total_tokens: 16,
    },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

function flattenRequest(body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }): {
  messages: Array<{ role: string; content: string; images?: FixtureImage[] }>;
  tools?: unknown[];
} {
  return {
    messages: (body.messages ?? []).map((message) => ({
      role: message.role,
      content: flattenMessageContent(message.content),
      images: fixtureImages(message.content),
    })),
    ...(body.tools ? { tools: body.tools } : {}),
  };
}

/** Preserve actual attached image bytes and their ordered prompt labels for scripted vision. */
function fixtureImages(content: unknown): FixtureImage[] {
  if (!Array.isArray(content)) return [];
  const text = flattenMessageContent(content);
  const labels = /IMAGES ATTACHED \(\d+\): ([^\n]+?)\. Look/.exec(text)?.[1]?.split("; ") ?? [];
  const images: FixtureImage[] = [];
  for (const part of content) {
    if (part?.type !== "image_url" || typeof part.image_url?.url !== "string") continue;
    const data = /^data:[^;]+;base64,(.*)$/.exec(part.image_url.url)?.[1];
    if (data) images.push({ data, label: labels[images.length] });
  }
  return images;
}
