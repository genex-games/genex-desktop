/**
 * The window's language choice: remembered on this computer, shared with main for its menus, and a
 * switch reloads the window (the app's words are read when it loads). Main missing the news still
 * switches the window.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  Locale,
  resolveLanguage,
  SYSTEM_LANGUAGE,
  systemLanguagesArgument,
  systemLanguagesFromArgs,
} from "../../src/shared/locale.ts";
import type { StudioSettingsView } from "../../src/shared/studio-api.ts";
import { languageChoice, shareLanguage, switchLanguage, windowLanguage } from "../../src/renderer/language.ts";

const holder = globalThis as { localStorage?: unknown; window?: unknown; navigator?: unknown };
let original: unknown;
let originalWindow: unknown;
let originalNavigator: PropertyDescriptor | undefined;

/** A page whose Chromium knows only `chromium` and whose preload carries `fromMain`. */
function page(chromium: string[], fromMain: string[] | null) {
  Object.defineProperty(globalThis, "navigator", { value: { languages: chromium }, configurable: true });
  holder.window = fromMain === null ? {} : { studio: { systemLanguages: () => fromMain } };
}

beforeEach(() => {
  original = holder.localStorage;
  originalWindow = holder.window;
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const values = new Map<string, string>();
  holder.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
});
afterEach(() => {
  holder.localStorage = original;
  holder.window = originalWindow;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete holder.navigator;
});

function fakeApi(saved: StudioSettingsView["language"] = SYSTEM_LANGUAGE, fail = false) {
  const sent: unknown[] = [];
  const view = { learning: true, selfImproving: false, language: saved } as StudioSettingsView;
  return {
    sent,
    settings: async () => view,
    setSettings: async (patch: { language?: StudioSettingsView["language"] }) => {
      if (fail) throw new Error("main is busy");
      sent.push(patch);
      return { ...view, ...patch };
    },
  };
}

describe("the window's language", () => {
  it("is System until one is chosen, and an unknown stored value reads as System", () => {
    assert.equal(languageChoice(), SYSTEM_LANGUAGE);
    (holder.localStorage as Storage).setItem("studio.language", "tlh");
    assert.equal(languageChoice(), SYSTEM_LANGUAGE);
    assert.equal(windowLanguage(Locale.Korean), Locale.Korean);
  });

  it("a switch remembers the choice, tells main and reloads", async () => {
    const api = fakeApi();
    let reloads = 0;
    await switchLanguage(api, Locale.Russian, () => reloads++);
    assert.equal(languageChoice(), Locale.Russian);
    assert.deepEqual(api.sent, [{ language: Locale.Russian }]);
    assert.equal(reloads, 1);
  });

  it("still switches the window when main cannot be told", async () => {
    let reloads = 0;
    await switchLanguage(fakeApi(SYSTEM_LANGUAGE, true), Locale.Japanese, () => reloads++);
    assert.equal(languageChoice(), Locale.Japanese);
    assert.equal(reloads, 1);
  });

  it("tells main only when it holds another choice", async () => {
    (holder.localStorage as Storage).setItem("studio.language", Locale.German);
    const behind = fakeApi(SYSTEM_LANGUAGE);
    await shareLanguage(behind);
    assert.deepEqual(behind.sent, [{ language: Locale.German }]);
    const same = fakeApi(Locale.German);
    await shareLanguage(same);
    assert.deepEqual(same.sent, []);
  });
});

describe("System in the window and in main's menus", () => {
  it("resolves to the same language: the window reads main's list, not Chromium's", () => {
    // A Mac set to Ukrainian, then Russian: Chromium's list holds only its own locale.
    const mac = ["uk-UA", "ru-RU"];
    page(["uk"], systemLanguagesFromArgs(["electron", systemLanguagesArgument(mac)]));
    const menus = resolveLanguage(SYSTEM_LANGUAGE, mac);
    assert.equal(menus, Locale.Russian);
    assert.equal(windowLanguage(SYSTEM_LANGUAGE), menus);
  });

  it("resolves to the same language for each computer's own spelling of its list", () => {
    const lists = [
      ["zh_HK.UTF-8", "zh", "ko_KR.UTF-8"],
      ["ja_JP.UTF-8", "ja_JP", "ja.UTF-8", "ja", "C"],
      ["C.UTF-8", "pt_PT@euro"],
      ["zh-Hant-TW", "en-TW"],
      ["de_DE.UTF-8@euro"],
      // glibc spells each of four languages four ways before the one Genex speaks.
      [
        ...["fi_FI", "sv_SE", "da_DK", "nb_NO"].flatMap((tag) => [
          `${tag}.UTF-8`,
          tag,
          `${tag.slice(0, 2)}.UTF-8`,
          tag.slice(0, 2),
        ]),
        "ja_JP.UTF-8",
      ],
    ];
    for (const list of lists) {
      page(["en-US"], systemLanguagesFromArgs([systemLanguagesArgument(list)]));
      assert.equal(windowLanguage(SYSTEM_LANGUAGE), resolveLanguage(SYSTEM_LANGUAGE, list), list.join(", "));
    }
  });

  it("falls back to Chromium's list in a page main gave none (a gallery, a test)", () => {
    page(["ja-JP"], null);
    assert.equal(windowLanguage(SYSTEM_LANGUAGE), Locale.Japanese);
    page(["ko-KR"], []);
    assert.equal(windowLanguage(SYSTEM_LANGUAGE), Locale.Korean);
  });

  it("carries only language tags across the page's arguments", () => {
    const rows: Array<[string, string[], string[]]> = [
      ["in order, as plain tags", ["pt-PT", "de-DE"], ["pt-pt", "de-de"]],
      ["a codeset and a modifier dropped", ["ja_JP.UTF-8", "pt_PT@euro"], ["ja-jp", "pt-pt"]],
      ["a separator inside a tag", ["ru,--inspect", "es"], ["es"]],
      ["a switch smuggled in as a tag", ["--remote-debugging-port=9222"], []],
      ["spaces and quotes", ['de "x"', "fr FR"], []],
      ["underscores as Linux writes them", ["zh_Hans_CN"], ["zh-hans-cn"]],
      ["nothing", [], []],
    ];
    for (const [name, tags, carried] of rows)
      assert.deepEqual(systemLanguagesFromArgs(["electron", systemLanguagesArgument(tags)]), carried, name);
    const many = Array.from({ length: 40 }, () => "en");
    assert.ok(systemLanguagesFromArgs([systemLanguagesArgument(many)]).length <= 16, "a long list is cut");
    assert.deepEqual(systemLanguagesFromArgs(["--genex-system-languages=ru,!!,ja"]), ["ru", "ja"], "a forged argument");
    assert.deepEqual(systemLanguagesFromArgs(["--lang=ru"]), [], "another switch");
  });
});
