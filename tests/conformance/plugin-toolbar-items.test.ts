/**
 * Which plugin buttons the stage strip shows for the game on it
 * (`src/renderer/panels/plugin-toolbar-items.ts`): Genex's Publish puts a game on the web, so a
 * game without Browser among its destinations has no Publish (the host refuses it
 * `not-a-destination` anyway), and neither has Studio's own Publish, shown while Genex is off.
 * Every other button, Genex's own or another plugin's, stays.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { playsOnWeb, visibleToolbarItems } from "../../src/renderer/panels/plugin-toolbar-items.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { GENEX_PLUGIN_ID, GENEX_PUBLISH_PANEL } from "../../src/shared/genex.ts";
import type { PluginInfo, PluginToolbarItem } from "../../src/shared/plugins.ts";

const { Web, Mac, Windows } = BuildTarget;

/** Genex's own Publish button, as its plugin.json declares it. */
const PUBLISH: PluginToolbarItem = {
  id: "publish",
  label: "Publish",
  ariaLabel: "Publish game",
  icon: "globe",
  requiresProject: true,
  target: { kind: "panel", id: GENEX_PUBLISH_PANEL },
  status: "publish-badge",
};
/** Another Genex button: an action, not the Publish panel. */
const GENEX_ACTION: PluginToolbarItem = {
  id: "share",
  label: "Share",
  ariaLabel: "Share game",
  target: { kind: "action", name: "share" },
};

function plugin(id: string): Pick<PluginInfo, "manifest"> {
  return {
    manifest: {
      apiVersion: 2,
      id,
      version: "1.0.0",
      name: id,
      publisher: "t",
      description: "t",
      backend: "backend.mjs",
      capabilities: [],
      tools: [],
      skills: [],
      panels: [],
      settings: [],
      actions: [],
    },
  };
}

describe("the stage strip's plugin buttons", () => {
  it("Publish is hidden for a game without Browser, and shown for one with it", () => {
    const genex = plugin(GENEX_PLUGIN_ID);
    assert.deepEqual(visibleToolbarItems([PUBLISH, GENEX_ACTION], genex, [Mac]), [GENEX_ACTION]);
    assert.deepEqual(visibleToolbarItems([PUBLISH], genex, [Mac, Windows]), []);
    assert.deepEqual(visibleToolbarItems([PUBLISH], genex, [Web]), [PUBLISH]);
    assert.deepEqual(visibleToolbarItems([PUBLISH], genex, [Web, Mac]), [PUBLISH]);
  });

  it("with no game, or destinations nobody knows, nothing is hidden", () => {
    assert.deepEqual(visibleToolbarItems([PUBLISH], plugin(GENEX_PLUGIN_ID), null), [PUBLISH]);
  });

  it("Studio's own Publish, while Genex is off, is offered only for a game that goes on the web", () => {
    assert.equal(playsOnWeb([Mac]), false);
    assert.equal(playsOnWeb([Mac, Windows]), false);
    assert.equal(playsOnWeb([Web, Mac]), true);
    assert.equal(playsOnWeb(null), true, "no game, or destinations nobody knows");
  });

  it("another plugin's buttons are untouched, even one whose panel is also called publish", () => {
    const other = plugin("itch-uploader");
    const items = [PUBLISH, GENEX_ACTION];
    assert.deepEqual(visibleToolbarItems(items, other, [Mac]), items);
  });
});
