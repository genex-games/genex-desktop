/**
 * Codex turns on the app server, with the studio's tools as Codex dynamic tools.
 *
 * The CLI is injected (`appServerFn`, `execFn`), so what is asserted is the studio's half of the
 * experimental `dynamicTools` contract of CLI 0.159's app server: the handshake that opts into
 * the experimental API, the thread it starts (tools, sandbox, approvals), each `item/tool/call`
 * answered with the tool's own picture inline, the notifications read as the same log events
 * the `codex exec` path writes, and every way the turn falls back to `codex exec` and the file
 * bridge: off by default, an older CLI, a server that refuses the tools.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { pathExists } from "../../src/substrate/fsx.ts";
import type { CodexAppServer, CodexAppServerConnection } from "../../src/substrate/engines/codex-app-server.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import {
  CODEX_DYNAMIC_TOOLS_MIN_VERSION,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  ToolCallRefusal,
  dynamicToolResponse,
  dynamicToolSpecs,
  meetsMinimumVersion,
  parseDynamicToolCall,
} from "../../src/substrate/engines/codex-dynamic-tools.ts";
import { BRIDGE_DIR } from "../../src/substrate/engines/studio-bridge.ts";
import type { DelegateRequest, LiveToolResult, LiveToolSpec } from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

const THREAD = "019a-thread";
const TURN = "019a-turn";
/** A one-pixel PNG, base64: what a screenshot answers with. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const COMPUTER: LiveToolSpec = {
  name: "computer",
  description: "Look at and drive the build's window.",
  parameters: {
    type: "object",
    properties: { action: { type: "string", description: "screenshot, click, type, key" } },
    required: ["action"],
  },
};

const CONNECTOR: LiveToolSpec = {
  name: "notes__search",
  description: "Search the notes.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    required: ["query"],
  },
};

// ── the pure mapping ───────────────────────────────────────────────────────────────────────

describe("codex dynamic tools: declarations and answers", () => {
  it("declares each tool as a function with its real schema, or its flat parameters", () => {
    const specs = dynamicToolSpecs([COMPUTER, CONNECTOR]);
    assert.deepEqual(specs, [
      { type: "function", name: "computer", description: COMPUTER.description, inputSchema: COMPUTER.parameters },
      {
        type: "function",
        name: "notes__search",
        description: CONNECTOR.description,
        inputSchema: CONNECTOR.inputSchema,
      },
    ]);
  });

  it("declares nothing when a tool name is one Codex would refuse: the turn keeps the bridge", () => {
    assert.equal(dynamicToolSpecs([COMPUTER, { ...CONNECTOR, name: "notes.search/x" }]), null);
    assert.equal(dynamicToolSpecs([{ ...COMPUTER, name: "" }]), null);
    assert.equal(dynamicToolSpecs([{ ...COMPUTER, name: "a".repeat(65) }]), null);
  });

  it("answers with the tool's text and its pictures inline, as data URLs", () => {
    const answer = dynamicToolResponse({
      text: "a screenshot of the build",
      images: [{ mimeType: "image/png", data: PIXEL, label: "build" }],
    });
    assert.deepEqual(answer, {
      success: true,
      contentItems: [
        { type: "inputText", text: "a screenshot of the build" },
        { type: "inputImage", imageUrl: `data:image/png;base64,${PIXEL}` },
      ],
    });
    assert.deepEqual(dynamicToolResponse("plain words"), {
      success: true,
      contentItems: [{ type: "inputText", text: "plain words" }],
    });
    assert.equal(dynamicToolResponse({ text: "it broke", isError: true }).success, false);
  });

  it("never sends what it cannot vouch for: a strange picture type or broken base64 becomes a note", () => {
    const answer = dynamicToolResponse({
      text: "two pictures",
      images: [
        { mimeType: "image/svg+xml", data: PIXEL },
        { mimeType: "image/png", data: "not base64 at all!" },
      ],
    });
    assert.equal(answer.contentItems.filter((item) => item.type === "inputImage").length, 0);
    assert.equal(answer.contentItems.length, 3, "the text plus one note per picture left out");
    assert.ok(answer.contentItems.every((item) => item.type === "inputText"));
  });

  it("keeps a whole answer under the size cap: the pictures that do not fit are named, not sent", () => {
    const big = "A".repeat(Math.floor(MAX_TOOL_RESULT_BYTES * 0.6));
    const answer = dynamicToolResponse({
      text: "frames",
      images: [
        { mimeType: "image/png", data: big },
        { mimeType: "image/png", data: big },
      ],
    });
    const images = answer.contentItems.filter((item) => item.type === "inputImage");
    assert.equal(images.length, 1, "the first fits, the second does not");
    assert.ok(Buffer.byteLength(JSON.stringify(answer.contentItems)) <= MAX_TOOL_RESULT_BYTES);
    const text = answer.contentItems.at(-1);
    assert.equal(text?.type, "inputText");

    const huge = dynamicToolResponse({ text: "x".repeat(MAX_TOOL_RESULT_BYTES * 2) });
    assert.ok(Buffer.byteLength(JSON.stringify(huge.contentItems)) <= MAX_TOOL_RESULT_BYTES, "text is cut too");
  });
});

describe("codex dynamic tools: a hostile item/tool/call", () => {
  const expected = { threadId: THREAD, tools: new Set(["computer"]) };
  const call = {
    threadId: THREAD,
    turnId: TURN,
    callId: "call-1",
    tool: "computer",
    arguments: { action: "screenshot" },
  };

  it("reads a well-formed call", () => {
    assert.deepEqual(parseDynamicToolCall(call, expected), {
      ok: true,
      call: { callId: "call-1", name: "computer", args: { action: "screenshot" } },
    });
    assert.equal(parseDynamicToolCall({ ...call, namespace: null }, expected).ok, true, "a null namespace is none");
  });

  const hostile: Array<{ label: string; params: unknown; code: ToolCallRefusal }> = [
    { label: "params that are not an object", params: "computer", code: ToolCallRefusal.Malformed },
    { label: "params that are an array", params: [call], code: ToolCallRefusal.Malformed },
    { label: "no params at all", params: undefined, code: ToolCallRefusal.Malformed },
    { label: "no call id", params: { ...call, callId: undefined }, code: ToolCallRefusal.Malformed },
    { label: "a numeric call id", params: { ...call, callId: 7 }, code: ToolCallRefusal.Malformed },
    { label: "no tool name", params: { ...call, tool: undefined }, code: ToolCallRefusal.Malformed },
    { label: "no arguments", params: { ...call, arguments: undefined }, code: ToolCallRefusal.Malformed },
    { label: "another thread", params: { ...call, threadId: "someone-else" }, code: ToolCallRefusal.WrongThread },
    { label: "a tool never declared", params: { ...call, tool: "shell" }, code: ToolCallRefusal.UnknownTool },
    { label: "an inherited name", params: { ...call, tool: "constructor" }, code: ToolCallRefusal.UnknownTool },
    { label: "a namespaced tool", params: { ...call, namespace: "studio" }, code: ToolCallRefusal.UnknownTool },
    { label: "array arguments", params: { ...call, arguments: ["screenshot"] }, code: ToolCallRefusal.BadArguments },
    { label: "string arguments", params: { ...call, arguments: "screenshot" }, code: ToolCallRefusal.BadArguments },
    { label: "null arguments", params: { ...call, arguments: null }, code: ToolCallRefusal.BadArguments },
    {
      label: "oversize arguments",
      params: { ...call, arguments: { action: "type", text: "x".repeat(MAX_TOOL_ARGUMENT_BYTES) } },
      code: ToolCallRefusal.TooLarge,
    },
  ];
  for (const row of hostile) {
    it(`refuses ${row.label} with a typed refusal the model can read, never a throw`, () => {
      const parsed = parseDynamicToolCall(row.params, expected);
      assert.equal(parsed.ok, false);
      if (parsed.ok) return;
      assert.equal(parsed.code, row.code);
      assert.equal(parsed.refusal.success, false);
      assert.equal(parsed.refusal.contentItems.length, 1);
      assert.equal(parsed.refusal.contentItems[0]?.type, "inputText");
    });
  }

  it("compares CLI versions by their numbers, and an unreadable version is never new enough", () => {
    const rows: Array<[string | undefined, boolean]> = [
      ["codex-cli 0.159.0", true],
      ["0.159.0", true],
      ["0.160.2", true],
      ["1.0.0", true],
      ["0.158.9", false],
      ["0.159.0-alpha.3", false],
      ["fixture-1", false],
      ["", false],
      [undefined, false],
    ];
    for (const [raw, ok] of rows) {
      assert.equal(meetsMinimumVersion(raw, CODEX_DYNAMIC_TOOLS_MIN_VERSION), ok, String(raw));
    }
  });
});

// ── the turn, on a scripted app server ─────────────────────────────────────────────────────

/** A one-way queue of messages that a reader awaits and a writer ends. */
function channel<T>() {
  const items: T[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  return {
    push(item: T) {
      if (ended) return;
      items.push(item);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async take(): Promise<T | undefined> {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) return next;
        if (ended) return undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

type Message = Record<string, any>;

/** The app server's side of the conversation, as a script reads and writes it. */
interface Peer {
  /** The client's next request or response; `initialized` is read past. */
  next(): Promise<Message | undefined>;
  send(message: Message): void;
}

/** An app server that plays `script` against the engine, and records what it was sent. */
function scriptedAppServer(script: (peer: Peer) => Promise<void>) {
  const launches: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];
  const sent: Message[] = [];
  let closes = 0;
  const fn: CodexAppServer = (invocation): CodexAppServerConnection => {
    launches.push({ argv: invocation.argv, cwd: invocation.cwd, env: invocation.env });
    const toClient = channel<Message>();
    const fromClient = channel<Message>();
    const peer: Peer = {
      next: async () => {
        for (;;) {
          const message = await fromClient.take();
          if (message?.method !== "initialized") return message;
        }
      },
      send: (message) => toClient.push(message),
    };
    void script(peer).finally(() => toClient.end());
    return {
      send: (message) => {
        sent.push(message);
        fromClient.push(message);
      },
      messages: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const message = await toClient.take();
            if (!message) return;
            yield message;
          }
        },
      },
      close: () => {
        closes += 1;
        toClient.end();
        fromClient.end();
      },
    };
  };
  return { fn, launches, sent, closes: () => closes };
}

/** Answers the handshake: initialize, then thread/start with a thread (or a refusal). */
async function handshake(peer: Peer, threadStartError?: string): Promise<Message | undefined> {
  const init = await peer.next();
  peer.send({ id: init?.id, result: { userAgent: "codex/0.159.0" } });
  const start = await peer.next();
  if (threadStartError) {
    peer.send({ id: start?.id, error: { code: -32600, message: threadStartError } });
    return start;
  }
  peer.send({
    id: start?.id,
    result: { thread: { id: THREAD }, model: "gpt-5.5-codex", cwd: start?.params?.cwd, sandbox: { type: "readOnly" } },
  });
  peer.send({ method: "thread/started", params: { thread: { id: THREAD } } });
  return start;
}

/** Reads turn/start and answers it. */
async function startTurn(peer: Peer): Promise<Message | undefined> {
  const turn = await peer.next();
  peer.send({ id: turn?.id, result: { turn: { id: TURN, items: [], status: "inProgress" } } });
  peer.send({
    method: "turn/started",
    params: { threadId: THREAD, turn: { id: TURN, items: [], status: "inProgress" } },
  });
  return turn;
}

function notify(method: string, params: Message): Message {
  return { method, params: { threadId: THREAD, turnId: TURN, ...params } };
}

/** A whole turn where Codex looks through the computer tool once, then says what it saw. */
function computerTurnScript(record: { start?: Message; turn?: Message; answer?: Message }) {
  return async (peer: Peer) => {
    record.start = await handshake(peer);
    record.turn = await startTurn(peer);
    const tool = { id: "call-1", type: "dynamicToolCall", tool: "computer", arguments: { action: "screenshot" } };
    peer.send(notify("item/started", { item: { ...tool, status: "inProgress" } }));
    peer.send({
      id: 90,
      method: "item/tool/call",
      params: {
        threadId: THREAD,
        turnId: TURN,
        callId: "call-1",
        tool: "computer",
        arguments: { action: "screenshot" },
      },
    });
    record.answer = await peer.next();
    peer.send(
      notify("item/completed", {
        item: { ...tool, status: "completed", success: true, contentItems: record.answer?.result?.contentItems },
      }),
    );
    peer.send(notify("item/started", { item: { id: "msg-1", type: "agentMessage", text: "" } }));
    peer.send(notify("item/agentMessage/delta", { itemId: "msg-1", delta: "The ball " }));
    peer.send(notify("item/agentMessage/delta", { itemId: "msg-1", delta: "bounces." }));
    peer.send(notify("item/completed", { item: { id: "msg-1", type: "agentMessage", text: "The ball bounces." } }));
    const breakdown = {
      inputTokens: 900,
      cachedInputTokens: 300,
      outputTokens: 120,
      reasoningOutputTokens: 20,
      totalTokens: 1020,
    };
    peer.send(notify("thread/tokenUsage/updated", { tokenUsage: { total: breakdown, last: breakdown } }));
    peer.send({
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: TURN, items: [], status: "completed" } },
    });
  };
}

/** An exec that records whether it ran, and runs a plain finished turn. */
function recordingExec() {
  const runs: Array<{ argv: string[]; prompt: string; cwd: string }> = [];
  const fn: CodexExec = (invocation) => {
    runs.push({ argv: invocation.argv, prompt: invocation.prompt, cwd: invocation.cwd });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "thread.started", thread_id: "exec-thread" };
        yield { type: "item.completed", item: { id: "m", type: "agent_message", text: "Done on exec." } };
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
      },
    };
  };
  return { fn, runs };
}

async function engineWith(options: {
  appServerFn: CodexAppServer;
  execFn: CodexExec;
  dynamicTools?: boolean;
  version?: string;
}): Promise<{ engine: CodexEngine; root: string }> {
  const root = await tmpDir("studio-codex-turns-");
  const home = path.join(root, "codex-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
  const version = options.version ?? `codex-cli ${CODEX_DYNAMIC_TOOLS_MIN_VERSION}`;
  const engine = new CodexEngine({
    resolveCli: async (provider, override, signal) => {
      const found = await fixtureCodingCli(provider, override, signal);
      return { ...found, status: { ...found.status, version } };
    },
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    executable: "/fake/codex",
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn: options.execFn,
    appServerFn: options.appServerFn,
    ...(options.dynamicTools === undefined ? {} : { codexDynamicTools: options.dynamicTools }),
  });
  return { engine, root };
}

const SCREENSHOT: LiveToolResult = {
  text: "a screenshot of the build",
  images: [{ mimeType: "image/png", data: PIXEL }],
};

function computerRequest(cwd: string, overrides: Partial<DelegateRequest> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const events: Array<{ type: string; payload: any }> = [];
  const request: DelegateRequest = {
    cwd,
    prompt: "Play the build and say whether the ball bounces.",
    liveTools: [COMPUTER],
    onLiveTool: async (name, args) => {
      calls.push({ name, args });
      return SCREENSHOT;
    },
    onEvent: (event) => events.push(event),
    ...overrides,
  };
  return { request, calls, events };
}

describe("codex turns on the app server", () => {
  it("runs a turn where Codex calls the computer tool and sees the screenshot inline", async () => {
    const record: { start?: Message; turn?: Message; answer?: Message } = {};
    const server = scriptedAppServer(computerTurnScript(record));
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn, dynamicTools: true });
    const { request, calls, events } = computerRequest(root);

    const result = await engine.delegate(request);

    assert.equal(exec.runs.length, 0, "codex exec never ran");
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, THREAD);
    assert.equal(result.summary, "The ball bounces.");
    assert.equal(result.usage.input_tokens, 900);
    assert.equal(result.usage.cache_read_tokens, 300);
    assert.equal(result.usage.output_tokens, 120);
    assert.equal(result.usage.reasoning_tokens, 20);
    assert.deepEqual(calls, [{ name: "computer", args: { action: "screenshot" } }]);

    // The handshake opts into the experimental API, and the thread carries the tools.
    const init = server.sent.find((message) => message.method === "initialize");
    assert.equal(init?.params?.capabilities?.experimentalApi, true);
    const declared = record.start?.params?.dynamicTools as Array<{ name: string }>;
    assert.deepEqual(
      declared.map((tool) => tool.name),
      ["checkpoint", "computer"],
      "every tool the bridge would have carried, and only those",
    );
    assert.deepEqual(
      declared.find((tool) => tool.name === "computer"),
      { type: "function", name: "computer", description: COMPUTER.description, inputSchema: COMPUTER.parameters },
    );
    assert.equal(record.start?.params?.cwd, root);
    assert.equal(record.start?.params?.approvalPolicy, "never");
    assert.equal(record.start?.params?.sandbox, "workspace-write");
    assert.deepEqual(record.turn?.params?.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [root],
      networkAccess: false,
    });
    const input = record.turn?.params?.input as Array<{ type: string; text?: string }>;
    assert.match(String(input[0]?.text), /Play the build/);
    assert.doesNotMatch(String(input[0]?.text), /run these as ordinary shell commands/, "no bridge instructions");
    assert.match(
      String(input[0]?.text),
      /checkpoint, computer are your own function tools/,
      "a brief written in the bridge's syntax is told the tools are native",
    );

    // The picture arrives as itself, in the answer to the call.
    assert.deepEqual(record.answer, {
      id: 90,
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: "a screenshot of the build" },
          { type: "inputImage", imageUrl: `data:image/png;base64,${PIXEL}` },
        ],
      },
    });

    // The same log the exec path writes: init, the tool call as mcp__studio__computer, the reply.
    const init0 = events.find((event) => event.type === "system" && event.payload.subtype === "init");
    assert.equal(init0?.payload.session_id, THREAD);
    assert.equal(init0?.payload.tool_delivery, "dynamic_tools");
    const toolUse = events.find((event) => event.type === "assistant" && event.payload.parts[0]?.type === "tool_use");
    assert.equal(toolUse?.payload.parts[0].name, "mcp__studio__computer");
    const toolResult = events.find((event) => event.type === "user" && event.payload.parts[0]?.type === "tool_result");
    assert.equal(toolResult?.payload.parts[0].is_error, false);
    assert.deepEqual(
      events.filter((event) => event.type === "text_delta").map((event) => event.payload.delta),
      ["The ball ", "bounces."],
    );
    assert.equal(await pathExists(path.join(root, BRIDGE_DIR)), false, "no file bridge was opened");
    assert.equal(server.closes(), 1, "the app server is closed when the turn ends");
    assert.ok(server.launches[0]?.argv.includes("--disable"), "Codex's own computer use stays off");
  });

  it("falls back to codex exec and the bridge when the app server refuses the tools, and remembers", async () => {
    let started: Message | undefined;
    const server = scriptedAppServer(async (peer) => {
      started = await handshake(peer, "dynamicTools requires experimentalApi capability");
    });
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn, dynamicTools: true });

    const first = computerRequest(root);
    const result = await engine.delegate(first.request);
    assert.ok(started?.params?.dynamicTools, "the tools were offered");
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, "exec-thread");
    assert.equal(exec.runs.length, 1, "the turn ran on codex exec instead");
    assert.match(exec.runs[0]?.prompt ?? "", /tool\.mjs computer/, "with the file bridge's instructions");
    const init = first.events.find((event) => event.type === "system" && event.payload.subtype === "init");
    assert.equal(init?.payload.tool_delivery, "file_bridge");

    await engine.delegate(computerRequest(root).request);
    assert.equal(server.launches.length, 1, "a refusal is remembered: the next turn goes straight to exec");
    assert.equal(exec.runs.length, 2);
  });

  it("a stop mid-turn interrupts the turn, closes the app server and reports what was done", async () => {
    const controller = new AbortController();
    let interrupt: Message | undefined;
    const server = scriptedAppServer(async (peer) => {
      await handshake(peer);
      await startTurn(peer);
      peer.send(notify("item/completed", { item: { id: "msg-0", type: "agentMessage", text: "Looking first." } }));
      peer.send({
        id: 91,
        method: "item/tool/call",
        params: {
          threadId: THREAD,
          turnId: TURN,
          callId: "call-1",
          tool: "computer",
          arguments: { action: "screenshot" },
        },
      });
      for (;;) {
        const message = await peer.next();
        if (!message) return;
        if (message.method === "turn/interrupt") interrupt = message;
      }
    });
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn, dynamicTools: true });
    const { request } = computerRequest(root, {
      signal: controller.signal,
      onLiveTool: async () => {
        controller.abort();
        return SCREENSHOT;
      },
    });

    const result = await engine.delegate(request);

    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.sessionId, THREAD, "Continue can resume the thread");
    assert.equal(result.summary, "Looking first.");
    assert.deepEqual(interrupt?.params, { threadId: THREAD, turnId: TURN });
    assert.ok(server.closes() >= 1, "the app server is closed");
    assert.equal(exec.runs.length, 0);
  });

  it("mid-turn, a hostile call is refused and an approval declined, and no studio tool runs", async () => {
    const answers: Message[] = [];
    const server = scriptedAppServer(async (peer) => {
      await handshake(peer);
      await startTurn(peer);
      const call = { threadId: THREAD, turnId: TURN, callId: "c", arguments: {} };
      peer.send({ id: 70, method: "item/tool/call", params: { ...call, tool: "shell" } });
      peer.send({ id: 71, method: "item/tool/call", params: { ...call, tool: "computer", threadId: "other" } });
      peer.send({ id: 72, method: "item/tool/call", params: { ...call, tool: "computer", arguments: "rm -rf /" } });
      peer.send({ id: 73, method: "item/commandExecution/requestApproval", params: { threadId: THREAD } });
      peer.send({ id: 74, method: "attestation/generate", params: {} });
      for (let index = 0; index < 5; index += 1) {
        const answer = await peer.next();
        if (answer) answers.push(answer);
      }
      peer.send({
        method: "turn/completed",
        params: { threadId: THREAD, turn: { id: TURN, items: [], status: "completed" } },
      });
    });
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn, dynamicTools: true });
    const { request, calls } = computerRequest(root);

    const result = await engine.delegate(request);

    assert.equal(result.ok, true, "the turn goes on");
    assert.deepEqual(calls, [], "no studio tool ran");
    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    for (const id of [70, 71, 72]) {
      assert.equal(byId.get(id)?.result?.success, false, `call ${id} is refused`);
      assert.equal(byId.get(id)?.result?.contentItems?.[0]?.type, "inputText");
    }
    assert.deepEqual(byId.get(73)?.result, { decision: "decline" });
    assert.equal(byId.get(74)?.error?.code, -32601, "a request Genex does not handle is answered, not left hanging");
  });

  it("a tool that throws answers the model in words, and the turn goes on", async () => {
    const record: { start?: Message; turn?: Message; answer?: Message } = {};
    const server = scriptedAppServer(computerTurnScript(record));
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn, dynamicTools: true });
    const { request } = computerRequest(root, {
      onLiveTool: async () => {
        throw new Error("the window closed");
      },
    });
    const result = await engine.delegate(request);
    assert.equal(result.ok, true);
    assert.deepEqual(record.answer?.result, {
      success: false,
      contentItems: [{ type: "inputText", text: "computer failed: the window closed" }],
    });
  });

  it("is off by default: a turn with live tools keeps codex exec and the file bridge", async () => {
    const server = scriptedAppServer(async () => {});
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn });
    const { request } = computerRequest(root);
    await engine.delegate(request);
    assert.equal(server.launches.length, 0);
    assert.equal(exec.runs.length, 1);
    assert.match(exec.runs[0]?.prompt ?? "", /tool\.mjs computer/);
  });

  it("keeps codex exec for a turn with no live tools, and for a resumed session", async () => {
    const server = scriptedAppServer(async () => {});
    const exec = recordingExec();
    const { engine, root } = await engineWith({ appServerFn: server.fn, execFn: exec.fn, dynamicTools: true });
    await engine.delegate({ cwd: root, prompt: "Build" });
    await engine.delegate(computerRequest(root, { resume: "older-thread" }).request);
    assert.equal(server.launches.length, 0);
    assert.equal(exec.runs.length, 2);
  });

  it("keeps codex exec when the installed CLI is older than the pinned minimum", async () => {
    const server = scriptedAppServer(async () => {});
    const exec = recordingExec();
    const { engine, root } = await engineWith({
      appServerFn: server.fn,
      execFn: exec.fn,
      dynamicTools: true,
      version: "codex-cli 0.158.2",
    });
    await engine.delegate(computerRequest(root).request);
    assert.equal(server.launches.length, 0);
    assert.equal(exec.runs.length, 1);
  });
});
