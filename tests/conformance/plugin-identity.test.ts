/**
 * A plugin id is a name, not an identity. A package from another publisher or another source that
 * declares an id already in use must not inherit that plugin's saved account, unlocked session or
 * data, and must never take the id of a plugin that ships with Studio (review PLG-1, GPX-3, MCP-3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { accountFixture, accountPackage, copyOfExample, installLocalOn, pluginFixture } from "../helpers/plugins.ts";
import type { PluginManifest, PluginSource } from "../../src/shared/plugins.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { memorySecretPort } from "../../src/substrate/mcp/store.ts";

const GITHUB: PluginSource = { kind: "github", repo: "someone/acct", sha: "b".repeat(40) };

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

test("a same-id package from another publisher does not inherit the saved account, the unlocked session or the data", async () => {
  const f = await accountFixture();
  try {
    const a = await accountPackage(f.base, "a", "Publisher A"),
      b = await accountPackage(f.base, "b", "Publisher B");
    await installLocalOn(f.registry, a.dir, a.manifest.capabilities);
    await f.registry.action("acct", "unlock", {});
    assert.equal(await f.registry.accountState("acct"), "unlocked");
    assert.deepEqual(await f.registry.tool("acct__greet", { name: "Ada" }, f.binding), { session: "TOKEN-OF-A" });
    await f.registry.setSetting("acct", "greeting", "A only");
    await mkdir(path.dirname(f.storageMarker), { recursive: true });
    await writeFile(f.storageMarker, "a");

    // Without the explicit "replace and erase data" answer the install is refused, and A is untouched.
    await assert.rejects(f.registry.installLocal(b.dir, "github", b.manifest.capabilities, GITHUB), /replace/i);
    const current = () => f.registry.list().find((p) => p.manifest.id === "acct")!;
    assert.equal(current().manifest.publisher, "Publisher A");
    assert.deepEqual(await f.registry.tool("acct__greet", { name: "Ada" }, f.binding), { session: "TOKEN-OF-A" });

    f.registry.authorizeReplacement(b.manifest, GITHUB);
    await f.registry.installLocal(b.dir, "github", b.manifest.capabilities, GITHUB);
    assert.equal(current().manifest.publisher, "Publisher B");
    assert.deepEqual(
      await f.registry.tool("acct__greet", { name: "Ada" }, f.binding),
      { session: null },
      "B never sees A's token",
    );
    assert.equal(await f.registry.accountState("acct"), "locked");
    assert.equal((await f.registry.settings("acct")).greeting, "Hello", "A's settings were erased");
    assert.equal(f.tokens.has("acct"), false, "A's saved credential was erased");
    assert.equal(await exists(f.storageMarker), false, "A's storage was erased");

    const next = await f.relaunch();
    assert.deepEqual(
      await next.tool("acct__greet", { name: "Ada" }, f.binding),
      { session: null },
      "and nothing comes back after a relaunch",
    );
    assert.equal(await next.accountState("acct"), "locked");
  } finally {
    await f.close();
  }
});

test("a removed plugin reinstalled by another publisher does not inherit its account; the same package still does", async () => {
  const f = await accountFixture();
  try {
    const a = await accountPackage(f.base, "a", "Publisher A"),
      b = await accountPackage(f.base, "b", "Publisher B");
    await installLocalOn(f.registry, a.dir, a.manifest.capabilities);
    await f.registry.action("acct", "unlock", {});
    await f.registry.remove("acct");
    await assert.rejects(f.registry.installLocal(b.dir, "github", b.manifest.capabilities, GITHUB), /replace/i);
    // Control: the package the account belongs to comes back with it, as removal promised.
    await installLocalOn(f.registry, a.dir, a.manifest.capabilities);
    assert.equal(await f.registry.accountState("acct"), "unlocked");
    assert.deepEqual(await f.registry.tool("acct__greet", { name: "Ada" }, f.binding), { session: "TOKEN-OF-A" });
    await f.registry.remove("acct");

    f.registry.authorizeReplacement(b.manifest, GITHUB);
    await f.registry.installLocal(b.dir, "github", b.manifest.capabilities, GITHUB);
    assert.deepEqual(await f.registry.tool("acct__greet", { name: "Ada" }, f.binding), { session: null });
    assert.equal(await f.registry.accountState("acct"), "locked");
    assert.equal(f.tokens.has("acct"), false);
    const next = await f.relaunch();
    assert.deepEqual(await next.tool("acct__greet", { name: "Ada" }, f.binding), { session: null });
    // An authorization is spent by the install it was given for.
    await next.remove("acct");
    await assert.rejects(next.installLocal(a.dir, "local", a.manifest.capabilities), /replace/i);
  } finally {
    await f.close();
  }
});

/**
 * M5: a plugin's MCP server is the connector `<plugin>-<server>`, and its secrets are stored under
 * that name. A same-id package from another publisher that declares the same server would be
 * started with them: the replacement erases them with the rest of the plugin's data.
 */
test("a same-id package from another publisher does not inherit the MCP secrets of the plugin it replaced", async () => {
  const f = await accountFixture();
  const values = new Map<string, string>();
  const mcp = new McpRegistry({ file: path.join(f.base, "connectors.json"), secrets: memorySecretPort(values) });
  try {
    await mcp.init();
    // Wired as studio-core wires it: servers published with the plugin, withdrawn with it, erased on replacement.
    f.registry.mcpHost = {
      register: async (id, servers) => {
        await mcp.unregisterPlugin(id);
        for (const server of servers)
          await mcp.registerPluginServer(id, {
            id: server.id,
            name: server.id,
            command: process.execPath,
            args: [],
            env: Object.keys(server.env ?? {}),
          });
      },
      unregister: (id) => mcp.unregisterPlugin(id),
      erase: (id, servers) => mcp.erasePluginSecrets(id, servers),
    };
    const withServer = (m: any) => {
      m.mcpServers = [
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
          cwd: "storage",
          env: { API_KEY: "secret:API_KEY" },
          description: "A server with a key.",
        },
      ];
    };
    const a = await accountPackage(f.base, "a", "Publisher A", withServer),
      b = await accountPackage(f.base, "b", "Publisher B", withServer);
    await installLocalOn(f.registry, a.dir, a.manifest.capabilities);
    assert.ok(
      (await mcp.list()).some((c) => c.connector.id === "acct-srv"),
      "A published its server",
    );
    // What saving the key on A's server card leaves in the secret store, and an OAuth token beside it.
    values.set("mcp.acct-srv.env.API_KEY", "KEY-OF-A");
    values.set("mcp.acct-srv.oauth.tokens", "OAUTH-OF-A");
    // Someone else's connector whose name merely starts the same way keeps its secret.
    values.set("mcp.acct-srvx.env.API_KEY", "NOT-A");

    f.registry.authorizeReplacement(b.manifest, GITHUB);
    await f.registry.installLocal(b.dir, "github", b.manifest.capabilities, GITHUB);
    assert.ok(
      (await mcp.list()).some((c) => c.connector.id === "acct-srv"),
      "B published the same server",
    );
    assert.deepEqual(
      [...values.keys()].filter((k) => k.startsWith("mcp.acct-srv.")),
      [],
      "no secret of A's server remains",
    );
    assert.equal(values.get("mcp.acct-srvx.env.API_KEY"), "NOT-A");
  } finally {
    await mcp.close();
    await f.close();
  }
});

test("a bundled id is refused from GitHub, the index or a local folder, and no answer unlocks it", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "impostor", (m) => {
      m.publisher = "Someone else";
    });
    const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8")) as PluginManifest;
    const sources: Array<[PluginSource["kind"], PluginSource]> = [
      ["github", GITHUB],
      ["index", { ...GITHUB, kind: "index" }],
      ["local", { kind: "local", directory: dir }],
    ];
    for (const [kind, origin] of sources) {
      f.registry.authorizeReplacement(manifest, origin);
      await assert.rejects(
        f.registry.installLocal(dir, kind, manifest.capabilities, origin),
        /ships with Studio/,
        kind,
      );
    }
    const bundled = f.registry.list().find((p) => p.manifest.id === "example")!;
    assert.equal(bundled.source, "bundled");
    assert.equal(bundled.manifest.publisher, "Studio development");
    // The seed is still Studio's, and still answers.
    assert.deepEqual(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), {
      text: "Hello Ada",
      project: "game",
    });
    // Removing the bundled plugin does not free its id for anyone else; restoring it brings Studio's back.
    await f.registry.remove("example");
    await assert.rejects(f.registry.installLocal(dir, "github", manifest.capabilities, GITHUB), /ships with Studio/);
    assert.equal((await f.registry.restore("example")).publisher, "Studio development");
  } finally {
    await f.close();
  }
});

/**
 * The official source moved from Rabneba/ai-game-studio to genex-games/genex-desktop. An official
 * plugin installed from either one is the same identity: its next release from the other keeps the
 * saved account and data, while an unlisted repository is still another identity.
 */
test("an official plugin keeps its identity across the move of its source repository", async () => {
  const f = await pluginFixture();
  try {
    const release = (version: string) =>
      copyOfExample(f.root, `blender-${version}`, (m) => {
        m.id = "blender";
        m.name = "Blender";
        m.publisher = "Studio";
        m.version = version;
      });
    const legacy: PluginSource = { kind: "index", repo: "Rabneba/ai-game-studio", sha: "c".repeat(40) };
    const moved: PluginSource = { kind: "index", repo: "genex-games/genex-desktop", sha: "d".repeat(40) };
    const first = await release("1.0.0");
    const manifest = JSON.parse(await readFile(path.join(first, "plugin.json"), "utf8")) as PluginManifest;
    await f.registry.installLocal(first, "index", manifest.capabilities, legacy);
    assert.equal(f.registry.replacement(manifest, moved), undefined, "the new repository is the same source");
    assert.ok(f.registry.replacement(manifest, { ...moved, repo: "someone/fork" }), "a fork is not");
    await f.registry.installLocal(await release("1.1.0"), "index", manifest.capabilities, moved);
    const current = f.registry.list().find((p) => p.manifest.id === "blender");
    assert.equal(current?.manifest.version, "1.1.0", "updated in place, without a replace-and-erase answer");
  } finally {
    await f.close();
  }
});
