/**
 * A hidden worker window paints only while it is used: any call on its port starts painting, a
 * call still out keeps it painting, and once nothing has called it for the idle time it stops, so
 * a leased window a builder is not looking at costs no frames.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type IdleTimers, paintWhileUsed } from "../../src/substrate/paint-while-used.ts";

/** Timeouts that fire only when the test advances the clock. */
function manualTimers(): IdleTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    setTimeout: (run, ms) => {
      due.set(++next, { at: now + ms, run });
      return next;
    },
    clearTimeout: (handle) => void due.delete(handle as number),
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...due.entries()]) {
        if (timer.at > now) continue;
        due.delete(handle);
        timer.run();
      }
    },
    pending: () => due.size,
  };
}

function painter() {
  const log: string[] = [];
  let painting = true;
  return {
    log,
    painting: () => painting,
    start() {
      painting = true;
      log.push("start");
    },
    stop() {
      painting = false;
      log.push("stop");
    },
  };
}

/** A port with the shapes GamePreview has: an async call, a sync call, a read-only status, a getter. */
class FakePort {
  #shots = 0;
  release: (() => void) | null = null;
  dispose?: () => Promise<void>;
  get shots(): number {
    return this.#shots;
  }
  async screenshot(): Promise<number> {
    return ++this.#shots;
  }
  async load(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  viewSize(): { width: number; height: number } {
    return { width: 960, height: 600 };
  }
  status(): string {
    return "ok";
  }
}

const IDLE_MS = 1000;

describe("paintWhileUsed", () => {
  it("stops painting a window nobody calls once the idle time passes", () => {
    const timers = manualTimers();
    const paint = painter();
    paintWhileUsed(new FakePort(), paint, { idleMs: IDLE_MS, timers });
    timers.advance(IDLE_MS - 1);
    assert.equal(paint.painting(), true);
    timers.advance(1);
    assert.equal(paint.painting(), false);
  });

  it("starts painting again before a call on a resting window runs, and answers what the port answers", async () => {
    const timers = manualTimers();
    const paint = painter();
    const port = paintWhileUsed(new FakePort(), paint, { idleMs: IDLE_MS, timers });
    timers.advance(IDLE_MS);
    assert.equal(paint.painting(), false);
    assert.equal(await port.screenshot(), 1);
    assert.deepEqual(paint.log, ["stop", "start"]);
    assert.equal(port.shots, 1, "getters and private fields read through to the port");
  });

  it("keeps painting while a call is still out, however long it runs, and rests an idle time after it", async () => {
    const timers = manualTimers();
    const paint = painter();
    const port = paintWhileUsed(new FakePort(), paint, { idleMs: IDLE_MS, timers });
    const loading = port.load();
    timers.advance(IDLE_MS * 5);
    assert.equal(paint.painting(), true);
    port.release?.();
    await loading;
    timers.advance(IDLE_MS - 1);
    assert.equal(paint.painting(), true);
    timers.advance(1);
    assert.equal(paint.painting(), false);
  });

  it("restarts the idle time on every call", () => {
    const timers = manualTimers();
    const paint = painter();
    const port = paintWhileUsed(new FakePort(), paint, { idleMs: IDLE_MS, timers });
    timers.advance(IDLE_MS - 1);
    port.viewSize();
    timers.advance(IDLE_MS - 1);
    assert.equal(paint.painting(), true);
    timers.advance(1);
    assert.equal(paint.painting(), false);
  });

  it("does not wake a resting window for a read of its status, and never starts a painter already painting", () => {
    const timers = manualTimers();
    const paint = painter();
    const port = paintWhileUsed(new FakePort(), paint, { idleMs: IDLE_MS, timers });
    port.viewSize();
    assert.deepEqual(paint.log, [], "a painting window is not told to start");
    timers.advance(IDLE_MS);
    assert.equal(port.status(), "ok");
    assert.equal(paint.painting(), false);
  });

  it("drops its timer when the window is disposed, so a closed window is never told to stop", async () => {
    const timers = manualTimers();
    const paint = painter();
    const raw = new FakePort();
    let disposed = 0;
    raw.dispose = async () => {
      disposed++;
    };
    const port = paintWhileUsed(raw, paint, { idleMs: IDLE_MS, timers });
    await port.dispose?.();
    assert.equal(disposed, 1);
    assert.equal(timers.pending(), 0);
    timers.advance(IDLE_MS);
    assert.deepEqual(paint.log, []);
  });

  it("lets the owner set methods on the port after it is wrapped", async () => {
    const timers = manualTimers();
    const paint = painter();
    const port = paintWhileUsed(new FakePort(), paint, { idleMs: IDLE_MS, timers });
    let disposed = 0;
    port.dispose = async () => {
      disposed++;
    };
    await port.dispose();
    assert.equal(disposed, 1);
    assert.equal(timers.pending(), 0);
  });
});
