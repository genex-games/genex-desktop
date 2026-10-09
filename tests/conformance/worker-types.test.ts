/**
 * The kinds of worker a lead may start, and the folders workers may write to, come from the plugins
 * that are on: the registry lists each declared kind once (the first plugin to declare an id wins),
 * with its tools as the agent names a worker is offered, and only while one of those tools reaches
 * the game; it expands and dedupes the folders of the plugins that are on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CoreFact, type FactRef } from "../../src/shared/project-facts.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { WorkerIsolation } from "../../src/shared/workers.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { copyOfExample, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { TOY_PLUGIN_ID, toyRegistry } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const at = (id: string, where = "."): FactRef => ({ id, path: where });
const TOY_GAME = [at("toy-project")];
const UNREAL_GAME = [at(CoreFact.UnrealProject)];
const WEB_GAME = [at(CoreFact.WebGame)];
/** A second local plugin that declares the toy's `scene` again, and a kind of its own. */
const LATER = "toy-later";
const TOY_SETTINGS = path.join(os.homedir(), "Library", "Application Support", "ToyEngine");

const UNREAL = JSON.parse(readFileSync(new URL("../../src/plugins/unreal/plugin.json", import.meta.url), "utf8"));

/** The toy registry with a second local plugin, `toy-later`, beside the toy; both off. */
async function withLater() {
  const registry = await toyRegistry();
  const dir = await copyOfExample(await tmpDir("studio-worker-types-"), LATER, (m) => {
    m.id = LATER;
    m.apiVersion = 3;
    m.tools = [{ name: "paint", description: "Paint a scene.", parameters: { type: "object", properties: {} } }];
    m.skills = [];
    m.workerTypes = [
      { id: "scene", description: "Paints one scene", tools: ["paint"], isolation: WorkerIsolation.Lock },
      {
        id: "painter",
        description: "Paints with the toy's build",
        tools: ["paint", "toy-engine__build"],
        isolation: "read",
      },
    ];
    m.folders = [
      { path: "~/Library/Application Support/ToyEngine", why: "The toy engine's settings, again" },
      { path: "/private/tmp/toy-later", why: "Its own scratch" },
    ];
  });
  await registry.installLocal(dir, PluginSourceKind.Local);
  // Both start off, whatever a loaded local plugin starts as today.
  await registry.setEnabled(TOY_PLUGIN_ID, false);
  await registry.setEnabled(LATER, false);
  return registry;
}

/** A registry whose only plugin carries the bundled Unreal plugin's tools and worker types, on. */
async function unrealRegistry() {
  const root = await tmpDir("studio-worker-types-unreal-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, "unreal", (m) => {
    m.id = UNREAL.id;
    m.apiVersion = 3;
    m.tools = UNREAL.tools;
    // Its editor steps need its lock, so the lock comes with them.
    m.locks = UNREAL.locks;
    m.skills = [];
    m.workerTypes = UNREAL.workerTypes;
  });
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return registry;
}

describe("worker types from the plugins that are on", () => {
  it("lists the worker types of the plugins that are on, first declaration first, with their tools as agent names", async () => {
    const registry = await withLater();
    try {
      assert.deepEqual(registry.workerTypes(TOY_GAME), [], "plugins that are off declare nothing");
      await registry.setEnabled(TOY_PLUGIN_ID, true);
      await registry.setEnabled(LATER, true);
      assert.deepEqual(registry.workerTypes(TOY_GAME), [
        {
          pluginId: TOY_PLUGIN_ID,
          id: "scene",
          description: "Edits one scene",
          tools: ["toy-engine__build"],
          isolation: WorkerIsolation.Copy,
        },
        {
          pluginId: LATER,
          id: "painter",
          description: "Paints with the toy's build",
          tools: ["toy-later__paint", "toy-engine__build"],
          isolation: WorkerIsolation.Read,
        },
      ]);
      // The toy's build reaches only a toy project: on a web game the toy's `scene` is left out,
      // so the later plugin's own `scene` is the one listed.
      assert.deepEqual(
        registry.workerTypes(WEB_GAME).map((type) => [type.pluginId, type.id, type.tools]),
        [
          [LATER, "scene", ["toy-later__paint"]],
          [LATER, "painter", ["toy-later__paint", "toy-engine__build"]],
        ],
      );
      await registry.setEnabled(TOY_PLUGIN_ID, false);
      assert.deepEqual(
        registry.workerTypes(TOY_GAME).map((type) => [type.pluginId, type.id]),
        [
          [LATER, "scene"],
          [LATER, "painter"],
        ],
        "the toy off, its kind and its tools are gone; a kind with one of its own tools left stays",
      );
    } finally {
      registry.cancel();
    }

    const unreal = await unrealRegistry();
    try {
      const cpp = unreal.workerTypes(UNREAL_GAME).find((type) => type.id === "cpp");
      assert.deepEqual(cpp && { pluginId: cpp.pluginId, tools: cpp.tools, isolation: cpp.isolation }, {
        pluginId: "unreal",
        tools: ["unreal__check-part"],
        isolation: WorkerIsolation.Copy,
      });
      assert.deepEqual(unreal.workerTypes(WEB_GAME), [], "a web game gets no C++ workers");
    } finally {
      unreal.cancel();
    }
  });

  it("expands and dedupes the folders of the plugins that are on", async () => {
    const registry = await withLater();
    try {
      assert.deepEqual(registry.workerFolders(), [], "plugins that are off add no folder");
      await registry.setEnabled(TOY_PLUGIN_ID, true);
      assert.deepEqual(registry.workerFolders(), [TOY_SETTINGS]);
      await registry.setEnabled(LATER, true);
      assert.deepEqual(registry.workerFolders(), [TOY_SETTINGS, "/private/tmp/toy-later"]);
    } finally {
      registry.cancel();
    }
  });
});
