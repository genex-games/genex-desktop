/**
 * A plugin's manifest in Genex's language: the texts a person reads from its plugin.json come from
 * the plugin's own `locales/<lang>.json` (`substrate/plugins/manifest-words.ts`), as the registry
 * serves them to the window (`displayList`, `displayManifest`, a panel's title), while ids, names,
 * values and permissions stay the manifest's own and the manifests the registry runs on stay
 * English. A missing key shows the English; a broken, oversized or escaping catalog is no
 * translations. The SDK's extractor lists exactly the texts the host translates, and the build
 * ships each bundled plugin's `locales/` beside its plugin.json.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { buildPlugins } from "../../scripts/build-plugins.mjs";
import {
  LOCALES_FOLDER,
  MANIFEST_FILE,
  MESSAGES_FILE,
  manifestMessages,
  writePanelMessages,
} from "../../src/plugin-sdk/panel-words.mjs";
import { messageKey, setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import {
  catalogSay,
  MANIFEST_CATALOG_MAX_BYTES,
  manifestTexts,
  mapManifestTexts,
  PLUGIN_LOCALES_FOLDER,
  readManifestCatalog,
  shownCardTool,
} from "../../src/substrate/plugins/manifest-words.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);

/** The example plugin's texts in Russian, all but one action's label ("Calls this session"). */
const RUSSIAN = {
  "Plugin SDK example": "Пример SDK",
  "Local SDK example: tool, skill, settings, isolated panel, a confirmed tool and a toolbar button.":
    "Пример SDK: инструмент, навык, настройки, панель, инструмент с подтверждением и кнопка.",
  "SDK demo": "Демо SDK",
  Greeting: "Приветствие",
  "Try example": "Попробовать пример",
  "The example plugin wants to shout your text back.": "Пример хочет прокричать твой текст в ответ.",
  Example: "Пример",
  "Example plugin demo": "Демо плагина-примера",
};

/** Every text a person reads blanked: what is left must be the manifest's own, whatever the language. */
const withoutTexts = (manifest: PluginManifest) => mapManifestTexts(manifest, (english) => (english ? "·" : ""));

/** A registry whose bundled example carries `locales` (file name → JSON value, or raw text). */
async function registryWith(locales: Record<string, unknown>) {
  const root = await tmpDir("manifest-words-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  const seed = await copyOfExample(seeds, "example");
  await mkdir(path.join(seed, PLUGIN_LOCALES_FOLDER));
  for (const [file, value] of Object.entries(locales))
    await writeFile(
      path.join(seed, PLUGIN_LOCALES_FOLDER, file),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const services = new PluginServices(path.join(root, "data"), {}, async () => ({}));
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, (id, m, a, b) =>
    services.call(id, m, a, b),
  );
  await registry.init();
  const english = () => registry.list().find((p) => p.manifest.id === "example")?.manifest;
  const shown = async (locale?: Locale) =>
    (await registry.displayList(locale)).find((p) => p.manifest.id === "example")?.manifest;
  return { registry, english, shown, close: () => registry.cancel() };
}

describe("a plugin's manifest in Genex's language", () => {
  afterEach(() => setLocale(Locale.English, {}));

  it("serves its texts from its own catalog, every id, name, value and permission its own", async () => {
    const { registry, english, shown, close } = await registryWith({ "ru.json": RUSSIAN });
    try {
      const before = structuredClone(english());
      const ru = await shown(Locale.Russian);
      assert.ok(ru && before);
      assert.equal(ru.name, "Пример SDK");
      assert.equal(ru.description, RUSSIAN[before.description as keyof typeof RUSSIAN]);
      assert.deepEqual(
        ru.panels.map((p) => [p.id, p.title, p.file]),
        [["demo", "Демо SDK", "panel.html"]],
      );
      assert.deepEqual(
        ru.settings.map((s) => [s.key, s.label, s.default]),
        [["greeting", "Приветствие", "Hello"]],
      );
      assert.deepEqual(
        ru.actions.map((a) => [a.name, a.label]),
        [
          ["hello", "Попробовать пример"],
          ["count", "Calls this session"],
        ],
        "a text the catalog leaves out shows the English",
      );
      const shout = ru.tools.find((t) => t.name === "shout");
      assert.equal(shout?.confirmation, "Пример хочет прокричать твой текст в ответ.");
      assert.equal(
        shout?.description,
        before.tools.find((t) => t.name === "shout")?.description,
        "agents read English",
      );
      assert.deepEqual(
        ru.toolbar?.map((i) => [i.id, i.label, i.ariaLabel, i.target]),
        [["demo", "Пример", "Демо плагина-примера", { kind: "panel", id: "demo" }]],
      );
      assert.deepEqual(withoutTexts(ru), withoutTexts(before), "nothing but the texts differs");
      assert.deepEqual(english(), before, "the manifest the registry runs on stays English");
      assert.deepEqual((await registry.displayManifest("example", Locale.Russian))?.name, "Пример SDK");
      assert.equal(await registry.displayManifest("nobody", Locale.Russian), undefined);
    } finally {
      close();
    }
  });

  it("follows the app's language as it changes, a panel's title with it", async () => {
    const { registry, shown, close } = await registryWith({
      "ru.json": RUSSIAN,
      "de.json": { "Plugin SDK example": "SDK-Beispiel", "SDK demo": "SDK-Demo" },
    });
    try {
      assert.equal((await shown())?.name, "Plugin SDK example", "English until a language is chosen");
      setLocale(Locale.Russian, {});
      assert.equal((await shown())?.name, "Пример SDK");
      assert.equal((await registry.panel("example", "demo")).title, "Демо SDK");
      setLocale(Locale.German, {});
      assert.equal((await shown())?.name, "SDK-Beispiel");
      assert.equal((await registry.panel("example", "demo")).title, "SDK-Demo");
      setLocale(Locale.Japanese, {});
      assert.equal((await shown())?.name, "Plugin SDK example", "a language it has no catalog for shows the English");
      setLocale(Locale.English, {});
      assert.equal((await shown())?.name, "Plugin SDK example");
      assert.equal((await registry.panel("example", "demo")).title, "SDK demo");
    } finally {
      close();
    }
  });

  it("is English, without an error, when its catalog is broken or too large", async () => {
    const big = JSON.stringify({ ...RUSSIAN, padding: "x".repeat(MANIFEST_CATALOG_MAX_BYTES) });
    const rows: Array<[string, unknown]> = [
      ["not JSON", "{ Greeting: Привет"],
      ["a list", JSON.stringify([RUSSIAN])],
      ["null", "null"],
      ["a value that is not text", JSON.stringify({ ...RUSSIAN, Greeting: 1 })],
      ["larger than the limit", big],
    ];
    for (const [what, text] of rows) {
      const { shown, close } = await registryWith({ "ru.json": text });
      try {
        assert.equal((await shown(Locale.Russian))?.name, "Plugin SDK example", what);
      } finally {
        close();
      }
    }
    const { shown, close } = await registryWith({ "ru.json": `\uFEFF${JSON.stringify(RUSSIAN)}` });
    try {
      assert.equal((await shown(Locale.Russian))?.name, "Пример SDK", "a byte order mark is no harm");
    } finally {
      close();
    }
  });
});

describe("reading a plugin's catalog", () => {
  /** A package folder with `locales/` laid out by `lay`, and a folder outside it holding a full catalog. */
  async function packageWith(lay: (pkg: string, outside: string) => Promise<unknown>) {
    const root = await tmpDir("manifest-catalog-");
    const pkg = path.join(root, "pkg");
    const outside = path.join(root, "outside");
    await mkdir(pkg);
    await mkdir(outside);
    await writeFile(path.join(outside, "ru.json"), JSON.stringify(RUSSIAN));
    await lay(pkg, outside);
    return { pkg, outside };
  }

  it("reads nothing through a link out of the package, and nothing else but a file", async () => {
    const rows: Array<[string, (pkg: string, outside: string) => Promise<unknown>]> = [
      ["locales/ is a link out", (pkg, outside) => symlink(outside, path.join(pkg, LOCALES_FOLDER))],
      [
        "ru.json is a link out",
        async (pkg, outside) => {
          await mkdir(path.join(pkg, LOCALES_FOLDER));
          await symlink(path.join(outside, "ru.json"), path.join(pkg, LOCALES_FOLDER, "ru.json"));
        },
      ],
      ["ru.json is a folder", (pkg) => mkdir(path.join(pkg, LOCALES_FOLDER, "ru.json"), { recursive: true })],
      ["no locales/ at all", async () => {}],
    ];
    for (const [what, lay] of rows) {
      const { pkg, outside } = await packageWith(lay);
      assert.equal((await readManifestCatalog(pkg, Locale.Russian)).size, 0, what);
      assert.deepEqual(JSON.parse(await readFile(path.join(outside, "ru.json"), "utf8")), RUSSIAN, what);
      assert.deepEqual(await readdir(pkg), existsSync(path.join(pkg, LOCALES_FOLDER)) ? [LOCALES_FOLDER] : [], what);
    }
    const inside = await packageWith(async (pkg) => {
      await mkdir(path.join(pkg, "words"));
      await writeFile(path.join(pkg, "words", "ru.json"), JSON.stringify(RUSSIAN));
      await mkdir(path.join(pkg, LOCALES_FOLDER));
      await symlink(path.join(pkg, "words", "ru.json"), path.join(pkg, LOCALES_FOLDER, "ru.json"));
    });
    assert.equal((await readManifestCatalog(inside.pkg, Locale.Russian)).get("Greeting"), "Приветствие");
    assert.equal((await readManifestCatalog(inside.pkg, Locale.English)).size, 0, "English has no catalog");
  });
});

describe("a translation Genex shows", () => {
  afterEach(() => setLocale(Locale.English, {}));

  const example = async () =>
    validateManifest(JSON.parse(await readFile(path.join(EXAMPLE_PLUGIN, MANIFEST_FILE), "utf8")));
  const say = (catalog: Record<string, string>) => catalogSay(new Map(Object.entries(catalog)));

  it("is plain text of a fitting length; anything else leaves the English", async () => {
    const manifest = await example();
    const rows: Array<[string, string]> = [
      ["a line break in one line", "Пример\nSDK"],
      ["a text direction override", "Пример \u202eSDK"],
      ["a control character", "Пример\u0007"],
      ["blank", "   "],
      ["many times longer than its English", "Пример ".repeat(20)],
    ];
    for (const [what, said] of rows)
      assert.equal(mapManifestTexts(manifest, say({ "Plugin SDK example": said })).name, manifest.name, what);
    const multiline = mapManifestTexts({ ...manifest, description: "One.\nTwo." }, say({ "One.\nTwo.": "Раз.\nДва." }));
    assert.equal(multiline.description, "Раз.\nДва.", "a line break where its English has one");
  });

  it("never names a stage strip button as Studio's own, in English or in the app's language", async () => {
    const manifest = await example();
    setLocale(Locale.Russian, { Builds: "Сборки", [messageKey("tab", "Live")]: "Эфир" });
    const label = (said: string) => mapManifestTexts(manifest, say({ Example: said })).toolbar?.[0]?.label;
    assert.equal(label("Пример"), "Пример");
    for (const taken of ["Builds", "сборки", "Эфир", "web game"]) assert.equal(label(taken), "Example", taken);
    assert.equal(label(" Пример"), "Example", "a strip name is trimmed");
    assert.equal(label("Очень длинное имя для кнопки"), "Example", "and fits the strip");
  });

  it("changes no text that is empty, and no card words Studio gives itself", async () => {
    const manifest = await example();
    const quiet = { ...manifest, actions: [{ name: "count", label: "Calls this session", confirmation: "" }] };
    assert.equal(mapManifestTexts(quiet, say({ "": "Точно?" })).actions[0]?.confirmation, "");
    const words = say({ ...RUSSIAN, "Your text": "Твой текст" });
    const declared: PluginManifest = {
      ...manifest,
      tools: manifest.tools.map((t) =>
        t.name === "shout" ? { ...t, confirmationInput: { parameter: "text", label: "Your text" } } : t,
      ),
    };
    const shown = mapManifestTexts(declared, words);
    const shout = declared.tools.find((t) => t.name === "shout");
    assert.ok(shout);
    assert.deepEqual(shownCardTool(shout, declared, shown).confirmationInput, {
      parameter: "text",
      label: "Твой текст",
    });
    assert.equal(
      shownCardTool(shout, declared, shown).confirmation,
      RUSSIAN[shout.confirmation as keyof typeof RUSSIAN],
    );
    const studios = { ...shout, confirmation: "Upload the reviewed files?" };
    assert.equal(shownCardTool(studios, declared, shown).confirmation, "Upload the reviewed files?");
    assert.deepEqual(shownCardTool(shout, undefined, shown), shout, "a tool no manifest declares");
  });
});

/** A manifest with every text a person reads, for the two lists to agree on. */
const EVERY_TEXT = {
  id: "words",
  name: "Words",
  description: "Every text.",
  setup: ["Open the app.", "Sign in."],
  panels: [{ id: "main", title: "Main page", file: "panel.html", placement: "settings" }],
  settings: [{ key: "path", label: "The program", type: "string", default: "" }],
  actions: [
    { name: "go", label: "Go", confirmation: "Go now?" },
    { name: "stop", label: "Stop" },
  ],
  tools: [
    { name: "plain", description: "Agents only.", parameters: { type: "object", properties: {} } },
    {
      name: "asks",
      description: "Asks first.",
      parameters: { type: "object", properties: { title: { type: "string" } } },
      confirmation: "Make it?",
      confirmationInput: { parameter: "title", label: "Title" },
    },
  ],
  toolbar: [{ id: "open", label: "Open", ariaLabel: "Open the words", target: { kind: "panel", id: "main" } }],
  folders: [{ path: "~/Library/Logs/Words", why: "Its build tool logs here" }],
  observers: [{ id: "view", facts: ["words"], tool: "shots", live: "stills", label: "Viewport" }],
  nativeRuntimes: [
    { id: "words", label: "Words runtime", candidates: [], version: { args: [], pattern: "", minimum: "1" } },
  ],
  skills: [{ name: "how", text: "Agents read this." }],
  capabilities: [],
};

describe("the texts a plugin translates", () => {
  it("are the same list in the SDK's extractor and in Genex", async () => {
    assert.deepEqual(manifestMessages(EVERY_TEXT), manifestTexts(EVERY_TEXT as unknown as PluginManifest));
    assert.ok(manifestMessages(EVERY_TEXT).includes("Viewport"));
    assert.ok(!manifestMessages(EVERY_TEXT).includes("Agents only."), "what agents read is not translated");
    for (const id of await readdir("src/plugins")) {
      const raw = JSON.parse(await readFile(path.join("src/plugins", id, MANIFEST_FILE), "utf8"));
      assert.deepEqual(manifestMessages(raw), manifestTexts(validateManifest(raw)), id);
    }
    assert.deepEqual(manifestMessages(null), []);
    assert.deepEqual(manifestMessages({ name: 3, actions: "go", panels: [null, { title: "" }] }), []);
  });

  it("go into messages.json beside the panel's, also for a plugin with no panel", async () => {
    const dir = await tmpDir("manifest-messages-");
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(EVERY_TEXT));
    await writeFile(path.join(dir, "panel.html"), `<h2 data-t>Set up</h2><script>t("Go")</script>`);
    const locales = path.join(dir, LOCALES_FOLDER);
    assert.deepEqual(await writePanelMessages([path.join(dir, "panel.html")], locales, EVERY_TEXT), []);
    const listed = JSON.parse(await readFile(path.join(locales, MESSAGES_FILE), "utf8"));
    assert.deepEqual(listed, [...new Set([...manifestMessages(EVERY_TEXT), "Set up"])].sort());

    const bare = await tmpDir("manifest-messages-");
    await writeFile(path.join(bare, MANIFEST_FILE), JSON.stringify(EVERY_TEXT));
    await run(process.execPath, ["src/plugin-sdk/panel-words.mjs", path.join(bare, MANIFEST_FILE)]);
    const written = JSON.parse(await readFile(path.join(bare, LOCALES_FOLDER, MESSAGES_FILE), "utf8"));
    assert.deepEqual(written, manifestMessages(EVERY_TEXT));
    assert.equal(await readFile(path.join(bare, LOCALES_FOLDER, "ru.json"), "utf8"), "{}\n");
  });

  it("ship with each bundled plugin, its locales/ beside its plugin.json", async () => {
    const resources = path.join(await tmpDir("manifest-words-build-"), "resources");
    await buildPlugins(process.cwd(), resources, { dependencies: false });
    const plugins = await readdir("src/plugins");
    const speaking = plugins.filter((id) => existsSync(path.join("src/plugins", id, LOCALES_FOLDER)));
    assert.ok(speaking.includes("genex") && speaking.includes("unity"));
    for (const id of speaking) {
      const shipped = path.join(resources, "plugins", id);
      assert.ok(existsSync(path.join(shipped, MANIFEST_FILE)), id);
      for (const file of await readdir(path.join("src/plugins", id, LOCALES_FOLDER)))
        assert.equal(
          await readFile(path.join(shipped, LOCALES_FOLDER, file), "utf8"),
          await readFile(path.join("src/plugins", id, LOCALES_FOLDER, file), "utf8"),
          `${id}/${file}`,
        );
    }
  });
});
