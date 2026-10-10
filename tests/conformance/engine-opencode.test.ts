/**
 * OpenCode: a delegated harness the studio runs inside its own sandbox.
 *
 * The sessions replay event streams recorded from OpenCode 1.18 (`fixtures/transcripts/opencode-*`)
 * through the engine's `execFn` seam, so the translation, the command line, the environment, the
 * sandbox and every ending are exercised without the CLI, a provider or the network.
 */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  OpenCodeEngine,
  type OpenCodeExec,
  type OpenCodeInvocation,
  openCodeSandbox,
  openCodeServerUrl,
  settledListing,
} from "../../src/substrate/engines/opencode.ts";
import {
  OpenCodeAccess,
  openCodeConfig,
  openCodeConfigV2,
  parseOpenCodeApiModels,
  parseOpenCodeModels,
} from "../../src/substrate/engines/opencode-cli.ts";
import { translateOpenCodeEvent } from "../../src/substrate/engines/opencode-events.ts";
import { EngineError, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const events = async (name: string) =>
  (await fixture(name))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const ready = async () => ({ ready: true, path: "/usr/local/bin/opencode", version: "1.18.34", detail: "ok" });

/** An engine whose sessions replay `stream`, recording each invocation. */
async function engineWith(stream: (invocation: OpenCodeInvocation) => AsyncIterable<Record<string, unknown>>) {
  const root = await tmpDir("opencode-engine-");
  const seen: OpenCodeInvocation[] = [];
  const execFn: OpenCodeExec = (invocation) => {
    seen.push(invocation);
    return stream(invocation);
  };
  // As in the app: the engine homes are a folder every sandbox denies; the scratch root is not in it.
  const engine = new OpenCodeEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
    execFn,
    resolveCli: ready,
    listModels: () => fixture("opencode-models-1.18.txt"),
  });
  return { engine, seen, root };
}

async function* replay(list: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const event of list) yield event;
}

async function game(): Promise<string> {
  const dir = await tmpDir("opencode-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return dir;
}

describe("OpenCode's model list", () => {
  it("reads `opencode models --verbose`: tool-calling models as provider/model, their limits, price and variants", async () => {
    const listed = parseOpenCodeModels(await fixture("opencode-models-1.18.txt"));
    assert.deepEqual(
      listed.map((model) => model.row.id),
      ["opencode/big-pickle", "opencode/ling-3.0-flash-fin-free"],
    );
    const [pickle, ling] = listed;
    assert.equal(pickle?.row.label, "Big Pickle");
    assert.equal(pickle?.row.contextWindow, 200_000);
    assert.equal(pickle?.row.maxTokens, 32_000);
    assert.equal(pickle?.row.supportsThinking, true);
    assert.equal(pickle?.row.efforts, undefined, "no variants, no dial");
    assert.equal(pickle?.row.note, "opencode · Free");
    assert.deepEqual(pickle?.hosts, ["opencode.ai"], "the provider's host, for the sandbox's network");
    assert.ok(
      listed.every((model) => model.anonymous),
      "OpenCode's own free models run with no sign-in at all",
    );
    assert.deepEqual(ling?.row.efforts?.slice(0, 1), ["low"]);
    assert.equal(ling?.row.defaultEffort, "low");
  });

  it("reaches a built-in provider that lists no address on its SDK's hosts, and its browser sign-in's", () => {
    const builtIn = (provider: string) =>
      parseOpenCodeModels(
        `${provider}/m\n${JSON.stringify({ id: "m", providerID: provider, capabilities: { toolcall: true } }, null, 2)}`,
      )[0]?.hosts;
    assert.deepEqual(
      builtIn("openai"),
      ["api.openai.com", "chatgpt.com", "auth.openai.com"],
      "a ChatGPT sign-in answers on chatgpt.com and refreshes on auth.openai.com",
    );
    assert.deepEqual(builtIn("anthropic"), ["api.anthropic.com"]);
    assert.deepEqual(builtIn("unheard-of"), [], "an unknown provider with no address reaches nothing new");
  });

  it("skips what it cannot run, and refuses a listing that is not one", () => {
    const entry = (fields: Record<string, unknown>) =>
      `p/m\n${JSON.stringify({ id: "m", providerID: "p", capabilities: { toolcall: true }, ...fields }, null, 2)}`;
    assert.deepEqual(parseOpenCodeModels(entry({ capabilities: { toolcall: false } })), []);
    assert.deepEqual(parseOpenCodeModels(entry({ status: "deprecated" })), []);
    assert.deepEqual(
      parseOpenCodeModels(entry({ capabilities: { toolcall: true, output: { text: true, image: true } } })),
      [],
      "an image generator is no coding model, though it calls tools",
    );
    assert.equal(
      parseOpenCodeModels(entry({ capabilities: { toolcall: true, output: { text: true, image: false } } })).length,
      1,
    );
    assert.deepEqual(parseOpenCodeModels(entry({ api: { url: "http://insecure.example/v1" } }))[0]?.hosts, []);
    assert.deepEqual(parseOpenCodeModels(entry({ api: { url: "not a url" } }))[0]?.hosts, []);
    assert.deepEqual(parseOpenCodeModels(""), [], "an empty listing is nothing signed in, not an error");
    assert.equal(parseOpenCodeModels(entry({}))[0]?.anonymous, false, "another provider's model needs its sign-in");
    const zen = (cost: Record<string, unknown>) =>
      `opencode/m\n${JSON.stringify({ id: "m", providerID: "opencode", capabilities: { toolcall: true }, cost }, null, 2)}`;
    assert.equal(parseOpenCodeModels(zen({ input: 0, output: 0 }))[0]?.anonymous, true);
    assert.equal(
      parseOpenCodeModels(zen({ input: 3, output: 15 }))[0]?.anonymous,
      false,
      "a paid OpenCode model is listed only once its account is signed in",
    );
    assert.throws(() => parseOpenCodeModels("Error: something broke\n"), /could not be read/);
  });
});

describe("OpenCode's status", () => {
  it("says what to do at each step: install, fix the install, sign in, or go", async () => {
    const root = await tmpDir("opencode-status-");
    const status = (resolveCli: () => Promise<{ ready: boolean; path?: string; detail: string }>, listing = "") =>
      new OpenCodeEngine({ scratchRoot: root, resolveCli, listModels: async () => listing }).status();
    const missing = await status(async () => ({ ready: false, detail: "missing" }));
    assert.equal(missing.code, "not_installed");
    assert.match(missing.remedy ?? "", /Install OpenCode/);
    const broken = await status(async () => ({
      ready: false,
      path: "/x/opencode",
      detail: "Required CLI options are unavailable",
    }));
    assert.equal(broken.code, "error");
    const signedOut = await status(ready);
    assert.equal(signedOut.code, "needs_login");
    assert.match(signedOut.remedy ?? "", /Sign in/);
    const go = await status(ready, await fixture("opencode-models-1.18.txt"));
    assert.equal(go.code, "ready");
  });
});

describe("OpenCode's account", () => {
  const signedIn = (listing: string) =>
    `${listing}\nanthropic/claude-x\n${JSON.stringify(
      {
        id: "claude-x",
        providerID: "anthropic",
        capabilities: { toolcall: true },
        cost: { input: 3, output: 15 },
      },
      null,
      2,
    )}`;
  const account = async (listing: string) => {
    const root = await tmpDir("opencode-account-");
    return new OpenCodeEngine({ scratchRoot: root, resolveCli: ready, listModels: async () => listing }).account();
  };

  it("is no one's while OpenCode lists only its own free models, though they stay ready to run", async () => {
    const listing = await fixture("opencode-models-1.18.txt");
    const anonymous = await account(listing);
    assert.equal(anonymous.source, "none");
    assert.equal(anonymous.afterSignOut, "signed-out");
    assert.deepEqual(anonymous.cli, { state: "ready", path: "/usr/local/bin/opencode", version: "1.18.34" });
    const root = await tmpDir("opencode-account-");
    const status = await new OpenCodeEngine({
      scratchRoot: root,
      resolveCli: ready,
      listModels: async () => listing,
    }).status();
    assert.equal(status.code, "ready", "the free models still run");
  });

  it("is OpenCode's own sign-in once it lists a provider's model", async () => {
    assert.equal((await account(signedIn(await fixture("opencode-models-1.18.txt")))).source, "system");
  });

  it("lists a signed-in provider's models before its own free ones, so the picker starts with them", async () => {
    const root = await tmpDir("opencode-account-");
    const listing = signedIn(await fixture("opencode-models-1.18.txt"));
    const engine = new OpenCodeEngine({ scratchRoot: root, resolveCli: ready, listModels: async () => listing });
    await engine.refreshModels(true);
    assert.deepEqual(
      (await engine.models()).map((model) => model.id),
      ["anthropic/claude-x", "opencode/big-pickle", "opencode/ling-3.0-flash-fin-free"],
    );
  });
});

describe("OpenCode sessions", () => {
  it("builds from the prompt on stdin, mirrors every event, and adds up the run's tokens and price", async () => {
    const { engine, seen } = await engineWith(async function* () {
      yield* replay(await events("opencode-run-1.18.jsonl"));
    });
    const cwd = await game();
    const mirrored: DelegateEvent[] = [];
    await engine.refreshModels(true);
    const result = await engine.delegate({
      cwd,
      prompt: "Write hello to out.txt",
      model: "opencode/big-pickle",
      onEvent: (event) => mirrored.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "opencode");
    assert.equal(result.billing, "api", "OpenCode runs on whatever the person pays a provider for");
    assert.equal(result.summary, "Done: wrote out.txt");
    assert.equal(result.sessionId, "ses_eeef4bcd4ffepuBfB6ihbgqZtf");
    assert.equal(result.usage.input_tokens, 200);
    assert.equal(result.usage.output_tokens, 40);
    assert.equal(result.turns, 3);
    const tool = mirrored.find(
      (event) => event.type === "assistant" && JSON.stringify(event.payload).includes("tool_use"),
    );
    assert.match(JSON.stringify(tool?.payload), /"name":"Bash".*echo hello > out.txt/);
    assert.ok(mirrored.some((event) => event.type === "user" && JSON.stringify(event.payload).includes("tool_result")));

    const [invocation] = seen;
    assert.deepEqual(invocation?.argv.slice(0, 5), ["run", "--format", "json", "--pure", "--model"]);
    assert.ok(!invocation?.argv.includes("Write hello to out.txt"), "the brief never rides argv");
    assert.match(invocation?.prompt ?? "", /^Write hello to out\.txt/);
    assert.match(invocation?.prompt ?? "", /OFF LIMITS/);
    assert.equal(invocation?.cwd, await import("node:fs/promises").then((fs) => fs.realpath(cwd)));
    const config = JSON.parse(invocation?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    assert.equal(config.permission.edit, "allow");
    assert.equal(config.permission.bash, "allow");
    assert.equal(config.permission.external_directory, "deny");
    assert.equal(config.permission.webfetch, "deny");
    assert.equal(config.autoupdate, false);
    assert.equal(invocation?.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
    assert.deepEqual(
      invocation?.domains,
      ["opencode.ai", "models.dev", "models.opencode.ai"],
      "only the model's own provider and OpenCode's catalogs are reachable",
    );
  });

  it("resumes by session id, and asks a model for an effort only when it offers that variant", async () => {
    const { engine, seen } = await engineWith(() => replay([]));
    await engine.refreshModels(true);
    const cwd = await game();
    await engine.delegate({
      cwd,
      prompt: "go on",
      resume: "ses_1",
      model: "opencode/ling-3.0-flash-fin-free",
      effort: "low",
    });
    await engine.delegate({ cwd, prompt: "go on", model: "opencode/big-pickle", effort: "high" });
    await engine.delegate({ cwd, prompt: "go on" });
    const [resumed, plain, picked] = seen.map((invocation) => invocation.argv);
    assert.deepEqual(resumed?.slice(-4), ["--session", "ses_1", "--variant", "low"]);
    assert.ok(!plain?.includes("--variant"), "a model with no variants gets no --variant");
    assert.ok(!picked?.includes("--model"), "with no pick, OpenCode's own default model runs");
    assert.ok(seen[2]?.domains.includes("opencode.ai"), "and every listed provider is reachable");
  });

  it("runs a read-only session from a scratch folder, with no edits and only the studio's bridge as a command", async () => {
    const { engine, seen, root } = await engineWith(async function* (invocation) {
      // The bridge is written where the session runs, for its shell to find.
      await access(path.join(invocation.cwd, ".studio", "bridge", "tool.mjs"), constants.R_OK);
      yield* replay([]);
    });
    const cwd = await game();
    const result = await engine.delegate({
      cwd,
      prompt: "Judge the build",
      readOnly: true,
      interviewTools: [{ name: "ask_user", description: "ask", parameters: { type: "object", properties: {} } }],
    });
    assert.equal(result.ok, true);
    const [invocation] = seen;
    assert.ok(invocation?.cwd.startsWith(path.join(root, "scratch")), "never the game folder");
    assert.ok(
      invocation?.sandbox.secretPaths.every((denied) => !invocation.cwd.startsWith(denied)),
      "and never inside a folder the sandbox denies",
    );
    const config = JSON.parse(invocation?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    assert.equal(config.permission.edit, "deny");
    assert.equal(config.permission.external_directory, "allow", "it reads the game by its full path");
    assert.deepEqual(config.permission.bash, { "*": "deny", "node .studio/bridge/tool.mjs *": "allow" });
    assert.match(invocation?.prompt ?? "", /you cannot change it/);
    assert.deepEqual(invocation?.sandbox.writableRoots.slice(0, 1), [invocation?.cwd]);
  });

  it("plans in Plan: read-only, from a folder of its own", async () => {
    const { engine, seen } = await engineWith(() => replay([]));
    const cwd = await game();
    const permissions = {
      mode: "plan" as const,
      allow: [],
      directories: [],
      protectWrites: [],
      ask: async () => ({ decision: "allow" as const }),
    };
    await engine.delegate({ cwd, prompt: "Plan it", permissions });
    assert.match(seen[0]?.prompt ?? "", /PLAN MODE/);
    assert.equal(JSON.parse(seen[0]?.env.OPENCODE_CONFIG_CONTENT ?? "{}").permission.edit, "deny");
  });

  it("throws a failure the run policy acts on by its status, and reports any other as the build's outcome", async () => {
    const failing = (status: number | null) =>
      replay([
        {
          type: "error",
          sessionID: "ses_x",
          error: { name: "APIError", data: { message: "nope", ...(status === null ? {} : { statusCode: status }) } },
        },
      ]);
    const rows: Array<[number, string]> = [
      [401, "auth"],
      [403, "auth"],
      [429, "rate_limit"],
      [402, "usage_limit"],
      [503, "unavailable"],
    ];
    const cwd = await game();
    for (const [status, kind] of rows) {
      const { engine } = await engineWith(() => failing(status));
      await assert.rejects(
        engine.delegate({ cwd, prompt: "x" }),
        (err) => err instanceof EngineError && err.kind === kind && err.engine === "opencode",
        `${status}`,
      );
    }
    const { engine } = await engineWith(() => failing(null));
    const result = await engine.delegate({ cwd, prompt: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorText, "nope");
    assert.equal(result.sessionId, "ses_x", "Continue resumes the session that failed");

    const recorded = translateOpenCodeEvent((await events("opencode-error-1.18.jsonl"))[0] ?? {});
    assert.deepEqual(recorded.failure, { message: "Forbidden: request blocked", status: 403 });
  });

  it("says to pick another model when the provider refuses the one picked", async () => {
    const refusing = (status: number) =>
      replay([
        {
          type: "error",
          sessionID: "ses_y",
          error: { name: "APIError", data: { message: "Bad Request: not supported", statusCode: status } },
        },
      ]);
    const cwd = await game();
    for (const status of [400, 404]) {
      const { engine } = await engineWith(() => refusing(status));
      await engine.refreshModels(true);
      const result = await engine.delegate({ cwd, prompt: "x", model: "opencode/big-pickle" });
      assert.equal(result.stopReason, "error", `${status} is the build's outcome, never a wait`);
      assert.match(result.errorText ?? "", /Big Pickle/, "the model by its name");
      assert.match(result.errorText ?? "", /Bad Request: not supported/, "the provider's own words");
      assert.match(result.errorText ?? "", /another model/);
    }
    const { engine } = await engineWith(() => refusing(400));
    const unpicked = await engine.delegate({ cwd, prompt: "x" });
    assert.equal(unpicked.errorText, "Bad Request: not supported", "with no pick there is no model to blame");
  });

  it("says the sandbox kept OpenCode from a provider whose address it does not know, never to sign in again", async () => {
    const root = await tmpDir("opencode-hosts-");
    const listing = `unheard-of/m\n${JSON.stringify(
      {
        id: "m",
        name: "Mystery",
        providerID: "unheard-of",
        capabilities: { toolcall: true },
        cost: { input: 1, output: 1 },
      },
      null,
      2,
    )}`;
    const engine = new OpenCodeEngine({
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "secrets")],
      resolveCli: ready,
      listModels: async () => listing,
      execFn: () =>
        replay([
          {
            type: "error",
            sessionID: "ses_z",
            error: { name: "APIError", data: { message: "Forbidden", statusCode: 403 } },
          },
        ]),
    });
    await engine.refreshModels(true);
    const result = await engine.delegate({ cwd: await game(), prompt: "x", model: "unheard-of/m" });
    assert.equal(result.stopReason, "error", "a blocked host is the build's outcome, not a lost sign-in");
    assert.match(result.errorText ?? "", /unheard-of/);
    assert.match(result.errorText ?? "", /sandbox/);
  });

  it("names OpenCode's free model when it fails, keeping the failure's kind", async () => {
    const failing = (status: number, message: string) =>
      replay([
        { type: "error", sessionID: "ses_f", error: { name: "APIError", data: { message, statusCode: status } } },
      ]);
    const cwd = await game();
    for (const [status, kind] of [
      [429, "rate_limit"],
      [500, "unavailable"],
    ] as const) {
      const { engine } = await engineWith(() => failing(status, "Upstream request failed: Endpoint is unavailable."));
      await engine.refreshModels(true);
      await assert.rejects(
        engine.delegate({ cwd, prompt: "x", model: "opencode/big-pickle" }),
        (err) =>
          err instanceof EngineError &&
          err.kind === kind &&
          /OpenCode's free model Big Pickle/.test(err.message) &&
          /Endpoint is unavailable/.test(err.message) &&
          !/^rate limited/.test(err.message),
        `${status}`,
      );
    }
    const { engine } = await engineWith(() => failing(500, "Unexpected server error"));
    await engine.refreshModels(true);
    await assert.rejects(
      engine.delegate({ cwd, prompt: "x" }),
      (err) => err instanceof EngineError && /OpenCode's free model/.test(err.message),
      "with no pick and no sign-in, OpenCode's own default is one of its free models",
    );
  });

  it("hands back what a stopped or timed-out session did, with the id Continue resumes", async () => {
    const hang: OpenCodeExec = async function* (invocation) {
      yield { type: "text", sessionID: "ses_long", part: { type: "text", text: "Working on it" } };
      // A busy machine may stop the session before this listens: an abort already made ends it too.
      if (invocation.signal.aborted) return;
      await new Promise((resolve) => invocation.signal.addEventListener("abort", resolve, { once: true }));
    };
    const cwd = await game();
    const stop = new AbortController();
    const { engine } = await engineWith(hang);
    const stopped = engine.delegate({ cwd, prompt: "x", signal: stop.signal });
    setTimeout(() => stop.abort(), 20);
    const byYou = await stopped;
    assert.equal(byYou.stopReason, "stopped");
    assert.equal(byYou.sessionId, "ses_long");
    assert.equal(byYou.summary, "Working on it");
    assert.equal(byYou.billing, "api");
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

  it("refuses Compact now: OpenCode compacts its own sessions", async () => {
    const { engine } = await engineWith(() => replay([]));
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "", compact: true, resume: "ses_1" }),
      /compacts its own/,
    );
  });
});

describe("OpenCode one-shot answers", () => {
  it("answers a judge with no tools, the critic's rules appended and its pictures attached as files", async () => {
    const { engine, seen } = await engineWith(() =>
      replay([{ type: "text", sessionID: "ses_j", part: { type: "text", text: "VERDICT: A" } }]),
    );
    const response = await engine.complete({
      systemPrompt: "You judge builds.",
      messages: [{ role: "user", content: "A or B?", images: [{ data: "aGk=", mimeType: "image/png" }] }],
    });
    assert.equal(response.message.content, "VERDICT: A");
    assert.equal(response.engine, "opencode");
    const [invocation] = seen;
    assert.match(invocation?.prompt ?? "", /You judge builds\.[\s\S]*A or B\?[\s\S]*Answer only from what is written/);
    assert.equal(invocation?.argv.filter((arg) => arg === "--file").length, 1);
    const config = JSON.parse(invocation?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    assert.equal(config.permission.read, "deny");
    assert.equal(config.permission.bash, "deny");
    await assert.rejects(
      engine.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "t", parameters: { type: "object", properties: {} } }],
      }),
      /no studio tools/,
    );
  });
});

describe("OpenCode's sandbox and config", () => {
  it("lets the session write its folder and its own state, and reach its own sign-in, and nothing else", () => {
    const home = path.resolve(path.sep, "Users", "me");
    const options = openCodeSandbox({
      runDir: path.join(home, "AI Games", "space"),
      gameDir: path.join(home, "AI Games", "space"),
      gitDirs: [path.join(home, "AI Games", "space", ".git")],
      scratchDir: path.join(home, "scratch"),
      secretPaths: [path.join(home, "secrets")],
      env: {},
      home,
    });
    assert.deepEqual(options.writableRoots, [
      path.join(home, "AI Games", "space"),
      path.join(home, "AI Games", "space", ".git"),
      path.join(home, ".local", "state", "opencode"),
      path.join(home, ".cache", "opencode"),
    ]);
    assert.deepEqual(options.ownHome, [path.join(home, ".local", "share", "opencode")]);
    assert.deepEqual(options.secretPaths, [path.join(home, "secrets")]);
    assert.deepEqual(options.denyWrite, [
      path.join(home, "AI Games", "space", "opencode.json"),
      path.join(home, "AI Games", "space", ".opencode"),
    ]);
    const relative = openCodeSandbox({
      runDir: "/r",
      gameDir: "/r",
      gitDirs: [],
      scratchDir: "/s",
      secretPaths: [],
      env: { XDG_STATE_HOME: "relative", XDG_DATA_HOME: "also/relative" },
      home,
    });
    assert.ok(
      relative.writableRoots.includes(path.join(home, ".local", "state", "opencode")),
      "a relative XDG folder is ignored",
    );
    assert.deepEqual(relative.ownHome, [path.join(home, ".local", "share", "opencode")]);
  });

  it("never asks: every permission is allow or deny; only a read-only session reads outside its folder", () => {
    for (const access of Object.values(OpenCodeAccess)) {
      for (const bridge of [false, true]) {
        const config = JSON.parse(openCodeConfig(access, bridge));
        const values = Object.values(config.permission).flatMap((value) =>
          typeof value === "string" ? [value] : Object.values(value as Record<string, string>),
        );
        assert.ok(
          values.every((value) => value === "allow" || value === "deny"),
          `${access} ${bridge}`,
        );
        assert.equal(config.permission.external_directory, access === "read-only" ? "allow" : "deny");
        if (access !== "build") assert.equal(config.permission.edit, "deny");
        assert.equal(config.permission.webfetch, "deny");
        assert.equal(config.permission.skill, "deny", "no skill, the person's own or a game's, reaches a session");
        assert.equal(config.share, "disabled");
      }
    }
  });
});

const v2 = async () => ({
  ready: true,
  path: "/opt/homebrew/bin/opencode",
  version: "opencode v2.0.20",
  detail: "ok",
});

/** An engine on a 2.x CLI whose sessions replay `stream`, listing the recorded 2.0.20 catalog. */
async function engineV2(stream: (invocation: OpenCodeInvocation) => AsyncIterable<Record<string, unknown>>) {
  const root = await tmpDir("opencode-v2-");
  const seen: OpenCodeInvocation[] = [];
  const engine = new OpenCodeEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets")],
    execFn: (invocation) => {
      seen.push(invocation);
      return stream(invocation);
    },
    resolveCli: v2,
    listModels: () => fixture("opencode-api-model-2.0.20.json"),
  });
  return { engine, seen };
}

/** A 2.x permission rule as the config writes it. */
type Rule = { action: string; resource: string; effect: string };

/** What 2.x decides for one call by these rules: the last that matches, as OpenCode reads them. */
const decide = (rules: Rule[], action: string, resource = "anything") =>
  rules.findLast(
    (rule) => (rule.action === "*" || rule.action === action) && (rule.resource === "*" || rule.resource === resource),
  )?.effect;

describe("OpenCode 2.x's model list", () => {
  it("reads `GET /api/model`: runnable models as provider/id, their limits, price, variants and the free ones", async () => {
    const listed = parseOpenCodeApiModels(await fixture("opencode-api-model-2.0.20.json"));
    assert.deepEqual(
      listed.map((model) => model.row.id),
      ["opencode/exo-free", "opencode/ling-3.1-flash-free", "opencode/space-bunny-free", "opencode/big-pickle"],
    );
    const [exo] = listed;
    assert.equal(exo?.row.label, "Exo Free");
    assert.equal(exo?.row.contextWindow, 1_048_576);
    assert.equal(exo?.row.maxTokens, 131_072);
    assert.deepEqual(exo?.row.efforts, ["high"]);
    assert.equal(exo?.row.supportsVision, true);
    assert.equal(exo?.row.note, "opencode · Free");
    assert.deepEqual(exo?.hosts, ["opencode.ai"]);
    assert.ok(listed.every((model) => model.anonymous && model.row.free === true));
    assert.equal(listed[3]?.row.efforts, undefined, "no variants, no dial");
  });

  it("names a model by the id `--model` takes, and skips what it cannot run; an unreadable list is refused", () => {
    const listing = (fields: Record<string, unknown>) =>
      JSON.stringify({
        location: { directory: "/game" },
        data: [
          {
            id: "m-alias",
            modelID: "m-upstream",
            providerID: "p",
            capabilities: { tools: true, output: ["text"] },
            cost: [{ input: 1, output: 2 }],
            ...fields,
          },
        ],
      });
    assert.equal(parseOpenCodeApiModels(listing({}))[0]?.row.id, "p/m-alias", "the id, not the provider's model id");
    assert.equal(parseOpenCodeApiModels(listing({}))[0]?.anonymous, false);
    assert.deepEqual(parseOpenCodeApiModels(listing({ enabled: false })), []);
    assert.deepEqual(parseOpenCodeApiModels(listing({ status: "deprecated" })), []);
    assert.deepEqual(parseOpenCodeApiModels(listing({ capabilities: { tools: false } })), []);
    assert.deepEqual(parseOpenCodeApiModels(listing({ capabilities: { tools: true, output: ["text", "image"] } })), []);
    assert.deepEqual(
      parseOpenCodeApiModels(listing({ variants: [{ id: "default" }, { id: "low" }, { id: 7 }] }))[0]?.row.efforts,
      ["low"],
      "`default` is no variant",
    );
    assert.deepEqual(parseOpenCodeApiModels(listing({ settings: { baseURL: "http://plain.example" } }))[0]?.hosts, []);
    assert.deepEqual(parseOpenCodeApiModels(JSON.stringify({ data: [] })), [], "nothing signed in, not an error");
    assert.deepEqual(parseOpenCodeApiModels(""), []);
    for (const broken of ["Error: no server", "{}", '{"data":{}}', "[1,2"])
      assert.throws(() => parseOpenCodeApiModels(broken), /could not be read/, broken);
  });
});

describe("OpenCode 2.x sessions", () => {
  it("runs each session on a private server inside the sandbox, never the person's background one", async () => {
    const { engine, seen } = await engineV2(async function* () {
      yield* replay(await events("opencode-run-2.0.20.jsonl"));
    });
    await engine.refreshModels(true);
    const cwd = await game();
    const result = await engine.delegate({ cwd, prompt: "Write hello", model: "opencode/exo-free", effort: "high" });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Done: wrote out.txt");
    assert.equal(result.sessionId, "ses_ed89ed804ffehtTg3vwhCjGdit");
    assert.equal(result.usage.input_tokens, 2049);
    const [invocation] = seen;
    assert.deepEqual(invocation?.argv, [
      "run",
      "--format",
      "json",
      "--standalone",
      "--agent",
      "build",
      "--model",
      "opencode/exo-free#high",
    ]);
    const real = await import("node:fs/promises").then((fs) => fs.realpath(cwd));
    assert.equal(invocation?.env.PWD, real, "2.x reads its folder from PWD before its working directory");
    assert.equal(invocation?.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1", "a game's own OpenCode config never loads");
    const home = invocation?.env.OPENCODE_TEST_HOME ?? "";
    assert.ok(home.startsWith(path.dirname(invocation?.sandbox.scratchDir ?? "")), "an empty home of its own");
    await access(home);
    assert.ok(
      invocation?.sandbox.secretPaths.every((denied) => !home.startsWith(denied)),
      "where the sandbox refuses nothing it looks at",
    );
    const config = JSON.parse(invocation?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    assert.deepEqual(config.permissions[0], { action: "*", resource: "*", effect: "deny" });
    assert.deepEqual(config.agents.build.permissions, config.permissions, "and the agent it runs ends on them");
    assert.equal(config.permission, undefined, "never 1.18's shape");
    assert.equal(config.share, "disabled");
    assert.equal(config.update, "disable");
    assert.deepEqual(invocation?.domains, ["opencode.ai", "models.dev", "models.opencode.ai"]);
  });

  it("resumes by session id, and leaves the variant off a model with no such dial", async () => {
    const { engine, seen } = await engineV2(() => replay([]));
    await engine.refreshModels(true);
    const cwd = await game();
    await engine.delegate({ cwd, prompt: "go on", resume: "ses_1", model: "opencode/big-pickle", effort: "high" });
    await engine.delegate({ cwd, prompt: "go on" });
    const [resumed, unpicked] = seen.map((invocation) => invocation.argv);
    assert.deepEqual(resumed?.slice(-4), ["--model", "opencode/big-pickle", "--session", "ses_1"]);
    assert.ok(!unpicked?.includes("--model"), "with no pick, OpenCode's own default model runs");
  });

  it("never asks: a closed world of allow and deny, edits only in a build, other folders only read-only", () => {
    const bridgeCall = "node .studio/bridge/tool.mjs *";
    const table: Array<[OpenCodeAccess, boolean, Record<string, string>]> = [
      ["build", false, { edit: "allow", shell: "allow", read: "allow", external_directory: "deny" }],
      [
        "read-only",
        true,
        { edit: "deny", shell: "deny", [bridgeCall]: "allow", read: "allow", external_directory: "allow" },
      ],
      ["read-only", false, { edit: "deny", [bridgeCall]: "deny", read: "allow", external_directory: "allow" }],
      ["answer", false, { edit: "deny", [bridgeCall]: "deny", read: "deny", glob: "deny", external_directory: "deny" }],
    ];
    const never = ["webfetch", "websearch", "skill", "subagent", "question", "a_future_tool"];
    for (const [access, bridge, expected] of table) {
      const rules = JSON.parse(openCodeConfigV2(access, bridge)).permissions as Rule[];
      assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "deny" }, access);
      assert.ok(
        rules.every((rule) => rule.effect === "allow" || rule.effect === "deny"),
        access,
      );
      for (const [call, effect] of Object.entries(expected)) {
        const [action, resource] = call === bridgeCall ? ["shell", bridgeCall] : [call, undefined];
        assert.equal(decide(rules, action, resource), effect, `${access} ${bridge} ${call}`);
      }
      for (const action of never) assert.equal(decide(rules, action), "deny", `${access} ${action}`);
    }
  });
});

describe("OpenCode 2.x failures and status", () => {
  it("reads 2.x's failures by the status they carry", async () => {
    const recorded = translateOpenCodeEvent((await events("opencode-error-2.0.20.jsonl"))[0] ?? {});
    assert.deepEqual(recorded.failure, {
      message: "Variant unavailable for opencode/big-pickle: nosuchvariant",
      status: null,
    });
    const { engine } = await engineV2(() =>
      replay([
        {
          type: "error",
          sessionID: "ses_r",
          error: { type: "provider.rate-limit", message: "Slow down", status: 429 },
        },
      ]),
    );
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "x" }),
      (err) => err instanceof EngineError && err.kind === "rate_limit",
    );
    const shell = translateOpenCodeEvent((await events("opencode-run-2.0.20.jsonl"))[1] ?? {});
    assert.match(JSON.stringify(shell.events[0]?.payload), /"name":"Bash".*echo hello > out\.txt/);
    assert.match(JSON.stringify(shell.events[1]?.payload), /call_00_gc7cglcccprpw0bt7aombz4s/);
  });

  it("refuses Compact now, as 1.18 does: OpenCode compacts its own sessions", async () => {
    const { engine } = await engineV2(() => replay([]));
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "", compact: true, resume: "ses_1" }),
      /compacts its own/,
    );
  });

  it("says when OpenCode is newer than Genex has tested, and still runs it", async () => {
    const root = await tmpDir("opencode-v2-status-");
    const status = (version: string) =>
      new OpenCodeEngine({
        scratchRoot: root,
        resolveCli: async () => ({ ready: true, path: "/x/opencode", version, detail: "ok" }),
        listModels: () => fixture("opencode-api-model-2.0.20.json"),
      }).status();
    const tested = await status("opencode v2.0.26");
    assert.equal(tested.code, "ready");
    assert.doesNotMatch(tested.detail, /tested/);
    const newer = await status("opencode v2.4.1");
    assert.equal(newer.code, "ready");
    assert.match(newer.detail, /2\.4\.1/);
    assert.match(newer.detail, /newer than Genex has tested/);
  });
});

describe("OpenCode 2.x's private listing server", () => {
  it("waits for a listing to settle: two reads that agree, or the last read when time runs out", async () => {
    const reads = (answers: string[]) => {
      let index = 0;
      return async () => answers[Math.min(index++, answers.length - 1)] ?? "";
    };
    const empty = JSON.stringify({ data: [] });
    const two = JSON.stringify({ data: [{ id: "a" }, { id: "b" }] });
    const one = JSON.stringify({ data: [{ id: "a" }] });
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    assert.equal(await settledListing(reads([empty, one, two, two]), { attempts: 10, intervalMs: 50, wait }), two);
    assert.deepEqual(waits, [50, 50, 50]);
    assert.equal(
      await settledListing(reads([empty]), { attempts: 3, intervalMs: 50, wait }),
      empty,
      "nothing ever listed: an empty list",
    );
  });

  it("talks only to a loopback HTTP address the server reports", () => {
    assert.equal(openCodeServerUrl('{"url":"http://127.0.0.1:56877"}'), "http://127.0.0.1:56877");
    assert.equal(openCodeServerUrl('{"url":"http://localhost:4000/"}'), "http://localhost:4000");
    for (const hostile of [
      '{"url":"http://example.com:80"}',
      '{"url":"https://127.0.0.1.example.com"}',
      '{"url":"file:///etc/passwd"}',
      '{"url":"http://user:pw@127.0.0.1:1"}',
      '{"url":7}',
      "Server listening on http://127.0.0.1:1",
      "",
    ])
      assert.equal(openCodeServerUrl(hostile), null, hostile);
  });
});
