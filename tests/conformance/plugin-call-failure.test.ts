/**
 * Why a plugin call failed reaches its `plugin_tool` record as a code, never as words: a plugin's
 * own error code crosses from its backend beside its unchanged words, and the host's own refusals
 * (a tool it doesn't know, arguments that don't fit, a plugin that is off, a declined card, a lock
 * not given, a call cut off) each name themselves. Usage analytics reads these codes to tell a
 * Roblox Studio that isn't connected from a plugin that broke.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pluginCallFailure } from "../../src/main/core/plugin-tools.ts";
import { LockRefusal, LockRefused } from "../../src/main/core/plugin-locks.ts";
import { finishedPayload, startedPayload } from "../../src/main/plugin-activity.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import type { PluginToolFinishedPayload } from "../../src/shared/game-assets.ts";
import { CallCutOff, PluginCallFailure } from "../../src/shared/plugins.ts";
import {
  PluginCallCutOff,
  PluginCallNotSent,
  PluginProcess,
  PluginRestartPaused,
} from "../../src/substrate/plugins/process.ts";
import { PluginConsentDeclined } from "../../src/substrate/plugins/registry.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { PLUGIN_SDK_BACKEND, pluginFixture } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A backend whose tools throw: with a code of its own, a code that is not one, or none. */
async function throwingBackend(): Promise<string> {
  const root = await tmpDir("studio-plugin-failure-");
  const entry = path.join(root, "backend.mjs");
  await writeFile(
    entry,
    [
      "const THROWN = {",
      '  coded: { code: "not-bound" },',
      '  node: { code: "ECONNREFUSED" },',
      '  pathy: { code: "/Users/alice/AI Games/My Secret Game" },',
      '  spaced: { code: "Studio is not connected" },',
      "  numeric: { code: 7 },",
      "  plain: {},",
      "};",
      "export const activate = () => ({",
      "  tool: (name) => {",
      "    throw Object.assign(new Error(`failed ${name}`), THROWN[name] ?? {});",
      "  },",
      "});",
    ].join("\n"),
  );
  return entry;
}

describe("a plugin's own failure", () => {
  const backends: PluginProcess[] = [];
  after(() => {
    for (const backend of backends) backend.stop();
  });

  it("crosses from its backend with its code beside its unchanged words", async () => {
    const backend = new PluginProcess(
      PLUGIN_SDK_BACKEND,
      await throwingBackend(),
      async () => ({}),
      () => {},
    );
    backends.push(backend);
    const failed = async (name: string): Promise<unknown> => {
      try {
        await backend.call("tool", name, {});
      } catch (error) {
        return error;
      }
      assert.fail(`${name} answered`);
    };
    const table: Array<[string, string | undefined]> = [
      ["coded", "not-bound"],
      ["node", "ECONNREFUSED"],
      ["pathy", undefined],
      ["spaced", undefined],
      ["numeric", undefined],
      ["plain", undefined],
    ];
    for (const [name, code] of table) {
      const error = await failed(name);
      assert.ok(error instanceof Error, name);
      // The chat row reads these words: the code changes nothing about them.
      assert.equal(String(error), `Error: failed ${name}`, name);
      assert.deepEqual(
        pluginCallFailure(error),
        { failure: PluginCallFailure.Plugin, ...(code ? { code } : {}) },
        name,
      );
    }
  });
});

describe("the host's own refusals", () => {
  it("the registry names an unknown tool, arguments that don't fit and a plugin that is off", async () => {
    const fixture = await pluginFixture();
    try {
      const { registry, binding } = fixture;
      const refused = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
        registry.tool(name, args, binding).then(
          () => assert.fail(`${name} answered`),
          (error: unknown) => error,
        );
      assert.deepEqual(pluginCallFailure(await refused("example__nope", {})), {
        failure: PluginCallFailure.UnknownTool,
      });
      assert.deepEqual(pluginCallFailure(await refused("example__greet", {})), {
        failure: PluginCallFailure.InvalidArguments,
      });
      assert.deepEqual(pluginCallFailure(await refused("missing__greet", { name: "x" })), {
        failure: PluginCallFailure.Unavailable,
      });
      // Their words are the ones the agent always read.
      await assert.rejects(registry.tool("example__nope", {}, binding), /^Error: Unknown plugin tool/);
    } finally {
      await fixture.close();
    }
  });

  it("each typed stop names itself, and anything else is other", () => {
    const table: Array<[unknown, PluginCallFailure]> = [
      [new PluginCallCutOff(CallCutOff.PluginEnded), PluginCallFailure.CutOff],
      [new PluginConsentDeclined("example__shout", "user"), PluginCallFailure.Declined],
      [new LockRefused(LockRefusal.Busy, "Unreal editor", "busy"), PluginCallFailure.LockRefused],
      [new PluginRestartPaused("paused", 1000), PluginCallFailure.RestartPaused],
      [new PluginCallNotSent(), PluginCallFailure.NotSent],
      [Object.assign(new Error("a host step failed"), { code: "not-bound" }), PluginCallFailure.Other],
      ["thrown words", PluginCallFailure.Other],
      [null, PluginCallFailure.Other],
    ];
    for (const [error, failure] of table) assert.deepEqual(pluginCallFailure(error), { failure }, String(error));
  });
});

describe("the call's record", () => {
  const started = startedPayload({
    pluginId: "roblox",
    pluginName: "Roblox",
    tool: "run-code",
    toolName: "roblox__run-code",
    args: {},
    project: "obby",
    engine: "claude-code",
    role: "chat",
  });

  it("carries the failure and the plugin's code, and an answer carries neither", () => {
    const failed = finishedPayload(
      started,
      { error: new Error("helper not bound"), failure: PluginCallFailure.Plugin, code: "not-bound" },
      0,
      3,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "helper not bound");
    assert.equal(failed.failure, PluginCallFailure.Plugin);
    assert.equal(failed.errorCode, "not-bound");
    const unnamed = finishedPayload(started, { error: new Error("x") }, 0, 3);
    assert.equal(unnamed.failure, PluginCallFailure.Other);
    assert.equal("errorCode" in unnamed, false);
    const answered = finishedPayload(started, { result: { ok: true } }, 0, 3);
    assert.equal("failure" in answered, false);
    assert.equal("errorCode" in answered, false);
  });
});

describe("an agent's call through the host", () => {
  const PROJECT = "failure-codes";
  let lite: CoreLite;
  let threadId: string;

  before(async () => {
    lite = await coreLite();
    await lite.core.plugins.setEnabled("unreal", true);
    await lite.core.games.scaffold(PROJECT);
    threadId = await lite.core.createGameThread(PROJECT);
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.core.mcp.close().catch(() => {});
    await lite.close();
  });

  /** The harness's `plugins.invoke` for an agent, and the record its call left. */
  async function recordOf(name: string, args: Record<string, unknown>): Promise<PluginToolFinishedPayload> {
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const call = api["plugins.invoke"];
    assert.ok(call);
    await call({ project: PROJECT, threadId, name, args }).catch(() => null);
    const events: EventEnvelope[] = await lite.core.store.listEvents(threadId);
    const records = events.flatMap((e) =>
      e.data.type === "custom" && e.data.event_type === CustomEvent.PluginTool ? [e.data.payload] : [],
    );
    const last = records.at(-1) as PluginToolFinishedPayload | undefined;
    assert.ok(last, `${name} left no record`);
    return last;
  }

  it("records the plugin's failure apart from the host's refusal of its arguments", async () => {
    const plugin = await recordOf("unreal__find-nodes", { query: "set intensity" });
    assert.equal(plugin.ok, false);
    assert.equal(plugin.failure, PluginCallFailure.Plugin);
    const refused = await recordOf("unreal__find-nodes", {});
    assert.equal(refused.ok, false);
    assert.equal(refused.failure, PluginCallFailure.InvalidArguments);
  });
});
