/**
 * Quitting stops play-time AI (`app-lifecycle.ts` `shutdownSteps`): its plan watcher hands back any
 * job in flight and the waiting fit counts go, on its own bound, after the harness and before the
 * core, so a hung watcher can neither hold the quit nor outlive the core it reads.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { runShutdown, shutdownSteps } from "../../src/main/app-lifecycle.ts";

const idle = { release() {}, dismiss() {}, cancel() {}, dispose() {} };

it("stops play-time AI after the harness and before the studio core", async () => {
  const order: string[] = [];
  const core = {
    host: { stop: async () => void order.push("harness"), kill: () => void order.push("kill") },
    stop: async () => void order.push("core"),
  };
  const gameAi = { dispose: async () => void order.push("play-time AI") };
  const steps = shutdownSteps({ keepAwake: idle, codexLogin: idle, claudeLogin: idle, terminals: idle, core, gameAi });
  assert.ok(steps.some((step) => step.name === "stop play-time AI"));
  const failed = await runShutdown(steps, { log: () => {} });
  assert.deepEqual(failed, []);
  assert.deepEqual(order, ["harness", "play-time AI", "core", "kill"]);
});

it("quits without play-time AI when the studio never composed it", async () => {
  const steps = shutdownSteps({
    keepAwake: idle,
    codexLogin: idle,
    claudeLogin: idle,
    terminals: idle,
    core: null,
    gameAi: null,
  });
  assert.deepEqual(await runShutdown(steps, { log: () => {} }), []);
});
