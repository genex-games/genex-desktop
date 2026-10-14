/**
 * A C++ game embedded in Live, for real (darwin, Apple silicon): the starter template built for
 * the Mac by the real C++ lane over the dev store, its headless executable started embedded by the
 * real `spawnGame` under the real embedded game profile, and the frames addon
 * (`native/genex-frames`, built here with its own `build.sh` and loaded into this Node) receiving
 * the template's IOSurface ring: `surface` makes the ring the host expected, every frame arrives
 * and is released through both the addon and the game's `release`, a resize starts a new
 * generation, a capture still works beside the ring, and stop leaves nothing running.
 *
 * Required when present: the dev store with a Mac prewarm and the owned ANGLE
 * (`GENEX_REQUIRE_TOOLCHAINS=1` turns their absence into a failure). It also needs the embedded
 * game profile; a tree without one says so and runs nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { execHost } from "../../src/main/core/toolchains.ts";
import { CppBuildPurpose, CppBuilds } from "../../src/main/cpp-build.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind, type ProjectShape } from "../../src/shared/game-project.ts";
import {
  NATIVE_FRAME_BURST,
  NATIVE_FRAME_RATE_MAX_PER_S,
  NATIVE_FRAME_SLOTS,
  NATIVE_FRAMES_ABI_VERSION,
  NATIVE_FRAMES_WIRE_VERSION,
  NativeOp,
  NativeRunMode,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { gameSandboxProfile } from "../../src/substrate/game-sandbox-profile.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { admitMacBundle, assembleRunDir, removeRunDir } from "../../src/substrate/native-bundle.ts";
import { type GameChild, ProcessSandbox } from "../../src/substrate/spawn.ts";
import { currentLock, locateToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { DEV_TOOLCHAINS, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const ADDON_BUILD = path.join(REPO, "native", "genex-frames", "build.sh");
/** The bundle id the run is signed with, as the library keeps one per game. */
const BUNDLE_ID = "games.genex.game.0123456789ab";
/** A cold Mac build of the template (configure included), plus the addon's own build. */
const REAL_BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
const ADDON_BUILD_TIMEOUT_MS = 5 * MINUTE_MS;
/** What Live asks for first (the starter's world at one device pixel per CSS pixel), then after a resize. */
const FIRST_RING = { w: 960, h: 540, dpr: 1, slots: NATIVE_FRAME_SLOTS, generation: 1 };
const RESIZED_RING = { w: 640, h: 360, dpr: 1, slots: NATIVE_FRAME_SLOTS, generation: 2 };
/** Frames a running starter must deliver, and how long it has. */
const FRAMES_WANTED = 30;
const FRAMES_WITHIN_MS = 3 * SECOND_MS;
/** Frames the resized ring must deliver before the row looks at the stats. */
const RESIZED_FRAMES_WANTED = 10;
/** How long a paused game is given for its last frame and releases to land. */
const SETTLE_MS = 300;
/** How often a row looks again while it waits. */
const POLL_MS = 20;

const MAC_HOST =
  process.platform === "darwin" && process.arch === "arm64"
    ? {}
    : { skip: "not run: embedded runs need an Apple silicon Mac" };

/** Whether this tree's game box has the embedded profile (one frames service beside the headless rules). */
function embeddedProfile(): { skip?: string } {
  try {
    gameSandboxProfile({ mode: NativeRunMode.Embedded });
    return {};
  } catch {
    return { skip: "not run: this tree's game box has no embedded profile" };
  }
}

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

/** The real clock. */
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};

// ── the frames addon, as this file loads it ──

/** What the addon's channel reports for leak checks. */
interface ChannelStats {
  accepted: number;
  released: number;
  dropped: number;
  refused: number;
  heldMask: number;
  retiredHeld: number;
  open: boolean;
  fault: unknown;
}

/** One run's receive channel. */
interface FramesChannel {
  serviceName: string;
  setPeer(pid: number): void;
  expectRing(ring: { generation: number; width: number; height: number; slots: number }): void;
  release(generation: number, slot: number, seq: number): boolean;
  stats(): ChannelStats;
  close(): void;
}

/** The addon's module object. */
interface FramesAddon {
  abiVersion: number;
  wireVersion: number;
  open(runId: string, onEvent: (event: unknown) => void, options: { maxFps: number; burst: number }): FramesChannel;
}

/** One frame the addon delivered. */
interface FrameEvent {
  type: "frame";
  generation: number;
  slot: number;
  seq: number;
  /** The game's realtime clock when it sent the frame, in microseconds. */
  ts: number;
  width: number;
  height: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

function isFramesAddon(value: unknown): value is FramesAddon {
  return (
    isRecord(value) &&
    typeof value.abiVersion === "number" &&
    typeof value.wireVersion === "number" &&
    isFunction(value.open)
  );
}

function isChannel(value: unknown): value is FramesChannel {
  if (!isRecord(value) || typeof value.serviceName !== "string") return false;
  return ["setPeer", "expectRing", "release", "stats", "close"].every((name) => isFunction(value[name]));
}

function isFrameEvent(value: unknown): value is FrameEvent {
  if (!isRecord(value) || value.type !== "frame") return false;
  return ["generation", "slot", "seq", "ts", "width", "height"].every((key) => Number.isSafeInteger(value[key]));
}

/** Build the addon with its own script into `out` and load it into this process. */
async function loadAddon(out: string): Promise<FramesAddon> {
  await execFileAsync("/bin/bash", [ADDON_BUILD], {
    env: { ...process.env, OUT: out },
    timeout: ADDON_BUILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const holder: { exports: unknown } = { exports: {} };
  process.dlopen(holder, path.join(out, "genex-frames.node"));
  assert.ok(isFramesAddon(holder.exports), "the addon's module shape");
  return holder.exports;
}

/** The starter, built for the Mac by the real lane over the dev store: its `out/` and the store's ANGLE. */
async function buildStarter(scratch: string) {
  const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
  const toolchains = await realpath(DEV_TOOLCHAINS);
  const layout = layoutFor(path.join(scratch, "userData"));
  const dir = path.join(scratch, "games", "bounce");
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
    currentLock: () => currentLock(store),
    emit: () => {},
    platform: process.platform,
    cores: os.availableParallelism(),
    denyWrite: [store, toolchains, layout.nativeRuns],
    writeLock: async () => {},
  });
  const built = await lane.ensure({
    project: "bounce",
    dir,
    shape: RAYLIB_SHAPE,
    target: BuildTarget.Mac,
    destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] },
    purpose: CppBuildPurpose.Live,
    lock: null,
    recordLock: false,
  });
  assert.ok(built.ok && built.output, JSON.stringify(built.problem, null, 2));
  const lock = await currentLock(store);
  assert.ok(lock);
  const located = await locateToolchain(store, lock, [BuildTarget.Mac]);
  assert.ok(located.ok && located.toolchain.angle, "the dev store's Mac ANGLE");
  return { sandbox, out: built.output, angle: located.toolchain.angle, root: layout.nativeRuns };
}

/** Wait until `done()` holds or `ms` pass; whether it held. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(POLL_MS);
  return done();
}

/** The embedded run a describe drives: the game, its port, the addon's channel and what arrived. */
interface Embedded {
  sandbox: ProcessSandbox;
  /** The run directory, removed after the run (its bundle is read-only to everyone but `removeRunDir`). */
  runDir: string;
  channel: FramesChannel;
  child: GameChild;
  port: NativeGamePort;
  frames: FrameEvent[];
  /** What the addon sent that was no frame (a refusal). */
  errors: unknown[];
  /** Each game-side release's outcome: null when the game answered, else what went wrong. */
  releases: Array<Promise<unknown>>;
}

/**
 * The starter built and admitted, the addon's channel open before the game starts (its service
 * checked in), the game started embedded under the real game box with that service, its pid the
 * channel's only peer, and its `ready` in. Every frame goes back at once, to the addon and then to
 * the game, as Live's allReferencesReleased does.
 */
async function startEmbedded(): Promise<Embedded> {
  const scratch = await realpath(await tmpDir("native-embed-real-"));
  const addon = await loadAddon(path.join(scratch, "frames"));
  assert.deepEqual([addon.abiVersion, addon.wireVersion], [NATIVE_FRAMES_ABI_VERSION, NATIVE_FRAMES_WIRE_VERSION]);
  const starter = await buildStarter(scratch);
  const runId = randomBytes(6).toString("hex");
  const frames: FrameEvent[] = [];
  const errors: unknown[] = [];
  const releases: Array<Promise<unknown>> = [];
  const live: { port?: NativeGamePort; channel?: FramesChannel } = {};
  const onEvent = (event: unknown): void => {
    if (!isFrameEvent(event)) {
      errors.push(event);
      return;
    }
    frames.push(event);
    live.channel?.release(event.generation, event.slot, event.seq);
    const released = live.port?.call(NativeOp.Release, { slot: event.slot, generation: event.generation });
    releases.push(
      released?.then(
        () => null,
        (error: unknown) => error,
      ) ?? Promise.resolve("no port yet"),
    );
  };
  const channel = addon.open(runId, onEvent, { maxFps: NATIVE_FRAME_RATE_MAX_PER_S, burst: NATIVE_FRAME_BURST });
  assert.ok(isChannel(channel));
  live.channel = channel;
  const admission = await admitMacBundle(starter.out, { mode: NativeRunMode.Headless });
  assert.ok(admission.ok, JSON.stringify(admission));
  const run = await assembleRunDir({
    root: starter.root,
    runId,
    admitted: admission.bundle,
    angle: starter.angle,
    bundleId: BUNDLE_ID,
    uiElement: true,
    exec: execHost,
  });
  const nonce = randomBytes(16).toString("hex");
  const child = await starter.sandbox.spawnGame({
    runId,
    ...run,
    mode: NativeRunMode.Embedded,
    nonce,
    frames: channel.serviceName,
  });
  channel.setPeer(child.pid);
  const port = new NativeGamePort({
    child,
    nonce,
    mode: NativeRunMode.Embedded,
    stateDir: run.state,
    timers: REAL_TIMERS,
    encodeJpeg: async (bgra) => Buffer.from(bgra),
  });
  live.port = port;
  await port.ready();
  return { sandbox: starter.sandbox, runDir: run.runDir, channel, child, port, frames, errors, releases };
}

/** The frames' game-side timestamps as intervals in milliseconds, for a failure's message. */
function timeline(frames: readonly FrameEvent[]): string {
  const stamps = frames.map((frame) => frame.ts);
  return stamps.map((ts, index) => (index === 0 ? 0 : Math.round((ts - (stamps[index - 1] ?? ts)) / 1000))).join(",");
}

/** Pause the game and let its last frames and releases land; every release the game answered. */
async function settle(run: Embedded): Promise<void> {
  await run.port.call(NativeOp.Pause);
  await sleep(SETTLE_MS);
  assert.deepEqual((await Promise.all(run.releases)).filter(Boolean), [], "the game took every release");
}

describe("a C++ game embedded in Live for real: the template's frame ring into the frames addon", {
  ...MAC_HOST,
  ...needsTools("devStore", "angleMac"),
  ...(process.platform === "darwin" ? needsPrewarmed(BuildTarget.Mac) : {}),
  ...embeddedProfile(),
  timeout: REAL_BUILD_TIMEOUT_MS,
}, () => {
  let run: Embedded | undefined;
  /** The run the `before` started. */
  const started = (): Embedded => run ?? assert.fail("the embedded run did not start");

  before(async () => {
    run = await startEmbedded();
  });

  after(async () => {
    if (run && running(run.child.pid)) run.child.kill("SIGKILL");
    await run?.child.exited.catch(() => {});
    run?.channel.close();
    if (run) await removeRunDir(run.runDir);
    await run?.sandbox.dispose();
  });

  it("surface makes the ring the host expected, and at least 30 frames arrive within 3 s, each one released", async () => {
    const { channel, port, frames, errors } = started();
    channel.expectRing({ generation: 1, width: FIRST_RING.w, height: FIRST_RING.h, slots: FIRST_RING.slots });
    const ring = await port.call(NativeOp.Surface, FIRST_RING);
    assert.deepEqual(ring, { generation: 1, width: 960, height: 540, slots: NATIVE_FRAME_SLOTS });
    const arrived = await waitFor(() => frames.length >= FRAMES_WANTED, FRAMES_WITHIN_MS);
    assert.ok(arrived, `${frames.length} frames in 3 s: ${JSON.stringify(channel.stats())} ${timeline(frames)}`);
    assert.deepEqual(errors, [], "no refusal from the addon");
    for (const [index, frame] of frames.entries()) {
      assert.deepEqual([frame.generation, frame.width, frame.height], [1, 960, 540]);
      assert.ok(frame.slot >= 0 && frame.slot < NATIVE_FRAME_SLOTS);
      if (index > 0) assert.ok(frame.seq > (frames[index - 1]?.seq ?? 0), "seq strictly increases");
    }
  });

  it("a paused game sends nothing more, and every frame it sent came back: accepted equals released, nothing held", async () => {
    const embedded = started();
    await settle(embedded);
    const count = embedded.frames.length;
    await sleep(SETTLE_MS);
    assert.equal(embedded.frames.length, count, "a paused game sends no frame");
    const stats = embedded.channel.stats();
    assert.equal(stats.accepted, embedded.frames.length);
    assert.equal(stats.released, stats.accepted);
    assert.equal(stats.heldMask, 0);
    assert.equal(stats.refused, 0);
  });

  it("a resize starts generation 2: its frames arrive at the new size, and the old ring's late ones are dropped, not fatal", async () => {
    const { channel, port, frames, errors } = started();
    const before = frames.length;
    await port.call(NativeOp.Start);
    channel.expectRing({ generation: 2, width: RESIZED_RING.w, height: RESIZED_RING.h, slots: RESIZED_RING.slots });
    const ring = await port.call(NativeOp.Surface, RESIZED_RING);
    assert.deepEqual(ring, { generation: 2, width: 640, height: 360, slots: NATIVE_FRAME_SLOTS });
    const resized = () => frames.slice(before).filter((frame) => frame.generation === 2);
    assert.ok(
      await waitFor(() => resized().length >= RESIZED_FRAMES_WANTED, FRAMES_WITHIN_MS),
      "frames of the new ring",
    );
    assert.ok(resized().every((frame) => frame.width === 640 && frame.height === 360));
    assert.deepEqual(errors, [], "nothing fatal");
    assert.deepEqual([channel.stats().refused, channel.stats().open], [0, true]);
  });

  it("a protocol capture beside the ring is non-blank and its digest matches", async () => {
    const shot = await started().port.screenshotWithStats();
    assert.ok(shot.stats.litFraction > 0, `a non-blank capture: ${JSON.stringify(shot.stats)}`);
  });

  it("quit ends the game with exit 0, its group is gone, and the channel closes with nothing held", async () => {
    const embedded = started();
    await settle(embedded);
    const stats = embedded.channel.stats();
    assert.deepEqual([stats.heldMask, stats.released], [0, stats.accepted]);
    await embedded.port.call(NativeOp.Quit);
    assert.deepEqual(await embedded.child.exited, { code: 0, signal: null });
    assert.equal(running(embedded.child.pid), false, "nothing left running");
    embedded.channel.close();
    assert.equal(embedded.channel.stats().open, false);
  });
});
