/**
 * The folders outside a game a plugin's programs write to, as its page and its suggestion card name
 * them before the person turns it on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginInfo, PluginManifest } from "../../src/shared/plugins.ts";
import { suggestionFolders } from "../../src/renderer/chat/plugin-suggestion.ts";
import { foldersLine } from "../../src/renderer/panels/plugins/labels.ts";

const SETTINGS = { path: "~/Library/Application Support/ToyEngine", why: "The toy engine's settings" };
const CACHE = { path: "/private/tmp/toy-cache", why: "Shaders it compiles" };

const listed = (id: string, folders?: PluginManifest["folders"], fields: Partial<PluginInfo> = {}) =>
  ({
    manifest: { id, name: id, description: "", ...(folders ? { folders } : {}) } as PluginManifest,
    enabled: false,
    removed: false,
    ...fields,
  }) as Pick<PluginInfo, "manifest" | "enabled" | "removed" | "unlisted">;

describe("a plugin's folders, before it is on", () => {
  it("names a plugin's folders and why, and nothing for a plugin without them", () => {
    const line = foldersLine({ folders: [SETTINGS, CACHE] });
    for (const part of [SETTINGS.path, SETTINGS.why, CACHE.path, CACHE.why]) assert.ok(line.includes(part), part);
    assert.ok(line.indexOf(SETTINGS.why) < line.indexOf(CACHE.path), "each folder with its own reason, in order");
    assert.equal(foldersLine({}), "");
    assert.equal(foldersLine({ folders: [] }), "");

    const list = [listed("toy", [SETTINGS, CACHE]), listed("plain"), listed("gone", [CACHE], { removed: true })];
    const card = suggestionFolders(list, "toy");
    assert.ok(card.includes(SETTINGS.path) && card.includes(CACHE.path), card);
    assert.ok(!card.includes(SETTINGS.why), "the card names the folders; the plugin's page says why");
    assert.equal(suggestionFolders(list, "plain"), "", "no line for a plugin without folders");
    assert.equal(suggestionFolders(list, "gone"), "", "nor for a removed plugin, which Install… reviews first");
    assert.equal(suggestionFolders(list, "elsewhere"), "", "nor for a plugin not in the list");
  });
});
