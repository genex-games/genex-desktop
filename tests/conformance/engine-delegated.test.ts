import { baseDenyRead } from "../../src/substrate/spawn.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
/**
 * Delegated engine + registry conformance.
 *
 * The Agent SDK's `query()` is injected here so the contract is tested without a live
 * subscription: what we assert is *our* half — options passed (including the isolated config
 * home), event mirroring, usage accounting, and how a subscription throttle turns into a
 * recoverable decision rather than a dead run.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeEngine, claudeJudgeContent, compactSdkMessage } from "../../src/substrate/engines/claude-code.ts";
import { EngineRegistry } from "../../src/substrate/engines/registry.ts";
import { STEER_STALL_MS, steerFeed, steerSession, userFrame } from "../../src/substrate/engines/claude-steer.ts";
import { credentialHomes } from "../../src/substrate/credential-homes.ts";
import { absoluteRule } from "../../src/substrate/engines/claude-permissions.ts";
import { EngineError, type Engine } from "../../src/substrate/engines/types.ts";
import { registeredSchema, scriptedClaude } from "../helpers/scripted-claude.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine resolves — and sweeps — its login homes the moment it is built, and `CLAUDE_CONFIG_DIR`
// is the first home it looks at. A dev shell that has one exported must not hand this file a home
// it does not own: every engine below is given tmp homes of its own instead.
delete process.env.CLAUDE_CONFIG_DIR;

function fakeQuery(messages: unknown[], options: { throwOn?: Error; throwAfter?: Error } = {}) {
  const seen: Array<Record<string, unknown>> = [];
  const fn = ((params: { prompt: string; options?: Record<string, unknown> }) => {
    seen.push({ prompt: params.prompt, ...params.options });
    return {
      async *[Symbol.asyncIterator]() {
        if (options.throwOn) throw options.throwOn;
        for (const message of messages) yield message;
        // The real SDK yields an error result and THEN throws when the CLI exits non-zero.
        if (options.throwAfter) throw options.throwAfter;
      },
    };
  }) as never;
  return { fn, seen };
}

type Frame = Record<string, any>;

/**
 * The fakeQuery above, for a steerable delegation: it reads `params.prompt` the way the SDK does
 * when it is not a string — the brief, then every message the engine pushes — and the script
 * reacts to what arrives. `read()` is null once the engine ended the input (the SDK then closes
 * the CLI's stdin); a script that reads past a missed end hangs, which the tests' timeouts catch.
 */
function steerableQuery(script: (io: { read(): Promise<Frame | null> }) => AsyncGenerator<unknown>) {
  const seen = { prompt: undefined as unknown, inputs: [] as Frame[], inputEnded: false };
  const fn = ((params: { prompt: unknown }) => {
    seen.prompt = params.prompt;
    const input =
      typeof params.prompt === "string" ? null : (params.prompt as AsyncIterable<Frame>)[Symbol.asyncIterator]();
    const read = async (): Promise<Frame | null> => {
      const next = input ? await input.next() : { done: true as const, value: undefined };
      if (next.done) {
        seen.inputEnded = true;
        return null;
      }
      seen.inputs.push(next.value);
      return next.value;
    };
    return { [Symbol.asyncIterator]: () => script({ read }) };
  }) as never;
  return { fn, seen };
}

/** The CLI's receipts for a message handed in with a uuid (2.1.281, `msg_lifecycle_v1`). */
const lifecycle = (frame: Frame, state: string) => ({
  type: "command_lifecycle",
  command_uuid: frame.uuid,
  state,
  uuid: `lc-${state}-${frame.uuid}`,
  session_id: "ses_steer",
});
const steerInit = (
  capabilities: string[] = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
) => ({
  type: "system",
  subtype: "init",
  model: "claude-opus-5",
  session_id: "ses_steer",
  tools: [],
  capabilities,
});
const toolUse = (id: string, name = "Bash") => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, id, input: { command: "sleep 4" } }] },
});
const toolResult = (id: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "slept" }] },
});
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
type Send =
  | ((message: {
      id: string;
      text: string;
      images?: Array<{ label: string; mimeType: string; data: string }>;
    }) => boolean)
  | null;

async function engineWithLogin(queryFn: never): Promise<ClaudeCodeEngine> {
  const root = await tmpDir("studio-engine-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    queryFn,
  });
}

const successRun = [
  { type: "system", subtype: "init", model: "claude-sonnet-5", tools: ["Read", "Write", "Bash"] },
  { type: "assistant", message: { content: [{ type: "text", text: "Scaffolding the game." }] } },
  {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Write", id: "tu_1", input: { file_path: "src/main.js" } }] },
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Built a playable pong prototype.",
    num_turns: 4,
    total_cost_usd: 0,
    usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 400 },
  },
];

describe("claude code delegated engine", () => {
  it("streams only reply text, preserves long completed replies, and retains tool results", async () => {
    const text = "The bridge and lights are ready. ".repeat(200);
    const { fn, seen } = fakeQuery([
      { type: "stream_event", event: { type: "message_start", message: { id: "reply" } } },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "worker",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "worker reply" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "The bridge" } },
      },
      { type: "assistant", message: { content: [{ type: "text", text }] } },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "check",
              content: [
                { type: "text", text: "Passed" },
                { type: "image", source: { data: "not text" } },
              ],
            },
          ],
        },
      },
      { type: "result", subtype: "success", result: text },
    ]);
    const engine = await engineWithLogin(fn);
    const events: Array<{ type: string; payload: any }> = [];
    await engine.delegate({
      cwd: await tmpDir("claude-stream-"),
      prompt: "Build",
      onEvent: (event) => events.push(event),
    });
    assert.equal(seen[0]!.includePartialMessages, true);
    assert.deepEqual(
      events.filter((e) => e.type === "text_delta").map((e) => e.payload),
      [{ streamId: "reply", delta: "The bridge" }],
    );
    assert.equal(events.find((e) => e.type === "assistant")!.payload.parts[0].text, text);
    assert.equal(events.find((e) => e.type === "user")!.payload.parts[0].content, "Passed");
  });
  it("reports Stop when an aborted SDK stream ends without throwing", async () => {
    const controller = new AbortController();
    const engine = await engineWithLogin((() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "clean-stop", model: "claude-sonnet-5", tools: [] };
        controller.abort();
      },
    })) as never);
    const result = await engine.delegate({
      cwd: await tmpDir("claude-clean-stop-"),
      prompt: "fixture",
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.sessionId, "clean-stop");
  });

  it("runs a brief in the game workspace and mirrors events for the log", async () => {
    const root = await tmpDir("studio-engine-");
    const home = path.join(root, "claude-home");
    // A login the studio owns: created here so the engine pins its own config home.
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const { fn, seen } = fakeQuery(successRun);
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      queryFn: fn,
    });
    const events: Array<{ type: string; payload: unknown }> = [];

    const result = await engine.delegate({
      prompt: "Build a pong game. Follow CLAUDE.md in this workspace.",
      cwd: "/tmp/game-workspace",
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary, "Built a playable pong prototype.");
    assert.equal(result.turns, 4);
    assert.equal(result.usage.input_tokens, 1200);
    assert.equal(result.usage.cache_read_tokens, 400);
    assert.equal(result.engine, "claude-code");

    // Its own credential home — we never hold the subscription token.
    const call = seen[0] as { cwd: string; permissionMode: string; env: Record<string, string> };
    assert.deepEqual(await engine.resolveLogin(), { source: "isolated", home });
    assert.equal(call.cwd, "/tmp/game-workspace");
    assert.equal(call.permissionMode, "acceptEdits");
    assert.equal(
      (call as unknown as { pathToClaudeCodeExecutable: string }).pathToClaudeCodeExecutable,
      "/fixture/external/claude",
    );
    assert.equal(call.env.PATH, "/fixture/runtime:/usr/bin:/bin");
    assert.equal(call.env.CLAUDE_CONFIG_DIR, home);

    assert.deepEqual(
      events.map((e) => e.type),
      ["system", "activity", "assistant", "activity", "assistant", "activity", "user", "result"],
    );
    assert.deepEqual(
      events.filter((e) => e.type === "activity").map((e) => (e.payload as { phase: string }).phase),
      ["thinking", "tool", "thinking"],
      "a tool result returns activity to inference",
    );
    const toolUse = events.filter((e) => e.type === "assistant")[1]!.payload as {
      parts: Array<{ type: string; name?: string }>;
    };
    assert.equal(toolUse.parts[0]?.name, "Write");
  });

  it("turns a subscription throttle into a recoverable engine error", async () => {
    const root = await tmpDir("studio-engine-");
    const { fn } = fakeQuery([], { throwOn: new Error("Claude usage limit reached; resets at 5pm") });
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "claude-home"),
      systemHome: path.join(root, "no-system-login"),
      queryFn: fn,
    });
    // Building the engine sweeps the homes it names: this one may name none but its own tmp.
    assert.deepEqual(await engine.resolveLogin(), { source: "none", home: null });
    await assert.rejects(
      () => engine.delegate({ prompt: "build", cwd: "/tmp/x" }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.kind, "rate_limit");
        // The reset the thrown text names rides with it, so the host can resume after it.
        const wait = err.retryAfterMs ?? 0;
        assert.ok(wait > 0 && wait <= 24 * 3_600_000, `the wait until 5pm: ${err.retryAfterMs}`);
        return true;
      },
    );
  });

  it("turns a weekly cap into usage_limit — the run must end, not wait", async () => {
    // The wording the CLI actually used the run a run burned every facet's strikes on it.
    const root = await tmpDir("studio-engine-");
    const { fn } = fakeQuery([], {
      throwOn: new Error("You've hit your weekly limit · resets Sep 1 at 10am (Europe/Belgrade)"),
    });
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "claude-home"),
      systemHome: path.join(root, "no-system-login"),
      queryFn: fn,
    });
    await assert.rejects(
      () => engine.delegate({ prompt: "build", cwd: "/tmp/x" }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.kind, "usage_limit");
        return true;
      },
    );
  });

  it("explains how to sign in instead of pretending to be ready", async () => {
    const root = await tmpDir("studio-engine-");
    const home = path.join(root, "empty-home");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      queryFn: fakeQuery([]).fn,
    });
    const previous = { key: process.env.ANTHROPIC_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const status = await engine.status();
      assert.equal(status.code, "needs_login");
      assert.match(status.remedy ?? "", /sign in/i);
    } finally {
      if (previous.key) process.env.ANTHROPIC_API_KEY = previous.key;
      if (previous.token) process.env.CLAUDE_CODE_OAUTH_TOKEN = previous.token;
    }
  });

  it("uses an existing Claude Code sign-in on this Mac rather than asking for a second one", async () => {
    const root = await tmpDir("studio-engine-");
    const systemHome = path.join(root, "dot-claude");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, ".credentials.json"), "{}");

    const { fn, seen } = fakeQuery(successRun);
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "engine-home"),
      systemHome,
      queryFn: fn,
    });
    const previous = { key: process.env.ANTHROPIC_API_KEY, dir: process.env.CLAUDE_CONFIG_DIR };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      assert.deepEqual(await engine.resolveLogin(), { source: "system", home: systemHome });
      const status = await engine.status();
      assert.equal(status.code, "ready");
      assert.match(status.detail, /existing Claude Code sign-in/);

      await engine.delegate({ prompt: "build", cwd: "/tmp/x" });
      const call = seen[0] as { env: Record<string, string> };
      assert.equal(
        call.env.CLAUDE_CONFIG_DIR,
        undefined,
        "with a system login the studio must not pin a config home — Claude Code finds its own",
      );
    } finally {
      if (previous.key) process.env.ANTHROPIC_API_KEY = previous.key;
      if (previous.dir) process.env.CLAUDE_CONFIG_DIR = previous.dir;
    }
  });

  it("treats an expired subscription session as a sign-in problem, not a generic error", async () => {
    const root = await tmpDir("studio-engine-");
    const systemHome = path.join(root, "dot-claude");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, ".credentials.json"), "{}");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "engine-home"),
      systemHome,
      // The exact message Claude Code emits when a subscription login has gone stale.
      queryFn: fakeQuery([], {
        throwOn: new Error("Failed to authenticate: OAuth session expired and could not be refreshed"),
      }).fn,
      authStatusFn: async () => ({ loggedIn: false, detail: "OAuth session expired; sign in again" }),
    });
    const previous = { key: process.env.ANTHROPIC_API_KEY, dir: process.env.CLAUDE_CONFIG_DIR };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      assert.equal((await engine.status()).code, "ready", "credential files exist, so it looks fine at first");
      await assert.rejects(
        () => engine.delegate({ prompt: "build", cwd: "/tmp/x" }),
        (err: unknown) => {
          assert.ok(err instanceof EngineError);
          assert.equal(err.kind, "auth");
          assert.match(err.message, /sign in/i);
          return true;
        },
      );
      // ...and afterwards the engine stops claiming to be ready.
      const after = await engine.status();
      assert.equal(after.code, "needs_login");
      assert.match(after.detail, /OAuth session expired/);
      // Rechecking without a working session must not pretend the files mean "signed in".
      await engine.recheckLogin();
      assert.equal((await engine.status()).code, "needs_login");
    } finally {
      if (previous.key) process.env.ANTHROPIC_API_KEY = previous.key;
      if (previous.dir) process.env.CLAUDE_CONFIG_DIR = previous.dir;
    }
  });

  it("detects an expired session on probe, before a build is even sent", async () => {
    const root = await tmpDir("studio-engine-");
    const systemHome = path.join(root, "dot-claude");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, ".credentials.json"), "{}");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "engine-home"),
      systemHome,
      queryFn: fakeQuery([], {
        throwOn: new Error("Failed to authenticate: OAuth session expired and could not be refreshed"),
      }).fn,
      authStatusFn: async () => ({ loggedIn: false, detail: "OAuth session expired; sign in again" }),
    });
    const previous = { key: process.env.ANTHROPIC_API_KEY, dir: process.env.CLAUDE_CONFIG_DIR };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      assert.equal((await engine.status()).code, "ready", "files-only status still looks fine");
      const probed = await engine.probeAuth();
      assert.equal(probed.code, "needs_login");
      assert.match(probed.detail, /OAuth session expired|sign in/i);
    } finally {
      if (previous.key) process.env.ANTHROPIC_API_KEY = previous.key;
      if (previous.dir) process.env.CLAUDE_CONFIG_DIR = previous.dir;
    }
  });

  it("keeps a dead session's answer while a recheck is still asking the CLI", async () => {
    const root = await tmpDir("studio-engine-");
    const systemHome = path.join(root, "dot-claude");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, ".credentials.json"), "{}");
    const answers: Array<(answer: { loggedIn: boolean | null; detail: string }) => void> = [];
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "engine-home"),
      systemHome,
      authStatusFn: () => new Promise((resolve) => answers.push(resolve)),
    });
    const previous = { key: process.env.ANTHROPIC_API_KEY, dir: process.env.CLAUDE_CONFIG_DIR };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
    const asked = async (count: number): Promise<void> => {
      while (answers.length < count) await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      const first = engine.probeAuth();
      await asked(1);
      answers[0]?.({ loggedIn: false, detail: "Not logged in" });
      assert.equal((await first).code, "needs_login");

      // A recheck in flight: every status read in the gap is still the last answer, never "ready".
      const recheck = engine.recheckLogin();
      await asked(2);
      assert.equal((await engine.status()).code, "needs_login", "no Ready flash while the CLI is asked");
      // Rechecks that arrive while the CLI is asked wait for it, then ask once more, together.
      const later = engine.recheckLogin();
      assert.equal(engine.recheckLogin(), later, "a recheck that has not started asking is joined");
      answers[1]?.({ loggedIn: false, detail: "Not logged in" });
      assert.equal((await recheck).code, "needs_login");
      await asked(3);
      assert.equal((await engine.status()).code, "needs_login");

      // An answer that cannot be read keeps the last one; a signed-in answer clears it.
      answers[2]?.({ loggedIn: null, detail: "timed out" });
      assert.equal((await later).code, "error");
      assert.equal(answers.length, 3, "the rechecks never asked the CLI at the same time");
      assert.equal((await engine.status()).code, "needs_login");
      const signedIn = engine.recheckLogin();
      await asked(4);
      answers[3]?.({ loggedIn: true, detail: "Logged in" });
      assert.equal((await signedIn).code, "ready");
      assert.equal((await engine.status()).code, "ready");
    } finally {
      if (previous.key) process.env.ANTHROPIC_API_KEY = previous.key;
      if (previous.dir) process.env.CLAUDE_CONFIG_DIR = previous.dir;
    }
  });

  it("believes the CLI when it says the session is dead, without waiting for a build", async () => {
    const root = await tmpDir("studio-engine-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      queryFn: fakeQuery(successRun).fn,
      authStatusFn: async () => ({ loggedIn: false, detail: "not logged in" }),
    });
    const probed = await engine.probeAuth();
    assert.equal(probed.code, "needs_login");
    assert.match(probed.detail, /not logged in/);
  });

  it("bridges interview tools over MCP and reports the intake call from the stream", async () => {
    const interviewRun = [
      { type: "system", subtype: "init", model: "claude-sonnet-5", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "Recap: a doomer street. Starting it." }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__studio__checkpoint", id: "tu_0", input: { note: "not an intake call" } },
            {
              type: "tool_use",
              name: "mcp__studio__start_autopilot",
              id: "tu_1",
              input: { goal: "doomer street", direction: "blue dusk" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Interview done — run commissioned.",
        num_turns: 3,
        total_cost_usd: 0,
        usage: {},
      },
    ];
    const { fn, seen } = fakeQuery(interviewRun);
    const engine = await engineWithLogin(fn);
    const result = await engine.delegate({
      prompt: "interview brief",
      cwd: "/tmp/x",
      interviewTools: [
        {
          name: "start_autopilot",
          description: "Launch the Autopilot run.",
          parameters: {
            type: "object",
            properties: { goal: { type: "string" }, direction: { type: "string" } },
            required: ["goal", "direction"],
          },
        },
      ],
    });
    assert.equal(result.ok, true);
    // checkpoint stays a checkpoint; only the bridged intake tool is reported back.
    assert.deepEqual(result.studioToolCalls, [
      { name: "start_autopilot", args: { goal: "doomer street", direction: "blue dusk" } },
    ]);
    const opts = seen[0] as Record<string, unknown>;
    assert.ok((opts.allowedTools as string[]).includes("mcp__studio__start_autopilot"));
    // Flipped (step 1): a Loop chat is a full contractor. It answers, researches or edits itself
    // and launches only when the ask is a build — a research-and-plan request once reached a
    // write-less interviewer whose only way forward was a seventeen-hour build.
    assert.equal((opts.disallowedTools as string[]).includes("Edit"), false, "a Loop chat may edit files");
    assert.equal((opts.disallowedTools as string[]).includes("Write"), false, "a Loop chat may write files");
    assert.ok((opts.allowedTools as string[]).includes("WebSearch"), "a Loop chat may research the web");
  });

  it("records only the bridged launch and question calls, not the session's other studio tools", async () => {
    const { fn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s-loop" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "mcp__studio__capture", input: {} },
            { type: "tool_use", id: "t2", name: "mcp__studio__srv__echo", input: { text: "hi" } },
            { type: "tool_use", id: "t3", name: "mcp__studio__ask_user", input: { question: "Plan or build?" } },
          ],
        },
      },
      { type: "result", subtype: "success", result: "asked", num_turns: 1, session_id: "s-loop" },
    ]);
    const engine = await engineWithLogin(fn);
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object" as const, properties: { goal: { type: "string" as const } } },
    });
    const result = await engine.delegate({
      prompt: "research first",
      cwd: "/tmp/game-workspace",
      interviewTools: [tool("start_autopilot"), tool("ask_user")],
    });
    assert.equal(seen.length, 1);
    // Capture and a connector ran during the session; only the question is the harness's to run.
    assert.deepEqual(result.studioToolCalls, [{ name: "ask_user", args: { question: "Plan or build?" } }]);
  });

  it("keeps read-only sessions and performance-optimization candidates off the web", async () => {
    const requests = [{ readOnly: true }, { optimization: { denyWrites: ["/tmp/x"] } }];
    for (const request of requests) {
      const { fn, seen } = fakeQuery(successRun);
      const engine = await engineWithLogin(fn);
      await engine.delegate({ prompt: "look", cwd: "/tmp/game-workspace", ...request } as never);
      const call = seen[0] as Record<string, unknown>;
      assert.equal((call.allowedTools as string[]).includes("WebSearch"), false, JSON.stringify(request));
      const banned = call.disallowedTools as string[];
      assert.ok(banned.includes("WebSearch") && banned.includes("WebFetch"), JSON.stringify(request));
    }
  });

  /**
   * One session: a waking run's lead is its chat's own session, resumed in the game folder where
   * that session lives, with the integration worktree it leads readable and no hands of its own.
   */
  it("resumes a read-only lead in the game folder, with the build it leads readable and nothing to write with", async () => {
    const { fn, seen } = fakeQuery(successRun);
    const engine = await engineWithLogin(fn);
    const game = "/tmp/game-workspace";
    const build = "/tmp/studio-scratch/autopilot/run_lead/integration";
    await engine.delegate({
      prompt: "lead the run",
      cwd: game,
      readOnly: true,
      resume: "chat-session",
      extraReads: [path.dirname(build)],
      director: { runId: "run_lead", threadId: "t", project: "game", root: build, chatSession: true },
      liveTools: [],
      onLiveTool: async () => "",
    });
    const call = seen[0] as Record<string, unknown>;
    assert.equal(call.cwd, game, "the chat's own session, where it lives");
    assert.equal(call.resume, "chat-session");
    const banned = call.disallowedTools as string[];
    for (const tool of ["Write", "Edit", "Bash"]) assert.ok(banned.includes(tool), `${tool} is not the lead's`);
    assert.equal((call.allowedTools as string[]).includes("Bash"), false);
    // The engine hands the SDK absolute paths: on Windows `/tmp/…` resolves onto the current drive.
    assert.deepEqual(call.additionalDirectories, [path.resolve(path.dirname(build))], "the build it leads is readable");
  });

  it("runs uncapped by default and honours resume — the stop button is the control, not a turn limit", async () => {
    // The first live build hit turn 61 of 60 with $7.54 of finished work on disk and the whole
    // thing reported as a crash. No cap: a chat build runs until done or stopped.
    const { fn, seen } = fakeQuery(successRun);
    const engine = await engineWithLogin(fn);
    await engine.delegate({ prompt: "build", cwd: "/tmp/x", resume: "ses_previous" });
    const call = seen[0] as Record<string, unknown>;
    assert.equal(call.maxTurns, undefined, "no default turn cap");
    assert.equal(call.resume, "ses_previous", "a resumed session continues where it left off");
  });

  it("reports an error result as a partial outcome, not a crash — the SDK's post-result throw adds nothing", async () => {
    const { fn } = fakeQuery(
      [
        { type: "system", subtype: "init", model: "claude-opus-5", session_id: "ses_abc", tools: [] },
        { type: "assistant", message: { content: [{ type: "text", text: "Building the arena." }] } },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["something broke at the end"],
          num_turns: 40,
          total_cost_usd: 5.5,
          usage: { input_tokens: 900, output_tokens: 400 },
        },
      ],
      { throwAfter: new Error("Claude Code returned an error result: something broke at the end") },
    );
    const engine = await engineWithLogin(fn);
    const result = await engine.delegate({ prompt: "build", cwd: "/tmp/x" });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "error_during_execution");
    assert.equal(result.errorText, "something broke at the end");
    assert.equal(result.sessionId, "ses_abc", "the session id survives, so Continue can resume it");
    assert.equal(result.turns, 40, "the partial work is accounted, not discarded");
    assert.equal(result.usage.input_tokens, 900);
  });

  it("treats the stop button as an instruction obeyed: abort returns the partial build with its session id", async () => {
    const abort = new AbortController();
    const { fn } = fakeQuery(
      [{ type: "system", subtype: "init", model: "claude-opus-5", session_id: "ses_stop", tools: [] }],
      { throwAfter: Object.assign(new Error("This operation was aborted"), { name: "AbortError" }) },
    );
    const engine = await engineWithLogin(fn);
    const result = await engine.delegate({
      prompt: "build",
      cwd: "/tmp/x",
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === "system") abort.abort();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.sessionId, "ses_stop");
  });

  it("a deadline abort returns the partial build, not a crash", async () => {
    // The fake mirrors the real SDK: an aborted controller makes the stream throw AbortError.
    let controller: AbortController | undefined;
    const fn = ((params: { prompt: string; options?: { abortController?: AbortController } }) => {
      controller = params.options?.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", model: "claude-opus-5", session_id: "ses_deadline", tools: [] };
          await new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
            if (controller!.signal.aborted) abort();
            else controller!.signal.addEventListener("abort", abort, { once: true });
          });
        },
      };
    }) as never;
    const engine = await engineWithLogin(fn);
    const started = Date.now();
    const result = await engine.delegate({ prompt: "build", cwd: "/tmp/x", timeoutMs: 50 });
    assert.ok(controller, "the controller reaches the SDK even though no user signal was given");
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "deadline");
    assert.equal(result.errorText, "time budget exhausted");
    assert.equal(result.sessionId, "ses_deadline", "the session id survives, so Continue can resume");
    assert.ok(Date.now() - started < 5_000, "the deadline settles the call instead of hanging");
  });

  it("a user stop still reads as stopped, not deadline, even with a time budget set", async () => {
    const abort = new AbortController();
    abort.abort();
    const { fn } = fakeQuery(
      [{ type: "system", subtype: "init", model: "claude-opus-5", session_id: "ses_stop", tools: [] }],
      { throwAfter: Object.assign(new Error("This operation was aborted"), { name: "AbortError" }) },
    );
    const engine = await engineWithLogin(fn);
    const result = await engine.delegate({ prompt: "build", cwd: "/tmp/x", signal: abort.signal, timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "stopped", "the user's stop wins over a pending deadline");
  });

  it("keeps the whole denial story: which tool, whose decision, what the model was told", () => {
    const compacted = compactSdkMessage({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      decision_reason: "rule",
      message: "python3 heredoc blocked by sandbox profile",
    }) as { tool_name: string; decision_reason: string; message: string };
    assert.equal(compacted.tool_name, "Bash");
    assert.equal(compacted.decision_reason, "rule");
    assert.match(compacted.message, /python3 heredoc/);
    // ...and the init mirror keeps the session id Continue needs.
    const init = compactSdkMessage({ type: "system", subtype: "init", model: "m", session_id: "ses_1", tools: [] }) as {
      session_id: string;
    };
    assert.equal(init.session_id, "ses_1");
  });

  it("preserves completed reply text so the durable message matches its stream", () => {
    const compacted = compactSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(5_000) }] },
    }) as { parts: Array<{ text: string }> };
    assert.equal(compacted.parts[0]!.text, "x".repeat(5_000));
  });

  it("confines the contractor: no user config, no cross-session tools, sandboxed shell", async () => {
    const root = await tmpDir("studio-engine-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    // D8: an ambient API key in the studio's own environment must never reach the contractor —
    // it would silently flip the SDK to metered billing nobody agreed to.
    process.env.ANTHROPIC_API_KEY = "sk-ant-ambient-test-key";
    const { fn, seen } = fakeQuery(successRun);
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
      queryFn: fn,
    });
    let result;
    try {
      result = await engine.delegate({ prompt: "build", cwd: "/tmp/game-workspace", effort: "high" });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }

    const call = seen[0] as Record<string, unknown>;
    assert.equal(
      (call.env as Record<string, string>).ANTHROPIC_API_KEY,
      undefined,
      "the ambient API key is stripped — subscription only (D8)",
    );
    assert.equal(result.billing, "subscription", "billing can never silently flip to metered API");
    // The first live build inherited the user's whole Claude Code config (111 tools, MCP
    // servers) and messaged the user's other sessions. Never again:
    assert.deepEqual(call.settingSources, [], "project settings require host-stored folder trust");
    assert.deepEqual(
      Object.keys(call.mcpServers as Record<string, unknown>),
      ["studio"],
      "exactly one MCP server reaches the contractor: the studio's own checkpoint tool",
    );
    // Load-bearing: without strict, passing ANY mcpServers makes the CLI also load the user's
    // own MCP configurations (the kiosk build came up with 111 tools, Linear included).
    assert.equal(call.strictMcpConfig, true, "only the studio's declared MCP server exists");
    // Bash is blanket-allowed — headless permission evaluation splits compound commands into
    // subcommands and was denying them piecemeal — and that is safe only because the sandbox
    // below can never be escaped.
    // Flipped (step 1): research is part of building — web search and page reading, with the
    // shell still sandboxed.
    assert.deepEqual(call.allowedTools, ["mcp__studio__checkpoint", "Bash", "WebSearch", "WebFetch"]);
    assert.deepEqual(call.disallowedTools, ["SendMessage", "ListAgents"]);
    // Thinking arrives as a summary instead of an empty block, for the chat's Thinking details.
    assert.equal((call.settings as Record<string, unknown>).showThinkingSummaries, true);
    // The delegate default is ABSENT, not empty: a build session is exactly where a project
    // skill earns its keep, and the query must go out byte-identical to what shipped.
    assert.equal("skills" in call, false, "no skills key on a delegation");
    // ...and its shell runs sandboxed but auto-allowed, so it can actually verify what it builds
    // (the first build shipped untested — every Bash call was permission-denied).
    // allowUnsandboxedCommands: false makes the CLI ignore dangerouslyDisableSandbox entirely.
    assert.deepEqual(call.sandbox, {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // SEC-3 (flipped): both CLIs' sign-in homes are write-denied with the studio's own secrets.
      filesystem: {
        denyWrite: [
          path.join(root, "secrets"),
          path.join(root, "engine-homes"),
          ...credentialHomes(),
          ...baseDenyRead(),
        ],
        denyRead: [
          ...baseDenyRead(),
          path.join(root, "secrets"),
          path.join(root, "engine-homes"),
          ...credentialHomes(),
          ...baseDenyRead(),
        ],
      },
    });
    assert.equal(
      (call.env as Record<string, string>).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
      "60000",
      "a forgotten background dev server is reaped a minute after idle, not waited on forever",
    );
    assert.equal(call.effort, "high");
    const settings = call.settings as { permissions: { deny: string[]; allow?: string[] } };
    // Flipped (permissions port): Claude Code reads a rule's "/abs" relative to the working
    // directory; only "//abs" is the filesystem root. Single-slash rules guard nothing real.
    assert.deepEqual(
      settings.permissions.deny,
      [
        ...new Set([
          path.join(root, "secrets"),
          path.join(root, "engine-homes"),
          ...credentialHomes(),
          ...baseDenyRead(),
        ]),
      ].map((dir) => absoluteRule("Read", dir)),
      "the studio's secret paths and the sign-in homes are deny-listed for reads, at their absolute paths",
    );
    assert.ok(settings.permissions.deny.every((rule) => rule.startsWith("Read(//")));
    assert.equal(settings.permissions.allow, undefined, "an unattended session carries no allow rules");
    // Unattended means nobody to ask: no prompt callback, no bypass flag, edits accepted.
    assert.equal(call.permissionMode, "acceptEdits");
    assert.equal("canUseTool" in call, false);
    assert.equal("allowDangerouslySkipPermissions" in call, false);
  });

  it("grants stills outside cwd and denies sibling folders for Read", async () => {
    const { fn, seen } = fakeQuery(successRun);
    const engine = await engineWithLogin(fn);
    await engine.delegate({
      prompt: "build",
      cwd: "/tmp/game-workspace",
      extraReads: ["/tmp/stills/blame"],
      denyReads: ["/tmp/sibling-game"],
    });
    const call = seen[0] as Record<string, unknown>;
    assert.deepEqual(call.additionalDirectories, [path.resolve("/tmp/stills/blame")]);
    const deny = (call.settings as { permissions: { deny: string[] } }).permissions.deny;
    // Flipped (permissions port): an absolute deny takes Claude Code's double slash.
    assert.deepEqual(
      deny.filter((rule) => rule.includes("sibling-game")),
      [absoluteRule("Read", "/tmp/sibling-game")],
    );
    if (process.platform !== "win32") assert.ok(deny.includes("Read(//tmp/sibling-game/**)"));
    assert.ok(!deny.some((rule) => rule.includes("stills")));
  });

  it("a judge that answers nothing is a failure, and the model asked for stands in for one the CLI did not name", async () => {
    const silent = [
      { type: "system", subtype: "init", tools: [] },
      { type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, total_cost_usd: 0, usage: {} },
    ];
    const empty = await engineWithLogin(fakeQuery(silent).fn);
    await assert.rejects(
      () => empty.complete({ model: "sonnet", messages: [{ role: "user", content: "BUILD A vs BUILD B" }] }),
      (err: unknown) => err instanceof EngineError && /no reply/i.test(err.message),
      "an empty verdict never reaches the parser as if it were one",
    );
    const unnamed = [
      { type: "system", subtype: "init", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: '{"pick":"A"}' }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: '{"pick":"A"}',
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
      },
    ];
    const answered = await (await engineWithLogin(fakeQuery(unnamed).fn)).complete({
      model: "sonnet",
      messages: [{ role: "user", content: "BUILD A vs BUILD B" }],
    });
    assert.equal(answered.model, "sonnet", "the record names the model asked for, not 'unknown'");
  });

  it("the critic is a tool-less one-shot in an empty folder, not a second builder", async () => {
    const judgeRun = [
      { type: "system", subtype: "init", model: "claude-sonnet-5", tools: [] },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: '{"pick":"A","biggest_gap":"contrast","reason":"the stills"}' }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: '{"pick":"A","biggest_gap":"contrast","reason":"the stills"}',
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 800, output_tokens: 40 },
      },
    ];
    const { fn, seen } = fakeQuery(judgeRun);
    const engine = await engineWithLogin(fn);
    const response = await engine.complete({
      model: "sonnet",
      systemPrompt: "JSON only.",
      messages: [
        {
          role: "user",
          content: "BUILD A vs BUILD B",
          images: [{ mimeType: "image/jpeg", data: "abc123", label: "BUILD A / default" }],
        },
      ],
    });
    assert.equal(response.engine, "claude-code");
    assert.match(response.message.content, /"pick":"A"/);

    const call = seen[0] as Record<string, unknown>;
    assert.equal(call.maxTurns, 1);
    assert.deepEqual(call.allowedTools, []);
    // Refusing tools is not removing them: without `tools: []` every built-in tool's definition
    // (TodoWrite, NotebookEdit, ToolSearch…) still rode along on each verdict's request.
    assert.deepEqual(call.tools, [], "no built-in tool's definition is sent to a judge");
    assert.deepEqual(call.mcpServers, {});
    assert.equal(call.strictMcpConfig, true);
    // A judge answers one question about one picture with no tools and no shell (M4.8b).
    // Options.skills is a context filter, not a sandbox: a bundled skill's frontmatter is
    // prompt weight that can only make two verdicts that should be the same differ.
    assert.deepEqual(call.skills, [], "the judge loads no skills at all");
    // No user, project or local settings reach a judge (their hooks, permissions or
    // memory would make two verdicts that should be the same differ).
    assert.deepEqual(call.settingSources, [], "the judge reads no settings files");
    const banned = call.disallowedTools as string[];
    assert.ok(banned.includes("SendMessage") && banned.includes("ListAgents") && banned.includes("Agent"));
    assert.ok(banned.includes("Write") && banned.includes("Read") && banned.includes("Bash"));
    // A verdict comes from the evidence handed over, never from something looked up.
    assert.ok(banned.includes("WebSearch") && banned.includes("WebFetch"), "a judge never researches");
    assert.notEqual(call.permissionMode, "acceptEdits");
    assert.match(String(call.cwd), /studio-judge-/);
    assert.equal(
      call.pathToClaudeCodeExecutable,
      "/fixture/external/claude",
      "the judge runs the resolved external CLI, like a build",
    );
    assert.equal(typeof call.prompt, "object", "stills travel as content blocks, not as a path in the prompt");
  });

  it("a judge CLI that never answers hits the completion ceiling as a timeout, fast", async () => {
    // Without a ceiling a hung judge held its RPC in flight forever, which muted the harness
    // wedge detector — the whole run stalled invisibly until someone looked in the morning.
    let controller: AbortController | undefined;
    const fn = ((params: { options?: { abortController?: AbortController } }) => {
      controller = params.options?.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
            if (controller!.signal.aborted) abort();
            else controller!.signal.addEventListener("abort", abort, { once: true });
          });
        },
      };
    }) as never;
    const engine = await engineWithLogin(fn);
    const started = Date.now();
    await assert.rejects(
      () => engine.complete({ messages: [{ role: "user", content: "BUILD A vs BUILD B" }], timeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.kind, "timeout", "a hung judge is a timeout, not a user stop or a crash");
        assert.match(err.message, /did not answer/);
        return true;
      },
    );
    assert.ok(controller, "the ceiling has a controller to fire even when no caller signal exists");
    assert.ok(Date.now() - started < 5_000, "the ceiling settles the call instead of hanging");
  });

  it("turns attached stills into Claude image blocks, not file paths", () => {
    const parts = claudeJudgeContent({
      systemPrompt: "Look at the pictures.",
      messages: [
        {
          role: "user",
          content: "BUILD A vs BUILD B",
          images: [{ mimeType: "image/jpeg", data: "abc123", label: "BUILD A / default" }],
        },
      ],
    });
    assert.equal(parts[0]?.type, "text");
    assert.equal(parts[0] && "text" in parts[0] ? parts[0].text : "", "Look at the pictures.\n\nBUILD A vs BUILD B");
    assert.equal(parts[1]?.type, "image");
    assert.equal(parts[1] && "source" in parts[1] ? parts[1].source.data : "", "abc123");
    assert.ok(!JSON.stringify(parts).includes(".jpg"));
  });

  it("refuses a tool-loop complete — that is what delegate is for", async () => {
    const engine = await engineWithLogin(fakeQuery([]).fn);
    await assert.rejects(
      () =>
        engine.complete({
          messages: [{ role: "user", content: "build" }],
          tools: [{ name: "write_file", description: "write", parameters: { type: "object", properties: {} } }],
        }),
      /no tool-loop completion/,
    );
  });

  it("reports the model that actually ran, from the contractor's own init event", async () => {
    const root = await tmpDir("studio-engine-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      queryFn: fakeQuery(successRun).fn,
    });
    const result = await engine.delegate({ prompt: "build", cwd: "/tmp/x" });
    assert.equal(result.model, "claude-sonnet-5", "the init event's model wins over the requested id");
    assert.ok((result.durationMs ?? -1) >= 0, "the build reports how long it took");
  });

  it("mirrors the story, not the heartbeat: stream noise never reaches the log", () => {
    // The first live build wrote ~1,200 thinking_tokens ticks and dozens of task_progress
    // pings into the event log — none of them mean anything on replay.
    for (const noise of [
      { type: "system", subtype: "thinking_tokens" },
      { type: "system", subtype: "task_progress" },
      { type: "system", subtype: "background_tasks_changed" },
      { type: "command_lifecycle" },
      { type: "tool_progress" },
    ]) {
      assert.equal(compactSdkMessage(noise), null, `${JSON.stringify(noise)} must be dropped`);
    }
    // ...while the meaningful system events survive.
    for (const kept of [
      { type: "system", subtype: "init", model: "m", tools: [] },
      { type: "system", subtype: "permission_denied" },
      { type: "rate_limit_event" },
    ]) {
      assert.notEqual(compactSdkMessage(kept), null, `${JSON.stringify(kept)} must be kept`);
    }
  });

  it("shows tool inputs relative to the workspace, not as absolute paths", () => {
    const cwd = "/Users/someone/Library/Application Support/AI Game Studio/workspaces/games/hi";
    const compacted = compactSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", id: "t1", input: { file_path: `${cwd}/src/enemies.js` } },
            {
              type: "tool_use",
              name: "Bash",
              id: "t2",
              input: { command: `cd "${cwd}" && node --check ${cwd}/src/main.js` },
            },
          ],
        },
      },
      cwd,
    ) as { parts: Array<{ input: string }> };
    assert.equal(compacted.parts[0]!.input, "src/enemies.js");
    assert.equal(compacted.parts[1]!.input, 'cd "." && node --check src/main.js');
  });
});

describe("steering a running Claude Code turn", () => {
  // Every script below either ends because the engine ended its input or hangs on `read()`.
  const timeout = 5_000;
  const story = (events: Array<{ type: string }>) =>
    events.map((e) => e.type).filter((t) => ["assistant", "user", "steer_delivered", "result"].includes(t));

  it("hands a message into the running turn and reports it read where the session read it", { timeout }, async () => {
    const { fn, seen } = steerableQuery(async function* ({ read }) {
      await read();
      yield steerInit();
      yield toolUse("tu_1");
      const steer = (await read())!;
      yield lifecycle(steer, "queued");
      yield toolResult("tu_1");
      // Folded in at the tool-result boundary: this is where the session read it.
      yield lifecycle(steer, "started");
      yield said("Done, and X too.");
      yield lifecycle(steer, "completed");
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done, and X too.",
        queued_turn_count: 0,
        usage: {},
      };
      assert.equal(await read(), null, "the input ends once the session answered everything it read");
    });
    const engine = await engineWithLogin(fn);
    const events: Array<{ type: string; payload: any }> = [];
    const readies: Send[] = [];
    let sent: boolean | undefined;
    const result = await engine.delegate({
      prompt: "Run the command",
      cwd: "/tmp/x",
      steer: { ready: (send) => readies.push(send) },
      onEvent: (event) => {
        events.push(event);
        // The person types while the tool runs.
        if (event.type === "assistant" && (event.payload as any).parts[0].type === "tool_use") {
          sent = readies[0]!({
            id: "m1",
            text: "please also do X",
            images: [{ label: "sketch", mimeType: "image/png", data: "iVBOR" }],
          });
        }
      },
    });

    assert.equal(engine.steersMidTurn, true);
    assert.equal(readies.length, 1, "ready is said exactly once");
    assert.equal(typeof readies[0], "function", "a CLI with msg_lifecycle_v1 takes input mid-turn");
    assert.equal(sent, true);
    // The brief carries no uuid: lifecycles are tracked only for steers.
    assert.deepEqual(seen.inputs[0], {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Run the command" }] },
      parent_tool_use_id: null,
    });
    const frame = seen.inputs[1]!;
    assert.equal(frame.type, "user");
    assert.equal(frame.priority, "next");
    assert.deepEqual(frame.origin, { kind: "human" });
    assert.match(frame.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(frame.session_id, "ses_steer");
    assert.equal(frame.parent_tool_use_id, null);
    assert.deepEqual(frame.message, {
      role: "user",
      content: [
        { type: "text", text: "please also do X\n\nIMAGES ATTACHED (1): sketch." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
      ],
    });

    // Recorded in stream order: after the tool result it was folded into, before the reply to it.
    assert.deepEqual(story(events), ["assistant", "user", "steer_delivered", "assistant", "result"]);
    assert.deepEqual(events.find((e) => e.type === "steer_delivered")!.payload, { id: "m1" });
    assert.ok(!events.some((e) => e.type === "command_lifecycle"), "lifecycle receipts are never mirrored");
    assert.deepEqual(result.steered, ["m1"]);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Done, and X too.");
    assert.equal(result.turns, 3, "receipts are not turns");
    assert.equal(seen.inputEnded, true);
    assert.equal(readies[0]!({ id: "m2", text: "too late" }), false, "nothing is taken once the input ended");
  });

  it("keeps the input open for a message taken during the final answer, and reports the last answer", {
    timeout,
  }, async () => {
    const { fn } = steerableQuery(async function* ({ read }) {
      await read();
      yield steerInit();
      yield said("First answer.");
      const late = (await read())!;
      yield lifecycle(late, "queued");
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "First answer.",
        num_turns: 1,
        queued_turn_count: 1,
        total_cost_usd: 0.1,
        usage: { input_tokens: 10, output_tokens: 20 },
      };
      // Taken but not read at the result: the CLI starts it as a turn of its own.
      yield lifecycle(late, "started");
      const later = (await read())!;
      yield { ...steerInit(), uuid: "second-init" };
      yield toolUse("tu_2");
      yield lifecycle(later, "queued");
      yield toolResult("tu_2");
      yield lifecycle(later, "started");
      yield said("Second answer, with both.");
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Second answer, with both.",
        num_turns: 2,
        queued_turn_count: 0,
        total_cost_usd: 0.3,
        usage: { input_tokens: 30, output_tokens: 5 },
      };
      assert.equal(await read(), null);
    });
    const engine = await engineWithLogin(fn);
    const events: Array<{ type: string; payload: any }> = [];
    const readies: Send[] = [];
    const sent: boolean[] = [];
    const result = await engine.delegate({
      prompt: "Answer slowly",
      cwd: "/tmp/x",
      steer: { ready: (send) => readies.push(send) },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "assistant" && (event.payload as any).parts[0].text === "First answer.")
          sent.push(readies[0]!({ id: "late", text: "one more thing" }));
        // Past the first result, with the late message only now read: the input is still open.
        if (event.type === "steer_delivered" && (event.payload as any).id === "late")
          sent.push(readies[0]!({ id: "later", text: "and another" }));
      },
    });

    assert.deepEqual(sent, [true, true]);
    assert.equal(readies.length, 1, "a second init is not a second ready");
    assert.deepEqual(story(events), [
      "assistant",
      "result",
      "steer_delivered",
      "assistant",
      "user",
      "steer_delivered",
      "assistant",
      "result",
    ]);
    assert.deepEqual(result.steered, ["late", "later"]);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Second answer, with both.", "the last result is the answer");
    assert.equal(result.turns, 3, "each result counts only its own turns");
    assert.deepEqual(
      [result.usage.input_tokens, result.usage.output_tokens],
      [40, 25],
      "each result's own tokens, added up",
    );
    assert.equal(result.usage.cost_usd, 0.3, "the cost is already the session's running total");
    assert.equal(result.sessionId, "ses_steer");
  });

  it("a stop with a message still queued reports it unread, and ends the input", { timeout }, async () => {
    const abort = new AbortController();
    const { fn, seen } = steerableQuery(async function* ({ read }) {
      await read();
      yield steerInit();
      yield toolUse("tu_1");
      const steer = (await read())!;
      yield lifecycle(steer, "queued");
      abort.abort();
      // The SDK is still reading the input when the stop lands: it must end, not hang.
      assert.equal(await read(), null);
      throw Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" });
    });
    const engine = await engineWithLogin(fn);
    const events: Array<{ type: string; payload: any }> = [];
    let send = null as Send;
    const result = await engine.delegate({
      prompt: "Run the long command",
      cwd: "/tmp/x",
      signal: abort.signal,
      steer: {
        ready: (s) => {
          send = s;
        },
      },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "assistant") assert.equal(send!({ id: "m1", text: "queued then stopped" }), true);
      },
    });
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.sessionId, "ses_steer");
    assert.deepEqual(result.steered, [], "queued is not read — the harness queues it again");
    assert.ok(!events.some((e) => e.type === "steer_delivered"));
    assert.equal(seen.inputEnded, true);
    assert.equal(send!({ id: "m2", text: "after the stop" }), false);
  });

  it("an interview session takes no input mid-turn: it is steered by interrupting it instead", {
    timeout,
  }, async () => {
    // Folded in at its question's or launch's tool result, a message would be answered by a turn
    // that had already decided; interrupted, the harness resumes it or lets the message wait.
    const { fn } = steerableQuery(async function* ({ read }) {
      await read();
      yield steerInit();
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__studio__ask_user",
              id: "tu_q",
              input: { question: "Top-down or side-on?" },
            },
          ],
        },
      };
      yield toolResult("tu_q");
      yield said("Asked.");
      yield { type: "result", subtype: "success", is_error: false, result: "Asked.", num_turns: 2, usage: {} };
      assert.equal(await read(), null, "the input ends with the answer");
    });
    const engine = await engineWithLogin(fn);
    const readies: Array<unknown> = [];
    const result = await engine.delegate({
      prompt: "interview brief",
      cwd: "/tmp/x",
      interviewTools: [
        {
          name: "ask_user",
          description: "Ask the person.",
          parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        },
      ],
      steer: {
        ready: (s) => {
          readies.push(s);
        },
      },
    });
    assert.deepEqual(readies, [null], "told once: no input mid-turn, although the CLI has message lifecycles");
    assert.deepEqual(result.studioToolCalls, [{ name: "ask_user", args: { question: "Top-down or side-on?" } }]);
    assert.deepEqual(result.steered, []);
  });

  it("a message the CLI discards is not delivered, and the input still ends", { timeout }, async () => {
    const { fn } = steerableQuery(async function* ({ read }) {
      await read();
      yield steerInit();
      yield toolUse("tu_1");
      const steer = (await read())!;
      yield lifecycle(steer, "queued");
      yield toolResult("tu_1");
      yield said("Done.");
      yield { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2, usage: {} };
      yield lifecycle(steer, "discarded");
      assert.equal(await read(), null);
    });
    const engine = await engineWithLogin(fn);
    let send = null as Send;
    const result = await engine.delegate({
      prompt: "Run the command",
      cwd: "/tmp/x",
      steer: {
        ready: (s) => {
          send = s;
        },
      },
      onEvent: (event) => {
        if (event.type === "assistant" && (event.payload as any).parts[0].type === "tool_use")
          send!({ id: "m1", text: "x" });
      },
    });
    assert.deepEqual(result.steered, []);
    assert.equal(result.summary, "Done.");
  });

  it("a message taken but never read holds the input open only until the stall passes, on the clock it is given", async () => {
    const stalls: Array<{ fire: () => void; ms: number; cancelled: boolean }> = [];
    const schedule = (fire: () => void, ms: number) => {
      const stall = { fire, ms, cancelled: false };
      stalls.push(stall);
      return () => {
        stall.cancelled = true;
      };
    };
    const readies: Send[] = [];
    const steer = steerSession((send) => readies.push(send));
    const feed = steerFeed(
      steer,
      userFrame("Run the command", []),
      new AbortController().signal,
      () => "ses_steer",
      schedule,
    );
    const input = feed.prompt[Symbol.asyncIterator]();
    const next = async () => (await input.next()) as IteratorResult<Frame>;
    assert.equal((await next()).value.message.content[0].text, "Run the command");
    feed.initialized(steerInit(), false);
    const send = readies[0]!;

    // Read in time: the stall is called off, and the input ends at the result that answers it.
    assert.equal(send({ id: "m1", text: "and X" }), true);
    const first = (await next()).value;
    feed.lifecycle(lifecycle(first, "queued"), () => {});
    feed.answered();
    assert.equal(stalls.length, 1);
    feed.lifecycle(lifecycle(first, "started"), () => {});
    assert.equal(stalls[0]!.cancelled, true, "read before the stall passed");

    // Taken during that answer and never read: nothing moves until the stall passes.
    assert.equal(send({ id: "m2", text: "and Y" }), true);
    const second = (await next()).value;
    feed.lifecycle(lifecycle(second, "queued"), () => {});
    feed.answered();
    assert.equal(stalls.length, 2);
    assert.equal(stalls[1]!.ms, STEER_STALL_MS);
    let ended = false;
    const end = next().then((result) => {
      ended = result.done === true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ended, false, "the input stays open while the message may still start");
    stalls[1]!.fire();
    await end;
    assert.equal(ended, true);
    assert.deepEqual(steer.steered, ["m1"], "the unread message reports as not delivered");
    assert.equal(send({ id: "m3", text: "too late" }), false);
    feed.dispose();
  });

  it("says null to a CLI without message lifecycles, and to a session that never reached its init", {
    timeout,
  }, async () => {
    // 2.1.281 advertises msg_lifecycle_v1; an older CLI says nothing about what it read.
    const old = steerableQuery(async function* ({ read }) {
      await read();
      yield steerInit(["interrupt_receipt_v1"]);
      yield said("hi");
      yield { type: "result", subtype: "success", is_error: false, result: "hi", num_turns: 1, usage: {} };
      assert.equal(await read(), null);
    });
    const readies: Send[] = [];
    const result = await (await engineWithLogin(old.fn)).delegate({
      prompt: "hello",
      cwd: "/tmp/x",
      steer: { ready: (send) => readies.push(send) },
    });
    assert.deepEqual(readies, [null]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.steered, []);
    assert.equal(old.seen.inputEnded, true, "the input still ends at the result");

    const failed: Send[] = [];
    const broken = await engineWithLogin(
      fakeQuery([], { throwOn: new Error("Claude usage limit reached; resets at 5pm") }).fn,
    );
    await assert.rejects(
      () => broken.delegate({ prompt: "build", cwd: "/tmp/x", steer: { ready: (send) => failed.push(send) } }),
      EngineError,
    );
    assert.deepEqual(failed, [null], "a stream that fails before init still hears ready once");

    const stopped: Send[] = [];
    const abort = new AbortController();
    abort.abort();
    const early = await (await engineWithLogin(fakeQuery(successRun).fn)).delegate({
      prompt: "build",
      cwd: "/tmp/x",
      signal: abort.signal,
      steer: { ready: (send) => stopped.push(send) },
    });
    assert.equal(early.stopReason, "stopped");
    assert.deepEqual(early.steered, []);
    assert.deepEqual(stopped, [null]);
  });

  it("a delegation without steer still sends the plain prompt, byte for byte", async () => {
    const plain = fakeQuery(successRun);
    const result = await (await engineWithLogin(plain.fn)).delegate({ prompt: "build", cwd: "/tmp/x" });
    assert.equal(plain.seen[0]!.prompt, "build");
    assert.equal("steered" in result, false);

    const stills = fakeQuery(successRun);
    await (await engineWithLogin(stills.fn)).delegate({
      prompt: "build",
      cwd: "/tmp/x",
      images: [{ label: "ref", mimeType: "image/jpeg", data: "abc" }],
    });
    const messages: unknown[] = [];
    for await (const message of stills.seen[0]!.prompt as unknown as AsyncIterable<unknown>) messages.push(message);
    assert.deepEqual(messages, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "build\n\nIMAGES ATTACHED (1): ref." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc" } },
          ],
        },
        parent_tool_use_id: null,
      },
    ]);
  });
});

describe("engine registry & fallback policy", () => {
  const engine = (id: string, kind: "direct" | "delegated", code: "ready" | "needs_login"): Engine => ({
    id,
    label: id,
    kind,
    status: async () => ({ code, detail: "" }),
    models: async () => [
      {
        id: `${id}-model`,
        label: id,
        contextWindow: 1000,
        maxTokens: 100,
        supportsTools: true,
        supportsVision: false,
        supportsThinking: false,
      },
    ],
    defaultModel: async () => `${id}-model`,
  });

  it("falls back from a throttled contractor to the local engine", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("ollama", "direct", "ready"));
    registry.register(engine("claude-code", "delegated", "ready"));
    const candidates = await registry.fallbackFor("claude-code", { kind: "rate_limit" });
    assert.deepEqual(candidates, ["ollama"], "a rate limit must fall back to something local");
  });

  it("never falls back to an engine that is not signed in", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("ollama", "direct", "needs_login"));
    registry.register(engine("claude-code", "delegated", "ready"));
    assert.deepEqual(await registry.fallbackFor("claude-code", { kind: "rate_limit" }), []);
  });

  it("does not treat a context overflow as an engine problem", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("ollama", "direct", "ready"));
    registry.register(engine("claude-code", "delegated", "ready"));
    assert.deepEqual(await registry.fallbackFor("claude-code", { kind: "context_overflow" }), []);
  });

  it("does not fall back on a sign-in failure — that hides the button the user needs", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("ollama", "direct", "ready"));
    registry.register(engine("claude-code", "delegated", "ready"));
    assert.deepEqual(await registry.fallbackFor("claude-code", { kind: "auth" }), []);
  });

  it("an outage falls back only to an engine that can do the job: tools need a direct engine", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("ollama", "direct", "ready"));
    registry.register(engine("claude-code", "delegated", "ready"));
    registry.register(engine("bonsai", "direct", "ready"));
    registry.setPreferredOrder(["ollama", "claude-code", "bonsai"]);
    // A delegated engine's complete() refuses tools: a tool loop on it dies at once.
    assert.deepEqual(await registry.fallbackFor("ollama", { kind: "unavailable" }, { tools: true }), ["bonsai"]);
    assert.deepEqual(
      await registry.fallbackFor("ollama", { kind: "unavailable" }),
      ["claude-code", "bonsai"],
      "a job with no tools may still move to a subscription",
    );
  });

  it("never moves work onto a metered API the person did not pick: no fallback, no first ready engine", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("openrouter", "direct", "ready"));
    registry.register(engine("opencode", "delegated", "ready"));
    registry.register(engine("claude-code", "delegated", "ready"));
    registry.register(engine("ollama", "direct", "ready"));
    registry.setPreferredOrder(["openrouter", "opencode", "claude-code", "ollama"]);
    assert.deepEqual(await registry.fallbackFor("claude-code", { kind: "rate_limit" }), ["ollama"]);
    assert.deepEqual(await registry.fallbackFor("ollama", { kind: "unavailable" }, { tools: true }), []);
    assert.deepEqual(await registry.fallbackFor("ollama", { kind: "unavailable" }), ["claude-code"]);
    assert.deepEqual(await registry.fallbackFor("openrouter", { kind: "unavailable" }), ["claude-code", "ollama"]);
    assert.equal((await registry.firstReady())?.id, "claude-code");
    assert.equal((await registry.firstReady("direct"))?.id, "ollama");
    // The person's own pick still reaches it: the registry holds it like any other engine.
    assert.equal(registry.get("openrouter").id, "openrouter");
  });

  it("describes engines for the picker, including unavailable ones", async () => {
    const registry = new EngineRegistry();
    registry.register(engine("ollama", "direct", "ready"));
    registry.register(engine("claude-code", "delegated", "needs_login"));
    const described = await registry.describe();
    assert.deepEqual(
      described.map((d) => d.id),
      ["ollama", "claude-code"],
    );
    assert.equal(described[1]?.status.code, "needs_login");
    assert.equal(described[0]?.defaultModel, "ollama-model");
  });
});

describe("the modeller on claude code (AG-930)", () => {
  it("exposes mcp__studio__blender__model only when the studio granted it, inside the one studio server", async () => {
    const plain = fakeQuery(successRun);
    const engine = await engineWithLogin(plain.fn);
    await engine.delegate({ prompt: "build", cwd: "/tmp/game-workspace" });
    assert.deepEqual(
      (plain.seen[0] as Record<string, unknown>).allowedTools,
      // Flipped (step 1): the pinned list now ends with the web tools.
      ["mcp__studio__checkpoint", "Bash", "WebSearch", "WebFetch"],
      "no grant, no tool — the pinned allow-list holds",
    );

    const granted = fakeQuery(successRun);
    const withTool = await engineWithLogin(granted.fn);

    await withTool.delegate({
      prompt: "build",
      cwd: "/tmp/game-workspace",
      liveTools: [
        {
          name: "blender__model",
          description: "Model a bpy script",
          parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
      ],
      onLiveTool: async () => ({ text: "Modelled" }),
    });
    const call = granted.seen[0] as Record<string, unknown>;
    assert.deepEqual(call.allowedTools, [
      "mcp__studio__checkpoint",
      "mcp__studio__blender__model",
      "Bash",
      "WebSearch",
      "WebFetch",
    ]);
    assert.deepEqual(
      Object.keys(call.mcpServers as Record<string, unknown>),
      ["studio"],
      "still exactly one MCP server",
    );
    assert.equal(call.strictMcpConfig, true);
  });
});

describe("a connector's tool on claude code (PR4)", () => {
  it("registers the connector's real schema inside the one studio server, and allows it by name", async () => {
    const script = scriptedClaude([{ tool: "srv__echo", args: { text: "hi", tags: ["a", "b"], count: 2, mode: "a" } }]);
    const engine = await engineWithLogin(script.queryFn);
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    await engine.delegate({
      prompt: "build",
      cwd: "/tmp/game-workspace",
      // Exactly what McpRegistry.toolsFor returns: the flat projection for old readers, and the
      // server's own JSON Schema beside it for the one consumer that can use it.
      liveTools: [
        {
          name: "srv__echo",
          description: "Echo the text back.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
              tags: { type: "array" },
              count: { type: "integer" },
              mode: { type: "string", description: "One of: a, b." },
            },
            required: ["text"],
          },
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "What to say back." },
              tags: { type: "array", items: { type: "string" } },
              count: { type: "integer" },
              mode: { type: "string", enum: ["a", "b"] },
            },
            required: ["text"],
          },
        },
      ],
      onLiveTool: async (name, args) => {
        seen.push({ name, args });
        return `echoed ${JSON.stringify(args)}`;
      },
    });

    const call = script.options as Record<string, unknown>;
    // A connector rides the studio's own in-process server: no second mcpServers entry, so the
    // two settings that keep the user's own MCP configuration out are untouched.
    assert.deepEqual(Object.keys(call.mcpServers as Record<string, unknown>), ["studio"]);
    assert.equal(call.strictMcpConfig, true);
    assert.ok(
      (call.allowedTools as string[]).includes("mcp__studio__srv__echo"),
      "a connector tool is allowed by the same mapping plugin tools use",
    );

    // The arguments arrive as the model sent them — an array is still an array, a number is
    // still a number. The flat projection could never have carried either.
    assert.deepEqual(seen, [{ name: "srv__echo", args: { text: "hi", tags: ["a", "b"], count: 2, mode: "a" } }]);
    assert.equal(script.calls[0]?.text, 'echoed {"text":"hi","tags":["a","b"],"count":2,"mode":"a"}');

    // And the registered schema is the connector's, not a string-shaped approximation of it.
    const schema = registeredSchema(script, "srv__echo");
    assert.ok(schema, "the studio server really registered the connector tool");
    assert.equal(schema!.safeParse({ text: "hi", tags: ["a"], count: 2, mode: "b" }).success, true);
    assert.equal(
      schema!.safeParse({ text: "hi", count: "2" }).success,
      false,
      "a string where an integer belongs is refused",
    );
    assert.equal(schema!.safeParse({ text: "hi", mode: "z" }).success, false, "a value outside the enum is refused");
    assert.equal(schema!.safeParse({ tags: ["a"] }).success, false, "a missing required argument is refused");
  });
});

describe("a failed studio tool on claude code", () => {
  it("answers the model with isError, not as a plain result", async () => {
    const script = scriptedClaude([{ tool: "boom" }, { tool: "refused" }, { tool: "fine" }]);
    const engine = await engineWithLogin(script.queryFn);
    const spec = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object" as const, properties: {} },
    });
    await engine.delegate({
      prompt: "build",
      cwd: "/tmp/game-workspace",
      liveTools: [spec("boom"), spec("refused"), spec("fine")],
      onLiveTool: async (name) => {
        if (name === "boom") throw new Error("the page is gone");
        if (name === "refused") return { text: "refused: not in this run", isError: true };
        return "done";
      },
    });
    assert.deepEqual(
      script.calls.map((c) => [c.tool, c.isError]),
      [
        ["boom", true],
        ["refused", true],
        ["fine", false],
      ],
    );
  });
});

describe("composer Claude context preferences", () => {
  /** The settings one delegation hands Claude Code, for preferences as a composer saved them. */
  async function delegatedSettings(preferences: { contextWindow?: number; fast?: boolean }) {
    let options: Record<string, unknown> = {};
    const engine = await engineWithLogin(((request: { options: Record<string, unknown> }) => {
      options = request.options;
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of successRun) yield event;
        },
      };
    }) as never);
    const cwd = await tmpDir("claude-composer-settings-");
    await engine.delegate({
      prompt: "Build a fixture",
      cwd,
      model: "opus",
      preferences,
      denyReads: [path.join(cwd, "private")],
    });
    return options.settings as {
      autoCompactWindow?: number;
      fastMode?: boolean;
      permissions: { deny: string[] };
    };
  }

  it("keeps workspace read-denial permissions whatever preferences were saved", async () => {
    const settings = await delegatedSettings({ contextWindow: 200_000, fast: true });
    assert.equal(settings.autoCompactWindow, undefined, "Claude Code compacts on its own; no window is sent");
    assert.equal(settings.fastMode, undefined, "Fast is hidden/refused until this model advertises support");
    assert.ok(settings.permissions.deny.length > 0, "saved preferences must never erase permission restrictions");
  });

  it("never sends a compaction point, even one an earlier build's picker saved", async () => {
    for (const contextWindow of [32_000, 200_000, 1_000_000, 1_500_000]) {
      const settings = await delegatedSettings({ contextWindow });
      assert.equal(settings.autoCompactWindow, undefined, `${contextWindow} is not sent: compaction is Auto only`);
    }
  });

  it("an unknown catalog limit is not guessed", async () => {
    const engine = await engineWithLogin((() => ({
      supportedModels: async () => [{ value: "future", displayName: "Future" }],
      close() {},
      async *[Symbol.asyncIterator]() {},
    })) as never);
    await engine.refreshModels();
    const models = await engine.models();
    assert.equal(models.find((model) => model.id === "future")?.contextWindow, 0);
  });
});

describe("Claude CLI model discovery", () => {
  it("initialization returns future models without sending a prompt or guessing from the CLI version", async () => {
    let turns = 0;
    let closed = false;
    let aborted = false;
    const engine = await engineWithLogin(((request: {
      prompt: AsyncIterable<unknown>;
      options: { abortController: AbortController };
    }) => {
      void (async () => {
        for await (const _message of request.prompt) turns++;
      })();
      request.options.abortController.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return {
        supportedModels: async () => [
          { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
        ],
        close() {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {},
      };
    }) as never);
    await engine.refreshModels();
    const model = (await engine.models()).find((row) => row.id === "sonnet");
    assert.equal(model?.label, "Sonnet 5.5");
    assert.equal(model?.resolvedModel, "claude-sonnet-5-5");
    assert.equal(turns, 0);
    assert.equal(closed, true);
    assert.equal(aborted, true);
  });

  it("marks the model the CLI's default resolves to, the first one listed", async () => {
    const engine = await engineWithLogin((() => ({
      supportedModels: async () => [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
        { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
      ],
      close() {},
      async *[Symbol.asyncIterator]() {},
    })) as never);
    await engine.refreshModels();
    const defaults = (await engine.models()).filter((row) => row.providerDefault).map((row) => row.id);
    assert.deepEqual(defaults, ["opus"]);
  });
});

describe("choosing a fallback when an engine's status hangs", () => {
  it("does not wait on a status that never answers: probes are bounded and side by side", async () => {
    const registry = new EngineRegistry({ statusProbeMs: 50 });
    const engine = (id: string, kind: "direct" | "delegated", status: () => Promise<unknown>) =>
      ({ id, label: id, kind, status, models: async () => [] }) as never;
    registry.register(engine("claude-code", "delegated", async () => ({ code: "ready", detail: "" })));
    registry.register(engine("stuck", "direct", () => new Promise(() => {})));
    registry.register(engine("ollama", "direct", async () => ({ code: "ready", detail: "" })));
    const started = Date.now();
    const candidates = await registry.fallbackFor("claude-code", { kind: "rate_limit" } as never);
    assert.deepEqual(candidates, ["ollama"], "the hung engine is not a candidate");
    assert.ok(Date.now() - started < 2_000, `answered on the probe's clock: ${Date.now() - started}ms`);
    assert.equal((await registry.firstReady())?.id, "claude-code");
  });
});

/**
 * Compact now on Claude Code: the chat's session compacts itself with Claude Code's own `/compact`
 * (`DelegateRequest.compact`), as the SDK documents for a resumed session, and goes on under the
 * same id. Its summary comes from the `PostCompact` hook; a refusal from the status message that
 * reports the compaction's result. The stream below is the order a live CLI 2.1 sends.
 */
describe("Compact now on claude code", () => {
  const SESSION = "ses-compact";
  /** A query that runs the session's `PostCompact` hooks as the CLI does once it has compacted. */
  function compactingQuery(messages: Array<Record<string, unknown>>, summary: string | null) {
    const seen: Array<Record<string, any>> = [];
    const fn = ((params: { prompt: unknown; options?: Record<string, any> }) => {
      seen.push({ prompt: params.prompt, ...params.options });
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            if (message.compact_result === "success" && summary !== null) {
              for (const matcher of params.options?.hooks?.PostCompact ?? []) {
                for (const hook of matcher.hooks) {
                  await hook(
                    {
                      hook_event_name: "PostCompact",
                      trigger: "manual",
                      compact_summary: summary,
                      session_id: SESSION,
                    },
                    undefined,
                    { signal: new AbortController().signal },
                  );
                }
              }
            }
            yield message;
          }
        },
      };
    }) as never;
    return { fn, seen };
  }
  const status = (fields: Record<string, unknown>) => ({
    type: "system",
    subtype: "status",
    session_id: SESSION,
    ...fields,
  });
  const init = { type: "system", subtype: "init", model: "claude-opus-5-5", tools: [], session_id: SESSION };
  const ended = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 0,
    session_id: SESSION,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  it("sends /compact to the resumed session and hands back the summary it wrote", async () => {
    const { fn, seen } = compactingQuery(
      [
        status({ status: "compacting" }),
        status({ status: null, compact_result: "success" }),
        init,
        {
          type: "system",
          subtype: "compact_boundary",
          session_id: SESSION,
          compact_metadata: { trigger: "manual", pre_tokens: 28_350, post_tokens: 1_736 },
        },
        { type: "user", message: { role: "user", content: "This session is being continued…" }, session_id: SESSION },
        ended,
      ],
      "<analysis>\nWhat the person asked, in order.\n</analysis>\n\n<summary>\n1. The plaza has a fountain.\n</summary>",
    );
    const engine = await engineWithLogin(fn);
    const events: Array<{ type: string; payload: any }> = [];
    const result = await engine.delegate({
      prompt: "",
      cwd: await tmpDir("claude-compact-"),
      resume: SESSION,
      compact: true,
      readOnly: true,
      onEvent: (event) => events.push(event),
    });

    assert.equal(seen[0]?.prompt, "/compact", "Claude Code's own command, alone");
    assert.equal(seen[0]?.resume, SESSION);
    assert.equal(result.ok, true);
    assert.equal(result.compacted, true);
    assert.equal(result.sessionId, SESSION, "the same session goes on");
    assert.equal(result.summary, "1. The plaza has a fountain.", "the summary, without the model's scratch analysis");
    assert.ok(
      events.some((e) => e.type === "context" && e.payload.compacted === true),
      "the context meter restarts",
    );
  });

  it("a compaction Claude Code refused is not compacted, and says why", async () => {
    const { fn } = compactingQuery(
      [
        status({ status: "compacting" }),
        status({ status: null, compact_result: "failed", compact_error: "Not enough messages to compact." }),
        init,
        ended,
      ],
      null,
    );
    const engine = await engineWithLogin(fn);
    const result = await engine.delegate({
      prompt: "",
      cwd: await tmpDir("claude-compact-"),
      resume: SESSION,
      compact: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.compacted, undefined);
    assert.equal(result.errorText, "Not enough messages to compact.");
    assert.equal(result.sessionId, SESSION, "the session is untouched and still resumable");
  });
});

/**
 * A provider that answers "Your organization has disabled Claude subscription access…" reports it
 * as a `success`-subtype result flagged `is_error`, in words that match none of the sign-in words.
 * Read as an ordinary failed turn, a lost account would close the run and land an unchecked build.
 * A revoked or disabled access is a sign-in failure the user has to fix.
 */
describe("an account whose access was taken away (provider lost)", () => {
  /** The words the CLI said, exactly. */
  const DISABLED =
    "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

  /** The stream as the run's log recorded it: the CLI's message as an assistant text, then the result. */
  const observed = (text: string, assistant: Record<string, unknown> = {}, result: Record<string, unknown> = {}) => [
    { type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "ses_lead", tools: [] },
    { type: "assistant", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null, ...assistant },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 5,
      total_cost_usd: 15.904740000000002,
      result: text,
      ...result,
    },
  ];

  const isAuth = (err: unknown): boolean => {
    assert.ok(err instanceof EngineError, String(err));
    assert.equal(err.kind, "auth", err.message);
    return true;
  };

  it("D1. a disabled subscription reported inside a success result is a sign-in failure, and the engine stops claiming to be ready", async () => {
    const engine = await engineWithLogin(fakeQuery(observed(DISABLED)).fn);
    await assert.rejects(
      () => engine.delegate({ prompt: "wake", cwd: "/tmp/x", resume: "ses_lead" }),
      (err: unknown) => isAuth(err) && (err as Error).message.includes("disabled Claude subscription access"),
    );
    const after = await engine.status();
    assert.equal(after.code, "needs_login");
    assert.match(after.detail, /disabled Claude subscription access/);
  });

  it("D2. a judge that meets the same answer fails on sign-in, not as some other error to retry", async () => {
    const engine = await engineWithLogin(fakeQuery(observed(DISABLED)).fn);
    await assert.rejects(
      () => engine.complete({ model: "opus", messages: [{ role: "user", content: "BUILD A vs BUILD B" }] }),
      isAuth,
    );
  });

  it("D3. the CLI's own error code on the reply decides, whatever the words, even when the result calls itself a success", async () => {
    for (const [code, text, flagged] of [
      ["oauth_org_not_allowed", "Claude Code is not available to this organization", true],
      ["account_on_hold", "Request refused", false],
      ["authentication_failed", "Request refused", true],
    ] as const) {
      const engine = await engineWithLogin(fakeQuery(observed(text, { error: code }, { is_error: flagged })).fn);
      await assert.rejects(() => engine.delegate({ prompt: "build", cwd: "/tmp/x" }), isAuth, code);
    }
  });

  it("D4. words that only look like it stay an ordinary failure (hostile inputs)", async () => {
    const lookalikes: Array<[string, Record<string, unknown>]> = [
      ["API Error: 529 Overloaded", { error: "overloaded" }],
      ["I disabled the subscription button in the HUD", {}],
      ["The organization has disabled tyre spray in the rain", {}],
      ["Your account screen is disabled until the race ends", {}],
      ["subscription access panel opened", {}],
      ["Access to the pit lane was revoked by the race director", {}],
    ];
    for (const [text, assistant] of lookalikes) {
      const engine = await engineWithLogin(fakeQuery(observed(text, assistant)).fn);
      const result = await engine.delegate({ prompt: "build", cwd: "/tmp/x" });
      assert.equal(result.ok, false, text);
      assert.equal(result.errorText, text);
      assert.equal((await engine.status()).code, "ready", `${text} leaves the sign-in alone`);
    }
    // A turn that answered after an error on its way is not a lost account.
    const recovered = [
      ...observed(DISABLED, { error: "oauth_org_not_allowed" }).slice(0, 2),
      { type: "assistant", message: { content: [{ type: "text", text: "Built it." }] }, parent_tool_use_id: null },
      { type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Built it." },
    ];
    const engine = await engineWithLogin(fakeQuery(recovered).fn);
    assert.equal((await engine.delegate({ prompt: "build", cwd: "/tmp/x" })).ok, true);
  });
});
