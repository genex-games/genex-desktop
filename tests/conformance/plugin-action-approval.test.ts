/**
 * A plugin action that declares `confirmation` is reviewed, then approved in a native dialog main
 * builds. When the plugin's `review` gives a question and words of its own, the dialog asks that
 * question, shows those words, and confirms with the action's own name; it never lists the
 * arguments as JSON then. Without a review the manifest's confirmation lists them, as before. The
 * dialog says the plugin's name, label and confirmation as the app's language does (`displayManifest`).
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

/** Every native message box main was asked to show; the Electron stand-in below records each one. */
const shown: Array<Record<string, unknown>> = [];
Object.assign(globalThis, { pluginApprovalDialogs: shown });
/** Main's plugin registrar imports electron; this stand-in records message boxes and answers the confirm button. */
const ELECTRON_STUB = `data:text/javascript,${encodeURIComponent(
  [
    "export const dialog = {",
    "  showMessageBox: async (options) => { globalThis.pluginApprovalDialogs.push(options); return { response: 1 }; },",
    "  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),",
    "};",
    "export const shell = { openExternal: async () => {} };",
    'export const app = { getVersion: () => "0.0.0", getPath: () => "/nonexistent" };',
    "export const BrowserWindow = class {};",
    "export default { dialog, shell, app, BrowserWindow };",
  ].join("\n"),
)}`;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "electron" ? { url: ELECTRON_STUB, shortCircuit: true } : next(specifier, context),
});
const { createIpcHandle } = await import("../../src/main/ipc-handle.ts");
const { registerPluginsIpc } = await import("../../src/main/ipc/plugins.ts");

const SETUP = { name: "setup", label: "Set up", confirmation: "Set up this Unreal project for Genex?" };
const ARGS = { project: "/Users/me/Lyra/Lyra.uproject" };
type Answer = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Main's review and action channels over one plugin whose `review` answers `review`, its manifest
 * in the app's language `inLanguage` (the English one unless given).
 */
function channels(review: unknown, inLanguage?: Record<string, unknown>) {
  const reached: string[] = [];
  const manifest = { id: "unreal", name: "Unreal", actions: [SETUP], capabilities: [] };
  const core = {
    plugins: {
      list: () => [{ manifest, enabled: true, removed: false, source: "bundled" }],
      displayManifest: async () => inLanguage ?? manifest,
      // The plugin is on: every action of its is the person's to run.
      servesAction: () => true,
      review: async () => review,
      action: async (_id: string, name: string) => {
        reached.push(name);
        return { done: name };
      },
    },
    pluginBinding: async () => undefined,
  };
  const listeners = new Map<string, (event: unknown, payload: unknown) => Promise<Answer>>();
  const ipc = {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<Answer>) =>
      listeners.set(channel, listener),
  };
  const studio = { sender: "studio" };
  registerPluginsIpc(createIpcHandle(ipc as never, { fixture: false, isStudioUi: (event) => event === studio }), {
    core: core as never,
    marketplace: () => null,
    confirmInstall: async () => false,
    fixtureNativePolicy: false,
    window: () => null,
  });
  const call = (channel: string, payload: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `main registers ${channel}`);
    return listener(studio, payload);
  };
  /** Review the setup action, then run it with the ticket the review issued. */
  const reviewAndRun = async () => {
    const reviewed = await call("studio:plugins.review", { id: "unreal", name: SETUP.name, args: ARGS });
    assert.ok(reviewed.ok, JSON.stringify(reviewed));
    const { ticket } = reviewed.value as { ticket: string };
    return call("studio:plugins.action", { id: "unreal", name: SETUP.name, args: ARGS, ticket });
  };
  return { call, reviewAndRun, reached };
}

describe("A confirmed plugin action's native dialog", () => {
  beforeEach(() => {
    shown.length = 0;
  });

  it("asks the plugin's own question with its own words, under the action's name, and no JSON", async () => {
    const detail = "• Turns on Epic's MCP plugins in Lyra.uproject\n• Adds the Genex editor helper";
    const { reviewAndRun, reached } = channels({ message: "Set up Lyra for Genex?", detail });
    assert.deepEqual(await reviewAndRun(), { ok: true, value: { done: "setup" } });
    assert.equal(shown.length, 1);
    const [box] = shown;
    assert.equal(box?.title, "Unreal: Set up");
    assert.equal(box?.message, "Set up Lyra for Genex?");
    assert.equal(box?.detail, detail);
    assert.deepEqual(box?.buttons, ["Cancel", "Set up"]);
    assert.equal(box?.cancelId, 0);
    assert.equal(box?.defaultId, 0, "Cancel stays the default");
    assert.deepEqual(reached, ["setup"]);
  });

  it("shows no arguments when the review gave a question alone", async () => {
    const { reviewAndRun } = channels({ message: "Set up Lyra for Genex?" });
    assert.equal((await reviewAndRun()).ok, true);
    assert.equal(shown[0]?.message, "Set up Lyra for Genex?");
    assert.equal(shown[0]?.detail, undefined);
    assert.deepEqual(shown[0]?.buttons, ["Cancel", "Set up"]);
  });

  it("without a review, asks the manifest's confirmation over the arguments, as before", async () => {
    const { reviewAndRun } = channels({});
    assert.equal((await reviewAndRun()).ok, true);
    assert.equal(shown[0]?.message, SETUP.confirmation);
    assert.equal(shown[0]?.detail, JSON.stringify(ARGS, null, 2));
    assert.deepEqual(shown[0]?.buttons, ["Cancel", "Approve"]);
  });

  it("says the plugin's name, label and confirmation in the app's language", async () => {
    const russian = { label: "Настроить", confirmation: "Настроить этот проект Unreal для Genex?" };
    const inRussian = { id: "unreal", name: "Unreal Engine", actions: [{ ...SETUP, ...russian }], capabilities: [] };
    const { reviewAndRun, reached } = channels({}, inRussian);
    assert.equal((await reviewAndRun()).ok, true);
    assert.equal(shown[0]?.title, "Unreal Engine: Настроить");
    assert.equal(shown[0]?.message, russian.confirmation);
    assert.deepEqual(reached, ["setup"], "the action runs by its own name");
    shown.length = 0;
    const reviewed = channels({ message: "Set up Lyra for Genex?" }, inRussian);
    assert.equal((await reviewed.reviewAndRun()).ok, true);
    assert.deepEqual(shown[0]?.buttons, ["Cancel", "Настроить"]);
  });

  const malformed: Array<[string, unknown]> = [
    ["a message that is not text", { message: { text: "Set up?" } }],
    ["a detail that is not text", { message: "Set up?", detail: ["• one"] }],
    ["a message past its bound", { message: "x".repeat(2_001) }],
    ["a detail past its bound", { message: "Set up?", detail: "x".repeat(4_001) }],
  ];
  for (const [what, review] of malformed)
    it(`refuses a review with ${what}, and nothing is asked or run`, async () => {
      const { call, reached } = channels(review);
      const reviewed = await call("studio:plugins.review", { id: "unreal", name: SETUP.name, args: ARGS });
      assert.equal(reviewed.ok, false);
      assert.match(reviewed.ok ? "" : reviewed.error, /Invalid plugin review/);
      assert.equal(shown.length, 0);
      assert.deepEqual(reached, []);
    });
});
