/**
 * A confirmed plugin tool that acts on the person's account with another service (`onAccount`, API 3:
 * an upload Roblox moderates, a generation that counts against its limits) keeps its card in Bypass,
 * since what goes wrong lands on that account, and offers Allow in this chat: one yes covers that
 * tool for the rest of the chat, read back from the chat's own log, and a new chat asks again. The
 * manifest's rules, the card's choices and words, and the path through a real core.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ConsentChoice, consentChoices } from "../../src/renderer/chat/consent-card.ts";
import { consentOutcomeWords } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { PluginConsentEvent } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { TOY_PLUGIN } from "../helpers/project-fixtures.ts";

/** How long a card nobody answers waits here, and how often a test looks for one. */
const CONSENT_TIMEOUT_MS = 20_000;
const LOOK_STEP_MS = 20;
const LOOK_TRIES = 250;

/** A toy tool that uploads to the person's account on another service. */
const UPLOAD = {
  name: "upload-art",
  description: "Upload art to the person's account.",
  parameters: { type: "object" as const, properties: {} },
  confirmation: "Upload this art to your account? The service moderates it.",
  onAccount: true as const,
};

const EXAMPLE_MANIFEST = path.resolve(import.meta.dirname, "../../src/plugins/example/plugin.json");

/** The toy's manifest with `tool` added; at API 2, the SDK example's, which uses nothing newer. */
async function toyWith(tool: Record<string, unknown>, apiVersion = 3) {
  const source = apiVersion === 3 ? path.join(TOY_PLUGIN, "plugin.json") : EXAMPLE_MANIFEST;
  const manifest = JSON.parse(await readFile(source, "utf8"));
  return { ...manifest, apiVersion, tools: [...manifest.tools, tool] };
}

describe("the manifest's onAccount", () => {
  it("is kept on an API 3 tool with a card", async () => {
    const tool = validateManifest(await toyWith(UPLOAD)).tools.find((entry) => entry.name === UPLOAD.name);
    assert.equal(tool?.onAccount, true);
  });

  const refused: Array<[string, Record<string, unknown>, number]> = [
    ["without a card", { ...UPLOAD, confirmation: undefined }, 3],
    ["before API 3", UPLOAD, 2],
    ["as anything but true", { ...UPLOAD, onAccount: "yes" }, 3],
  ];
  for (const [what, tool, apiVersion] of refused)
    it(`is refused ${what}`, async () => {
      const manifest = await toyWith(tool, apiVersion);
      assert.throws(() => validateManifest(manifest), /onAccount|confirmation|apiVersion/);
    });
});

describe("an onAccount card", () => {
  it("offers Allow in this chat beside Allow once, and says so once answered", () => {
    const choices = consentChoices({ consentPrompt: UPLOAD.confirmation, consentChatOffered: true });
    assert.deepEqual(
      choices.map((choice) => [choice.id, choice.label]),
      [
        [ConsentChoice.Once, "Allow once"],
        [ConsentChoice.Always, "Allow in this chat"],
        [ConsentChoice.Decline, "Don't allow"],
      ],
    );
    assert.equal(consentOutcomeWords({ state: "approved", always: true, chatOffered: true }), "Allowed in this chat");
    assert.equal(consentOutcomeWords({ state: "approved", by: "chat" }), "Allowed in this chat");
    assert.equal(consentOutcomeWords({ state: "approved", by: "mode" }), "Allowed in Bypass");
  });
});

describe("an onAccount tool through a real core", () => {
  let lite: CoreLite;
  const project = "on-account";

  before(async () => {
    lite = await coreLite({ consentTimeoutMs: CONSENT_TIMEOUT_MS });
    await lite.core.games.scaffold(project);
  });

  after(async () => {
    await lite.close();
  });

  const binding = (threadId: string, game = project) => ({
    project: game,
    directory: lite.core.games.dirFor(game),
    threadId,
  });
  const cards = async (): Promise<PluginConsentEvent[]> =>
    (await lite.core.listAllEvents()).flatMap((event) =>
      event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginConsent
        ? [event.data.payload as PluginConsentEvent]
        : [],
    );
  /** The card a call left waiting, once it shows. */
  async function waitingCard(known: Set<string>): Promise<PluginConsentEvent> {
    for (let tries = 0; tries < LOOK_TRIES; tries++) {
      const card = (await cards()).find((c) => c.state === "pending" && !known.has(c.consentId));
      if (card) return card;
      await sleep(LOOK_STEP_MS);
    }
    assert.fail("no card waits");
  }
  /** Asks, answers the card it shows as `answer` says, and returns the answer the call got. */
  async function asked(threadId: string, answer: { approved: boolean; always?: boolean }, game = project) {
    const known = new Set((await cards()).map((card) => card.consentId));
    const asking = lite.core.requestConsent("toy", UPLOAD, {}, binding(threadId, game));
    const card = await waitingCard(known);
    assert.equal(card.chatOffered, true, "the card offers Allow in this chat");
    assert.equal(lite.core.resolveConsent(card.consentId, answer.approved, answer.always === true), true);
    return asking;
  }

  it("asks in Bypass; Allow in this chat covers the tool's later calls in that chat only", async () => {
    const chat = await lite.core.createGameThread(project);
    await lite.core.setPermissionMode(chat, PermissionMode.Bypass);
    assert.deepEqual(await asked(chat, { approved: true }), { approved: true, by: "user" });
    assert.deepEqual(await asked(chat, { approved: true, always: true }), { approved: true, by: "user", always: true });
    const before = (await cards()).length;
    assert.deepEqual(await lite.core.requestConsent("toy", UPLOAD, {}, binding(chat)), { approved: true, by: "chat" });
    const after = (await cards()).slice(before);
    assert.deepEqual(
      after.map((card) => [card.state, card.by]),
      [["approved", "chat"]],
      "logged, already answered: nothing waited on the person",
    );
    // Another game's chat: a game with an empty chat hands that one out again.
    await lite.core.games.scaffold(`${project}-2`);
    const other = await lite.core.createGameThread(`${project}-2`);
    assert.deepEqual(
      await asked(other, { approved: false }, `${project}-2`),
      { approved: false, by: "user" },
      "a new chat asks",
    );
  });
});
