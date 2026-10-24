import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomizationMethod } from "../../src/shared/plugin-customization.ts";
import { answerCustomizationRequest } from "../../src/renderer/panels/plugin-customization-request.ts";
import { panelContext } from "../../src/renderer/panels/panel-bridge.ts";
import { PluginCapability, PluginSourceKind, PluginHealth, type PluginInfo } from "../../src/shared/plugins.ts";

test("the panel discovers the profile API and requests only its bound identity", async () => {
  assert.equal(panelContext(null, { getPropertyValue: () => "" }).features.uiCustomization, 1);
  const calls: unknown[] = [];
  const plugin = {
    manifest: { id: "theme", capabilities: [PluginCapability.UiCustomization] },
    enabled: true,
    removed: false,
    source: PluginSourceKind.Local,
    health: PluginHealth.Ready,
  } as PluginInfo;
  const api = {
    async pluginCustomization(id: string) {
      calls.push(id);
      return null;
    },
    async pluginSetCustomization(id: string, profile: unknown) {
      calls.push([id, profile]);
    },
  };
  const payload = { version: 1, id: "another-plugin" };
  await answerCustomizationRequest(CustomizationMethod.Set, payload, plugin, api, "theme");
  assert.deepEqual(calls, [["theme", payload]]);
  await answerCustomizationRequest(CustomizationMethod.Reset, {}, plugin, api, "theme");
  assert.deepEqual(calls[1], ["theme", null]);
  await answerCustomizationRequest(CustomizationMethod.Read, {}, plugin, api, "theme");
  assert.equal(calls[2], "theme");
  for (const denied of [
    { ...plugin, enabled: false },
    { ...plugin, removed: true },
    { ...plugin, unlisted: true },
    { ...plugin, manifest: { ...plugin.manifest, capabilities: [] } },
    { ...plugin, manifest: { ...plugin.manifest, id: "another" } },
  ])
    await assert.rejects(answerCustomizationRequest(CustomizationMethod.Set, payload, denied, api, "theme"));
  assert.equal(calls.length, 3);
});
