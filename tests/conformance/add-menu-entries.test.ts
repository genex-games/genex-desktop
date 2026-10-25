/**
 * The composer's Add menu: which plugins and servers it lists, the status each shows only when
 * something needs doing, the action beside that status, and what the @ list offers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { McpConnectorView } from "../../src/shared/mcp.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import {
  addMenuEntries,
  type EntryActions,
  EntryScope,
  mentionOptions,
  visibleConnectors,
} from "../../src/renderer/ui/add-menu-entries.ts";

const server = (id: string, over: Partial<McpConnectorView> = {}, connector: object = {}): McpConnectorView =>
  ({
    connector: { id, name: id, transport: "stdio", enabled: true, scope: "global", toolPolicy: {}, ...connector },
    health: "ready",
    toolCount: 0,
    secrets: [],
    trusted: true,
    secretsAvailable: true,
    ...over,
  }) as McpConnectorView;

const plugin = (id: string, over: Partial<PluginInfo> = {}, manifest: object = {}): PluginInfo =>
  ({
    manifest: { id, name: id, actions: [], ...manifest },
    enabled: true,
    removed: false,
    health: "ready",
    ...over,
  }) as PluginInfo;

function recorder() {
  const calls: string[] = [];
  const actions: EntryActions = {
    manage: (id) => calls.push(`manage:${id ?? ""}`),
    connect: (view) => calls.push(`connect:${view.connector.id}`),
    connectAccount: (p) => calls.push(`account:${p.manifest.id}`),
    enablePlugin: (p, on) => calls.push(`plugin:${p.manifest.id}:${on}`),
    enableServer: (view, on) => calls.push(`server:${view.connector.id}:${on}`),
  };
  return { calls, actions };
}

describe("the Add menu's rows", () => {
  it("lists plugins, then the servers no listed plugin owns", () => {
    const { actions } = recorder();
    const owned = server("blender", {}, { source: { plugin: "genex", server: "blender" } });
    const entries = addMenuEntries([plugin("genex")], [owned, server("github")], null, actions);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["plugin:genex", "mcp:github"],
    );
  });

  it("says a plugin's switch applies to all games, and a server's does not", () => {
    const { actions } = recorder();
    const entries = addMenuEntries([plugin("genex")], [server("github")], null, actions);
    assert.deepEqual(
      entries.map((e) => [e.id, e.scope]),
      [
        ["plugin:genex", EntryScope.AllGames],
        ["mcp:github", undefined],
      ],
    );
  });

  it("shows a server's trouble only when something needs doing, with the fix beside it", () => {
    const { calls, actions } = recorder();
    const views = [
      server("ready"),
      server("off", {}, { enabled: false }),
      server("connecting", { health: "connecting" }),
      server("failed", { health: "failed" }),
      server("idle", { health: "idle" }),
      server("secret", { health: "idle" }, { env: ["TOKEN"] }),
    ];
    const entries = addMenuEntries([], views, null, actions);
    assert.deepEqual(
      entries.map((e) => [e.id, e.status?.text ?? null, e.status?.action?.label ?? null]),
      [
        ["mcp:ready", null, null],
        ["mcp:off", null, null],
        ["mcp:connecting", "Connecting…", null],
        ["mcp:failed", "Failed to connect", "Retry"],
        ["mcp:idle", "Not connected", "Connect"],
        ["mcp:secret", "Needs setup", "Set up"],
      ],
    );
    for (const entry of entries) entry.status?.action?.run();
    assert.deepEqual(calls, ["connect:failed", "connect:idle", "manage:"]);
  });

  it("puts a plugin's account before its own start and its servers", () => {
    const { calls, actions } = recorder();
    const withAccount = plugin("genex", { health: "failed" }, { account: { connect: "login" } });
    const connections = {
      sources: [{ kind: "plugin", id: "genex", account: "locked" }],
    } as unknown as Parameters<typeof addMenuEntries>[2];
    const [locked] = addMenuEntries([withAccount], [], connections, actions);
    // A locked account reads as not connected yet: one Connect button, no "Account locked" words.
    assert.deepEqual([locked?.status?.text, locked?.status?.action?.label], ["", "Connect"]);
    locked?.status?.action?.run();
    assert.deepEqual(calls, ["account:genex"]);
    const at = (account: string | undefined) =>
      addMenuEntries(
        [withAccount],
        [],
        { sources: [{ kind: "plugin", id: "genex", account }] } as unknown as Parameters<typeof addMenuEntries>[2],
        actions,
      )[0]?.status;
    assert.deepEqual([at("failed")?.text, at("failed")?.action?.label], ["", "Reconnect"]);
    assert.deepEqual([at("authorizing")?.text, at("authorizing")?.action], ["Finish in your browser", undefined]);
    assert.equal(at("unlocked")?.text, "Failed to start", "a connected account says nothing; its failed start does");
    assert.equal(at(undefined)?.text, "Failed to start", "an account still being read says nothing either");
    const [failed] = addMenuEntries([plugin("tools", { health: "failed" })], [], null, actions);
    assert.deepEqual([failed?.status?.text, failed?.status?.action?.label], ["Failed to start", "Manage"]);
  });

  it("carries each plugin's and server's own picture", () => {
    const { actions } = recorder();
    const pictured = { ...plugin("genex"), iconUrl: "studio-plugin://genex/.icon?v=1" } as never;
    const drawn = server("linear", {}, {});
    const [row, serverRow] = addMenuEntries(
      [pictured],
      [{ ...drawn, icon: "data:image/png;base64,AA" }],
      null,
      actions,
    );
    assert.equal(row?.icon, "studio-plugin://genex/.icon?v=1");
    assert.equal(serverRow?.icon, "data:image/png;base64,AA");
    assert.equal(addMenuEntries([plugin("tools")], [], null, actions)[0]?.icon, undefined);
  });

  it("names a plugin's own server in its status, and leaves one that connects on use alone", () => {
    const { actions } = recorder();
    const source = { plugin: "genex", server: "blender" };
    const failing = server("genex-blender", { health: "failed" }, { name: "Genex Tools · Blender", source });
    const [row] = addMenuEntries([plugin("genex")], [failing], null, actions);
    assert.deepEqual([row?.status?.text, row?.status?.action?.label], ["Blender failed to connect", "Retry"]);
    const waiting = server("genex-blender", { health: "idle" }, { name: "Genex Tools · Blender", source });
    assert.equal(addMenuEntries([plugin("genex")], [waiting], null, actions)[0]?.status, null);
  });

  it("opens a plugin's page from its row, on or off, and leaves a server's row to its switch", () => {
    const { calls, actions } = recorder();
    const [on, off, serverRow] = addMenuEntries(
      [plugin("genex"), plugin("godot", { enabled: false })],
      [server("github")],
      null,
      actions,
    );
    on?.open?.();
    off?.open?.();
    assert.deepEqual(calls, ["manage:genex", "manage:godot"]);
    assert.equal(serverRow?.open, undefined);
  });

  it("offers Settings beside a plugin's switch unless its action already opens the same page", () => {
    const { calls, actions } = recorder();
    const source = { plugin: "genex", server: "blender" };
    const failing = server("genex-blender", { health: "failed" }, { name: "Genex Tools · Blender", source });
    const settings = (plugins: PluginInfo[], views: McpConnectorView[] = []) =>
      addMenuEntries(plugins, views, null, actions)[0]?.settings;
    settings([plugin("godot")])?.();
    assert.deepEqual(calls, ["manage:godot"]);
    assert.equal(settings([plugin("genex")], [failing]), undefined, "Retry opens its page");
    assert.equal(settings([plugin("godot", { health: "failed" })]), undefined, "Manage opens its page");
    const locked = {
      revision: 1,
      appliedRevision: null,
      active: false,
      sources: [
        { id: "genex", name: "Genex", kind: "plugin", enabled: true, health: "ready", tools: 0, account: "locked" },
      ],
    } as never;
    const account = plugin("genex", {}, { account: { connect: "login" } });
    assert.equal(addMenuEntries([account], [], locked, actions)[0]?.status?.action?.label, "Connect");
    assert.equal(typeof addMenuEntries([account], [], locked, actions)[0]?.settings, "function", "Connect signs in");
  });
});

describe("which servers the menu offers", () => {
  it("keeps to the game's scope and hides a plugin's optional endpoint until it is configured", () => {
    const optional = plugin("genex", {}, { mcpServers: [{ id: "cloud", requires: { settings: ["key"] } }] });
    const views = [
      server("global"),
      server("other-game", {}, { scope: { projects: ["golf"] } }),
      server("cloud", {}, { enabled: false, source: { plugin: "genex", server: "cloud" } }),
    ];
    assert.deepEqual(
      visibleConnectors(views, [optional], "kart").map((v) => v.connector.id),
      ["global"],
    );
  });
});

describe("the @ list", () => {
  it("offers Images for its own words, then the plugins that are on and match", () => {
    const { actions } = recorder();
    const entries = addMenuEntries([plugin("Genex"), plugin("Github", { enabled: false })], [], null, actions);
    const names = (query: string | null) =>
      mentionOptions(
        query,
        entries,
        () => {},
        () => {},
      ).map((option) => option.name);
    assert.deepEqual(names(null), ["Images", "Genex"]);
    assert.deepEqual(names("mood"), ["Images"]);
    assert.deepEqual(names("gen"), ["Genex"]);
    assert.deepEqual(names("git"), []);
  });
});
