/**
 * Preview windows the harness borrows over RPC belong to the harness process that borrowed them
 * (PERF-4). A killed harness never runs its `finally` blocks, so every lease it held is given back
 * when it dies and before every restart, while leases the host took for itself (a delegation's
 * window, a build candidate) are left to their own `finally`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { OVERFLOW_WINDOWS_MAX, PreviewPool } from "../../src/substrate/preview-pool.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { hostOf, hostTarget } from "../../src/shared/game-targets.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { GameBoxProblem, NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

/** This host's own desktop destination: a native lease it can run (CI runs Linux and Windows too). */
const HOST_TARGET = hostTarget(hostOf(process.platform) ?? StudioPlatform.Mac);
/** Only a Mac has a box for an agent's headless run; Windows and Linux boxes open only Play windows. */
const HEADLESS_BOX = process.platform === "darwin";
/** The sandbox's answer as the product gives it on this host, for the run's own mode. */
const hostGameBox = (mode: NativeRunMode = NativeRunMode.Window) => HEADLESS_BOX || mode === NativeRunMode.Window;

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
describe("the computers of a harness that ended", () => {
  it("stops the preview.computer sessions on its windows, on a crash and before a restart", async () => {
    const ports = fakePorts();
    const lite = await coreLite({ preview: {} as never, createHeadlessPreview: ports.create, previewPoolMax: 6 });
    lite.core.host.restart = (async () => {}) as never;
    lite.core.host.healthcheck = (async () => true) as never;
    try {
      const { core } = lite;
      const api = lite.api() as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
      const project = "lease-computer";
      await core.games.scaffold(project);
      const root = await realpath(core.games.dirFor(project));
      const released: string[] = [];
      let made = 0;
      // The session a leased window's computer holds: its release ends a Play Protocol game's process.
      core._computerToolsFor = (async () => {
        const id = `session-${++made}`;
        return {
          liveTools: [{ name: "computer", description: "", parameters: { type: "object", properties: {} } }],
          onLiveTool: async () => "ok",
          trace: () => ({}),
          release: async () => {
            released.push(id);
          },
        };
      }) as never;
      const playOn = async () => {
        const { handle } = (await api["preview.acquire"]!({ label: "facet" })) as { handle: string };
        await api["preview.computer"]!({ handle, project, root, describe: true });
        return handle;
      };
      await playOn();
      await core.host.options.onUnexpectedExit!({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
      assert.deepEqual(released, ["session-1"], "a crash stops the dead harness's computer sessions");

      await playOn();
      await core.recover("test wedge");
      assert.deepEqual(released, ["session-1", "session-2"], "a restart stops the old harness's sessions");
    } finally {
      await lite.close();
    }
  });
});

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

/**
 * A native lease (a C++ game's headless run, borrowed with a desktop target) is the harness's like
 * a window: when the harness dies it is given back, and giving it back ends its run. The registry
 * is a scripted stand-in; no game process runs.
 */
describe("harness-borrowed native leases", () => {
  it("a harness that dies gives back its native leases and their runs end", {
    skip: HEADLESS_BOX ? false : "only a Mac's game box runs an agent's headless game",
  }, async (t) => {
    const stopped: string[] = [];
    const ownedStops: string[] = [];
    let started = 0;
    const registry = {
      start: async (request: { project: string; mode: string; owner?: string }) => {
        started++;
        return {
          status: {
            project: request.project,
            runId: `run${started}`,
            mode: request.mode,
            owner: request.owner ?? null,
          },
          port: { studioState: async () => ({}) },
        };
      },
      stop: async (runId: string) => void stopped.push(runId),
      stopAll: async () => {},
      stopAgentRuns: async () => {},
      stopProject: async () => {},
      stopMode: async () => {},
      stopOwnedBy: async (owner: string) => void ownedStops.push(owner),
      state: () => null,
      portOf: () => null,
      front: async () => false,
      sweepOrphans: async () => 0,
      onFocus: () => () => {},
      onStatus: () => () => {},
      reembed: async () => null,
      showEmbedded: () => {},
    };
    const lite = await coreLite({
      preview: {} as never,
      createHeadlessPreview: fakePorts().create,
      createNativeRuns: () => registry as never,
    });
    t.mock.method(lite.core.sandbox, "gameBoxAvailable", hostGameBox);
    lite.core.host.restart = (async () => {}) as never;
    lite.core.host.healthcheck = (async () => true) as never;
    await lite.core.games.scaffold("pong", {
      title: "Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [HOST_TARGET],
    });
    const api = lite.api();
    const { handle } = await api["preview.acquire"]({ label: "evidence", target: HOST_TARGET });
    await api["preview.load"]({ project: "pong", handle });
    const capacity = async () => (await api["preview.capacity"]()).native?.leases;
    assert.equal(await capacity(), 1);
    const died = lite.core.host.options.onUnexpectedExit;
    assert.ok(died);
    await died({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
    assert.equal(await capacity(), 0, "the dead harness's native lease is given back");
    assert.deepEqual(stopped, ["run1"], "and its run ends");
    assert.deepEqual(ownedStops, ["harness:1"], "with every other run that boot's leases started");
  });
});

/**
 * The core asks its sandbox's game box for the mode a run needs: a lease and the judging target are
 * an agent's headless run, so a host whose box opens only Play windows (Windows with the launcher,
 * Linux with a security context) offers neither; and a Play refused for want of a box says why.
 */
describe("the core asks the game box for the run's own mode", () => {
  const own = HOST_TARGET;
  const windowOnly = (mode: NativeRunMode = NativeRunMode.Window) => mode === NativeRunMode.Window;

  it("a native lease is refused no-game-box when the box runs only Play windows, before any run starts", async (t) => {
    let started = 0;
    const lite = await coreLite({
      preview: {} as never,
      createHeadlessPreview: fakePorts().create,
      createNativeRuns: () =>
        ({ start: async () => void started++, sweepOrphans: async () => 0, onFocus: () => () => {} }) as never,
    });
    t.mock.method(lite.core.sandbox, "gameBoxAvailable", windowOnly);
    const asked: NativeRunMode[] = [];
    t.mock.method(lite.core.sandbox, "gameBox", (mode: NativeRunMode) => {
      asked.push(mode);
      return mode === NativeRunMode.Window ? null : GameBoxProblem.NoHeadlessBuild;
    });
    await assert.rejects(
      lite.api()["preview.acquire"]({ label: "evidence", target: own }),
      (error: unknown) =>
        error instanceof NativeError &&
        error.refusal === NativeRefusal.NoGameBox &&
        error.box === GameBoxProblem.NoHeadlessBuild,
    );
    assert.deepEqual(asked, [NativeRunMode.Headless], "the refusal carries the box's reason for a headless run");
    assert.equal(started, 0);
    assert.equal((await lite.api()["preview.capacity"]()).native?.gameBox, false, "nor is a judging target offered");
  });

  it("Play refused for want of a game box carries the sandbox's reason", async (t) => {
    const lite = await coreLite();
    t.mock.method(lite.core.sandbox, "gameBoxAvailable", () => false);
    const asked: NativeRunMode[] = [];
    t.mock.method(lite.core.sandbox, "gameBox", (mode: NativeRunMode) => {
      asked.push(mode);
      return GameBoxProblem.LauncherMissing;
    });
    await lite.core.games.scaffold("pong", {
      title: "Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [own],
    });
    await assert.rejects(
      lite.core.nativeRuns.start({ project: "pong", target: own, mode: NativeRunMode.Window }),
      (error: unknown) =>
        error instanceof NativeError &&
        error.refusal === NativeRefusal.NoGameBox &&
        error.box === GameBoxProblem.LauncherMissing,
    );
    assert.deepEqual(asked, [NativeRunMode.Window]);
  });
});
