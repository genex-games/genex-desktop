/**
 * Plan mode is for planning (B2): while a game chat is in Plan, no plugin or connector action runs
 * on its behalf, whoever asks (the chat's session, a build's lead, a worker) and whatever was saved
 * as "always allow", and no run's coordinator or run control starts, goes on with or lands a build.
 * A plugin's skill is still readable. Leaving Plan lifts it.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { McpConnector } from "../../src/shared/mcp.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { coreLite } from "../helpers/core-lite.ts";

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");

const echo = (): McpConnector =>
  ({
    id: "echo",
    name: "Echo",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    enabled: true,
    scope: "global",
    toolPolicy: { autoApprove: ["echo"] },
    createdAt: new Date().toISOString(),
  }) as McpConnector;

/** The log's custom records of one type, as payloads. */
async function records(lite: Awaited<ReturnType<typeof coreLite>>, type: string) {
  return (await lite.core.listAllEvents()).flatMap((event) =>
    event.data.type === "custom" && event.data.event_type === type ? [event.data.payload] : [],
  );
}

it("in Plan mode a connector action is refused without a card, even one saved as always allowed", async () => {
  const lite = await coreLite();
  try {
    const project = "planning";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.mcp.save(echo(), {}, { trust: true });
    await lite.core.mcp.toolsFor(project);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "while planning" } }),
      /Plan mode/,
    );
    assert.equal((await records(lite, "plugin_consent")).length, 0, "no card: Plan answers it");
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    assert.equal(
      await api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "after the plan" } }),
      "after the plan",
      "leaving Plan lifts it, and the saved grant applies again",
    );
  } finally {
    // A core-lite never started, so its stop leaves connectors to the test.
    await lite.core.mcp.close();
    await lite.close();
  }
});

it("in Bypass a connector action runs without a card; in any other mode it still asks", async () => {
  const lite = await coreLite();
  try {
    const project = "bypassing";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.mcp.save({ ...echo(), toolPolicy: {} }, {}, { trust: true });
    await lite.core.mcp.toolsFor(project);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    /** The first consent card the log holds, polled for up to two seconds. */
    const firstCard = async () => {
      for (let i = 0; i < 100; i++) {
        const [card] = (await records(lite, "plugin_consent")) as Array<{ consentId?: unknown }>;
        if (card) return card;
        await setTimeout(20);
      }
      return undefined;
    };
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    const bypassed = api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "no questions" } });
    const unexpected = await Promise.race([bypassed.then(() => undefined), firstCard()]);
    if (unexpected) lite.core.resolveConsent(String(unexpected.consentId), true);
    assert.equal(unexpected, undefined, "Bypass asks nothing");
    assert.equal(await bypassed, "no questions");
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    const call = api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "asked" } });
    const asked = await firstCard();
    assert.ok(asked, "Auto still asks before a connector action nobody always-allowed");
    lite.core.resolveConsent(String(asked.consentId), true);
    assert.equal(await call, "asked");
  } finally {
    await lite.core.mcp.close();
    await lite.close();
  }
});

it("in Plan mode a plugin action answers the agent that it waits for the plan, and nothing runs", async () => {
  const lite = await coreLite();
  try {
    const project = "planning";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const answer = (await api["plugins.invoke"]!({
      project,
      threadId,
      name: "genex__asset",
      args: { operation: "image", prompt: "a paid picture" },
    })) as { blocker?: string; message?: string };
    assert.equal(answer.blocker, "plan_mode");
    assert.match(String(answer.message), /Plan mode/);
    assert.equal((await records(lite, "plugin_tool_started")).length, 0, "the tool never started");
    assert.equal((await records(lite, "plugin_consent")).length, 0);
  } finally {
    await lite.close();
  }
});

it("in Plan mode a run's coordinator and the chat's run controls cannot land, continue or resume a build", async () => {
  const lite = await coreLite();
  try {
    const project = "planning-run";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.append(
      [
        { type: "custom", event_type: "run_registered", payload: { runId: "run_a", project, mode: "director" } },
        { type: "custom", event_type: "run_finished", payload: { runId: "run_a", project, landed: false } },
      ],
      threadId,
    );
    let dispatched = 0;
    lite.core.host.dispatch = async () => {
      dispatched++;
    };
    const tool = (name: string) =>
      lite.api()["coordinator.tool"]!({ threadId, runId: "run_a", name, args: { text: "Add a boss" } }).then(
        String,
        (error: unknown) => `refused: ${String(error)}`,
      );
    const before = (await lite.core.listAllEvents()).length;
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    for (const name of ["land_build", "continue_build", "resume_run"]) {
      const answer = await tool(name);
      assert.match(answer, /Plan mode, so this did not run/, `${name}: ${answer}`);
    }
    assert.equal(dispatched, 0, "nothing was sent to the harness");
    const runEvents = (await lite.core.listAllEvents())
      .slice(before)
      .filter((event) => event.data.type === "custom" && /^run_|steer/.test(String(event.data.event_type)));
    assert.deepEqual(runEvents, [], "no run record was written");
    assert.match(await tool("run_status"), /run_a/, "reading the run still works");
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    assert.doesNotMatch(await tool("land_build"), /Plan mode/, "leaving Plan lifts it");
  } finally {
    await lite.close();
  }
});
