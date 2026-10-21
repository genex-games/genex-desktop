/**
 * A bundled plugin's confirmed tool may have its backend word each call's card (`confirmationCard`,
 * API 3): the card asks the backend's one plain line for this call (Game mods names the game and the
 * files an install replaces), and the manifest's own question whenever the backend answers nothing
 * usable or the plugin isn't Studio's own. The manifest's rules, the words the host takes, and the
 * whole path through a real core.
 */
import assert from "node:assert/strict";
import { cp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { confirmationCardText, type PluginBinding, PluginSourceKind } from "../../src/shared/plugins.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The toy's tool whose card its backend words. */
const CARD_IT = {
  name: "card-it",
  description: "Do something to the toy game.",
  parameters: { type: "object", properties: { say: { type: "string", description: "What the card asks." } } },
  confirmation: "Do it to the game?",
  confirmationCard: true,
};

/** The toy's manifest with `tool` added, at `apiVersion`. */
async function toyWith(tool: Record<string, unknown>, apiVersion = 3) {
  const manifest = JSON.parse(await readFile(path.join(TOY_PLUGIN, "plugin.json"), "utf8"));
  return { ...manifest, apiVersion, tools: [...manifest.tools, tool] };
}

describe("the manifest's confirmationCard", () => {
  it("is kept on an API 3 tool with a card", async () => {
    const tool = validateManifest(await toyWith(CARD_IT)).tools.find((entry) => entry.name === "card-it");
    assert.equal(tool?.confirmationCard, true);
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ["without a card", { ...CARD_IT, confirmation: undefined }],
    ["as anything but true", { ...CARD_IT, confirmationCard: "yes" }],
  ];
  for (const [what, tool] of refused)
    it(`is refused ${what}`, async () => assert.throws(() => validateManifest(toyWithSync(tool)), /confirmationCard/));

  it("is refused before API 3", async () => {
    const manifest = { ...(await toyWith(CARD_IT)), apiVersion: 2 };
    assert.throws(() => validateManifest(manifest));
  });
});

/** The toy's manifest with `tool` added, read once for the refusal table. */
let toyManifest: Record<string, unknown> & { tools: unknown[] };
before(async () => {
  toyManifest = JSON.parse(await readFile(path.join(TOY_PLUGIN, "plugin.json"), "utf8"));
});
const toyWithSync = (tool: Record<string, unknown>) => ({
  ...toyManifest,
  apiVersion: 3,
  tools: [...toyManifest.tools, tool],
});

describe("a backend's words as the card takes them", () => {
  it("are one plain line of at most 300 characters, trimmed; anything else is no words", () => {
    assert.equal(confirmationCardText("  Put this mod into Factorio? "), "Put this mod into Factorio?");
    for (const bad of ["", "   ", "a\nb", "a‮b", "x".repeat(301), 42, null, undefined])
      assert.equal(confirmationCardText(bad), undefined, JSON.stringify(bad));
  });
});

describe("through a real core, with a copy of the toy", () => {
  let lite: CoreLite;
  let binding: PluginBinding;
  let threadId: string;

  before(async () => {
    lite = await coreLite({
      onUiEvent: (event: UiEventData) => {
        if (event.type !== UiEvent.PluginConsent) return;
        const payload = event.payload as { consentId: string; state: string };
        if (payload.state === "pending")
          void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, true, false));
      },
    });
    const { core } = lite;
    const dir = path.join(await realpath(await tmpDir("toy-card-")), "toy-engine-plugin");
    await cp(TOY_PLUGIN, dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(await toyWith(CARD_IT), null, 2));
    await core.plugins.installLocal(dir, PluginSourceKind.Bundled, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    const game = (await core.games.scaffold("garden")).dir;
    threadId = await core.threadForGame("garden");
    binding = { project: "garden", directory: game, threadId };
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  /** The question the newest card asked. */
  async function lastCard(): Promise<string | undefined> {
    const cards = toEntries(await lite.core.store.listEvents(threadId)).filter(
      (entry) => (entry as { consentId?: string }).consentId,
    ) as Array<{ prompt?: string; consentPrompt?: string }>;
    const card = cards.at(-1);
    return card?.prompt ?? card?.consentPrompt;
  }

  it("asks the backend's words for this call, and every call again", async () => {
    await lite.core.plugins.tool(`${TOY_PLUGIN_ID}__card-it`, { say: "Put this mod into Factorio?" }, binding);
    assert.equal(await lastCard(), "Put this mod into Factorio?");
    await lite.core.plugins.tool(`${TOY_PLUGIN_ID}__card-it`, { say: "Put this mod into Balatro?" }, binding);
    assert.equal(await lastCard(), "Put this mod into Balatro?", "no earlier yes answers a later call");
  });

  it("never lets a plugin that isn't Studio's own word its card: a local copy asks its manifest's question", async () => {
    const dir = path.join(await realpath(await tmpDir("toy-card-local-")), "toy-engine-plugin");
    await cp(TOY_PLUGIN, dir, { recursive: true });
    const toy = await toyWith(CARD_IT);
    const local = { ...toy, id: "cardtoy", name: "Card toy", engine: { ...toy.engine, id: "cardtoy" } };
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(local, null, 2));
    await lite.core.plugins.installLocal(dir, PluginSourceKind.Local, []);
    await lite.core.plugins.setEnabled("cardtoy", true);
    await lite.core.plugins.tool("cardtoy__card-it", { say: "Totally safe, nothing to see." }, binding);
    const asked = (await lastCard()) ?? "";
    assert.match(asked, /Do it to the game\?$/);
    assert.doesNotMatch(asked, /Totally safe/);
  });

  it("asks the manifest's question when the backend answers nothing usable", async () => {
    for (const args of [{}, { say: "two\nlines" }]) {
      await lite.core.plugins.tool(`${TOY_PLUGIN_ID}__card-it`, args, binding);
      assert.equal(await lastCard(), "Do it to the game?", JSON.stringify(args));
    }
  });
});
