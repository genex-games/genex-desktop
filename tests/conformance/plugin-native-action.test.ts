/**
 * A plugin action marked `native` starts, quits or opens a desktop app or the browser, or writes
 * outside the plugin's storage, so a disposable fixture profile refuses it in main before the
 * backend runs: no app opens and nothing is written on the developer's computer. Every other action
 * still reaches the backend, and a live profile runs the native ones too.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";

/** Main's plugin registrar imports electron; this stand-in opens no dialog and no browser. */
const ELECTRON_STUB = `data:text/javascript,${encodeURIComponent(
  [
    "export const dialog = { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };",
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

/** Get Xcode opens the App Store page or the Xcode app, so it is native too. */
const NATIVE = ["create", "open-editor", "quit-editor", "get-unreal", "skip", "get-xcode"];

/**
 * Roblox's actions that quit, open or click in Studio, write its Plugins folder and settings,
 * download and run Roblox's installer, read the person's places (Documents, Studio's recent list,
 * the open Studios), write and link a place, or download the Luau checks.
 */
const ROBLOX_NATIVE = [
  "setup",
  "undo-setup",
  "restart-studio",
  "do-it-for-me",
  "get-studio",
  "open-studio",
  "quit-studio",
  "places",
  "use-place",
  "create",
  "add-luau-checks",
  "publish-update",
  "first-publish",
];

/** Main's `studio:plugins.action` over a bundled plugin's real manifest, with a core that records each call. */
async function actionChannel(fixture: boolean, id = "unreal") {
  const manifest = validateManifest(JSON.parse(await readFile(`src/plugins/${id}/plugin.json`, "utf8")));
  const reached: string[] = [];
  const core = {
    plugins: {
      list: () => [{ manifest, enabled: true, removed: false, source: "bundled" }],
      // The plugin is on: every action of its is the person's to run.
      servesAction: () => true,
      action: async (_id: string, name: string) => {
        reached.push(name);
        return { ok: name };
      },
    },
    pluginBinding: async () => undefined,
  };
  const listeners = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const ipc = {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) =>
      listeners.set(channel, listener),
  };
  const studio = { sender: "studio" };
  const handle = createIpcHandle(ipc as never, { fixture, isStudioUi: (event) => event === studio });
  registerPluginsIpc(handle, {
    core: core as never,
    marketplace: () => null,
    confirmInstall: async () => false,
    fixtureNativePolicy: fixture,
    window: () => null,
  });
  const listener = listeners.get("studio:plugins.action");
  assert.ok(listener, "main registers the action channel");
  const act = (name: string) => listener(studio, { id, name, args: {} }) as Promise<{ ok: boolean; error?: string }>;
  return { act, reached };
}

describe("A native plugin action", () => {
  it("is refused in a fixture profile before the backend runs", async () => {
    const { act, reached } = await actionChannel(true);
    for (const name of NATIVE) {
      const answer = await act(name);
      assert.equal(answer.ok, false, name);
      assert.match(answer.error ?? "", /^unsupported-in-fixture/, name);
    }
    assert.deepEqual(reached, [], "the backend never saw a native action");
  });

  it("an action that isn't native still reaches the backend in a fixture profile", async () => {
    const { act, reached } = await actionChannel(true);
    for (const name of ["status", "templates", "toolbar-status"]) assert.equal((await act(name)).ok, true, name);
    assert.deepEqual(reached, ["status", "templates", "toolbar-status"]);
  });

  it("a live profile runs every action", async () => {
    const { act, reached } = await actionChannel(false);
    for (const name of NATIVE) assert.equal((await act(name)).ok, true, name);
    assert.deepEqual(reached, NATIVE);
  });
});

describe("Roblox Studio's native actions", () => {
  it("are refused in a fixture profile before the backend runs: no download, no installer, no Studio", async () => {
    const { act, reached } = await actionChannel(true, "roblox");
    for (const name of ROBLOX_NATIVE) {
      const answer = await act(name);
      assert.equal(answer.ok, false, name);
      assert.match(answer.error ?? "", /^unsupported-in-fixture/, name);
    }
    assert.deepEqual(reached, []);
  });

  it("are exactly the ones the manifest marks native; status, steps and Stop still reach the backend", async () => {
    const roblox = validateManifest(JSON.parse(await readFile("src/plugins/roblox/plugin.json", "utf8")));
    assert.deepEqual(
      roblox.actions.filter((action) => action.native).map((action) => action.name),
      ROBLOX_NATIVE,
    );
    const { act, reached } = await actionChannel(true, "roblox");
    for (const name of ["status", "steps", "cancel-get-studio"]) assert.equal((await act(name)).ok, true, name);
    assert.deepEqual(reached, ["status", "steps", "cancel-get-studio"]);
  });
});

describe("The manifest's native field", () => {
  /** The Unreal manifest with Get Unreal's `native` set to `native` (absent when undefined). */
  const manifest = async (native: unknown) => {
    const raw = JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8"));
    const actions = raw.actions.map((action: { name: string; native?: unknown }) => {
      if (action.name !== "get-unreal") return action;
      const { native: _old, ...rest } = action;
      return native === undefined ? rest : { ...rest, native };
    });
    return { ...raw, actions };
  };
  const getUnreal = (m: ReturnType<typeof validateManifest>) => m.actions.find((a) => a.name === "get-unreal");

  it("keeps native: true and leaves it off when absent", async () => {
    assert.equal(getUnreal(validateManifest(await manifest(true)))?.native, true);
    assert.equal(getUnreal(validateManifest(await manifest(undefined)))?.native, undefined);
  });

  for (const native of [false, "yes", 1, null, {}])
    it(`refuses native: ${JSON.stringify(native)}`, async () => {
      const raw = await manifest(native);
      assert.throws(() => validateManifest(raw), /native/i);
    });

  it("the Unreal plugin marks exactly the actions that start or quit an app, open the browser or write a game", async () => {
    const unreal = validateManifest(JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8")));
    assert.deepEqual(
      unreal.actions.filter((action) => action.native).map((action) => action.name),
      NATIVE,
    );
  });
});
