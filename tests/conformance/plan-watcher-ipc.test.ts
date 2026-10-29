/**
 * The plan watcher's channels into main (`main/ipc/plan-watcher.ts`), driven through the real typed
 * `handle()` with a recording watcher: every channel of the map with the `studio:plan-watcher`
 * prefix is registered, a hostile switch payload is refused before the watcher hears anything, and
 * the channels that reach genex.games, the browser or the secret store are refused in a fixture
 * profile.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerPlanWatcherIpc, type PlanWatcherIpcDeps } from "../../src/main/ipc/plan-watcher.ts";
import { ChannelClass, classifyChannel } from "../../src/main/dev/native-policy.ts";
import { STUDIO_INVOKE_CHANNELS } from "../../src/shared/ipc-channels.ts";
import { AiWatcherSignIn, AiWatcherState, type AiWatcherView } from "../../src/shared/game-ai-watcher.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const studio = { sender: "studio", senderFrame: "main-frame" };

const VIEW: AiWatcherView = {
  enabled: false,
  state: AiWatcherState.Off,
  runners: [],
  codexHeld: false,
  resetsAt: null,
  problem: null,
  signIn: AiWatcherSignIn.SignedOut,
  code: null,
  cliAlso: false,
  lastAnsweredAt: null,
};

function registered(fixture = false) {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture, isStudioUi: () => true },
  );
  const heard: Array<[string, unknown[]]> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      heard.push([name, args]);
      return VIEW;
    };
  const watcher: PlanWatcherIpcDeps["watcher"] = {
    view: record("view"),
    setEnabled: record("setEnabled"),
    signIn: record("signIn"),
    cancelSignIn: record("cancelSignIn"),
    signOut: record("signOut"),
  };
  registerPlanWatcherIpc(handle, { watcher });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(studio, payload);
  };
  return { listeners, invoke, heard };
}

const WATCHER_CHANNELS = Object.keys(STUDIO_INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("studio:plan-watcher"),
);

describe("the plan watcher's registrar", () => {
  it("registers every studio:plan-watcher channel of the map, and only those", () => {
    const { listeners } = registered();
    assert.deepEqual([...listeners.keys()].sort(), [...WATCHER_CHANNELS].sort());
    assert.equal(WATCHER_CHANNELS.length, 5);
  });

  it("hands each call to the watcher", async () => {
    const { invoke, heard } = registered();
    for (const [channel, payload] of [
      ["studio:plan-watcher", undefined],
      ["studio:plan-watcher.switch", { enabled: true }],
      ["studio:plan-watcher.sign-in", undefined],
      ["studio:plan-watcher.cancel", undefined],
      ["studio:plan-watcher.sign-out", undefined],
    ] as const) {
      const result = await invoke(channel, payload);
      assert.equal(result.ok, true, channel);
    }
    assert.deepEqual(heard, [
      ["view", []],
      ["setEnabled", [true]],
      ["signIn", []],
      ["cancelSignIn", []],
      ["signOut", []],
    ]);
  });

  const hostile: unknown[] = [
    undefined,
    null,
    "on",
    { enabled: "true" },
    { enabled: 1 },
    { enabled: true, watcherId: "w_1" },
    { on: true },
    JSON.parse('{"__proto__":{"enabled":true}}'),
  ];
  for (const payload of hostile) {
    it(`refuses the switch payload ${JSON.stringify(payload)} before the watcher hears it`, async () => {
      const { invoke, heard } = registered();
      const result = await invoke("studio:plan-watcher.switch", payload);
      assert.equal(result.ok, false);
      assert.deepEqual(heard, []);
    });
  }
});

describe("the plan watcher's channels in a fixture profile", () => {
  it("reads and cancels from memory; switching, signing in and out are native", () => {
    assert.equal(classifyChannel("studio:plan-watcher"), ChannelClass.FixtureSafe);
    assert.equal(classifyChannel("studio:plan-watcher.cancel"), ChannelClass.FixtureSafe);
    for (const channel of ["studio:plan-watcher.switch", "studio:plan-watcher.sign-in", "studio:plan-watcher.sign-out"])
      assert.equal(classifyChannel(channel), ChannelClass.Native, channel);
  });

  it("a fixture profile refuses the native ones before the watcher hears them", async () => {
    const { invoke, heard } = registered(true);
    for (const channel of [
      "studio:plan-watcher.switch",
      "studio:plan-watcher.sign-in",
      "studio:plan-watcher.sign-out",
    ]) {
      const result = await invoke(channel, channel.endsWith("switch") ? { enabled: true } : undefined);
      assert.equal(result.ok, false, channel);
    }
    assert.deepEqual(heard, []);
    assert.equal((await invoke("studio:plan-watcher")).ok, true);
  });
});
