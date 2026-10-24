/**
 * A real HTTP server speaking enough of xAI's Responses API, as Grok Build 1.0.70 streams it, for
 * the real Grok Build CLI to run one scripted turn with no account: the CLI is pointed at it as
 * Grok's own session service (`GROK_CLI_CHAT_PROXY_BASE_URL`), signed in with a made-up token
 * (`fakeGrokSignIn`), so nothing reaches xAI and nothing is billed.
 *
 * The script is one shell command, then done. The first turn request gets a call to Grok's shell
 * (`run_terminal_command`); a request that carries that call's output gets a short reply. Grok's
 * side requests (a session title, a status line) get a few words. Every request is kept.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the fake says once the command has run. */
export const FAKE_DONE_TEXT = "Done: the command ran.";
/** The words a side request (a title, a status line) gets. */
const SIDE_TEXT = "Fake title";
/** The system words of Grok's side requests, which are no turn of the session. */
const SIDE_REQUEST = /session title|dashboard line/;

export interface FakeXai {
  /** Grok's session service at the fake (`GROK_CLI_CHAT_PROXY_BASE_URL`). */
  proxyUrl: string;
  requests: unknown[];
  /** What Grok sent back for the scripted command (its output, or why it did not run it), once it did. */
  commandOutput: () => string | null;
  /** Script the next turns: forget the last output, and run `command` instead. */
  next: (command: string) => void;
  close: () => Promise<void>;
}

interface ResponsesBody {
  model?: string;
  input?: Array<{ type?: string; role?: string; content?: unknown; output?: unknown }>;
}

/** One Responses stream of `items`, as server-sent events. */
function stream(res: ServerResponse, model: string, items: Array<Record<string, unknown>>): void {
  let sequence = 0;
  const send = (type: string, data: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const response = {
    id: "resp_fake",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "in_progress",
    output: [] as unknown[],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("response.created", { response });
  items.forEach((item, output_index) => {
    send("response.output_item.added", { output_index, item: { ...item, status: "in_progress" } });
    send("response.output_item.done", { output_index, item: { ...item, status: "completed" } });
  });
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  };
  const output = items.map((item) => ({ ...item, status: "completed" }));
  send("response.completed", { response: { ...response, status: "completed", output, usage } });
  res.end();
}

const message = (text: string) => ({
  type: "message",
  id: "msg_fake",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

/** A fake whose scripted turn runs `command` in Grok's shell. */
export async function startFakeXai(first: string): Promise<FakeXai> {
  const requests: unknown[] = [];
  let output: string | null = null;
  let command = first;
  const reply = (body: ResponsesBody): Array<Record<string, unknown>> => {
    const system = body.input?.find((item) => item.role === "system")?.content;
    if (SIDE_REQUEST.test(typeof system === "string" ? system : "")) return [message(SIDE_TEXT)];
    const result = body.input?.find((item) => item.type === "function_call_output");
    if (result) {
      output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return [message(FAKE_DONE_TEXT)];
    }
    const args = JSON.stringify({ command, description: "Run the probe" });
    return [
      { type: "function_call", id: "fc_fake", call_id: "call_fake_1", name: "run_terminal_command", arguments: args },
    ];
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as ResponsesBody) : {};
    requests.push(body);
    if (req.method === "POST" && req.url?.endsWith("/responses")) return stream(res, body.model ?? "grok", reply(body));
    // Anything else Grok asks on the way (models, settings, the account): an empty answer.
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    proxyUrl: `http://127.0.0.1:${port}/proxy/v1`,
    requests,
    commandOutput: () => output,
    next: (scripted) => {
      output = null;
      command = scripted;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
