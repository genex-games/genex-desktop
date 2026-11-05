/**
 * Computer control's yes lasts the chat, as its card says ("during this session"): the person
 * answers the session's card and each app's once, and the chat's next turns use the computer with no
 * further card. Their Stop, the stop shortcut or turning computer control off ends that yes, and the
 * next turn asks again. A chat in Auto or Bypass asks no card at all. Real delegation over a fake
 * driver.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { desktopControl } from "../../src/main/core/desktop-control.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
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
    // Manual asks: Auto and Bypass ask no computer-control card.
    await core.setPermissionMode(threadId, PermissionMode.Manual);
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

it("a chat in Auto or Bypass uses the computer with no card, never kept for a later Manual; Manual and Accept edits ask", async () => {
  const clicks: string[] = [];
  const desktop = desktopControl({
    findDriver: async () => "/fake/cua-driver",
    connect: async () => ({ ...quietDriver(), click: async (x, y) => void clicks.push(`${x},${y}`) }),
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
    assert.equal(core.settings.computerControl, true, "on by default");
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        await request.onLiveTool!("desktop", { action: "left_click", coordinate: "10,20" });
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const rows: Array<[PermissionMode | null, number]> = [
      [null, 0],
      [PermissionMode.Auto, 0],
      [PermissionMode.Bypass, 0],
      [PermissionMode.Manual, 2],
      [PermissionMode.AcceptEdits, 2],
    ];
    for (const [mode, cards] of rows) {
      // A game of its own per row: each chat's yes is its own.
      const project = `desk-${mode ?? "unchosen"}`.toLowerCase();
      await core.games.scaffold(project);
      const threadId = await core.createGameThread(project);
      if (mode) await core.setPermissionMode(threadId, mode);
      const before = { asked, clicks: clicks.length };
      await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project, threadId, prompt: "click" });
      const label = mode ?? "a chat that never chose (Auto)";
      assert.equal(asked - before.asked, cards, `${label}: cards asked`);
      assert.equal(clicks.length - before.clicks, 1, `${label}: the click went through`);
      if (mode !== PermissionMode.Auto && mode !== PermissionMode.Bypass) continue;
      // What Auto or Bypass let through was never the chat's yes: switched to Manual, it asks.
      await core.setPermissionMode(threadId, PermissionMode.Manual);
      const switched = asked;
      await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project, threadId, prompt: "click" });
      assert.equal(asked - switched, 2, `${label}, then Manual: the session and the app are asked`);
    }
  } finally {
    await lite.close();
  }
});

it("a session's card nobody answers expires as unanswered, never as a no: the model reads so and the next call asks again", async () => {
  // The owner's Unreal chat: the card waited nine minutes with nobody at the computer, and the model
  // read "the person did not allow computer control", so it told them control was off.
  const desktop = desktopControl({
    findDriver: async () => "/fake/cua-driver",
    connect: async () => quietDriver(),
    ownApp: () => false,
  });
  let asked = 0;
  const lite = await coreLite({
    desktop,
    consentTimeoutMs: 20,
    onUiEvent: (event: UiEventData) => {
      if (event.type !== UiEvent.PluginConsent) return;
      if ((event.payload as { state: string }).state === "pending") asked += 1;
    },
  });
  try {
    const { core } = lite;
    await core.updateSettings({ computerControl: true });
    const project = "desk-unanswered";
    await core.games.scaffold(project);
    const threadId = await core.createGameThread(project);
    // Manual asks: Auto and Bypass ask no computer-control card.
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    const answers: string[] = [];
    core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        for (let call = 0; call < 2; call++) {
          const result = await request.onLiveTool!("desktop", { action: "screenshot" });
          answers.push(typeof result === "string" ? result : result.text);
        }
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project, threadId, prompt: "go" });

    assert.equal(asked, 2, "an expired card is no answer: the next call asks again");
    assert.equal(answers.length, 2);
    for (const answer of answers) {
      assert.match(answer, /nobody answered/);
      assert.doesNotMatch(answer, /did not allow/);
    }
  } finally {
    await lite.close();
  }
});
