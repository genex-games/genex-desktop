/**
 * A plugin's backend runs in a process of its own with its own copy of the app's words: it speaks
 * the app's language because the host tells it before a call, and again after the language changes.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { PluginProcess } from "../../src/substrate/plugins/process.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BOOTSTRAP = path.resolve("src/plugin-sdk/backend.mjs");
const I18N = path.resolve("src/shared/i18n.ts");

/** A backend whose tool answers "Set up" through its own import of the app's words. */
async function wordsBackend(): Promise<string> {
  const root = await tmpDir("studio-plugin-language-");
  const entry = path.join(root, "backend.mjs");
  await writeFile(
    entry,
    [
      `import { t } from ${JSON.stringify(I18N)};`,
      'export const activate = () => ({ tool: () => ({ words: t("Set up {engine}", { engine: "Unity" }) }) });',
    ].join("\n"),
  );
  return entry;
}

describe("a plugin backend's language", () => {
  const backends: PluginProcess[] = [];
  after(() => {
    for (const backend of backends) backend.stop();
    setLocale(Locale.English, {});
  });

  it("follows the app's, before its first call and after a change", async () => {
    const backend = new PluginProcess(
      BOOTSTRAP,
      await wordsBackend(),
      async () => ({}),
      () => {},
    );
    backends.push(backend);
    setLocale(Locale.Russian, { "Set up {engine}": "Настроить {engine}" });
    assert.deepEqual(await backend.call("tool", "words", {}), { words: "Настроить Unity" });
    setLocale(Locale.German, { "Set up {engine}": "{engine} einrichten" });
    assert.deepEqual(await backend.call("tool", "words", {}), { words: "Unity einrichten" });
    setLocale(Locale.English, {});
    assert.deepEqual(await backend.call("tool", "words", {}), { words: "Set up Unity" });
  });
});
