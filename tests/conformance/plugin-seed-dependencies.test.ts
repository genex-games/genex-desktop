// A bundled plugin's dependencies stay in the app: a first launch copies a seed without its
// node_modules, and the plugin's backend and its host-cli servers find them in the seed.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { PLUGIN_SEED_ENV, pluginBackendEnv } from "../../src/substrate/plugins/process.ts";
import { genexCliPath } from "../../src/main/core/plugin-tools.ts";
import { genexCliPath as backendCliPath } from "../../src/plugins/genex/cli.ts";
import { EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** A seeds folder holding the example plugin with a node_modules of its own, and a registry over it. */
async function seededRegistry(): Promise<{ root: string; seed: string; registry: PluginRegistry }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-seed-deps-"));
  const seed = path.join(root, "seeds", "example");
  await cp(EXAMPLE_PLUGIN, seed, { recursive: true });
  // The backend answers its `count` action with the seed folder it was told about.
  await writeFile(
    path.join(seed, "backend.mjs"),
    `export async function activate() { return { async tool() { return {}; }, async action() { return { text: process.env.${PLUGIN_SEED_ENV} ?? "none" }; } }; }\n`,
  );
  await mkdir(path.join(seed, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(seed, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}\n');
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    path.join(root, "seeds"),
    PLUGIN_SDK_BACKEND,
    async () => null,
  );
  await registry.init();
  return { root, seed, registry };
}

test("a first launch copies a bundled seed without its node_modules, and its backend is told where the seed is", async () => {
  // Windows 11 held each first write of the Genex seed's 2,394 dependency files (the pinned CLI) for
  // longer than the whole start budget (release canary 39440536691).
  const { root, seed, registry } = await seededRegistry();
  try {
    await registry.setEnabled("example", true);
    const copies = path.join(root, "installed", "packages", "example");
    const [copy] = await readdir(copies);
    assert.ok(copy);
    const directory = path.join(copies, copy);
    assert.ok(await exists(path.join(directory, "backend.mjs")), "the package itself is copied");
    assert.equal(await exists(path.join(directory, "node_modules")), false, "its dependencies are not");
    const answer = (await registry.action("example", "count", {}, { project: "game", directory: root })) as {
      text: string;
    };
    assert.equal(answer.text, seed);
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("a plugin's backend hears of a seed only when it has one", () => {
  const parent = { PATH: "/usr/bin", HOME: "/home/me" };
  assert.equal(
    pluginBackendEnv(parent, "linux", undefined, "/app/plugins/genex")[PLUGIN_SEED_ENV],
    "/app/plugins/genex",
  );
  assert.equal(pluginBackendEnv(parent, "linux")[PLUGIN_SEED_ENV], undefined);
  assert.equal(pluginBackendEnv({ ...parent, [PLUGIN_SEED_ENV]: "/elsewhere" }, "linux")[PLUGIN_SEED_ENV], undefined);
});

/**
 * A folder whose node_modules hold a stand-in Genex CLI, by its real path: `require` resolves the
 * CLI through links (macOS `/var` and `/tmp` are links to `/private/…`).
 */
async function folderWithCli(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-cli-")));
  const pkg = path.join(dir, "node_modules", "@genex-ai", "cli-demo");
  await mkdir(path.join(pkg, "dist"), { recursive: true });
  await writeFile(path.join(pkg, "package.json"), '{"name":"@genex-ai/cli-demo","version":"0.0.0"}\n');
  await writeFile(path.join(pkg, "dist", "index.js"), "");
  return dir;
}

test("the pinned CLI is found in the plugin's seed when its installed copy has none", async () => {
  const seed = await folderWithCli();
  const copy = await mkdtemp(path.join(os.tmpdir(), "studio-copy-"));
  try {
    const expected = path.join(seed, "node_modules", "@genex-ai", "cli-demo", "dist", "index.js");
    assert.equal(genexCliPath(copy, seed), expected, "a host-cli server");
    assert.equal(backendCliPath(seed), expected, "the Genex backend");
    // An installed copy that still carries the CLI (an older profile's) uses the app's pin instead.
    const older = await folderWithCli();
    assert.equal(genexCliPath(older, seed), expected);
    assert.equal(genexCliPath(older), path.join(older, "node_modules", "@genex-ai", "cli-demo", "dist", "index.js"));
    await rm(older, { recursive: true, force: true });
    assert.equal(await readFile(expected, "utf8"), "");
  } finally {
    await rm(seed, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
  }
});
