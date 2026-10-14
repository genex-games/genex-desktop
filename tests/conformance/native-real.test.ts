/**
 * Native runs for real (darwin, Apple silicon): games started by the real `spawnGame` under the
 * real game profile, from run directories the real `assembleRunDir` made out of bundles the real
 * admission let through, spoken to by the real port and stopped by the real registry. A small C
 * protocol game proves the transport, the capture digest and the stop escalation; the starter
 * template, built by the real C++ lane for the Mac from the dev store, proves a headless agent run
 * on ANGLE-Metal and a window run. No row leaves a process running.
 *
 * Required when present: the owned ANGLE (`angleMac`) and, for the template, the dev store with a
 * Mac prewarm (`GENEX_REQUIRE_TOOLCHAINS=1` turns their absence into a failure).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Duplex, Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import {
  NATIVE_QUIT_GRACE_MS,
  NATIVE_READY_TIMEOUT_MS,
  NATIVE_STOP_BUDGET_MS,
  NATIVE_TERM_GRACE_MS,
  NativeBackend,
  NativeOp,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import { NativeRuns, type NativeRunsOptions, type PreparedRun } from "../../src/main/core/native-runs.ts";
import { execHost } from "../../src/main/core/toolchains.ts";
import { CppBuilds } from "../../src/main/cpp-build.ts";
import { gameSandboxProfile, prepareGameLaunch } from "../../src/substrate/game-sandbox-profile.ts";
import { admitMacBundle, assembleRunDir, type MacAngle, removeRunDir } from "../../src/substrate/native-bundle.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { type GameChild, type GameSpawnRequest, ProcessSandbox } from "../../src/substrate/spawn.ts";
import { locateToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { DEV_TOOLCHAINS, devStoreLock, devTool, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { raylibLanes } from "../helpers/game-lanes.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PROTOCOL_GAME = path.join(REPO, "tests", "cpp", "protocol_game.c");
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-W2-RUNTIME");
/** The bundle id the runs here are signed with: a game's once-chosen id, as the library keeps it. */
const BUNDLE_ID = "games.genex.game.0123456789ab";
/** A cold Mac build of the template (configure included). */
const REAL_BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
/** One fake-clock step while a real process runs, and the real pause after it for its I/O to land. */
const FAKE_STEP_MS = 250;
const REAL_PAUSE_MS = 10;

const MAC_HOST =
  process.platform === "darwin" && process.arch === "arm64"
    ? {}
    : { skip: "not run: native runs need an Apple silicon Mac" };

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

/** The real clock. */
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** A clock the row moves by hand, while the real processes behind it run in real time. */
function fakeClock() {
  let now = 0;
  const due: Array<{ at: number; run: () => void }> = [];
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      due.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = due.findIndex((timer) => timer === handle);
      if (index >= 0) due.splice(index, 1);
    },
  };
  /** Moves the clock one step, runs what fell due, and lets real I/O land. */
  const step = async () => {
    now += FAKE_STEP_MS;
    due.sort((a, b) => a.at - b.at);
    while (due[0] && due[0].at <= now) due.shift()?.run();
    await new Promise((resolve) => setTimeout(resolve, REAL_PAUSE_MS));
  };
  return { timers, step, now: () => now };
}

/** The owned Metal-only ANGLE, as the store names it: its folder, both libraries and its manifest's digest. */
async function ownedAngle(): Promise<MacAngle> {
  const tool = devTool("angleMac");
  assert.ok("path" in tool, "the owned ANGLE");
  const dir = await realpath(tool.path);
  const manifest = await readFile(path.join(dir, "manifest.json"));
  return {
    dir,
    egl: path.join(dir, "libEGL.dylib"),
    gles: path.join(dir, "libGLESv2.dylib"),
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  };
}

/** The protocol game built as a Mac game's `out/`: a thin arm64 `game-headless` importing ANGLE through the bundle's rpath. */
async function buildProtocolGame(angle: MacAngle, out: string, stubborn: boolean): Promise<void> {
  await mkdir(out, { recursive: true });
  const args = ["clang", "-arch", "arm64", "-mmacosx-version-min=13.0", "-O1", "-o", path.join(out, "game-headless")];
  if (stubborn) args.push("-DSTUBBORN");
  args.push(PROTOCOL_GAME, `-L${angle.dir}`, "-lEGL", "-lGLESv2", "-Wl,-rpath,@executable_path/../Frameworks");
  await execFileAsync("/usr/bin/xcrun", args);
}

/** The options each registry here was made with, so a row can make a variant of one. */
const OPTIONS = new WeakMap<NativeRuns, NativeRunsOptions>();
function runsOptions(runs: NativeRuns): NativeRunsOptions {
  const options = OPTIONS.get(runs);
  assert.ok(options);
  return options;
}

/** A registry over the real game box: `prepare` is given, everything else is the product's. */
function realRegistry(
  sandbox: ProcessSandbox,
  root: string,
  prepare: NativeRunsOptions["prepare"],
  timers: NativeTimers,
): { runs: NativeRuns; statuses: NativeRunStatus[] } {
  const statuses: NativeRunStatus[] = [];
  const options: NativeRunsOptions = {
    root,
    prepare,
    spawn: (request) => sandbox.spawnGame(request),
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
    },
    timers,
  };
  const runs = new NativeRuns(options);
  OPTIONS.set(runs, options);
  return { runs, statuses };
}

/** Admission and assembly of `out` for each run, as `prepareNativeRun` does after the build. */
function assembledFrom(root: string, angle: MacAngle, out: string): NativeRunsOptions["prepare"] {
  return async (request): Promise<PreparedRun> => {
    const admission = await admitMacBundle(out, { mode: request.mode });
    assert.ok(admission.ok, JSON.stringify(admission));
    const run = await assembleRunDir({
      root,
      runId: request.runId,
      admitted: admission.bundle,
      angle,
      bundleId: BUNDLE_ID,
      uiElement: true,
      exec: execHost,
    });
    return { runId: request.runId, ...run, bundleId: BUNDLE_ID };
  };
}

/** The real `spawnGame`, with each group signal noted at the fake time it was sent. */
function signalNoting(sandbox: ProcessSandbox, now: () => number, signals: Array<[NodeJS.Signals, number]>) {
  return async (request: GameSpawnRequest): Promise<GameChild> => {
    const child = await sandbox.spawnGame(request);
    return {
      ...child,
      kill: (signal) => {
        signals.push([signal, now()]);
        child.kill(signal);
      },
    };
  };
}

describe("a protocol game under the real game box", { ...MAC_HOST, ...needsTools("angleMac") }, () => {
  let angle: MacAngle;
  let sandbox: ProcessSandbox;
  let root: string;
  let builds: string;
  before(async () => {
    angle = await ownedAngle();
    const scratch = await realpath(await tmpDir("native-real-"));
    root = path.join(scratch, "native-runs");
    builds = path.join(scratch, "builds");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await buildProtocolGame(angle, path.join(builds, "good"), false);
    await buildProtocolGame(angle, path.join(builds, "stubborn"), true);
    sandbox = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(scratch, "scratch"),
      secretPaths: [],
      enabled: false,
      nativeRunsRoot: root,
    });
  });
  after(async () => {
    await sandbox?.dispose();
  });

  it("is ready, answers state, and a capture's digest matches; stop reaps it and removes its run dir", async () => {
    const { runs, statuses } = realRegistry(
      sandbox,
      root,
      assembledFrom(root, angle, path.join(builds, "good")),
      REAL_TIMERS,
    );
    const run = await runs.start({ project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid;
    assert.ok(pid);
    assert.equal(run.status.state, NativeRunState.Ready);
    assert.deepEqual(await run.port.studioState(), { tick: 1 });
    const shot = await run.port.screenshotWithStats();
    assert.equal(shot.stats.width, 2);
    assert.ok(shot.stats.litFraction > 0, "a non-blank capture");
    await runs.stop(run.status.runId);
    assert.equal(statuses.at(-1)?.state, NativeRunState.Stopped);
    assert.deepEqual(statuses.at(-1)?.exit, { code: 0, signal: null });
    assert.equal(running(pid), false, "nothing left running");
    assert.deepEqual(await readdir(root), [], "the run dir is gone");
  });

  it("a game that ignores quit and SIGTERM is escalated to SIGKILL after both graces, and reaped inside the margin", async () => {
    const clock = fakeClock();
    const { runs, statuses } = realRegistry(
      sandbox,
      root,
      assembledFrom(root, angle, path.join(builds, "stubborn")),
      clock.timers,
    );
    const signals: Array<[NodeJS.Signals, number]> = [];
    const spawned = new NativeRuns({ ...runsOptions(runs), spawn: signalNoting(sandbox, clock.now, signals) });
    const run = await spawned.start({ project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid;
    assert.ok(pid);
    const from = clock.now();
    let stopped = false;
    const stopping = spawned.stop(run.status.runId).then(() => {
      stopped = true;
    });
    while (!stopped && clock.now() - from <= 2 * NATIVE_STOP_BUDGET_MS) await clock.step();
    await stopping;
    const [term, kill] = signals;
    assert.deepEqual(
      signals.map(([signal]) => signal),
      ["SIGTERM", "SIGKILL"],
    );
    assert.ok(term && term[1] - from >= NATIVE_QUIT_GRACE_MS, "SIGTERM only after the quit grace");
    assert.ok(kill && kill[1] - from >= NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS, "SIGKILL only after both graces");
    const last = statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed);
    assert.equal(
      last?.exit?.signal,
      "SIGKILL",
      "reaped by the kernel inside the reap margin (not the margin's fallback)",
    );
    assert.equal(running(pid), false, "nothing left running");
  });
});

/**
 * The template in a fresh library, the real lane over the dev store, and a registry whose runs
 * are prepared by the real `prepareNativeRun`; statuses and stderr lines are collected.
 */
async function templateRig(statuses: NativeRunStatus[], evidence: string[]) {
  const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
  const toolchains = await realpath(DEV_TOOLCHAINS);
  const scratch = await realpath(await tmpDir("native-real-template-"));
  const layout = layoutFor(path.join(scratch, "userData"));
  const dir = path.join(scratch, "games", "pong");
  await cp(TEMPLATE, dir, { recursive: true });
  await mkdir(layout.nativeRuns, { recursive: true, mode: 0o700 });
  const sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(scratch, "games")],
    scratchDir: layout.scratch,
    secretPaths: [],
    denyWrite: [...studioBaseDenyWrites(layout, [dir]), store, toolchains],
    nativeRunsRoot: layout.nativeRuns,
  });
  const lane = new CppBuilds({
    root: layout.cppBuilds,
    run: (request) => sandbox.run(request),
    locate: (lock, targets) => locateToolchain(store, lock, targets),
    currentLock: () => devStoreLock(),
    emit: () => {},
    platform: process.platform,
    cores: os.availableParallelism(),
    denyWrite: [store, toolchains, layout.nativeRuns],
    writeLock: async () => {},
  });
  const game: GameProject = {
    name: "pong",
    dir,
    title: "Pong",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/pong",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    built: false,
    shape: {
      entry: "index.html",
      main: "src/main.cpp",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RaylibCpp,
      serve: ".",
    },
    destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] },
  };
  const deps: NativePrepareDeps = {
    root: layout.nativeRuns,
    host: StudioPlatform.Mac,
    gameBox: () => sandbox.gameBoxAvailable(),
    games: { list: async () => [game], bundleIdFor: async () => BUNDLE_ID },
    gameBuilds: raylibLanes(lane),
    toolchains: {
      currentLock: () => devStoreLock(),
      locate: (lock, targets) => locateToolchain(store, lock, targets),
    },
    exec: execHost,
  };
  const runs = new NativeRuns({
    root: layout.nativeRuns,
    prepare: (request, signal) => prepareNativeRun(deps, request, signal),
    spawn: (request) => sandbox.spawnGame(request),
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
      if (event.type === UiEvent.NativeLog) evidence.push(...event.payload.lines);
    },
    timers: REAL_TIMERS,
  });
  return { sandbox, runs, deps, root: layout.nativeRuns };
}

describe("the starter template, built by the real lane, under the real game box", {
  ...MAC_HOST,
  ...needsTools("devStore", "angleMac"),
  ...(process.platform === "darwin" ? needsPrewarmed(BuildTarget.Mac) : {}),
  timeout: REAL_BUILD_TIMEOUT_MS,
}, () => {
  let rig: Awaited<ReturnType<typeof templateRig>>;
  const statuses: NativeRunStatus[] = [];
  const evidence: string[] = [];
  before(async () => {
    rig = await templateRig(statuses, evidence);
  });
  after(async () => {
    await rig?.runs.stopAll();
    await rig?.sandbox.dispose();
    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(
      path.join(EVIDENCE, "native-real-template.txt"),
      `${JSON.stringify(statuses, null, 2)}\n--- stderr ---\n${evidence.join("\n")}\n`,
    );
  });

  it("an agent's headless run is ready on ANGLE-Metal within the ready timeout; a non-blank capture's digest matches; stop reaps", async () => {
    const startedAt = Date.now();
    const run = await rig.runs.start({ project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid;
    assert.ok(pid);
    const readyAt = statuses.find(
      (status) => status.runId === run.status.runId && status.state === NativeRunState.Ready,
    );
    assert.ok(readyAt, "ready");
    const backend = run.status.backend;
    const shot = await run.port.screenshotWithStats().finally(() => rig.runs.stop(run.status.runId));
    evidence.push(
      `headless: backend ${backend}, capture ${JSON.stringify(shot.stats)}, started to stopped in ${Date.now() - startedAt}ms (ready timeout ${NATIVE_READY_TIMEOUT_MS}ms)`,
    );
    assert.ok(shot.stats.litFraction > 0, `a non-blank capture: ${JSON.stringify(shot.stats)}`);
    assert.equal(running(pid), false, "nothing left running");
    assert.equal(backend, NativeBackend.MetalAngle, "the game reports ANGLE-Metal");
  });

  it("a window run is ready, comes to the front, captures, and quits with exit 0", async () => {
    const run = await rig.runs.start({ project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Window });
    const pid = run.status.pid;
    assert.ok(pid);
    assert.equal(run.status.state, NativeRunState.Ready);
    assert.deepEqual(await run.port.call(NativeOp.Front), { fronted: true });
    const shot = await run.port.screenshotWithStats();
    assert.ok(shot.stats.width > 0);
    const ended = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (run.status.state !== NativeRunState.Ready) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    await run.port.call(NativeOp.Quit);
    await ended;
    assert.equal(run.status.state, NativeRunState.Stopped);
    assert.deepEqual(run.status.exit, { code: 0, signal: null });
    assert.equal(running(pid), false, "nothing left running");
  });
});

/** How long each Play window is watched for the view-bridge measurement. */
const VIEW_BRIDGE_WATCH_MS = 5000;
/** How long a measured window may take to end once told to (its ready is the port's own timeout). */
const VIEW_BRIDGE_EXIT_MS = 5000;
/** The AppKit listener whose endpoint a sandboxed window keeps asking for, as NSLog names it. */
const VIEW_BRIDGE = "'com.apple.view-bridge'";
const VIEW_BRIDGE_EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-W3-MAC-FIXES", "view-bridge.txt");

/** The window profile with one more filter (`(global-name "…")`, `(xpc-service-name "…")`) in its mach-lookup rule. */
function withLookup(profile: string, filter: string): string {
  return profile.replace(
    /^\(allow mach-lookup (.*)\)$/m,
    (_, names: string) => `(allow mach-lookup ${names} ${filter})`,
  );
}

/** What one measured Play window wrote to stderr while it was watched, and what the port passed on. */
interface WindowStderr {
  /** Raw stderr lines naming the view-bridge listener. */
  viewBridge: number;
  /** Every raw stderr line. */
  lines: number;
  /** The lines the port wrote to its console and listeners (each a native log line for Live). */
  emitted: number;
  other: string[];
}

/**
 * Starts the prepared run's window under `profile` exactly as `spawnGame` would (the product's own
 * launch, then the profile text swapped), through the real port; counts its raw stderr and what
 * the port passes on for `VIEW_BRIDGE_WATCH_MS` after its ready, then ends its process group.
 */
async function watchWindow(root: string, prepared: PreparedRun, profile: string): Promise<WindowStderr> {
  const nonce = "a1b2c3d4";
  const launch = await prepareGameLaunch({ ...prepared, mode: NativeRunMode.Window, nonce }, root);
  await writeFile(launch.args[launch.args.indexOf("-f") + 1] ?? "", profile, { mode: 0o600 });
  const child = spawn(launch.file, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const pid = child.pid ?? 0;
  const kill = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-pid, signal);
  };
  const game: GameChild = {
    pid,
    fd3: child.stdio[3] as Duplex,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    exited,
    kill,
  };
  const seen: WindowStderr = { viewBridge: 0, lines: 0, emitted: 0, other: [] };
  let watching = false;
  let held = "";
  game.stderr.on("data", (chunk: Buffer) => {
    held += chunk.toString("utf8");
    const lines = held.split("\n");
    held = lines.pop() ?? "";
    if (!watching) return;
    for (const line of lines) {
      seen.lines += 1;
      if (line.includes(VIEW_BRIDGE)) seen.viewBridge += 1;
      else if (seen.other.length < 20) seen.other.push(line);
    }
  });
  const port = new NativeGamePort({
    child: game,
    nonce,
    mode: NativeRunMode.Window,
    stateDir: launch.cwd,
    timers: REAL_TIMERS,
    project: "pong",
    encodeJpeg: async (bgra) => Buffer.from(bgra),
  });
  port.onStderr(() => {
    if (watching) seen.emitted += 1;
  });
  try {
    await port.ready();
    watching = true;
    await sleep(VIEW_BRIDGE_WATCH_MS);
    watching = false;
  } finally {
    kill("SIGTERM");
    const ended = await Promise.race([exited.then(() => true), sleep(VIEW_BRIDGE_EXIT_MS).then(() => false)]);
    if (!ended) kill("SIGKILL");
    await exited;
  }
  return seen;
}

/**
 * ACC-06: AppKit in a Play window asks, about 120 times a second, for an endpoint the window
 * profile does not let it reach. The decision rule: grant the name only if that stops the flood and
 * no remote view service (open and save panels, sharing) becomes reachable. Measured here on the
 * real starter, built by the real lane and started from a real run directory.
 */
describe("the window profile and AppKit's view-bridge (measured)", {
  ...MAC_HOST,
  ...needsTools("devStore", "angleMac"),
  ...(process.platform === "darwin" ? needsPrewarmed(BuildTarget.Mac) : {}),
  timeout: REAL_BUILD_TIMEOUT_MS,
}, () => {
  let rig: Awaited<ReturnType<typeof templateRig>>;
  before(async () => {
    rig = await templateRig([], []);
  });
  after(async () => {
    await rig?.runs.stopAll();
    await rig?.sandbox.dispose();
  });

  it("a Play window's view-bridge flood is the same with com.apple.view-bridge granted, so it stays denied and the port collapses it", async () => {
    const prepare = async () =>
      prepareNativeRun(
        rig.deps,
        { project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Window, runId: randomBytes(8).toString("hex") },
        new AbortController().signal,
      );
    const profile = gameSandboxProfile({ mode: NativeRunMode.Window });
    const watch = async (text: string) => {
      const prepared = await prepare();
      try {
        return await watchWindow(rig.root, prepared, text);
      } finally {
        await removeRunDir(prepared.runDir);
      }
    };
    const current = await watch(profile);
    const granted = await watch(withLookup(profile, '(global-name "com.apple.view-bridge")'));
    const auxiliary = await watch(withLookup(profile, '(xpc-service-name "com.apple.ViewBridgeAuxiliary")'));
    const perSecond = (seen: WindowStderr) => (seen.viewBridge * 1000) / VIEW_BRIDGE_WATCH_MS;
    const report = { watchMs: VIEW_BRIDGE_WATCH_MS, current, granted, auxiliary };
    await mkdir(path.dirname(VIEW_BRIDGE_EVIDENCE), { recursive: true });
    await writeFile(
      VIEW_BRIDGE_EVIDENCE,
      `${JSON.stringify(report, (key, value) => (key === "viewBridge" ? { lines: value, perSecond: (value * 1000) / VIEW_BRIDGE_WATCH_MS } : value), 2)}\n`,
    );
    // The decision, measured on macOS 26.6.2 (M4 Max): the window keeps asking about 117 times a
    // second whether com.apple.view-bridge is granted or not (the denial is ViewBridgeAuxiliary's
    // XPC lookup, and granting that does not stop it either), so neither is granted and the port
    // collapses the repeats instead.
    assert.ok(perSecond(current) > 10, `the flood this decision is about: ${JSON.stringify(current)}`);
    assert.ok(granted.viewBridge * 2 > current.viewBridge, `the grant does not stop it: ${JSON.stringify(report)}`);
    for (const name of ["com.apple.view-bridge", "com.apple.ViewBridgeAuxiliary"])
      assert.ok(!profile.includes(name), name);
    // What reaches Live's log and the console: a handful of lines where the game wrote hundreds.
    for (const seen of [current, granted, auxiliary])
      assert.ok(seen.emitted * 50 < seen.lines, `the port passed on ${seen.emitted} of ${seen.lines} lines`);
  });
});
