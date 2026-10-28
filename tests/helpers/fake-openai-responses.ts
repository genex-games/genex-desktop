/**
 * A real HTTP server speaking enough of OpenAI's Responses API for the real Codex CLI to run one
 * scripted turn: the CLI is pointed at it as a custom model provider (`codexProviderArgs`), with
 * no sign-in, so nothing reaches an account and nothing is billed.
 *
 * The script is one shell command, then done. The first request gets a call to whichever shell
 * the session was offered (`exec_command`, `shell_command` or `shell`); a request that carries
 * that call's output gets a short reply. Every request is kept, so a check can read what Codex
 * sent back for the command: its output, or why it refused to run it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The model id the CLI is told to use; the fake answers as it, whatever was asked. */
const FAKE_MODEL = "fake-model";
/** The provider id the CLI is told to use. */
const FAKE_PROVIDER = "genex_fake";
/** What the fake says once the command has run. */
const DONE_TEXT = "Done: the command ran.";
const SCRIPTED_CALL_ID = "call_fake_shell_1";

export interface FakeResponses {
  /** The base URL of the fake's API, as a Codex provider's `base_url`. */
  baseUrl: string;
  requests: unknown[];
  /** The shell the scripted call went to, once it was made. */
  calledShell: () => string | null;
  /** What Codex sent back for that call (the command's output, or its refusal), once it did. */
  commandOutput: () => string | null;
  close: () => Promise<void>;
}

interface ResponsesBody {
  tools?: Array<{ name?: string }>;
  input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
}

/** The `-c` flags that point `codex exec` at the fake instead of OpenAI. */
export function codexProviderArgs(fake: FakeResponses): string[] {
  const provider = `{name="${FAKE_PROVIDER}",base_url="${fake.baseUrl}",wire_api="responses"}`;
  return [
    "-c",
    `model_provider="${FAKE_PROVIDER}"`,
    "-c",
    `model_providers.${FAKE_PROVIDER}=${provider}`,
    "-m",
    FAKE_MODEL,
  ];
}

/** The scripted call for the shell the session was offered: a string command, or argv. */
function shellCall(offered: Set<string | undefined>, command: readonly string[]): { name: string; args: unknown } {
  const line = command.join(" ");
  if (offered.has("exec_command")) return { name: "exec_command", args: { cmd: line } };
  if (offered.has("shell_command")) return { name: "shell_command", args: { command: line } };
  return { name: "shell", args: { command } };
}

/** One Responses stream, as server-sent events. */
function stream(item: unknown): string {
  const events = [
    { type: "response.created", response: { id: "resp_fake" } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: "resp_fake",
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** A fake whose scripted turn runs `command` (program and arguments). */
export async function startFakeResponses(command: readonly string[]): Promise<FakeResponses> {
  const requests: unknown[] = [];
  let called: string | null = null;
  let output: string | null = null;

  const reply = (body: ResponsesBody): unknown => {
    const result = body.input?.find(
      (item) => item.type === "function_call_output" && item.call_id === SCRIPTED_CALL_ID,
    );
    if (result) {
      output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return {
        type: "message",
        role: "assistant",
        id: "msg_fake",
        content: [{ type: "output_text", text: DONE_TEXT }],
      };
    }
    const call = shellCall(new Set((body.tools ?? []).map((tool) => tool.name)), command);
    called = call.name;
    return { type: "function_call", call_id: SCRIPTED_CALL_ID, name: call.name, arguments: JSON.stringify(call.args) };
  };

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as ResponsesBody) : {};
    requests.push(body);
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      // Anything else the CLI asks on the way (a model list): an empty answer.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [], data: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(stream(reply(body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    calledShell: () => called,
    commandOutput: () => output,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
