/**
 * A plugin consent card that times out with nobody answering is not a no: the person may simply be
 * away. The agent reads that it may carry on and ask again later, and the settled card says nobody
 * answered rather than that the request was declined.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONSENT_DECLINED_MESSAGES, CONSENT_TIMEOUT_MS } from "../../src/main/core/plugin-tools.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { consentOutcomeWords } from "../../src/renderer/words.ts";
import { priorConsentDecline } from "../../src/main/core/consent-audience.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { PluginConsentBy } from "../../src/shared/plugins.ts";
import { coreLite } from "../helpers/core-lite.ts";

const ARGS = { package: "multiplayer" };

/** A settled card for the package install, in a run or (without `runId`) in the chat itself. */
function settledCard(by: PluginConsentBy, runId?: string) {
  return customEventData(CustomEvent.PluginConsent, {
    consentId: `c-${by}-${runId ?? "chat"}`,
    pluginId: "genex",
    pluginName: "Genex",
    tool: "genex__package",
    project: "chess",
    prompt: "Install?",
    args: ARGS,
    state: "declined",
    by,
    ...(runId ? { runId } : {}),
  });
}

describe("A consent nobody answered", () => {
  it("tells the agent the person may be away, not that they said no", () => {
    const heard = CONSENT_DECLINED_MESSAGES.timeout;
    assert.match(heard, new RegExp(`Nobody answered within ${CONSENT_TIMEOUT_MS / MINUTE_MS} minutes`));
    assert.match(heard, /may be away/);
    assert.match(heard, /not a no/);
    assert.match(heard, /carry on with other work and ask again later/);
    assert.doesNotMatch(heard, /declined/i);
  });

  it("is still a decline when the person said no", () => {
    assert.match(CONSENT_DECLINED_MESSAGES.user, /declined/);
  });

  it("settles its card as nobody answered, never as declined", () => {
    assert.equal(consentOutcomeWords({ state: "declined", by: "timeout" }), "Nobody answered");
    assert.equal(consentOutcomeWords({ state: "declined", by: "user" }), "Declined");
  });

  it("lets the agent ask again in the same run and the same chat turn", async () => {
    const { core } = await coreLite();
    const chat = await core.store.createThread({ metadata: { project: "chess" } });
    await core.append([settledCard("timeout", "run-t"), settledCard("timeout")], chat);
    assert.equal(await priorConsentDecline(core, chat, "run-t", "genex__package", ARGS), null, "a run's re-ask");
    assert.equal(await priorConsentDecline(core, chat, undefined, "genex__package", ARGS), null, "a chat's re-ask");
  });

  it("does not lift the person's real no", async () => {
    const { core } = await coreLite();
    const chat = await core.store.createThread({ metadata: { project: "chess" } });
    await core.append([settledCard("user", "run-u"), settledCard("user")], chat);
    const no = { approved: false, by: "user" };
    assert.deepEqual(await priorConsentDecline(core, chat, "run-u", "genex__package", ARGS), no);
    assert.deepEqual(await priorConsentDecline(core, chat, undefined, "genex__package", ARGS), no);
  });
});
