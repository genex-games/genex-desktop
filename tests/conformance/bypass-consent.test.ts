/**
 * A consent card in a chat the person switched to Bypass: an agent's call of a plugin tool that asks
 * first (`confirmation`), and its computer control, which asks through the same cards, go on with
 * no card, logged as approved by the mode. A card asked for the person's own act (a press, `afresh`)
 * still asks, and a card that waited while the chat was in another mode is answered by the switch.
 * Real core.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { PluginConsentEvent } from "../../src/shared/plugins.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

/** How long a card nobody answers waits here, and how often a test looks for one. */
const CONSENT_TIMEOUT_MS = 20_000;
const LOOK_STEP_MS = 20;
const LOOK_TRIES = 250;

const TOOL = {
  name: "upload-image",
  description: "Upload pictures",
  parameters: { type: "object" as const, properties: {} },
  confirmation: "Upload pictures to your Roblox account?",
};

describe("Bypass answers an agent's consent cards", () => {
  let lite: CoreLite;
  let threadId = "";
  const project = "bypass";

  before(async () => {
    lite = await coreLite({ consentTimeoutMs: CONSENT_TIMEOUT_MS });
    await lite.core.games.scaffold(project);
    threadId = await lite.core.createGameThread(project);
  });

  after(async () => {
    await lite.close();
  });

  const binding = () => ({ project, directory: lite.core.games.dirFor(project), threadId });
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

  it("Bypass runs the call with no waiting card and logs it approved by the mode", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    const answer = await lite.core.requestConsent("roblox", TOOL, { images: "[]" }, binding());
    assert.deepEqual(answer, { approved: true, by: "mode" });
    const logged = (await cards()).filter((card) => card.tool === "roblox__upload-image");
    assert.deepEqual(
      logged.map((card) => [card.state, card.by]),
      [["approved", "mode"]],
      "one row, already answered: nothing waited on the person",
    );
  });

  it("Manual asks", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Manual);
    const known = new Set((await cards()).map((card) => card.consentId));
    const asking = lite.core.requestConsent("roblox", TOOL, { images: "[1]" }, binding());
    const card = await waitingCard(known);
    assert.equal(lite.core.resolveConsent(card.consentId, false), true);
    assert.deepEqual(await asking, { approved: false, by: "user" });
  });

  it("the person's switch to Bypass answers a card that waited", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Manual);
    const known = new Set((await cards()).map((card) => card.consentId));
    const asking = lite.core.requestConsent("roblox", TOOL, { images: "[2]" }, binding());
    await waitingCard(known);
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    assert.deepEqual(await asking, { approved: true, by: "mode" });
  });

  it("a card for the person's own press still asks in Bypass", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    const known = new Set((await cards()).map((card) => card.consentId));
    const asking = lite.core.requestConsent("roblox", TOOL, { images: "[3]" }, binding(), undefined, undefined, {
      afresh: true,
    });
    const card = await waitingCard(known);
    assert.equal(lite.core.resolveConsent(card.consentId, true), true);
    assert.deepEqual(await asking, { approved: true, by: "user" });
  });
});
