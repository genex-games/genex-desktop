/**
 * A plugin loaded from a folder on this Mac runs with the person's access, so each of its agent
 * tools asks before it runs, every call, until the person answers Always allow for that tool. The
 * grant goes when its code changes or it is turned off. Bypass, a run's own consent and an agent's
 * message never answer the card; the plugin's own steps at Genex's moments run without one; and no
 * host method an agent reaches loads or turns on a plugin.
 *
 * A real core (`coreLite`) with a local test plugin `lp`: agent tools `build` (needs the lock
 * `bench`), `ship`, and `stamp` (its own confirmation), and a harness step `tidy` at the health
 * moment. Each backend call appends its tool's name to `calls.log` in the game's folder.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { installDetail } from "../../src/main/plugin-install-words.ts";
import { suggestionLocalAccess } from "../../src/renderer/chat/plugin-suggestion.ts";
import { localAccessNote } from "../../src/renderer/panels/plugins/labels.ts";
import { PLUGIN_SUGGESTION_WORDS, PLUGINS_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { type PluginInfo, PluginSourceKind, type PluginTool } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

/** A card nobody answers declines this fast here, so the rows that wait it out end quickly. */
const CONSENT_TIMEOUT_MS = 1_500;
/** How long a test looks for a card or a backend call before it says none came. */
const LOOK_MS = 5_000;
const LOOK_STEP_MS = 20;
const PLUGIN_ID = "lp";
const PLUGIN_NAME = "Local bench";
const PROJECT = "bench-game";
const ENGINE = "claude-code";
const RUN_ID = "run_bench";
const BUILD = `${PLUGIN_ID}__build`;
const SHIP = `${PLUGIN_ID}__ship`;
const STAMP = `${PLUGIN_ID}__stamp`;

const BACKEND = `
import { appendFile } from "node:fs/promises";
import path from "node:path";
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      await appendFile(path.join(ctx.directory, "calls.log"), name + "\\n");
      return { ran: name };
    },
  };
}
`;

/** The test plugin's folder, as the person would pick it. */
async function localPackage(): Promise<string> {
  const dir = await tmpDir("studio-local-consent-");
  const empty = { type: "object", properties: {} };
  const manifest = {
    apiVersion: 3,
    id: PLUGIN_ID,
    version: "1.0.0",
    name: PLUGIN_NAME,
    publisher: "Studio tests",
    description: "A bench loaded from a folder.",
    backend: "backend.mjs",
    capabilities: [],
    locks: [{ id: "bench", label: "Bench", per: "project" }],
    hooks: [{ on: "health", tool: "tidy" }],
    tools: [
      { name: "build", description: "Build at the bench.", parameters: empty, needs: ["bench"] },
      { name: "ship", description: "Ship what was built.", parameters: empty },
      { name: "stamp", description: "Stamp the sheet.", confirmation: "Stamp the sheet?", parameters: empty },
      { name: "tidy", audience: "harness", description: "Tidy the bench.", parameters: empty },
    ],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "backend.mjs"), BACKEND);
  return dir;
}

/** What a session read back from a live tool call, as text. */
function liveText(result: LiveToolResult | undefined): string {
  if (result === undefined) return "no handler";
  return typeof result === "string" ? result : result.text;
}

type Api = Record<string, (input: unknown) => Promise<unknown>>;
type Card = { consentId: string; state: string; tool: string; prompt: string; alwaysOffered?: boolean; by?: string };

describe("a local plugin's tools ask one by one", () => {
  let lite: CoreLite;
  let api: Api;
  let source: string;
  let dir: string;
  let threadId: string;
  /** The live tool the fake engine's session calls in its turn, and what it was answered. */
  let liveTool = "";
  let liveAnswer = "";

  const call = (method: string, params: unknown) => {
    const handler = api[method];
    assert.ok(handler, method);
    return handler(params);
  };
  const invoke = (name: string) => call(HostMethod.PluginsInvoke, { project: PROJECT, threadId, name, args: {} });
  const cards = async (): Promise<Card[]> =>
    (await lite.core.listAllEvents()).flatMap((event) =>
      event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginConsent
        ? [event.data.payload as Card]
        : [],
    );
  /** The pending card asked since `known` was taken, waiting for it to show. */
  const nextCard = async (known: Set<string>): Promise<Card | undefined> => {
    for (let waited = 0; waited < LOOK_MS; waited += LOOK_STEP_MS) {
      const card = (await cards()).find((c) => c.state === "pending" && !known.has(c.consentId));
      if (card) return card;
      await sleep(LOOK_STEP_MS);
    }
    return undefined;
  };
  const askedIds = async () => new Set((await cards()).map((c) => c.consentId));
  const calls = async (): Promise<string[]> =>
    (await readFile(path.join(dir, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  /**
   * A fresh start for a test: an empty call log and a new chat in Auto, since a card declined in a
   * chat answers the same call no again until the person speaks there.
   */
  const fresh = async () => {
    await writeFile(path.join(dir, "calls.log"), "");
    threadId = await lite.core.store.createThread({ title: "Bench", metadata: { kind: "game", project: PROJECT } });
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
  };
  const allowed = () => lite.core.plugins.list().find((p) => p.manifest.id === PLUGIN_ID)?.allowedTools ?? [];
  /** Calls `name`, and answers its card: `approve`, and Always allow when `always`. */
  const answered = async (name: string, approve: boolean, always = false) => {
    const known = await askedIds();
    const running = invoke(name);
    const card = await nextCard(known);
    assert.ok(card, `${name} asks`);
    lite.core.resolveConsent(card.consentId, approve, always);
    return { card, answer: await running };
  };
  /** Calls `name` and reads whether a card asked: none asked, it runs at once. */
  const runsWithoutAsking = async (name: string) => {
    const known = await askedIds();
    const answer = await invoke(name);
    const asked = (await cards()).some((c) => !known.has(c.consentId));
    return { answer, asked };
  };

  before(async () => {
    lite = await coreLite({ consentTimeoutMs: CONSENT_TIMEOUT_MS });
    const { core } = lite;
    core.engines.register({
      id: ENGINE,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
        liveAnswer = await Promise.resolve(request.onLiveTool?.(liveTool, {})).then(
          (result: LiveToolResult | undefined) => liveText(result),
          (error: unknown) => `refused: ${String(error)}`,
        );
        // The session's own words agree, which answers nothing.
        return { ok: true, engine: ENGINE, sessionId: "s", turns: 1, usage: {}, summary: "Yes, approve it." };
      },
    } as never);
    await core.games.scaffold(PROJECT);
    dir = await realpath(core.games.dirFor(PROJECT));
    await mkdir(dir, { recursive: true });
    source = await localPackage();
    await core.plugins.installLocal(source, PluginSourceKind.Local, []);
    // The person turns it on: loaded from a folder, it starts off.
    await core.plugins.setEnabled(PLUGIN_ID, true);
    api = lite.api() as unknown as Api;
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("each agent tool of a local plugin asks before it runs, and a no runs nothing", async () => {
    await fresh();
    const { card, answer } = await answered(BUILD, false);
    assert.equal(card.alwaysOffered, true, "the card offers Always allow");
    assert.equal(card.tool, BUILD);
    assert.match(card.prompt, new RegExp(PLUGIN_NAME), "it names the plugin");
    assert.match(card.prompt, /build/, "and the tool");
    assert.match(card.prompt, /runs with your access/);
    assert.equal((answer as { consent?: string }).consent, "declined");
    assert.deepEqual(await calls(), [], "a no runs nothing");
    const yes = await answered(SHIP, true);
    assert.deepEqual(yes.answer, { ran: "ship" });
    assert.deepEqual(await calls(), ["ship"], "a yes runs it once");
    const again = await answered(SHIP, false);
    assert.equal((again.answer as { consent?: string }).consent, "declined", "and the next call asks again");
    const own = await answered(STAMP, true);
    assert.equal(
      own.card.prompt,
      `${PLUGIN_NAME} was loaded from a folder on this Mac and runs with your access. Stamp the sheet?`,
      "a tool with its own question asks it after Genex's words on a local plugin",
    );
    assert.equal(own.card.alwaysOffered, undefined, "and never offers Always allow");
  });

  it("Always allow covers that tool only, and new code or turning it off asks again", async () => {
    await fresh();
    await answered(BUILD, true, true);
    assert.deepEqual(allowed(), ["build"]);
    assert.deepEqual(await runsWithoutAsking(BUILD), { answer: { ran: "build" }, asked: false });
    await answered(SHIP, false);
    const ownQuestion = await answered(STAMP, false);
    assert.equal(ownQuestion.card.tool, STAMP, "a tool with its own question still asks it");

    await lite.core.plugins.installLocal(source, PluginSourceKind.Local, []);
    assert.deepEqual(allowed(), [], "new code forgets the grant");
    await answered(BUILD, true, true);
    await lite.core.plugins.setEnabled(PLUGIN_ID, false);
    await lite.core.plugins.setEnabled(PLUGIN_ID, true);
    assert.deepEqual(allowed(), [], "turning it off forgets the grant");
    await answered(BUILD, true, true);
    await lite.core.plugins.forgetAllowed(PLUGIN_ID);
    assert.deepEqual(allowed(), [], "Ask every time forgets the grant");
    const asks = await answered(BUILD, false);
    assert.equal(asks.card.tool, BUILD, "and the next call asks");
  });

  it("Bypass, a run's own consent and an agent's message never answer it", async () => {
    await fresh();
    await lite.core.plugins.forgetAllowed(PLUGIN_ID);
    const known = await askedIds();
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    try {
      const answer = (await invoke(SHIP)) as { consent?: string };
      assert.equal(answer.consent, "declined", "in Bypass the card still asks, and nobody answering is no yes");
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    }
    // A run going in this chat, its builder's session calling the tool in its turn.
    await lite.core.append(
      [
        {
          type: EventKind.Custom,
          event_type: CustomEvent.RunStarted,
          payload: { runId: RUN_ID, project: PROJECT, goal: "a bench" },
        },
      ],
      threadId,
    );
    lite.core.host.options.onNotify?.("run.keepawake", { runId: RUN_ID });
    liveTool = SHIP;
    const delegate = api["engine.delegate"] as (params: unknown) => Promise<unknown>;
    await delegate({
      engine: ENGINE,
      prompt: "ship it",
      project: PROJECT,
      threadId,
      director: { runId: RUN_ID, threadId, project: PROJECT, root: dir, setup: null, tools: [] },
      chatTurn: { messageId: RUN_ID },
    });
    assert.match(liveAnswer, /Nobody answered/, "the run's session was told nobody answered");
    const asked = (await cards()).filter((c) => !known.has(c.consentId) && c.tool === SHIP);
    assert.deepEqual(
      asked.map((c) => [c.state, c.by]),
      [
        ["pending", undefined],
        ["declined", "timeout"],
        ["pending", undefined],
        ["declined", "timeout"],
      ],
      "both calls asked, and each card went unanswered whatever the session said",
    );
    assert.deepEqual(await calls(), [], "nothing ran");
    assert.deepEqual(
      Object.keys(api).filter((method) => /consent/i.test(method)),
      [],
      "no host method answers a card",
    );
  });

  it("the card comes before the tool's lock", async () => {
    await fresh();
    await lite.core.plugins.forgetAllowed(PLUGIN_ID);
    const known = await askedIds();
    const running = invoke(BUILD);
    const card = await nextCard(known);
    assert.ok(card, "the call asks");
    assert.deepEqual(lite.core.locks.holders(), [], "nothing is held while the card waits");
    lite.core.resolveConsent(card.consentId, true);
    assert.deepEqual(await running, { ran: "build" });
    assert.deepEqual(lite.core.locks.holders(), [], "and it let go after");
  });

  it("a local plugin's harness steps run at Genex's moments without a card; its agent tool still asks", async () => {
    await fresh();
    await lite.core.plugins.forgetAllowed(PLUGIN_ID);
    const known = await askedIds();
    const report = (await call(HostMethod.HooksFire, { project: PROJECT, on: HookEvent.Health })) as {
      ran: string[];
    };
    assert.deepEqual(report.ran, [`${PLUGIN_ID}__tidy`]);
    assert.deepEqual(await calls(), ["tidy"], "the step ran");
    assert.equal((await cards()).filter((c) => !known.has(c.consentId)).length, 0, "with no card");
    const asks = await answered(BUILD, false);
    assert.equal(asks.card.tool, BUILD, "its agent tool still asks");
  });

  it("Watch folder is refused for a plugin loaded from a game's folder, and allowed for one elsewhere", async () => {
    const inGame = path.join(dir, "genex-plugins", "bench2");
    await mkdir(inGame, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    await writeFile(path.join(inGame, "plugin.json"), JSON.stringify({ ...manifest, id: "bench2" }));
    await writeFile(path.join(inGame, "backend.mjs"), BACKEND);
    const { plugins } = lite.core;
    await plugins.installLocal(inGame, PluginSourceKind.Local, [], { kind: PluginSourceKind.Local, directory: inGame });
    await plugins.setEnabled("bench2", true);
    try {
      await assert.rejects(plugins.watch("bench2", true), /agents write/);
      await plugins.watch(PLUGIN_ID, true);
      await plugins.watch(PLUGIN_ID, false);
    } finally {
      await plugins.setEnabled("bench2", false);
    }
  });

  it("no host method or tool an agent reaches loads or turns on a plugin", async () => {
    await lite.core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    assert.equal(lite.core.plugins.enabled(TOY_PLUGIN_ID), false, "loaded, it starts off");
    const build = `${TOY_PLUGIN_ID}__build`;
    const params: Record<string, unknown> = {
      [HostMethod.PluginsTools]: { project: PROJECT },
      [HostMethod.PluginsWorkerTypes]: { project: PROJECT },
      [HostMethod.PluginsFind]: { project: PROJECT, text: "toy" },
      [HostMethod.PluginsSuggest]: { project: PROJECT, threadId, plugin: TOY_PLUGIN_ID, reason: "a toy project" },
      [HostMethod.PluginsPreflightMultiplayer]: { project: PROJECT, threadId },
      [HostMethod.PluginsInvoke]: { project: PROJECT, threadId, name: build, args: {} },
    };
    const pluginMethods = Object.values(HostMethod).filter((method) => method.startsWith("plugins."));
    assert.deepEqual(Object.keys(params).sort(), [...pluginMethods].sort(), "every plugins.* method is tried");
    for (const method of pluginMethods) {
      await call(method, params[method]).catch(() => undefined);
      assert.equal(lite.core.plugins.enabled(TOY_PLUGIN_ID), false, `${method} leaves it off`);
    }
    await assert.rejects(invoke(build), /unavailable|Unknown/i, "its tool is unknown while it is off");
    const tools = (await call(HostMethod.PluginsTools, { project: PROJECT })) as { tools: Array<{ name: string }> };
    assert.ok(!tools.tools.some((tool) => tool.name === build), "and never offered");
  });
});

describe("a local plugin's saved Always allow", () => {
  /** A registry of its own under `root`, with the test plugin installed and on, its cards answered by `answer`. */
  async function registryAt(root: string) {
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      path.join(root, "seeds"),
      PLUGIN_SDK_BACKEND,
      async () => null,
    );
    closeBeforeCleanup(async () => registry.cancel());
    await registry.init();
    const asked: string[] = [];
    let answer: (tool: PluginTool) => Promise<{ approved: boolean; by: "user"; always?: boolean }> = async () => ({
      approved: false,
      by: "user",
    });
    registry.consent = async (_id, tool) => {
      asked.push(tool.name);
      return answer(tool);
    };
    return {
      registry,
      asked,
      answerWith: (next: typeof answer) => {
        answer = next;
      },
      allowed: () => registry.list().find((p) => p.manifest.id === PLUGIN_ID)?.allowedTools ?? [],
    };
  }
  async function fresh() {
    const root = await tmpDir("studio-local-allow-");
    await mkdir(path.join(root, "seeds"));
    const game = await tmpDir("studio-local-allow-game-");
    return { root, game, source: await localPackage() };
  }
  const run = (registry: PluginRegistry, game: string, tool: string) =>
    registry.tool(`${PLUGIN_ID}__${tool}`, {}, { project: PROJECT, directory: game }).catch((error: Error) => error);

  it("an Always allow is saved with the plugin and still answers after a restart", async () => {
    const { root, game, source } = await fresh();
    const first = await registryAt(root);
    await first.registry.installLocal(source, PluginSourceKind.Local, []);
    await first.registry.setEnabled(PLUGIN_ID, true);
    first.answerWith(async () => ({ approved: true, by: "user", always: true }));
    assert.deepEqual(await run(first.registry, game, "ship"), { ran: "ship" });
    first.registry.cancel();
    const again = await registryAt(root);
    assert.deepEqual(again.allowed(), ["ship"], "read back with the record");
    assert.deepEqual(await run(again.registry, game, "ship"), { ran: "ship" });
    assert.deepEqual(again.asked, [], "and it ran without a card");
  });

  it("a saved grant that isn't a list of names grants nothing", async () => {
    const { root, game, source } = await fresh();
    const first = await registryAt(root);
    await first.registry.installLocal(source, PluginSourceKind.Local, []);
    await first.registry.setEnabled(PLUGIN_ID, true);
    first.registry.cancel();
    const file = path.join(root, "installed", "installed.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    records[PLUGIN_ID].allowed = "shipping build";
    await writeFile(file, JSON.stringify(records));
    const again = await registryAt(root);
    for (const tool of ["ship", "build"]) {
      assert.ok((await run(again.registry, game, tool)) instanceof Error, `${tool} is declined`);
    }
    assert.deepEqual(again.asked, ["ship", "build"], "each still asked");
  });

  it("an Always allow answered after the plugin was loaded again is not kept for the new code", async () => {
    const { root, game, source } = await fresh();
    const { registry, allowed, answerWith } = await registryAt(root);
    await registry.installLocal(source, PluginSourceKind.Local, []);
    await registry.setEnabled(PLUGIN_ID, true);
    let release: () => void = () => {};
    const reloaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerWith(async () => {
      await reloaded;
      return { approved: true, by: "user", always: true };
    });
    const running = run(registry, game, "ship");
    await sleep(LOOK_STEP_MS);
    await registry.installLocal(source, PluginSourceKind.Local, []);
    release();
    assert.ok(
      (await running) instanceof Error,
      "the yes was for the code the person was asked about: it never runs the new code",
    );
    assert.deepEqual(allowed(), [], "the grant was for the code the person was asked about");
  });

  it("an Always allow answered while turning it off is queued ahead leaves no grant once it is on again", async () => {
    const { root, game, source } = await fresh();
    const { registry, allowed, answerWith, asked } = await registryAt(root);
    await registry.installLocal(source, PluginSourceKind.Local, []);
    await registry.setEnabled(PLUGIN_ID, true);
    // A plugin whose backend takes a while to start: turning it on holds the registry's queue.
    const slow = await localPackage();
    const manifest = JSON.parse(await readFile(path.join(slow, "plugin.json"), "utf8"));
    await writeFile(path.join(slow, "plugin.json"), JSON.stringify({ ...manifest, id: "slow" }));
    await writeFile(
      path.join(slow, "backend.mjs"),
      `await new Promise((resolve) => setTimeout(resolve, 300));\n${BACKEND}`,
    );
    await registry.installLocal(slow, PluginSourceKind.Local, []);
    let queued: Promise<unknown> = Promise.resolve();
    answerWith(async () => {
      queued = Promise.all([registry.setEnabled("slow", true), registry.setEnabled(PLUGIN_ID, false)]);
      return { approved: true, by: "user", always: true };
    });
    assert.ok((await run(registry, game, "ship")) instanceof Error, "turned off before it ran: it never runs");
    await queued;
    await registry.setEnabled(PLUGIN_ID, true);
    assert.deepEqual(allowed(), [], "no grant was kept on the record turned off");
    answerWith(async () => ({ approved: false, by: "user" }));
    asked.length = 0;
    assert.ok((await run(registry, game, "ship")) instanceof Error);
    assert.deepEqual(asked, ["ship"], "it asks again");
  });
});

describe("a local plugin's own server tools", () => {
  /** An MCP server over stdio with one `echo` tool, written with nothing to import (its package has no node_modules). */
  const SERVER_SCRIPT = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const echo = { name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } };
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
  if (method === "tools/list") return send({ id, result: { tools: [echo] } });
  if (method === "tools/call") return send({ id, result: { content: [{ type: "text", text: String(params.arguments?.text ?? "") }] } });
  send({ id, error: { code: -32601, message: "no such method" } });
});
`;
  const SERVER_PLUGIN = "ls";
  const SERVER_TOOL = `${SERVER_PLUGIN}-echo__echo`;

  /** A local plugin whose work is an MCP server of its own (`node server.mjs`), no backend tools. */
  async function serverPackage(): Promise<string> {
    const folder = await tmpDir("studio-local-server-");
    const manifest = {
      apiVersion: 3,
      id: SERVER_PLUGIN,
      version: "1.0.0",
      name: "Local echo",
      publisher: "Studio tests",
      description: "Echoes from a server loaded from a folder.",
      backend: "backend.mjs",
      capabilities: [],
      tools: [],
      skills: [],
      panels: [],
      settings: [],
      actions: [],
      mcpServers: [
        {
          id: "echo",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
          cwd: "storage:project",
          // Said to only read: a local plugin's server asks every call all the same.
          reads: ["echo"],
          description: "Echoes.",
        },
      ],
    };
    await writeFile(path.join(folder, "plugin.json"), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(folder, "backend.mjs"), "export async function activate() { return {}; }\n");
    await writeFile(path.join(folder, "server.mjs"), SERVER_SCRIPT);
    return folder;
  }

  it("ask every call: Bypass, Auto, the tool's own reads, a saved Always allow and silence never run them", async () => {
    const lite = await coreLite({ consentTimeoutMs: CONSENT_TIMEOUT_MS });
    try {
      const project = "echo-bench";
      await lite.core.games.scaffold(project);
      const threadId = await lite.core.createGameThread(project);
      await lite.core.plugins.installLocal(await serverPackage(), PluginSourceKind.Local, []);
      await lite.core.plugins.setEnabled(SERVER_PLUGIN, true);
      await lite.core.mcp.toolsFor(project);
      const api = lite.api() as unknown as Api;
      const echo = () => api["mcp.invoke"]!({ project, threadId, name: SERVER_TOOL, args: { text: "one" } });
      const pending = async () =>
        (await lite.core.listAllEvents()).flatMap((event) =>
          event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginConsent
            ? [event.data.payload as Card]
            : [],
        );

      await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
      await assert.rejects(echo(), /declin|Nobody answered|consent/i, "Bypass does not answer its card");
      await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
      await lite.core.mcp.alwaysAllow(SERVER_TOOL, project);
      await assert.rejects(echo(), /declin|Nobody answered|consent/i, "a saved Always allow does not either");
      const cards = (await pending()).filter((card) => card.tool === "echo" || card.tool === SERVER_TOOL);
      assert.equal(cards.filter((card) => card.state === "pending").length, 2, "both calls asked");
      assert.ok(
        cards.every((card) => card.state !== "pending" || /runs with your access/.test(card.prompt)),
        "its card says it runs with your access",
      );
      assert.ok(
        cards.every((card) => !card.alwaysOffered),
        "and offers no Always allow",
      );

      const known = new Set((await pending()).map((card) => card.consentId));
      const answered = echo();
      let card: Card | undefined;
      for (let waited = 0; waited < LOOK_MS && !card; waited += LOOK_STEP_MS) {
        card = (await pending()).find((c) => c.state === "pending" && !known.has(c.consentId));
        if (!card) await sleep(LOOK_STEP_MS);
      }
      assert.ok(card, "the next call asks");
      lite.core.resolveConsent(card.consentId, true);
      assert.equal(await answered, "one", "a yes runs it once");
    } finally {
      lite.core.plugins.cancel();
      await lite.core.mcp.close();
      await lite.close();
    }
  });
});

describe("the words a local plugin carries", () => {
  it("the trust dialog, the plugin page and the suggestion card say a local plugin runs with your access", async () => {
    const manifest = JSON.parse(await readFile(path.join(TOY_PLUGIN, "plugin.json"), "utf8"));
    const local = installDetail({ manifest, origin: { kind: PluginSourceKind.Local, directory: TOY_PLUGIN } });
    assert.match(local, /It runs with your access: Genex doesn't sandbox its code\./);
    assert.match(local, /It starts off: turn it on in Plugins; each of its tools asks you before it runs\./);
    assert.match(local, /Once on, it runs at Genex's moments: /, "a plugin with hooks names its moments");
    const github = installDetail({
      manifest,
      origin: { kind: PluginSourceKind.Github, repo: "someone/toy", sha: "a".repeat(40) },
    });
    assert.doesNotMatch(github, /runs with your access|starts off/, "another source says what it always said");

    const info = (source: PluginSourceKind) =>
      ({ manifest, source, enabled: true, removed: false }) as unknown as PluginInfo;
    assert.equal(localAccessNote(info(PluginSourceKind.Local)), PLUGINS_WORDS.page.localAccess);
    assert.equal(localAccessNote(info(PluginSourceKind.Bundled)), null);
    assert.match(PLUGINS_WORDS.page.localAccess, /runs with your access/);

    const list = [info(PluginSourceKind.Local)];
    assert.equal(suggestionLocalAccess(list, TOY_PLUGIN_ID), PLUGIN_SUGGESTION_WORDS.localAccess);
    assert.equal(suggestionLocalAccess([info(PluginSourceKind.Github)], TOY_PLUGIN_ID), "");
    assert.equal(suggestionLocalAccess([], TOY_PLUGIN_ID), "", "a plugin not installed says nothing yet");
    assert.match(PLUGIN_SUGGESTION_WORDS.localAccess, /runs with your access/);
    for (const words of [PLUGINS_WORDS.page.localAccess, PLUGIN_SUGGESTION_WORDS.localAccess])
      assert.match(words, /its own steps at Genex's moments don't ask/, "never a promise that all of its code asks");
  });

  it("the trust dialog names every step a local plugin runs without asking", () => {
    const empty = { type: "object", properties: {} };
    const manifest = validateManifest({
      apiVersion: 3,
      id: "steps",
      version: "1.0.0",
      name: "Steps",
      publisher: "Studio tests",
      description: "Every kind of step.",
      backend: "backend.mjs",
      capabilities: [],
      detect: [{ fact: "steps-project", files: ["*.steps"] }],
      locks: [{ id: "desk", label: "Desk", per: "project", personFirst: "busy" }],
      hooks: [{ on: "health", tool: "tidy" }],
      observers: [{ id: "desk-look", facts: ["steps-project"], tool: "look" }],
      tools: [
        { name: "new-steps", description: "Make one.", parameters: empty, makes: ["steps-project"], ready: "ready" },
        { name: "tidy", audience: "harness", description: "Tidy.", parameters: empty },
        { name: "look", audience: "harness", description: "Look.", parameters: empty },
        { name: "busy", audience: "harness", description: "Busy?", parameters: empty },
        { name: "ready", audience: "harness", description: "Ready?", parameters: empty },
      ],
      skills: [],
      panels: [],
      settings: [],
      actions: [],
    });
    const words = installDetail({ manifest, origin: { kind: PluginSourceKind.Local, directory: "/x/steps" } });
    for (const step of [
      "on health checks",
      "when a reviewer checks a finish",
      "while it holds a lock",
      "before a project of its kind is made",
    ])
      assert.ok(words.includes(step), `${step}: ${words}`);
    assert.match(words, /those steps don't ask you first/);
  });
});
