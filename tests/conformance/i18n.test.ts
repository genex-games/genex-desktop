/**
 * The app's words in other languages: picking a language from a computer's list, and filling in
 * a message — placeholders, each language's plural forms, choices and quoting — the way
 * translators write them.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  currentLocale,
  formatList,
  formatMessage,
  intlLocale,
  messageArguments,
  messageKey,
  MessageSyntaxError,
  parseMessage,
  setLocale,
  t,
  tc,
} from "../../src/shared/i18n.ts";
import {
  computerLanguages,
  isLanguageChoice,
  Locale,
  matchLocale,
  resolveLanguage,
  SYSTEM_LANGUAGE,
} from "../../src/shared/locale.ts";

const GAMES = "{count, plural, one {# game} other {# games}}";
const GAMES_RU = "{count, plural, one {# игра} few {# игры} many {# игр} other {# игры}}";

afterEach(() => setLocale(Locale.English, {}));

describe("choosing a language", () => {
  const cases: Array<[string[], Locale]> = [
    [["ru-RU", "en-US"], Locale.Russian],
    [["en-GB"], Locale.English],
    [["pt-PT"], Locale.PortugueseBrazil],
    [["pt-BR"], Locale.PortugueseBrazil],
    [["zh-CN"], Locale.ChineseSimplified],
    [["zh-Hans-CN"], Locale.ChineseSimplified],
    [["zh-TW", "ja-JP"], Locale.Japanese],
    [["zh-Hant-HK"], Locale.English],
    [["uk-UA", "de-DE"], Locale.German],
    [["ko_KR"], Locale.Korean],
    [["fr-CA"], Locale.French],
    [["es-419"], Locale.Spanish],
    [[], Locale.English],
    [[""], Locale.English],
  ];
  for (const [tags, expected] of cases) {
    it(`${tags.join(", ") || "no languages"} → ${expected}`, () => assert.equal(matchLocale(tags), expected));
  }

  // Each computer's own spelling of its language list, as Electron's getPreferredSystemLanguages()
  // hands it over: every language Genex speaks is found, and any other falls back to English.
  const computers: Array<[string, string[], Locale]> = [
    ["a Mac in Japanese", ["ja-JP", "en-JP"], Locale.Japanese],
    ["a Mac in English with its region set to Japan", ["en-JP", "ja-JP"], Locale.English],
    ["a Mac in Russian", ["ru-RU", "en-RU"], Locale.Russian],
    ["a Mac in Korean", ["ko-KR"], Locale.Korean],
    ["a Mac in Simplified Chinese", ["zh-Hans-CN", "en-CN"], Locale.ChineseSimplified],
    ["a Mac in Simplified Chinese in Hong Kong", ["zh-Hans-HK"], Locale.ChineseSimplified],
    ["a Mac in Traditional Chinese (Taiwan), then English", ["zh-Hant-TW", "en-TW"], Locale.English],
    ["a Mac in Traditional Chinese (Hong Kong), then Japanese", ["zh-Hant-HK", "ja-HK"], Locale.Japanese],
    ["a Mac in Brazilian Portuguese", ["pt-BR"], Locale.PortugueseBrazil],
    ["a Mac in European Portuguese", ["pt-PT"], Locale.PortugueseBrazil],
    ["a Mac in Mexican Spanish", ["es-MX", "en-MX"], Locale.Spanish],
    ["a Mac in Swiss German", ["de-CH"], Locale.German],
    ["a Mac in Canadian French", ["fr-CA", "en-CA"], Locale.French],
    ["a Mac in Ukrainian, then Russian", ["uk-UA", "ru-UA"], Locale.Russian],
    ["a Mac in Italian only", ["it-IT"], Locale.English],
    ["Windows in Japanese", ["ja"], Locale.Japanese],
    ["Windows in Simplified Chinese", ["zh-CN"], Locale.ChineseSimplified],
    ["Windows in Traditional Chinese", ["zh-TW"], Locale.English],
    ["Windows in Macau Chinese", ["zh-MO"], Locale.English],
    ["Windows in Korean, then English", ["ko", "en-US"], Locale.Korean],
    ["Linux in Japanese", ["ja_JP.UTF-8", "ja_JP", "ja.UTF-8", "ja", "C"], Locale.Japanese],
    ["Linux with only the codeset-bearing name", ["ja.UTF-8"], Locale.Japanese],
    [
      "Linux in Taiwanese Chinese: glibc's plain zh is that same locale",
      ["zh_TW.UTF-8", "zh_TW", "zh", "C"],
      Locale.English,
    ],
    ["Linux in Hong Kong Chinese, then Korean", ["zh_HK.UTF-8", "zh", "ko_KR.UTF-8"], Locale.Korean],
    ["Linux in Simplified Chinese", ["zh_CN.UTF-8"], Locale.ChineseSimplified],
    ["Linux in European Portuguese with a modifier", ["pt_PT@euro"], Locale.PortugueseBrazil],
    ["Linux in German, euro modifier", ["de_DE.UTF-8@euro"], Locale.German],
    ["Linux with the C locale first", ["C", "POSIX", "fr_FR.UTF-8"], Locale.French],
    ["Linux with the C locale only", ["C.UTF-8", "C"], Locale.English],
  ];
  for (const [computer, tags, expected] of computers) {
    it(`${computer} → ${expected}`, () => assert.equal(matchLocale(tags), expected));
  }

  it("reads the computer's list in order, Chromium's locale only when the list is empty, a pinned --lang first", () => {
    const mac = { pinned: "", preferred: ["ja-JP", "en-US"], locale: "en-US", systemLocale: "en-US" };
    assert.deepEqual(computerLanguages(mac), ["ja-JP", "en-US"]);
    assert.deepEqual(computerLanguages({ ...mac, preferred: [] }), ["en-US", "en-US"]);
    assert.deepEqual(computerLanguages({ ...mac, preferred: [], locale: "", systemLocale: "ko-KR" }), ["ko-KR"]);
    assert.deepEqual(computerLanguages({ ...mac, pinned: "ru" }), ["ru"]);
    assert.equal(matchLocale(computerLanguages({ ...mac, preferred: [], locale: "ja" })), Locale.Japanese);
  });

  it("a set language wins over the computer's, and System or anything unknown follows the computer", () => {
    assert.equal(resolveLanguage(Locale.Japanese, ["ru-RU"]), Locale.Japanese);
    assert.equal(resolveLanguage(SYSTEM_LANGUAGE, ["ru-RU"]), Locale.Russian);
    assert.equal(resolveLanguage("klingon", ["de"]), Locale.German);
    assert.equal(resolveLanguage(undefined, []), Locale.English);
    assert.equal(isLanguageChoice("pt-BR"), true);
    assert.equal(isLanguageChoice("pt"), false);
  });
});

describe("t", () => {
  it("shows the English when a translation cannot be read, never an error", () => {
    setLocale(Locale.Russian, { "Played {days} days ago": "Сыграно {days, plural, one {# день" });
    assert.equal(t("Played {days} days ago", { days: 3 }), "Played 3 days ago");
  });

  it("writes a plural's count the way the language writes numbers, English as it was", () => {
    setLocale(Locale.Russian, { [GAMES]: GAMES_RU });
    assert.equal(t(GAMES, { count: 1200 }), "1\u00a0200 игр");
    setLocale(Locale.English, {});
    assert.equal(t(GAMES, { count: 1200 }), "1200 games");
  });

  it("is the English itself until a language is set, and falls back to it for a missing translation", () => {
    assert.equal(t("Publish"), "Publish");
    setLocale(Locale.Russian, { Publish: "Опубликовать" });
    assert.equal(currentLocale(), Locale.Russian);
    assert.equal(t("Publish"), "Опубликовать");
    assert.equal(t("Keep building"), "Keep building");
    assert.equal(t("Played {days} days ago", { days: 3 }), "Played 3 days ago");
  });

  it("fills placeholders in the translation", () => {
    setLocale(Locale.German, { "Publish {name}": "{name} veröffentlichen" });
    assert.equal(t("Publish {name}", { name: "Midnight Apex" }), "Midnight Apex veröffentlichen");
  });

  it("uses each language's plural forms", () => {
    assert.equal(t(GAMES, { count: 1 }), "1 game");
    assert.equal(t(GAMES, { count: 5 }), "5 games");
    setLocale(Locale.Russian, { [GAMES]: GAMES_RU });
    const russian = [1, 2, 5, 11, 21, 22, 25, 1.5].map((count) => t(GAMES, { count }));
    assert.deepEqual(russian, ["1 игра", "2 игры", "5 игр", "11 игр", "21 игра", "22 игры", "25 игр", "1,5 игры"]);
    setLocale(Locale.Japanese, { [GAMES]: "{count, plural, other {#本のゲーム}}" });
    assert.equal(t(GAMES, { count: 1 }), "1本のゲーム");
  });

  it("tells the same English apart by its context", () => {
    setLocale(Locale.German, { Play: "Spielen", [messageKey("tab", "Play")]: "Spiel" });
    assert.equal(t("Play"), "Spielen");
    assert.equal(tc("tab", "Play"), "Spiel");
    assert.equal(tc("button", "Play"), "Play");
  });

  it("an empty translation counts as missing", () => {
    setLocale(Locale.French, { Publish: "" });
    assert.equal(t("Publish"), "Publish");
  });
});

describe("message syntax", () => {
  it("exact numbers win over plural categories", () => {
    const zero = "{n, plural, =0 {Nothing yet} one {# file} other {# files}}";
    assert.equal(formatMessage(zero, { n: 0 }, Locale.English), "Nothing yet");
    assert.equal(formatMessage(zero, { n: 1 }, Locale.English), "1 file");
  });

  it("select picks a branch by value, other otherwise", () => {
    const pattern = "{who, select, you {You} other {{who}}} played";
    assert.equal(formatMessage(pattern, { who: "you" }, Locale.English), "You played");
    assert.equal(formatMessage(pattern, { who: "Rab" }, Locale.English), "Rab played");
  });

  it("apostrophes stay apostrophes unless they quote syntax", () => {
    assert.equal(formatMessage("Couldn't play {name}", { name: "it" }, Locale.English), "Couldn't play it");
    assert.equal(
      formatMessage("Write '{name}' to insert it", { name: "x" }, Locale.English),
      "Write {name} to insert it",
    );
    assert.equal(formatMessage("It''s {n}", { n: 2 }, Locale.English), "It's 2");
    assert.equal(formatMessage("{n, plural, other {#'#' {n}}}", { n: 3 }, Locale.English), "3# 3");
  });

  it("a missing value shows its placeholder rather than a blank", () => {
    assert.equal(formatMessage("Hello {name}", {}, Locale.English), "Hello {name}");
  });

  it("formats {n, number} in the language", () => {
    assert.equal(formatMessage("{n, number} tokens", { n: 1234567 }, Locale.Russian), "1\u00a0234\u00a0567 tokens");
  });

  it("refuses broken messages with a syntax error", () => {
    for (const broken of [
      "{count, plural, one {# game}}",
      "{count",
      "{, plural}",
      "text }",
      "{n, ordinal, other {x}}",
    ]) {
      assert.throws(() => parseMessage(broken), MessageSyntaxError, broken);
    }
  });

  it("lists the placeholders a message reads, inside plural branches too", () => {
    assert.deepEqual([...messageArguments("{n, plural, one {# by {who}} other {# by {who} in {place}}}")].sort(), [
      "n",
      "place",
      "who",
    ]);
  });
});

describe("lists and formats", () => {
  it("English keeps the app's own list; other languages use their own", () => {
    assert.equal(formatList(["a"]), "a");
    assert.equal(formatList(["a", "b", "c"]), "a, b and c");
    setLocale(Locale.Russian, {});
    assert.equal(formatList(["a", "b", "c"]), "a, b и c");
  });

  it("dates follow the computer in English and the app's language otherwise", () => {
    assert.equal(intlLocale(), undefined);
    setLocale(Locale.Japanese, {});
    assert.equal(intlLocale(), "ja");
  });
});
