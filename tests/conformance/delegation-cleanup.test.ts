/**
 * A delegation's cleanup runs to the end whatever one step of it throws: a plugin lease
 * whose release fails (a pending plugin update that cannot activate) used to skip the rest, so the
 * folder stayed locked and the budget counted the work as running forever.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { coreLite } from "../helpers/core-lite.ts";

it("a plugin lease that fails to release still frees the folder for the next delegation", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const project = "cleanup";
    await core.games.scaffold(project);
    const threadId = await core.createGameThread(project);
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async () => ({ ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} }),
    } as never);
    const lease = core.plugins.lease.bind(core.plugins);
    let failing = true;
    core.plugins.lease = () => {
      const release = lease();
      return async () => {
        await release();
        if (failing) throw new Error("a pending plugin update could not activate");
      };
    };
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const brief = { engine: "fixture-delegate", project, threadId, prompt: "build it" };
    await api[HostMethod.EngineDelegate]!(brief).catch(() => {});
    failing = false;
    const second = (await api[HostMethod.EngineDelegate]!(brief)) as { ok?: boolean };
    assert.equal(second.ok, true, "the folder was freed although the first release threw");
    assert.equal(core.budget.userInFlight, 0, "no work is still counted as running");
  } finally {
    await lite.close();
  }
});
