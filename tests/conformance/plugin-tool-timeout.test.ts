/**
 * A plugin tool's own call deadline (`timeoutMs`, API 3): a game engine's import or export runs
 * past the host's 190-second ceiling up to the most a tool may declare, never more; a tool that
 * declares none keeps the host's ceiling.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PLUGIN_TOOL_MAX_TIMEOUT_MS, PluginSourceKind } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PLUGIN_CALL_TIMEOUT_MS, PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { TOY_PLUGIN } from "../helpers/project-fixtures.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

const SIX_MINUTES = 360_000;

/** The toy engine plugin's manifest with its `build` tool declaring `timeoutMs`, as a publisher writes it. */
async function toyManifest(timeoutMs: unknown, apiVersion = 3) {
  const manifest = JSON.parse(await readFile(path.join(TOY_PLUGIN, "plugin.json"), "utf8"));
  manifest.apiVersion = apiVersion;
  const build = manifest.tools.find((tool: { name: string }) => tool.name === "build");
  build.timeoutMs = timeoutMs;
  return manifest;
}

describe("a plugin tool's own call deadline", () => {
  it("is kept as declared from a second to the most a tool may declare, on API 3 only", async () => {
    const kept = validateManifest(await toyManifest(SIX_MINUTES));
    assert.equal(kept.tools.find((tool) => tool.name === "build")?.timeoutMs, SIX_MINUTES);
    for (const refused of [PLUGIN_TOOL_MAX_TIMEOUT_MS + 1, 999, 1.5, "600000", null]) {
      const manifest = await toyManifest(refused);
      assert.throws(() => validateManifest(manifest), /Invalid tools\[\]\.timeoutMs/, String(refused));
    }
  });

  it("lets that tool's call run past the host's ceiling, and no other tool's", async () => {
    const root = await tmpDir("studio-tool-timeout-");
    const plugin = path.join(root, "toy");
    await cp(TOY_PLUGIN, plugin, { recursive: true });
    await writeFile(path.join(plugin, "plugin.json"), JSON.stringify(await toyManifest(SIX_MINUTES)));
    await mkdir(path.join(root, "seeds"));
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      path.join(root, "seeds"),
      PLUGIN_SDK_BACKEND,
      async () => null,
    );
    closeBeforeCleanup(async () => registry.cancel());
    await registry.init();
    await registry.installLocal(plugin, PluginSourceKind.Local);
    assert.equal(registry.callCeilingOf("toy-engine__build"), SIX_MINUTES);
    assert.equal(registry.callCeilingOf("toy-engine__capture"), PLUGIN_CALL_TIMEOUT_MS);
  });

  it("is what the Godot plugin's tools that run Godot declare, so an import or export isn't cut at 190 seconds", async () => {
    const manifest = validateManifest(
      JSON.parse(await readFile(new URL("../../src/plugins/godot/plugin.json", import.meta.url), "utf8")),
    );
    for (const name of ["new-game", "check", "run-scene", "screenshot", "web-export", "export-templates"])
      assert.equal(manifest.tools.find((tool) => tool.name === name)?.timeoutMs, PLUGIN_TOOL_MAX_TIMEOUT_MS, name);
  });
});
