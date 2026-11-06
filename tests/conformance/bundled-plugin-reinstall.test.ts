/**
 * Every plugin Genex ships comes back after the person removes it: Reinstall copies its seed into the
 * profile and starts the backend from that copy, which has no `node_modules` beside or above it. A
 * backend that needs a package from the app's own `node_modules` at import never starts there, so
 * Reinstall refuses it (`plugin_backend_failed`) and every tool of an installed copy fails.
 */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

/** Reinstall starts each backend once; a cold start of the largest one takes a few seconds. */
const REINSTALL_TIMEOUT_MS = 120_000;

let lite: CoreLite;
before(async () => {
  lite = await coreLite();
});
after(() => lite.close());

it("removing and reinstalling each bundled plugin starts its backend from the profile copy", {
  timeout: REINSTALL_TIMEOUT_MS,
}, async () => {
  const plugins = lite.core.plugins;
  // The person removes neither the Genex plugin, which holds the account, nor one that works under
  // another plugin's switch.
  const removable = (id: string) => id !== GENEX_PLUGIN_ID && !plugins.underHood.has(id);
  const bundled = plugins
    .list()
    .filter((plugin) => plugin.source === PluginSourceKind.Bundled && removable(plugin.manifest.id))
    .map((plugin) => plugin.manifest.id);
  assert.ok(bundled.includes("godot"), "the shipped plugins include Godot");
  const refused: string[] = [];
  for (const id of bundled) {
    await plugins.remove(id);
    await plugins.restore(id).catch((error: unknown) => {
      refused.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  assert.deepEqual(refused, [], "every bundled plugin reinstalls");
});
