/**
 * How a plugin starts once it is installed. A plugin loaded from a folder on this Mac starts off:
 * only the person turns it on. An update or a watch reload keeps the person's choice; every other
 * source (a bundled seed, GitHub) starts on as before.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { installUpdateFacts } from "../../src/main/plugin-install-words.ts";
import { installLocalPlugin, reviewPluginInstall } from "../../src/main/plugin-local-install.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { PluginRegistry, startsEnabled } from "../../src/substrate/plugins/registry.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND, pluginFixture } from "../helpers/plugins.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

/** How long a watched reload is given to land. */
const RELOAD_PATIENCE_MS = 10_000;
const ID = "example";

/** An empty registry (no seeds) under a fresh folder. */
async function emptyRegistry(): Promise<{ root: string; registry: PluginRegistry }> {
  const root = await tmpDir("studio-local-start-");
  await mkdir(path.join(root, "seeds"));
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    path.join(root, "seeds"),
    PLUGIN_SDK_BACKEND,
    async () => null,
  );
  closeBeforeCleanup(async () => registry.cancel());
  await registry.init();
  return { root, registry };
}

/** Bumps the version written in a plugin folder's manifest. */
async function bump(dir: string, version: string): Promise<void> {
  const file = path.join(dir, "plugin.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.version = version;
  await writeFile(file, JSON.stringify(manifest));
}

/** Waits until `ready` holds, within the reload's patience. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + RELOAD_PATIENCE_MS;
  while (!ready() && Date.now() < deadline) await sleep(20);
  assert.ok(ready(), "it happened in time");
}

describe("a plugin's first state", () => {
  it("a plugin loaded from a folder starts off, and every other source starts on as before", async () => {
    const { root, registry } = await emptyRegistry();
    await registry.installLocal(await copyOfExample(root, "picked"), PluginSourceKind.Local);
    assert.equal(registry.enabled(ID), false, "loaded with registry.installLocal: off");

    const other = await emptyRegistry();
    await installLocalPlugin(other.registry, await copyOfExample(other.root, "picked"), async () => true);
    assert.equal(other.registry.enabled(ID), false, "loaded through the trust dialog: off");

    const bundled = await pluginFixture();
    try {
      assert.equal(bundled.registry.enabled(ID), true, "a bundled seed starts on");
    } finally {
      await bundled.close();
    }

    const github = await emptyRegistry();
    await github.registry.installLocal(await copyOfExample(github.root, "fetched"), PluginSourceKind.Github, [], {
      kind: PluginSourceKind.Github,
      repo: "someone/example",
      sha: "a".repeat(40),
    });
    assert.equal(github.registry.enabled(ID), true, "a GitHub install starts on");
  });

  it("an update and a watch reload keep the person's choice; a re-load after removal starts off again", async () => {
    const { root, registry } = await emptyRegistry();
    const source = await copyOfExample(root, "author");
    await registry.installLocal(source, PluginSourceKind.Local);
    await registry.setEnabled(ID, true);
    await bump(source, "1.1.0");
    await registry.installLocal(source, PluginSourceKind.Local);
    assert.equal(registry.enabled(ID), true, "an update of a plugin the person turned on stays on");

    const edits: Array<() => void> = [];
    registry.watchFolder = (_directory, onChange) => {
      edits.push(onChange);
      return { close() {} };
    };
    await registry.watch(ID, true);
    await bump(source, "1.2.0");
    for (const edit of edits) edit();
    await until(() => registry.list().find((p) => p.manifest.id === ID)?.manifest.version === "1.2.0");
    assert.equal(registry.enabled(ID), true, "a watch reload keeps it on");
    await registry.watch(ID, false);

    await registry.setEnabled(ID, false);
    await bump(source, "1.3.0");
    await registry.installLocal(source, PluginSourceKind.Local);
    assert.equal(registry.enabled(ID), false, "an update of a plugin the person turned off stays off");

    await registry.setEnabled(ID, true);
    await registry.remove(ID);
    await registry.restore(ID);
    assert.equal(registry.enabled(ID), false, "loaded again after removal, it starts off");
  });

  it("a watched edit that adds a step at Genex's moments runs no code and adds no step", async () => {
    const { root, registry } = await emptyRegistry();
    const source = await copyOfExample(root, "author");
    const marker = path.join(root, "backend-ran");
    await registry.installLocal(source, PluginSourceKind.Local);
    await registry.setEnabled(ID, true);
    const edits: Array<() => void> = [];
    registry.watchFolder = (_directory, onChange) => {
      edits.push(onChange);
      return { close() {} };
    };
    await registry.watch(ID, true);
    const before = registry.list().find((p) => p.manifest.id === ID)?.manifest;
    // An agent's edit: a harness tool at the health moment, and new code that leaves a mark when it runs.
    const file = path.join(source, "plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.version = "1.1.0";
    manifest.apiVersion = 3;
    manifest.tools.push({
      name: "tidy",
      audience: "harness",
      description: "Tidy up.",
      parameters: { type: "object", properties: {} },
    });
    manifest.hooks = [{ on: "health", tool: "tidy" }];
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(
      path.join(source, "backend.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "ran\\n");\nexport async function activate() { return { async tool() { return {}; } }; }\n`,
    );
    for (const edit of edits) edit();
    await until(() => registry.list().find((p) => p.manifest.id === ID)?.error !== undefined);
    const after = registry.list().find((p) => p.manifest.id === ID);
    assert.deepEqual(after?.manifest, before, "the reload was refused: no new step");
    assert.match(String(after?.error), /Load local plugin/, "the person is told how to review it");
    assert.equal(await readFile(marker, "utf8").catch(() => ""), "", "and the edited code never ran");
    await registry.watch(ID, false);
  });

  it("Watch folder is refused for a folder agents write in", async () => {
    const { root, registry } = await emptyRegistry();
    const source = await copyOfExample(root, "author");
    await registry.installLocal(source, PluginSourceKind.Local);
    await registry.setEnabled(ID, true);
    registry.watchFolder = () => ({ close() {} });
    registry.agentWritable = async (directory) => directory.startsWith(root);
    await assert.rejects(registry.watch(ID, true), /agents write/);
    registry.agentWritable = async () => false;
    await registry.watch(ID, true);
    await registry.watch(ID, false);
  });

  it("the trust dialog says it stays on exactly when the registry then keeps it on", async () => {
    type Row = { label: string; setUp: (registry: PluginRegistry, source: string, root: string) => Promise<unknown> };
    const loaded = (r: PluginRegistry, source: string) => r.installLocal(source, PluginSourceKind.Local);
    const rows: Row[] = [
      {
        label: "an update of a plugin that is on",
        setUp: async (r, source) => {
          await loaded(r, source);
          await r.setEnabled(ID, true);
        },
      },
      { label: "an update of a plugin that is off", setUp: loaded },
      {
        label: "a re-load after removal",
        setUp: async (r, source) => {
          await loaded(r, source);
          await r.setEnabled(ID, true);
          await r.remove(ID);
        },
      },
      {
        label: "a replacement of a GitHub plugin that is on",
        setUp: async (r, _source, root) => {
          const github = { kind: PluginSourceKind.Github, repo: "someone/example", sha: "a".repeat(40) } as const;
          await r.installLocal(await copyOfExample(root, "fetched"), PluginSourceKind.Github, [], github);
        },
      },
    ];
    for (const row of rows) {
      const { root, registry } = await emptyRegistry();
      const source = await copyOfExample(root, "author");
      await row.setUp(registry, source, root);
      await bump(source, "1.1.0");
      let said: boolean | undefined;
      await installLocalPlugin(registry, source, async (manifest, origin, _scan, previous) => {
        const { replaces } = reviewPluginInstall(registry, manifest, origin, []);
        said = installUpdateFacts(registry.list(), manifest, origin, previous, Boolean(replaces)).staysOn;
        if (replaces) registry.authorizeReplacement(manifest, origin);
        return true;
      });
      assert.equal(said, registry.enabled(ID), row.label);
      assert.equal(
        registry.list().find((p) => p.manifest.id === ID)?.manifest.version,
        "1.1.0",
        `${row.label}: loaded`,
      );
    }
  });

  it("a replacement from a folder starts off; a replacement from anywhere else starts on", () => {
    const on = { enabled: true, removed: false };
    const off = { enabled: false, removed: false };
    const rows: Array<[string, PluginSourceKind, typeof on | undefined, boolean, boolean]> = [
      ["a local folder replacing a GitHub plugin that is on", PluginSourceKind.Local, on, true, false],
      ["a GitHub package replacing a local plugin that is off", PluginSourceKind.Github, off, true, true],
      ["a local update of a plugin that is on", PluginSourceKind.Local, on, false, true],
      ["a local update of a plugin that is off", PluginSourceKind.Local, off, false, false],
      ["a local re-load after removal", PluginSourceKind.Local, { enabled: false, removed: true }, false, false],
      ["a first local load", PluginSourceKind.Local, undefined, false, false],
      ["a first GitHub install", PluginSourceKind.Github, undefined, false, true],
    ];
    for (const [label, source, previous, replacing, expected] of rows)
      assert.equal(startsEnabled(source, previous, replacing), expected, label);
  });

  it("a plugin that starts off runs none of its code until the person turns it on", async () => {
    const { root, registry } = await emptyRegistry();
    const source = await copyOfExample(root, "marked");
    const marker = path.join(root, "backend-ran");
    await writeFile(
      path.join(source, "backend.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "ran\\n");\nexport async function activate() { return { async tool() { return {}; } }; }\n`,
    );
    const ran = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    await registry.installLocal(source, PluginSourceKind.Local);
    assert.equal(registry.enabled(ID), false);
    assert.equal(await ran(), 0, "loading it ran none of its code");
    await bump(source, "1.1.0");
    await registry.installLocal(source, PluginSourceKind.Local);
    assert.equal(await ran(), 0, "nor did loading it again while off");
    await registry.setEnabled(ID, true);
    assert.ok((await ran()) > 0, "turning it on starts its backend");
  });

  it("a plugin that won't start can't be turned on, and stays off", async () => {
    const { root, registry } = await emptyRegistry();
    const source = await copyOfExample(root, "broken");
    await writeFile(path.join(source, "backend.mjs"), "throw new Error('broken backend');\n");
    await registry.installLocal(source, PluginSourceKind.Local);
    await assert.rejects(registry.setEnabled(ID, true));
    assert.equal(registry.enabled(ID), false);
  });

  it("dropped code the person allows starts off", async () => {
    const root = await tmpDir("studio-local-dropped-");
    await mkdir(path.join(root, "seeds"));
    const dropped = path.join(root, "installed", "packages", ID, "dropped");
    await mkdir(path.dirname(dropped), { recursive: true });
    await cp(EXAMPLE_PLUGIN, dropped, { recursive: true });
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      path.join(root, "seeds"),
      PLUGIN_SDK_BACKEND,
      async () => null,
    );
    closeBeforeCleanup(async () => registry.cancel());
    await registry.init();
    assert.equal(registry.list().find((p) => p.manifest.id === ID)?.unlisted, true, "listed, never activated");
    await registry.allowUnlisted(ID);
    assert.equal(registry.enabled(ID), false, "allowed by the person, it is installed off");
  });
});
