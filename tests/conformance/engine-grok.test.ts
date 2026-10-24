/**
 * Grok Build: a delegated harness the studio runs inside its own sandbox.
 *
 * The streams were recorded from the real Grok Build CLI 1.0.70 (`fixtures/transcripts/grok-*`),
 * so the translation, the command line, the environment, the sandbox and every ending are exercised
 * without an account or the network. The signed-out probe and the signed-out run are the CLI on its
 * own; every other recording had the CLI talk to a scripted stand-in for xAI's API (the model's
 * words and xAI's error bodies are the stand-in's, the events around them the CLI's). None comes
 * from a real Grok account yet.
 */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { grokEnv, grokTurnArgv, parseGrokProbe, type GrokProbe } from "../../src/substrate/engines/grok-cli.ts";
import { grokStderrStatus, grokStream, parseGrokLine } from "../../src/substrate/engines/grok-events.ts";
import { GrokEngine, grokEvents, type GrokExec, type GrokInvocation } from "../../src/substrate/engines/grok.ts";
import { EngineError, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const events = async (name: string) =>
  (await fixture(name))
    .split("\n")
    .map(parseGrokLine)
    .filter((event): event is Record<string, unknown> => event !== null);

/** A recorded stream through one translator, everything it said gathered. */
async function translate(name: string) {
  const stream = grokStream();
  const said = [...(await events(name)).map((event) => stream.translate(event)), stream.flush()];
  const mirrored = said.flatMap((part) => part.events);
  return {
    said,
    rows: mirrored.filter((event) => event.type === "assistant" || event.type === "user" || event.type === "result"),
    deltas: mirrored.filter((event) => event.type === "text_delta"),
    sessionId: said.findLast((part) => part.sessionId)?.sessionId,
    failure: said.findLast((part) => part.failure)?.failure,
  };
}

const parts = (row: { payload: unknown }) => (row.payload as { parts: Array<Record<string, unknown>> }).parts;

describe("Grok Build's stream", () => {
  it("mirrors a build as the chat's rows: a thought, the reply, each tool call with its result, the summary", async () => {
    const { rows, sessionId } = await translate("grok-run-1.0.70.jsonl");
    const shapes = rows.flatMap((row) => parts(row).map((part) => `${row.type}:${String(part.type)}`));
    assert.deepEqual(shapes, [
      "assistant:thinking",
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:text",
    ]);
    const [thought, reply, shell, shellResult, read, readResult, summary] = rows.map((row) => parts(row)[0] ?? {});
    assert.equal(thought?.text, "I need to create a file.");
    assert.equal(reply?.text, "I'll write the file now.", "a reply's chunks are one row");
    assert.deepEqual(
      { name: shell?.name, id: shell?.id, input: shell?.input },
      { name: "Bash", id: "call_60", input: "echo hello > hello.txt && cat hello.txt" },
      "Grok's shell reads as the Bash call it is",
    );
    assert.deepEqual(
      { id: shellResult?.tool_use_id, error: shellResult?.is_error, content: shellResult?.content },
      { id: "call_60", error: false, content: "hello\n" },
    );
    assert.equal(read?.name, "Read");
    assert.match(String(read?.input), /hello\.txt/);
    assert.equal(readResult?.tool_use_id, read?.id, "a result answers its own call, by id");
    assert.equal(summary?.text, "Done: hello.txt says hello.");
    assert.equal(sessionId, "01a16f21-8c48-70b1-9a25-a7b9d5c998e2");
  });

  it("streams each reply's words as they arrive, one stream per reply", async () => {
    const { deltas } = await translate("grok-run-1.0.70.jsonl");
    const streams = new Map<string, string>();
    for (const event of deltas) {
      const { streamId, delta } = event.payload as { streamId: string; delta: string };
      streams.set(streamId, (streams.get(streamId) ?? "") + delta);
    }
    assert.deepEqual([...streams.values()], ["I'll write the file now.", "Done: hello.txt says hello."]);
  });

  it("counts the turn's tokens as the CLI's own total, uncached input apart from cache reads", async () => {
    const { said } = await translate("grok-run-1.0.70.jsonl");
    const ended = said.findLast((part) => part.totals);
    assert.deepEqual(ended?.totals, {
      input_tokens: 1500,
      output_tokens: 95,
      cache_read_tokens: 14_700,
      cache_write_tokens: 0,
      reasoning_tokens: 20,
    });
    assert.equal(ended?.turns, 3, "the model rounds the CLI counted");
    const responses = said.filter((part) => part.usage);
    assert.equal(responses.length, 3, "one reading per model response, for a run cut short");
    assert.deepEqual(
      responses.map((part) => part.promptTokens),
      [5200, 5400, 5600],
      "each response's whole prompt, cached or not: the context it filled",
    );
  });

  it("reads a refused or failed call as an error result, so the chat shows it failed", async () => {
    const { rows } = await translate("grok-refused-command-1.0.70.jsonl");
    const result = rows.flatMap(parts).find((part) => part.type === "tool_result");
    assert.equal(result?.is_error, true);
    assert.match(String(result?.content), /cancelled/);
  });

  it("says a failure with the status xAI answered, from the error's own fields", async () => {
    assert.deepEqual((await translate("grok-auth-failed-1.0.70.jsonl")).failure?.status, 401);
    assert.deepEqual((await translate("grok-model-refused-1.0.70.jsonl")).failure?.status, 404);
    const signedOut = (await translate("grok-not-signed-in-1.0.70.jsonl")).failure;
    assert.equal(signedOut?.status, null, "no status: the engine asks the CLI whether it is signed in");
    assert.match(String(signedOut?.message), /grok login/);
    const limited = await translate("grok-rate-limit-1.0.70.jsonl");
    assert.equal(limited.failure?.status, null, "Grok's own error names no status after its retries");
    assert.equal(
      grokStderrStatus(await fixture("grok-rate-limit-1.0.70.stderr")),
      429,
      "its error log does, as a field",
    );
    assert.equal(
      grokStderrStatus("ERROR something status=oops\nWARN status=500 other"),
      null,
      "only an error line counts",
    );
    assert.equal(grokStderrStatus(""), null);
  });

  it("reports a compaction and the session it kept", async () => {
    const { said, sessionId } = await translate("grok-compact-1.0.70.jsonl");
    assert.ok(said.some((part) => part.compacted));
    assert.equal(sessionId, "01a16f21-8c48-70b1-9a25-a7b9d5c998e2");
  });

  it("reads a studio bridge command as the studio tool it calls", () => {
    const stream = grokStream();
    const out = stream.translate({
      type: "tool_call",
      toolCallId: "call_9",
      toolName: "run_terminal_command",
      status: "pending",
      rawInput: { command: "node .studio/bridge/tool.mjs capture --json '{}'", description: "Look at the game" },
    });
    assert.equal(parts(out.events[0] as { payload: unknown })[0]?.name, "mcp__studio__capture");
  });

  it("ignores lines it does not know and lines that are not events", () => {
    assert.equal(parseGrokLine("warning: grok-4.7 has no effort levels"), null);
    assert.equal(parseGrokLine("[1,2]"), null);
    assert.deepEqual(grokStream().translate({ type: "available_commands", tools: [] }).events, []);
    assert.deepEqual(grokStream().translate({ type: "something_new" }).events, []);
  });
});

const probed = async (name: string): Promise<GrokProbe> => parseGrokProbe((await fixture(name)).split("\n"));
const SIGNED_IN = "grok-probe-signed-in-1.0.70.jsonl";
const ready = async () => ({
  ready: true,
  path: "/Users/me/.grok/bin/grok",
  version: "grok 1.0.70 (f50904eaee6c)",
  detail: "ok",
});

async function* replay(list: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const event of list) yield event;
}

/** An engine whose sessions replay `stream`, recording each invocation and the prompt it was handed. */
async function engineWith(
  stream: (invocation: GrokInvocation) => AsyncIterable<Record<string, unknown>>,
  options: { probe?: string; home?: string } = {},
) {
  const root = await tmpDir("grok-engine-");
  const seen: GrokInvocation[] = [];
  const prompts: unknown[] = [];
  const execFn: GrokExec = async function* (invocation) {
    seen.push(invocation);
    const file = invocation.argv[invocation.argv.indexOf("--prompt-file") + 1];
    if (invocation.argv.includes("--prompt-file") && file) prompts.push(JSON.parse(await readFile(file, "utf8")));
    yield* stream(invocation);
  };
  const engine = new GrokEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
    home: options.home ?? path.join(root, "home", ".grok"),
    execFn,
    resolveCli: ready,
    probe: () => probed(options.probe ?? SIGNED_IN),
  });
  return { engine, seen, prompts, root };
}

async function game(): Promise<string> {
  const dir = await tmpDir("grok-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return dir;
}

const flag = (argv: readonly string[] | undefined, name: string) => {
  const at = argv?.indexOf(name) ?? -1;
  return at < 0 ? undefined : argv?.[at + 1];
};

describe("Grok Build's sign-in and models", () => {
  it("reads whose sign-in Grok runs on and the models it offers, from the CLI's own typed answers", async () => {
    const signedOut = await probed("grok-probe-signed-out-1.0.70.jsonl");
    assert.deepEqual(signedOut.account, { method: null, email: null, blocked: null });
    const [latest, older] = signedOut.models;
    assert.deepEqual(
      { id: latest?.id, label: latest?.label, context: latest?.contextWindow, default: latest?.providerDefault },
      { id: "grok-4.6", label: "Grok 4.6", context: 500_000, default: true },
    );
    assert.deepEqual(latest?.efforts, ["low", "medium", "high", "xhigh"], "least to most, as the composer lists them");
    assert.equal(latest?.defaultEffort, "high");
    assert.equal(older?.providerDefault, undefined);
    assert.equal(latest?.supportsVision, true, "Grok takes pictures in a prompt");
    assert.equal((await probed("grok-probe-api-key-1.0.70.jsonl")).account.method, "xai.api_key");
    const signedIn = await probed(SIGNED_IN);
    assert.equal(signedIn.account.method, "cached_token", "the person's own `grok login`");
    assert.deepEqual(
      signedIn.models.map((model) => [model.id, model.contextWindow]),
      [
        ["grok-4.6", 500_000],
        ["grok-4.7", 256_000],
        ["grok-code-fast-1", 256_000],
      ],
    );
    assert.throws(() => parseGrokProbe(["not json", "{}"]), /could not be read/);
  });

  it("says what to do at each step: install, fix the install, sign in, or go", async () => {
    const at = (resolveCli: () => Promise<{ ready: boolean; path?: string; detail: string }>, probe = SIGNED_IN) =>
      new GrokEngine({ resolveCli, probe: () => probed(probe) }).status();
    const missing = await at(async () => ({ ready: false, detail: "missing" }));
    assert.equal(missing.code, "not_installed");
    assert.match(missing.remedy ?? "", /Install Grok Build/);
    const broken = await at(async () => ({
      ready: false,
      path: "/x/grok",
      detail: "Required CLI options are unavailable",
    }));
    assert.deepEqual([broken.code, broken.detail], ["error", "Required CLI options are unavailable"]);
    const signedOut = await at(ready, "grok-probe-signed-out-1.0.70.jsonl");
    assert.equal(signedOut.code, "needs_login");
    assert.match(signedOut.remedy ?? "", /Sign in to Grok/);
    const go = await at(ready);
    assert.deepEqual([go.code, go.detail], ["ready", "Grok Build 1.0.70, 3 models"]);
    const silent = await new GrokEngine({
      resolveCli: ready,
      probe: async () => {
        throw new Error("grok agent did not answer");
      },
    }).status();
    assert.equal(silent.code, "error", "a CLI that does not answer is never called signed out");
  });

  it("is the CLI's own sign-in once it says one, and no one's before", async () => {
    const { engine } = await engineWith(() => replay([]));
    assert.equal((await engine.account()).source, "system");
    assert.equal((await engine.account()).cli.version, "grok 1.0.70 (f50904eaee6c)");
    const signedOut = await engineWith(() => replay([]), { probe: "grok-probe-signed-out-1.0.70.jsonl" });
    assert.equal((await signedOut.engine.account()).source, "none");
  });
});

describe("Grok Build sessions", () => {
  it("builds from a prompt file, approving calls only inside the studio's sandbox, and mirrors every event", async () => {
    const { engine, seen, prompts } = await engineWith(async function* () {
      yield* await events("grok-run-1.0.70.jsonl");
    });
    const cwd = await game();
    const mirrored: DelegateEvent[] = [];
    const result = await engine.delegate({ cwd, prompt: "Make hello.txt", onEvent: (event) => mirrored.push(event) });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Done: hello.txt says hello.");
    assert.equal(result.sessionId, "01a16f21-8c48-70b1-9a25-a7b9d5c998e2");
    assert.equal(result.billing, "subscription", "the person's own Grok sign-in is their plan, not a bill");
    assert.deepEqual(
      { input: result.usage.input_tokens, cached: result.usage.cache_read_tokens, output: result.usage.output_tokens },
      { input: 1500, cached: 14_700, output: 95 },
    );
    assert.equal(result.contextTokens, 5600, "the last response's whole prompt");
    const [invocation] = seen;
    const argv = invocation?.argv ?? [];
    assert.equal(flag(argv, "--output-format"), "streaming-json");
    assert.equal(flag(argv, "--cwd"), invocation?.cwd);
    assert.equal(flag(argv, "--sandbox"), "off", "the studio's sandbox holds it, never a second one inside");
    assert.ok(argv.includes("--always-approve"), "nobody is there to approve a build's calls");
    assert.ok(argv.includes("--no-wait-for-background"), "nothing it starts outlives the turn");
    assert.match(flag(argv, "--disallowed-tools") ?? "", /ask_user_question/);
    assert.equal(flag(argv, "--model"), undefined, "with no pick, Grok's own default runs");
    assert.deepEqual(prompts[0], [{ type: "text", text: (prompts[0] as Array<{ text: string }>)[0]?.text }]);
    assert.match((prompts[0] as Array<{ text: string }>)[0]?.text ?? "", /^Make hello\.txt/);
    assert.equal(invocation?.cwd, await realpath(cwd), "a build runs in its workspace");
    assert.deepEqual(invocation?.domains, [
      "api.x.ai",
      "cli-chat-proxy.grok.com",
      "auth.x.ai",
      "accounts.x.ai",
      "grok.com",
    ]);
    const rows = mirrored.filter((event) => event.type === "assistant" || event.type === "user");
    assert.equal(rows.length, 7);
    assert.ok(
      mirrored.some((event) => event.type === "context"),
      "how full the context is, after each response",
    );
  });

  it("runs on the person's own Grok home, never an xAI key, and loads none of their other tools' servers or hooks", async () => {
    const home = path.join(os.tmpdir(), "grok-home-example", ".grok");
    const env = grokEnv(home);
    assert.equal(env.GROK_HOME, home, "named outright: on Windows the sandbox's own user runs it");
    assert.equal(env.XAI_API_KEY, undefined);
    for (const name of [
      "GROK_CLAUDE_MCPS_ENABLED",
      "GROK_CLAUDE_HOOKS_ENABLED",
      "GROK_CURSOR_MCPS_ENABLED",
      "GROK_MEMORY",
    ])
      assert.equal(env[name], "0", name);
    assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
    assert.equal(env.RUST_LOG, "error", "its error log names a failed call's status");
    const { engine, seen } = await engineWith(() => replay([]), { home });
    await engine.delegate({ cwd: await game(), prompt: "x" });
    const sandbox = seen[0]?.sandbox;
    assert.deepEqual(sandbox?.ownHome, [home], "its own home: the sign-in it reads and the sessions it keeps");
    assert.ok(
      sandbox?.denyWrite?.some((dir) => dir.endsWith(`${path.sep}.grok`)),
      "a game's own Grok settings stay as they are",
    );
  });

  it("puts a picked model, an effort it offers and the pictures into the turn; an effort it does not offer stays out", async () => {
    const { engine, seen, prompts } = await engineWith(() => replay([]), {
      probe: "grok-probe-signed-out-1.0.70.jsonl",
    });
    await engine.models();
    await engine.refreshModels(true);
    const cwd = await game();
    await engine.delegate({
      cwd,
      prompt: "Match this",
      model: "grok-4.6",
      effort: "xhigh",
      resume: "01a16f21",
      images: [{ label: "reference", mimeType: "image/png", data: "aGk=" }],
    });
    await engine.delegate({ cwd, prompt: "x", model: "grok-4.5", effort: "xhigh" });
    const [first, second] = seen.map((invocation) => invocation.argv);
    assert.equal(flag(first, "--model"), "grok-4.6");
    assert.equal(flag(first, "--reasoning-effort"), "xhigh");
    assert.equal(flag(first, "--resume"), "01a16f21");
    assert.equal(flag(second, "--reasoning-effort"), undefined, "Grok 4.5 has no xhigh");
    assert.deepEqual((prompts[0] as unknown[])[1], { type: "image", data: "aGk=", mimeType: "image/png" });
  });

  it("runs a read-only session from a scratch folder, the only one its sandbox lets it write, with no editing tools", async () => {
    const { engine, seen, root } = await engineWith(async function* (invocation) {
      await access(path.join(invocation.cwd, ".studio", "bridge", "tool.mjs"), constants.R_OK);
      yield* replay([]);
    });
    const result = await engine.delegate({
      cwd: await game(),
      prompt: "Judge the build",
      readOnly: true,
      interviewTools: [{ name: "ask_user", description: "ask", parameters: { type: "object", properties: {} } }],
    });
    assert.equal(result.ok, true);
    const [invocation] = seen;
    assert.ok(invocation?.cwd.startsWith(path.join(root, "scratch")), "never the game folder");
    const argv = invocation?.argv ?? [];
    assert.ok(
      argv.includes("--always-approve"),
      "a refused call would end its turn: the sandbox, not Grok's ask mode, keeps the game as it is",
    );
    assert.match(flag(argv, "--disallowed-tools") ?? "", /search_replace,write/);
    assert.deepEqual(invocation?.sandbox.writableRoots, [invocation?.cwd], "it writes only its own folder");
  });

  it("a blind judge has the shell alone, approved only for the studio bridge, and no web", async () => {
    const { engine, seen, prompts } = await engineWith(() => replay([]));
    await engine.delegate({
      cwd: await game(),
      prompt: "Play it",
      blind: true,
      readOnly: true,
      liveTools: [{ name: "press", description: "press", parameters: { type: "object", properties: {} } }],
      onLiveTool: async () => "ok",
    });
    const argv = seen[0]?.argv ?? [];
    assert.equal(flag(argv, "--tools"), "run_terminal_command");
    assert.ok(!argv.includes("--always-approve"), "a headless run refuses every call nobody approved");
    assert.equal(flag(argv, "--allow"), "Bash(node .studio/bridge/tool.mjs *)");
    assert.ok(argv.includes("--disable-web-search"));
    assert.match((prompts[0] as Array<{ text: string }>)[0]?.text ?? "", /JUDGE BY PLAYING/);
  });

  it("plans in Plan: read-only, from a folder of its own", async () => {
    const { engine, seen, prompts } = await engineWith(() => replay([]));
    const cwd = await game();
    await engine.delegate({
      cwd,
      prompt: "Add a boss",
      permissions: { mode: "plan", ask: async () => ({ decision: "deny" }) } as never,
    });
    assert.notEqual(seen[0]?.cwd, cwd);
    assert.deepEqual(seen[0]?.sandbox.writableRoots, [seen[0]?.cwd], "the game folder stays read-only");
    assert.match((prompts[0] as Array<{ text: string }>)[0]?.text ?? "", /PLAN MODE/);
  });

  it("throws a failure the run policy acts on by its status, and reports any other as the build's outcome", async () => {
    const cwd = await game();
    const ending = async (name: string, stderr = "") => {
      const { engine } = await engineWith(async function* (invocation) {
        if (stderr) invocation.onStderr(stderr);
        yield* await events(name);
      });
      return engine.delegate({ cwd, prompt: "x", model: "grok-4.7" });
    };
    await assert.rejects(
      ending("grok-auth-failed-1.0.70.jsonl"),
      (err) => err instanceof EngineError && err.kind === "auth",
    );
    await assert.rejects(
      ending("grok-rate-limit-1.0.70.jsonl", await fixture("grok-rate-limit-1.0.70.stderr")),
      (err) => err instanceof EngineError && err.kind === "rate_limit",
      "a 429 the CLI's error log named",
    );
    const refused = await ending("grok-model-refused-1.0.70.jsonl");
    assert.equal(refused.ok, false);
    assert.match(refused.errorText ?? "", /^xAI refused grok-4\.7 [\s\S]*Pick another model/);
  });

  it("calls a failure with no status a sign-in failure only when the CLI says it is signed out", async () => {
    const cwd = await game();
    const signedOut = await engineWith(
      async function* () {
        yield* await events("grok-not-signed-in-1.0.70.jsonl");
      },
      { probe: "grok-probe-signed-out-1.0.70.jsonl" },
    );
    await assert.rejects(
      signedOut.engine.delegate({ cwd, prompt: "x" }),
      (err) => err instanceof EngineError && err.kind === "auth",
    );
    const signedIn = await engineWith(async function* () {
      yield { type: "error", message: "Internal error: the session store is locked" };
    });
    const outcome = await signedIn.engine.delegate({ cwd, prompt: "x" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorText, "Internal error: the session store is locked");
  });

  it("hands back what a stopped or timed-out session did, with the id Continue resumes", async () => {
    const hang: GrokExec = async function* (invocation) {
      yield { type: "text", data: "Working on it" };
      yield { type: "usage", usage: { input_tokens: 10, output_tokens: 2 } };
      yield {
        type: "tool_call",
        toolCallId: "call_1",
        toolName: "run_terminal_command",
        status: "pending",
        rawInput: { command: "npm test" },
      };
      if (invocation.signal.aborted) return;
      await new Promise((resolve) => invocation.signal.addEventListener("abort", resolve, { once: true }));
    };
    const cwd = await game();
    const stop = new AbortController();
    const { engine } = await engineWith(hang);
    const stopped = engine.delegate({ cwd, prompt: "x", signal: stop.signal, resume: "01a16f21" });
    setTimeout(() => stop.abort(), 20);
    const byYou = await stopped;
    assert.equal(byYou.stopReason, "stopped");
    assert.equal(byYou.sessionId, "01a16f21");
    assert.equal(byYou.summary, "Working on it");
    assert.equal(byYou.usage.input_tokens, 10, "the responses it had finished are counted");
    const late = await (await engineWith(hang)).engine.delegate({ cwd, prompt: "x", timeoutMs: 20 });
    assert.equal(late.stopReason, "deadline");
  });

  it("keeps a worker to its seam while it runs, and gives the files back after", async () => {
    const cwd = await game();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "sword.js"), "// mine\n");
    let lockedDuring = false;
    const { engine } = await engineWith(async function* () {
      lockedDuring = await access(path.join(cwd, "main.js"), constants.W_OK).then(
        () => false,
        () => true,
      );
      yield* replay([]);
    });
    await engine.delegate({
      cwd,
      prompt: "build the sword",
      ownership: { facetId: "sword", owns: ["src/sword.js"], ownsMain: false },
    });
    if (os.platform() !== "win32" && process.getuid?.() !== 0)
      assert.equal(lockedDuring, true, "an unowned file is read-only while it runs");
    await access(path.join(cwd, "main.js"), constants.W_OK);
  });

  it("compacts a session with Grok's own /compact, and says when it could not", async () => {
    const { engine, seen } = await engineWith(async function* () {
      yield* await events("grok-compact-1.0.70.jsonl");
    });
    const cwd = await game();
    const result = await engine.delegate({
      cwd,
      prompt: "",
      compact: true,
      resume: "01a16f21-8c48-70b1-9a25-a7b9d5c998e2",
    });
    assert.equal(result.compacted, true);
    assert.equal(result.sessionId, "01a16f21-8c48-70b1-9a25-a7b9d5c998e2");
    assert.deepEqual(seen[0]?.argv.slice(0, 4), ["-p", "/compact", "--resume", "01a16f21-8c48-70b1-9a25-a7b9d5c998e2"]);
    const failed = await (
      await engineWith(() =>
        replay([
          { type: "error", message: 'Internal error: {"kind":"compact_failed","message":"degenerate summary"}' },
        ]),
      )
    ).engine.delegate({ cwd, prompt: "", compact: true, resume: "s" });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorText, "degenerate summary");
  });
});

describe("Grok Build one-shot answers", () => {
  it("answers a judge with no tool approved, the critic's rules appended and its pictures in the prompt", async () => {
    const { engine, seen, prompts } = await engineWith(async function* () {
      yield* await events("grok-resume-1.0.70.jsonl");
    });
    const response = await engine.complete({
      systemPrompt: "You judge builds.",
      messages: [{ role: "user", content: "A or B?", images: [{ data: "aGk=", mimeType: "image/png" }] }],
    });
    assert.equal(response.message.content, "PASS: looks good.");
    assert.equal(response.engine, "grok");
    const argv = seen[0]?.argv ?? [];
    assert.ok(!argv.includes("--always-approve") && !argv.includes("--allow"), "nothing it could run is approved");
    assert.match(flag(argv, "--disallowed-tools") ?? "", /run_terminal_command/);
    assert.ok(argv.includes("--disable-web-search"));
    const [words, picture] = prompts[0] as Array<Record<string, string>>;
    assert.match(words?.text ?? "", /You judge builds\.[\s\S]*A or B\?[\s\S]*Answer only from what is written/);
    assert.deepEqual(picture, { type: "image", data: "aGk=", mimeType: "image/png" });
    await assert.rejects(
      engine.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "", parameters: {} }] as never,
      }),
      /take no studio tools/,
    );
  });
});

describe("Grok Build's command line", () => {
  it("starts the CLI in the sandbox with its arguments as words, the prompt never on the command line", async () => {
    const root = await tmpDir("grok-spawn-");
    // A stand-in CLI: Node, printing its arguments as one event and an error line on stderr.
    const cli = path.join(root, "cli.cjs");
    await writeFile(
      cli,
      'process.stderr.write("ERROR responses API error status=503 x\\n"); process.stdout.write(JSON.stringify({ type: "args", argv: process.argv.slice(2) }) + "\\n");\n',
    );
    const sandbox = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      enabled: false,
    });
    const argv = grokTurnArgv({
      access: "build",
      promptFile: path.join(root, "it's prompt.json"),
      cwd: root,
      bridge: false,
    });
    let stderr = "";
    const seen: Array<Record<string, unknown>> = [];
    try {
      const invocation = {
        argv: [cli, ...argv],
        cwd: root,
        env: {},
        signal: new AbortController().signal,
        domains: [],
        onStderr: (chunk: string) => {
          stderr += chunk;
        },
      };
      for await (const event of grokEvents(sandbox, process.execPath, invocation)) seen.push(event);
    } finally {
      await sandbox.dispose();
    }
    assert.deepEqual(seen[0]?.argv, argv, "a path with a quote in it arrives as one word");
    assert.equal(grokStderrStatus(stderr), 503);
  });
});
