import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePluginCustomization } from "../../src/shared/plugin-customization.ts";
import { copyOfExample, installLocalOn, pluginFixture } from "../helpers/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { readFile, writeFile, rename, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginCapability, PluginSourceKind, type PluginInfo } from "../../src/shared/plugins.ts";
import { customizationProviders, PLUGIN_COLOR_ROLES } from "../../src/shared/plugin-customization.ts";
import { COLOR_ROLES, DEFAULT_APPEARANCE, paletteFor, Scheme } from "../../src/renderer/appearance/themes.ts";
import { pluginTheme } from "../helpers/plugin-theme.ts";
import { customizedAppearance } from "../../src/renderer/appearance/plugin-customization.ts";

test("native core palettes compose without modifying the person's mode or saved appearance", () => {
  assert.deepEqual([...PLUGIN_COLOR_ROLES].sort(), [...COLOR_ROLES].sort());
  const base = structuredClone(DEFAULT_APPEARANCE);
  const before = structuredClone(base);
  const profile = parsePluginCustomization({ version: 1, theme: pluginTheme() });
  const painted = customizedAppearance(base, profile.theme ?? null);
  assert.equal(paletteFor(painted, Scheme.Dark).background, "#111111");
  assert.equal(painted.uiFont, "system");
  assert.equal(painted.mode, base.mode);
  assert.deepEqual(base, before);
  assert.equal(customizedAppearance(base, null), base);
});
test("provider offers exclude disabled, removed and unpermitted plugins", () => {
  const provider = (id: string) => ({
    manifest: { id, capabilities: [PluginCapability.UiCustomization] } as PluginInfo["manifest"],
    enabled: true,
    removed: false,
    customization: parsePluginCustomization({ version: 1 }),
  });
  const a = provider("a"),
    b = provider("b");
  assert.deepEqual(
    customizationProviders([b, a]).map((p) => p.manifest.id),
    ["b", "a"],
  );
  for (const excluded of [
    { ...a, enabled: false },
    { ...a, removed: true },
    { ...a, unlisted: true },
    { ...a, manifest: { ...a.manifest, capabilities: [] } },
  ])
    assert.deepEqual(
      customizationProviders([excluded, b]).map((p) => p.manifest.id),
      ["b"],
    );
});

for (const composition of [
  { surfaces: { missing: { kind: "solid", color: "#123456" } } },
  { surfaces: { app: { kind: "image", data: "https://example.com/track" } } },
  { surfaces: { app: { kind: "image", data: "data:image/svg+xml;base64,PHN2Zz4=" } } },
  { surfaces: { app: { kind: "gradient", colors: ["red", "#123456"] } } },
  { surfaces: { app: { kind: "solid", color: "#123456", animated: true } } },
  { surfaces: { app: { kind: "gradient", colors: ["#123456", "#abcdef"], animated: "yes" } } },
  { layout: [{ target: "navigation", columns: 0 }] },
  { layout: [{ target: "navigation", columns: 2, items: { settings: { column: 2, columnSpan: 2 } } }] },
  { layout: [{ target: "app", items: { settings: {} } }] },
  { layout: [{ target: "navigation" }, { target: "navigation" }] },
  { widgets: [{ id: "a", target: "app", kind: "html", text: "<script/>" }] },
  { widgets: [{ id: "a", target: "app", kind: "text", html: "<script/>" }] },
  { widgets: [{ id: "a", target: "app", kind: "image", image: "file:///secret" }] },
  {
    widgets: [
      { id: "a", target: "app", kind: "text" },
      { id: "a", target: "app", kind: "clock" },
    ],
  },
  { widgets: Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, target: "app", kind: "clock" })) },
  { layout: [{ target: "app", columns: 2 }], widgets: [{ id: "a", target: "app", kind: "clock", columnSpan: 3 }] },
  { fonts: { uiFont: "url(file:///secret)" } },
  { mode: "unknown" },
  { dark: { background: "#123456\n" } },
  { surfaces: { app: { kind: "solid", color: "#123456\n" } } },
  { surfaces: { app: { kind: "image", data: "data:image/png;base64,AAAA\n" } } },
  { widgets: [{ id: "clock\n", target: "app", kind: "clock" }] },
]) {
  test(`reject unsafe or inconsistent composition: ${JSON.stringify(composition).slice(0, 100)}`, () => {
    assert.throws(() => parsePluginCustomization({ version: 1, ...composition }));
  });
}

test("only API 3 manifests can request UI customization", async () => {
  const f = await pluginFixture();
  try {
    const original = f.registry.list()[0].manifest;
    for (const apiVersion of [1, 2])
      assert.throws(
        () =>
          validateManifest({
            ...original,
            apiVersion,
            capabilities: [...original.capabilities, PluginCapability.UiCustomization],
          }),
        /requires API 3/,
      );
    assert.equal(
      validateManifest({
        ...original,
        apiVersion: 3,
        capabilities: [...original.capabilities, PluginCapability.UiCustomization],
      }).apiVersion,
      3,
    );
  } finally {
    await f.close();
  }
});

test("a versioned profile accepts a complete theme and bounded geometry", () => {
  const profile = { version: 1, theme: pluginTheme() };
  assert.deepEqual(parsePluginCustomization(profile), profile);
});

for (const profile of [
  null,
  [],
  { version: 2 },
  { version: 1, css: "body{display:none}" },
  { version: 1, dark: { unknown: "#123456" } },
  { version: 1, dark: { accent: "url(file:///secret)" } },
  { version: 1, dark: { background: "red;display:none" } },
  { version: 1, geometry: { textSize: NaN } },
  { version: 1, geometry: { textSize: 11 } },
  { version: 1, geometry: { textSize: 19 } },
  { version: 1, geometry: { buttonRadius: -1 } },
  { version: 1, geometry: { cardRadius: 33 } },
  { version: 1, geometry: { zIndex: 999999 } },
  JSON.parse('{"version":1,"dark":{"__proto__":"#123456"}}'),
]) {
  test(`reject an invalid profile: ${JSON.stringify(profile)}`, () => {
    assert.throws(() => parsePluginCustomization(profile));
  });
}

test("profiles are gated, durable, isolated and retained only across updates of the same identity", async () => {
  const f = await pluginFixture();
  try {
    const directory = await copyOfExample(f.root, "theme", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.capabilities.push("ui.customization");
    });
    await installLocalOn(f.registry, directory);
    const profile = { version: 1, theme: pluginTheme() };
    await assert.rejects(f.registry.setCustomization("example", profile), /customization/);
    await f.registry.setCustomization("theme", profile);
    const panel = f.registry
      .list()
      .find((entry) => entry.manifest.id === "theme")
      ?.manifest.panels.find((entry) => entry.placement === "settings");
    assert.ok(panel);
    await assert.rejects(
      f.registry.setCustomization("theme", {
        version: 1,
        newChat: { panel: "undeclared", height: 160 },
      }),
      /declared settings panel/,
    );
    assert.equal(f.registry.customization("theme")?.theme?.dark.background, "#111111");
    await f.registry.setCustomization("theme", {
      ...profile,
      newChat: { panel: panel.id, height: 160 },
    });
    assert.equal(f.registry.customization("theme")?.newChat?.panel, panel.id);
    await f.registry.setCustomization("theme", profile);
    assert.deepEqual(f.registry.customization("theme"), parsePluginCustomization(profile));
    const read = f.registry.customization("theme");
    if (read?.theme) read.theme.dark.background = "#ffffff";
    assert.equal(f.registry.customization("theme")?.theme?.dark.background, "#111111");
    await assert.rejects(f.registry.setCustomization("theme", { version: 1, geometry: { textSize: 50 } }));
    assert.equal(f.registry.customization("theme")?.theme?.dark.background, "#111111");
    const reloaded = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, f.registry.service);
    try {
      await reloaded.init();
      assert.deepEqual(reloaded.customization("theme"), parsePluginCustomization(profile));
      await reloaded.setEnabled("theme", false);
      assert.throws(() => reloaded.customization("theme"));
      await assert.rejects(reloaded.setCustomization("theme", profile));
      await reloaded.setEnabled("theme", true);
      assert.equal(reloaded.customization("theme")?.theme?.dark.background, "#111111");
      await reloaded.setCustomization("theme", null);
      assert.equal(reloaded.customization("theme"), null);
    } finally {
      reloaded.cancel();
    }
    const update = await copyOfExample(f.root, "theme-update", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.version = "1.1.0";
      m.capabilities.push("ui.customization");
    });
    await installLocalOn(f.registry, update);
    assert.equal(f.registry.customization("theme")?.theme?.dark.background, "#111111");
    await f.registry.remove("theme");
    assert.throws(() => f.registry.customization("theme"));
    await assert.rejects(f.registry.setCustomization("theme", profile));
  } finally {
    await f.close();
  }
});

test("a failed durable save leaves the prior in-memory profile intact", async () => {
  const f = await pluginFixture();
  try {
    const directory = await copyOfExample(f.root, "theme", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.capabilities.push(PluginCapability.UiCustomization);
    });
    await installLocalOn(f.registry, directory);
    await f.registry.setCustomization("theme", { version: 1, theme: pluginTheme() });
    const file = path.join(f.registry.root, "data", "theme", "customization.json"),
      backup = `${file}.backup`;
    await rename(file, backup);
    await mkdir(file);
    try {
      await assert.rejects(f.registry.setCustomization("theme", { version: 1 }));
      assert.equal(f.registry.customization("theme")?.theme?.dark.accent, "#aabbff");
    } finally {
      await rmdir(file);
      await rename(backup, file);
    }
  } finally {
    await f.close();
  }
});

test("a refused install record with a malformed saved profile cannot break plugin listing", async () => {
  const f = await pluginFixture();
  let reloaded: PluginRegistry | undefined;
  try {
    const file = path.join(f.registry.root, "installed.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    records.example.manifest.apiVersion = 99;
    records.example.customization = { version: 1, css: "body{display:none}" };
    await writeFile(file, JSON.stringify(records));
    reloaded = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, f.registry.service);
    await reloaded.init();
    const listed = reloaded.list().find((p) => p.manifest.id === "example");
    assert.equal(listed?.enabled, false);
    assert.equal(listed?.customization, undefined);
  } finally {
    reloaded?.cancel();
    await f.close();
  }
});

test("a replaced publisher cannot inherit another plugin's customization profile", async () => {
  const f = await pluginFixture();
  try {
    const make = async (name: string, publisher: string) =>
      copyOfExample(f.root, name, (m) => {
        m.id = "theme";
        m.publisher = publisher;
        m.apiVersion = 3;
        m.capabilities.push(PluginCapability.UiCustomization);
      });
    const a = await make("a", "Publisher A"),
      b = await make("b", "Publisher B");
    await installLocalOn(f.registry, a);
    await f.registry.setCustomization("theme", { version: 1, theme: pluginTheme() });
    const manifest = validateManifest(JSON.parse(await readFile(path.join(b, "plugin.json"), "utf8")));
    const origin = { kind: PluginSourceKind.Local, directory: b };
    await assert.rejects(f.registry.installLocal(b, PluginSourceKind.Local, manifest.capabilities, origin));
    assert.equal(f.registry.customization("theme")?.theme?.dark.accent, "#aabbff");
    f.registry.authorizeReplacement(manifest, origin);
    await installLocalOn(f.registry, b, manifest.capabilities, origin);
    assert.equal(f.registry.customization("theme"), null);
  } finally {
    await f.close();
  }
});
