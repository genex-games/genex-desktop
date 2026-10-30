import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { StudioCore } from "../../src/main/studio-core.ts";
import type { IpcResult } from "../../src/shared/ipc-channels.ts";
import type { IpcSender } from "../../src/main/ipc-handle.ts";

const electron = `data:text/javascript,${encodeURIComponent("export const dialog = {}; export const app = {}; export const shell = {}; export const BrowserWindow = class {}; export default {dialog,app,shell,BrowserWindow};")}`;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context),
});
const { createIpcHandle } = await import("../../src/main/ipc-handle.ts");
const { registerPluginsIpc } = await import("../../src/main/ipc/plugins.ts");

test("host job channels validate payloads and reach only the owning core methods", async () => {
  const calls: unknown[] = [];
  const core = {
    pluginNativeJobs: async (id: string) => {
      calls.push(["list", id]);
      return [];
    },
    pluginNativeJob: async (id: string, jobId: string) => {
      calls.push(["detail", id, jobId]);
      return null;
    },
    pluginCancelNativeJob: async (id: string, jobId: string) => {
      calls.push(["cancel", id, jobId]);
      return true;
    },
  } as unknown as StudioCore;
  const studio = { sender: "studio", senderFrame: "main" };
  const handlers = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    { fixture: true, isStudioUi: (event) => event === studio },
  );
  registerPluginsIpc(handle, {
    core,
    marketplace: () => null,
    confirmInstall: async () => false,
    fixtureNativePolicy: true,
    window: () => null,
  });
  const invoke = async (channel: string, payload: unknown, event: IpcSender = studio) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler(event, payload);
  };
  for (const payload of [undefined, null, {}, { id: 7 }, { id: "plugin", jobId: 1 }])
    assert.equal((await invoke("studio:plugins.cancel-native-job", payload)).ok, false);
  assert.equal(
    (await invoke("studio:plugins.native-jobs", { id: "plugin" }, { sender: "other", senderFrame: "other" })).ok,
    false,
  );
  for (const payload of [undefined, null, {}, { id: 7 }, { id: "plugin", jobId: 1 }])
    assert.equal((await invoke("studio:plugins.native-job", payload)).ok, false);
  assert.equal(
    (
      await invoke(
        "studio:plugins.native-job",
        { id: "plugin", jobId: "job" },
        { sender: "other", senderFrame: "other" },
      )
    ).ok,
    false,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(await invoke("studio:plugins.native-jobs", { id: "plugin" }), { ok: true, value: [] });
  assert.deepEqual(await invoke("studio:plugins.native-job", { id: "plugin", jobId: "job" }), {
    ok: true,
    value: null,
  });
  assert.deepEqual(await invoke("studio:plugins.cancel-native-job", { id: "plugin", jobId: "job" }), {
    ok: true,
    value: true,
  });
  assert.deepEqual(calls, [
    ["list", "plugin"],
    ["detail", "plugin", "job"],
    ["cancel", "plugin", "job"],
  ]);
});
