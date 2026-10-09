/**
 * When the harness dies, plugins keep running and keep their connectors; a call it cut off is
 * recorded as outcome unknown and the next session is told to check it.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { clearCutOffs, type CutOffCall, noteCutOff, peekCutOffs } from "../../src/main/core/cut-off-calls.ts";
import { cutOffNotice } from "../../src/main/core/delegation-prompts.ts";
import { CustomEvent, customEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { CallCutOff } from "../../src/shared/plugins.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type PluginMcpLaunch, PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

/** The id of the test's own plugin: a backend tool that waits, and a connector that loses its app. */
const PLUGIN = "cutdemo";
const NOTICE = /^Studio notice: these calls were cut off before they answered/;
/** What the test's engine notes for a compaction, which reads no prompt. */
const COMPACTED = "(compacted)";

/**
 * The plugin's MCP server, dependency-free: `lost` answers the error a connector gives when the app
 * it drives went away mid-call (it carries the outcome-unknown marker), `fail` an ordinary error,
 * and `hang` never answers.
 */
const SERVER = `
const TOOLS = ["lost", "fail", "hang"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
function answer(name) {
  if (name === "lost") return { isError: true, content: [{ type: "text", text: "the app went away mid-call" }], _meta: { "genex/outcome": "unknown" } };
  return { isError: true, content: [{ type: "text", text: "the app refused" }] };
}
process.stdin.setEncoding("utf8");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const { id, method, params } = JSON.parse(line);
    if (id === undefined || id === null) continue;
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cut-fixture", version: "1.0.0" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else if (method === "tools/call") { if (params?.name !== "hang") send({ jsonrpc: "2.0", id, result: answer(params?.name) }); }
    else send({ jsonrpc: "2.0", id, result: {} });
  }
}
`;

/**
 * A backend whose `wait` answers only once its call is cancelled, `who` names its process and how
 * many waits it was sent, and `die` ends its process mid-call.
 */
const BACKEND = `let waits = 0;
export async function activate() {
  return {
    async tool(name, args, ctx) {
      if (name === "who") return { pid: process.pid, waits };
      if (name === "die") {
        setTimeout(() => process.exit(1), 20);
        return new Promise(() => {});
      }
      waits++;
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      return { waited: true };
    },
  };
}
`;

/** The test's plugin as a local folder: one agent tool, `wait`, and one MCP server, `editor`. */
async function cutPackage(root: string): Promise<string> {
  const dir = await copyOfExample(root, PLUGIN, (m) => {
    m.id = PLUGIN;
    m.name = "Cut demo";
    m.capabilities = [];
    m.settings = [];
    m.panels = [];
    m.toolbar = [];
    m.actions = [];
    m.skills = [];
    const tool = (name: string, description: string) => ({
      name,
      description,
      parameters: { type: "object", properties: {} },
    });
    m.tools = [
      tool("wait", "Wait until cancelled."),
      tool("who", "Name the backend."),
      tool("die", "End the backend mid-call."),
    ];
    m.mcpServers = [
      {
        id: "editor",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "storage:project",
        description: "An app.",
      },
    ];
  });
  await writeFile(path.join(dir, "backend.mjs"), BACKEND);
  await writeFile(path.join(dir, "server.mjs"), SERVER);
  return dir;
}

/** Poll until `predicate` holds. */
async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A record's error text never opens with a class name ("PluginCallCutOff: …"). */
const CLASS_NAME_FIRST = /^\w+: /;

/** A harness that dies and is brought back by the watchdog, with no harness process in this test. */
async function crashHarness(lite: CoreLite): Promise<void> {
  lite.core.host.restart = (async () => {}) as never;
  lite.core.host.healthcheck = (async () => true) as never;
  await lite.core.recover("harness crashed 3× in a row");
}

describe("a harness crash and the plugins", () => {
  let lite: CoreLite;
  let api: Api;
  let threadId: string;
  const project = "cut-off";
  const prompts: string[] = [];
  /** What the next delegated session does first: the plugin tool to call and its arguments, if any. */
  let firstCall: [string, Record<string, unknown>] | null = null;
  /** Whether the next delegated session fails (its engine answers `ok: false`). */
  let failNext = false;

  before(async () => {
    lite = await coreLite();
    api = lite.api() as unknown as Api;
    await lite.core.snapshot("harness", "known good", undefined, true);
    await lite.core.games.scaffold(project);
    threadId = await lite.core.createGameThread(project);
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    await lite.core.plugins.setEnabled("unreal", true);
    const root = await tmpDir("studio-cut-plugin-");
    await lite.core.plugins.installLocal(await cutPackage(root), "local", []);
    await lite.core.plugins.setEnabled(PLUGIN, true);
    await lite.core.mcp.toolsFor(project);
    lite.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      compactsNatively: true,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        prompts.push(request.compact ? COMPACTED : request.prompt);
        const call = firstCall;
        firstCall = null;
        if (call) await request.onLiveTool?.(...call).catch(() => null);
        const ok = !failNext;
        failNext = false;
        return { ok, engine: "claude-code", summary: "fixture", turns: 1, usage: {}, sessionId: "s1" };
      },
    } as never);
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.core.mcp.close().catch(() => {});
    await lite.close();
  });

  const delegate = () => api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "Build it" });
  const events = (): Promise<EventEnvelope[]> => lite.core.store.listEvents(threadId);
  const pluginRecords = async (
    type: typeof CustomEvent.PluginToolStarted | typeof CustomEvent.PluginTool,
    tool = `${PLUGIN}__wait`,
  ) =>
    (await events()).flatMap((event) => {
      const payload = customEvent(event, type);
      return payload && payload.toolName === tool ? [payload] : [];
    });
  /** The backend's own account: its process and the waits it was sent. */
  const who = async () => {
    const answer = await lite.core.plugins.tool(`${PLUGIN}__who`, {}, { project, directory: "/unused", threadId });
    return answer as { pid: number; waits: number };
  };
  const connectorRecords = async (tool: string) =>
    (await events()).flatMap((event) => {
      const payload = customEvent(event, CustomEvent.ConnectorTool);
      return payload?.tool === tool ? [payload] : [];
    });
  const connectorIds = () => lite.core.mcp.ids().filter((id) => lite.core.mcp.ownerOf(id) === "unreal");

  it("a harness crash keeps every plugin's connectors", async () => {
    const before = connectorIds();
    assert.ok(before.length > 0, "the Unreal plugin publishes its editor connector");
    await crashHarness(lite);
    // Withdrawing a plugin's servers is fire-and-forget: give it the time it would take.
    await sleep(200);
    assert.deepEqual(connectorIds(), before);
    assert.ok(lite.core.mcp.ids().includes(`${PLUGIN}-editor`), "the test plugin's connector too");
  });

  it("a harness crash lets go of the game folder a worker held in place", async () => {
    const hold = (id: string) =>
      api["locks.hold"]!({ project, threadId, holder: { id, title: `Writer ${id}` } }) as Promise<object>;
    assert.ok("held" in (await hold("w1")));
    assert.ok("busy" in (await hold("w2")), "one writer in place at a time");
    await crashHarness(lite);
    assert.deepEqual(lite.core.locks.holders(), []);
    assert.ok("held" in (await hold("w2")), "the reborn loop's writer takes it");
    await api["locks.release"]!({ project, threadId, holder: { id: "w2" } });
  });

  it("a plugin call the harness's crash cut off is recorded as outcome unknown, never sent again, and the chat's next session is told to check it", async () => {
    const backend = await who();
    firstCall = [`${PLUGIN}__wait`, {}];
    prompts.length = 0;
    const first = delegate();
    await until(async () => (await pluginRecords(CustomEvent.PluginToolStarted)).length === 1, "the call to start");
    await crashHarness(lite);
    await Promise.allSettled([first]);
    await until(async () => (await pluginRecords(CustomEvent.PluginTool)).length === 1, "the call's record");
    const [record] = await pluginRecords(CustomEvent.PluginTool);
    assert.equal(record?.ok, false);
    assert.equal(record?.cutOff, "harness-ended");
    assert.doesNotMatch(record?.error ?? "", CLASS_NAME_FIRST, "the chat row reads the reason, not a class name");
    await delegate();
    await delegate();
    assert.equal((await pluginRecords(CustomEvent.PluginToolStarted)).length, 1, "the call was never sent again");
    assert.deepEqual(await who(), { pid: backend.pid, waits: 1 }, "the backend kept running and got the call once");
    assert.match(prompts[1] ?? "", NOTICE, "the next session reads the notice first");
    assert.ok(prompts[1]?.includes(`${PLUGIN}__wait`), "naming the call");
    assert.ok(!prompts[2]?.includes("were cut off"), "and only once");
  });

  it("a connector call the harness's crash cut off is recorded as outcome unknown", async () => {
    const call = api["mcp.invoke"]!({ project, threadId, name: `${PLUGIN}-editor__hang`, args: {} }).then(
      () => null,
      (error: unknown) => error,
    );
    await until(
      async () =>
        (await events()).some((event) => customEvent(event, CustomEvent.ConnectorToolStarted)?.tool === "hang"),
      "the connector call to go out",
    );
    await crashHarness(lite);
    assert.ok((await call) instanceof Error, "the call ends with an error");
    const [record] = await connectorRecords("hang");
    assert.equal(record?.ok, false);
    assert.equal(record?.cutOff, "harness-ended");
  });

  it("a connector whose app went away mid-call is recorded as outcome unknown and named to the next session; an ordinary error is not", async () => {
    prompts.length = 0;
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: `${PLUGIN}-editor__fail`, args: {} }),
      /the app refused/,
    );
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: `${PLUGIN}-editor__lost`, args: {} }),
      /the app went away mid-call/,
    );
    assert.equal((await connectorRecords("fail"))[0]?.cutOff, undefined, "an error that never says its outcome");
    assert.equal((await connectorRecords("lost"))[0]?.cutOff, "app-lost");
    await delegate();
    assert.match(prompts[0] ?? "", NOTICE);
    assert.ok(prompts[0]?.includes(`${PLUGIN}-editor__lost`), "naming the call");
    assert.ok(!prompts[0]?.includes(`${PLUGIN}-editor__fail`), "never the ordinary error");
  });

  it("a plugin call whose backend ended mid-call is recorded as outcome unknown and named to the next session", async () => {
    const tool = `${PLUGIN}__die`;
    firstCall = [tool, {}];
    prompts.length = 0;
    await delegate();
    const [record] = await pluginRecords(CustomEvent.PluginTool, tool);
    assert.equal(record?.ok, false);
    assert.equal(record?.cutOff, "plugin-ended");
    assert.match(record?.error ?? "", /exited/);
    assert.doesNotMatch(record?.error ?? "", CLASS_NAME_FIRST);
    assert.equal((await pluginRecords(CustomEvent.PluginToolStarted, tool)).length, 1, "the call started once");
    await delegate();
    assert.match(prompts[1] ?? "", NOTICE);
    assert.ok(prompts[1]?.includes(`${tool} (its plugin stopped while it ran)`), prompts[1]);
  });

  it("a Genex host tool call the harness's crash cut off is recorded as outcome unknown", async () => {
    const tool = "genex__cli";
    const running: string[] = [];
    const hostTool = lite.core.plugins.hostTool;
    lite.core.plugins.hostTool = async (_id, _host, _args, _binding, signal) => {
      running.push(tool);
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { stdout: "too late" };
    };
    try {
      firstCall = [tool, { command: "doctor" }];
      const first = delegate();
      await until(async () => running.length === 1, "the host tool to start");
      await crashHarness(lite);
      await Promise.allSettled([first]);
      await until(async () => (await pluginRecords(CustomEvent.PluginTool, tool)).length === 1, "the call's record");
      const [record] = await pluginRecords(CustomEvent.PluginTool, tool);
      assert.equal(record?.ok, false);
      assert.equal(record?.cutOff, "harness-ended");
      assert.doesNotMatch(record?.error ?? "", CLASS_NAME_FIRST);
    } finally {
      lite.core.plugins.hostTool = hostTool;
    }
  });

  it("a session that failed, or one without host tools, never uses up the notice", async () => {
    prompts.length = 0;
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: `${PLUGIN}-editor__lost`, args: {} }),
      /the app went away mid-call/,
    );
    failNext = true;
    await delegate().catch(() => null);
    // A read-only session gets no host tools: it is neither told nor takes the notice.
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "Look only", readOnly: true });
    await delegate();
    assert.match(prompts[0] ?? "", NOTICE, "the session that failed was told");
    assert.ok(!prompts[1]?.includes("were cut off"), "the session without host tools is not");
    assert.match(prompts[2] ?? "", NOTICE, "the next session that works still reads it");
    assert.ok(prompts[2]?.includes(`${PLUGIN}-editor__lost`), "naming the call");
    await delegate();
    assert.ok(!prompts[3]?.includes("were cut off"), "and then it is used up");
  });

  it("a connector call still waiting on its card when the harness dies never went out: no outcome unknown, no notice", async () => {
    // Another game's chat, which asks before each connector action (the test's own chat bypasses).
    const other = "cut-off-asks";
    await lite.core.games.scaffold(other);
    const asking = await lite.core.createGameThread(other);
    assert.notEqual(asking, threadId);
    await lite.core.setPermissionMode(asking, PermissionMode.Auto);
    await lite.core.mcp.toolsFor(other);
    const tool = `${PLUGIN}-editor__hang`;
    const call = api["mcp.invoke"]!({ project: other, threadId: asking, name: tool, args: { held: true } }).then(
      () => null,
      (error: unknown) => error,
    );
    const carded = async () =>
      (await lite.core.store.listEvents(asking)).some(
        (event) => customEvent(event, CustomEvent.PluginConsent)?.tool === tool,
      );
    await until(carded, "the call's consent card");
    await crashHarness(lite);
    assert.ok((await call) instanceof Error, "the call ends with an error");
    const records = (await lite.core.store.listEvents(asking)).flatMap((event) => {
      const payload = customEvent(event, CustomEvent.ConnectorTool);
      return payload?.tool === "hang" ? [payload] : [];
    });
    assert.ok(records.length > 0, "the call is recorded");
    for (const record of records) assert.equal(record.cutOff, undefined, "it never went out");
    const sessions: string[] = [];
    const told = prompts.length;
    await api["engine.delegate"]!({ engine: "claude-code", project: other, threadId: asking, prompt: "Build it" });
    sessions.push(...prompts.slice(told));
    assert.ok(!sessions.some((prompt) => prompt.includes(tool)), "the next session is not told to check it");
  });

  it("a compaction never uses up the notice: the next session that works still reads it", async () => {
    prompts.length = 0;
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: `${PLUGIN}-editor__lost`, args: {} }),
      /the app went away mid-call/,
    );
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId,
      prompt: "",
      compact: true,
      resume: "s1",
    });
    await delegate();
    assert.deepEqual(prompts[0], COMPACTED);
    assert.match(prompts[1] ?? "", NOTICE);
    assert.ok(prompts[1]?.includes(`${PLUGIN}-editor__lost`), "naming the call");
  });
});

it("ending the calls in flight leaves every plugin's servers published and its account unlocked", async () => {
  const root = await tmpDir("studio-cut-registry-");
  const seeds = path.join(root, "seeds");
  const seed = path.join(seeds, "example");
  await mkdir(seeds);
  await cp(EXAMPLE_PLUGIN, seed, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(seed, "plugin.json"), "utf8"));
  manifest.capabilities.push("credentials");
  manifest.actions.push({ name: "unlock", label: "Unlock saved account", confirmation: "Unlock the saved account." });
  manifest.mcpServers = [
    {
      id: "echo",
      transport: "stdio",
      command: "node",
      args: ["backend.mjs"],
      cwd: "storage:project",
      env: { TOKEN_FILE: "credential-file" },
      requires: { credential: true },
      description: "A server that echoes.",
    },
  ];
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async (id, method) => {
    if (method === "storage.root") return path.join(root, "data", id);
    if (method === "credentials.read") return "tok-registry";
    throw new Error(`unexpected host service ${method}`);
  });
  try {
    await registry.init();
    const seen: Array<{ kind: string; launch?: PluginMcpLaunch }> = [];
    registry.mcpHost = {
      register: (_id, _servers, launch) => {
        seen.push({ kind: "register", launch });
      },
      unregister: () => {
        seen.push({ kind: "unregister" });
      },
    };
    await registry.syncMcpServers();
    const launch = seen.at(-1)?.launch;
    assert.ok(launch);
    await registry.action("example", "unlock", {});
    seen.length = 0;
    registry.abortCalls("harness-ended");
    assert.deepEqual(seen, [], "nothing is withdrawn");
    assert.equal(await launch.credentialFile(), "GENEX_TOKEN=tok-registry\n", "the account stays unlocked");
  } finally {
    registry.cancel();
  }
});

it("a thread keeps its last twenty cut-off calls, each with its arguments clipped, until a session that read them answers", () => {
  const calls = new Map<string, CutOffCall[]>();
  const call = (n: number): CutOffCall => ({ tool: `p__t${n}`, args: "", reason: CallCutOff.HarnessEnded });
  for (let n = 1; n <= 21; n++) noteCutOff(calls, "t", call(n));
  assert.deepEqual(
    peekCutOffs(calls, "t").map((c) => c.tool),
    Array.from({ length: 20 }, (_, i) => `p__t${i + 2}`),
    "the oldest goes first",
  );
  noteCutOff(calls, undefined, call(99));
  assert.deepEqual(peekCutOffs(calls, undefined), [], "a call with no thread is noted nowhere");
  assert.ok(![...calls.values()].flat().some((c) => c.tool === "p__t99"));

  const long = new Map<string, CutOffCall[]>();
  noteCutOff(long, "t", { tool: "p__long", args: "x".repeat(1000), reason: CallCutOff.AppLost });
  assert.equal(
    peekCutOffs(long, "t")[0]?.args.length,
    200,
    "an agent's arguments are clipped before a prompt repeats them",
  );

  const told = peekCutOffs(calls, "t");
  noteCutOff(calls, "t", call(22));
  assert.equal(peekCutOffs(calls, "t").length, 20, "a look takes nothing");
  clearCutOffs(calls, "t", told);
  assert.deepEqual(
    peekCutOffs(calls, "t").map((c) => c.tool),
    ["p__t22"],
    "a call noted after the session was told stays",
  );
  clearCutOffs(calls, "t", peekCutOffs(calls, "t"));
  assert.deepEqual(peekCutOffs(calls, "t"), []);
});

it("the cut-off notice words each reason, and says nothing for no calls", () => {
  assert.equal(cutOffNotice([]), "");
  const why: Array<[CallCutOff, string]> = [
    [CallCutOff.HarnessEnded, "the studio's loop ended while it ran"],
    [CallCutOff.PluginEnded, "its plugin stopped while it ran"],
    [CallCutOff.AppLost, "the app it drives went away while it ran"],
  ];
  for (const [reason, words] of why) {
    const notice = cutOffNotice([{ tool: "p__t", args: '{"a":1}', reason }]);
    assert.match(notice, NOTICE, reason);
    assert.ok(notice.includes(`p__t {"a":1} (${words})`), notice);
  }
});
