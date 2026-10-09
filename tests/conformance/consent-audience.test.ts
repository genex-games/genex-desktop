import assert from "node:assert/strict";
import { it } from "node:test";
import { coreLite } from "../helpers/core-lite.ts";
import { consentAudience } from "../../src/main/core/consent-audience.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";

it("routes a worker approval to its run, never to another chat of the same game", async () => {
  const { core } = await coreLite();
  const parent = await core.store.createThread({ metadata: { project: "chess" } });
  const other = await core.store.createThread({ metadata: { project: "chess" } });
  const child = await core.store.createThread();
  await core.append([customEventData(CustomEvent.RunStarted, { runId: "run-a", project: "chess" })], parent);
  await core.append([customEventData(CustomEvent.RunStarted, { runId: "run-b", project: "chess" })], other);
  const binding = { project: "chess", directory: "/unused", threadId: child };
  assert.equal(await consentAudience(core, binding, "run-a"), parent);
  assert.equal(await consentAudience(core, binding, "run-b"), other);
  assert.equal(await consentAudience(core, binding), child);
  assert.equal(await consentAudience(core, binding, "unknown"), child);
  assert.equal(await consentAudience(core, { ...binding, project: "wrong" }, "run-a"), child);
  await core.append([customEventData(CustomEvent.RunStarted, { runId: "run-a", project: "chess" })], other);
  assert.equal(await consentAudience(core, binding, "run-a"), child, "ambiguous ownership is never guessed");
});

it("records one actionable parent card and resolves the original worker exactly once", async () => {
  const { PluginToolService } = await import("../../src/main/core/plugin-tools.ts");
  const { PluginConsent } = await import("../../src/main/plugin-consent.ts");
  const { UiEvent } = await import("../../src/shared/ui-events.ts");
  const { customEvent } = await import("../../src/shared/custom-events.ts");
  const consent = new PluginConsent({ timeoutMs: 1000 });
  let announce: (id: string) => void = () => {};
  const announced = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const { core } = await coreLite({
    onUiEvent: (event) => {
      if (event.type === UiEvent.PluginConsent && event.payload.state === "pending") announce(event.payload.consentId);
    },
  });
  const parent = await core.store.createThread({ metadata: { project: "chess" } });
  const child = await core.store.createThread();
  await core.append([customEventData(CustomEvent.RunStarted, { runId: "run-c", project: "chess" })], parent);
  const attribution = new WeakMap();
  const service = new PluginToolService(core, {
    consent,
    pluginCallAttribution: attribution,
    mcpSecrets: null,
    activeConnectorCalls: new Map(),
    cutOffCalls: new Map(),
    planning: async () => false,
    bypassing: async () => false,
  });
  const binding = { project: "chess", directory: "/unused", threadId: child };
  attribution.set(binding, { runId: "run-c", facetId: "online" });
  const response = service.requestConsent(
    "example",
    {
      name: "package",
      description: "Install SDK",
      parameters: { type: "object", properties: {} },
      confirmation: "Install SDK?",
    },
    {},
    binding,
  );
  const id = await announced;
  const cards = (await core.store.chatState(parent)).flatMap((event) => {
    const payload = customEvent(event, CustomEvent.PluginConsent);
    return payload ? [payload] : [];
  });
  try {
    assert.equal(cards.length, 1, "worker approval must appear in the main conversation state projection");
    assert.equal(cards[0]?.originThreadId, child);
    assert.equal(consent.resolve(id, true), true);
    assert.deepEqual(await response, { approved: true, by: "user" });
    assert.equal(consent.resolve(id, true), false);
    assert.equal(
      (await core.store.listEvents(child)).some((event) => customEvent(event, CustomEvent.PluginConsent)),
      false,
    );
  } finally {
    consent.cancel({}, "stop");
    await response;
  }
});

it("a denied prerequisite stays blocked across worker retries until an explicit run resume", async () => {
  const { priorConsentDecline } = await import("../../src/main/core/consent-audience.ts");
  const { core } = await coreLite();
  const parent = await core.store.createThread({ metadata: { project: "chess" } });
  const args = { package: "multiplayer", version: "pinned" };
  await core.append(
    [
      customEventData(CustomEvent.PluginConsent, {
        consentId: "declined",
        pluginId: "genex",
        pluginName: "Genex",
        tool: "genex__package",
        project: "chess",
        prompt: "Install?",
        args,
        state: "declined",
        by: "user",
        runId: "run-d",
      }),
    ],
    parent,
  );
  assert.deepEqual(await priorConsentDecline(core, parent, "run-d", "genex__package", args), {
    approved: false,
    by: "user",
  });
  assert.equal(await priorConsentDecline(core, parent, "other-run", "genex__package", args), null);
  assert.equal(await priorConsentDecline(core, parent, "run-d", "genex__package", { package: "different" }), null);
  await core.append([customEventData(CustomEvent.AutopilotResumed, { runId: "run-d" })], parent);
  assert.equal(await priorConsentDecline(core, parent, "run-d", "genex__package", args), null);
});

it("a chat's declined tool call is not asked again until the user speaks", async () => {
  const { priorConsentDecline } = await import("../../src/main/core/consent-audience.ts");
  const { core } = await coreLite();
  const chat = await core.store.createThread({ metadata: { project: "chess" } });
  const args = { prompt: "a marble rook" };
  const consent = (state: "declined" | "approved") =>
    customEventData(CustomEvent.PluginConsent, {
      consentId: `c-${state}`,
      pluginId: "genex",
      pluginName: "Genex",
      tool: "genex__asset",
      project: "chess",
      prompt: "Generate a paid asset?",
      args,
      state,
      by: "user",
    });
  await core.append(
    [{ type: "messages", messages: [{ role: "user", content: "make a rook" }] }, consent("declined")],
    chat,
  );
  assert.deepEqual(
    await priorConsentDecline(core, chat, undefined, "genex__asset", args),
    { approved: false, by: "user" },
    "the model asking again in the same turn gets the user's no, not another card",
  );
  assert.equal(await priorConsentDecline(core, chat, undefined, "genex__asset", { prompt: "a wooden rook" }), null);
  await core.append([{ type: "messages", messages: [{ role: "user", content: "ok, go ahead" }] }], chat);
  assert.equal(
    await priorConsentDecline(core, chat, undefined, "genex__asset", args),
    null,
    "a new message may ask again",
  );
});

for (const answer of ["stop", "decline", "timeout"] as const) {
  it(`parent approval projection settles after ${answer}, including off-page questions`, async (t) => {
    const { PluginToolService } = await import("../../src/main/core/plugin-tools.ts");
    const { PluginConsent } = await import("../../src/main/plugin-consent.ts");
    const { UiEvent } = await import("../../src/shared/ui-events.ts");
    const { customEvent } = await import("../../src/shared/custom-events.ts");
    const consent = new PluginConsent({ timeoutMs: 1000 });
    let announce: (id: string) => void = () => {};
    const announced = new Promise<string>((resolve) => {
      announce = resolve;
    });
    const { core } = await coreLite({
      onUiEvent: (event) => {
        if (event.type === UiEvent.PluginConsent && event.payload.state === "pending")
          announce(event.payload.consentId);
      },
    });
    const parent = await core.store.createThread({ metadata: { project: "chess" } });
    const child = await core.store.createThread();
    await core.append([customEventData(CustomEvent.RunStarted, { runId: "run-settle", project: "chess" })], parent);
    const binding = { project: "chess", directory: "/unused", threadId: child };
    const attribution = new WeakMap([[binding, { runId: "run-settle", facetId: "online" }]]);
    const service = new PluginToolService(core, {
      consent,
      pluginCallAttribution: attribution,
      mcpSecrets: null,
      activeConnectorCalls: new Map(),
      cutOffCalls: new Map(),
      planning: async () => false,
      bypassing: async () => false,
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = service.requestConsent(
      "genex",
      { name: "package", description: "SDK", parameters: { type: "object", properties: {} }, confirmation: "Install?" },
      {},
      binding,
    );
    const id = await announced;
    for (let i = 0; i < 90; i++)
      await core.append(
        [customEventData(CustomEvent.AutopilotDecision, { runId: "run-settle", text: `Progress ${i}` })],
        parent,
      );
    const before = await core.store.chatPage(parent);
    assert.ok(before.context.some((event) => customEvent(event, CustomEvent.PluginConsent)?.consentId === id));
    if (answer === "stop") consent.cancel({ project: "chess" }, "stop");
    if (answer === "decline") consent.resolve(id, false);
    if (answer === "timeout") t.mock.timers.tick(1000);
    const result = await pending;
    assert.equal(result.approved, false);
    const expectedBy = answer === "decline" ? "user" : answer;
    assert.equal(result.by, expectedBy);
    const questions = (await core.store.chatState(parent)).flatMap((event) => {
      const question = customEvent(event, CustomEvent.PluginConsent);
      return question?.consentId === id ? [question] : [];
    });
    assert.equal(questions.length, 0, "settled questions leave the pending projection");
    const history = (await core.store.listEvents(parent)).flatMap((event) => {
      const question = customEvent(event, CustomEvent.PluginConsent);
      return question?.consentId === id ? [question] : [];
    });
    assert.equal(history.length, 2, "one request and one durable answer");
    assert.equal(history.at(-1)?.state, "declined");
    assert.equal(history.at(-1)?.by, expectedBy);
    assert.equal(consent.resolve(id, true), false);
  });
}
