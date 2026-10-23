/**
 * Live's Native view plays what Live shows. A build copy Live loads (Play latest, a run card's
 * Play, Reload of a run's build) is the folder its Mac build is made from: the embedded run the
 * person watches starts again on that copy, and an embed asked for afterwards builds the copy too,
 * never the game folder. Live back on the game folder brings the Native view back to it. The
 * registry here is a scripted stand-in that records what it is asked: no game builds or runs.
 */
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerNativeIpc } from "../../src/main/ipc/native.ts";
import type { NativeEmbedRequest, NativeRunsHost } from "../../src/main/core/native-runs.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { NativeRunMode, NativeRunState, type NativeRunStatus } from "../../src/shared/native-contract.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Live's canvas size, as the renderer sends it. */
const EMBED_SIZE = { width: 640, height: 360, dpr: 2 };

/** A ready embedded run of `project`. */
function embeddedRun(project: string, runId: string): NativeRunStatus {
  return {
    project,
    runId,
    target: BuildTarget.Mac,
    state: NativeRunState.Ready,
    mode: NativeRunMode.Embedded,
    pid: 1,
    backend: null,
    refusal: null,
    problem: null,
    exit: null,
    owner: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
  };
}

/** A registry that records each embed and each restart on another folder; `watching` games hold an embedded run. */
function recordingRegistry() {
  const embeds: NativeEmbedRequest[] = [];
  const reembeds: Array<{ project: string; root: string | undefined }> = [];
  const watching = new Set<string>();
  const nothing = async () => {};
  const host: NativeRunsHost = {
    start: async () => {
      throw new Error("Live's Native view only embeds");
    },
    stop: nothing,
    stopAll: nothing,
    stopAgentRuns: nothing,
    stopProject: nothing,
    stopMode: nothing,
    stopOwnedBy: nothing,
    state: (project, mode) =>
      mode === NativeRunMode.Embedded && watching.has(project) ? embeddedRun(project, `${project}-shown`) : null,
    portOf: () => null,
    front: async () => false,
    sweepOrphans: async () => 0,
    onFocus: () => () => {},
    onStatus: () => () => {},
    embed: async (request) => {
      embeds.push(request);
      watching.add(request.project);
      return embeddedRun(request.project, `${request.project}-${embeds.length}`);
    },
    reembed: async (project, root) => {
      if (!watching.has(project)) return null;
      reembeds.push({ project, root });
      return embeddedRun(project, `${project}-again-${reembeds.length}`);
    },
    resize: () => false,
    input: async () => false,
    showEmbedded: () => {},
    kill: () => {},
  };
  return { host, embeds, reembeds, watching };
}

/** A Live view that records each folder it served. */
function recordingLive() {
  const loads: Array<{ project: string; root: string | null }> = [];
  const port = {
    loads,
    async load(project: string, entry: string, root?: string) {
      loads.push({ project, root: root ?? null });
      return `game://${project}/${entry}`;
    },
    async reload() {},
    status: () => ({ project: loads.at(-1)?.project ?? null, loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
    async dispose() {},
  };
  return port;
}

/** Main's native IPC over the lite core, as Live's canvas calls it. */
function nativeIpc(lite: CoreLite) {
  const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  registerNativeIpc(handle, lite.core);
  return (channel: string, payload: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener({ sender: "studio", senderFrame: "main-frame" } as IpcSender, payload);
  };
}

/** A game open in Live, a run's build of it one commit ahead, and the person watching its Native view. */
async function stage() {
  const live = recordingLive();
  const registry = recordingRegistry();
  const lite = await coreLite({
    preview: live as never,
    gamesRoot: await realpath(await tmpDir("studio-native-live-copy-")),
    previewPoolMax: 2,
    createHeadlessPreview: async () => recordingLive() as never,
    createNativeRuns: () => registry.host,
  });
  const game = await lite.core.games.scaffold("pong");
  await lite.core.loadPreview({ project: "pong" });
  const worktree = path.join(lite.core.layout.scratch, "autopilot", "run_x", "integration");
  await gitFile(["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: game.dir });
  await writeFile(path.join(worktree, "plaza.js"), "export const plaza = 'red';\n");
  await gitFile(["add", "-A"], { cwd: worktree });
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "plaza"], { cwd: worktree });
  const head = (await gitFile(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
  registry.watching.add("pong");
  return { lite, live, registry, head, invoke: nativeIpc(lite) };
}

describe("Live's Native view plays the build Live shows", () => {
  it("Play latest starts the Native view again on the copy Live loaded, and a later embed builds that copy", async (t) => {
    const { lite, live, registry, head, invoke } = await stage();
    t.after(() => lite.close());
    const copy = await lite.core.showBuild("pong", head);
    const served = live.loads.at(-1)?.root ?? null;
    assert.ok(served && (await realpath(served)) === (await realpath(copy.dir)), "Live serves the copy");
    assert.deepEqual(registry.reembeds, [{ project: "pong", root: served }], "the Native view follows Live");
    const reply = await invoke("studio:native.embed", { project: "pong", size: EMBED_SIZE });
    assert.equal(reply.ok, true);
    assert.equal(registry.embeds.at(-1)?.root, served, "Try again or a remount builds the copy, not the game folder");
  });

  it("Live back on the game folder brings the Native view back to it; the same folder again restarts nothing", async (t) => {
    const { lite, registry, head, invoke } = await stage();
    t.after(() => lite.close());
    await lite.core.showBuild("pong", head);
    await lite.core.loadPreview({ project: "pong" });
    assert.deepEqual(
      registry.reembeds.map((asked) => asked.root),
      [registry.reembeds[0]?.root, undefined],
    );
    await lite.core.loadPreview({ project: "pong" });
    assert.equal(registry.reembeds.length, 2, "Live loaded the folder it already served");
    await invoke("studio:native.embed", { project: "pong", size: EMBED_SIZE });
    assert.equal(registry.embeds.at(-1)?.root, undefined, "the game folder");
    assert.equal(Object.hasOwn(registry.embeds.at(-1) ?? {}, "root"), false);
  });

  it("a copy Live loads while nobody watches the Native view starts nothing", async (t) => {
    const { lite, registry, head } = await stage();
    t.after(() => lite.close());
    registry.watching.delete("pong");
    await lite.core.showBuild("pong", head);
    assert.deepEqual(registry.reembeds, []);
    assert.deepEqual(registry.embeds, []);
  });
});
