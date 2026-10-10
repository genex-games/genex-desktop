/**
 * Stop and Play on the stage strip: Stop takes the person's game off Live so it stops costing the
 * machine anything, Play brings the same page back. Both reach Live's own view, one operation at
 * a time with its loads, and never the harness's stand-in.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { describe, it } from "node:test";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerPreviewIpc } from "../../src/main/ipc/preview.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { createUnityProject } from "../../src/plugins/unity/project-setup.ts";

/** A live view that records loads, stops and resumes; `stoppable: false` is a port without them. */
function livePort({ stoppable = true } = {}) {
  const port = {
    calls: [] as string[],
    async load(project: string, entry: string) {
      port.calls.push("load");
      return `game://${project}/${entry}`;
    },
    async reload() {
      port.calls.push("reload");
    },
    status: () => ({ project: "pong", loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
    ...(stoppable
      ? {
          async stop() {
            port.calls.push("stop");
          },
          async resume() {
            port.calls.push("resume");
          },
        }
      : {}),
  };
  return port;
}

async function stage(
  port: ReturnType<typeof livePort>,
): Promise<{ lite: CoreLite; ipc: (channel: string) => Promise<IpcResult> }> {
  const lite = await coreLite({ preview: port as never, gamesRoot: await realpath(await tmpDir("studio-live-stop-")) });
  await lite.core.games.scaffold("pong");
  await lite.core.loadPreview({ project: "pong" });
  const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => listeners.set(channel, listener) },
    { fixture: true, isStudioUi: () => true },
  );
  registerPreviewIpc(handle, { core: lite.core, preview: () => null, previewBoundsSeen: { last: null } });
  const ipc = (channel: string) =>
    listeners.get(channel)!({ sender: "studio", senderFrame: "main-frame" } as IpcSender, undefined);
  return { lite, ipc };
}

describe("Stop and Play", () => {
  it("Stop stops Live's view and Play resumes it", async () => {
    const port = livePort();
    const { ipc } = await stage(port);
    port.calls.length = 0;
    assert.deepEqual(await ipc("studio:preview.stop"), { ok: true, value: true });
    assert.deepEqual(await ipc("studio:preview.play"), { ok: true, value: true });
    assert.deepEqual(port.calls, ["stop", "resume"]);
  });

  it("a view that cannot stop leaves both presses harmless", async () => {
    const port = livePort({ stoppable: false });
    const { ipc } = await stage(port);
    port.calls.length = 0;
    assert.deepEqual(await ipc("studio:preview.stop"), { ok: true, value: true });
    assert.deepEqual(await ipc("studio:preview.play"), { ok: true, value: true });
    assert.deepEqual(port.calls, []);
  });

  it("Stop waits for a load already under way, so the stopped page is never replaced by it", async () => {
    const port = livePort();
    const { lite, ipc } = await stage(port);
    port.calls.length = 0;
    const loading = lite.core.loadPreview({ project: "pong" });
    const stopping = ipc("studio:preview.stop");
    await Promise.all([loading, stopping]);
    assert.deepEqual(port.calls, ["load", "stop"]);
  });

  it("switching to Unity stops the browser inside the same queue, without waiting on itself", async (t) => {
    const port = livePort();
    const { lite, ipc } = await stage(port);
    const dir = path.join(await tmpDir("studio-live-unity-"), "unity-game");
    await createUnityProject(dir, "6000.5.5f1");
    const project = await lite.core.games.adopt(dir);
    port.calls.length = 0;
    // The bound proves that the preview queue settles. Project creation/adoption performs real
    // Git work and is outside that operation, particularly on a cold hosted Windows runner.
    await t.test("the preview queue settles within its original bound", { timeout: 10_000 }, async () => {
      const switching = lite.core.loadPreview({ project: project.name });
      const stopping = ipc("studio:preview.stop");
      assert.equal(await switching, `unity:${encodeURIComponent(project.name)}`);
      assert.deepEqual(await stopping, { ok: true, value: true });
      assert.deepEqual(port.calls, ["stop", "stop"]);
      assert.equal(await lite.core.loadPreview({ project: "pong" }), "game://pong/index.html");
      assert.deepEqual(port.calls, ["stop", "stop", "load"]);
    });
  });
});
