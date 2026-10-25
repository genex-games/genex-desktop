/**
 * A plugin panel in Genex's language: the host names the window's language in the panel's context
 * (`panel-bridge.ts`), the SDK's `words.js` speaks it from the plugin's own `locales/<lang>.json`
 * that `inline-panel-sdk.mjs` pastes in, and a missing translation shows the English. The bundled
 * plugins' `locales/messages.json` lists exactly the English each panel asks for and the texts of
 * its manifest a person reads, and their catalogs keep to it.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import vm from "node:vm";
import { inlinePanelSdk } from "../../src/plugin-sdk/inline-panel-sdk.mjs";
import {
  CATALOGS_ID,
  LOCALES_FOLDER,
  MANIFEST_FILE,
  MESSAGES_FILE,
  manifestMessages,
  PANEL_LOCALES,
  panelMessages,
  readPanelLocales,
  writePanelMessages,
} from "../../src/plugin-sdk/panel-words.mjs";
import { PanelSurface, panelContext } from "../../src/renderer/panels/panel-bridge.ts";
import { PanelMessage, PanelMethod, openPanelBridge } from "../../src/renderer/panels/panel-host-bridge.ts";
import { messageArguments, setLocale } from "../../src/shared/i18n.ts";
import { Locale, LOCALES } from "../../src/shared/locale.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** One element of a stand-in page: its text, its attributes and its `data-t` mark. */
type Element = { textContent: string; dataset: { t: string }; attributes: Record<string, string> };
const element = (text: string, t = "", attributes: Record<string, string> = {}) => ({
  textContent: text,
  dataset: { t },
  attributes,
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  },
  hasAttribute(name: string) {
    return name in this.attributes;
  },
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  },
});

/**
 * `words.js` on a stand-in page whose host answers context with `context` (or fails, or never
 * answers), with the plugin's translations pasted in as `inline-panel-sdk.mjs` pastes them.
 */
async function panel(options: {
  context?: Record<string, unknown> | "fails" | "silent";
  catalogs?: Record<string, Record<string, string>>;
  marked?: Element[];
}) {
  const timers: Array<() => void> = [];
  const html: { lang?: string } = {};
  const document = {
    documentElement: html,
    getElementById: (id: string) =>
      id === CATALOGS_ID && options.catalogs ? { textContent: JSON.stringify(options.catalogs) } : null,
    querySelectorAll: (selector: string) => (selector === "[data-t]" ? (options.marked ?? []) : []),
  };
  const context = options.context ?? {};
  const call = async (method: string) => {
    assert.equal(method, "context");
    if (context === "fails") throw new Error("Unsupported panel operation");
    if (context === "silent") return new Promise(() => {});
    return context;
  };
  const window = { studioPlugin: { call } as Record<string, any> };
  const realm = vm.createContext({
    window,
    document,
    setTimeout: (run: () => void) => timers.push(run),
    clearTimeout() {},
  });
  vm.runInContext(await readFile("src/plugin-sdk/words.js", "utf8"), realm);
  return { sdk: window.studioPlugin, html, timers };
}

const RUSSIAN = {
  "Set up {name}": "Настроить {name}",
  "{count, plural, one {# game} other {# games}}":
    "{count, plural, one {# игра} few {# игры} many {# игр} other {# игры}}",
  Ready: "Готово",
  "Open the folder": "Открыть папку",
  Broken: "{oops",
};

describe("the panel SDK's words", () => {
  it("speak the host's language from the plugin's catalog, plural forms by that language's rules", async () => {
    const { sdk, html } = await panel({ context: { locale: "ru" }, catalogs: { ru: RUSSIAN } });
    assert.equal(sdk.locale, "en", "English until the host has named the language");
    assert.equal(await sdk.ready, "ru");
    assert.equal(sdk.locale, "ru");
    assert.equal(html.lang, "ru", "the page says which language it is in");
    assert.equal(sdk.t("Set up {name}", { name: "Drift" }), "Настроить Drift");
    const games = (count: number) => sdk.t("{count, plural, one {# game} other {# games}}", { count });
    assert.deepEqual([1, 3, 5, 21, 1200].map(games), ["1 игра", "3 игры", "5 игр", "21 игра", "1\u00a0200 игр"]);
    assert.equal(sdk.formatList(["a", "b", "c"]), "a, b и c");
  });

  it("show the English, its placeholders filled, when a translation is missing or broken", async () => {
    const { sdk } = await panel({ context: { locale: "ru" }, catalogs: { ru: RUSSIAN } });
    await sdk.ready;
    assert.equal(sdk.t("Restart {app}", { app: "Unreal" }), "Restart Unreal");
    assert.equal(sdk.t("Broken"), "Broken", "a translation that does not parse gives way to the English");
    assert.equal(sdk.t("Couldn't open '{'{name}'}'", { name: "Cave" }), "Couldn't open {Cave}");
  });

  it("stay English, as written, without a language the plugin has words for", async () => {
    const rows: Array<[string, Parameters<typeof panel>[0]]> = [
      ["no locale in the context (an older host)", { context: {}, catalogs: { ru: RUSSIAN } }],
      ["a language the plugin brings no words for", { context: { locale: "de" }, catalogs: { ru: RUSSIAN } }],
      ["English itself", { context: { locale: "en" }, catalogs: { ru: RUSSIAN } }],
      ["no catalogs pasted in", { context: { locale: "ru" } }],
      ["a context that fails", { context: "fails", catalogs: { ru: RUSSIAN } }],
    ];
    for (const [name, options] of rows) {
      const marked = [element("  Ready \n")];
      const { sdk, html } = await panel({ ...options, marked });
      assert.equal(await sdk.ready, "en", name);
      assert.equal(html.lang, "en", name);
      assert.equal(sdk.t("Set up {name}", { name: "Drift" }), "Set up Drift", name);
      assert.equal(sdk.t("{count, plural, one {# game} other {# games}}", { count: 2 }), "2 games", name);
      assert.equal(sdk.formatList(["a", "b", "c"]), "a, b and c", name);
      assert.equal(marked[0]?.textContent, "  Ready \n", `${name}: the page keeps its own English`);
    }
  });

  it("go on in English when the host never answers", async () => {
    const { sdk, timers } = await panel({ context: "silent", catalogs: { ru: RUSSIAN } });
    await settle();
    assert.equal(timers.length, 1, "one wait for the language");
    timers[0]?.();
    assert.equal(await sdk.ready, "en");
  });

  it("translate the page's marked text and attributes before the panel goes on", async () => {
    const text = element("\n  Ready\n ");
    const titled = element("Ready", "title aria-label", { title: "Open the folder", "aria-label": "Unknown words" });
    const both = element("Ready", "text title", { title: "Open the folder" });
    const { sdk } = await panel({ context: { locale: "ru" }, catalogs: { ru: RUSSIAN }, marked: [text, titled, both] });
    await sdk.ready;
    assert.equal(text.textContent, "Готово");
    assert.equal(titled.textContent, "Ready", "only what the mark names");
    assert.deepEqual(titled.attributes, { title: "Открыть папку", "aria-label": "Unknown words" });
    assert.deepEqual([both.textContent, both.attributes.title], ["Готово", "Открыть папку"]);
  });
});

describe("a panel's messages, read from its page", () => {
  it("are its t() literals and its data-t words, decoded and folded as the frame reads them", () => {
    const html = `<!doctype html><html><body>
<h2 data-t>Set up
   Unreal</h2><p data-t>Tom &amp; Jerry&#8217;s game</p>
<button data-t="title" title="Open the folder">Open</button>
<input data-t="placeholder aria-label" placeholder="Search" aria-label="Search places">
<span data-testid="x">Not marked</span>
<script type="application/json" id="${CATALOGS_ID}">{"ru":{"t(\\"no\\")":"x"}}</script>
<script type="module">
const t = studioPlugin.t;
say(t("Restart {app}", { app }), api.t('Don\\'t "quit"'), t(\`Plain\`));
</script></body></html>`;
    assert.deepEqual(panelMessages(html), {
      messages: [
        'Don\'t "quit"',
        "Open the folder",
        "Plain",
        "Restart {app}",
        "Search",
        "Search places",
        "Set up Unreal",
        "Tom & Jerry’s game",
      ],
      problems: [],
    });
  });

  it("names what it cannot read: a t() of anything but a plain string, a mark on markup or on nothing", () => {
    const html = `<p data-t>Open <b>Unity</b></p><button data-t="title">Go</button>
<script>t(words); t(\`Hi \${name}\`); t("ok");</script>`;
    const { messages, problems } = panelMessages(html);
    assert.deepEqual(messages, ["ok"]);
    assert.equal(problems.length, 4, problems.join("\n"));
  });
});

describe("pasting a plugin's translations into its panel", () => {
  afterEach(() => setLocale(Locale.English, {}));

  it("pastes the translated languages beside the SDK, as data that cannot close its element", async () => {
    const dir = await tmpDir("panel-words-");
    await writeFile(path.join(dir, "ru.json"), JSON.stringify({ Ready: "Готово", "Set up": "" }));
    await writeFile(path.join(dir, "de.json"), "{}\n");
    await writeFile(path.join(dir, "ja.json"), JSON.stringify({ Ready: "</script><script>alert(1)</script>" }));
    assert.deepEqual(await readPanelLocales(dir), {
      ru: { Ready: "Готово" },
      ja: { Ready: "</script><script>alert(1)</script>" },
    });
    const html = await inlinePanelSdk("<body><!-- STUDIO_PANEL_SDK --></body>", undefined, dir);
    const pasted = /<script type="application\/json" id="studio-panel-locales">([^<]*)<\/script>/.exec(html);
    assert.ok(pasted, "the catalogs go in before the SDK");
    assert.deepEqual(JSON.parse(pasted[1] ?? ""), await readPanelLocales(dir));
    assert.ok(html.includes("api.ready = new Promise"), "and words.js with the bridge");
    const bare = await inlinePanelSdk("<!-- STUDIO_PANEL_SDK -->");
    assert.ok(!bare.includes('type="application/json"'), "no folder, no catalogs");
  });

  it("refuses a catalog that is not an object of strings, naming its file", async () => {
    const dir = await tmpDir("panel-words-");
    await writeFile(path.join(dir, "fr.json"), JSON.stringify({ Ready: 1 }));
    await assert.rejects(readPanelLocales(dir), /fr\.json/);
    await writeFile(path.join(dir, "fr.json"), "[]");
    await assert.rejects(readPanelLocales(dir), /fr\.json/);
  });

  it("writes the messages list and an empty catalog per language, keeping catalogs already there", async () => {
    const dir = await tmpDir("panel-words-");
    const page = path.join(dir, "panel.html");
    await writeFile(page, `<h2 data-t>Set up</h2><script>t("Ready")</script>`);
    const locales = path.join(dir, LOCALES_FOLDER);
    await mkdir(locales);
    await writeFile(path.join(locales, "ru.json"), '{"Ready":"Готово"}');
    assert.deepEqual(await writePanelMessages([page], locales), []);
    assert.deepEqual(JSON.parse(await readFile(path.join(locales, MESSAGES_FILE), "utf8")), ["Ready", "Set up"]);
    assert.equal(await readFile(path.join(locales, "ru.json"), "utf8"), '{"Ready":"Готово"}');
    assert.equal(await readFile(path.join(locales, "zh-Hans.json"), "utf8"), "{}\n");
  });

  it("speaks the languages the app speaks", () => {
    assert.deepEqual(
      PANEL_LOCALES,
      LOCALES.filter((locale) => locale !== Locale.English),
    );
  });

  it("is told the window's language in the panel's context", async () => {
    const style = { getPropertyValue: () => "" };
    assert.equal(panelContext(null, style).locale, Locale.English);
    setLocale(Locale.Russian, {});
    assert.equal(panelContext(null, style).locale, Locale.Russian);
    assert.equal(panelContext(null, style, PanelSurface.Card, Locale.Japanese).locale, Locale.Japanese);

    const posted: Array<{ result?: { locale?: string } }> = [];
    const frame = { postMessage: (message: never) => posted.push(message) };
    const bridge = openPanelBridge({
      frame: () => frame,
      plugin: () => ({ manifest: { id: "toy-engine", actions: [] } }) as unknown as PluginInfo,
      project: () => "valley",
      surface: () => PanelSurface.Page,
      style: () => style,
      review: () => {},
      onHead: () => {},
      onHeight: () => {},
    });
    await bridge.receive({
      source: frame,
      origin: "null",
      data: { type: PanelMessage.Request, id: "1", method: PanelMethod.Context },
    });
    assert.equal(posted[0]?.result?.locale, Locale.Russian, "the bridge answers context in the window's language");
  });
});

/** The bundled plugins that speak Genex's language, each with its `locales/` folder. */
const SPEAKING = ["blender", "genex", "godot", "roblox", "unity", "unreal"];

describe("the bundled panels' words", () => {
  for (const id of SPEAKING) {
    it(`${id}: messages.json lists what its panel and manifest ask for, and each catalog keeps to it`, async () => {
      const root = path.join("src/plugins", id);
      const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8")) as {
        panels: Array<{ file: string }>;
      };
      const asked = new Set<string>(manifestMessages(manifest));
      for (const { file } of manifest.panels) {
        const { messages, problems } = panelMessages(await readFile(path.join(root, file), "utf8"));
        assert.deepEqual(problems, [], `${file} reads`);
        for (const message of messages) asked.add(message);
      }
      const locales = path.join(root, LOCALES_FOLDER);
      const listed = JSON.parse(await readFile(path.join(locales, MESSAGES_FILE), "utf8")) as string[];
      const panels = manifest.panels.map(({ file }) => path.join(root, file)).join(" ");
      assert.deepEqual(listed, [...asked].sort(), `run: node src/plugin-sdk/panel-words.mjs ${panels}`);
      for (const english of listed) assert.doesNotThrow(() => messageArguments(english), english);
      for (const locale of PANEL_LOCALES) {
        const file = path.join(locales, `${locale}.json`);
        assert.ok(existsSync(file), `${file} exists`);
        const catalog = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
        for (const [english, said] of Object.entries(catalog)) {
          assert.ok(asked.has(english), `${file}: "${english}" is no longer asked for`);
          if (!said) continue;
          assert.deepEqual(
            [...messageArguments(said)].sort(),
            [...messageArguments(english)].sort(),
            `${file}: "${english}" keeps its placeholders`,
          );
        }
      }
    });
  }

  it("every bundled plugin with a locales folder is checked", async () => {
    const plugins = await readdir("src/plugins");
    const withLocales = plugins.filter((id) => existsSync(path.join("src/plugins", id, LOCALES_FOLDER))).sort();
    assert.deepEqual(withLocales, SPEAKING);
  });
});
