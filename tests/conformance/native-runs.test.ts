/**
 * The native run registry: every C++ · raylib game the studio started, how each one is stopped
 * (`quit`, SIGTERM to its group, SIGKILL to the group and every listed descendant, reaped inside
 * the stop budget), which runs each lifecycle moment ends (never pauses), the pidfile the next boot
 * sweeps an orphan by, the memory cap, and the status and log events the renderer reads. The games
 * are in memory, behind the real port; time is a fake clock and no row waits out a NATIVE_* constant.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { setTimeout as sleep, setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { type CppBuildInput, CppBuildPurpose, CppBuilds, refusalProblem } from "../../src/main/cpp-build.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import type { BuildIdentity } from "../../src/shared/build-preview.ts";
import {
  GameBoxProblem,
  NATIVE_CALL_TIMEOUT_MS,
  NATIVE_GAME_MEMORY_MAX_BYTES,
  NATIVE_HEARTBEAT_MS,
  NATIVE_LOG_BATCH_MAX,
  NATIVE_QUIT_GRACE_MS,
  NATIVE_REAP_MARGIN_MS,
  NATIVE_STDERR_LINE_MAX_CHARS,
  NATIVE_STOP_BUDGET_MS,
  NATIVE_TERM_GRACE_MS,
  NativeError,
  NativeEvent,
  NativeOp,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeLogBatch,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { NativeRuns, type NativeRunsOptions, type NativeStartRequest } from "../../src/main/core/native-runs.ts";
import type { NativeFramesHost } from "../../src/main/native-frames.ts";
import {
  type NativeAiLink,
  NativeExitError,
  NativeGamePort,
  fnv1a64Hex,
} from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameExit, GameSpawnRequest, RunRequest } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      due.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle);
    },
  };
  const settle = async () => {
    for (let round = 0; round < 8; round++) await tick();
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = next[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    await settle();
  };
  return { timers, advance, settle, now: () => now };
}

/** A long CPU-bound step: past a heartbeat's silence (`NATIVE_HEARTBEAT_MS`), inside the step's deadline. */
const LONG_STEP_MS = 7000;

/** How long, in real time, a test waits for a signal that needs no fake time to pass: rounds of a step. */
const SIGNAL_WAIT_ROUNDS = 500;
const SIGNAL_WAIT_STEP_MS = 10;

/** How a scripted game behaves. */
interface Behaviour {
  ignoreQuit?: boolean;
  ignoreTerm?: boolean;
  /** SIGKILL never reaps it (a zombie the kernel holds). */
  neverReaped?: boolean;
  /** Answers no `state` and no `capture` (a wedged main loop). */
  silent?: boolean;
  /** Exits so before it ever says ready (a crash in the game's own init). */
  exitBeforeReady?: { code: number | null; signal: NodeJS.Signals | null };
  /** Fields its `ready` states over the protocol 1 defaults (a Rust game's protocol 2 and receipt). */
  ready?: Record<string, unknown>;
  /** What its `state` answers in place of `{tick: 1}` (a protocol 2 game's lifecycle and safe area). */
  state?: Record<string, unknown>;
  /**
   * Serves one op at a time and holds every `step` until the test calls `finishStep()`: a long
   * CPU-bound step, with whatever arrives behind it queued as a real game's loop queues it.
   */
  holdSteps?: boolean;
}

/** A Rust · wgpu game's ready (contract v2) and the state fields a protocol 2 game must answer. */
const V2_RECEIPT = {
  tier: "core",
  backend: "metal",
  adapter: "Apple M4",
  nativeEnhanced: [],
  extensionApi: 1,
  customPassApi: 1,
};
const V2_GAME: Behaviour = {
  ready: { protocol: 2, contractVersion: 2, backend: { api: "metal", device: "Apple M4" }, receipt: V2_RECEIPT },
  state: { tick: 1, lifecycle: "resumed", safeArea: { top: 0, left: 0, bottom: 0, right: 0 } },
};

/** The 2×2 BGRA picture a scripted game's `capture` writes. */
const CAPTURED = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]);

/** A game in memory that answers the protocol by itself: ready with the spawn's nonce, state, quit, front. */
function scriptedGame(request: GameSpawnRequest, pid: number, behaviour: Behaviour) {
  const toGame = new PassThrough();
  const fromGame = new PassThrough();
  const stderr = new PassThrough();
  let reap: (exit: GameExit) => void = () => {};
  let reaped = false;
  const exited = new Promise<GameExit>((done) => {
    reap = (exit) => {
      if (reaped) return;
      reaped = true;
      done(exit);
    };
  });
  const signals: NodeJS.Signals[] = [];
  const ops: string[] = [];
  const send = (value: unknown) => fromGame.write(`${JSON.stringify(value)}\n`);
  /** What the game answers each op with; an op it does not know (or a wedged loop's state) goes unanswered. */
  const answers: Record<string, (arg: Record<string, unknown>) => unknown> = {
    state: () => (behaviour.silent ? undefined : (behaviour.state ?? { tick: 1 })),
    capture: () => {
      if (behaviour.silent) return undefined;
      const dir = path.join(request.state, "captures");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "1.bgra"), CAPTURED);
      return { seq: 1, width: 2, height: 2, format: "bgra8", digest: fnv1a64Hex(CAPTURED) };
    },
    surface: (arg) => ({ generation: arg.generation, width: arg.w, height: arg.h, slots: arg.slots }),
    release: () => ({}),
    front: () => ({ fronted: request.mode === NativeRunMode.Window }),
    audio: () => ({ muted: true }),
    // Only a game that holds its steps answers one (once released); otherwise a step goes unanswered.
    step: () => (behaviour.holdSteps ? { frame: 1, simulatedMs: 16, steppedFrames: 1, drawCalls: 1 } : undefined),
    quit: () => {
      if (!behaviour.ignoreQuit) setImmediate(() => reap({ code: 0, signal: null }));
      return { quitting: true };
    },
  };
  let buffered = "";
  const queued: Array<{ id: number; op: string; arg?: object }> = [];
  let holding = false;
  const serve = () => {
    while (!holding && queued.length > 0) {
      const { id, op, arg } = queued.shift() ?? { id: 0, op: "" };
      ops.push(op);
      if (op === NativeOp.Step && behaviour.holdSteps) {
        holding = true;
        held = () => send({ id, ok: true, op, result: answers[op]?.({ ...arg }) });
        return;
      }
      const result = answers[op]?.({ ...arg });
      if (result !== undefined) send({ id, ok: true, op, result });
    }
  };
  let held: () => void = () => {};
  /** The held step is answered, then whatever queued behind it. */
  const finishStep = () => {
    held();
    holding = false;
    serve();
  };
  toGame.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      queued.push(JSON.parse(buffered.slice(0, end)) as { id: number; op: string; arg?: object });
      buffered = buffered.slice(end + 1);
    }
    serve();
  });
  const child: GameChild = {
    pid,
    fd3: Duplex.from({ readable: fromGame, writable: toGame }),
    stdout: new PassThrough(),
    stderr,
    exited,
    kill: (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM" && !behaviour.ignoreTerm) setImmediate(() => reap({ code: null, signal }));
      if (signal === "SIGKILL" && !behaviour.neverReaped) setImmediate(() => reap({ code: null, signal }));
    },
  };
  const early = behaviour.exitBeforeReady;
  if (early) setImmediate(() => reap(early));
  else
    setImmediate(() =>
      send({
        event: NativeEvent.Ready,
        nonce: request.nonce,
        protocol: 1,
        contractVersion: 1,
        build: "test",
        backend: { api: "metal-angle", device: "Apple M4" },
        size: { width: 320, height: 180 },
        seed: 0,
        ...behaviour.ready,
      }),
    );
  return { child, signals, ops, send, stderr, reap, finishStep };
}

type Game = ReturnType<typeof scriptedGame>;

interface RegistryRig {
  runs: NativeRuns;
  clock: ReturnType<typeof fakeClock>;
  root: string;
  games: Game[];
  statuses: NativeRunStatus[];
  logs: NativeLogBatch[];
  killed: Array<[number, NodeJS.Signals]>;
  prepared: string[];
  behaviour: Behaviour;
}

/** Live's frames host where every embedded run's channel opens and rings, and no frame ever comes. */
function quietFrames(): NativeFramesHost {
  const generations = new Map<string, number>();
  return {
    available: () => null,
    open: ({ runId }) => ({ service: `games.genex.frames.${runId}` }),
    peer: () => {},
    ring: (runId, size) => {
      const generation = (generations.get(runId) ?? 0) + 1;
      generations.set(runId, generation);
      return { generation, ...size, slots: 3 };
    },
    pause: () => {},
    resume: () => {},
    close: () => {},
    stats: () => null,
  };
}

async function registry(overrides: Partial<NativeRunsOptions> = {}, behaviour: Behaviour = {}): Promise<RegistryRig> {
  const root = await tmpDir("native-runs-");
  const clock = fakeClock();
  const games: Game[] = [];
  const statuses: NativeRunStatus[] = [];
  const logs: NativeLogBatch[] = [];
  const killed: Array<[number, NodeJS.Signals]> = [];
  const prepared: string[] = [];
  let nextPid = 5000;
  const runs = new NativeRuns({
    root,
    timers: clock.timers,
    prepare: async (request) => {
      const runDir = path.join(root, request.runId);
      await mkdir(path.join(runDir, "state"), { recursive: true });
      request.onAdmitting?.();
      prepared.push(request.runId);
      return {
        runId: request.runId,
        runDir,
        exe: path.join(runDir, "bundle", "Game.app", "Contents", "MacOS", "game"),
        bundle: path.join(runDir, "bundle"),
        state: path.join(runDir, "state"),
        bundleId: "games.genex.game.0123456789ab",
      };
    },
    spawn: async (request) => {
      nextPid += 1;
      const game = scriptedGame(request, nextPid, behaviour);
      games.push(game);
      return game.child;
    },
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async () => Buffer.alloc(0) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
      if (event.type === UiEvent.NativeLog) logs.push(event.payload);
    },
    sampleFootprint: async () => 1024,
    descendants: async () => [],
    startedAt: async (pid) => `Thu Oct  1 12:00:00 2026 ${pid}`,
    signal: (pid, signal) => void killed.push([pid, signal]),
    frames: quietFrames(),
    ...overrides,
  });
  return { runs, clock, root, games, statuses, logs, killed, prepared, behaviour };
}

function request(project: string, mode: NativeStartRequest["mode"], extra: Partial<NativeStartRequest> = {}) {
  return { project, target: BuildTarget.Mac, mode, ...extra };
}

/** Starts a run and lets its handshake land. */
async function started(r: RegistryRig, req: NativeStartRequest) {
  const starting = r.runs.start(req);
  await r.clock.settle();
  return starting;
}

/** The states a run ends in. */
const ENDED: ReadonlySet<string> = new Set([
  NativeRunState.Stopped,
  NativeRunState.Killed,
  NativeRunState.Crashed,
  NativeRunState.Refused,
]);

/** Stops `runId` on the fake clock and answers how long it took to end (its last status), on that clock. */
async function timedStop(r: RegistryRig, runId: string): Promise<number> {
  const from = r.clock.now();
  let endedAt: number | null = null;
  let done = false;
  const stopping = r.runs.stop(runId).then(() => {
    done = true;
  });
  for (let step = 0; step < 100 && !done; step++) {
    await r.clock.advance(100);
    const ended = r.statuses.some((status) => status.runId === runId && ENDED.has(status.state));
    if (ended && endedAt === null) endedAt = r.clock.now();
  }
  await stopping;
  return (endedAt ?? r.clock.now()) - from;
}

describe("stopping a run", () => {
  it("quit is enough for a game that quits: no signal, stopped well inside the quit grace", async () => {
    const r = await registry();
    const run = await started(r, request("pong", NativeRunMode.Window));
    const took = await timedStop(r, run.status.runId);
    assert.ok(took < NATIVE_QUIT_GRACE_MS, `${took}ms`);
    assert.deepEqual(r.games[0]?.signals, []);
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Stopped);
  });

  it("quit → SIGTERM → SIGKILL for a game that ignores quit and TERM: killed, reaped inside the budget", async () => {
    const r = await registry({}, { ignoreQuit: true, ignoreTerm: true });
    const run = await started(r, request("pong", NativeRunMode.Window));
    const took = await timedStop(r, run.status.runId);
    assert.deepEqual(r.games[0]?.signals, ["SIGTERM", "SIGKILL"]);
    assert.ok(took >= NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS, `escalated only after both graces: ${took}ms`);
    assert.ok(took <= NATIVE_STOP_BUDGET_MS, `${took}ms`);
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed);
    assert.equal(r.runs.state("pong"), null, "no live run is left");
  });

  it("a game that ignores quit but obeys SIGTERM ends stopped after the quit grace", async () => {
    const r = await registry({}, { ignoreQuit: true });
    const run = await started(r, request("pong", NativeRunMode.Window));
    await timedStop(r, run.status.runId);
    assert.deepEqual(r.games[0]?.signals, ["SIGTERM"]);
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Stopped);
  });

  it("a SIGKILL that never reaps still resolves the stop at the reap margin", async () => {
    const r = await registry({}, { ignoreQuit: true, ignoreTerm: true, neverReaped: true });
    const run = await started(r, request("pong", NativeRunMode.Window));
    const took = await timedStop(r, run.status.runId);
    assert.ok(took <= NATIVE_STOP_BUDGET_MS + 100, `${took}ms`);
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Killed);
  });

  it("descendants the injected ps lists are killed with the group", async () => {
    const r = await registry({ descendants: async () => [7001, 7002] }, { ignoreQuit: true, ignoreTerm: true });
    const run = await started(r, request("pong", NativeRunMode.Window));
    await timedStop(r, run.status.runId);
    assert.deepEqual(r.killed, [
      [7001, "SIGKILL"],
      [7002, "SIGKILL"],
    ]);
  });

  it("a kill that throws is logged and the stop still resolves", async () => {
    const lines: string[] = [];
    const r = await registry(
      {
        descendants: async () => [7001],
        signal: () => {
          throw new Error("EPERM");
        },
        log: (line) => void lines.push(line),
      },
      { ignoreQuit: true, ignoreTerm: true },
    );
    const run = await started(r, request("pong", NativeRunMode.Window));
    await timedStop(r, run.status.runId);
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Killed);
    assert.ok(lines.length > 0, "the failed kill is logged");
  });

  it("the run dir is removed once the run ends, and its pidfile was there while it ran (0600, pid and lstart)", async () => {
    const r = await registry();
    const run = await started(r, request("pong", NativeRunMode.Window));
    const pidfile = path.join(r.root, run.status.runId, "pid.json");
    const written = JSON.parse(await readFile(pidfile, "utf8")) as { pid: number; lstart: string };
    assert.deepEqual(written, { pid: run.status.pid, lstart: `Thu Oct  1 12:00:00 2026 ${run.status.pid}` });
    assert.equal((await stat(pidfile)).mode & 0o777, 0o600);
    await timedStop(r, run.status.runId);
    assert.deepEqual(await readdir(r.root), []);
  });
});

describe("how a run ends on its own", () => {
  it("the person closing the window (exit 0) is stopped; a non-zero exit or a signal is crashed", async () => {
    for (const [exit, state] of [
      [{ code: 0, signal: null }, NativeRunState.Stopped],
      [{ code: 3, signal: null }, NativeRunState.Crashed],
      [{ code: null, signal: "SIGSEGV" as const }, NativeRunState.Crashed],
    ] as const) {
      const r = await registry();
      await started(r, request("pong", NativeRunMode.Window));
      r.games[0]?.reap(exit);
      await r.clock.settle();
      assert.equal(r.statuses.at(-1)?.state, state, JSON.stringify(exit));
      assert.deepEqual(r.statuses.at(-1)?.exit, exit);
      assert.equal(r.runs.state("pong"), null);
    }
  });

  it("a game that exits 1 before ready: start rejects with its exit, never bad-handshake, and the run is crashed", async () => {
    const r = await registry({}, { exitBeforeReady: { code: 1, signal: null } });
    const start = r.runs.start(request("pong", NativeRunMode.Headless)).then(
      () => null,
      (error: unknown) => error,
    );
    await r.clock.settle();
    const error = await start;
    assert.ok(error instanceof NativeExitError, String(error));
    assert.deepEqual(error.exit, { code: 1, signal: null });
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Crashed);
    assert.equal(last?.refusal, null, "the host refused nothing");
    assert.deepEqual(last?.exit, { code: 1, signal: null });
  });

  it("a heartbeat nobody answers kills the game unresponsive", async () => {
    const r = await registry({}, { silent: true });
    await started(r, request("pong", NativeRunMode.Headless));
    await r.clock.advance(NATIVE_HEARTBEAT_MS * 2);
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed);
    assert.equal(last?.refusal, NativeRefusal.Unresponsive);
    assert.deepEqual(r.games[0]?.signals, ["SIGKILL"]);
  });

  it("a game over the memory cap is killed memory-cap", async () => {
    const r = await registry({ sampleFootprint: async () => NATIVE_GAME_MEMORY_MAX_BYTES + 1 });
    await started(r, request("pong", NativeRunMode.Headless));
    await r.clock.advance(NATIVE_HEARTBEAT_MS * 2);
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed);
    assert.equal(last?.refusal, NativeRefusal.MemoryCap);
  });

  /** /proc/<pid>/status as Linux writes it, with the game's own anonymous and shared-memory pages. */
  const procStatus = (anonKb: number, shmemKb = 0) =>
    `Name:\tgame\nVmRSS:\t${anonKb + shmemKb + 9000} kB\nRssAnon:\t${anonKb} kB\nRssFile:\t9000 kB\nRssShmem:\t${shmemKb} kB\n`;

  it("on a Linux host, a game over the cap is killed memory-cap: the sum over bubblewrap and every descendant", async () => {
    const third = Math.ceil(NATIVE_GAME_MEMORY_MAX_BYTES / 1024 / 3) + 1;
    const read: number[] = [];
    const r = await registry({
      platform: "linux",
      sampleFootprint: undefined,
      descendants: async (pid) => [pid + 1000, pid + 2000],
      readProcStatus: async (pid) => {
        read.push(pid);
        return pid >= 6000 ? procStatus(third - 1024, 1024) : procStatus(third);
      },
    });
    await started(r, request("pong", NativeRunMode.Window, { target: BuildTarget.Linux }));
    await r.clock.advance(NATIVE_HEARTBEAT_MS * 2);
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed, "no one process is over the cap, the box is");
    assert.equal(last?.refusal, NativeRefusal.MemoryCap);
    assert.deepEqual(read.slice(0, 3), [5001, 6001, 7001], "bubblewrap's pid, then each descendant");
  });

  it("on a Linux host, a game under the cap keeps running, and an unreadable /proc kills nothing", async () => {
    for (const status of [procStatus(1024), null]) {
      const r = await registry({
        platform: "linux",
        sampleFootprint: undefined,
        descendants: async (pid) => [pid + 1000],
        readProcStatus: async () => status,
      });
      await started(r, request("pong", NativeRunMode.Window, { target: BuildTarget.Linux }));
      await r.clock.advance(NATIVE_HEARTBEAT_MS * 2);
      assert.equal(r.statuses.at(-1)?.state, NativeRunState.Ready, String(status));
    }
  });
});

describe("which runs each moment ends", () => {
  async function three(r: RegistryRig) {
    const window = await started(r, request("pong", NativeRunMode.Window));
    const headless = await started(r, request("pong", NativeRunMode.Headless, { owner: "harness:1" }));
    const surface = { width: 64, height: 64, dpr: 1 };
    const embedded = await started(r, request("pong", NativeRunMode.Embedded, { surface }));
    const other = await started(r, request("tetris", NativeRunMode.Window));
    return { window, headless, embedded, other };
  }
  const live = (r: RegistryRig, project: string, mode: NativeRunStatus["mode"]) => r.runs.state(project, mode)?.runId;

  it("composer Stop (D10) ends the agent runs and leaves the person's windows", async () => {
    const r = await registry();
    const runs = await three(r);
    const stopping = r.runs.stopAgentRuns();
    await r.clock.advance(NATIVE_STOP_BUDGET_MS);
    await stopping;
    assert.equal(live(r, "pong", NativeRunMode.Headless), undefined);
    assert.equal(live(r, "pong", NativeRunMode.Window), runs.window.status.runId);
    assert.equal(live(r, "pong", NativeRunMode.Embedded), runs.embedded.status.runId);
    assert.equal(live(r, "tetris", NativeRunMode.Window), runs.other.status.runId);
  });

  it("stopProject(p, [window, embedded]) leaves p's headless runs and other games' runs", async () => {
    const r = await registry();
    const runs = await three(r);
    const stopping = r.runs.stopProject("pong", [NativeRunMode.Window, NativeRunMode.Embedded]);
    await r.clock.advance(NATIVE_STOP_BUDGET_MS);
    await stopping;
    assert.equal(live(r, "pong", NativeRunMode.Window), undefined);
    assert.equal(live(r, "pong", NativeRunMode.Embedded), undefined);
    assert.equal(live(r, "pong", NativeRunMode.Headless), runs.headless.status.runId);
    assert.equal(live(r, "tetris", NativeRunMode.Window), runs.other.status.runId);
  });

  it("stopMode(embedded) ends only embedded runs", async () => {
    const r = await registry();
    const runs = await three(r);
    const stopping = r.runs.stopMode(NativeRunMode.Embedded);
    await r.clock.advance(NATIVE_STOP_BUDGET_MS);
    await stopping;
    assert.equal(live(r, "pong", NativeRunMode.Embedded), undefined);
    assert.equal(live(r, "pong", NativeRunMode.Window), runs.window.status.runId);
    assert.equal(live(r, "pong", NativeRunMode.Headless), runs.headless.status.runId);
  });

  it("stopOwnedBy ends a dead harness's runs and nobody else's", async () => {
    const r = await registry();
    const runs = await three(r);
    const stopping = r.runs.stopOwnedBy("harness:1");
    await r.clock.advance(NATIVE_STOP_BUDGET_MS);
    await stopping;
    assert.equal(live(r, "pong", NativeRunMode.Headless), undefined);
    assert.equal(live(r, "pong", NativeRunMode.Window), runs.window.status.runId);
  });

  it("stopAll ends every run", async () => {
    const r = await registry();
    await three(r);
    const stopping = r.runs.stopAll();
    await r.clock.advance(NATIVE_STOP_BUDGET_MS);
    await stopping;
    for (const mode of Object.values(NativeRunMode)) assert.equal(live(r, "pong", mode), undefined, mode);
    assert.equal(live(r, "tetris", NativeRunMode.Window), undefined);
  });
});

describe("Play", () => {
  it("a second Play fronts the live window and starts nothing", async () => {
    const r = await registry();
    const first = await started(r, request("pong", NativeRunMode.Window));
    const second = await started(r, request("pong", NativeRunMode.Window));
    assert.equal(second.status.runId, first.status.runId);
    assert.equal(r.games.length, 1, "one game process");
    assert.ok(r.games[0]?.ops.includes("front"));
  });

  it("a supervisor that throws neither strands the game nor blocks the next Play", async () => {
    // The lazy supervisor client forks a utility process on its first register; a failure there
    // (or anywhere after the spawn) must not leave a game running with no port and no ready timer.
    let registers = 0;
    const r = await registry({
      supervisor: {
        register: () => {
          registers += 1;
          if (registers === 1) throw new Error("the supervisor could not start");
        },
        forget: () => {},
      },
    });
    const first = await r.runs.start(request("pong", NativeRunMode.Window)).then(
      () => null,
      (error: unknown) => error,
    );
    await r.clock.settle();
    const game = r.games[0];
    assert.ok(game, "the game was spawned");
    if (first === null) {
      // The failure was only logged: the run is ready and stops as any run does.
      assert.equal(r.runs.state("pong")?.state, NativeRunState.Ready);
    } else {
      assert.ok(game.signals.includes("SIGKILL"), "the stranded game was killed");
      assert.equal(r.runs.state("pong"), null, "the run ended");
    }
    await r.runs.stopAll();
    await r.clock.settle();
    const second = await started(r, request("pong", NativeRunMode.Window));
    assert.equal(second.status.state, NativeRunState.Ready, "the next Play starts a game");
    assert.equal(r.games.length, 2, "a second game process");
  });

  it("anything that throws after the spawn kills the game: the run ends, and the next Play starts afresh", async () => {
    let connects = 0;
    const r = await registry({
      connect: (child, io) => {
        connects += 1;
        if (connects === 1) throw new Error("the port could not be made");
        return new NativeGamePort({ ...io, child, encodeJpeg: async () => Buffer.alloc(0) });
      },
    });
    const first = await r.runs.start(request("pong", NativeRunMode.Window)).then(
      () => null,
      (error: unknown) => error,
    );
    await r.clock.settle();
    assert.ok(first instanceof Error, "the start says it failed");
    assert.ok(r.games[0]?.signals.includes("SIGKILL"), "the game with no port was killed");
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Killed);
    assert.equal(r.runs.state("pong"), null, "the run ended");
    const second = await started(r, request("pong", NativeRunMode.Window));
    assert.equal(second.status.state, NativeRunState.Ready);
    assert.equal(r.games.length, 2);
  });

  it("front raises the window run and answers what the game said; no window run answers false", async () => {
    const r = await registry();
    assert.equal(await r.runs.front("pong"), false);
    await started(r, request("pong", NativeRunMode.Window));
    assert.equal(await r.runs.front("pong"), true);
  });

  it("a refused prepare ends refused with its refusal and problem, and nothing is spawned", async () => {
    const problem = refusalProblem({
      project: "pong",
      target: BuildTarget.Mac,
      reason: BuildProblemCode.ToolchainMissing,
      at: new Date(0).toISOString(),
    });
    for (const error of [
      new NativeError(NativeRefusal.NotADestination, "not a destination"),
      new NativeError(NativeRefusal.BuildFailed, "build failed", problem),
      new NativeError(NativeRefusal.LinksOpenGl, "links OpenGL"),
    ]) {
      const r = await registry({
        prepare: async () => {
          throw error;
        },
      });
      const refused = await r.runs.start(request("pong", NativeRunMode.Window)).then(
        () => null,
        (e: unknown) => e,
      );
      assert.equal(refused, error);
      const last = r.statuses.at(-1);
      assert.equal(last?.state, NativeRunState.Refused);
      assert.equal(last?.refusal, error.refusal);
      assert.deepEqual(last?.problem, error.problem);
      assert.equal(r.games.length, 0, "nothing spawned");
    }
  });
});

/**
 * Composer Stop (D10) and a caller's own abort reach a run that is still building or starting: the
 * start is cancelled, a game spawned meanwhile is escalated and reaped, and `start` rejects with an
 * `AbortError` (the Play IPC reads that as a stop the person asked for).
 */
/** A prepare that waits until the row opens it, or rejects when its signal aborts. */
function gatedPrepare(r: { root: string }) {
  const gates: Array<() => void> = [];
  const prepare: NativeRunsOptions["prepare"] = async (req, signal) => {
    await new Promise<void>((resolve, reject) => {
      gates.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const runDir = path.join(r.root, req.runId);
    await mkdir(path.join(runDir, "state"), { recursive: true });
    return {
      runId: req.runId,
      runDir,
      exe: path.join(runDir, "bundle", "Game.app", "Contents", "MacOS", "game"),
      bundle: path.join(runDir, "bundle"),
      state: path.join(runDir, "state"),
      bundleId: "games.genex.game.0123456789ab",
    };
  };
  const open = () => {
    for (const gate of gates.splice(0)) gate();
  };
  return { prepare, open };
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

describe("stopping a run that is still starting", () => {
  for (const how of ["Stop", "the caller's signal"] as const) {
    it(`${how} while building: stopped, nothing spawned, the run dir gone, start rejects AbortError`, async () => {
      const root = await tmpDir("native-runs-gated-");
      const gated = gatedPrepare({ root });
      const r = await registry({ root, prepare: gated.prepare });
      const controller = new AbortController();
      const start = r.runs.start(request("pong", NativeRunMode.Headless, { signal: controller.signal })).then(
        () => null,
        (error: unknown) => error,
      );
      await r.clock.settle();
      const runId = r.statuses[0]?.runId;
      assert.ok(runId);
      assert.equal(r.statuses.at(-1)?.state, NativeRunState.Building);
      if (how === "Stop") await r.runs.stop(runId);
      else controller.abort();
      await r.clock.advance(NATIVE_STOP_BUDGET_MS);
      gated.open();
      await r.clock.settle();
      const error = await start;
      assert.ok(isAbort(error), `an aborted start rejects AbortError: ${String(error)}`);
      assert.deepEqual(
        r.statuses.map((status) => status.state),
        [NativeRunState.Building, NativeRunState.Stopped],
      );
      assert.equal(r.games.length, 0, "nothing spawned");
      assert.deepEqual(await readdir(root), [], "no run dir is left");
      assert.equal(r.runs.state("pong", NativeRunMode.Headless), null);
    });
  }

  it("Stop while the game is being spawned: it is escalated at once (no port to ask), reaped, and start rejects AbortError", async () => {
    let entered: () => void = () => {};
    const spawnEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let spawned: () => void = () => {};
    const spawning = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const games: Game[] = [];
    let signaledAt: number | null = null;
    const gatedSpawn: NativeRunsOptions["spawn"] = async (req) => {
      entered();
      await spawning;
      const game = scriptedGame(req, 6001, {});
      const kill = game.child.kill;
      game.child.kill = (signal) => {
        signaledAt = g.clock.now();
        kill(signal);
      };
      games.push(game);
      return game.child;
    };
    const g = await registry({ spawn: gatedSpawn });
    const start = g.runs.start(request("pong", NativeRunMode.Headless)).then(
      () => null,
      (error: unknown) => error,
    );
    // Prepare writes a real run dir: the spawn entry acknowledges that its I/O finished.
    await spawnEntered;
    assert.equal(g.statuses.at(-1)?.state, NativeRunState.Starting);
    const runId = g.statuses[0]?.runId;
    assert.ok(runId);
    const from = g.clock.now();
    let stopped = false;
    const stopping = g.runs.stop(runId).then(() => {
      stopped = true;
    });
    await g.clock.settle();
    spawned();
    // SIGTERM needs no time to pass, so the clock stands still until it lands: advancing it while the
    // spawn's real I/O finishes would measure the runner's load, not a quit grace.
    for (let round = 0; round < SIGNAL_WAIT_ROUNDS && signaledAt === null; round++) await sleep(SIGNAL_WAIT_STEP_MS);
    for (let step = 0; step < 100 && !stopped; step++) await g.clock.advance(100);
    await stopping;
    const error = await start;
    assert.ok(isAbort(error), `an aborted start rejects AbortError: ${String(error)}`);
    const game = games[0];
    assert.ok(game, "the game was spawned");
    assert.deepEqual(game.signals, ["SIGTERM"], "SIGTERM at once: no port was there to ask it to quit");
    assert.ok(signaledAt !== null, "the child was signaled");
    assert.ok(signaledAt - from < NATIVE_QUIT_GRACE_MS, "no quit grace waited before SIGTERM");
    assert.equal(signaledAt, from, "signaled before any time passed on the run's clock");
    const last = g.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Stopped);
    assert.deepEqual(await readdir(g.root), [], "no run dir is left");
  });
});

/**
 * The lane shares one build per folder: a harness lease's Mac build of a game and the person's Play
 * on Mac of the same game wait on one build. Each caller's signal ends only its own wait.
 */
describe("a Play whose Mac build joined another caller's", () => {
  /** A lane over a fake store and Command Line Tools, whose runs hold until their signal aborts. */
  async function holdingLane(parent: string) {
    const calls: RunRequest[] = [];
    const builds = new CppBuilds({
      root: path.join(parent, "cpp-builds"),
      run: (req) => {
        calls.push(req);
        return new Promise((resolve) => {
          const done = () =>
            resolve({
              code: null,
              signal: "SIGKILL",
              stdout: "",
              stderr: "",
              durationMs: 1,
              timedOut: false,
              truncated: false,
              sandboxed: false,
              command: req.command,
              cwd: req.cwd,
            });
          if (req.signal?.aborted) done();
          else req.signal?.addEventListener("abort", done, { once: true });
        });
      },
      locate: async (lock) => ({
        ok: true,
        toolchain: {
          lock,
          cmake: "/store/cmake/bin/cmake",
          ninja: "/store/ninja/ninja",
          emscripten: null,
          genexCmake: { [BuildTarget.Mac]: "/store/locks/genex-macos.cmake" },
          angle: {
            dir: "/store/angle",
            egl: "/store/angle/libEGL.dylib",
            gles: "/store/angle/libGLESv2.dylib",
            manifestSha256: "d".repeat(64),
          },
        },
      }),
      currentLock: async () => ({ version: 1, entries: {}, digest: "ab".repeat(32) }),
      emit: () => {},
      platform: "darwin",
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      exec: async (file) => ({ code: 0, stdout: file.endsWith("xcrun") ? "/sdk/MacOSX.sdk\n" : "/clt\n", stderr: "" }),
    });
    const dir = path.join(parent, "pong");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "CMakeLists.txt"), 'include("${GENEX_CMAKE}")\n');
    await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 0; }\n");
    const mac = (purpose: CppBuildPurpose): CppBuildInput => ({
      project: "pong",
      dir,
      shape: {
        entry: "index.html",
        main: "src/main.cpp",
        build: null,
        install: null,
        own: false,
        kind: "raylib-cpp",
        serve: ".",
      },
      target: BuildTarget.Mac,
      destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Mac] },
      purpose,
      lock: null,
    });
    return { builds, calls, mac };
  }

  it("Stop of a run whose Mac build joined another caller's resolves within NATIVE_STOP_BUDGET_MS, and the other build runs on", async () => {
    const parent = await tmpDir("native-runs-join-");
    const lane = await holdingLane(parent);
    // A harness lease is building pong for the Mac.
    const lease = lane.builds.ensure(lane.mac(CppBuildPurpose.Judging), { signal: new AbortController().signal });
    for (let turn = 0; turn < 500 && lane.calls.length === 0; turn++) await sleep(2);
    assert.equal(lane.calls.length, 1, "the lease's build runs");
    const r = await registry({
      prepare: async (req, signal) => {
        const outcome = await lane.builds.ensure(lane.mac(CppBuildPurpose.Live), { signal });
        signal.throwIfAborted();
        throw new NativeError(NativeRefusal.BuildFailed, "the Mac build failed", outcome.problem);
      },
    });
    // The person presses Play on Mac: its build joins the lease's.
    const start = r.runs.start(request("pong", NativeRunMode.Window)).catch((error: unknown) => error);
    await sleep(50);
    const runId = r.statuses[0]?.runId;
    assert.ok(runId);
    let done = false;
    const stopping = r.runs.stop(runId).then(() => {
      done = true;
    });
    for (let waited = 0; waited < NATIVE_STOP_BUDGET_MS && !done; waited += 100) {
      await r.clock.advance(100);
      await sleep(2);
    }
    assert.equal(done, true, "Stop returned inside the stop budget");
    assert.ok(isAbort(await start), "the start says it was stopped");
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Stopped);
    assert.equal(lane.calls[0]?.signal?.aborted, false, "the lease's build was not cancelled by the person's Stop");
    lane.builds.cancelAll();
    assert.equal((await lease).problem?.reason, BuildProblemCode.Cancelled);
    await stopping;
  });
});

describe("what a run reports", () => {
  it("every state change is a native.status event, building to ready to stopped", async () => {
    const r = await registry();
    const run = await started(r, request("pong", NativeRunMode.Window));
    await timedStop(r, run.status.runId);
    assert.deepEqual(
      r.statuses.map((status) => status.state),
      [
        NativeRunState.Building,
        NativeRunState.Admitting,
        NativeRunState.Starting,
        NativeRunState.Ready,
        NativeRunState.Stopping,
        NativeRunState.Stopped,
      ],
    );
    assert.equal(r.statuses[3]?.backend, "metal-angle");
    assert.match(run.status.runId, /^[0-9a-f]{12}$/);
  });

  it("a protocol 2 game's capability receipt is kept on its status; a protocol 1 game has none", async () => {
    const receipt = {
      tier: "core",
      backend: "metal",
      adapter: "Apple M4",
      nativeEnhanced: ["subgroup"],
      extensionApi: 1,
      customPassApi: 1,
    };
    const v2 = await registry(
      {},
      { ready: { protocol: 2, contractVersion: 2, backend: { api: "metal", device: "Apple M4" }, receipt } },
    );
    const rust = await started(v2, request("pond", NativeRunMode.Headless));
    assert.deepEqual(rust.status.receipt, receipt);
    assert.equal(rust.status.backend, "metal");
    const v1 = await registry();
    const raylib = await started(v1, request("pong", NativeRunMode.Headless));
    assert.equal(raylib.status.receipt, null);
  });

  it("a window run's focus reaches onFocus; a headless run's does not", async () => {
    const r = await registry();
    const heard: Array<[string, boolean]> = [];
    r.runs.onFocus((run, focused) => heard.push([run.mode, focused]));
    await started(r, request("pong", NativeRunMode.Window));
    await started(r, request("pong", NativeRunMode.Headless));
    r.games[1]?.send({ event: "focus", focused: true });
    r.games[0]?.send({ event: "focus", focused: true });
    await r.clock.settle();
    assert.deepEqual(heard, [[NativeRunMode.Window, true]]);
  });

  it("onStatus hears every change native.status announces; a listener that throws stops nothing", async () => {
    const lines: string[] = [];
    const r = await registry({ log: (line) => void lines.push(line) });
    const heard: string[] = [];
    r.runs.onStatus(() => {
      throw new Error("a broken listener");
    });
    const stop = r.runs.onStatus((run) => void heard.push(run.state));
    const run = await started(r, request("pong", NativeRunMode.Window));
    stop();
    await timedStop(r, run.status.runId);
    assert.deepEqual(
      heard,
      r.statuses.slice(0, 4).map((status) => status.state),
    );
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Stopped, "the run still ended");
    assert.ok(lines.some((line) => line.includes("a broken listener")));
  });

  it("kill ends a run killed with the refusal it names, by SIGKILL; an ended or unknown run is left alone", async () => {
    const r = await registry();
    const run = await started(r, request("pong", NativeRunMode.Headless));
    r.runs.kill(run.status.runId, NativeRefusal.FramesStalled);
    await r.clock.settle();
    assert.deepEqual(r.games[0]?.signals, ["SIGKILL"]);
    const last = r.statuses.at(-1);
    assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Killed, NativeRefusal.FramesStalled]);
    const count = r.statuses.length;
    r.runs.kill(run.status.runId, NativeRefusal.FramesInvalid);
    r.runs.kill("0123456789ab", NativeRefusal.FramesInvalid);
    await r.clock.settle();
    assert.equal(r.statuses.length, count, "nothing more happened");
  });

  it("an embedded start needs Live's frames: with none here it is refused, and nothing is registered or built", async () => {
    const r = await registry({ frames: null });
    await assert.rejects(
      r.runs.start(request("pong", NativeRunMode.Embedded, { surface: { width: 64, height: 64, dpr: 1 } })),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.EmbedUnsupported,
    );
    assert.deepEqual([r.statuses, r.prepared, r.games], [[], [], []]);
    assert.equal(r.runs.resize("pong", { width: 64, height: 64, dpr: 1 }), false);
    assert.equal(await r.runs.input("pong", [{ type: "tap", keys: ["Space"] }]), false);
  });

  it("portOf answers the window run, else the newest agent run", async () => {
    const r = await registry();
    assert.equal(r.runs.portOf("pong"), null);
    const first = await started(r, request("pong", NativeRunMode.Headless));
    const newest = await started(r, request("pong", NativeRunMode.Headless));
    assert.equal(r.runs.portOf("pong"), newest.port);
    assert.notEqual(r.runs.portOf("pong"), first.port);
    const window = await started(r, request("pong", NativeRunMode.Window));
    assert.equal(r.runs.portOf("pong"), window.port);
  });

  it("portOf answers the run Live shows (the embedded run) before an agent run, and the window before both", async () => {
    const r = await registry();
    const headless = await started(r, request("pong", NativeRunMode.Headless, { owner: "harness:1" }));
    const surface = { width: 64, height: 64, dpr: 1 };
    const embedded = await started(r, request("pong", NativeRunMode.Embedded, { surface }));
    assert.equal(r.runs.portOf("pong"), embedded.port, "Live's Native view is the run the person looks at");
    assert.notEqual(r.runs.portOf("pong"), headless.port);
    const window = await started(r, request("pong", NativeRunMode.Window));
    assert.equal(r.runs.portOf("pong"), window.port);
  });
});

describe("what a run logs", () => {
  it("stderr reaches native.log in batches of at most 200 lines, each cut at 2048, truncated when cut", async () => {
    const r = await registry();
    const run = await started(r, request("pong", NativeRunMode.Window));
    const game = r.games[0];
    assert.ok(game);
    game.stderr.write(`${"x".repeat(NATIVE_STDERR_LINE_MAX_CHARS + 5)}\n`);
    for (let line = 0; line < 450; line++) game.stderr.write(`WARNING: ${line}\n`);
    await r.clock.advance(NATIVE_HEARTBEAT_MS);
    assert.ok(r.logs.length > 0);
    for (const batch of r.logs) {
      assert.ok(batch.lines.length <= NATIVE_LOG_BATCH_MAX);
      assert.ok(batch.lines.every((line) => line.length <= NATIVE_STDERR_LINE_MAX_CHARS));
      assert.equal(batch.runId, run.status.runId);
    }
    assert.equal(r.logs[0]?.truncated, true);
    assert.equal(r.logs[0]?.lines[0]?.length, NATIVE_STDERR_LINE_MAX_CHARS);
    const delivered = r.logs.flatMap((batch) => batch.lines);
    assert.equal(delivered.length, 451, "every line arrives: a full batch goes out at once, none is dropped");
    assert.deepEqual(
      delivered.slice(1),
      Array.from({ length: 450 }, (_, line) => `WARNING: ${line}`),
      "in the order the game wrote them",
    );
    assert.ok(
      r.logs.slice(1).every((batch) => !batch.truncated),
      "only the batch with the cut line says truncated",
    );
  });

  it("a stderr flood is capped per flush window, said as truncated, and later lines arrive again", async () => {
    const r = await registry();
    await started(r, request("pong", NativeRunMode.Window));
    const game = r.games[0];
    assert.ok(game);
    const flood = 20_000;
    for (let line = 0; line < flood; line++) game.stderr.write(`flood ${line}\n`);
    await r.clock.advance(NATIVE_HEARTBEAT_MS);
    const delivered = r.logs.flatMap((batch) => batch.lines);
    assert.ok(delivered.length < flood, `a flood is cut: ${delivered.length} of ${flood}`);
    assert.ok(delivered.length >= 451, "an honest burst fits in one window");
    assert.deepEqual(
      delivered,
      Array.from({ length: delivered.length }, (_, line) => `flood ${line}`),
      "what arrives is the flood's start, in order",
    );
    assert.ok(r.logs.every((batch) => batch.lines.length <= NATIVE_LOG_BATCH_MAX));
    assert.ok(
      r.logs.some((batch) => batch.truncated),
      "the drop is said",
    );
    game.stderr.write("Segmentation fault: 11\n");
    await r.clock.advance(NATIVE_HEARTBEAT_MS);
    assert.equal(r.logs.at(-1)?.lines.at(-1), "Segmentation fault: 11", "the next window passes lines again");
  });
});

describe("the boot sweep", () => {
  it("kills only a pidfile's group whose start time still matches, removes every leftover run dir and follows no link", async () => {
    const outside = await tmpDir("native-sweep-outside-");
    await writeFile(path.join(outside, "keep.txt"), "untouched");
    const starts = new Map([
      [4101, "Thu Oct  1 09:00:00 2026"],
      [4102, "Thu Oct  1 09:30:00 2026"],
    ]);
    const r = await registry({ startedAt: async (pid) => starts.get(pid) ?? null });
    const leftover = async (id: string, pid: number, lstart: string) => {
      await mkdir(path.join(r.root, id), { recursive: true });
      await writeFile(path.join(r.root, id, "pid.json"), JSON.stringify({ pid, lstart }));
    };
    await leftover("aaaaaaaaaaaa", 4101, "Thu Oct  1 09:00:00 2026");
    await leftover("bbbbbbbbbbbb", 4102, "Wed Sep 30 23:00:00 2026");
    await leftover("cccccccccccc", 4103, "Thu Oct  1 08:00:00 2026");
    await mkdir(path.join(r.root, "dddddddddddd"));
    await symlink(outside, path.join(r.root, "eeeeeeeeeeee"));
    await mkdir(path.join(r.root, "ffffffffffff"));
    await symlink(path.join(outside, "keep.txt"), path.join(r.root, "ffffffffffff", "pid.json"));
    const killedCount = await r.runs.sweepOrphans();
    assert.equal(killedCount, 1);
    assert.deepEqual(r.killed, [[-4101, "SIGKILL"]], "only the group whose start time matches");
    assert.deepEqual(await readdir(r.root), [], "every leftover run dir is gone");
    assert.deepEqual(await readdir(outside), ["keep.txt"], "nothing behind a link was touched");
    assert.equal((await lstat(path.join(outside, "keep.txt"))).isFile(), true);
  });
});

/**
 * Per OS, with the platform injected. On Windows the game runs in the launcher's kill-on-close Job
 * Object: the run's child is the launcher, whose `kill` is the only handle the registry holds (the
 * scripted game below stands in for launcher and job together: ending the launcher ends the game).
 */
describe("stopping a run, per OS", () => {
  it("win32: quit, then the launcher handle (fd 3 closed, then the launcher ended); never a group signal or ps", async () => {
    let listed = 0;
    const r = await registry(
      {
        platform: "win32",
        descendants: async () => {
          listed += 1;
          return [7001];
        },
      },
      { ignoreQuit: true, ignoreTerm: true },
    );
    const run = await started(r, request("pong", NativeRunMode.Window, { target: BuildTarget.Windows }));
    const took = await timedStop(r, run.status.runId);
    assert.deepEqual(r.games[0]?.signals, ["SIGTERM", "SIGKILL"], "both through the launcher handle");
    assert.deepEqual(r.killed, [], "no pid or process group is signalled");
    assert.equal(listed, 0, "no descendants are listed: the job holds them");
    assert.ok(took <= NATIVE_STOP_BUDGET_MS, `${took}ms`);
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Killed);
  });

  it("linux: the group escalation as on a Mac, descendants included", async () => {
    const r = await registry(
      { platform: "linux", descendants: async () => [7001] },
      { ignoreQuit: true, ignoreTerm: true },
    );
    const run = await started(r, request("pong", NativeRunMode.Window, { target: BuildTarget.Linux }));
    await timedStop(r, run.status.runId);
    assert.deepEqual(r.games[0]?.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(r.killed, [[7001, "SIGKILL"]]);
    assert.equal(r.statuses.at(-1)?.state, NativeRunState.Killed);
  });

  it("win32: the boot sweep ends a matching launcher by its pid, never a group", async () => {
    const r = await registry({ platform: "win32", startedAt: async () => "Thu Oct  1 09:00:00 2026" });
    await mkdir(path.join(r.root, "aaaaaaaaaaaa"), { recursive: true });
    await writeFile(
      path.join(r.root, "aaaaaaaaaaaa", "pid.json"),
      JSON.stringify({ pid: 4101, lstart: "Thu Oct  1 09:00:00 2026" }),
    );
    assert.equal(await r.runs.sweepOrphans(), 1);
    assert.deepEqual(r.killed, [[4101, "SIGKILL"]]);
  });
});

describe("a game box that refused", () => {
  it("a spawn refused for want of a box ends refused no-game-box, with the box's problem", async () => {
    const r = await registry({
      spawn: async () => {
        throw new NativeError(NativeRefusal.NoGameBox, "no launcher", null, GameBoxProblem.LauncherMissing);
      },
    });
    const start = r.runs
      .start(request("pong", NativeRunMode.Window, { target: BuildTarget.Windows }))
      .catch((error: unknown) => error);
    await r.clock.settle();
    assert.ok((await start) instanceof NativeError);
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Refused);
    assert.equal(last?.refusal, NativeRefusal.NoGameBox);
    assert.equal(last?.box, GameBoxProblem.LauncherMissing);
  });

  it("a box that fails after the spawn (the launcher's own failure) ends the run refused, not crashed", async () => {
    const r = await registry();
    await started(r, request("pong", NativeRunMode.Window, { target: BuildTarget.Windows }));
    const refused = new NativeError(NativeRefusal.NoGameBox, "the launcher failed", null, GameBoxProblem.BoxRefused);
    r.games[0]?.reap({ code: 0xe0470008, signal: null, refused });
    await r.clock.settle();
    const last = r.statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Refused);
    assert.equal(last?.refusal, NativeRefusal.NoGameBox);
    assert.equal(last?.box, GameBoxProblem.BoxRefused);
  });
});

describe("a GPU that hangs, a device that comes back, and where a capture came from", () => {
  it("contract v2: a step past its deadline is gpu-hang: the group and its descendants get SIGKILL, and the run ends killed inside the reap margin even when the kernel never reaps it", async () => {
    const r = await registry({ descendants: async () => [7001] }, { ...V2_GAME, neverReaped: true });
    const run = await started(r, request("pond", NativeRunMode.Headless));
    const from = r.clock.now();
    // The looping shader's step: the game never answers it.
    const step = run.port.call(NativeOp.Step, { ms: 16 }).then(
      () => null,
      (error: unknown) => (error instanceof NativeError ? error.refusal : String(error)),
    );
    await r.clock.advance(NATIVE_CALL_TIMEOUT_MS);
    assert.equal(await step, NativeRefusal.GpuHang);
    assert.deepEqual(r.games[0]?.signals, ["SIGKILL"], "SIGKILL to the group at the deadline");
    assert.deepEqual(r.killed, [[7001, "SIGKILL"]], "a descendant outside the group is killed too");
    await r.clock.advance(NATIVE_REAP_MARGIN_MS);
    const last = r.statuses.at(-1);
    assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Killed, NativeRefusal.GpuHang]);
    const endedAt = Date.parse(last?.endedAt ?? "");
    assert.ok(
      endedAt - from <= NATIVE_CALL_TIMEOUT_MS + NATIVE_REAP_MARGIN_MS,
      "ended inside the deadline and the margin",
    );
    assert.equal(r.runs.state("pond", NativeRunMode.Headless), null, "Play is free for a fresh start");
  });

  it("contract v2: a long step with a heartbeat queued behind it is answered: the heartbeat waits, the step's own deadline decides", async () => {
    const r = await registry({}, { ...V2_GAME, holdSteps: true });
    const run = await started(r, request("pond", NativeRunMode.Headless));
    // Sent just before the first heartbeat, so that beat's state queues behind the step.
    await r.clock.advance(NATIVE_HEARTBEAT_MS - 1);
    const step = run.port.call(NativeOp.Step, { ms: 600_000 }).then(
      () => "answered",
      (error: unknown) => (error instanceof NativeError ? error.refusal : String(error)),
    );
    // Seven seconds of CPU-bound stepping: past a heartbeat's silence, inside the step's deadline.
    await r.clock.advance(LONG_STEP_MS);
    assert.equal(run.port.failure, null, "nothing ended the game while it owed the step");
    r.games[0]?.finishStep();
    assert.equal(await step, "answered");
    await r.clock.settle();
    assert.equal(run.port.failure, null);
    assert.notEqual(r.statuses.at(-1)?.state, NativeRunState.Killed, JSON.stringify(r.statuses.at(-1)));
    // The heartbeat comes back once nothing is owed: a game that then goes silent is unresponsive.
    await r.clock.advance(NATIVE_HEARTBEAT_MS * 3);
    assert.equal(run.port.failure, null, "the game answers its heartbeats again");
  });

  it("contract v2: a game silent while it owes a capture is gpu-hang at the capture's deadline, which the heartbeat waits for; silent owing nothing stays unresponsive", async () => {
    const hung = await registry({}, { ...V2_GAME, silent: true });
    const run = await started(hung, request("pond", NativeRunMode.Headless));
    // Asked just after the run is ready: the capture's own deadline falls after the heartbeat's.
    await hung.clock.advance(1);
    void run.port.screenshotWithStats().catch(() => {});
    await hung.clock.advance(NATIVE_HEARTBEAT_MS * 2);
    const last = hung.statuses.at(-1);
    assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Killed, NativeRefusal.GpuHang]);
    const wedged = await registry({}, { ...V2_GAME, silent: true });
    await started(wedged, request("pond", NativeRunMode.Headless));
    await wedged.clock.advance(NATIVE_HEARTBEAT_MS * 2);
    assert.equal(wedged.statuses.at(-1)?.refusal, NativeRefusal.Unresponsive);
  });

  it("a killed game the kernel reaps at once ends with its exit, and the reap margin adds nothing", async () => {
    const r = await registry({}, V2_GAME);
    const run = await started(r, request("pond", NativeRunMode.Headless));
    r.runs.kill(run.status.runId, NativeRefusal.GpuHang);
    await r.clock.settle();
    const last = r.statuses.at(-1);
    assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Killed, NativeRefusal.GpuHang]);
    assert.deepEqual(last?.exit, { code: null, signal: "SIGKILL" });
    const count = r.statuses.length;
    await r.clock.advance(NATIVE_REAP_MARGIN_MS);
    assert.equal(r.statuses.length, count, "nothing more happened");
  });

  /** A frames host that records every ring it announces. */
  function recordingFrames() {
    const rings: Array<{ runId: string; generation: number }> = [];
    const frames = quietFrames();
    const ring = frames.ring;
    frames.ring = (runId, size) => {
      const made = ring(runId, size);
      rings.push({ runId, generation: made.generation });
      return made;
    };
    return { frames, rings };
  }

  /** The `surface` ops the game was sent. */
  const surfaces = (game: Game | undefined) => (game?.ops ?? []).filter((op) => op === NativeOp.Surface).length;

  it("contract v2: a game that restored its lost device gets a new ring generation at once, so the old one's slots are refused", async () => {
    const { frames, rings } = recordingFrames();
    const r = await registry({ frames }, V2_GAME);
    const status = r.runs.embed({
      project: "pond",
      target: BuildTarget.Mac,
      surface: { width: 320, height: 180, dpr: 2 },
    });
    await r.clock.settle();
    const run = await status;
    assert.deepEqual(
      rings.map((ring) => ring.generation),
      [1],
    );
    r.games[0]?.send({ event: NativeEvent.DeviceRestored });
    await r.clock.settle();
    assert.deepEqual(
      rings.map((ring) => ring.generation),
      [1, 2],
      "a new generation, without waiting out the resize debounce",
    );
    assert.equal(surfaces(r.games[0]), 2, "the game was told the new ring");
    assert.equal(r.runs.state("pond", NativeRunMode.Embedded)?.state, NativeRunState.Ready, "the run goes on");
    await r.runs.stop(run.runId);
  });

  it("a restored device of a run that has no ring, or that is stopping, announces nothing", async () => {
    const { frames, rings } = recordingFrames();
    const r = await registry({ frames }, V2_GAME);
    await started(r, request("pond", NativeRunMode.Headless));
    r.games[0]?.send({ event: NativeEvent.DeviceRestored });
    await r.clock.settle();
    assert.equal(rings.length, 0, "a headless run has no ring to replace");
    const embedded = r.runs.embed({
      project: "pond",
      target: BuildTarget.Mac,
      surface: { width: 320, height: 180, dpr: 1 },
    });
    await r.clock.settle();
    const run = await embedded;
    const stopping = r.runs.stop(run.runId);
    r.games[1]?.send({ event: NativeEvent.DeviceRestored });
    await r.clock.advance(NATIVE_STOP_BUDGET_MS);
    await stopping;
    assert.deepEqual(
      rings.map((ring) => ring.generation),
      [1],
      "a stopping run is not rung again",
    );
  });

  it("a capture carries its provenance: the game's seq, the digest, the camera, the run id and the build prepare admitted", async () => {
    const build: BuildIdentity = {
      stack: GameStack.RustWgpu,
      target: BuildTarget.Mac,
      digest: "a".repeat(64),
      lock: "b".repeat(64),
    };
    const root = await tmpDir("native-runs-build-");
    const r = await registry({
      root,
      prepare: async (req) => {
        const runDir = path.join(root, req.runId);
        await mkdir(path.join(runDir, "state"), { recursive: true });
        const state = path.join(runDir, "state");
        return {
          runId: req.runId,
          runDir,
          exe: path.join(runDir, "game"),
          bundle: runDir,
          state,
          bundleId: null,
          build,
        };
      },
    });
    const run = await started(r, request("pond", NativeRunMode.Headless));
    const shot = await run.port.screenshotWithStats();
    assert.deepEqual(shot.provenance, {
      seq: 1,
      digest: fnv1a64Hex(CAPTURED),
      camera: "default",
      runId: run.status.runId,
      build,
    });
    await r.runs.stop(run.status.runId);
  });

  it("a run whose prepare names no build says so: the provenance's build is null, never guessed", async () => {
    const r = await registry();
    const run = await started(r, request("pong", NativeRunMode.Headless));
    const shot = await run.port.screenshotWithStats();
    assert.equal(shot.provenance.build, null);
    assert.equal(shot.provenance.runId, run.status.runId);
    await r.runs.stop(run.status.runId);
  });
});

describe("play-time AI: the runs the studio answers", () => {
  it("a run playAi answers is spawned with ai and its port starts the link; a run it does not answer gets neither", async () => {
    const asked: unknown[] = [];
    const requests: GameSpawnRequest[] = [];
    const linked: string[] = [];
    const link: NativeAiLink = { hear: () => {}, boundary: async () => {}, flush: async () => {}, close: () => {} };
    const behaviour: Behaviour = { ready: { capabilities: { ai: true } } };
    let pid = 7000;
    const r = await registry(
      {
        playAi: (run) => {
          asked.push(run);
          if (run.project !== "oracle") return null;
          return () => {
            linked.push(run.runId);
            return link;
          };
        },
        spawn: async (request) => {
          requests.push(request);
          pid += 1;
          return scriptedGame(request, pid, behaviour).child;
        },
      },
      behaviour,
    );
    const answered = await started(r, request("oracle", NativeRunMode.Headless));
    const plain = await started(r, request("pong", NativeRunMode.Headless));
    assert.deepEqual(asked, [
      { project: "oracle", runId: answered.status.runId, mode: NativeRunMode.Headless, target: BuildTarget.Mac },
      { project: "pong", runId: plain.status.runId, mode: NativeRunMode.Headless, target: BuildTarget.Mac },
    ]);
    assert.equal(requests[0]?.ai, true);
    assert.equal(Object.hasOwn(requests[1] ?? {}, "ai"), false);
    assert.deepEqual(linked, [answered.status.runId], "only the answered run's port started a link");
    await r.runs.stopAll();
  });
});
