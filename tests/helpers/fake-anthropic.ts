/**
 * A real HTTP server speaking enough of Anthropic's Messages API for the real Claude Code CLI to
 * run one scripted worker turn: the CLI is pointed at it with `ANTHROPIC_BASE_URL` and a dummy
 * OAuth token, so nothing reaches an account and nothing is billed.
 *
 * The script is one shell command, then done. A request whose tools include the session's shell
 * (the studio's `run_command` where Genex's sandbox runs the commands, else Claude Code's own
 * `Bash`) and that has not yet seen that call's result gets the call; every other request (the
 * CLI's side requests: a title, a quota probe) gets a short text answer. Every request is kept, so
 * a check can say which shell the session was offered.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What a Claude worker's scripted command writes in its folder, and the command itself. */
export const CLAUDE_WORKER_PROOF = { file: "worker-proof.txt", text: "ok" } as const;
export const CLAUDE_WORKER_COMMAND = `printf ${CLAUDE_WORKER_PROOF.text} > ${CLAUDE_WORKER_PROOF.file}`;

/** The shells the script calls, preferred first. */
export const SCRIPTED_SHELLS = ["mcp__studio__run_command", "Bash"] as const;
/** The model the fake answers as, whatever was asked. */
const FAKE_MODEL = "claude-fake-1";
/** What the fake says once the command has run, and to every side request. */
const DONE_TEXT = "Done: the command ran.";
const SIDE_TEXT = "ok";

export interface FakeAnthropicOptions {
  /** The command the scripted turn runs. */
  command: string;
}

export interface FakeAnthropicRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeAnthropic {
  /** The base URL to hand the CLI as `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  requests: FakeAnthropicRequest[];
  /** The shell the scripted call went to, once it was made. */
  calledShell: () => string | null;
  /** What the CLI sent back for that call (its text), once it did. */
  shellResult: () => string | null;
  close: () => Promise<void>;
}

interface MessagesBody {
  stream?: boolean;
  tools?: Array<{ name?: string }>;
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** A content block of a reply, as the fake sends it. */
type ReplyBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

const SCRIPTED_CALL_ID = "toolu_fake_shell_1";

export async function startFakeAnthropic(options: FakeAnthropicOptions): Promise<FakeAnthropic> {
  const requests: FakeAnthropicRequest[] = [];
  let called: string | null = null;

  const reply = (body: MessagesBody): { blocks: ReplyBlock[]; stop: string } => {
    const offered = new Set((body.tools ?? []).map((tool) => tool.name));
    const shell = SCRIPTED_SHELLS.find((name) => offered.has(name));
    if (!shell) return { blocks: [{ type: "text", text: SIDE_TEXT }], stop: "end_turn" };
    if (sawResult(body)) return { blocks: [{ type: "text", text: DONE_TEXT }], stop: "end_turn" };
    called = shell;
    return {
      blocks: [{ type: "tool_use", id: SCRIPTED_CALL_ID, name: shell, input: { command: options.command } }],
      stop: "tool_use",
    };
  };

  /** The answer to one request: a token count, a scripted reply, or an empty answer to anything else. */
  const answer = (request: FakeAnthropicRequest): { json: unknown } | { stream: ReturnType<typeof reply> } => {
    const post = request.method === "POST";
    if (post && request.path.endsWith("/v1/messages/count_tokens")) return { json: { input_tokens: 10 } };
    // Anything else the CLI asks on the way (a profile, settings, a model list): an empty answer.
    if (!post || !request.path.endsWith("/v1/messages")) return { json: {} };
    const messages = (request.body ?? {}) as MessagesBody;
    const scripted = reply(messages);
    return messages.stream ? { stream: scripted } : { json: message(scripted.blocks, scripted.stop) };
  };

  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const request = { method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0] ?? "/", body: parse(raw) };
      requests.push(request);
      const answered = answer(request);
      if ("stream" in answered) stream(res, answered.stream.blocks, answered.stream.stop);
      else json(res, answered.json);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    calledShell: () => called,
    shellResult: () => resultText(requests),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A tool result block, as the CLI sends one back. */
type ResultBlock = { type?: string; tool_use_id?: string; content?: unknown };

/** The scripted call's result block in a conversation, or null when it has none yet. */
function scriptedResult(body: MessagesBody): ResultBlock | null {
  const blocks = (body.messages ?? []).flatMap((message) =>
    Array.isArray(message.content) ? (message.content as ResultBlock[]) : [],
  );
  return blocks.find((block) => block.type === "tool_result" && block.tool_use_id === SCRIPTED_CALL_ID) ?? null;
}

/** The scripted call's result as the CLI last sent it, its text blocks joined. */
function resultText(requests: readonly FakeAnthropicRequest[]): string | null {
  for (const request of [...requests].reverse()) {
    const block = scriptedResult((request.body ?? {}) as MessagesBody);
    if (!block) continue;
    if (typeof block.content === "string") return block.content;
    const parts = Array.isArray(block.content) ? (block.content as Array<{ text?: unknown }>) : [];
    return parts.map((part) => String(part.text ?? "")).join("\n");
  }
  return null;
}

/** Whether the conversation already holds the scripted call's result. */
function sawResult(body: MessagesBody): boolean {
  return scriptedResult(body) !== null;
}

function message(blocks: ReplyBlock[], stop: string) {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: FAKE_MODEL,
    content: blocks,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** The reply as the Messages API streams it: start, each block's start, delta and stop, then the end. */
function stream(res: ServerResponse, blocks: ReplyBlock[], stop: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { ...message([], ""), stop_reason: null } });
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      const start = { type: "tool_use", id: block.id, name: block.name, input: {} };
      send("content_block_start", { type: "content_block_start", index, content_block: start });
      const delta = { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
      send("content_block_delta", { type: "content_block_delta", index, delta });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  }
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function parse(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}
