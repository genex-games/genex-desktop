/**
 * Who may run a plugin tool, and when Plan mode holds it back: the harness's own steps, a run's
 * calls, and an agent naming a tool kept for the harness.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createToolRegistry } from "../../src/harness-seed/tools/index.ts";
import { PluginToolService, type PluginCallContext } from "../../src/main/core/plugin-tools.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { HostMethod, harnessParamsProblem } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { PluginCallBlocker, PluginToolAudience } from "../../src/shared/plugins.ts";
import { UnrealLivePluginTool, UnrealLoopTool } from "../../src/harness-seed/loop/unreal/live-contract.ts";
import { heldInPlan, unrealTool, unrealWrite } from "../../src/harness-seed/loop/unreal/lead-steps.ts";
import { LeadPluginTool } from "../../src/harness-seed/loop/unreal/save-point.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyOfExample, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "plan-guard";
const EDITOR_IDLE = { answering: false, running: null, reopening: { state: "idle" }, helper: null };

describe("the harness's plugins.invoke", () => {
  let lite: CoreLite;
  let threadId: string;
  let invoke: (params: Record<string, unknown>) => Promise<unknown>;

  before(async () => {
    lite = await coreLite();
    await lite.core.plugins.setEnabled("unreal", true);
    await lite.core.games.scaffold(PROJECT);
    threadId = await lite.core.createGameThread(PROJECT);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const call = api["plugins.invoke"];
    assert.ok(call);
    invoke = (params) => call({ project: PROJECT, threadId, args: {}, ...params });
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.core.mcp.close().catch(() => {});
    await lite.close();
  });

  it("in Plan mode the harness's own steps still run", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      assert.deepEqual(await invoke({ name: UnrealLoopTool.EditorState, step: true }), EDITOR_IDLE);
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    }
  });

  it("in Plan mode a chat checkpoint's steps change nothing", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      for (const name of [LeadPluginTool.EditorActivity, UnrealLivePluginTool.SaveAll]) {
        const answer = (await invoke({ name, step: true, checkpoint: true })) as { blocker?: unknown };
        assert.equal(answer?.blocker, PluginCallBlocker.PlanMode, name);
      }
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    }
  });

  it("in Plan mode the Unreal Loop runner's writes wait; its reads still run", async () => {
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const ctx = { call: (method: string, params: unknown) => api[method]!(params) };
    const lead = { ctx, run: { project: PROJECT }, threadId } as never;
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      // A held write throws, so whatever it was part of (a save point, a rewind, a module) is not done.
      for (const name of [UnrealLivePluginTool.SaveAll, UnrealLivePluginTool.EndEditor, UnrealLoopTool.AddCppModule])
        await assert.rejects(unrealWrite(lead, name), (err) => heldInPlan(err), name);
      assert.deepEqual(await unrealTool(lead, UnrealLoopTool.EditorState), EDITOR_IDLE);
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    }
  });

  it("an agent naming a tool kept for the harness is refused, and nothing runs", async () => {
    // A mistyped flag is refused by the host's params check before any handler; at the handler it
    // reads as no step all the same.
    const hostile: Array<[string, Record<string, unknown>, boolean]> = [
      ["no step", {}, false],
      ["step: false", { step: false }, false],
      ['step: "true"', { step: "true" }, true],
      ["step: 1", { step: 1 }, true],
      ["step: {}", { step: {} }, true],
    ];
    for (const [label, extra, mistyped] of hostile) {
      const params = { project: PROJECT, threadId, name: UnrealLoopTool.RunPart, args: { part: "../x" }, ...extra };
      const refused = harnessParamsProblem(HostMethod.PluginsInvoke, params);
      assert.equal(refused !== null, mistyped, label);
      if (refused) assert.match(refused.message, /step/, label);
      await assert.rejects(invoke(params), /Unknown tool: unreal__run-part/, label);
    }
    assert.equal(
      harnessParamsProblem(HostMethod.PluginsInvoke, { project: PROJECT, name: "x", args: {}, step: true }),
      null,
    );
    // A mistyped checkpoint would read as none at the handler, and a write would run in a planning chat.
    for (const checkpoint of ["true", 1, {}]) {
      const params = {
        project: PROJECT,
        threadId,
        name: UnrealLivePluginTool.SaveAll,
        args: {},
        step: true,
        checkpoint,
      };
      const refused = harnessParamsProblem(HostMethod.PluginsInvoke, params);
      assert.ok(refused, JSON.stringify(checkpoint));
      assert.match(refused.message, /checkpoint/, JSON.stringify(checkpoint));
    }
    await assert.rejects(
      invoke({ name: UnrealLoopTool.RunPart, args: { part: "../x" }, step: true }),
      /not a part name/,
    );
  });
});

it("a run's plugin call answers to the Plan mode of the chat the run was started in", async () => {
  const { core, close } = await coreLite();
  try {
    const parent = await core.store.createThread({ metadata: { project: "chess" } });
    const child = await core.store.createThread();
    await core.append([customEventData(CustomEvent.RunStarted, { runId: "run-p", project: "chess" })], parent);
    const service = new PluginToolService(core, {
      consent: null as never,
      pluginCallAttribution: new WeakMap(),
      mcpSecrets: null,
      activeConnectorCalls: new Map(),
      cutOffCalls: new Map(),
      planning: async (thread) => thread === parent,
      bypassing: async () => false,
      locks: core.locks,
      hooks: core.hooks,
    });
    const ways: Array<[string, Partial<PluginCallContext>]> = [
      ["a worker's attribution", { attribution: { runId: "run-p", agentId: "w1" } }],
      ["the director's session", { director: { runId: "run-p" } }],
      ["a self-capture", { selfCapture: { runId: "run-p" } }],
    ];
    for (const [way, row] of ways) {
      const binding = { project: "chess", directory: "/unused", threadId: child };
      const answer = (await service.invokePluginTool(
        "genex__asset",
        { operation: "image", prompt: "x" },
        binding,
        undefined,
        { engine: "claude-code", ...row },
      )) as { blocker?: unknown };
      assert.equal(answer?.blocker, PluginCallBlocker.PlanMode, way);
    }
    for (const thread of [parent, child]) {
      const started = (await core.store.listEvents(thread)).filter(
        (e) => e.data.type === "custom" && e.data.event_type === CustomEvent.PluginToolStarted,
      );
      assert.deepEqual(started, [], "nothing started");
    }
  } finally {
    core.plugins.cancel();
    await close();
  }
});

/** A registry whose only plugin is the example on API 3, its `shout` kept for the harness. */
async function harnessShoutRegistry() {
  const root = await tmpDir("studio-invoke-guards-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, "example", (manifest) => {
    manifest.apiVersion = 3;
    for (const tool of manifest.tools) if (tool.name === "shout") tool.audience = PluginToolAudience.Harness;
  });
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return { registry, binding: { project: "game", directory: root } };
}

it("the registry runs a tool kept for the harness only for the harness", async () => {
  const { registry, binding } = await harnessShoutRegistry();
  try {
    let asked = 0;
    registry.consent = async () => {
      asked++;
      return { approved: true, by: "user" };
    };
    await assert.rejects(registry.tool("example__shout", { text: "hi" }, binding), /Unknown plugin tool/);
    await assert.rejects(
      registry.tool("example__shout", { text: "hi" }, binding, undefined, PluginToolAudience.Agents),
      /Unknown plugin tool/,
    );
    assert.equal(asked, 0, "no card for a call that may not run");
    assert.deepEqual(
      await registry.tool("example__shout", { text: "hi" }, binding, undefined, PluginToolAudience.Harness),
      { text: "HI", project: "game" },
    );
    assert.equal(asked, 1, "the harness's call still asks for its confirmation");
  } finally {
    registry.cancel();
  }
});

it("a local model's plugin tool call never claims to be a harness step", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    if (method === "plugins.tools")
      return {
        tools: [{ name: "example__greet", description: "Greets", parameters: { type: "object", properties: {} } }],
        guidance: "",
        revision: 1,
      };
    if (method === "mcp.tools") return { tools: [], guidance: "", revision: 1 };
    if (method === "plugins.invoke") sent.push(params);
    return { greeting: "hi" };
  };
  const workspace = path.resolve("src/harness-seed");
  const registry = await createToolRegistry({ workspace, call } as never, { project: PROJECT });
  const answer = await registry.execute({ name: "example__greet", arguments: {} }, {
    project: PROJECT,
    threadId: "t",
    call,
  } as never);
  assert.equal(answer.ok, true, answer.content);
  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0] ?? {}, "step"), false);
  assert.equal(Object.hasOwn(sent[0] ?? {}, "checkpoint"), false);
});
