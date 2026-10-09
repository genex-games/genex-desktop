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
} from "../../src/substrate/engines/opencode.ts";
import { OpenCodeAccess, openCodeConfig, parseOpenCodeApiModels } from "../../src/substrate/engines/opencode-cli.ts";
import { translateOpenCodeEvent } from "../../src/substrate/engines/opencode-events.ts";
import { EngineError, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
/** Redacted `opencode api get /api/model` capture (v2.0.26): `settings.apiKey` stripped. */
const apiFixture = async (): Promise<unknown> => JSON.parse(await fixture("opencode-api-model-2.x.json"));
/** The fixture catalog trimmed to OpenCode's own free models: no sign-in anywhere in it. */
const freeOnlyListing = async (): Promise<string> => {
  const value = (await apiFixture()) as { data: Array<{ providerID?: unknown }> };
  return JSON.stringify({ data: value.data.filter((model) => model.providerID === "opencode") });
};
const events = async (name: string) =>
  (await fixture(name))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const ready = async () => ({ ready: true, path: "/usr/local/bin/opencode", version: "2.0.26", detail: "ok" });

/** An engine whose sessions replay `stream`, recording each invocation. */
async function engineWith(
  stream: (invocation: OpenCodeInvocation) => AsyncIterable<Record<string, unknown>>,
  listing?: string,
) {
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
    listModels: async () => listing ?? (await fixture("opencode-api-model-2.x.json")),
  });
  return { engine, seen, root };
}

async function* replay(list: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const event of list) yield event;
}

/** Last-match-wins, as OpenCode resolves `permissions`: the final matching rule decides. */
function configRule(
  config: { permissions: Array<{ action: string; resource: string; effect: string }> },
  action: string,
  resource: string,
): string | undefined {
  return config.permissions
    .filter((r) => (r.action === action || r.action === "*") && (r.resource === resource || r.resource === "*"))
    .at(-1)?.effect;
}

async function game(): Promise<string> {
  const dir = await tmpDir("opencode-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return dir;
}

describe("OpenCode's model list", () => {
  const entry = (fields: Record<string, unknown>) => ({
    id: "m",
    modelID: "m",
    providerID: "p",
    name: "M",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
    limit: { context: 100_000, output: 8_000 },
    ...fields,
  });
  const wrap = (models: unknown) => ({ location: { directory: "/fixture" }, data: models });

  it("reads api/model: provider/model ids, limits, vision, price, variants and hosts", async () => {
    const listed = parseOpenCodeApiModels(await apiFixture());
    assert.deepEqual(
      listed.map((model) => model.row.id),
      [
        "opencode-go/claude-haiku-5-5",
        "opencode/exo-free",
        "opencode/ling-3.1-flash-free",
        "opencode-go/deepseek-v4-flash-vision-exp",
      ],
    );
    const [haiku, exo, ling, deepseek] = listed;
    assert.equal(haiku?.row.label, "Claude Haiku 5.5");
    assert.equal(haiku?.row.contextWindow, 1_000_000);
    assert.equal(haiku?.row.maxTokens, 128_000);
    assert.equal(haiku?.row.supportsVision, true);
    assert.equal(haiku?.row.supportsThinking, true);
    assert.deepEqual(haiku?.row.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(haiku?.row.defaultEffort, "low");
    assert.equal(haiku?.row.note, "opencode-go · $0.10 in / $0.50 out per M tokens");
    assert.deepEqual(haiku?.hosts, ["opencode.ai"], "the provider's host, for the sandbox's network");
    assert.equal(exo?.row.note, "opencode · Free");
    assert.deepEqual(exo?.row.efforts, ["high"]);
    assert.equal(exo?.row.defaultEffort, "high");
    assert.equal(ling?.row.efforts, undefined, "no variants, no dial");
    assert.equal(ling?.row.supportsVision, false);
    assert.equal(deepseek?.row.supportsVision, true);
    assert.ok(exo?.anonymous && ling?.anonymous, "OpenCode's own free models run with no sign-in at all");
    assert.equal(haiku?.anonymous, false, "a paid model needs its sign-in");
  });

  it("falls back honestly when the listing omits pieces, and reaches a custom endpoint by its address", () => {
    const [bare] = parseOpenCodeApiModels(wrap([entry({ limit: undefined, variants: undefined })]));
    assert.equal(bare?.row.contextWindow, 200_000);
    assert.equal(bare?.row.maxTokens, 32_000);
    assert.equal(bare?.row.contextSource, "unknown");
    assert.equal(bare?.row.efforts, undefined);
    const [custom] = parseOpenCodeApiModels(
      wrap([entry({ providerID: "atelier", settings: { baseURL: "https://models.atelier.example/v1" } })]),
    );
    assert.deepEqual(custom?.hosts, ["models.atelier.example"]);
    const [builtin] = parseOpenCodeApiModels(wrap([entry({ providerID: "openai" })]));
    assert.deepEqual(
      builtin?.hosts,
      ["api.openai.com", "chatgpt.com", "auth.openai.com"],
      "a ChatGPT sign-in answers on chatgpt.com and refreshes on auth.openai.com",
    );
  });

  it("skips what it cannot run, and refuses a listing that is not one", () => {
    assert.deepEqual(parseOpenCodeApiModels(wrap([entry({ capabilities: { tools: false } })])), []);
    assert.deepEqual(parseOpenCodeApiModels(wrap([entry({ enabled: false })])), []);
    assert.deepEqual(parseOpenCodeApiModels(wrap([entry({ status: "deprecated" })])), []);
    assert.deepEqual(
      parseOpenCodeApiModels(wrap([entry({ capabilities: { tools: true, output: ["text", "image"] } })])),
      [],
      "an image generator is no coding model, though it calls tools",
    );
    assert.equal(parseOpenCodeApiModels(wrap([entry({})])).length, 1);
    assert.deepEqual(parseOpenCodeApiModels(wrap([42, null, "x"])), [], "non-object entries are skipped");
    assert.deepEqual(parseOpenCodeApiModels(wrap([])), [], "an empty listing is nothing signed in, not an error");
    assert.deepEqual(parseOpenCodeApiModels([]), [], "a bare array reads as the model list");
    assert.throws(() => parseOpenCodeApiModels(wrap("Error: something broke")), /could not be read/);
    assert.throws(() => parseOpenCodeApiModels(null), /could not be read/);
  });

  it("says a deprecated free model failed as a free model, whatever channel reports it", async () => {
    const { engine } = await engineWith(() =>
      replay([
        {
          type: "error",
          sessionID: "ses_d",
          error: {
            name: "APIError",
            data: { message: "Model exo-free has been deprecated.", statusCode: 410 },
          },
        },
      ]),
    );
    await engine.refreshModels(true);
    const outcome = await engine
      .delegate({ cwd: await game(), prompt: "x", model: "opencode/exo-free" })
      .catch((err: unknown) => err);
    const words =
      outcome instanceof EngineError ? outcome.message : ((outcome as { errorText?: string }).errorText ?? "");
    assert.match(words, /OpenCode's free model Exo Free/);
    assert.match(words, /deprecated/);
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
    const go = await status(ready, await fixture("opencode-api-model-2.x.json"));
    assert.equal(go.code, "ready");
  });
});

describe("OpenCode's account", () => {
  const signedIn = async (listing: string) => {
    const value = JSON.parse(listing) as { data: unknown[] };
    value.data.unshift({
      id: "claude-x",
      modelID: "claude-x",
      providerID: "anthropic",
      name: "Claude X",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      cost: [{ input: 3, output: 15 }],
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 32_000 },
    });
    return JSON.stringify(value);
  };
  const account = async (listing: string) => {
    const root = await tmpDir("opencode-account-");
    return new OpenCodeEngine({ scratchRoot: root, resolveCli: ready, listModels: async () => listing }).account();
  };

  it("is no one's while OpenCode lists only its own free models, though they stay ready to run", async () => {
    const listing = await freeOnlyListing();
    const anonymous = await account(listing);
    assert.equal(anonymous.source, "none");
    assert.equal(anonymous.afterSignOut, "signed-out");
    assert.deepEqual(anonymous.cli, { state: "ready", path: "/usr/local/bin/opencode", version: "2.0.26" });
    const root = await tmpDir("opencode-account-");
    const status = await new OpenCodeEngine({
      scratchRoot: root,
      resolveCli: ready,
      listModels: async () => listing,
    }).status();
    assert.equal(status.code, "ready", "the free models still run");
  });

  it("is OpenCode's own sign-in once it lists a provider's model", async () => {
    assert.equal((await account(await signedIn(await fixture("opencode-api-model-2.x.json")))).source, "system");
  });

  it("lists a signed-in provider's models before its own free ones, so the picker starts with them", async () => {
    const root = await tmpDir("opencode-account-");
    const listing = await signedIn(await fixture("opencode-api-model-2.x.json"));
    const engine = new OpenCodeEngine({ scratchRoot: root, resolveCli: ready, listModels: async () => listing });
    await engine.refreshModels(true);
    assert.deepEqual(
      (await engine.models()).map((model) => model.id),
      [
        "anthropic/claude-x",
        "opencode-go/claude-haiku-5-5",
        "opencode-go/deepseek-v4-flash-vision-exp",
        "opencode/exo-free",
        "opencode/ling-3.1-flash-free",
      ],
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
      model: "opencode/ling-3.1-flash-free",
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
    assert.deepEqual(invocation?.argv.slice(0, 5), [
      "run",
      "--format",
      "json",
      "--model",
      "opencode/ling-3.1-flash-free",
    ]);
    assert.ok(!invocation?.argv.includes("--pure"), "v2 has no --pure");
    assert.ok(!invocation?.argv.includes("--variant"), "effort rides --model as #variant, not --variant");
    assert.ok(!invocation?.argv.includes("Write hello to out.txt"), "the brief never rides argv");
    assert.match(invocation?.prompt ?? "", /^Write hello to out\.txt/);
    assert.match(invocation?.prompt ?? "", /OFF LIMITS/);
    assert.equal(invocation?.cwd, await import("node:fs/promises").then((fs) => fs.realpath(cwd)));
    const config = JSON.parse(invocation?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    assert.equal(configRule(config, "edit", "*"), "allow");
    assert.equal(configRule(config, "shell", "*"), "allow");
    assert.equal(configRule(config, "external_directory", "*"), "deny");
    assert.equal(configRule(config, "webfetch", "*"), "deny");
    assert.equal(config.update, "disable");
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
      model: "opencode-go/deepseek-v4-flash-vision-exp",
      effort: "low",
    });
    await engine.delegate({ cwd, prompt: "go on", model: "opencode/ling-3.1-flash-free", effort: "high" });
    await engine.delegate({ cwd, prompt: "go on" });
    const [resumed, plain, picked] = seen.map((invocation) => invocation.argv);
    assert.deepEqual(resumed?.slice(-4), [
      "--model",
      "opencode-go/deepseek-v4-flash-vision-exp#low",
      "--session",
      "ses_1",
    ]);
    assert.ok(!plain?.includes("--variant"), "a model with no variants gets no --variant");
    assert.equal(
      plain?.[plain.indexOf("--model") + 1],
      "opencode/ling-3.1-flash-free",
      "an unoffered effort is dropped, not suffixed",
    );
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
    assert.equal(configRule(config, "edit", "*"), "deny");
    assert.equal(configRule(config, "external_directory", "*"), "allow", "it reads the game by its full path");
    assert.equal(configRule(config, "shell", "*"), "deny");
    assert.ok(
      config.permissions.some(
        (r: { action: string; resource: string; effect: string }) =>
          r.action === "shell" && r.effect === "allow" && r.resource.includes("tool.mjs"),
      ),
      "only the studio bridge runs",
    );
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
    assert.equal(configRule(JSON.parse(seen[0]?.env.OPENCODE_CONFIG_CONTENT ?? "{}"), "edit", "*"), "deny");
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
      const result = await engine.delegate({ cwd, prompt: "x", model: "opencode/exo-free" });
      assert.equal(result.stopReason, "error", `${status} is the build's outcome, never a wait`);
      assert.match(result.errorText ?? "", /Exo Free/, "the model by its name");
      assert.match(result.errorText ?? "", /Bad Request: not supported/, "the provider's own words");
      assert.match(result.errorText ?? "", /another model/);
    }
    const { engine } = await engineWith(() => refusing(400));
    const unpicked = await engine.delegate({ cwd, prompt: "x" });
    assert.equal(unpicked.errorText, "Bad Request: not supported", "with no pick there is no model to blame");
  });

  it("says the sandbox kept OpenCode from a provider whose address it does not know, never to sign in again", async () => {
    const root = await tmpDir("opencode-hosts-");
    const listing = JSON.stringify({
      location: { directory: "/fixture" },
      data: [
        {
          id: "m",
          modelID: "m",
          name: "Mystery",
          providerID: "unheard-of",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          cost: [{ input: 1, output: 1 }],
          status: "active",
          enabled: true,
          limit: { context: 100_000, output: 8_000 },
        },
      ],
    });
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
        engine.delegate({ cwd, prompt: "x", model: "opencode/exo-free" }),
        (err) =>
          err instanceof EngineError &&
          err.kind === kind &&
          /OpenCode's free model Exo Free/.test(err.message) &&
          /Endpoint is unavailable/.test(err.message) &&
          !/^rate limited/.test(err.message),
        `${status}`,
      );
    }
    const { engine } = await engineWith(() => failing(500, "Unexpected server error"), await freeOnlyListing());
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

  it("picks the first signed-in model as default, else the first listed, else none", async () => {
    const { engine } = await engineWith(() => replay([]));
    await engine.refreshModels(true);
    assert.equal(await engine.defaultModel(), "opencode-go/claude-haiku-5-5");
    const { engine: freeOnly } = await engineWith(() => replay([]), await freeOnlyListing());
    await freeOnly.refreshModels(true);
    assert.equal(await freeOnly.defaultModel(), "opencode/exo-free");
    const { engine: empty } = await engineWith(() => replay([]), JSON.stringify({ data: [] }));
    await empty.refreshModels(true);
    assert.equal(await empty.defaultModel(), null);
  });

  it("compacts the resumed session on OpenCode's own server and goes on under the same id", async () => {
    const seen: string[][] = [];
    const root = await tmpDir("opencode-compact-");
    const engine = new OpenCodeEngine({
      scratchRoot: path.join(root, "scratch"),
      resolveCli: ready,
      listModels: () => fixture("opencode-api-model-2.x.json"),
      apiFn: async (args) => {
        seen.push(args);
        return "{}";
      },
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "", compact: true, resume: "ses_1" });
    assert.deepEqual(seen, [["api", "post", "/api/session/ses_1/compact"]]);
    assert.equal(result.ok, true);
    assert.equal(result.compacted, true);
    assert.equal(result.sessionId, "ses_1");
  });

  it("reports a compaction the server refused as the build's outcome", async () => {
    const root = await tmpDir("opencode-compact-");
    const engine = new OpenCodeEngine({
      scratchRoot: path.join(root, "scratch"),
      resolveCli: ready,
      listModels: () => fixture("opencode-api-model-2.x.json"),
      apiFn: async () => {
        throw new Error("session not found");
      },
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "", compact: true, resume: "ses_gone" });
    assert.equal(result.ok, false);
    assert.match(result.errorText ?? "", /session not found/);
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
    assert.equal(configRule(config, "read", "*"), "deny");
    assert.equal(configRule(config, "shell", "*"), "deny");
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

  it("emits V2 permission rules that never ask and start from a closed-world deny", () => {
    for (const access of Object.values(OpenCodeAccess)) {
      for (const bridge of [false, true]) {
        const config = JSON.parse(openCodeConfig(access, bridge));
        assert.ok(Array.isArray(config.permissions), `${access} ${bridge} uses permissions[]`);
        assert.ok(
          config.permissions.every((r: { effect: string }) => r.effect === "allow" || r.effect === "deny"),
          `${access} ${bridge} never asks`,
        );
        assert.deepEqual(config.permissions.at(0), { action: "*", resource: "*", effect: "deny" });
        assert.deepEqual(config.plugins, [], "no project plugin runs in a studio session");
        assert.equal(config.share, "manual");
        assert.equal(config.update, "disable");
      }
    }
  });

  it("lets a build edit and run, a read-only session only run the studio bridge, and an answer nothing", () => {
    const build = JSON.parse(openCodeConfig(OpenCodeAccess.Build, true));
    assert.equal(configRule(build, "edit", "*"), "allow");
    assert.equal(configRule(build, "shell", "*"), "allow");
    assert.equal(configRule(build, "webfetch", "https://example.com"), "deny");
    assert.equal(configRule(build, "some-future-tool", "*"), "deny", "an action with no rule hits the wildcard");
    const readOnly = JSON.parse(openCodeConfig(OpenCodeAccess.ReadOnly, true));
    assert.equal(configRule(readOnly, "edit", "*"), "deny");
    assert.equal(configRule(readOnly, "read", "*"), "allow");
    assert.equal(configRule(readOnly, "external_directory", "*"), "allow");
    assert.ok(
      readOnly.permissions.some(
        (r: { action: string; resource: string; effect: string }) =>
          r.action === "shell" && r.effect === "allow" && r.resource.includes("tool.mjs"),
      ),
      "read-only shell allows only the studio bridge",
    );
    const answer = JSON.parse(openCodeConfig(OpenCodeAccess.Answer, false));
    assert.ok(answer.permissions.every((r: { effect: string }) => r.effect === "deny"));
  });
});
