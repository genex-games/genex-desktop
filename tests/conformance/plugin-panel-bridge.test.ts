/**
 * The host's side of a plugin panel's bridge: a request is answered in the game it was asked in,
 * even when the person moves to another game before the answer comes (the panel is told its context
 * changed, then gets its answer), and a panel that is gone gets nothing more.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { PanelSurface } from "../../src/renderer/panels/panel-bridge.ts";
import { PanelMessage, PanelMethod, openPanelBridge } from "../../src/renderer/panels/panel-host-bridge.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";

const plugin = {
  manifest: { id: "toy-engine", actions: [{ name: "open-editor", label: "Open" }] },
} as unknown as PluginInfo;

/** A panel's frame on a host whose game the test moves, and main's action channel answered by hand. */
function panelOn(project: string) {
  const posted: unknown[] = [];
  const frame = { postMessage: (message: unknown) => posted.push(message) };
  const host = { project, frame: frame as typeof frame | null };
  const asked: string[] = [];
  const answers: Array<(value: unknown) => void> = [];
  Object.assign(globalThis, {
    window: {
      studio: {
        pluginAction: (_id: string, name: string, _args: unknown, game: string) => {
          asked.push(`${name} in ${game}`);
          return new Promise((resolve) => answers.push(resolve));
        },
      },
    },
  });
  const bridge = openPanelBridge({
    frame: () => host.frame,
    plugin: () => plugin,
    project: () => host.project,
    surface: () => PanelSurface.Page,
    style: () => ({ getPropertyValue: () => "" }),
    review: () => {},
    onHead: () => {},
    onHeight: () => {},
  });
  const request = (id: string) =>
    bridge.receive({
      source: frame,
      origin: "null",
      data: { type: PanelMessage.Request, id, method: PanelMethod.Action, name: "open-editor", args: {} },
    });
  return { bridge, host, posted, asked, answers, request };
}

describe("a plugin panel's requests", () => {
  it("answers a request asked before the game changed, after telling the panel its context changed", async () => {
    const panel = panelOn("valley");
    const answered = panel.request("1");
    await settle();
    panel.host.project = "harbor";
    panel.bridge.contextChanged();
    panel.answers[0]?.({ opened: true });
    await answered;
    assert.deepEqual(panel.asked, ["open-editor in valley"], "asked in the game it came from");
    assert.deepEqual(panel.posted, [
      { type: PanelMessage.ContextChanged },
      { type: PanelMessage.Result, id: "1", result: { opened: true } },
    ]);
  });

  it("asks a request that comes after the change in the new game", async () => {
    const panel = panelOn("valley");
    panel.host.project = "harbor";
    const answered = panel.request("2");
    await settle();
    panel.answers[0]?.(null);
    await answered;
    assert.deepEqual(panel.asked, ["open-editor in harbor"]);
  });

  it("tells a panel that is gone nothing more, and takes no more requests from it", async () => {
    const panel = panelOn("valley");
    const answered = panel.request("1");
    await settle();
    panel.bridge.close();
    panel.bridge.contextChanged();
    panel.answers[0]?.({ opened: true });
    await answered;
    await panel.request("2");
    assert.deepEqual(panel.posted, []);
    assert.deepEqual(panel.asked, ["open-editor in valley"]);
  });

  it("ignores a message from anything but its own frame", async () => {
    const panel = panelOn("valley");
    await panel.bridge.receive({
      source: { postMessage() {} },
      origin: "null",
      data: { type: PanelMessage.Request, id: "1", method: PanelMethod.Action, name: "open-editor" },
    });
    assert.deepEqual(panel.asked, []);
  });
});
