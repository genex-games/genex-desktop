/**
 * `studio:live.reloadAssets` (game systems C-19b): Reload's asset swap over IPC, through the real
 * typed `handle()`. A listed game inside the allowed root reaches the core's swap and its answer
 * comes back; a fixture profile refuses the channel (native-classified: it writes into a running
 * game's copy and sends it an op); a payload that names no listed game is refused before the core
 * is asked anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IpcSender } from "../../src/main/ipc-handle.ts";
import { createIpcHandle } from "../../src/main/ipc-handle.ts";
import { type LiveAssetsIpcCore, registerLiveAssetsIpc } from "../../src/main/ipc/live-assets.ts";
import { LiveAssetsOutcome, type LiveAssetsAnswer } from "../../src/shared/live-assets.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<unknown>;

const SWAPPED: LiveAssetsAnswer = {
  outcome: LiveAssetsOutcome.Swapped,
  reason: null,
  reloaded: ["textures/bark.png"],
  pending: 1,
};

function liveAssetsIpc(fixture: boolean) {
  const asked: string[] = [];
  const allowed: string[] = [];
  const core: LiveAssetsIpcCore = {
    games: {
      list: async () => [
        { name: "forest", dir: "/games/forest" } as Awaited<ReturnType<LiveAssetsIpcCore["games"]["list"]>>[number],
      ],
    },
    assertProjectAllowed: async (dir) => {
      allowed.push(dir);
    },
    reloadLiveAssets: async (project) => {
      asked.push(project);
      return SWAPPED;
    },
  };
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener as Listener) },
    { fixture, isStudioUi: () => true },
  );
  registerLiveAssetsIpc(handle, core);
  const listener = listeners.get("studio:live.reloadAssets");
  assert.ok(listener, "the channel is registered");
  const invoke = (payload: unknown) => listener({} as IpcSender, payload);
  return { invoke, asked, allowed };
}

describe("studio:live.reloadAssets", () => {
  it("a listed game reaches the core's swap and its answer comes back", async () => {
    const ipc = liveAssetsIpc(false);
    assert.deepEqual(await ipc.invoke({ project: "forest" }), { ok: true, value: SWAPPED });
    assert.deepEqual(ipc.asked, ["forest"]);
    assert.deepEqual(ipc.allowed, ["/games/forest"]);
  });

  it("a fixture profile refuses it before the core is asked", async () => {
    const ipc = liveAssetsIpc(true);
    const answer = (await ipc.invoke({ project: "forest" })) as { ok: boolean; error?: string };
    assert.equal(answer.ok, false);
    assert.match(answer.error ?? "", /unsupported-in-fixture/);
    assert.deepEqual(ipc.asked, []);
  });

  const HOSTILE: Array<[string, unknown]> = [
    ["no payload", undefined],
    ["no project", {}],
    ["a number", { project: 7 }],
    ["a climbing path", { project: "../forest" }],
    ["a nested path", { project: "games/forest" }],
    ["a dot name", { project: ".." }],
    ["a NUL", { project: "forest\0" }],
    ["an unlisted game", { project: "desert" }],
    ["an inherited field", Object.create({ project: "forest" })],
  ];
  for (const [name, payload] of HOSTILE) {
    it(`refuses ${name} and asks the core nothing`, async () => {
      const ipc = liveAssetsIpc(false);
      const answer = (await ipc.invoke(payload)) as { ok: boolean };
      assert.equal(answer.ok, false);
      assert.deepEqual(ipc.asked, []);
    });
  }
});
