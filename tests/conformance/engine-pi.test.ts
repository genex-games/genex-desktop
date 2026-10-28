/**
 * Pi: a delegated harness the studio runs inside its own sandbox.
 *
 * Sessions replay a recorded JSON-mode stream (`fixtures/transcripts/pi-*`) through the engine's
 * `execFn` seam, so the translation, the command line, the sandbox and every ending are exercised
 * without the CLI, a provider or the network.
 */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PiEngine, type PiExec, type PiInvocation, piSandbox, stderrFailure } from "../../src/substrate/engines/pi.ts";
import { hostsFromPiModelsJson, parsePiModels } from "../../src/substrate/engines/pi-cli.ts";
import { translatePiEvent } from "../../src/substrate/engines/pi-events.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { EngineError, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { readFile } from "node:fs/promises";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const events = async (name: string) =>
  (await fixture(name))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const ready = async () => ({ ready: true, path: "/usr/local/bin/pi", version: "0.1.0", detail: "ok" });

async function engineWith(stream: (invocation: PiInvocation) => AsyncIterable<Record<string, unknown>>) {
  const root = await tmpDir("pi-engine-");
  const seen: PiInvocation[] = [];
  const execFn: PiExec = (invocation) => {
    seen.push(invocation);
    return stream(invocation);
  };
  const engine = new PiEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
    execFn,
    resolveCli: ready,
    listModels: () => fixture("pi-models.txt"),
  });
  return { engine, seen, root };
}

async function* replay(list: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const event of list) yield event;
}

async function game(): Promise<string> {
  const dir = await tmpDir("pi-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return dir;
}

describe("Pi's model list", () => {
  it("reads `pi --list-models`: provider/model, limits, thinking and vision", async () => {
    const listed = parsePiModels(await fixture("pi-models.txt"));
    assert.deepEqual(
      listed.map((model) => model.row.id),
      ["anthropic/claude-sonnet-4", "openai/gpt-4.1", "github-copilot/gpt-4o", "acme/custom-bot"],
    );
    const [sonnet, gpt] = listed;
    assert.equal(sonnet?.row.label, "claude-sonnet-4");
    assert.equal(sonnet?.row.contextWindow, 200_000);
    assert.equal(sonnet?.row.maxTokens, 16_400);
    assert.equal(sonnet?.row.supportsThinking, true);
    assert.equal(sonnet?.row.supportsVision, true);
    assert.deepEqual(sonnet?.hosts, ["api.anthropic.com"]);
    assert.equal(gpt?.row.supportsThinking, false);
    assert.deepEqual(gpt?.hosts, ["api.openai.com", "chatgpt.com", "auth.openai.com"]);
    assert.ok(listed[2]?.hosts.includes("api.github.com"), "Copilot reaches GitHub");
    assert.deepEqual(listed[3]?.hosts, [], "an unknown provider gets no wildcard hosts");
    const withStore = parsePiModels(await fixture("pi-models.txt"), {
      acme: ["api.acme.test"],
    });
    assert.deepEqual(withStore[3]?.hosts, ["api.acme.test"], "a custom provider reaches only its models.json host");
    assert.ok(!withStore[3]?.hosts.includes("*.amazonaws.com"));
  });

  it("takes an unknown provider's hosts only from models.json https baseUrl", () => {
    const hosts = hostsFromPiModelsJson(
      JSON.stringify({
        acme: { models: [{ baseUrl: "https://api.acme.test/v1?key=secret" }] },
        openai: { models: [{ baseUrl: "https://api.openai.com/v1" }] },
        local: { models: [{ baseUrl: "http://127.0.0.1:1234" }, { apiKey: "!echo stolen" }] },
      }),
    );
    assert.deepEqual(hosts.acme, ["api.acme.test"]);
    assert.deepEqual(hosts.openai, ["api.openai.com"]);
    assert.equal(hosts.local, undefined);
  });

  it("reads models.json as Pi writes it, providers under `providers`", () => {
    const hosts = hostsFromPiModelsJson(
      JSON.stringify({
        $schema: "https://pi.dev/schemas/models.schema.json",
        providers: {
          acme: { baseUrl: "https://llm.acme.test/v1", api: "openai-completions", apiKey: "!op read acme" },
          local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen" }] },
        },
      }),
    );
    assert.deepEqual(hosts, { acme: ["llm.acme.test"] }, "a custom provider reaches its own baseUrl, nothing else");
    const [custom] = parsePiModels(
      "provider  model  context  max-out  thinking  images\nacme  bot  32K  8K  no  no\n",
      hosts,
    );
    assert.deepEqual(custom?.hosts, ["llm.acme.test"]);
  });

  it("gives Copilot and ChatGPT sign-in the hosts Pi's catalog sends them to", () => {
    const listing = [
      "provider  model  context  max-out  thinking  images",
      "github-copilot  gpt-5  128K  16K  yes  yes",
      "openai-codex  gpt-5.1-codex  272K  128K  yes  yes",
      "deepseek  deepseek-chat  128K  8K  no  no",
    ].join("\n");
    const [copilot, codex, deepseek] = parsePiModels(listing);
    assert.ok(copilot?.hosts.includes("*.githubcopilot.com"), "the Copilot API, not only api.github.com");
    assert.ok(copilot?.hosts.includes("api.github.com"), "where its token is exchanged");
    assert.deepEqual(codex?.hosts, ["chatgpt.com", "auth.openai.com"]);
    assert.deepEqual(deepseek?.hosts, ["api.deepseek.com"]);
  });

  it("skips the header and refuses a listing that is not one", () => {
    assert.deepEqual(parsePiModels(""), []);
    assert.deepEqual(parsePiModels("provider     model                      context  max-out  thinking  images\n"), []);
    assert.throws(() => parsePiModels("Error: something broke\n"), /could not be read/);
  });
});

describe("Pi's status", () => {
  it("says what to do at each step: install, fix the install, sign in, or go", async () => {
    const root = await tmpDir("pi-status-");
    const status = (resolveCli: () => Promise<{ ready: boolean; path?: string; detail: string }>, listing = "") =>
      new PiEngine({ scratchRoot: root, resolveCli, listModels: async () => listing }).status();
    const missing = await status(async () => ({ ready: false, detail: "missing" }));
    assert.equal(missing.code, "not_installed");
    assert.match(missing.remedy ?? "", /Install Pi/);
    const broken = await status(async () => ({
      ready: false,
      path: "/x/pi",
      detail: "Required CLI options are unavailable",
    }));
    assert.equal(broken.code, "error");
    const signedOut = await status(ready);
    assert.equal(signedOut.code, "needs_login");
    assert.match(signedOut.remedy ?? "", /Sign in/);
    const go = await status(ready, await fixture("pi-models.txt"));
    assert.equal(go.code, "ready");
  });
});

describe("Pi's account", () => {
  it("is Pi's own sign-in once it lists a model, and no one's before", async () => {
    const root = await tmpDir("pi-account-");
    const empty = await new PiEngine({
      scratchRoot: root,
      resolveCli: ready,
      listModels: async () => "provider     model                      context  max-out  thinking  images\n",
    }).account();
    assert.equal(empty.source, "none");
    const signedIn = await new PiEngine({
      scratchRoot: root,
      resolveCli: ready,
      listModels: () => fixture("pi-models.txt"),
    }).account();
    assert.equal(signedIn.source, "system");
    assert.deepEqual(signedIn.cli, { state: "ready", path: "/usr/local/bin/pi", version: "0.1.0" });
  });
});

describe("Pi's events", () => {
  it("mirrors JSON-mode text, tools, usage and the session id", async () => {
    const stream = await events("pi-run.jsonl");
    const seen: DelegateEvent[] = [];
    let sessionId: string | undefined;
    let text = "";
    let usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number } = {};
    for (const event of stream) {
      const translated = translatePiEvent(event);
      if (translated.sessionId) sessionId = translated.sessionId;
      if (translated.text) text = translated.text;
      if (translated.usage) usage = { ...usage, ...translated.usage };
      seen.push(...(translated.events as DelegateEvent[]));
    }
    assert.equal(sessionId, "sess-pi-1");
    assert.equal(text, "Hello from Pi.");
    assert.equal(usage.input_tokens, 12);
    assert.equal(usage.output_tokens, 5);
    assert.equal(usage.cost_usd, 0.01);
    assert.ok(seen.some((event) => event.type === "assistant"));
    assert.ok(seen.some((event) => event.type === "user"));
  });
});

describe("Pi's sessions", () => {
  it("runs `pi --mode json` in the game folder, resumes by --session-id, and stops on abort", async () => {
    const cwd = await game();
    const { engine, seen } = await engineWith(() => replay([]));
    const result = await engine.delegate({
      cwd,
      prompt: "Build a hut",
      model: "anthropic/claude-sonnet-4",
      effort: "high",
      onEvent: () => {},
    });
    assert.equal(result.ok, true);
    const first = seen[0];
    assert.ok(first);
    assert.deepEqual(first.argv.slice(0, 2), ["--mode", "json"]);
    assert.ok(first.argv.includes("--no-extensions"));
    assert.ok(!first.argv.includes("--offline"), "a session still needs the model host");
    assert.ok(first.argv.includes("--session-id"));
    assert.ok(first.argv.includes("--model"));
    assert.equal(first.argv[first.argv.indexOf("--model") + 1], "anthropic/claude-sonnet-4");
    assert.equal(first.argv[first.argv.indexOf("--thinking") + 1], "high");
    assert.equal(first.cwd, await realpath(cwd));
    assert.match(first.prompt, /Build a hut/);
    assert.ok(first.sandbox.readableHome?.some((home) => home.includes(".pi")));

    const resumed = await engine.delegate({
      cwd,
      prompt: "Again",
      resume: "sess-pi-1",
      onEvent: () => {},
    });
    assert.equal(resumed.sessionId, "sess-pi-1");
    assert.equal(seen[1]?.argv[seen[1].argv.indexOf("--session-id") + 1], "sess-pi-1");

    const controller = new AbortController();
    controller.abort();
    const stopped = await engine.delegate({
      cwd,
      prompt: "Stop me",
      signal: controller.signal,
      onEvent: () => {},
    });
    assert.equal(stopped.ok, false);
    assert.match(stopped.errorText ?? "", /stopped/i);
  });

  it("replays a recorded stream into a completed build", async () => {
    const cwd = await game();
    const stream = await events("pi-run.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Hello from Pi.");
    assert.equal(result.sessionId, "sess-pi-1");
    assert.equal(result.usage.input_tokens, 12);
  });

  it("throws when compact is asked of Pi", async () => {
    const cwd = await game();
    const { engine } = await engineWith(() => replay([]));
    await assert.rejects(
      () => engine.delegate({ cwd, prompt: "x", compact: true, onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.message.includes("compacts"),
    );
  });
});

describe("Pi's sandbox", () => {
  it("writes the game folder and Pi's own home, and denies the studio's secrets", () => {
    const sandbox = piSandbox({
      runDir: "/game",
      gameDir: "/game",
      gitDirs: [],
      scratchDir: "/tmp/scratch",
      secretPaths: ["/secrets"],
      home: "/Users/dev",
    });
    assert.ok(sandbox.writableRoots.includes("/game"));
    assert.ok(
      sandbox.writableRoots.includes(path.join("/Users/dev", ".pi", "agent", "sessions")),
      "a session may write its own transcripts",
    );
    assert.ok(
      sandbox.writableRoots.includes(path.join("/Users/dev", ".pi", "agent", "auth.json.lock")),
      "Pi creates a lock folder even to read auth.json",
    );
    assert.equal(sandbox.ownHome, undefined, "`~/.pi` is not a write grant: a session must not rewrite it");
    assert.deepEqual(sandbox.readableHome, [path.join("/Users/dev", ".pi")], "the CLI still reads its sign-ins");
    assert.ok(sandbox.secretPaths.includes("/secrets"));
    const denied = sandbox.denyWrite ?? [];
    for (const leaf of [
      "auth.json",
      "settings.json",
      "models.json",
      "models-store.json",
      "extensions",
      "skills",
      "npm",
      "bin",
      "tools",
      "prompts",
    ])
      assert.ok(
        denied.some((p) => p.endsWith(`${path.sep}${leaf}`)),
        `a session cannot plant ${leaf} that later runs unsandboxed`,
      );
    assert.ok(
      denied.some((p) => p === path.join("/game", ".pi")),
      "a game's own .pi folder is not the session's to plant",
    );
  });

  it("leaves Pi's home readable and writable only where a session must write", async () => {
    const home = os.homedir();
    const piHome = path.join(home, ".pi");
    const agent = path.join(piHome, "agent");
    const box = await ProcessSandbox.create({
      ...piSandbox({ runDir: "/game", gameDir: "/game", gitDirs: [], scratchDir: "/tmp/pi-scratch", secretPaths: [] }),
      enabled: false,
    });
    const writes = (dir: string) => box.policy.allowWrite.some((root) => dir === root || dir.startsWith(`${root}/`));
    assert.ok(writes(path.join(agent, "sessions")), "a session writes its transcripts");
    assert.ok(writes(path.join(agent, "auth.json.lock")), "Pi makes a lock folder even to read auth.json");
    for (const planted of ["bin", "tools", "prompts", "extensions", "skills", "npm", "agents"])
      assert.ok(!writes(path.join(agent, planted)), `a session cannot plant agent/${planted}, which runs outside it`);
    assert.ok(!writes(path.join(home, ".pi", "AGENTS.md")), "nor the instructions its sign-in reads");
    assert.ok(!box.policy.denyRead.includes(piHome), "the CLI reads its own sign-ins");
    assert.ok(!box.policy.denyWrite.includes(piHome), "a deny on the whole store would cut those two write grants");
  });
});

describe("Pi's JSON stream", () => {
  it("takes one reply's usage from the last snapshot, not the sum of every delta", async () => {
    const cwd = await game();
    const stream = await events("pi-stream.jsonl");
    const mirrored: DelegateEvent[] = [];
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: (event) => mirrored.push(event) });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Hello from Pi.");
    assert.equal(result.turns, 1, "one assistant reply is one turn");
    assert.equal(result.usage.input_tokens, 100, "cumulative input, not 100+100");
    assert.equal(result.usage.output_tokens, 2, "cumulative output, not 1+2");
    assert.equal(result.usage.cost_usd, 0.02);
    const assistants = mirrored.filter((event) => event.type === "assistant");
    assert.equal(assistants.length, 1, "message_end is the one chat row, not each delta");
    assert.ok(
      mirrored.some((event) => event.type === "text_delta"),
      "deltas still stream for the live display",
    );
  });

  it("a rate-limit retry that gives up is a failure, not an empty success", async () => {
    const cwd = await game();
    const stream = await events("pi-error.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "rate_limit",
    );
  });

  it("a retry that succeeds after message_end error is a success, not a leftover failure", async () => {
    const cwd = await game();
    const stream = await events("pi-retry.jsonl");
    const mirrored: DelegateEvent[] = [];
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: (event) => mirrored.push(event) });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Hello after retry.");
    assert.ok(
      !mirrored.some((event) => event.type === "result" && (event.payload as { subtype?: string }).subtype === "error"),
    );
  });

  it("an expired sign-in says to sign in to Pi again", async () => {
    const cwd = await game();
    const stream = await events("pi-expired.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
    );
  });

  it("a read-only auth.json that cannot refresh says to sign in to Pi again", async () => {
    const cwd = await game();
    const stream = await events("pi-eperm.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
    );
  });

  it("Pi dying because auth.json cannot be written says to sign in again", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-eperm" };
      throw new Error(
        "Credential store modify failed for openai: EPERM: operation not permitted, open '/Users/dev/.pi/agent/auth.json'",
      );
    });
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
    );
  });

  it("reads a provider status only where Pi puts it, at the head of the error", () => {
    const failure = (errorMessage: string) =>
      translatePiEvent({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage },
      }).pendingFailure;
    assert.equal(failure('401: {"error":{"message":"invalid key"}}')?.status, 401);
    assert.equal(failure("429 rate limited")?.status, 429, "Pi's retry errors carry the status first");
    assert.equal(
      failure('500: {"error":{"message":"upstream said 429"}}')?.status,
      500,
      "a number in the body is text",
    );
    assert.equal(failure("Bad Request: model not found")?.status, null, "no status, no guess");
  });

  it("a failure that only reads like a sign-in problem is not one", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-prose" };
      yield {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "not signed in, said the proxy" },
      };
      yield { type: "agent_end", willRetry: false };
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /said the proxy/);
  });

  it("a permission failure on a file that is not the credential store is not a sign-in problem", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-eperm-other" };
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "EPERM: operation not permitted, open '/game/out.js'",
        },
      };
      yield { type: "agent_end", willRetry: false };
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /out\.js/);
  });

  it("keeps a credential out of the error a failed Pi process leaves in the chat", () => {
    const failed = stderrFailure("Error: provider rejected Bearer sk-live-abc123def456", 1);
    assert.doesNotMatch(failed.message, /sk-live-abc123def456/);
    assert.match(failed.message, /\[redacted\]/);
    assert.match(stderrFailure("\n", 2).message, /exited with 2/);
  });

  it("a refused model ends as an error, not an empty answer", async () => {
    const cwd = await game();
    const stream = await events("pi-refusal.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", model: "anthropic/claude-sonnet-4", onEvent: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /model not found/i);
  });

  it("a non-zero exit after events is a failure", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-exit" };
      throw new Error("Pi exited with 1");
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.ok, false);
    assert.match(result.errorText ?? "", /exited with 1/);
  });
});

describe("Pi's plan and one-shot answers", () => {
  it("keeps bash in Plan so the studio tools bridge can run", async () => {
    const cwd = await game();
    const { engine, seen } = await engineWith(() => replay([]));
    await engine.delegate({
      cwd,
      prompt: "Plan it",
      permissions: {
        mode: PermissionMode.Plan,
        allow: [],
        directories: [],
        protectWrites: [],
        ask: async () => ({ decision: "allow" as const }),
      },
      interviewTools: [{ name: "ask_user", description: "ask", parameters: { type: "object", properties: {} } }],
      onEvent: () => {},
    });
    const tools = seen[0]?.argv[seen[0].argv.indexOf("--tools") + 1] ?? "";
    assert.match(tools, /\bbash\b/, "Plan still has bash for node .studio/bridge/tool.mjs");
  });

  it("answers a judge with no tools", async () => {
    const stream = await events("pi-run.jsonl");
    const { engine, seen } = await engineWith(() => replay(stream));
    const response = await engine.complete({
      systemPrompt: "You judge builds.",
      messages: [{ role: "user", content: "A or B?" }],
    });
    assert.equal(response.message.content, "Hello from Pi.");
    assert.equal(response.engine, "pi");
    assert.ok(seen[0]?.argv.includes("--no-tools"));
    await assert.rejects(
      engine.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "t", parameters: { type: "object", properties: {} } }],
      }),
      /no studio tools/,
    );
  });
});

/**
 * Streams recorded from a real `pi --mode json` (1.4.0) against a local stand-in endpoint
 * (`fixtures/transcripts/pi-recorded/README.md`): Pi's own events, retries, stop reasons and usage.
 */
describe("Pi's recorded JSON stream", () => {
  const recorded = (name: string) => events(path.join("pi-recorded", `${name}.jsonl`));
  const run = async (name: string) => {
    const cwd = await game();
    const stream = await recorded(name);
    const mirrored: DelegateEvent[] = [];
    const { engine } = await engineWith(() => replay(stream));
    const settled = engine
      .delegate({ cwd, prompt: "Say hello", onEvent: (event) => mirrored.push(event) })
      .then((result) => ({ result, error: null }))
      .catch((error: unknown) => ({ result: null, error }));
    return { ...(await settled), mirrored };
  };
  const errorRows = (mirrored: DelegateEvent[]) =>
    mirrored.filter((event) => event.type === "result" && (event.payload as { subtype?: string }).subtype === "error");

  it("adds one reply's usage once, from message_end, however many deltas carried it", async () => {
    const { result, mirrored } = await run("ok");
    assert.equal(result?.ok, true);
    assert.equal(result?.usage.input_tokens, 120, "five message_update snapshots of 120 are still 120");
    assert.equal(result?.usage.output_tokens, 7);
    assert.equal(mirrored.filter((event) => event.type === "text_delta").length, 3, "each delta streams live");
  });

  it("sums usage across replies, one message_end each", async () => {
    const { result } = await run("tool");
    assert.equal(result?.ok, true);
    assert.equal(result?.summary, "Done: genex.");
    assert.equal(result?.usage.input_tokens, 250, "100 + 150");
    assert.equal(result?.usage.output_tokens, 12, "5 + 7");
  });

  it("makes one chat row per reply, not one per delta, and does not repeat the text", async () => {
    const { result, mirrored } = await run("ok");
    const rows = mirrored.filter((event) => event.type === "assistant");
    assert.equal(rows.length, 1);
    assert.equal(result?.turns, 1);
    assert.equal(result?.summary, "Hello from Pi.");
    const said = JSON.stringify(rows[0]?.payload);
    assert.equal(said.split("Hello from Pi.").length - 1, 1, "message_end's text appears once");
  });

  it("a rate limit Pi gave up retrying is a rate-limit failure, not an empty success", async () => {
    const { result, error } = await run("ratelimit");
    assert.equal(result, null);
    assert.ok(error instanceof EngineError && error.kind === "rate_limit", String(error));
  });

  it("a retry that then succeeds ends as that success, with no error left in the chat", async () => {
    const { result, mirrored } = await run("flaky");
    assert.equal(result?.ok, true);
    assert.equal(result?.summary, "Hello from Pi.");
    assert.equal(result?.usage.input_tokens, 120, "the failed attempt reported no usage");
    assert.deepEqual(errorRows(mirrored), []);
  });

  it("a model the provider does not have is an error with the provider's words", async () => {
    const { result, error } = await run("badmodel");
    const said = result?.errorText ?? (error instanceof Error ? error.message : "");
    assert.notEqual(result?.ok, true);
    assert.match(said, /does not exist/);
  });

  it("a 401 says to sign in to Pi again", async () => {
    const { error } = await run("auth");
    assert.ok(error instanceof EngineError && error.kind === "auth", String(error));
    assert.match(error.message, /sign in to Pi again/i);
  });

  it("a filtered reply with no text is an error, not an empty answer", async () => {
    const { result } = await run("refusal");
    assert.equal(result?.ok, false);
    assert.equal(result?.stopReason, "error");
    assert.match(result?.errorText ?? "", /content_filter/);
  });

  it("no network is an error once Pi stops retrying", async () => {
    const { result, error } = await run("nonetwork");
    const said = result?.errorText ?? (error instanceof Error ? error.message : "");
    assert.notEqual(result?.ok, true);
    assert.match(said, /Connection error/);
  });

  it("reads the failed message inside a nested stream error, not [object Object]", () => {
    const translated = translatePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" },
      },
    });
    assert.equal(translated.pendingFailure?.message, "429 rate limited");
    assert.equal(translated.pendingFailure?.status, 429);
  });
});
