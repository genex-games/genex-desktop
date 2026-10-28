/**
 * Computer control's yes lasts the chat, as its card says ("during this session"): the person
 * answers the session's card and each app's once, and the chat's next turns use the computer with no
 * further card. Their Stop, the stop shortcut or turning computer control off ends that yes, and the
 * next turn asks again. Real delegation over a fake driver.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { desktopControl } from "../../src/main/core/desktop-control.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import type { DesktopDriver } from "../../src/substrate/desktop-driver.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** A driver over one app in front that does nothing. */
function quietDriver(): DesktopDriver {
  return {
    screenshot: async () => ({
      image: Buffer.from("png"),
      mime: "image/png",
      width: 100,
      height: 100,
      screen: { width: 100, height: 100 },
    }),
    focus: async () => ({ app: { name: "Notes", bundleId: "com.apple.Notes", pid: 9 }, secure: false }),
    move: async () => {},
    click: async () => {},
    mouse: async () => {},
    drag: async () => {},
    scroll: async () => {},
    type: async () => {},
    press: async () => {},
    accessibility: async () => ({}),
    close: async () => {},
  };
}

it("one yes covers the chat's later turns; Stop, the shortcut and turning control off end it", async () => {
  const desktop = desktopControl({
    findDriver: async () => "/fake/cua-driver",
    connect: async () => quietDriver(),
    ownApp: () => false,
  });
  let asked = 0;
  let answer: (consentId: string) => void = () => {};
  const lite = await coreLite({
    desktop,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      const payload = event.payload as { consentId: string; state: string };
      if (payload.state !== "pending") return;
      asked += 1;
      answer(payload.consentId);
    },
  });
  try {
    const { core } = lite;
    answer = (consentId) => void Promise.resolve().then(() => core.resolveConsent(consentId, true));
    await core.updateSettings({ computerControl: true });
    const project = "desk-chat";
    await core.games.scaffold(project);
    const threadId = await core.createGameThread(project);
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        await request.onLiveTool!("desktop", { action: "screenshot" });
        await request.onLiveTool!("desktop", { action: "left_click", coordinate: "10,20" });
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const turn = (prompt: string) =>
      api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project, threadId, prompt });

    await turn("first");
    assert.equal(asked, 2, "the first turn asks for the session and for Notes");
    await turn("second");
    await turn("third");
    assert.equal(asked, 2, "the chat's later turns ask nothing more");

    await core.stopThread(threadId);
    await turn("after stop");
    assert.equal(asked, 4, "the person's Stop ends the yes: the next turn asks again");

    await desktop.stopAll();
    await turn("after the shortcut");
    assert.equal(asked, 6, "the stop shortcut ends it too");

    await core.updateSettings({ computerControl: false });
    await core.updateSettings({ computerControl: true });
    await turn("after off and on");
    assert.equal(asked, 8, "turning computer control off ends it");
  } finally {
    await lite.close();
  }
});
