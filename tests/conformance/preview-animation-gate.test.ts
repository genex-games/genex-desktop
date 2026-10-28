import assert from "node:assert/strict";
import test from "node:test";
import { animationGate } from "../../src/page/animation-gate.ts";

test("hidden previews retain callbacks without any native RAF and resume each once", () => {
  const native = new Map<number, (time: number) => void>();
  let id = 0;
  const gate = animationGate({
    request: (callback) => {
      native.set(++id, callback);
      return id;
    },
    cancel: (key) => {
      native.delete(key);
    },
  });
  const calls: number[] = [];
  gate.request((time) => calls.push(time));
  gate.setVisible(false);
  gate.setVisible(false);
  assert.equal(native.size, 0);
  gate.request((time) => calls.push(time + 1));
  const cancelled = gate.request(() => assert.fail("cancelled callback ran"));
  gate.cancel(cancelled);
  assert.equal(native.size, 0);
  gate.setVisible(true);
  gate.setVisible(true);
  assert.equal(native.size, 2);
  const jobs = [...native.values()];
  native.clear();
  for (const callback of jobs) callback(100);
  assert.deepEqual(calls, [100, 101]);
  gate.setVisible(false);
  gate.setVisible(true);
  assert.equal(native.size, 0);
});

test("a frame callback can hide and queue its next frame without restarting the pump", () => {
  const native = new Map<number, (time: number) => void>();
  let id = 0;
  const gate = animationGate({
    request: (callback) => {
      native.set(++id, callback);
      return id;
    },
    cancel: (key) => {
      native.delete(key);
    },
  });
  let frames = 0;
  const pump = () => {
    frames++;
    gate.setVisible(false);
    gate.request(pump);
  };
  gate.request(pump);
  const first = [...native.values()];
  native.clear();
  first[0]?.(1);
  assert.equal(frames, 1);
  assert.equal(native.size, 0);
  gate.setVisible(true);
  const second = [...native.values()];
  native.clear();
  second[0]?.(2);
  assert.equal(frames, 2);
  assert.equal(native.size, 0);
});

test("a native callback already queued before hide cannot escape the visibility gate", () => {
  let deliver: ((time: number) => void) | undefined;
  const gate = animationGate({
    request: (callback) => {
      deliver = callback;
      return 1;
    },
    cancel: () => {},
  });
  let frames = 0;
  gate.request(() => {
    frames++;
  });
  gate.setVisible(false);
  deliver?.(1);
  assert.equal(frames, 0);
  gate.setVisible(true);
  deliver?.(2);
  assert.equal(frames, 1);
});

test("a cancelled callback from before hide cannot consume the newly armed frame after show", () => {
  const deliveries: Array<(time: number) => void> = [];
  const gate = animationGate({
    request: (callback) => {
      deliveries.push(callback);
      return deliveries.length;
    },
    cancel: () => {},
  });
  const frames: number[] = [];
  gate.request((time) => frames.push(time));
  gate.setVisible(false);
  gate.setVisible(true);
  deliveries[0]?.(1);
  assert.deepEqual(frames, []);
  deliveries[1]?.(2);
  assert.deepEqual(frames, [2]);
});

test("a capped preview lets through at most its rate of frames, each frame whole, and the cap lifts at once", () => {
  let queued: Array<(time: number) => void> = [];
  const gate = animationGate({
    request: (callback) => {
      queued.push(callback);
      return queued.length;
    },
    cancel: () => {},
  });
  const frame = (time: number) => {
    const now = queued;
    queued = [];
    for (const callback of now) callback(time);
  };
  const game: number[] = [];
  const shim: number[] = [];
  const loop = (time: number) => {
    game.push(time);
    gate.request(loop);
  };
  const pump = (time: number) => {
    shim.push(time);
    gate.request(pump);
  };
  gate.request(pump);
  gate.request(loop);
  gate.setMaxFps(30);
  // A 120 Hz display for 100 ms: frames every 8.33 ms.
  for (let n = 0; n <= 12; n++) frame(n * (1000 / 120));
  assert.deepEqual(
    game.map((time) => Math.round(time)),
    [0, 33, 67, 100],
    "about every fourth frame at 120 Hz",
  );
  assert.deepEqual(shim, game, "every callback of a frame shares it");
  gate.setMaxFps(0);
  frame(108.4);
  frame(116.7);
  assert.equal(game.length, 6, "uncapped, every frame runs again");
});
