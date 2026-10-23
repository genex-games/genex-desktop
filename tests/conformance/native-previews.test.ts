/**
 * The previews' native side (C++ · raylib): Live shows a native run only as its embedded Mac build,
 * and the person's Live actions end the runs tied to what Live showed — Reload of a raylib game ends
 * its Play window and embedded runs before the rebuild, and Live switching to another game ends the
 * previous game's — while agents' headless runs are theirs. A Play window's sound follows "Genex or
 * the game window is focused", for that game only; an embedded run is heard only while Live shows
 * it, as Live's own page is, and then instead of that page. The pool's native leases start headless
 * runs through the registry. The registry here is a scripted stand-in (`createNativeRuns`): no game
 * process runs.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { hostOf, hostTarget } from "../../src/shared/game-targets.ts";
import { setTimeout as sleep, setImmediate as tick } from "node:timers/promises";
import {
  NATIVE_LEASES_MAX,
  NativeError,
  NativeRefusal,
  type NativeTimers,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
} from "../../src/shared/native-contract.ts";
import type { NativeRun, NativeRunsHost, NativeStartRequest } from "../../src/main/core/native-runs.ts";
import { MAC_CAPTURE_LEASE_WAIT_MS } from "../../src/main/core/previews.ts";
import type { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import { CAPTURE_MANIFEST_VERSION } from "../../src/shared/build-preview.ts";
import { latestBuildPreview } from "../../src/substrate/build-preview.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { LiveBehindReason } from "../../src/shared/live-behind.ts";

/** This host's own desktop destination: the native leases and runs here are the ones it can run (CI runs Linux and Windows too). */
const HOST_TARGET = hostTarget(hostOf(process.platform) ?? StudioPlatform.Mac);

/** Only a Mac has a box for an agent's headless run; Windows and Linux boxes open only Play windows. */
const HEADLESS_BOX = process.platform === "darwin";
/** The sandbox's answer as the product gives it on this host, for the run's own mode. */
const hostGameBox = (mode: NativeRunMode = NativeRunMode.Window) => HEADLESS_BOX || mode === NativeRunMode.Window;
/** A native lease starts a headless run, which only a host with a headless box offers (`preview-leases` covers the refusal). */
const LEASES_RUN_HERE = { skip: HEADLESS_BOX ? false : "only a Mac's game box runs an agent's headless game" };

/** A run's port as far as the previews reach it: what it was told. */
interface FakeRunPort {
  visible: boolean[];
  muted: boolean[];
}

/** Where a scripted run's capture comes from, as the native port reports it (its run id is the run's own). */
const NATIVE_PROVENANCE = {
  seq: 7,
  digest: "f".repeat(16),
  camera: "default",
  build: { stack: GameStack.RaylibCpp, target: HOST_TARGET, digest: "d".repeat(64), lock: null },
} as const;

/** A scripted registry: it records what it is asked and runs nothing. */
function fakeRegistry() {
  const events: string[] = [];
  const ports = new Map<string, FakeRunPort>();
  const portFor = (project: string, mode: string): FakeRunPort => {
    const key = `${project}/${mode}`;
    const port = ports.get(key) ?? { visible: [], muted: [] };
    ports.set(key, port);
    return port;
  };
  let focus: ((run: NativeRunStatus, focused: boolean) => void) | null = null;
  const statusListeners = new Set<(run: NativeRunStatus) => void>();
  /** The games with an embedded run, as `embedOf` started them. */
  const embedded = new Set<string>();
  const shown: Array<[string, boolean]> = [];
  const started: NativeStartRequest[] = [];
  const stopped: string[] = [];
  /** The runs started and not stopped: the games that would be running. */
  const live = new Set<string>();
  /** Games whose build fails: their start is refused `build-failed`, as native-prepare refuses one. */
  const failing = new Set<string>();
  /** While gated, a start waits for `open()`, or rejects when its signal aborts (as the registry's does). */
  let gated = false;
  const gates: Array<() => void> = [];
  const waitForGate = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      gates.push(resolve);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const status = (request: NativeStartRequest, runId: string): NativeRunStatus => ({
    project: request.project,
    runId,
    target: request.target,
    state: NativeRunState.Ready,
    mode: request.mode,
    pid: 1,
    backend: null,
    refusal: null,
    problem: null,
    exit: null,
    owner: request.owner ?? null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
  });
  const asPort = (fake: FakeRunPort, runId = "run") =>
    ({
      setVisible: (visible: boolean) => fake.visible.push(visible),
      setAudioMuted: (muted: boolean) => fake.muted.push(muted),
      studioState: async () => ({ tick: 1 }),
      studioCall: async () => [],
      consoleEntries: () => [],
      status: () => ({
        project: null,
        url: null,
        crashed: false,
        unresponsive: false,
        loadError: null,
        consoleErrors: 0,
      }),
      // The game's own capture, with the provenance a native port gives it.
      screenshotWithStats: async () => ({
        jpeg: Buffer.from([0xff, 0xd8, 0xff, 1]),
        stats: { width: 4, height: 4, sampled: 16, meanLuma: 40, litFraction: 0.5, canvas: true },
        surface: CaptureSurface.Canvas,
        provenance: { ...NATIVE_PROVENANCE, runId },
      }),
    }) as unknown as NativeGamePort;
  const host: NativeRunsHost = {
    start: async (request) => {
      started.push(request);
      const runId = `run${started.length}`;
      if (gated) await waitForGate(request.signal);
      if (failing.has(request.project)) throw new NativeError(NativeRefusal.BuildFailed, "the Mac build failed");
      live.add(runId);
      const run: NativeRun = {
        status: status(request, runId),
        port: asPort(portFor(request.project, request.mode), runId),
      };
      return run;
    },
    stop: async (runId) => {
      stopped.push(runId);
      live.delete(runId);
    },
    stopAll: async () => void events.push("stopAll"),
    stopAgentRuns: async () => void events.push("stopAgentRuns"),
    stopProject: async (project, modes) => void events.push(`stopProject ${project} ${[...modes].join(",")}`),
    stopMode: async (mode) => void events.push(`stopMode ${mode}`),
    stopOwnedBy: async (owner) => void events.push(`stopOwnedBy ${owner}`),
    state: (project, mode) => {
      const ours = mode === NativeRunMode.Embedded && embedded.has(project);
      return ours ? status({ project, target: HOST_TARGET, mode }, `${project}-embedded`) : null;
    },
    portOf: (project, mode) => (mode && ports.has(`${project}/${mode}`) ? asPort(portFor(project, mode)) : null),
    front: async () => false,
    sweepOrphans: async () => 0,
    onFocus: (listener) => {
      focus = listener;
      return () => {};
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    embed: async () => {
      throw new Error("the previews never embed");
    },
    resize: () => false,
    input: async () => false,
    showEmbedded: (project, visible) => void shown.push([project, visible]),
    kill: () => {},
  };
  /** `project`'s embedded run is ready, as the registry announces it. */
  const embedOf = (project: string) => {
    embedded.add(project);
    portFor(project, NativeRunMode.Embedded);
    const ready = status({ project, target: HOST_TARGET, mode: NativeRunMode.Embedded }, `${project}-embedded`);
    for (const listener of statusListeners) listener(ready);
  };
  const focusOf = (project: string, mode: NativeRunMode, focused: boolean) => {
    assert.ok(focus, "the previews listen to native focus");
    focus(status({ project, target: HOST_TARGET, mode }, "focused"), focused);
  };
  const gate = (on: boolean) => {
    gated = on;
  };
  const open = () => {
    for (const resolve of gates.splice(0)) resolve();
  };
  return { host, events, ports, portFor, started, stopped, live, gate, open, focusOf, embedOf, shown, failing };
}

/** A Live view that records what it was told. */
function recordingLive() {
  const muted: boolean[] = [];
  const loads: string[] = [];
  const live = {
    load: async (project: string) => {
      loads.push(project);
      return `game://${project}/index.html`;
    },
    reload: async () => {},
    note: () => {},
    screenshot: async () => Buffer.alloc(0),
    evaluate: async () => null,
    studioState: async () => ({}),
    studioCall: async () => ({}),
    input: async () => ({ ok: true, applied: 0, width: 1, height: 1 }),
    consoleEntries: () => [],
    status: () => ({
      project: null,
      url: null,
      crashed: false,
      unresponsive: false,
      loadError: null,
      consoleErrors: null,
    }),
    setAudioMuted: (value: boolean) => void muted.push(value),
    setVisible: () => {},
    setObserved: () => {},
    profile: async () => ({ sessionId: "s1" }),
  } satisfies PreviewPort;
  return { live, muted, loads };
}

/** A clock that moves only when `advance` says so: timers fire once their time has passed. */
function manualTimers() {
  let now = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      next += 1;
      due.set(next, { at: now + ms, run });
      return next;
    },
    clearTimeout: (handle) => void due.delete(handle as number),
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [handle, timer] of [...due]) {
      if (timer.at > now) continue;
      due.delete(handle);
      timer.run();
    }
  };
  return { timers, advance, pending: () => due.size };
}

async function rig(t: TestContext, options: { nativeTimers?: NativeTimers } = {}) {
  const registry = fakeRegistry();
  const { live, muted: liveMuted } = recordingLive();
  const lite = await coreLite({
    preview: live,
    createHeadlessPreview: async () => recordingLive().live,
    createNativeRuns: () => registry.host,
    ...options,
  });
  t.mock.method(lite.core.sandbox, "gameBoxAvailable", hostGameBox);
  const { core } = lite;
  for (const name of ["pong", "tetris"])
    await core.games.scaffold(name, {
      title: name,
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, HOST_TARGET],
    });
  return { ...lite, registry, liveMuted };
}

describe("Live's actions end the native runs tied to what it showed", () => {
  it("Live Reload of a raylib game stops its window and embedded runs before the rebuild", async (t) => {
    const { core, registry } = await rig(t);
    await core.loadPreview({ project: "pong" });
    const builds = t.mock.method(core.cppBuilds, "ensure", async () => {
      registry.events.push("build");
      return { ok: false, output: null, lastGood: null, problem: null, ran: false };
    });
    registry.events.length = 0;
    await core.reloadLive();
    assert.ok(builds.mock.callCount() > 0, "Reload rebuilt the game");
    assert.equal(registry.events[0], `stopProject pong ${NativeRunMode.Window},${NativeRunMode.Embedded}`);
    assert.ok(registry.events.indexOf("build") > 0, "the stop came before the rebuild");
  });

  it("Live Reload of a change held for Live stops its window and embedded runs before loading it", async (t) => {
    const { core, registry } = await rig(t);
    await core.loadPreview({ project: "pong" });
    await core.offerLive({ project: "pong", root: null, note: null });
    assert.equal((await core.liveState("pong")).reason, LiveBehindReason.Changed, "the change waits for Reload");
    const builds = t.mock.method(core.cppBuilds, "ensure", async () => {
      registry.events.push("build");
      return { ok: false, output: null, lastGood: null, problem: null, ran: false };
    });
    registry.events.length = 0;
    await core.reloadLive();
    assert.ok(builds.mock.callCount() > 0, "Reload built the held change");
    // Live's Native view starts the Mac build again only once Reload ended the run it showed.
    assert.equal(registry.events[0], `stopProject pong ${NativeRunMode.Window},${NativeRunMode.Embedded}`);
    assert.ok(registry.events.indexOf("build") > 0, "the stop came before the build");
  });

  it("Live switching to another game stops the previous game's window and embedded runs, and leaves its headless runs", async (t) => {
    const { core, registry } = await rig(t);
    await core.loadPreview({ project: "pong" });
    assert.deepEqual(registry.events, [], "the first game stops nothing");
    await core.loadPreview({ project: "tetris" });
    assert.deepEqual(registry.events, [`stopProject pong ${NativeRunMode.Window},${NativeRunMode.Embedded}`]);
    await core.loadPreview({ project: "tetris" });
    assert.equal(registry.events.length, 1, "loading the same game again is no switch");
  });

  it("a harness loading a game into a hidden window is no game switch", async (t) => {
    const { core, registry } = await rig(t);
    await core.loadPreview({ project: "pong" });
    const lease = await core.api()["preview.acquire"]({ label: "evidence", target: BuildTarget.Web });
    await core.loadPreview({ project: "tetris", handle: lease.handle }).catch(() => "");
    assert.deepEqual(registry.events, []);
  });
});

describe("a Play window's sound", () => {
  it("is heard while Genex or that game's window is in front, with the switch on", async (t) => {
    const { core, registry } = await rig(t);
    const window = registry.portFor("pong", NativeRunMode.Window);
    core.previewSound({ on: true });
    registry.focusOf("pong", NativeRunMode.Window, true);
    core.previewForeground(false);
    assert.equal(window.muted.at(-1), false, "its own window is in front");
    registry.focusOf("pong", NativeRunMode.Window, false);
    assert.equal(window.muted.at(-1), true, "Genex and the window are both behind another app");
    core.previewForeground(true);
    assert.equal(window.muted.at(-1), false, "Genex is in front");
    core.previewSound({ on: false });
    assert.equal(window.muted.at(-1), true, "the switch is off");
  });

  it("a game playing in Live and in its own window is heard once: Live while Genex is in front, the window while it is focused", async (t) => {
    const { core, registry, liveMuted } = await rig(t);
    // Live plays pong's web build: the lane answers a built page.
    const out = await tmpDir("native-previews-out-");
    await writeFile(path.join(out, "index.html"), "<!doctype html>");
    t.mock.method(core.cppBuilds, "ensure", async () => ({
      ok: true,
      output: out,
      lastGood: out,
      problem: null,
      ran: true,
    }));
    await core.loadPreview({ project: "pong" });
    const window = registry.portFor("pong", NativeRunMode.Window);
    core.previewSound({ on: true });
    core.previewForeground(true);
    registry.focusOf("pong", NativeRunMode.Window, false);
    assert.deepEqual(
      [liveMuted.at(-1), window.muted.at(-1)],
      [false, true],
      "Genex in front: Live is heard, the window not",
    );
    registry.focusOf("pong", NativeRunMode.Window, true);
    core.previewForeground(false);
    assert.deepEqual(
      [liveMuted.at(-1), window.muted.at(-1)],
      [true, false],
      "the window focused: it is heard, Live not",
    );
    await core.previewStageVisible(false);
    registry.focusOf("pong", NativeRunMode.Window, false);
    core.previewForeground(true);
    assert.equal(window.muted.at(-1), false, "Live hidden (Builds or Assets): the window is the one heard");
  });

  it("a game without Browser plays nothing in Live: its Play window is heard while Genex is in front", async (t) => {
    const { core, registry } = await rig(t);
    await core.games.scaffold("mac-only", {
      title: "mac-only",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [HOST_TARGET],
    });
    await core.loadPreview({ project: "mac-only" });
    const window = registry.portFor("mac-only", NativeRunMode.Window);
    core.previewSound({ on: true });
    core.previewForeground(true);
    registry.focusOf("mac-only", NativeRunMode.Window, false);
    assert.equal(window.muted.at(-1), false, "Live shows a card, so the window is the one heard");
  });

  it("another game's window, or a forged focus from a headless run, changes nothing", async (t) => {
    const { core, registry } = await rig(t);
    const pong = registry.portFor("pong", NativeRunMode.Window);
    core.previewSound({ on: true });
    registry.focusOf("pong", NativeRunMode.Window, false);
    core.previewForeground(false);
    const before = [...pong.muted];
    assert.equal(before.at(-1), true);
    registry.focusOf("pong", NativeRunMode.Headless, true);
    registry.focusOf("tetris", NativeRunMode.Window, true);
    assert.equal(pong.muted.at(-1), true, "pong stays muted");
  });
});

describe("a game's Mac build inside Live", () => {
  it("is heard only while Live shows it: on screen, Genex in front, the switch on; Live's page is not heard meanwhile", async (t) => {
    const { core, registry, liveMuted } = await rig(t);
    await core.loadPreview({ project: "pong" });
    core.previewSound({ on: true });
    core.previewForeground(true);
    registry.embedOf("pong");
    const embedded = registry.portFor("pong", NativeRunMode.Embedded);
    assert.equal(embedded.muted.at(-1), false, "Live shows it");
    assert.equal(liveMuted.at(-1), true, "one copy of the game is heard: not Live's page");
    core.previewForeground(false);
    assert.equal(embedded.muted.at(-1), true, "Genex is behind another app");
    core.previewForeground(true);
    await core.previewStageVisible(false);
    assert.equal(embedded.muted.at(-1), true, "Live is hidden (Builds or Assets)");
    assert.deepEqual(registry.shown.at(-1), ["pong", false], "and rests");
    await core.previewStageVisible(true);
    assert.equal(embedded.muted.at(-1), false);
    core.previewSound({ on: false });
    assert.equal(embedded.muted.at(-1), true, "the switch is off");
  });

  it("outvoices the same game's Play window as Live's page does: the window is heard only while it has the focus", async (t) => {
    const { core, registry } = await rig(t);
    await core.loadPreview({ project: "pong" });
    core.previewSound({ on: true });
    core.previewForeground(true);
    registry.embedOf("pong");
    const window = registry.portFor("pong", NativeRunMode.Window);
    const embedded = registry.portFor("pong", NativeRunMode.Embedded);
    registry.focusOf("pong", NativeRunMode.Window, false);
    assert.deepEqual([embedded.muted.at(-1), window.muted.at(-1)], [false, true], "Genex in front: Live's run");
    registry.focusOf("pong", NativeRunMode.Window, true);
    core.previewForeground(false);
    assert.deepEqual([embedded.muted.at(-1), window.muted.at(-1)], [true, false], "the window focused: the window");
  });

  it("an embedded run's status reaches the stage's sight: a run that starts while Live is hidden rests at once", async (t) => {
    const { core, registry } = await rig(t);
    await core.loadPreview({ project: "pong" });
    await core.previewStageVisible(false);
    registry.shown.length = 0;
    registry.embedOf("pong");
    assert.deepEqual(registry.shown, [["pong", false]]);
  });
});

describe("native leases", () => {
  it(
    "a lease for a desktop target starts a headless run through the registry, owned by the harness",
    LEASES_RUN_HERE,
    async (t) => {
      const { core, registry } = await rig(t);
      const api = core.api();
      const { handle } = await api["preview.acquire"]({ label: "evidence", target: HOST_TARGET });
      const url = await api["preview.load"]({ project: "pong", handle });
      assert.match(url, /^native:\/\/pong\//);
      assert.deepEqual(
        registry.started.map(({ project, target, mode, owner }) => ({ project, target, mode, owner })),
        [{ project: "pong", target: HOST_TARGET, mode: NativeRunMode.Headless, owner: "harness:1" }],
      );
      assert.deepEqual(await api["preview.state"]({ handle }), { tick: 1 }, "the run's port answers the senses");
      await api["preview.release"]({ handle });
      assert.deepEqual(registry.stopped, ["run1"], "giving the lease back stops its run");
    },
  );

  /** Waits until `done()` holds: the core reads the library and checks roots on real I/O first. */
  async function until(done: () => boolean): Promise<void> {
    for (let wait = 0; wait < 400 && !done(); wait++) await sleep(5);
    assert.ok(done(), "it happened");
  }

  it(
    "a lease given back while its game still starts leaves no game running, and four live games stay the most",
    LEASES_RUN_HERE,
    async (t) => {
      const { core, registry } = await rig(t);
      const api = core.api();
      registry.gate(true);
      const { handle } = await api["preview.acquire"]({ label: "evidence", target: HOST_TARGET });
      const loading = api["preview.load"]({ project: "pong", handle }).then(
        () => null,
        (error: unknown) => error,
      );
      await until(() => registry.started.length === 1);
      await api["preview.release"]({ handle });
      registry.open();
      assert.ok(await loading, "the load is cancelled");
      await until(() => registry.live.size === 0);
      const capacity = (await api["preview.capacity"]()) as { native: { leases: number } };
      assert.equal(capacity.native.leases, 0, "its slot is free again");
      registry.gate(false);
      const held: string[] = [];
      for (let lease = 0; lease < NATIVE_LEASES_MAX; lease++) {
        const next = await api["preview.acquire"]({ label: `evidence ${lease}`, target: HOST_TARGET });
        await api["preview.load"]({ project: "pong", handle: next.handle });
        held.push(next.handle);
      }
      assert.equal(registry.live.size, NATIVE_LEASES_MAX);
      let fifth = false;
      const waiting = api["preview.acquire"]({ label: "fifth", target: HOST_TARGET }).then((lease) => {
        fifth = true;
        return lease;
      });
      for (let turn = 0; turn < 50; turn++) await tick();
      assert.equal(fifth, false, "a fifth lease waits while four games run");
      await api["preview.release"]({ handle: held[0] ?? "" });
      const late = await waiting;
      for (const handleHeld of [...held.slice(1), late.handle]) await api["preview.release"]({ handle: handleHeld });
      assert.equal(registry.live.size, 0);
    },
  );

  it("native.stop cancels its lease's load while the game still starts", LEASES_RUN_HERE, async (t) => {
    const { core, registry } = await rig(t);
    const api = core.api();
    registry.gate(true);
    const { handle } = await api["preview.acquire"]({ label: "evidence", target: HOST_TARGET });
    const loading = api["preview.load"]({ project: "pong", handle }).then(
      () => null,
      (error: unknown) => error,
    );
    await until(() => registry.started.length === 1);
    assert.equal(await api["native.stop"]({ project: "pong", handle }), true, "it stopped the load");
    registry.open();
    assert.ok(await loading, "the load is cancelled");
    assert.equal(registry.live.size, 0);
    await api["preview.release"]({ handle });
  });
});

describe("what agent processes may read", () => {
  it("no agent or build process reads a native run's bundle or state: the runs root is read-denied as well as write-denied", async (t) => {
    // A run's bundle holds the game's copied assets; were a file from outside the game ever to
    // reach one, an agent reading it there would read what its own sandbox denies elsewhere.
    const { core } = await rig(t);
    assert.ok(core.sandbox.policy.denyRead.includes(core.layout.nativeRuns), "read-denied");
    assert.ok(core.sandbox.policy.denyWrite.includes(core.layout.nativeRuns), "write-denied");
  });
});

describe("the optimizer's profile", () => {
  it("a candidate load on a native lease is refused and starts nothing", LEASES_RUN_HERE, async (t) => {
    // A profiling load builds a candidate's web build: on a headless native run's lease it would
    // start a Mac run on the web build's out/ folder, with no profiler to read.
    const { core, registry } = await rig(t);
    const revision = { snapshotId: null, commit: "c0ffee", tree: "7ree" };
    const sources = t.mock.method(core.candidates, "source", async () => ({
      root: core.games.dirFor("pong"),
      project: "pong",
      runId: "run_opt",
    }));
    const webBuilds = t.mock.method(core.cppBuilds, "ensure", async () => ({
      ok: false,
      output: null,
      lastGood: null,
      problem: null,
      ran: false,
    }));
    const api = core.api();
    const lease = await api["preview.acquire"]({
      label: "optimization",
      purpose: "optimization",
      target: HOST_TARGET,
    });
    const refused = await api["preview.load"]({
      project: "pong",
      handle: lease.handle,
      candidateId: "cand1",
      revision,
    }).then(
      () => null,
      (error: unknown) => error as { refusal?: string },
    );
    assert.ok(refused, "the profiling load was refused");
    assert.equal(refused.refusal, NativeRefusal.Unsupported);
    assert.deepEqual(registry.started, [], "no native run started");
    assert.equal(webBuilds.mock.callCount(), 0, "nothing was built");
    assert.equal(sources.mock.callCount(), 0, "no candidate was read");
    await api["preview.release"]({ handle: lease.handle });
  });

  it("is refused while a native lease is held, as while another window is", LEASES_RUN_HERE, async (t) => {
    const { core } = await rig(t);
    await core.games.scaffold("web", { title: "web" });
    const revision = { snapshotId: null, commit: "c0ffee", tree: "7ree" };
    t.mock.method(core.candidates, "source", async () => ({
      root: core.games.dirFor("web"),
      project: "web",
      runId: "run_opt",
    }));
    t.mock.method(core.builds, "ensure", async () => ({
      ok: false,
      output: null,
      lastGood: null,
      problem: null,
      ran: false,
    }));
    const api = core.api();
    const stage = await api["preview.acquire"]({ label: "optimization", purpose: "optimization" });
    await api["preview.load"]({ project: "web", handle: stage.handle, candidateId: "cand1", revision });
    const begin = {
      action: "begin",
      runId: "run_opt",
      stageId: "optimization",
      scenarioId: "steady",
      handle: stage.handle,
      expectedRevision: revision,
      warmupMs: 0,
      sampleMs: 0,
    } as const;
    assert.deepEqual(await api["preview.profile"](begin), { sessionId: "s1" }, "alone, the stage profiles");
    const native = await api["preview.acquire"]({ label: "evidence", target: HOST_TARGET });
    const refused = (await api["preview.profile"](begin)) as { sessionId: string | null; reason?: string };
    assert.equal(refused.sessionId, null, "a game running beside it would skew the profile");
    assert.ok(refused.reason);
    await api["preview.release"]({ handle: native.handle });
    await api["preview.release"]({ handle: stage.handle });
  });
});

/**
 * A C++ builder checks every destination its game is made for (BUGS ACC-10): its capture names the
 * one it looks at. `macos` builds the Mac build and runs it headless through a lease of the
 * session's own, given back when the session ends; a destination the game is not made for is said
 * and nothing runs. The registry is the scripted stand-in: no game process runs.
 */
describe("a C++ builder's capture looks at the destination it names", {
  skip: process.platform !== "darwin" && "a builder's Mac capture runs on a Mac",
}, () => {
  it("runs the Mac build headless for macos, refuses others, and gives the run back", async (t) => {
    const { core, registry } = await rig(t);
    await core.games.scaffold("pong-web", {
      title: "pong-web",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web],
    });
    const answers: string[] = [];
    core.engines.register({
      id: "fake",
      label: "fake",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: { onCapture?: (args: { cameras?: string; target?: string }) => Promise<string> }) => {
        assert.ok(request.onCapture, "a builder has eyes");
        answers.push(await request.onCapture({ cameras: "default", target: BuildTarget.Mac }));
        answers.push(await request.onCapture({ target: "ios" }));
        return { ok: true, engine: "fake", turns: 1, usage: {}, summary: "done" };
      },
    } as never);
    const delegate = core.api()["engine.delegate"] as (p: unknown) => Promise<unknown>;
    await delegate({
      engine: "fake",
      project: "pong",
      prompt: "build",
      selfCapture: { project: "pong", root: core.games.dirFor("pong") },
    });
    assert.deepEqual(
      registry.started.map((request) => [request.project, request.target, request.mode]),
      [["pong", BuildTarget.Mac, NativeRunMode.Headless]],
      "one headless run of the Mac build",
    );
    assert.match(answers[0] ?? "", /^Captured your CURRENT Mac build/, answers[0]);
    assert.match(answers[1] ?? "", /not one of this game's destinations/, answers[1]);
    assert.equal(registry.live.size, 0, "the session's Mac run ended with it");

    answers.length = 0;
    core.engines.register({
      id: "fake-web",
      label: "fake-web",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: { onCapture?: (args: { cameras?: string; target?: string }) => Promise<string> }) => {
        answers.push(await request.onCapture!({ target: BuildTarget.Mac }));
        return { ok: true, engine: "fake-web", turns: 1, usage: {}, summary: "done" };
      },
    } as never);
    await delegate({
      engine: "fake-web",
      project: "pong-web",
      prompt: "build",
      selfCapture: { project: "pong-web", root: core.games.dirFor("pong-web") },
    });
    assert.match(answers[0] ?? "", /not one of this game's destinations/, answers[0]);
    assert.equal(registry.started.length, 1, "a game made for the browser alone runs no Mac build");
  });

  it("with every Mac run taken, waits on the core's clock, says so, keeps no lease, and a later capture runs", async (t) => {
    const clock = manualTimers();
    const { core, registry } = await rig(t, { nativeTimers: clock.timers });
    const api = core.api();
    const held: string[] = [];
    for (let lease = 0; lease < NATIVE_LEASES_MAX; lease++) {
      const next = await api["preview.acquire"]({ label: `evidence ${lease}`, target: HOST_TARGET });
      await api["preview.load"]({ project: "tetris", handle: next.handle });
      held.push(next.handle);
    }
    const answers: string[] = [];
    let settled = false;
    core.engines.register({
      id: "fake",
      label: "fake",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: { onCapture?: (args: { cameras?: string; target?: string }) => Promise<string> }) => {
        const capture = () => request.onCapture?.({ cameras: "default", target: BuildTarget.Mac }) ?? "";
        const first = Promise.resolve(capture()).then((answer) => {
          settled = true;
          return answer;
        });
        // The core reads the library on real I/O before it asks for a run: wait until the wait is armed.
        for (let turn = 0; turn < 400 && clock.pending() === 0; turn++) await sleep(5);
        clock.advance(MAC_CAPTURE_LEASE_WAIT_MS - 1);
        for (let turn = 0; turn < 50; turn++) await tick();
        assert.equal(settled, false, "it waits while the night's checks hold every Mac run");
        clock.advance(1);
        for (let turn = 0; turn < 50 && !settled; turn++) await tick();
        assert.equal(settled, true, "the wait ends by the core's clock, not the wall's");
        answers.push(await first);
        await api["preview.release"]({ handle: held.pop() ?? "" });
        answers.push(await capture());
        return { ok: true, engine: "fake", turns: 1, usage: {}, summary: "done" };
      },
    } as never);
    const delegate = core.api()["engine.delegate"] as (p: unknown) => Promise<unknown>;
    await delegate({
      engine: "fake",
      project: "pong",
      prompt: "build",
      selfCapture: { project: "pong", root: core.games.dirFor("pong") },
    });
    assert.match(answers[0] ?? "", /^No Mac run is free right now/, answers[0]);
    assert.match(answers[1] ?? "", /^Captured your CURRENT Mac build/, answers[1]);
    for (const handle of held) await api["preview.release"]({ handle });
    for (let turn = 0; turn < 200 && registry.live.size > 0; turn++) await tick();
    assert.equal(registry.live.size, 0, "every run ended");
    const capacity = (await api["preview.capacity"]()) as { native: { leases: number } };
    assert.equal(capacity.native.leases, 0, "no lease was kept by the capture that waited");
    assert.equal(clock.pending(), 0, "no wait is left on the clock");
  });
  it("saves the Mac frame's manifest beside it: the run, the worker, the commit and the native run's provenance", async (t) => {
    const { core } = await rig(t);
    const answers: string[] = [];
    core.engines.register({
      id: "fake",
      label: "fake",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: { onCapture?: (args: { cameras?: string; target?: string }) => Promise<string> }) => {
        const { onCapture } = request;
        assert.ok(onCapture, "a builder has eyes");
        answers.push(await onCapture({ cameras: "default", target: BuildTarget.Mac }));
        return { ok: true, engine: "fake", turns: 1, usage: {}, summary: "done" };
      },
    } as never);
    const runId = "run_mac";
    await (core.api()["engine.delegate"] as (p: unknown) => Promise<unknown>)({
      engine: "fake",
      project: "pong",
      prompt: "build",
      selfCapture: { project: "pong", root: core.games.dirFor("pong"), runId, facetId: "paddle", iteration: 2 },
    });
    assert.match(answers[0] ?? "", /c1_default\.jpg/, answers[0]);
    const frame = await latestBuildPreview(core.layout.runs, { runId, facetId: "paddle", iteration: 2 });
    assert.ok(frame?.manifest, "the Mac frame has a manifest");
    const head = (await git(core.games.dirFor("pong"), ["rev-parse", "HEAD"])).trim();
    assert.deepEqual(
      { ...frame.manifest, capturedAt: null },
      {
        version: CAPTURE_MANIFEST_VERSION,
        runId,
        workerId: "paddle",
        call: 1,
        camera: "default",
        commit: head,
        // The rig's game is a clean checkout: the capture rendered its commit with no edits.
        edited: false,
        capturedAt: null,
        // TS-F1: a port that names neither the render settings nor the output size saves both as null.
        provenance: {
          ...NATIVE_PROVENANCE,
          build: { ...NATIVE_PROVENANCE.build },
          runId: "run1",
          render: null,
          outputSize: null,
        },
      },
    );
  });
});

describe("a native lease whose build fails", () => {
  it("is left with no run, and a capture is refused build-failed, never the older run", LEASES_RUN_HERE, async (t) => {
    const { core, registry } = await rig(t);
    const api = core.api();
    const { handle } = await api["preview.acquire"]({ label: "evidence", target: HOST_TARGET });
    await api["preview.load"]({ project: "tetris", handle });
    assert.equal((await api["preview.screenshot"]({ handle })).bytes > 0, true, "the first build is photographed");

    registry.failing.add("tetris");
    await assert.rejects(
      api["preview.load"]({ project: "tetris", handle }),
      (error: { refusal?: string }) => error.refusal === NativeRefusal.BuildFailed,
    );
    assert.equal(registry.live.size, 0, "the older run was stopped, not kept");
    await assert.rejects(
      api["preview.screenshot"]({ handle }),
      (error: { refusal?: string }) => error.refusal === NativeRefusal.BuildFailed,
      "a capture says the build failed, not that nothing was loaded",
    );

    registry.failing.delete("tetris");
    await api["preview.load"]({ project: "tetris", handle });
    assert.equal(
      (await api["preview.screenshot"]({ handle })).bytes > 0,
      true,
      "a build that works again is photographed",
    );
    await api["preview.release"]({ handle });
  });
});
