/**
 * The developer control channel runs one operation on the app at a time. A `game.state` asked of
 * a page whose start-up never ended never answered: it timed out, yet kept the channel's one slot
 * for good, so every later request, `status` and `stop` included, was refused as busy and the
 * session could neither be inspected nor stopped through the channel. Status and stop never wait
 * for the slot, and an operation past its deadline gives the slot back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operationSlot } from "../../src/main/dev/operation-slot.ts";
import { DevError, DevErrorCode, DevMethod } from "../../src/main/dev/protocol.ts";

/** Timers that fire only when the test says so. */
function heldTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setTimeout: (callback: () => void, _ms: number) => {
        const handle = next++;
        pending.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    },
    expire: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
    armed: () => pending.size,
  };
}

const never = () => new Promise<never>(() => {});
const busyRefusal = (error: unknown) => error instanceof DevError && error.code === DevErrorCode.Busy;

describe("the developer channel's operation slot", () => {
  it("refuses a second operation on the app while one runs", async () => {
    const clock = heldTimers();
    const slot = operationSlot(30_000, clock.timers);
    void slot.run(DevMethod.GameState, never, () => {});
    assert.equal(slot.busy(), true);
    await assert.rejects(
      slot.run(
        DevMethod.GameInput,
        async () => 1,
        () => {},
      ),
      busyRefusal,
    );
  });

  it("answers status and stop while an operation that never ends holds the slot", async () => {
    const clock = heldTimers();
    const slot = operationSlot(30_000, clock.timers);
    void slot.run(DevMethod.GameState, never, () => {});
    assert.equal(
      await slot.run(
        DevMethod.Status,
        async () => "status",
        () => {},
      ),
      "status",
    );
    assert.equal(
      await slot.run(
        DevMethod.Stop,
        async () => "stopping",
        () => {},
      ),
      "stopping",
    );
    assert.equal(slot.busy(), true, "neither took the slot");
  });

  it("gives the slot back when an operation that never ends runs out of time, and says so once", async () => {
    const clock = heldTimers();
    const slot = operationSlot(30_000, clock.timers);
    const timeouts: string[] = [];
    void slot.run(DevMethod.GameState, never, () => timeouts.push("game.state"));
    clock.expire();
    assert.deepEqual(timeouts, ["game.state"]);
    assert.equal(slot.busy(), false);
    assert.equal(
      await slot.run(
        DevMethod.GameInput,
        async () => "next",
        () => {},
      ),
      "next",
    );
  });

  it("never frees the slot of the operation that came after one it gave up on", async () => {
    const clock = heldTimers();
    const slot = operationSlot(30_000, clock.timers);
    let finishStuck: () => void = () => {};
    const stuck = slot.run(
      DevMethod.GameState,
      () => new Promise<void>((resolve) => (finishStuck = resolve)),
      () => {},
    );
    clock.expire();
    void slot.run(DevMethod.GameInput, never, () => {});
    finishStuck();
    await stuck;
    assert.equal(slot.busy(), true, "the late finish left the newer operation's slot alone");
  });

  it("frees the slot and clears its deadline when an operation ends, in success or failure", async () => {
    const clock = heldTimers();
    const slot = operationSlot(30_000, clock.timers);
    assert.equal(
      await slot.run(
        DevMethod.GameState,
        async () => "ok",
        () => {},
      ),
      "ok",
    );
    await assert.rejects(
      slot.run(
        DevMethod.GameState,
        async () => Promise.reject(new Error("page gone")),
        () => {},
      ),
      /page gone/,
    );
    assert.equal(slot.busy(), false);
    assert.equal(clock.armed(), 0);
  });
});
