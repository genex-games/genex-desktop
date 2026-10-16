import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { reloadAndWait } from "../../src/main/smoke/reload.ts";

const TIMEOUT_MS = 100;

function trackedTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return {
    created: t.mock.method(globalThis, "setTimeout"),
    cleared: t.mock.method(globalThis, "clearTimeout"),
  };
}

function assertTimerCleared(timers: ReturnType<typeof trackedTimers>): void {
  assert.equal(timers.created.mock.callCount(), 1);
  assert.equal(timers.cleared.mock.callCount(), 1);
  assert.equal(timers.cleared.mock.calls[0]?.arguments[0], timers.created.mock.calls[0]?.result);
}

test("reload waits for the new document and releases its listener and timer on completion", async (t) => {
  const timers = trackedTimers(t);
  let reloads = 0;
  const contents = Object.assign(new EventEmitter(), { reload: () => reloads++ });
  let completed = false;
  const pending = reloadAndWait(contents, TIMEOUT_MS).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(reloads, 1);
  assert.equal(completed, false, "a reload request has not loaded the new document yet");
  assert.equal(contents.listenerCount("did-finish-load"), 1);
  contents.emit("did-finish-load");
  await pending;
  assert.equal(completed, true);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assertTimerCleared(timers);
});

test("reload arms its load listener before starting navigation", async (t) => {
  const timers = trackedTimers(t);
  const contents = Object.assign(new EventEmitter(), {
    reload: () => {
      assert.equal(contents.listenerCount("did-finish-load"), 1);
      contents.emit("did-finish-load");
    },
  });
  await reloadAndWait(contents, TIMEOUT_MS);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assertTimerCleared(timers);
});

test("reload times out at its deadline and releases its listener and timer", async (t) => {
  const timers = trackedTimers(t);
  const contents = Object.assign(new EventEmitter(), { reload: () => {} });
  const outcome: { state: string; error?: unknown } = { state: "pending" };
  const pending = reloadAndWait(contents, TIMEOUT_MS).then(
    () => {
      outcome.state = "loaded";
    },
    (error: unknown) => {
      outcome.state = "failed";
      outcome.error = error;
    },
  );
  t.mock.timers.tick(TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(outcome.state, "pending");
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(outcome.state, "failed", "a window that never loads must not hang the smoke");
  await pending;
  assert.match(String(outcome.error), /reload.*timed out/i);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assertTimerCleared(timers);
  contents.emit("did-finish-load");
  assert.equal(outcome.state, "failed", "a late document cannot change the timeout result");
});

test("a failed reload preserves its error and releases its listener and timer", async (t) => {
  const timers = trackedTimers(t);
  const failure = new Error("navigation failed");
  const contents = Object.assign(new EventEmitter(), {
    reload: () => {
      throw failure;
    },
  });
  await assert.rejects(reloadAndWait(contents, TIMEOUT_MS), (error: unknown) => error === failure);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assertTimerCleared(timers);
});
