/**
 * A real HTTP server speaking the part of OpenRouter's API the engine uses: the public model list,
 * the key check and the OpenAI-compatible `chat/completions` SSE stream. pi-ai does real HTTP and
 * SSE against it, so the engine's provider wiring, key handling and failure mapping are exercised
 * for real, with no network and no account.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type FakeReply, writeChatCompletion } from "./fake-ollama.ts";

/** A key this server accepts. */
export const GOOD_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

export interface FakeOpenRouterOptions {
  /** The catalog's `data`. */
  models?: unknown[];
  /** Replace the whole `/models` answer: a status and a raw body. */
  catalog?: { status: number; body: string };
  /** Keys `/key` accepts; any other is refused with 401. */
  keys?: string[];
  /** The status `/key` answers for an accepted key (an outage: 503). */
  keyStatus?: number;
  replies?: FakeReply[];
}

export interface FakeOpenRouter {
  baseUrl: string;
  requests: Array<{ path: string; body: unknown; authorization: string | undefined }>;
  close: () => Promise<void>;
}

/** Two tool-calling models (one sees, one thinks), and one that cannot call tools. */
export const CATALOG = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    context_length: 200_000,
    supported_parameters: ["tools", "tool_choice", "reasoning", "max_tokens"],
    architecture: { input_modalities: ["text", "image"] },
    top_provider: { max_completion_tokens: 64_000 },
    pricing: { prompt: "0.000003", completion: "0.000015" },
  },
  {
    id: "qwen/qwen3-coder",
    name: "Qwen: Qwen3 Coder",
    context_length: 40_000,
    supported_parameters: ["tools", "max_tokens"],
    architecture: { input_modalities: ["text"] },
    top_provider: { max_completion_tokens: null },
    pricing: { prompt: "0", completion: "0" },
  },
  {
    id: "some/chat-only",
    name: "Chat only",
    context_length: 8_192,
    supported_parameters: ["max_tokens"],
    architecture: { input_modalities: ["text"] },
    pricing: { prompt: "0.000001", completion: "0.000001" },
  },
];

export async function startFakeOpenRouter(options: FakeOpenRouterOptions = {}): Promise<FakeOpenRouter> {
  const keys = options.keys ?? [GOOD_KEY];
  const replies = [...(options.replies ?? [])];
  const requests: FakeOpenRouter["requests"] = [];
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
      requests.push({ path: url, body, authorization: req.headers.authorization });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const keyGiven = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const accepted = keys.includes(keyGiven);
      if (url === "/api/v1/models") {
        if (options.catalog) {
          res.writeHead(options.catalog.status, { "content-type": "application/json" });
          return res.end(options.catalog.body);
        }
        return json({ data: options.models ?? CATALOG });
      }
      if (url === "/api/v1/key") {
        if (!accepted) return json({ error: { message: "No auth credentials found", code: 401 } }, 401);
        return json({ data: { label: "sk-or-v1-012...def", usage: 0.5, limit: null } }, options.keyStatus ?? 200);
      }
      if (url.startsWith("/api/v1/chat/completions")) {
        if (!accepted) return json({ error: { message: "No auth credentials found", code: 401 } }, 401);
        return writeChatCompletion(res, body, replies.shift() ?? { text: "ok" });
      }
      json({ error: `unhandled ${url}` }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
