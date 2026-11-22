/**
 * A real HTTP server speaking enough of OpenAI's chat-completions stream for a real coding CLI
 * (Pi, through a `models.json` provider; OpenCode 2.x, through a provider of its config) to run one
 * scripted turn with no account: nothing reaches a provider and nothing is billed.
 *
 * The script is one call, then done: a turn that offers tools gets one shell command (Pi's `bash`
 * tool, or the one a test names), and the request that carries that call's output gets a short
 * reply. A turn with no script, or one that offers no tools (OpenCode's session title, which
 * leaves the script for the turn after it), gets the reply at once. Every request is kept.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the fake says once the command has run, or when a turn has none to run. */
export const FAKE_CHAT_DONE_TEXT = "Done: the command ran.";
/** The provider a test's `models.json` names, and its one model. */
export const FAKE_CHAT_PROVIDER = "genex-fake";
export const FAKE_CHAT_MODEL = "probe";
const TOOL_CALL_ID = "call_probe";
/** The shell tool as Pi names it. */
const PI_SHELL_TOOL = "bash";

export interface FakeChat {
  /** The provider's base URL for a `models.json` entry. */
  baseUrl: string;
  /** Every chat request's body, oldest first. */
  requests: ChatBody[];
  /** The `authorization` header of every chat request: whose sign-in each went out on. */
  authorizations: () => string[];
  /** What the CLI sent back for the scripted command (its output, or why it did not run it). */
  commandOutput: () => string | null;
  /** Script the next turn: forget the last output and run `command`, or say the reply at once. */
  next: (command: string | null) => void;
  close: () => Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
}

export interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: unknown[];
}

/** One chat-completions stream of `deltas`, ending for `finish`, as server-sent events. */
function stream(res: ServerResponse, model: string, deltas: Array<Record<string, unknown>>, finish: string): void {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model, choices, ...extra })}\n\n`,
    );
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const delta of deltas) chunk([{ index: 0, delta, finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: finish }]);
  chunk([], { usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
  res.end("data: [DONE]\n\n");
}

/** A message's words, whether the CLI sent a string or content parts. */
function wordsOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("");
}

/** The loopback address the fake provider listens on unless a test names another. */
const LOOPBACK = "127.0.0.1";

/**
 * The fake provider, listening on loopback: on `host`, another address of this computer's own.
 * Its scripted command is a call of `shellTool`, the CLI's own name for its shell tool.
 */
export async function startFakeChat(host: string = LOOPBACK, shellTool: string = PI_SHELL_TOOL): Promise<FakeChat> {
  const requests: ChatBody[] = [];
  const headers: IncomingHttpHeaders[] = [];
  let command: string | null = null;
  let output: string | null = null;

  const answer = (body: ChatBody, res: ServerResponse): void => {
    const model = body.model ?? FAKE_CHAT_MODEL;
    const last = body.messages?.at(-1);
    if (last?.role === "tool") {
      output = wordsOf(last.content);
      stream(res, model, [{ role: "assistant", content: FAKE_CHAT_DONE_TEXT }], "stop");
      return;
    }
    const run = body.tools?.length ? command : null;
    if (run === null) {
      stream(res, model, [{ role: "assistant", content: FAKE_CHAT_DONE_TEXT }], "stop");
      return;
    }
    command = null;
    const call = {
      index: 0,
      id: TOOL_CALL_ID,
      type: "function",
      function: { name: shellTool, arguments: JSON.stringify({ command: run }) },
    };
    stream(res, model, [{ role: "assistant", content: null, tool_calls: [call] }], "tool_calls");
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"not found"}}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatBody;
      requests.push(body);
      headers.push(req.headers);
      answer(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://${host}:${port}/v1`,
    requests,
    authorizations: () => headers.map((sent) => String(sent.authorization ?? "")),
    commandOutput: () => output,
    next: (next) => {
      command = next;
      output = null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
