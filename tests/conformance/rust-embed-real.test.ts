/**
 * The Rust pond embedded in Live for real (darwin, Apple silicon): its dev flavour, built through
 * the cargo env helper, prepared by the real `prepareNativeRun` over the pond's injected deps
 * (`helpers/rust-pond-binary.ts`), embedded by the real registry (`NativeRuns.embed`) under the
 * M1.13 embedded game profile, its frames taken by the real frames host (`createNativeFrames`)
 * over the unchanged receive-only addon (`native/genex-frames/build.sh`). Electron's
 * `sharedTexture` is stood in by one that draws each import at once and gives it back. Rows: the
 * first ring at Live's size with every frame released, a capture beside the ring, a resize's new
 * generation, hidden Live resting the frames, a second embed replacing the first, and unembedding
 * (Stop) reaping the game within `NATIVE_STOP_BUDGET_MS` and closing its channel with nothing held.
 *
 * The pond's dev flavour embeds through the facade: `genex::install` serves `surface` and
 * `release` and sends each frame through a `genex_frames::FrameSender` on the run's
 * `GENEX_FRAMES_SERVICE` (M2.4).
 *
 * Needs Apple clang, `node_api.h` and the spike toolchain; `GENEX_REQUIRE_METAL=1` turns their
 * absence into a failure.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import { NativeRuns, type NativeSurfaceSize } from "../../src/main/core/native-runs.ts";
import { createNativeFrames, type NativeFramesHost } from "../../src/main/native-frames.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NATIVE_RESIZE_DEBOUNCE_MS,
  NATIVE_STOP_BUDGET_MS,
  type NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { POND_PROJECT, buildPond, needsPond, pondGame, pondPrepareDeps } from "../helpers/rust-pond-binary.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { metalRequired } from "../helpers/gpu-games.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ADDON_BUILD = path.join(REPO, "native", "genex-frames", "build.sh");
const NODE_API_INCLUDE = path.join(path.dirname(path.dirname(process.execPath)), "include", "node");
const REQUIRED = metalRequired();
/** The Electron the frames host has been tested with. */
const ELECTRON_MAJOR = 43;
/** A cold pond build plus the addon's build and every row. */
const SUITE_TIMEOUT_MS = 20 * MINUTE_MS;
const ADDON_BUILD_TIMEOUT_MS = 5 * MINUTE_MS;
/** Live's canvas first (the pond's world at one device pixel per CSS pixel), then after a resize. */
const FIRST_SURFACE: NativeSurfaceSize = { width: 960, height: 540, dpr: 1 };
const RESIZED_SURFACE: NativeSurfaceSize = { width: 640, height: 360, dpr: 1 };
/** Frames a running pond must deliver, and how long it has. */
const FRAMES_WANTED = 30;
const FRAMES_WITHIN_MS = 3 * SECOND_MS;
const RESIZED_FRAMES_WANTED = 10;
/** How long a hidden or stopping run is given for its last frame and releases to land. */
const SETTLE_MS = 300;
const POLL_MS = 20;

/** What the addon's build needs and this Mac lacks, or null. */
function addonToolAbsent(): string | null {
  const clang = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" });
  if (clang.status !== 0) return "Apple clang (xcrun)";
  return existsSync(path.join(NODE_API_INCLUDE, "node_api.h")) ? null : `node_api.h in ${NODE_API_INCLUDE}`;
}

/** `{}` when the addon can be built here (Apple clang, `node_api.h`); a skip, or a throw when required. */
function needsAddonTools(): { skip?: string } {
  if (process.platform !== "darwin") return {};
  const absent = addonToolAbsent();
  if (!absent) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_METAL=1: ${absent} absent`);
  return { skip: `not run: ${absent} absent` };
}

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** One import the stand-in `sharedTexture` drew: the frame's coded size. */
interface Drawn {
  width: number;
  height: number;
}

/** Electron's `sharedTexture`, stood in: each import is drawn at once and given back. */
function drawingTexture(drawn: Drawn[]) {
  return {
    importSharedTexture(options: {
      textureInfo: { codedSize: { width: number; height: number }; handle: { ioSurface: Buffer } };
      allReferencesReleased: () => void;
    }) {
      assert.equal(options.textureInfo.handle.ioSurface.length, 8, "an IOSurfaceRef");
      drawn.push({ ...options.textureInfo.codedSize });
      return { release: () => void setImmediate(options.allReferencesReleased) };
    },
    sendSharedTexture: async () => {},
  };
}

/** Builds the addon with its own script into `<resources>/native/`, where the frames host loads it. */
async function addonResources(scratch: string): Promise<string> {
  const build = path.join(scratch, "addon");
  await execFileAsync("/bin/bash", [ADDON_BUILD], {
    env: { ...process.env, OUT: build, NODE_API_INCLUDE },
    timeout: ADDON_BUILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const resources = path.join(scratch, "resources");
  await mkdir(path.join(resources, "native"), { recursive: true });
  await copyFile(path.join(build, "genex-frames.node"), path.join(resources, "native", "genex-frames.node"));
  return resources;
}

/** The pond's Live rig: the real game box, the real frames host and a registry over both. */
interface LiveRig {
  sandbox: ProcessSandbox;
  root: string;
  frames: NativeFramesHost;
  runs: NativeRuns;
  statuses: NativeRunStatus[];
  drawn: Drawn[];
  killed: Array<[string, NativeRefusal]>;
}

async function liveRig(): Promise<LiveRig> {
  const scratch = await realpath(await tmpDir("rust-embed-real-"));
  const root = path.join(scratch, "native-runs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const resources = await addonResources(scratch);
  const out = await buildPond(path.join(scratch, "builds", "out"));
  const sandbox = await ProcessSandbox.create({
    writableRoots: [],
    scratchDir: path.join(scratch, "scratch"),
    secretPaths: [],
    enabled: false,
    nativeRunsRoot: root,
  });
  const { deps } = pondPrepareDeps({
    root,
    out,
    game: pondGame(path.join(scratch, "games", POND_PROJECT)),
    gameBox: () => sandbox.gameBoxAvailable(),
  });
  const drawn: Drawn[] = [];
  const killed: Array<[string, NativeRefusal]> = [];
  const statuses: NativeRunStatus[] = [];
  const holder: { runs: NativeRuns | null } = { runs: null };
  const frames = createNativeFrames({
    resources,
    electronMajor: ELECTRON_MAJOR,
    sharedTexture: drawingTexture(drawn),
    target: () => ({ frame: "the studio" }),
    timers: REAL_TIMERS,
    kill: (runId, refusal) => {
      killed.push([runId, refusal]);
      holder.runs?.kill(runId, refusal);
    },
    log: () => {},
  });
  assert.equal(frames.available(), null, "the real addon passes the frames host's checks");
  const runs = new NativeRuns({
    root,
    prepare: (request, signal) => prepareNativeRun(deps, request, signal),
    spawn: (request) => sandbox.spawnGame(request),
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
    },
    timers: REAL_TIMERS,
    frames,
  });
  holder.runs = runs;
  return { sandbox, root, frames, runs, statuses, drawn, killed };
}

/** Wait until `done()` holds or `ms` pass; whether it held. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(POLL_MS);
  return done();
}

/** The pond's embedded run, as Live shows it. */
const EMBED = { project: POND_PROJECT, target: BuildTarget.Mac, surface: FIRST_SURFACE } as const;

describe("the Rust pond embedded in Live: its frames through the unchanged addon", {
  ...needsPond(),
  ...needsAddonTools(),
  timeout: SUITE_TIMEOUT_MS,
}, () => {
  let rig: LiveRig | undefined;
  let embedded: NativeRunStatus | undefined;
  const live = (): LiveRig => rig ?? assert.fail("the Live rig did not start");
  const run = (): NativeRunStatus => embedded ?? assert.fail("the pond was not embedded");
  const accepted = (runId: string) => live().frames.stats(runId)?.accepted ?? 0;

  before(async () => {
    rig = await liveRig();
  });

  after(async () => {
    await rig?.runs.stopAll();
    await rig?.sandbox.dispose();
  });

  it("embed: the pond is ready inside Live, the ring is Live's size, and 30 frames arrive within 3 s, each one released", async () => {
    const { runs, frames, drawn, killed } = live();
    embedded = await runs.embed(EMBED);
    assert.equal(embedded.state, NativeRunState.Ready, JSON.stringify(embedded));
    const { runId } = embedded;
    const arrived = await waitFor(() => accepted(runId) >= FRAMES_WANTED, FRAMES_WITHIN_MS);
    assert.ok(arrived, `${accepted(runId)} frames in 3 s: ${JSON.stringify(frames.stats(runId))}`);
    assert.ok(
      drawn.every((frame) => frame.width === FIRST_SURFACE.width && frame.height === FIRST_SURFACE.height),
      "every frame at Live's size",
    );
    assert.deepEqual(killed, [], "the frames host ended nothing");
  });

  it("a protocol capture beside the ring is non-blank", async () => {
    const port = live().runs.portOf(POND_PROJECT, NativeRunMode.Embedded);
    assert.ok(port, "the embedded run's port");
    const shot = await port.screenshotWithStats();
    assert.ok(shot.stats.litFraction > 0, `a non-blank capture: ${JSON.stringify(shot.stats)}`);
  });

  it.todo(
    "Live's frame is pixel-correct: the canvas digest equals the capture's (needs the renderer's readback of the shared texture: an Electron row through dev-control, not this Node process)",
  );

  it("a resize starts a new generation: its frames arrive at the new size, nothing refused", async () => {
    const { runs, frames, drawn } = live();
    const { runId } = run();
    const before = drawn.length;
    assert.equal(runs.resize(POND_PROJECT, RESIZED_SURFACE), true);
    await sleep(NATIVE_RESIZE_DEBOUNCE_MS);
    const resized = () =>
      drawn
        .slice(before)
        .filter((frame) => frame.width === RESIZED_SURFACE.width && frame.height === RESIZED_SURFACE.height);
    assert.ok(
      await waitFor(() => resized().length >= RESIZED_FRAMES_WANTED, FRAMES_WITHIN_MS),
      "frames of the new ring",
    );
    assert.equal(frames.stats(runId)?.refused, 0);
  });

  it("hidden Live rests the pond: no frame arrives until it is shown again", async () => {
    const { runs } = live();
    const { runId } = run();
    runs.showEmbedded(POND_PROJECT, false);
    await sleep(SETTLE_MS);
    const resting = accepted(runId);
    await sleep(SETTLE_MS);
    assert.equal(accepted(runId), resting, "a hidden run sends no frame");
    runs.showEmbedded(POND_PROJECT, true);
    assert.ok(await waitFor(() => accepted(runId) > resting, FRAMES_WITHIN_MS), "frames again once shown");
  });

  it("a second embed replaces the first: the old run is stopped, the new one is ready with frames", async () => {
    const { runs, statuses } = live();
    const first = run();
    embedded = await runs.embed(EMBED);
    assert.notEqual(embedded.runId, first.runId);
    assert.equal(embedded.state, NativeRunState.Ready);
    const { runId } = embedded;
    assert.ok(await waitFor(() => accepted(runId) >= FRAMES_WANTED, FRAMES_WITHIN_MS), "the new run's frames");
    const ended = statuses.filter((status) => status.runId === first.runId).at(-1);
    assert.equal(ended?.state, NativeRunState.Stopped);
    assert.equal(first.pid !== null && running(first.pid), false, "the old run is gone");
  });

  it("unembed: every frame came back, then Stop reaps the pond within the budget and closes its channel", async () => {
    const { runs, frames, statuses, root } = live();
    const { runId, pid } = run();
    assert.ok(pid);
    runs.showEmbedded(POND_PROJECT, false);
    await sleep(SETTLE_MS);
    const stats = frames.stats(runId);
    assert.deepEqual(
      [stats?.heldMask, stats?.released, stats?.refused],
      [0, stats?.accepted, 0],
      JSON.stringify(stats),
    );
    const from = Date.now();
    await runs.stopMode(NativeRunMode.Embedded);
    const took = Date.now() - from;
    assert.ok(took < NATIVE_STOP_BUDGET_MS, `reaped ${took} ms after Stop (budget ${NATIVE_STOP_BUDGET_MS} ms)`);
    assert.equal(statuses.filter((status) => status.runId === runId).at(-1)?.state, NativeRunState.Stopped);
    assert.equal(running(pid), false, "nothing left running");
    assert.equal(frames.stats(runId), null, "the channel is closed");
    assert.deepEqual(await readdir(root), [], "every run dir is gone");
  });
});
