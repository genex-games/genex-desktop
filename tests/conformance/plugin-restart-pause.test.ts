/**
 * A plugin's backend that keeps ending is not forked again on every call. On Windows shutting
 * down, Genex's backend died at once after each start and each call started a new one: 85
 * `plugin_failed` in 3 s. The first end still restarts on the next call; after that the backend
 * waits a pause that doubles with each end, and calls meanwhile are refused without a start.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { type PluginChange, PluginChangeReason } from "../../src/shared/plugins.ts";
import { PluginCallNotSent, PluginRestartPaused } from "../../src/substrate/plugins/process.ts";
import { createRestartPause } from "../../src/substrate/plugins/restart-pause.ts";
import { copyOfExample, pluginFixture } from "../helpers/plugins.ts";

describe("the pause before a plugin's backend starts again", () => {
  const cases: { name: string; endsAt: number[]; askedAt: number; remaining: number }[] = [
    { name: "never ended: starts now", endsAt: [], askedAt: 0, remaining: 0 },
    { name: "one end: starts again at once", endsAt: [0], askedAt: 0, remaining: 0 },
    { name: "a second end soon after: waits 1 s", endsAt: [0, 100], askedAt: 100, remaining: SECOND_MS },
    { name: "part of the pause has passed", endsAt: [0, 100], askedAt: 600, remaining: 500 },
    { name: "a third end: waits 2 s", endsAt: [0, 100, 1_200], askedAt: 1_200, remaining: 2 * SECOND_MS },
    {
      name: "a long streak waits at most 30 s",
      endsAt: Array.from({ length: 12 }, (_, i) => i * 100),
      askedAt: 1_100,
      remaining: 30 * SECOND_MS,
    },
    { name: "a minute's quiet starts the count again", endsAt: [0, 100, 70_000], askedAt: 70_000, remaining: 0 },
  ];
  for (const c of cases)
    it(c.name, () => {
      let now = 0;
      const pause = createRestartPause(() => now);
      for (const at of c.endsAt) {
        now = at;
        pause.ended("genex");
      }
      now = c.askedAt;
      assert.equal(pause.remaining("genex"), c.remaining);
      assert.equal(pause.remaining("godot"), 0, "another plugin's ends are its own");
    });

  it("is forgotten when the person turns the plugin on again", () => {
    const pause = createRestartPause(() => 0);
    pause.ended("genex");
    pause.ended("genex");
    pause.forget("genex");
    assert.equal(pause.remaining("genex"), 0);
  });
});

/** A plugin whose backend exits on its first tool call, installed and turned on in a fixture. */
async function crashingPlugin() {
  const f = await pluginFixture({ installed: "local" });
  const dir = await copyOfExample(f.root, "crash");
  await writeFile(path.join(dir, "backend.mjs"), "export async function activate(){return {tool(){process.exit(9)}}}");
  await f.registry.installLocal(dir);
  let now = 0;
  f.registry.restarts = createRestartPause(() => now);
  const failures: PluginChange[] = [];
  f.registry.onChange = (change) => {
    if (change.reason === PluginChangeReason.Failed) failures.push(change);
  };
  const call = () => f.registry.tool("example__greet", { name: "Ada" }, f.binding);
  return { f, failures, call, advance: (ms: number) => (now += ms) };
}

describe("a registry whose plugin's backend keeps ending", () => {
  it("refuses calls during the pause without starting a backend, and starts one after it", async () => {
    const { f, failures, call, advance } = await crashingPlugin();
    try {
      await assert.rejects(call(), /exited/);
      await assert.rejects(call(), /exited/, "the first end restarts at once");
      assert.equal(failures.length, 2);
      for (let i = 0; i < 5; i++) await assert.rejects(call(), PluginRestartPaused);
      assert.equal(failures.length, 2, "no backend started during the pause, so none ended");
      advance(SECOND_MS);
      await assert.rejects(call(), /exited/, "after the pause the next call starts it again");
      await assert.rejects(call(), PluginRestartPaused, "and the next pause is longer");
      assert.equal(failures.length, 3);
    } finally {
      await f.close();
    }
  });

  it("starts at once again when the person turns the plugin off and on", async () => {
    const { f, failures, call } = await crashingPlugin();
    try {
      await assert.rejects(call(), /exited/);
      await assert.rejects(call(), /exited/);
      await assert.rejects(call(), PluginRestartPaused);
      await f.registry.setEnabled("example", false);
      await f.registry.setEnabled("example", true);
      await assert.rejects(call(), /exited/);
      assert.equal(failures.length, 3);
    } finally {
      await f.close();
    }
  });

  it("starts no backend once the computer's session ends", async () => {
    const { f, failures, call } = await crashingPlugin();
    try {
      f.registry.holdStarts();
      await assert.rejects(call(), PluginCallNotSent);
      assert.equal(failures.length, 0);
    } finally {
      await f.close();
    }
  });
});
