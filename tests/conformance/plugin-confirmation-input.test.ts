/**
 * A confirmed plugin tool may name one of its text parameters the person can edit on its card
 * (`confirmationInput`, API 3): the card shows the agent's value in a field under its question, and
 * the person's Allow sends their edit as that parameter. The manifest's rules, the consent ledger,
 * the card's entry, and the whole path through a real core with a copy of the toy engine.
 */
import assert from "node:assert/strict";
import { cp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PluginConsent } from "../../src/main/plugin-consent.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { confirmationInputValue, type PluginBinding, PluginSourceKind } from "../../src/shared/plugins.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const EXAMPLE_MANIFEST = path.resolve(import.meta.dirname, "../../src/plugins/example/plugin.json");

/** The toy's tool whose card lets the person edit the name it was called with. */
const NAME_IT = {
  name: "name-it",
  description: "Name the toy game.",
  parameters: { type: "object", properties: { name: { type: "string", description: "The game's name." } } },
  confirmation: "Name the toy game as shown?",
  confirmationInput: { parameter: "name", label: "Game name" },
};

/** The toy's manifest with `tool` added; at API 2, the SDK example's, which uses nothing newer. */
async function toyWith(tool: Record<string, unknown>, apiVersion = 3) {
  const source = apiVersion === 3 ? path.join(TOY_PLUGIN, "plugin.json") : EXAMPLE_MANIFEST;
  const manifest = JSON.parse(await readFile(source, "utf8"));
  return { ...manifest, apiVersion, tools: [...manifest.tools, tool] };
}

describe("the manifest's confirmationInput", () => {
  it("is kept on an API 3 tool with a card, naming one of its text parameters, with a short label", async () => {
    const manifest = validateManifest(await toyWith(NAME_IT));
    const tool = manifest.tools.find((entry) => entry.name === "name-it");
    assert.deepEqual(tool?.confirmationInput, { parameter: "name", label: "Game name" });
  });

  const refused: Array<[string, Record<string, unknown>, number]> = [
    ["without a card", { ...NAME_IT, confirmation: undefined }, 3],
    ["before API 3", NAME_IT, 2],
    ["naming no parameter of the tool", { ...NAME_IT, confirmationInput: { parameter: "title", label: "x" } }, 3],
    [
      "naming a parameter that isn't text",
      {
        ...NAME_IT,
        parameters: { type: "object", properties: { name: { type: "number" } } },
      },
      3,
    ],
    ["with an empty label", { ...NAME_IT, confirmationInput: { parameter: "name", label: "" } }, 3],
    ["with a long label", { ...NAME_IT, confirmationInput: { parameter: "name", label: "x".repeat(61) } }, 3],
    ["with a label on two lines", { ...NAME_IT, confirmationInput: { parameter: "name", label: "a\nb" } }, 3],
    ["as text", { ...NAME_IT, confirmationInput: "name" }, 3],
  ];
  for (const [what, tool, apiVersion] of refused)
    it(`is refused ${what}`, async () => {
      const manifest = await toyWith(tool, apiVersion);
      assert.throws(() => validateManifest(manifest), /confirmationInput|confirmation/);
    });
});

describe("an edit as the card sends it", () => {
  it("is one plain line of at most 200 characters, trimmed; anything else is no edit", () => {
    assert.equal(confirmationInputValue("  Sky Racers "), "Sky Racers");
    for (const bad of ["", "   ", "a\nb", "a\u0007b", "x".repeat(201), 42, null, undefined])
      assert.equal(confirmationInputValue(bad), undefined, JSON.stringify(bad));
  });

  it("the ledger hands an approval's edit on, and drops it from a no", async () => {
    const consent = new PluginConsent({ timeoutMs: 60_000 });
    const asked = { consentId: "c1", pluginId: "toy", tool: "toy__name-it", project: "garden" };
    const yes = consent.request(asked);
    assert.equal(consent.resolve("c1", true, false, "Sky Racers"), true);
    assert.deepEqual(await yes, { approved: true, by: "user", input: "Sky Racers" });
    const no = consent.request({ ...asked, consentId: "c2" });
    consent.resolve("c2", false, false, "Sky Racers");
    assert.deepEqual(await no, { approved: false, by: "user" });
  });
});

describe("through a real core, with a copy of the toy that came with Genex", () => {
  let lite: CoreLite;
  let binding: PluginBinding;
  let threadId: string;
  /** What the next card's Allow sends as the edit; undefined sends none. */
  let edit: string | undefined;
  let approve = true;

  before(async () => {
    lite = await coreLite({
      onUiEvent: (event: UiEventData) => {
        if (event.type !== UiEvent.PluginConsent) return;
        const payload = event.payload as { consentId: string; state: string };
        if (payload.state !== "pending") return;
        const [yes, input] = [approve, edit];
        void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, yes, false, input));
      },
    });
    const { core } = lite;
    const dir = path.join(await realpath(await tmpDir("toy-input-")), "toy-engine-plugin");
    await cp(TOY_PLUGIN, dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(await toyWith(NAME_IT), null, 2));
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

  it("the card shows the agent's value in its field; Allow with an edit calls the tool with the edit", async () => {
    edit = "Sky Racers";
    const answer = (await lite.core.plugins.tool(`${TOY_PLUGIN_ID}__name-it`, { name: "Sky Race" }, binding)) as {
      name?: string;
    };
    assert.equal(answer.name, "Sky Racers");
    const cards = toEntries(await lite.core.store.listEvents(threadId)).filter(
      (entry) => (entry as { consentId?: string }).consentId,
    ) as Array<{ consentInput?: { label: string; value: string } }>;
    assert.deepEqual(cards.at(-1)?.consentInput, { label: "Game name", value: "Sky Race" });
  });

  it("Allow without an edit, or with one that isn't a plain line, keeps the agent's value", async () => {
    for (const input of [undefined, "a\nb"]) {
      edit = input;
      const answer = (await lite.core.plugins.tool(`${TOY_PLUGIN_ID}__name-it`, { name: "Sky Race" }, binding)) as {
        name?: string;
      };
      assert.equal(answer.name, "Sky Race", JSON.stringify(input));
    }
  });

  it("Don't allow runs nothing, whatever was typed", async () => {
    approve = false;
    edit = "Sky Racers";
    try {
      await assert.rejects(lite.core.plugins.tool(`${TOY_PLUGIN_ID}__name-it`, { name: "Sky Race" }, binding));
    } finally {
      approve = true;
    }
  });
});
