import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { PanelSurface, panelContext, panelErrorReply } from "../../src/renderer/panels/panel-bridge.ts";
import { runPluginAction } from "../../src/renderer/plugin-actions.ts";
import { isUserCancelled, UserCancelledError } from "../../src/shared/errors.ts";
import { PanelErrorCode } from "../../src/shared/plugins.ts";

test("panel notifications accept only parent, isolate callbacks and unsubscribe", async () => {
  const listeners = new Map<string, Function>();
  const parent = { postMessage() {} };
  const context = vm.createContext({
    parent,
    window: { addEventListener: (n: string, fn: Function) => listeners.set(n, fn) },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(await readFile("src/plugin-sdk/panel.js", "utf8"), context);
  let calls = 0;
  const sdk = context.window.studioPlugin;
  sdk.onContextChanged(() => {
    throw new Error("consumer failed");
  });
  const unsubscribe = sdk.onContextChanged(() => calls++);
  listeners.get("message")!({ source: {}, data: { type: "studio-plugin-context-changed" } });
  assert.equal(calls, 0);
  listeners.get("message")!({ source: parent, data: { type: "studio-plugin-context-changed" } });
  assert.equal(calls, 1);
  unsubscribe();
  listeners.get("message")!({ source: parent, data: { type: "studio-plugin-context-changed" } });
  assert.equal(calls, 1);
});

test("chooseFile asks the host for Studio's file picker and waits as long as a panel may", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const posted: unknown[] = [];
  const waits: number[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const context = vm.createContext({
    parent,
    window: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
    setTimeout: (_listener: () => void, ms: number) => waits.push(ms),
    clearTimeout() {},
  });
  vm.runInContext(await readFile("src/plugin-sdk/panel.js", "utf8"), context);
  const chosen = context.window.studioPlugin.chooseFile({ title: "Choose a project", extensions: ["uproject"] });
  // The request crosses as data; the panel's objects come from the frame's own realm.
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
    {
      type: "studio-plugin-request",
      id: "1",
      method: "chooseFile",
      args: { title: "Choose a project", extensions: ["uproject"] },
    },
  ]);
  assert.deepEqual(waits, [1_800_000], "the person may take their time in the picker");
  listeners.get("message")?.({ source: parent, data: { type: "studio-plugin-result", id: "1", result: null } });
  assert.equal(await chosen, null, "cancelled");
});

/** The SDK's panel.js in a fresh realm, with the host's results delivered by hand. */
async function sdkPanel() {
  const listeners = new Map<string, (event: unknown) => void>();
  const parent = { postMessage() {} };
  const context = vm.createContext({
    parent,
    window: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
    setTimeout: () => 0,
    clearTimeout() {},
  });
  vm.runInContext(await readFile("src/plugin-sdk/panel.js", "utf8"), context);
  const answer = (data: Record<string, unknown>) =>
    listeners.get("message")?.({ source: parent, data: { type: "studio-plugin-result", ...data } });
  return { sdk: context.window.studioPlugin, answer };
}

test("a cancelled Studio confirmation reaches the panel as code cancelled; any other code is dropped", async () => {
  const rows: Array<[Record<string, unknown>, string | undefined]> = [
    [{ error: "Error: Cancelled by user", code: "cancelled" }, "cancelled"],
    [{ error: "Error: Cancelled by user", code: "x" }, undefined],
    [{ error: "Error: disk full" }, undefined],
  ];
  for (const [i, [result, code]] of rows.entries()) {
    const { sdk, answer } = await sdkPanel();
    const call = sdk.call("action", "setup", {});
    answer({ id: "1", ...result });
    const error = await call.then(
      () => assert.fail(`row ${i} resolved`),
      (e: Error & { code?: string }) => e,
    );
    assert.equal(error.message, result.error);
    assert.equal(error.code, code, `row ${i}`);
  }
});

test("the host answers a cancel with code cancelled and keeps its words; a failure carries no code", () => {
  const rows: Array<[unknown, Record<string, unknown>]> = [
    [new UserCancelledError(), { error: "Cancelled by user", code: PanelErrorCode.Cancelled }],
    [new Error("Cancelled by user"), { error: "Cancelled by user", code: PanelErrorCode.Cancelled }],
    [new Error("Cancelled by user: disk full"), { error: "Error: Cancelled by user: disk full" }],
    [new Error("disk full"), { error: "Error: disk full" }],
  ];
  for (const [error, reply] of rows) assert.deepEqual(panelErrorReply(error), reply);
});

test("a declined image review is the same cancel as a declined confirmation", async () => {
  const studio = {
    pluginReview: async () => ({ ticket: "t", images: [{ label: "a", dataUrl: "data:image/png;base64,AA==" }] }),
    pluginAction: async () => assert.fail("a declined review must not run the action"),
  };
  Object.assign(globalThis, { window: { studio } });
  const plugin = { manifest: { id: "p", actions: [{ name: "go", label: "Go", confirmation: "Go?" }] } } as never;
  await assert.rejects(
    runPluginAction({ plugin, name: "go", args: {}, project: null, review: (r) => r.resolve(false) }),
    (error: unknown) => isUserCancelled(error),
  );
});

test("the panel context carries the theme's accent button colours as Studio paints them", () => {
  const painted: Record<string, string> = {
    "--background": " #1e1e2e",
    "--foreground": "#cdd6f4 ",
    "--accent-primary": "#cba6f7",
    "--accent-fill": " #835fab",
    "--accent-foreground": "#ffffff",
    "--accent-hover": "#8a66b3 ",
  };
  const style = { getPropertyValue: (name: string) => painted[name] ?? "" };
  assert.deepEqual(panelContext("/games/g", style).theme, {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    accent: "#cba6f7",
    accentFill: "#835fab",
    accentForeground: "#ffffff",
    accentHover: "#8a66b3",
  });
});

test("a panel in a dialog is told the dialog card's colour as its background, so it paints no inset rectangle", () => {
  const painted: Record<string, string> = {
    "--background": "#f9faf9",
    "--card": " #ffffff",
    "--foreground": "#101112",
  };
  const style = { getPropertyValue: (name: string) => painted[name] ?? "" };
  assert.equal(panelContext(null, style, PanelSurface.Card).theme.background, "#ffffff");
  assert.equal(panelContext(null, style).theme.background, "#f9faf9", "a panel on the page keeps the page's");
});
