import assert from "node:assert/strict";
import test from "node:test";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { NATIVE_LEASES_MAX } from "../../src/shared/native-contract.ts";
import { PreviewPool } from "../../src/substrate/preview-pool.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";

const live = {} as PreviewPort;
function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("preview pool reserves capacity while a port is being created", async () => {
  const creation = deferred<PreviewPort>();
  let creates = 0;
  const pool = new PreviewPool({
    live,
    max: 1,
    createHeadless: () => {
      creates++;
      return creation.promise;
    },
  });
  const first = pool.acquire({ label: "first" });
  const second = pool.acquire({ label: "second" });
  creation.resolve(live);
  await first;
  await assert.rejects(second, /pool exhausted/);
  assert.equal(creates, 1);
});

test("preview pool holds capacity until disposal completes and duplicate releases await it", async () => {
  const disposal = deferred<void>();
  const port = { dispose: () => disposal.promise } as PreviewPort;
  const pool = new PreviewPool({ live, max: 1, createHeadless: async () => port });
  const lease = await pool.acquire({ label: "first" });
  const releasing = pool.release(lease.handle);
  let done = false;
  const duplicate = pool.release(lease.handle).then(() => {
    done = true;
  });
  const acquiring = pool.acquire({ label: "second" });
  await Promise.resolve();
  assert.equal(done, false);
  disposal.resolve();
  await Promise.all([releasing, duplicate]);
  await assert.rejects(acquiring, /pool exhausted/);
  await pool.acquire({ label: "after cleanup" });
});

test("failed creation returns reserved capacity", async () => {
  let first = true;
  const pool = new PreviewPool({
    live,
    max: 1,
    createHeadless: async () => {
      if (first) {
        first = false;
        throw new Error("creation failed");
      }
      return live;
    },
  });
  await assert.rejects(pool.acquire({ label: "failed" }), /creation failed/);
  await pool.acquire({ label: "retry" });
});

test("disposing the pool waits for an in-flight acquisition and destroys its port", async () => {
  const creation = deferred<PreviewPort>();
  let disposed = 0;
  const pool = new PreviewPool({ live, max: 1, createHeadless: () => creation.promise });
  const acquiring = pool.acquire({ label: "pending" });
  const stopping = pool.disposeAll();
  creation.resolve({
    dispose: async () => {
      disposed++;
    },
  } as PreviewPort);
  await Promise.all([acquiring, stopping]);
  assert.equal(disposed, 1);
  assert.equal(pool.leaseCount, 0);
});

test("failed cleanup retains capacity instead of reusing an uncleared session", async () => {
  const pool = new PreviewPool({
    live,
    max: 1,
    createHeadless: async () =>
      ({
        dispose: async (): Promise<void> => {
          throw new Error("cleanup failed");
        },
      }) as PreviewPort,
  });
  const lease = await pool.acquire({ label: "first" });
  await assert.rejects(pool.release(lease.handle), /cleanup failed/);
  await assert.rejects(pool.acquire({ label: "unsafe replacement" }), /pool exhausted/);
  await assert.rejects(pool.release(lease.handle), /cleanup failed/);
});

/**
 * Native leases (a C++ game's headless run through the native registry) are their own budget:
 * `NATIVE_LEASES_MAX` at once, counted apart from the hidden windows' `max`, and a lease past it
 * waits for one to be given back instead of being refused.
 */
test("native leases are counted apart from the windows' ceiling, and the fifth waits", async () => {
  const made: Array<{ target: string; owner?: string }> = [];
  const pool = new PreviewPool({
    live,
    max: 1,
    createHeadless: async () => ({}) as PreviewPort,
    createNative: async (options) => {
      made.push(options);
      return {} as PreviewPort;
    },
  });
  await pool.acquire({ label: "window" });
  const natives = [];
  for (let i = 0; i < NATIVE_LEASES_MAX; i++)
    natives.push(await pool.acquire({ label: "evidence", target: BuildTarget.Mac, owner: "harness:1" }));
  assert.equal(pool.leaseCount, 1, "windows count only windows");
  assert.equal(pool.nativeLeaseCount, NATIVE_LEASES_MAX);
  await assert.rejects(pool.acquire({ label: "second window" }), /pool exhausted/, "native leases took no window");
  let fifth: string | null = null;
  const waiting = pool.acquire({ label: "fifth", target: BuildTarget.Mac }).then((lease) => {
    fifth = lease.handle;
    return lease;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fifth, null, "the fifth waits");
  assert.equal(made.length, NATIVE_LEASES_MAX);
  const [first, second] = natives;
  assert.ok(first && second);
  await pool.release(first.handle);
  await waiting;
  assert.ok(fifth, "and takes the place given back");
  assert.equal(pool.nativeLeaseCount, NATIVE_LEASES_MAX);
  assert.deepEqual(made[0], { target: BuildTarget.Mac, owner: "harness:1" });
  assert.equal(pool.leaseOf(second.handle)?.target, BuildTarget.Mac);
});

test("a Web target, or none, is a hidden window as before; a pool with no native leases refuses a desktop target", async () => {
  let windows = 0;
  const pool = new PreviewPool({
    live,
    max: 2,
    createHeadless: async () => {
      windows++;
      return {} as PreviewPort;
    },
  });
  const web = await pool.acquire({ label: "web", target: BuildTarget.Web });
  const plain = await pool.acquire({ label: "plain" });
  assert.equal(windows, 2);
  assert.equal(pool.leaseOf(web.handle)?.target, BuildTarget.Web);
  assert.equal(pool.leaseOf(plain.handle)?.target, null, "a lease that named no target says so");
  await assert.rejects(pool.acquire({ label: "mac", target: BuildTarget.Mac }), /native/);
  assert.equal(pool.leaseCount, 2);
});

test("a native lease waiting for room opens nothing once its signal aborts", async () => {
  let made = 0;
  const pool = new PreviewPool({
    live,
    createHeadless: async () => ({}) as PreviewPort,
    createNative: async () => {
      made++;
      return {} as PreviewPort;
    },
  });
  for (let i = 0; i < NATIVE_LEASES_MAX; i++) await pool.acquire({ label: "n", target: BuildTarget.Mac });
  const ended = new AbortController();
  const waiting = pool.acquire({ label: "late", target: BuildTarget.Mac, signal: ended.signal });
  ended.abort(new Error("the session ended"));
  await assert.rejects(waiting, /the session ended/);
  assert.equal(made, NATIVE_LEASES_MAX);
});
