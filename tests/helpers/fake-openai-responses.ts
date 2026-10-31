/**
 * A real HTTP server speaking enough of OpenAI's Responses API for the real Codex CLI to run one
 * scripted turn: the CLI is pointed at it as a custom model provider (`codexProviderArgs`), with
 * no sign-in, so nothing reaches an account and nothing is billed.
 *
 * The script is one shell command, then done. The first request gets a call to whichever shell
 * the session was offered (`exec_command`, `shell_command` or `shell`); a request that carries
 * that call's output gets a short reply. Every request is kept, so a check can read what Codex
 * sent back for the command: its output, or why it refused to run it. The call can ask to run
 * outside the sandbox (`escalated`), which a session in `on-request` approvals asks its client
 * about. `startFakeAnswer` is the plainer fake of a one-shot call that only answers.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The model id the CLI is told to use; the fake answers as it, whatever was asked. */
export const FAKE_MODEL = "fake-model";
/** The provider id the CLI is told to use. */
const FAKE_PROVIDER = "genex_fake";
/** What the fake says once the command has run. */
const DONE_TEXT = "Done: the command ran.";
/** Each scripted call's id: this and its number in the fake's life (the first is `call_fake_shell_1`). */
const SCRIPTED_CALL_PREFIX = "call_fake_shell_";

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
  input?: Array<{ type?: string; role?: string; call_id?: string; output?: unknown }>;
}

/** The `-c` flags that point `codex exec` at the fake instead of OpenAI, and its model. */
export function codexProviderArgs(fake: FakeResponses): string[] {
  return [...codexProviderConfig(fake), "-m", FAKE_MODEL];
}

/**
 * The `-c` flags alone, for a launch that names the model elsewhere: the app server (its thread's
 * `model`), or an argv the engine built with the session's model already on it ({@link FAKE_MODEL}).
 */
export function codexProviderConfig(fake: FakeResponses): string[] {
  const provider = `{name="${FAKE_PROVIDER}",base_url="${fake.baseUrl}",wire_api="responses"}`;
  return ["-c", `model_provider="${FAKE_PROVIDER}"`, "-c", `model_providers.${FAKE_PROVIDER}=${provider}`];
}

/**
 * What the scripted call asks beyond the command: to run outside the sandbox, with the model's own
 * reason (`sandbox_permissions: "require_escalated"`), which is what a session in Codex's
 * `on-request` approvals asks its client to approve.
 */
export interface ScriptedCallOptions {
  escalated?: { justification: string };
}

/** The scripted call for the shell the session was offered: a string command, or argv. */
function shellCall(
  offered: Set<string | undefined>,
  command: readonly string[],
  options: ScriptedCallOptions,
): { name: string; args: unknown } {
  const line = command.join(" ");
  const escalation = options.escalated
    ? { sandbox_permissions: "require_escalated", justification: options.escalated.justification }
    : {};
  if (offered.has("exec_command")) return { name: "exec_command", args: { cmd: line, ...escalation } };
  if (offered.has("shell_command")) return { name: "shell_command", args: { command: line, ...escalation } };
  return { name: "shell", args: { command, ...escalation } };
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

/**
 * The output of this turn's scripted call, if Codex sent it: one after the fake's last reply (a turn
 * ends with one), whatever else came with it (a message steered into the turn).
 */
function turnOutput(input: ResponsesBody["input"]): { output?: unknown } | undefined {
  const items = input ?? [];
  const lastReply = items.findLastIndex((item) => item.type === "message" && item.role === "assistant");
  return items
    .slice(lastReply + 1)
    .findLast((item) => item.type === "function_call_output" && item.call_id?.startsWith(SCRIPTED_CALL_PREFIX));
}

/** An assistant message saying `text`. */
function message(id: string, text: string): unknown {
  return { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] };
}

/**
 * A fake whose scripted turn runs `command` (program and arguments). Each turn is scripted alike: a
 * request with no output of its turn's call yet (a new turn, a resumed session's included) gets a
 * call with an id of its own, and the one carrying its output gets the reply.
 */
export async function startFakeResponses(
  command: readonly string[],
  options: ScriptedCallOptions = {},
): Promise<FakeResponses> {
  let called: string | null = null;
  let output: string | null = null;
  let calls = 0;

  const reply = (body: ResponsesBody): unknown => {
    const answered = turnOutput(body.input);
    if (answered) {
      output = typeof answered.output === "string" ? answered.output : JSON.stringify(answered.output);
      return message(`msg_fake_${calls}`, DONE_TEXT);
    }
    const call = shellCall(new Set((body.tools ?? []).map((tool) => tool.name)), command, options);
    called = call.name;
    calls += 1;
    const callId = `${SCRIPTED_CALL_PREFIX}${calls}`;
    return { type: "function_call", call_id: callId, name: call.name, arguments: JSON.stringify(call.args) };
  };
  return serve(reply, {
    calledShell: () => called,
    commandOutput: () => output,
  });
}

/**
 * A fake whose every turn is one reply, `text`, and nothing else: the answer of a one-shot call
 * (`codex exec --ephemeral`), such as the Auto check's verdict.
 */
export async function startFakeAnswer(text: string): Promise<FakeResponses> {
  let answers = 0;
  return serve(
    () => {
      answers += 1;
      return message(`msg_answer_${answers}`, text);
    },
    { calledShell: () => null, commandOutput: () => null },
  );
}

/** The fake's server: each Responses request answered with `reply`'s one item, every request kept. */
async function serve(
  reply: (body: ResponsesBody) => unknown,
  reads: Pick<FakeResponses, "calledShell" | "commandOutput">,
): Promise<FakeResponses> {
  const requests: unknown[] = [];
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
    ...reads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
