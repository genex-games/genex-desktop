/**
 * Preview windows the harness borrows over RPC belong to the harness process that borrowed them
 * (PERF-4). A killed harness never runs its `finally` blocks, so every lease it held is given back
 * when it dies and before every restart, while leases the host took for itself (a delegation's
 * window, a build candidate) are left to their own `finally`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { OVERFLOW_WINDOWS_MAX, PreviewPool } from "../../src/substrate/preview-pool.ts";
import { coreLite } from "../helpers/core-lite.ts";

interface FakePort {
  id: number;
  disposed: boolean;
  dispose(): Promise<void>;
}

function fakePorts() {
  const made: FakePort[] = [];
  let gate: Promise<void> | null = null;
  const create = async () => {
    if (gate) await gate;
    const port: FakePort = {
      id: made.length,
      disposed: false,
      async dispose() {
        port.disposed = true;
      },
    };
    made.push(port);
    return port as never;
  };
  return {
    made,
    create,
    hold(until: Promise<void>) {
      gate = until;
    },
    open: () => made.filter((port) => !port.disposed).length,
  };
}

describe("preview pool ownership", () => {
  it("releases only the leases an owner took", async () => {
    const ports = fakePorts();
    const pool = new PreviewPool({ live: {} as never, createHeadless: ports.create, max: 4 });
    const a = await pool.acquire({ label: "facet", owner: "harness:1" });
    const b = await pool.acquire({ label: "facet", owner: "harness:1" });
    const own = await pool.acquire({ label: "delegation" });
    const other = await pool.acquire({ label: "facet", owner: "harness:2" });
    const released = await pool.releaseOwnedBy("harness:1");
    assert.deepEqual(released.sort(), [a.handle, b.handle].sort());
    assert.deepEqual(
      pool
        .leases()
        .map((lease) => lease.handle)
        .sort(),
      [own.handle, other.handle].sort(),
    );
    assert.equal(ports.open(), 2);
  });
});

describe("harness-borrowed preview windows", () => {
  const start = async () => {
    const ports = fakePorts();
    const lite = await coreLite({ preview: {} as never, createHeadlessPreview: ports.create, previewPoolMax: 6 });
    // No harness process in this rig: a restart is a no-op that "boots" healthy.
    lite.core.host.restart = (async () => {}) as never;
    lite.core.host.healthcheck = (async () => true) as never;
    const api = lite.api() as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
    const acquire = async () => ((await api["preview.acquire"]!({ label: "facet" })) as { handle: string }).handle;
    const capacity = async () => (await api["preview.capacity"]!()) as { inUse: number };
    return { ...lite, ports, api, acquire, capacity };
  };

  it("a harness that dies gives back every window it borrowed", async () => {
    const { core, ports, acquire, capacity } = await start();
    await acquire();
    await acquire();
    assert.equal((await capacity()).inUse, 2);
    await core.host.options.onUnexpectedExit!({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
    assert.equal((await capacity()).inUse, 0, "the dead harness's windows are released");
    assert.equal(ports.open(), 0, "and their offscreen pages are disposed");
  });

  it("a window still being opened when the harness dies is released once it arrives", async () => {
    const { core, ports, acquire, capacity } = await start();
    let open!: () => void;
    ports.hold(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    const pending = acquire();
    await core.host.options.onUnexpectedExit!({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
    open();
    await pending.catch(() => {});
    assert.equal((await capacity()).inUse, 0, "a lease for a harness that is gone is not kept");
    assert.equal(ports.open(), 0);
  });

  it("an applied self-update and a watchdog restore release the old harness's windows before the restart", async () => {
    const { core, acquire, capacity } = await start();
    const seen: number[] = [];
    core.host.restart = (async () => {
      seen.push((await capacity()).inUse);
    }) as never;
    await acquire();
    await core.requestSelfRestart("test", 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(seen, [0], "self-update: released before the restart");

    await acquire();
    await acquire();
    await core.recover("test wedge");
    assert.deepEqual(seen, [0, 0], "watchdog: released before the restart");
  });
});

/**
 * A session whose pool was full took a window past the ceiling, with no ceiling of its own: a busy
 * run could open hidden windows without end, and every one is a renderer with a GPU context of
 * its own (Live's WebGL context among the ones Chromium drops first). Past `OVERFLOW_WINDOWS_MAX`
 * a session waits for a window to close, and one that ends while it waits opens none.
 */
describe("windows past the pool's ceiling", () => {
  it("opens at most OVERFLOW_WINDOWS_MAX, then queues sessions until a window closes", async () => {
    const ports = fakePorts();
    const pool = new PreviewPool({ live: {} as never, createHeadless: ports.create, max: 1 });
    await pool.acquire({ label: "builder" });
    const overflow = [];
    for (let i = 0; i < OVERFLOW_WINDOWS_MAX; i++) overflow.push(await pool.acquire({ label: "s", overflow: true }));
    assert.equal(ports.open(), 1 + OVERFLOW_WINDOWS_MAX);
    const order: string[] = [];
    const first = pool.acquire({ label: "first", overflow: true }).then((lease) => {
      order.push("first");
      return lease;
    });
    const second = pool.acquire({ label: "second", overflow: true }).then((lease) => {
      order.push("second");
      return lease;
    });
    await setImmediate();
    assert.equal(ports.open(), 1 + OVERFLOW_WINDOWS_MAX, "the next two wait");
    await pool.release(overflow[0]!.handle);
    await first;
    await setImmediate();
    assert.deepEqual(order, ["first"], "one window closed, one session takes it, in the order they asked");
    assert.equal(ports.open(), 1 + OVERFLOW_WINDOWS_MAX);
    await pool.release(overflow[1]!.handle);
    await second;
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(ports.open(), 1 + OVERFLOW_WINDOWS_MAX);
  });

  it("a session that ends while it waits opens nothing", async () => {
    const ports = fakePorts();
    const pool = new PreviewPool({ live: {} as never, createHeadless: ports.create, max: 0 });
    for (let i = 0; i < OVERFLOW_WINDOWS_MAX; i++) await pool.acquire({ label: "s", overflow: true });
    const ended = new AbortController();
    const waiting = pool.acquire({ label: "late", overflow: true, signal: ended.signal });
    ended.abort(new Error("the session ended"));
    await assert.rejects(waiting, /the session ended/);
    const gone = new AbortController();
    gone.abort(new Error("already over"));
    await assert.rejects(pool.acquire({ label: "over", overflow: true, signal: gone.signal }), /already over/);
    assert.equal(ports.made.length, OVERFLOW_WINDOWS_MAX, "no window was opened for either");
    assert.equal(pool.leaseCount, OVERFLOW_WINDOWS_MAX);
  });

  it("a normal lease is still refused at the ceiling, never queued", async () => {
    const ports = fakePorts();
    const pool = new PreviewPool({ live: {} as never, createHeadless: ports.create, max: 1 });
    await pool.acquire({ label: "builder" });
    await assert.rejects(pool.acquire({ label: "facet" }), /exhausted/);
  });
});
