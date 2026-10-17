/**
 * The harness's own steps leave no plugin call records. A tool only the harness calls
 * (`tools[].audience: "harness"`, such as the Unreal Loop's editor-state poll) is a step of the
 * harness's loop, never an agent's work: a run polls it hundreds of times, and a
 * `plugin_tool_started`/`plugin_tool` pair for each one buried the chat's and the Builds graph's
 * real calls. A tool agents get, called by the local harness on an agent's behalf, keeps its pair.
 */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const PROJECT = "quiet-poll";

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

/** The harness's `plugins.invoke`: as the loop takes its own step (`step`), or for an agent. */
function invoke(name: string, args: Record<string, unknown> = {}, step?: true): Promise<unknown> {
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const call = api["plugins.invoke"];
  assert.ok(call);
  return call({ project: PROJECT, threadId, name, args, ...(step ? { step } : {}) });
}

/** The plugin call records the game's chat holds, by tool name. */
async function recorded(): Promise<string[]> {
  const events: EventEnvelope[] = await lite.core.store.listEvents(threadId);
  const types = new Set<string>([CustomEvent.PluginToolStarted, CustomEvent.PluginTool]);
  return events.flatMap((e) =>
    e.data.type === "custom" && types.has(e.data.event_type)
      ? [`${e.data.event_type}:${String((e.data.payload as { toolName?: unknown }).toolName)}`]
      : [],
  );
}

it("a harness-only step answers as before and leaves no plugin call record", async () => {
  const before = await recorded();
  for (let poll = 0; poll < 3; poll++)
    assert.deepEqual(await invoke("unreal__editor-state", {}, true), {
      answering: false,
      running: null,
      reopening: { state: "idle" },
      helper: null,
    });
  await assert.rejects(
    invoke("unreal__log-errors", {}, true),
    /isn't linked to an Unreal project/,
    "a failed step is thrown",
  );
  assert.deepEqual(await recorded(), before);
});

it("an agent's tool the local harness calls still leaves its pair", async () => {
  const before = await recorded();
  await invoke("unreal__find-nodes", { query: "set intensity" }).catch(() => null);
  assert.deepEqual((await recorded()).slice(before.length), [
    "plugin_tool_started:unreal__find-nodes",
    "plugin_tool:unreal__find-nodes",
  ]);
});
