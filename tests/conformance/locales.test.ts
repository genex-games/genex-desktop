/**
 * Every language's catalog against the messages the app asks for (`messages.ts`, written by
 * `npm run i18n:extract`): nothing missing, nothing stale, every translation readable, with the
 * placeholders its English has — a translation that drops `{name}` would show a sentence without
 * the name, one that invents `{who}` would show the braces.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageArguments, type MessageNode, parseMessage } from "../../src/shared/i18n.ts";
import { Locale, LOCALES } from "../../src/shared/locale.ts";
import { loadCatalog } from "../../src/shared/locales/index.ts";
import { MESSAGES } from "../../src/shared/locales/messages.ts";

/** The English of a catalog key (a context, U+0004, then the English, or the English alone). */
function englishOf(key: string): string {
  return key.slice(key.indexOf("\u0004") + 1);
}

/** Forms only millions take ("1 millón de juegos"); counts in the app never reach them, and other reads right. */
const MILLIONS_ONLY: Partial<Record<Locale, string>> = {
  [Locale.Spanish]: "many",
  [Locale.French]: "many",
  [Locale.PortugueseBrazil]: "many",
};

/** Plurals in a message that lack a form the language has: Russian needs one, few and many beside other. */
function missingPluralForms(message: string, locale: Locale): string[] {
  const needed = new Intl.PluralRules(locale)
    .resolvedOptions()
    .pluralCategories.filter((form) => form !== MILLIONS_ONLY[locale]);
  const gaps: string[] = [];
  const walk = (nodes: readonly MessageNode[]): void => {
    for (const node of nodes) {
      if (typeof node === "string" || node.kind === "pound" || node.kind === "arg" || node.kind === "number") continue;
      if (node.kind === "plural")
        for (const form of needed) if (!node.cases.has(form)) gaps.push(`{${node.name}} lacks "${form}"`);
      for (const branch of node.cases.values()) walk(branch);
    }
  };
  walk(parseMessage(message));
  return gaps;
}

for (const locale of LOCALES.filter((locale) => locale !== Locale.English)) {
  describe(`the ${locale} catalog`, () => {
    it("translates every message the app asks for, and only those", async () => {
      const catalog = await loadCatalog(locale);
      const asked = new Set<string>(MESSAGES);
      const missing = MESSAGES.filter((key) => !catalog[key]);
      const stale = Object.keys(catalog).filter((key) => !asked.has(key));
      assert.deepEqual(stale, [], "keys the app no longer asks for");
      assert.deepEqual(missing.slice(0, 20), [], `${missing.length} messages without a translation`);
    });

    it("keeps each message's placeholders, reads as a message and gives every plural form", async () => {
      const catalog = await loadCatalog(locale);
      const broken: string[] = [];
      for (const [key, translation] of Object.entries(catalog)) {
        try {
          const expected = [...messageArguments(englishOf(key))].sort();
          const actual = [...messageArguments(translation)].sort();
          if (expected.join() !== actual.join()) broken.push(`${key}: {${expected}} → {${actual}}`);
          for (const gap of missingPluralForms(translation, locale)) broken.push(`${key}: ${gap}`);
        } catch (error) {
          broken.push(`${key}: ${(error as Error).message}`);
        }
      }
      assert.deepEqual(broken, []);
    });
  });
}
