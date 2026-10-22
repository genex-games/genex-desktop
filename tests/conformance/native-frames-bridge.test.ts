/**
 * The preload's half of Live's embedded frames (`createStudioBridge(ipc, files, languages, frames)` in
 * `src/preload/studio-bridge.ts`): one `sharedTexture` receiver, registered when the bridge is made
 * and before main can send anything, that hands each frame to the one `nativeFrames` subscriber and
 * then always closes the frame and releases the import. A frame never released holds one of the
 * game's three slots until Electron's sweep (`.studio-dev` m5a RESULTS §4), so every path below
 * ends in exactly one close and one release, in that order.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BridgeFrames, type BridgeIpc, createStudioBridge } from "../../src/preload/studio-bridge.ts";
import type { NativeFrameMeta } from "../../src/shared/native-contract.ts";

/** An `ipcRenderer` stand-in that answers nothing: the frames path never invokes a channel. */
const ipc: BridgeIpc = {
  invoke: async () => ({ ok: true, value: null }),
  on: () => {},
  off: () => {},
};

const META: NativeFrameMeta = {
  project: "pong",
  runId: "0123456789ab",
  generation: 2,
  seq: 41,
  slot: 1,
  width: 1600,
  height: 1200,
};

type Receiver = Parameters<BridgeFrames["setSharedTextureReceiver"]>[0];

/** A fake `sharedTexture` that records its receiver, and one import whose frame and release log in order. */
function fakeFrames() {
  const receivers: Receiver[] = [];
  const frames: BridgeFrames = {
    setSharedTextureReceiver(receiver) {
      receivers.push(receiver);
    },
  };
  const log: string[] = [];
  const frame = {
    close: () => log.push("close"),
  };
  const importedSharedTexture = {
    getVideoFrame: () => {
      log.push("frame");
      return frame;
    },
    release: () => log.push("release"),
  };
  /** Delivers one frame the way Electron calls the receiver: the import, then main's extra arguments. */
  const deliver = (meta: unknown = META) => {
    const receiver = receivers[0];
    assert.ok(receiver, "a receiver was registered");
    return receiver({ importedSharedTexture }, meta);
  };
  return { frames, receivers, log, frame, deliver };
}

describe("the preload's frames receiver", () => {
  it("is registered exactly once, when the bridge is made, and never without sharedTexture", () => {
    const fake = fakeFrames();
    const api = createStudioBridge(ipc, undefined, undefined, fake.frames);
    assert.equal(fake.receivers.length, 1, "registered at creation");
    const off = api.nativeFrames(() => {});
    off();
    api.nativeFrames(() => {});
    assert.equal(fake.receivers.length, 1, "subscribing registers nothing more");

    const plain = createStudioBridge(ipc);
    const unsubscribe = plain.nativeFrames(() => assert.fail("no frames reach a bridge without sharedTexture"));
    assert.equal(typeof unsubscribe, "function");
    assert.doesNotThrow(unsubscribe);
  });

  it("with no subscriber, closes the frame and releases the import once each, before it resolves", async () => {
    const fake = fakeFrames();
    createStudioBridge(ipc, undefined, undefined, fake.frames);
    await fake.deliver();
    assert.deepEqual(fake.log, ["frame", "close", "release"]);
  });

  it("awaits the subscriber's promise before it closes and releases", async () => {
    const fake = fakeFrames();
    const api = createStudioBridge(ipc, undefined, undefined, fake.frames);
    let finish: () => void = () => {};
    const drawn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    api.nativeFrames(() => drawn);
    const delivered = fake.deliver();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.log, ["frame"], "nothing is released while the canvas still draws");
    finish();
    await delivered;
    assert.deepEqual(fake.log, ["frame", "close", "release"]);
  });

  for (const [label, subscriber] of [
    [
      "throws",
      () => {
        throw new Error("the canvas is gone");
      },
    ],
    ["rejects", async () => Promise.reject(new Error("the canvas is gone"))],
  ] as const) {
    it(`still closes and releases once when the subscriber ${label}`, async () => {
      const fake = fakeFrames();
      const api = createStudioBridge(ipc, undefined, undefined, fake.frames);
      api.nativeFrames(subscriber);
      await fake.deliver();
      assert.deepEqual(fake.log, ["frame", "close", "release"]);
    });
  }

  it("releases the import once when its frame cannot be read (a lost GPU process), and draws nothing", async () => {
    const receivers: Receiver[] = [];
    const log: string[] = [];
    createStudioBridge(ipc, undefined, undefined, {
      setSharedTextureReceiver: (receiver) => void receivers.push(receiver),
    }).nativeFrames(() => assert.fail("no frame to draw"));
    const importedSharedTexture = {
      getVideoFrame: () => {
        throw new Error("the import can no longer be mapped");
      },
      release: () => log.push("release"),
    };
    await receivers[0]?.({ importedSharedTexture }, META);
    assert.deepEqual(log, ["release"], "the game's slot is free again");
  });

  it("hands the subscriber the frame and main's meta as sent", async () => {
    const fake = fakeFrames();
    const api = createStudioBridge(ipc, undefined, undefined, fake.frames);
    const heard: Array<[unknown, NativeFrameMeta]> = [];
    api.nativeFrames((frame, meta) => {
      heard.push([frame, meta]);
    });
    await fake.deliver();
    assert.equal(heard.length, 1);
    assert.equal(heard[0]?.[0], fake.frame, "the VideoFrame itself");
    assert.deepEqual(heard[0]?.[1], META);
  });

  it("keeps one subscriber: a second replaces the first, and the first's unsubscribe leaves the second", async () => {
    const fake = fakeFrames();
    const api = createStudioBridge(ipc, undefined, undefined, fake.frames);
    const heard: string[] = [];
    const offFirst = api.nativeFrames(() => {
      heard.push("first");
    });
    api.nativeFrames(() => {
      heard.push("second");
    });
    offFirst();
    await fake.deliver();
    assert.deepEqual(heard, ["second"]);
  });

  it("releases at once again after the subscriber unsubscribes", async () => {
    const fake = fakeFrames();
    const api = createStudioBridge(ipc, undefined, undefined, fake.frames);
    const heard: number[] = [];
    const off = api.nativeFrames((_frame, meta) => {
      heard.push(meta.seq);
    });
    off();
    await fake.deliver();
    assert.deepEqual(heard, []);
    assert.deepEqual(fake.log, ["frame", "close", "release"]);
  });
});
