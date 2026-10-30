/**
 * One leased window at another size, for that lease only (`PreviewPool.resize`, a plugin
 * observer's still at its own size): every other window, Live and the stand-in stay as they are,
 * and the window is back at the facet size when its lease is given back. A size the host cannot
 * honour is refused before anything moves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LIVE_HANDLE, PreviewPool, STAND_IN_HANDLE } from "../../src/substrate/preview-pool.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PreviewGone, previewGone } from "../../src/shared/preview-contract.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** The size every pooled window opens at (`FACET_WINDOW` in main/index.ts). */
const FACET = { width: 960, height: 600 } as const;

interface Size {
  width: number;
  height: number;
}

interface SizedPort {
  id: string;
  size: Size;
  /** Every size this port was asked to take, in order; null is "back to the size it opened at". */
  asked: Array<Size | null>;
  disposedAt: Size | null;
  viewSize(): Size;
  setViewSize(size: Size | null): void;
  dispose(): Promise<void>;
  status(): unknown;
}

function sizedPort(id: string): SizedPort {
  const port: SizedPort = {
    id,
    size: { ...FACET },
    asked: [],
    disposedAt: null,
    viewSize: () => ({ ...port.size }),
    setViewSize(size) {
      port.asked.push(size);
      port.size = size ? { ...size } : { ...FACET };
    },
    async dispose() {
      port.disposedAt = { ...port.size };
    },
    status: () => ({
      project: null,
      url: null,
      crashed: false,
      unresponsive: false,
      loadError: null,
      consoleErrors: 0,
    }),
  };
  return port;
}

function sizedPorts() {
  const made: SizedPort[] = [];
  const live = sizedPort("live");
  const create = async () => {
    const port = sizedPort(`pooled-${made.length}`);
    made.push(port);
    return port as never;
  };
  return { made, live, create, everyPort: () => [live, ...made] };
}

/** Each port's size and requests, so a refusal can prove nothing moved. */
const snapshot = (ports: SizedPort[]) =>
  ports.map((port) => ({ id: port.id, size: port.size, asked: port.asked.length }));

/**
 * A refusal for its own reason: a missing method (a TypeError) never passes for one, so each
 * row fails until the host refuses that input on purpose.
 */
const refusedFor = (reason: RegExp) => (error: unknown) =>
  error instanceof Error && !(error instanceof TypeError) && reason.test(error.message);
const BAD_SIZE = /two finite positive numbers/;
const NO_LEASE = /only a leased pooled window|unknown preview handle/;

/** Sizes the host refuses outright: not a finite positive number. Nothing may move for any of them. */
const HOSTILE: Array<[label: string, width: unknown, height: unknown]> = [
  ["NaN width", Number.NaN, 900],
  ["NaN height", 1600, Number.NaN],
  ["negative width", -1600, 900],
  ["negative height", 1600, -1],
  ["zero", 0, 0],
  ["infinite", Number.POSITIVE_INFINITY, 900],
  ["a string", "1600", 900],
  ["null", null, 900],
  ["missing", undefined, undefined],
  ["an object", { valueOf: () => 1600 }, 900],
  ["a boolean", true, 900],
];

/** Sizes the host honours, clamped to what a window may be. */
const CLAMPED: Array<[asked: Size, applied: Size]> = [
  [
    { width: 1600, height: 900 },
    { width: 1600, height: 900 },
  ],
  [
    { width: 10_000, height: 10_000 },
    { width: 1920, height: 1200 },
  ],
  [
    { width: 1, height: 1 },
    { width: 320, height: 240 },
  ],
  [
    { width: 1600.4, height: 899.6 },
    { width: 1600, height: 900 },
  ],
];

describe("one pooled window at another size", () => {
  it("resizes only the named lease, and the window is the facet size again when it is released", async () => {
    const ports = sizedPorts();
    const pool = new PreviewPool({ live: ports.live as never, createHeadless: ports.create, max: 4 });
    const judge = await pool.acquire({ label: "ship-review" });
    const worker = await pool.acquire({ label: "build:hud" });
    const applied = pool.resize(judge.handle, { width: 1600, height: 900 });
    assert.deepEqual(applied, { width: 1600, height: 900 });
    assert.deepEqual(pool.port(judge.handle).viewSize?.(), { width: 1600, height: 900 });
    assert.deepEqual(pool.port(worker.handle).viewSize?.(), FACET, "a worker's window keeps its size");
    assert.deepEqual(ports.live.asked, [], "Live is never resized");
    await pool.release(judge.handle);
    assert.deepEqual(ports.made[0]?.disposedAt, FACET, "the window is the facet size again before it closes");
    assert.deepEqual(ports.made[1]?.asked, [], "the worker's window was never asked to change");
  });

  it("restores a resized window when every lease is disposed at once", async () => {
    const ports = sizedPorts();
    const pool = new PreviewPool({ live: ports.live as never, createHeadless: ports.create, max: 4 });
    const judge = await pool.acquire({ label: "ship-review" });
    pool.resize(judge.handle, { width: 1600, height: 900 });
    await pool.disposeAll();
    assert.deepEqual(ports.made[0]?.disposedAt, FACET);
  });

  it("a window that was never resized is not asked to restore", async () => {
    const ports = sizedPorts();
    const pool = new PreviewPool({ live: ports.live as never, createHeadless: ports.create, max: 4 });
    const lease = await pool.acquire({ label: "facet" });
    await pool.release(lease.handle);
    assert.deepEqual(ports.made[0]?.asked, []);
  });

  for (const [asked, applied] of CLAMPED) {
    it(`clamps ${asked.width}×${asked.height} to ${applied.width}×${applied.height}`, async () => {
      const ports = sizedPorts();
      const pool = new PreviewPool({ live: ports.live as never, createHeadless: ports.create, max: 4 });
      const lease = await pool.acquire({ label: "ship-review" });
      assert.deepEqual(pool.resize(lease.handle, asked), applied);
      assert.deepEqual(ports.made[0]?.size, applied);
    });
  }

  for (const [label, width, height] of HOSTILE) {
    it(`refuses ${label} and moves nothing`, async () => {
      const ports = sizedPorts();
      const pool = new PreviewPool({ live: ports.live as never, createHeadless: ports.create, max: 4 });
      const lease = await pool.acquire({ label: "ship-review" });
      const before = snapshot(ports.everyPort());
      assert.throws(() => pool.resize(lease.handle, { width, height }), refusedFor(BAD_SIZE));
      assert.deepEqual(snapshot(ports.everyPort()), before);
      await pool.release(lease.handle);
      assert.deepEqual(ports.made[0]?.asked, [], "a refused size leaves nothing to restore");
    });
  }

  it("never resizes Live, the stand-in or a handle that is no lease", async () => {
    const ports = sizedPorts();
    const pool = new PreviewPool({ live: ports.live as never, createHeadless: ports.create, max: 4 });
    await pool.standIn();
    const released = await pool.acquire({ label: "gone" });
    await pool.release(released.handle);
    const before = snapshot(ports.everyPort());
    for (const handle of [LIVE_HANDLE, STAND_IN_HANDLE, "pv-unknown", released.handle, "", "../live"]) {
      assert.throws(() => pool.resize(handle, { width: 1600, height: 900 }), refusedFor(NO_LEASE), handle);
    }
    assert.deepEqual(snapshot(ports.everyPort()), before);
  });

  it("refuses a lease whose window cannot change size, and moves nothing", async () => {
    const pool = new PreviewPool({ live: {} as never, createHeadless: async () => ({}) as never, max: 2 });
    const lease = await pool.acquire({ label: "old-port" });
    assert.throws(() => pool.resize(lease.handle, { width: 1600, height: 900 }), refusedFor(/cannot change size/));
  });
});

describe("why a game window's renderer went away", () => {
  /** Electron's `render-process-gone` reasons, each read as one typed code. */
  const READ: Array<[electron: string, gone: PreviewGone]> = [
    ["killed", PreviewGone.Killed],
    ["oom", PreviewGone.Oom],
    // Evicted to free memory: the machine's pressure, like an out-of-memory kill.
    ["memory-eviction", PreviewGone.Oom],
    ["crashed", PreviewGone.Crashed],
    ["launch-failed", PreviewGone.LaunchFailed],
    ["abnormal-exit", PreviewGone.Abnormal],
    // A renderer that exits on its own while its page is up has still gone abnormally.
    ["clean-exit", PreviewGone.Abnormal],
    ["integrity-failure", PreviewGone.Integrity],
    // A reason a later Electron adds is never mistaken for the machine's doing.
    ["something-new", PreviewGone.Crashed],
    ["constructor", PreviewGone.Crashed],
    ["", PreviewGone.Crashed],
  ];
  for (const [electron, gone] of READ) {
    it(`reads ${electron} as ${gone}`, () => {
      assert.equal(previewGone(electron), gone);
    });
  }

  it("preview.status carries the reason from the window that died", async () => {
    const ports = sizedPorts();
    const lite = await coreLite({
      preview: ports.live as never,
      createHeadlessPreview: ports.create,
      previewPoolMax: 4,
    });
    const api = lite.api() as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
    const { handle } = (await api[HostMethod.PreviewAcquire]!({ label: "facet" })) as { handle: string };
    const dead = ports.made[0]!;
    dead.status = () => ({
      project: "p",
      url: null,
      crashed: true,
      gone: PreviewGone.Killed,
      unresponsive: false,
      loadError: null,
      consoleErrors: 0,
    });
    const status = (await api[HostMethod.PreviewStatus]!({ handle })) as { crashed: boolean; gone: PreviewGone };
    assert.deepEqual([status.crashed, status.gone], [true, PreviewGone.Killed]);
    await lite.close();
  });
});
