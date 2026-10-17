import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MultiplayerPress,
  multiplayerPress,
  showsMultiplayer,
  shownToolbarStatus,
  toolbarGlyph,
  toolbarItems,
  toolbarReaction,
  toolbarStatusFrom,
  toolbarTip,
  toolbarUpdateStatus,
  visibleToolbarEntries,
} from "../../src/shared/plugin-toolbar.ts";
import { PLUGIN_TOOLBAR_WORDS } from "../../src/renderer/words.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import type { PluginInfo, PluginManifest, PluginToolbarItem } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import type { GameKind } from "../../src/shared/project-facts.ts";

const item = (over: Partial<PluginToolbarItem> = {}): PluginToolbarItem => ({
  id: "demo",
  label: "Example",
  ariaLabel: "Example plugin demo",
  target: { kind: "panel", id: "demo" },
  ...over,
});
const plugin = (id: string, toolbar: PluginToolbarItem[] | undefined, over: Partial<PluginInfo> = {}): PluginInfo => ({
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
    panels: [{ id: "demo", title: "Demo", file: "panel.html", placement: "settings" }],
    settings: [],
    actions: [],
    ...(toolbar ? { toolbar } : {}),
  },
  source: "local",
  enabled: true,
  removed: false,
  health: "stopped",
  state: "enabled",
  ...over,
});

test("toolbarItems keeps enabled installed plugins only and honours requiresProject", () => {
  const plugins = [
    plugin("a", [
      item(),
      item({ id: "two", ariaLabel: "Two", requiresProject: false }),
      item({ id: "three", ariaLabel: "Three", requiresProject: true }),
    ]),
    plugin("off", [item()], { enabled: false, state: "disabled" }),
    plugin("gone", [item()], { removed: true, enabled: false, state: "disabled" }),
    plugin("dropped", [item()], { unlisted: true, state: "not-enabled" }),
    plugin("none", undefined),
  ];
  assert.deepEqual(
    toolbarItems(plugins, "game").map((e) => e.key),
    ["a:demo", "a:two", "a:three"],
  );
  assert.deepEqual(
    toolbarItems(plugins, null).map((e) => e.key),
    ["a:two"],
  );
  assert.deepEqual(
    toolbarItems(plugins, undefined).map((e) => e.key),
    ["a:two"],
  );
  assert.deepEqual(
    toolbarItems(plugins, "").map((e) => e.key),
    ["a:two"],
  );
  const [first] = toolbarItems(plugins, "game");
  assert.equal(first!.plugin.manifest.id, "a");
  assert.deepEqual(first!.item, item());
  assert.deepEqual(toolbarItems([], "game"), []);
});
test("toolbarStatusFrom sanitizes badge, title, disabled and tone and rejects non-objects", () => {
  for (const value of [null, undefined, "Draft", 3, true, ["Draft"]]) assert.equal(toolbarStatusFrom(value), null);
  assert.deepEqual(toolbarStatusFrom({}), {});
  assert.deepEqual(toolbarStatusFrom({ badge: "Draft", title: "Draft is online", disabled: false, tone: "ok" }), {
    badge: "Draft",
    title: "Draft is online",
    disabled: false,
    tone: "ok",
  });
  assert.deepEqual(toolbarStatusFrom({ badge: "x".repeat(40) }), { badge: "x".repeat(16) });
  assert.deepEqual(toolbarStatusFrom({ title: "y".repeat(200) }), { title: "y".repeat(120) });
  assert.deepEqual(toolbarStatusFrom({ badge: "  Live \n now  ", title: "\tready\n" }), {
    badge: "Live now",
    title: "ready",
  });
  assert.deepEqual(toolbarStatusFrom({ badge: 7 }), { badge: "7" });
  assert.deepEqual(toolbarStatusFrom({ badge: "", title: "", disabled: 1 }), { disabled: true });
  assert.deepEqual(toolbarStatusFrom({ disabled: "", tone: "loud" }), { disabled: false });
  assert.deepEqual(toolbarStatusFrom({ badge: {}, title: ["x"], tone: "warn", extra: "dropped" }), { tone: "warn" });
  assert.deepEqual(toolbarStatusFrom({ kind: "toolbar", item: "publish", badge: "Live", tone: "ok" }), {
    badge: "Live",
    tone: "ok",
  });
});

test("a change to the open game's own record re-asks the buttons; file writes and other games do not", () => {
  const changed = (payload: { project?: string; file?: string }, open: string | null) =>
    toolbarReaction({ type: UiEvent.GameChanged, payload } as UiEvent, [], open);
  assert.equal(changed({ project: "valley" }, "valley"), "refresh", "its engine link or title changed");
  assert.equal(changed({}, "valley"), "refresh", "every game changed, as when the games folder moves");
  assert.equal(changed({ project: "valley", file: "src/main.ts" }, "valley"), null, "a build writing files");
  assert.equal(changed({ project: "valley", file: "references" }, "valley"), null);
  assert.equal(changed({ project: "lantern" }, "valley"), null, "another game");
  assert.equal(changed({ project: "valley" }, null), null, "no game open");
});

test("a finished turn in the open game's chat re-asks the buttons; another game's does not", () => {
  const finished = (project: string, open: string | null) =>
    toolbarReaction(
      { type: UiEvent.DelegationFinished, payload: { project, engine: "claude", active: 0 } } as UiEvent,
      [],
      open,
    );
  assert.equal(finished("lantern", "lantern"), "refresh");
  assert.equal(finished("harbor", "lantern"), null);
  assert.equal(finished("lantern", null), null);
});

test("a plugin change re-asks every button; a plugin's toolbar event updates its own button", () => {
  const [entry] = toolbarItems([plugin("a", [item()])], "game");
  const event = (payload: unknown) => ({ type: UiEvent.PluginEvent, payload }) as UiEvent;
  assert.equal(toolbarReaction({ type: UiEvent.PluginsChanged, payload: {} } as UiEvent, [], null), "refresh");
  assert.deepEqual(
    toolbarReaction(
      event({ id: "a", event: { kind: "toolbar", item: "demo", badge: "Live", tone: "ok" } }),
      [entry],
      "game",
    ),
    { key: "a:demo", update: { badge: "Live", tone: "ok" } },
  );
  assert.equal(toolbarReaction(event({ id: "a", event: { kind: "toolbar" } }), [entry], "game"), "refresh");
  assert.equal(
    toolbarReaction(event({ id: "b", event: { kind: "toolbar" } }), [entry], "game"),
    null,
    "not its plugin",
  );
  assert.equal(toolbarReaction(event({ id: "a", event: { kind: "progress" } }), [entry], "game"), null);
  assert.equal(toolbarReaction({ type: UiEvent.GameArchived, payload: {} } as UiEvent, [entry], "game"), null);
});

test("a plugin behind the version Studio bundles says Update on its buttons, until that update waits or is done", () => {
  const behind = plugin("unreal", [item()], { availableVersion: "0.3.0" });
  assert.deepEqual(toolbarUpdateStatus(behind, PLUGIN_TOOLBAR_WORDS.update), {
    badge: "Update",
    title: PLUGIN_TOOLBAR_WORDS.update.title("unreal", "0.3.0"),
  });
  const waiting = plugin("unreal", [item()], { availableVersion: "0.3.0", pendingVersion: "0.3.0" });
  assert.equal(toolbarUpdateStatus(waiting, PLUGIN_TOOLBAR_WORDS.update), null, "the update waits for its sessions");
  assert.equal(toolbarUpdateStatus(plugin("unreal", [item()]), PLUGIN_TOOLBAR_WORDS.update), null, "up to date");
  const status = toolbarStatusFrom(toolbarUpdateStatus(behind, PLUGIN_TOOLBAR_WORDS.update));
  assert.equal(status?.badge, "Update", "the badge survives the toolbar's own sanitizing");
});
test("Multiplayer brings Genex in, updates an older Genex first, and otherwise asks the game's chat", () => {
  assert.equal(multiplayerPress(undefined), MultiplayerPress.SetUp, "Genex off or not installed");
  const behind = plugin("genex", [item()], { availableVersion: "1.10.0" });
  assert.equal(multiplayerPress(behind), MultiplayerPress.Update, "an older Genex's instructions refuse the template");
  const waiting = plugin("genex", [item()], { availableVersion: "1.10.0", pendingVersion: "1.10.0" });
  assert.equal(multiplayerPress(waiting), MultiplayerPress.Ask, "as Publish: the update waits for its sessions");
  assert.equal(multiplayerPress(plugin("genex", [item()])), MultiplayerPress.Ask);
});
test("Multiplayer stands beside Publish only on a built single-player game with something in it, whose page is its own", () => {
  const game = { publish: true, builtOnce: true, multiplayer: false, emptyGame: false, webExport: false };
  assert.equal(showsMultiplayer(game), true);
  assert.equal(showsMultiplayer({ ...game, builtOnce: false }), false, "a game never built has nothing to share yet");
  assert.equal(showsMultiplayer({ ...game, multiplayer: true }), false, "a multiplayer game is multiplayer already");
  assert.equal(showsMultiplayer({ ...game, emptyGame: true }), false, "an empty game has nothing to play together yet");
  assert.equal(showsMultiplayer({ ...game, publish: false }), false, "no Publish, no Multiplayer");
  assert.equal(
    showsMultiplayer({ ...game, webExport: true }),
    false,
    "an engine's web export is a build, never edited",
  );
});
test("toolbarStatusFrom keeps attention as a boolean", () => {
  assert.deepEqual(toolbarStatusFrom({ attention: true }), { attention: true });
  assert.deepEqual(toolbarStatusFrom({ attention: 0, title: "Up to date" }), { attention: false, title: "Up to date" });
  assert.deepEqual(toolbarStatusFrom({ kind: "toolbar", item: "publish", attention: "yes" }), { attention: true });
  assert.deepEqual(toolbarStatusFrom({ badge: "Draft" }), { badge: "Draft" });
});
test("a button scoped to facts shows on a game served by one of them, elsewhere only while its plugin brings it out", () => {
  const unreal: GameKind = { facts: [{ id: "unreal-project", path: "unreal" }] };
  const web: GameKind = { facts: [{ id: "web-game", path: "." }] };
  const noKindYet: GameKind = { facts: [], holds: "nothing" };
  const plugins = [plugin("u", [item({ id: "editor", ariaLabel: "Editor", facts: ["unreal-project"] }), item()])];
  const shown = (game: GameKind | undefined, project: string | null = "game", status = {}) =>
    visibleToolbarEntries(toolbarItems(plugins, project, game), status).map((e) => e.key);
  assert.deepEqual(shown(unreal), ["u:editor", "u:demo"]);
  assert.deepEqual(shown(web), ["u:demo"]);
  assert.deepEqual(shown(noKindYet), ["u:demo"], "a game with no kind yet is served as a web game");
  assert.deepEqual(shown(undefined), ["u:demo"], "a game whose facts aren't known yet");
  assert.deepEqual(
    toolbarItems(plugins, "game", web).map((e) => e.key),
    ["u:editor", "u:demo"],
    "a scoped button out of its facts is still asked for its status",
  );
  assert.deepEqual(shown(web, "game", { "u:editor": { shown: true } }), ["u:editor", "u:demo"]);
  assert.deepEqual(shown(web, "game", { "u:editor": { shown: false } }), ["u:demo"]);
  assert.deepEqual(shown(unreal, null), [], "no game open: neither the scoped button nor one that needs a game");
});

test("every bundled plugin that makes a kind of project keeps its buttons off a web game and shows them on its own", () => {
  const web: GameKind = { facts: [{ id: "web-game", path: "." }] };
  const engines = readdirSync("src/plugins", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(`src/plugins/${entry.name}/plugin.json`, "utf8")) as PluginManifest)
    .map((raw) => validateManifest(raw))
    .filter((manifest) => (manifest.scaffolds?.length ?? 0) > 0 && (manifest.toolbar?.length ?? 0) > 0);
  assert.ok(engines.length >= 2, "Unreal and Unity at least");
  for (const manifest of engines) {
    const plugins = [{ ...plugin(manifest.id, undefined), manifest }];
    assert.deepEqual(visibleToolbarEntries(toolbarItems(plugins, "game", web), {}), [], `${manifest.id} on a web game`);
    for (const button of manifest.toolbar ?? []) {
      const own: GameKind = { facts: (button.facts ?? []).map((id) => ({ id, path: "." })) };
      assert.ok(button.facts?.length, `${manifest.id}:${button.id} names the facts of its games`);
      assert.ok(button.icon, `${manifest.id}:${button.id} has an icon to fold into`);
      const keys = visibleToolbarEntries(toolbarItems(plugins, "game", own), {}).map((entry) => entry.key);
      assert.ok(keys.includes(`${manifest.id}:${button.id}`), `${manifest.id}:${button.id} on its own game`);
    }
  }
});

test("a folded button is never blank: its icon, else its label's first letter; unfolded, an icon-less button has none", () => {
  assert.equal(toolbarGlyph(item({ icon: "box" }), true), "box");
  assert.equal(toolbarGlyph(item({ icon: "box" }), false), "box");
  assert.equal(toolbarGlyph(item({ label: "example" }), true), "E");
  assert.equal(toolbarGlyph(item({ label: "example" }), false), undefined);
});

test("toolbarStatusFrom keeps shown as a boolean", () => {
  assert.deepEqual(toolbarStatusFrom({ shown: true }), { shown: true });
  assert.deepEqual(toolbarStatusFrom({ shown: 0, title: "Make this game in Unreal" }), {
    shown: false,
    title: "Make this game in Unreal",
  });
  assert.deepEqual(toolbarStatusFrom({ badge: "Ready" }), { badge: "Ready" });
});

test("toolbarStatusFrom keeps dot as a boolean", () => {
  assert.deepEqual(toolbarStatusFrom({ badge: "Ready", tone: "ok", dot: true }), {
    badge: "Ready",
    tone: "ok",
    dot: true,
  });
  assert.deepEqual(toolbarStatusFrom({ badge: "Not open", dot: 0 }), { badge: "Not open", dot: false });
  assert.deepEqual(toolbarStatusFrom({ kind: "toolbar", item: "editor", dot: "yes" }), { dot: true });
});
test("a dot's tooltip says its word first, then the plugin's title; a word badge's says the title alone", () => {
  assert.deepEqual(toolbarTip({ badge: "Not open", tone: "info", dot: true, title: "Drift isn't open in Unreal." }), [
    "Not open",
    "Drift isn't open in Unreal.",
  ]);
  assert.deepEqual(toolbarTip({ badge: "Starting", dot: true }), ["Starting"]);
  assert.deepEqual(toolbarTip({ badge: "Draft", title: "Draft is online" }), ["Draft is online"]);
  assert.deepEqual(toolbarTip({ title: "Make this game in Unreal" }), ["Make this game in Unreal"]);
  assert.deepEqual(toolbarTip({ dot: true }), [], "a dot with no word draws nothing to say");
  assert.deepEqual(toolbarTip(undefined), []);
});
test("Update takes the badge's place as a word in the quiet tone, whatever dot or tone the plugin's own had", () => {
  const own = { badge: "Ready", tone: "ok", dot: true, title: "Connected to Drift." } as const;
  const update = toolbarUpdateStatus(
    plugin("unreal", [item()], { availableVersion: "0.3.0" }),
    PLUGIN_TOOLBAR_WORDS.update,
  );
  assert.deepEqual(shownToolbarStatus(own, update), {
    badge: "Update",
    title: PLUGIN_TOOLBAR_WORDS.update.title("unreal", "0.3.0"),
  });
  assert.deepEqual(shownToolbarStatus({ ...own, disabled: true, attention: true }, update), {
    disabled: true,
    attention: true,
    badge: "Update",
    title: PLUGIN_TOOLBAR_WORDS.update.title("unreal", "0.3.0"),
  });
  assert.equal(shownToolbarStatus(own, null), own, "up to date: the plugin's own status");
  assert.equal(shownToolbarStatus(undefined, null), undefined);
});
