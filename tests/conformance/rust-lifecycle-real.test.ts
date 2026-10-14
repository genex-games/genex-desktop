/**
 * The Rust pond's lifecycle for real (darwin, Apple silicon): its dev flavour, built through the
 * cargo env helper, is prepared by the real `prepareNativeRun` (over the pond's injected deps, see
 * `helpers/rust-pond-binary.ts`), started by the real `spawnGame` under the M1.13 game profile,
 * spoken to by the real port and stopped by the real registry on the real clock. Stop asks `quit`
 * first. A pond that answers no `quit` (its group stopped with SIGSTOP, as a game hung in a GPU
 * wait looks) gets SIGTERM to its group after the quit grace, which ends it: the pond keeps the
 * default SIGTERM action (genex-studio's Stop contract), and macOS ends a stopped process on it.
 * The SIGKILL leg needs a game that ignores SIGTERM, which the pond never does, so that row stands
 * in the signal boundary: its SIGTERM is noted and not delivered, and the real SIGKILL ends the
 * frozen pond. Either way it is gone within `NATIVE_STOP_BUDGET_MS`. A run starts again after a
 * Stop, and a Stop while the build runs starts nothing. No row leaves a process running.
 *
 * Needs the spike toolchain; `GENEX_REQUIRE_METAL=1` turns its absence into a failure.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import { NativeRuns, type NativeRunsOptions } from "../../src/main/core/native-runs.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NATIVE_QUIT_GRACE_MS,
  NATIVE_READY_TIMEOUT_MS,
  NATIVE_STOP_BUDGET_MS,
  NATIVE_TERM_GRACE_MS,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { type GameChild, type GameSpawnRequest, ProcessSandbox } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import {
  POND_PROJECT,
  type PondLane,
  buildPond,
  needsPond,
  pondGame,
  pondPrepareDeps,
} from "../helpers/rust-pond-binary.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A cold pond build (the whole wgpu graph) plus every row. */
const SUITE_TIMEOUT_MS = 20 * MINUTE_MS;
/**
 * The share of the ready deadline a boxed cold start may use (pass-1 gate): the box grants no
 * shader cache, so every pipeline compiles cold, and a start that only just beats the deadline
 * times out under load.
 */
const READY_MARGIN_SHARE = 0.5;

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

/** The real clock: the budget is a wall-clock promise. */
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** Each group signal the registry sent and when; `ignored` signals are noted and never delivered. */
interface SignalLog {
  sent: Array<[NodeJS.Signals, number]>;
  ignored: Set<NodeJS.Signals>;
}

/** The real `spawnGame`, with each group signal noted; one the row ignores stands in a game that ignores it. */
function signalNoting(sandbox: ProcessSandbox, log: SignalLog) {
  return async (request: GameSpawnRequest): Promise<GameChild> => {
    const child = await sandbox.spawnGame(request);
    return {
      ...child,
      kill: (signal) => {
        log.sent.push([signal, Date.now()]);
        if (!log.ignored.has(signal)) child.kill(signal);
      },
    };
  };
}

/** Stops `runId` and answers how long the stop took on the real clock. */
async function timedStop(runs: NativeRuns, runId: string): Promise<{ from: number; took: number }> {
  const from = Date.now();
  await runs.stop(runId);
  return { from, took: Date.now() - from };
}

/** The pond's rig: the real game box, the pond's prepare deps and a registry over both. */
interface PondRig {
  sandbox: ProcessSandbox;
  root: string;
  deps: NativePrepareDeps;
  lane: PondLane;
  statuses: NativeRunStatus[];
  signals: SignalLog;
  runs: NativeRuns;
}

async function pondRig(): Promise<PondRig> {
  const scratch = await realpath(await tmpDir("rust-lifecycle-real-"));
  const root = path.join(scratch, "native-runs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const out = await buildPond(path.join(scratch, "builds", "out"));
  const sandbox = await ProcessSandbox.create({
    writableRoots: [],
    scratchDir: path.join(scratch, "scratch"),
    secretPaths: [],
    enabled: false,
    nativeRunsRoot: root,
  });
  const { deps, lane } = pondPrepareDeps({
    root,
    out,
    game: pondGame(path.join(scratch, "games", POND_PROJECT)),
    gameBox: () => sandbox.gameBoxAvailable(),
  });
  const statuses: NativeRunStatus[] = [];
  const signals: SignalLog = { sent: [], ignored: new Set() };
  const options: NativeRunsOptions = {
    root,
    prepare: (request, signal) => prepareNativeRun(deps, request, signal),
    spawn: signalNoting(sandbox, signals),
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
    },
    timers: REAL_TIMERS,
  };
  return { sandbox, root, deps, lane, statuses, signals, runs: new NativeRuns(options) };
}

/** The pond's headless run, as an agent's run starts. */
const HEADLESS = { project: POND_PROJECT, target: BuildTarget.Mac, mode: NativeRunMode.Headless } as const;

describe("the Rust pond under the real game box: ready, Stop, restart, cancel", {
  ...needsPond(),
  timeout: SUITE_TIMEOUT_MS,
}, () => {
  let rig: PondRig | undefined;
  const ready = (): PondRig => rig ?? assert.fail("the pond rig did not start");

  before(async () => {
    rig = await pondRig();
  });

  after(async () => {
    await rig?.runs.stopAll();
    await rig?.sandbox.dispose();
  });

  // Flipped (FIX-LIVE): was "a Rust game naming the Mac is refused lane-missing" for a headless run,
  // while the pond rode the raylib shape; its headless run now prepares through the wgpu admission
  // (the rows below), and only its window run, which the studio mode cannot show, has no lane.
  it("the pond's window run is refused lane-missing before any build: its studio mode serves headless", async () => {
    const { root, deps, lane } = ready();
    const controller = new AbortController();
    const window = { ...HEADLESS, mode: NativeRunMode.Window, runId: "0123456789ab" };
    await assert.rejects(
      prepareNativeRun(deps, window, controller.signal),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.LaneMissing,
    );
    assert.equal(lane.builds(), 0, "nothing was built");
    assert.deepEqual(await readdir(root), [], "nothing was assembled");
  });

  it("the pond is ready headless under the game profile, captures non-blank, and Stop's quit ends it with exit 0 inside the budget", async () => {
    const { runs, statuses, root, signals } = ready();
    signals.sent.length = 0;
    const run = await runs.start(HEADLESS);
    const pid = run.status.pid;
    assert.ok(pid);
    assert.equal(run.status.state, NativeRunState.Ready);
    const shot = await run.port.screenshotWithStats();
    assert.ok(shot.stats.litFraction > 0, `a non-blank capture: ${JSON.stringify(shot.stats)}`);
    const from = Date.now();
    await runs.stop(run.status.runId);
    const took = Date.now() - from;
    assert.ok(took < NATIVE_QUIT_GRACE_MS, `quit alone ended it (${took} ms)`);
    assert.deepEqual(signals.sent, [], "no signal was needed");
    const last = statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Stopped);
    assert.deepEqual(last?.exit, { code: 0, signal: null });
    assert.equal(running(pid), false, "nothing left running");
    assert.deepEqual(await readdir(root), [], "the run dir is gone");
  });

  // Pass-1 gate: the renderer pass compiled about sixty pipelines one after another on the first
  // frame; in the box (no shader cache) that took 20-21 s, past the 20 s ready deadline.
  it("a cold boxed start says ready within half the ready deadline", async () => {
    const { runs } = ready();
    const from = Date.now();
    const run = await runs.start(HEADLESS);
    const took = Date.now() - from;
    await runs.stop(run.status.runId);
    const margin = NATIVE_READY_TIMEOUT_MS * READY_MARGIN_SHARE;
    assert.ok(
      took < margin,
      `ready ${took} ms after start (at most ${margin} ms of the ${NATIVE_READY_TIMEOUT_MS} ms deadline)`,
    );
  });

  it("a frozen pond that answers no quit gets SIGTERM to its group after the quit grace, which ends it before the budget", async () => {
    const { runs, statuses, signals } = ready();
    signals.sent.length = 0;
    const run = await runs.start(HEADLESS);
    const pid = run.status.pid;
    assert.ok(pid);
    // Frozen, as a game hung in a GPU wait: `quit` is never read.
    process.kill(-pid, "SIGSTOP");
    const { from, took } = await timedStop(runs, run.status.runId);
    assert.deepEqual(
      signals.sent.map(([signal]) => signal),
      ["SIGTERM"],
    );
    const [term] = signals.sent;
    assert.ok(term && term[1] - from >= NATIVE_QUIT_GRACE_MS, "SIGTERM only after the quit grace");
    assert.ok(took < NATIVE_STOP_BUDGET_MS, `reaped ${took} ms after Stop (budget ${NATIVE_STOP_BUDGET_MS} ms)`);
    assert.deepEqual(statuses.at(-1)?.exit, { code: null, signal: "SIGTERM" });
    assert.equal(running(pid), false, "nothing left running");
  });

  it("a frozen pond that also ignores SIGTERM gets SIGKILL after both graces, and is reaped before the budget", async () => {
    const { runs, statuses, signals } = ready();
    signals.sent.length = 0;
    signals.ignored.add("SIGTERM");
    const run = await runs.start(HEADLESS);
    const pid = run.status.pid;
    assert.ok(pid);
    process.kill(-pid, "SIGSTOP");
    const { from, took } = await timedStop(runs, run.status.runId).finally(() => signals.ignored.clear());
    assert.deepEqual(
      signals.sent.map(([signal]) => signal),
      ["SIGTERM", "SIGKILL"],
    );
    const [term, kill] = signals.sent;
    assert.ok(term && term[1] - from >= NATIVE_QUIT_GRACE_MS, "SIGTERM only after the quit grace");
    assert.ok(kill && kill[1] - from >= NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS, "SIGKILL only after both graces");
    assert.ok(took < NATIVE_STOP_BUDGET_MS, `reaped ${took} ms after Stop (budget ${NATIVE_STOP_BUDGET_MS} ms)`);
    const last = statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed);
    assert.equal(last?.exit?.signal, "SIGKILL", "reaped by the kernel, not the margin's fallback");
    assert.equal(running(pid), false, "nothing left running");
  });

  it("after a Stop the pond starts again: a fresh run id and pid, ready, and stopped cleanly", async () => {
    const { runs, statuses, root } = ready();
    const first = await runs.start(HEADLESS);
    await runs.stop(first.status.runId);
    const again = await runs.start(HEADLESS);
    assert.notEqual(again.status.runId, first.status.runId);
    assert.notEqual(again.status.pid, first.status.pid);
    assert.equal(again.status.state, NativeRunState.Ready);
    const pid = again.status.pid;
    assert.ok(pid);
    await runs.stop(again.status.runId);
    assert.deepEqual(statuses.at(-1)?.exit, { code: 0, signal: null });
    assert.equal(running(pid), false, "nothing left running");
    assert.deepEqual(await readdir(root), [], "both run dirs are gone");
  });

  it("a Stop while the build runs cancels the start: nothing is admitted, assembled or spawned", async () => {
    const { runs, statuses, lane, root } = ready();
    const release = lane.hold();
    const builds = lane.builds();
    const starting = runs.start(HEADLESS);
    while (lane.builds() === builds) await new Promise((resolve) => setImmediate(resolve));
    const stopping = runs.stopProject(POND_PROJECT, [NativeRunMode.Headless]);
    release();
    await assert.rejects(starting, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await stopping;
    const last = statuses.at(-1);
    assert.equal(last?.pid, null, "no game was spawned");
    assert.notEqual(last?.state, NativeRunState.Ready);
    assert.deepEqual(await readdir(root), [], "no run dir was assembled");
  });
});
