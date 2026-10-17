/**
 * "Always allow" on a connector's consent card: the person's answer saves that exact tool as
 * allowed without asking, for their own connector (in connectors.json, where the Connectors card
 * shows it) and for one a plugin owns (beside it, since plugin connectors live in memory). The
 * grant survives a restart, can be taken back, and only ever names a tool the connector exposes.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { McpConnector } from "../../src/shared/mcp.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { coreLite } from "../helpers/core-lite.ts";

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");
const EDITOR = { id: "editor", name: "Unreal Editor · editor", command: "ignored", args: [] };
const LAUNCH = { execPath: process.execPath, extraArgs: [SERVER] };
const TOOL = "unreal-editor__echo";

const echo = (): McpConnector =>
  ({
    id: "echo",
    name: "Echo",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    enabled: true,
    scope: "global",
    toolPolicy: {},
    createdAt: new Date().toISOString(),
  }) as McpConnector;

async function pluginRegistry(file: string): Promise<McpRegistry> {
  const registry = new McpRegistry({ file });
  await registry.init();
  await registry.registerPluginServer("unreal", EDITOR, LAUNCH);
  return registry;
}

it("a plugin connector's always-allowed tool skips the card, survives a restart and can be taken back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-always-"));
  const file = path.join(root, "connectors.json");
  const first = await pluginRegistry(file);
  try {
    assert.equal(await first.toolAutoApproved(TOOL, null), false, "asks until the person says always");
    await first.alwaysAllow(TOOL, null);
    assert.equal(await first.toolAutoApproved(TOOL, null), true);
    assert.deepEqual(first.alwaysAllowed("unreal-editor"), ["echo"]);
  } finally {
    await first.close();
  }
  const reopened = await pluginRegistry(file);
  try {
    assert.equal(await reopened.toolAutoApproved(TOOL, null), true, "kept across a restart");
    await reopened.forgetAlwaysAllowed("unreal-editor");
    assert.equal(await reopened.toolAutoApproved(TOOL, null), false, "taken back");
    assert.deepEqual(reopened.alwaysAllowed("unreal-editor"), []);
  } finally {
    await reopened.close();
  }
  const files = await readdir(root);
  assert.ok(!files.includes("connectors.json"), "a plugin's grant never writes the user's connectors file");
});

it("always allow refuses a tool the connector doesn't expose, and writes nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-always-bad-"));
  const registry = await pluginRegistry(path.join(root, "connectors.json"));
  try {
    for (const name of ["unreal-editor__nosuch", "nosuch__echo", "unreal-editor", "../x__echo", ""]) {
      await assert.rejects(registry.alwaysAllow(name, null), Error, name);
    }
    assert.deepEqual(registry.alwaysAllowed("unreal-editor"), []);
    assert.deepEqual(await readdir(root), [], "nothing written");
  } finally {
    await registry.close();
  }
});

it("answering a connector's card with Always allow runs the call and asks nothing next time", async () => {
  const lite = await coreLite();
  try {
    const project = "always";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.mcp.save(echo(), {}, { trust: true });
    await lite.core.mcp.toolsFor(project);
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const cards = async () =>
      (await lite.core.listAllEvents()).flatMap((event) =>
        event.data.type === "custom" && event.data.event_type === "plugin_consent"
          ? [event.data.payload as { consentId: string; state: string; alwaysOffered?: boolean; always?: boolean }]
          : [],
      );
    const first = api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "one" } });
    let asked: Awaited<ReturnType<typeof cards>>[number] | undefined;
    for (let i = 0; i < 100 && !asked; i++) {
      asked = (await cards()).find((card) => card.state === "pending");
      if (!asked) await setTimeout(20);
    }
    assert.ok(asked, "the first call asks");
    assert.equal(asked.alwaysOffered, true, "a connector's card offers Always allow");
    assert.equal(lite.core.resolveConsent(asked.consentId, true, true), true);
    assert.equal(await first, "one");
    assert.ok((await cards()).some((card) => card.state === "approved" && card.always === true));
    assert.equal(await api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "two" } }), "two");
    assert.equal((await cards()).filter((card) => card.state === "pending").length, 1, "no second card");
    const saved = JSON.parse(await readFile(lite.core.mcp.store.file, "utf8")) as { connectors: McpConnector[] };
    assert.deepEqual(saved.connectors[0]?.toolPolicy.autoApprove, ["echo"], "shown in the Connectors card");
  } finally {
    await lite.core.mcp.close();
    await lite.close();
  }
});
