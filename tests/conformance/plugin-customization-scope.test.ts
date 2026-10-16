import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access, mkdir, rename, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { parsePluginCustomization } from "../../src/shared/plugin-customization.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { PluginCapability } from "../../src/shared/plugins.ts";
import { copyOfExample, installLocalOn, pluginFixture } from "../helpers/plugins.ts";
import { pluginTheme } from "../helpers/plugin-theme.ts";

for (const field of ["mode", "surfaces", "layout", "widgets", "css"]) {
  test(`the narrowed API rejects ${field}`, () => {
    const value = field === "mode" ? "dark" : {};
    assert.throws(() => parsePluginCustomization({ version: 1, [field]: value }));
  });
}
test("one declared panel and a complete readable theme are accepted", () => {
  const value = { version: 1, theme: pluginTheme(), newChat: { panel: "widget", height: 160 } };
  const result = parsePluginCustomization(value);
  assert.equal(result.theme?.name, "Test theme");
  assert.deepEqual(result.newChat, value.newChat);
});
test("the contrast floor applies to text in both schemes", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const role of ["foreground", "muted", "accent", "success", "warning", "danger"] as const) {
      const theme = pluginTheme();
      theme[scheme][role] = theme[scheme].field;
      assert.throws(() => parsePluginCustomization({ version: 1, theme }), /contrast/i);
    }
  }
});
test("customization has its own data file and does not replace the install record", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "theme", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.capabilities.push(PluginCapability.UiCustomization);
    });
    await installLocalOn(f.registry, dir);
    const file = path.join(f.registry.root, "installed.json");
    const before = await readFile(file, "utf8");
    const profile = { version: 1, theme: pluginTheme() };
    await f.registry.setCustomization("theme", profile);
    assert.equal(await readFile(file, "utf8"), before);
    const stored = path.join(f.registry.root, "data", "theme", "customization.json");
    assert.deepEqual(JSON.parse(await readFile(stored, "utf8")), parsePluginCustomization(profile));
  } finally {
    await f.close();
  }
});

test("saving an offer leaves an already open tool approval valid", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "theme", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.capabilities.push(PluginCapability.UiCustomization);
    });
    await installLocalOn(f.registry, dir);
    let asked = 0;
    f.registry.consent = async () => {
      asked++;
      await f.registry.setCustomization("theme", { version: 1 });
      return { approved: true, by: "user" };
    };
    assert.deepEqual(await f.registry.tool("theme__shout", { text: "approved" }, f.binding), {
      text: "APPROVED",
      project: "game",
    });
    assert.ok(asked > 0);
  } finally {
    await f.close();
  }
});

test("panel references reject trailing newlines and out-of-range sizes", () => {
  for (const newChat of [
    { panel: "x\n", height: 160 },
    { panel: "../other", height: 160 },
    { panel: "x", height: 95 },
    { panel: "x", height: 241 },
    { panel: "x", height: 96.5 },
    { panel: "x", height: Infinity },
    { panel: "x", height: 160, target: "app" },
  ])
    assert.throws(() => parsePluginCustomization({ version: 1, newChat }));
  for (const height of [96, 240])
    assert.equal(parsePluginCustomization({ version: 1, newChat: { panel: "x", height } }).newChat?.height, height);
});
test("incomplete palettes and unsafe font, geometry or color data reject the entire offer", () => {
  for (const change of [
    { light: {} },
    { name: "" },
    { name: "x".repeat(65) },
    { mode: "dark" },
    { fonts: { uiFont: "url(file:///secret)" } },
    { fonts: { contentFont: "remote" } },
    { geometry: { textSize: 16 } },
    { geometry: { buttonRadius: -1 } },
    { geometry: { buttonRadius: 25 } },
    { geometry: { cardRadius: 33 } },
    { geometry: { cardRadius: NaN } },
    { dark: { ...pluginTheme().dark, background: "#123456\n" } },
    { dark: { ...pluginTheme().dark, foreground: "red;display:none" } },
    { dark: { ...pluginTheme().dark, controlBorder: "#181818" } },
    { dark: { ...pluginTheme().dark, icon: "#ffffff" } },
  ])
    assert.throws(() => parsePluginCustomization({ version: 1, theme: { ...pluginTheme(), ...change } }));
});
test("refused install ids cannot create profile folders outside plugin data", async () => {
  const f = await pluginFixture();
  try {
    const file = path.join(f.registry.root, "installed.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    records["../../escaped"] = {
      ...records.example,
      manifest: {
        ...records.example.manifest,
        id: "../../escaped",
        apiVersion: 3,
        capabilities: [PluginCapability.UiCustomization],
      },
    };
    await writeFile(file, JSON.stringify(records));
    const reload = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, f.registry.service);
    try {
      await reload.init();
      await assert.rejects(access(path.join(f.root, "escaped")));
    } finally {
      reload.cancel();
    }
  } finally {
    await f.close();
  }
});

test("linked data folders are refused before reads or writes touch their target", async () => {
  const f = await pluginFixture();
  try {
    const source = await copyOfExample(f.root, "theme", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.capabilities.push(PluginCapability.UiCustomization);
    });
    await installLocalOn(f.registry, source);
    const profile = { version: 1, theme: pluginTheme() };
    await f.registry.setCustomization("theme", profile);
    const dir = path.join(f.registry.root, "data", "theme"),
      backup = `${dir}-backup`;
    const outside = path.join(f.root, "unrelated");
    await mkdir(outside);
    const target = path.join(outside, "customization.json");
    await writeFile(target, '"untouched"');
    await rename(dir, backup);
    await symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
    try {
      await assert.rejects(f.registry.setCustomization("theme", { version: 1 }));
      assert.equal(await readFile(target, "utf8"), '"untouched"');
      assert.deepEqual(f.registry.customization("theme"), parsePluginCustomization(profile));
      const reload = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, f.registry.service);
      try {
        await reload.init();
        assert.equal(reload.customization("theme"), null);
      } finally {
        reload.cancel();
      }
    } finally {
      await rm(dir);
      await rename(backup, dir);
    }
  } finally {
    await f.close();
  }
});
test("malformed and oversized profile files are ignored without changing them", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "theme", (m) => {
      m.id = "theme";
      m.apiVersion = 3;
      m.capabilities.push(PluginCapability.UiCustomization);
    });
    await installLocalOn(f.registry, dir);
    await f.registry.setCustomization("theme", { version: 1 });
    const file = path.join(f.registry.root, "data", "theme", "customization.json");
    for (const bytes of ["{", '{"version":1,"css":"body{}"}', " ".repeat(16 * 1024 + 1)]) {
      await writeFile(file, bytes);
      const reload = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, f.registry.service);
      try {
        await reload.init();
        assert.equal(reload.customization("theme"), null);
        assert.equal(reload.list().find((p) => p.manifest.id === "theme")?.customization, undefined);
        assert.equal(await readFile(file, "utf8"), bytes);
      } finally {
        reload.cancel();
      }
    }
  } finally {
    await f.close();
  }
});
