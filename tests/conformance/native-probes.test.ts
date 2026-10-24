/**
 * The host's typed probes (M3b): `preview.witness`, `preview.emptyScene` and `preview.cameraPose`
 * read a game through its studio contract (`state()` and `step`) and never evaluate JavaScript, so
 * a native run answers them; a page that cannot step is refused `unsupported`, which the gate reads
 * as unmeasured. They are routed by handle like every other preview method: an unknown or foreign
 * handle is refused before any port is touched. `native.build` answers the host's own admission
 * facts for a Mac build, read-only: nothing is assembled, signed or started.
 *
 * The darwin row builds the starter through the real Mac lane and asks the probes of a real
 * headless run (required when the dev store and the owned ANGLE are present).
 */
import assert from "node:assert/strict";
import { cp, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import {
  MAC_ANGLE_IMPORTS,
  MAC_GAME_RPATH,
  NATIVE_MAC_EXECUTABLES,
  NativeRefusal,
  NativeRunMode,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import { NativeRuns } from "../../src/main/core/native-runs.ts";
import { execHost } from "../../src/main/core/toolchains.ts";
import { CppBuilds } from "../../src/main/cpp-build.ts";
import { admissionFacts } from "../../src/main/harness-rpc/native.ts";
import { cameraPoseOf, emptySceneOf, WITNESS_DEFAULT_MS, witnessOf } from "../../src/main/harness-rpc/preview.ts";
import { NativeGamePort, NativeLeasePort } from "../../src/substrate/native-game-port.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { currentLock, locateToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { DEV_TOOLCHAINS, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import { gameCommands, LoadCommand, machO } from "../helpers/macho.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { raylibLanes } from "../helpers/game-lanes.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";
import { M2, macBinary } from "../fixtures/rust-bundles/binaries.ts";

const OPENGL = "/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL";
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-W3-GATE");
const REAL_BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
/** The starter's destinations: Browser and Mac. */
const DESTINATIONS = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] };

/** A port that plays a stepped game: `step` answers the C++ runtime's shape. */
function steppedPort(state: Record<string, unknown> = {}) {
  let frame = 0;
  const calls: Array<{ method: string; arg: unknown }> = [];
  const port: Pick<PreviewPort, "studioState" | "studioCall"> = {
    studioState: async () => ({ frame, simulatedMs: frame * 16, ...state }),
    studioCall: async (method: string, arg?: unknown) => {
      calls.push({ method, arg });
      if (method !== "step") return { __missing: true };
      const ticks = Math.max(1, Math.round(Number(arg) / 16.67));
      frame += ticks;
      return { frame, simulatedMs: frame * 16, steppedFrames: ticks, drawCalls: 7 };
    },
  };
  return { port, calls };
}

describe("the typed probes over a game's studio contract", () => {
  it("witness steps the game and reads its frame counters, never evaluating JavaScript", async () => {
    const { port, calls } = steppedPort();
    const witness = await witnessOf(port, 320);
    assert.deepEqual(witness, { frameBefore: 0, frameAfter: 19, simulatedMs: 304, drawCalls: 7 });
    assert.deepEqual(calls, [{ method: "step", arg: 320 }]);
    assert.equal(WITNESS_DEFAULT_MS, 320);
    const byDefault = steppedPort();
    await witnessOf(byDefault.port);
    assert.deepEqual(byDefault.calls, [{ method: "step", arg: WITNESS_DEFAULT_MS }]);
  });

  it("a page whose step answers no frame counter is refused unsupported, the gate's unmeasured", async () => {
    // The Three.js template's step answers what the shim counted, not the C++ runtime's frame.
    const three: Pick<PreviewPort, "studioState" | "studioCall"> = {
      studioState: async () => ({ score: 1 }),
      studioCall: async () => ({ idle: 0, frames: 3 }),
    };
    const refused = await witnessOf(three, 320).then(
      () => null,
      (error: unknown) => error as { refusal?: string },
    );
    assert.equal(refused?.refusal, NativeRefusal.Unsupported);
    const missing: Pick<PreviewPort, "studioState" | "studioCall"> = {
      studioState: async () => ({ __missing: true }),
      studioCall: async () => ({ __missing: true }),
    };
    const gone = await witnessOf(missing, 320).then(
      () => null,
      (error: unknown) => error as { refusal?: string },
    );
    assert.equal(gone?.refusal, NativeRefusal.Unsupported);
  });

  it("emptyScene is measured exactly when state().phase is a string; cameraPose exactly when state().camera exists", async () => {
    const rows: Array<{ state: Record<string, unknown>; empty: boolean; pose: boolean }> = [
      { state: {}, empty: false, pose: false },
      { state: { phase: "menu" }, empty: true, pose: false },
      { state: { phase: 3 }, empty: false, pose: false },
      { state: { camera: "default" }, empty: false, pose: true },
      { state: { camera: null }, empty: false, pose: true },
      { state: { phase: "playing", camera: "eye:here" }, empty: true, pose: true },
    ];
    for (const { state, empty, pose } of rows) {
      const { port } = steppedPort(state);
      assert.equal((await emptySceneOf(port)).measured, empty, JSON.stringify(state));
      assert.equal((await cameraPoseOf(port)).measured, pose, JSON.stringify(state));
    }
    const { port } = steppedPort({ phase: "playing", camera: "eye:here", __render: { drawCalls: 12 } });
    assert.deepEqual(await emptySceneOf(port), { measured: true, phase: "playing", drawCalls: 12 });
    assert.deepEqual(await cameraPoseOf(port), { measured: true, camera: "eye:here", pose: null });
    const posed = steppedPort({ camera: { name: "top", position: [0, 10, 0] } });
    assert.deepEqual(await cameraPoseOf(posed.port), {
      measured: true,
      camera: "top",
      pose: { name: "top", position: [0, 10, 0] },
    });
  });
});

describe("the typed probes as harness methods", () => {
  let lite: CoreLite;
  const stand = steppedPort({ phase: "menu", camera: "default" });
  before(async () => {
    const fake = (): PreviewPort => ({
      load: async () => "",
      reload: async () => {},
      screenshot: async () => Buffer.alloc(0),
      evaluate: async () => {
        throw new Error("a typed probe evaluates nothing");
      },
      studioState: stand.port.studioState,
      studioCall: stand.port.studioCall,
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
    });
    lite = await coreLite({ preview: fake(), createHeadlessPreview: async () => fake() });
  });

  it("answer through the window a call names, and the stand-in for none", async () => {
    const api = lite.api();
    const witness = await api[HostMethod.PreviewWitness]({ ms: 64 });
    assert.equal(witness.frameAfter - witness.frameBefore, 4);
    // No `__render` in this state: the draws are the last witness step's.
    assert.deepEqual(await api[HostMethod.PreviewEmptyScene]({}), { measured: true, phase: "menu", drawCalls: 7 });
    assert.equal((await api[HostMethod.PreviewCameraPose]({})).camera, "default");
    const { handle } = await api[HostMethod.PreviewAcquire]({ label: "evidence" });
    assert.equal((await api[HostMethod.PreviewEmptyScene]({ handle })).measured, true);
    await api[HostMethod.PreviewRelease]({ handle });
  });

  it("an unknown or foreign handle is refused before any port is touched", async () => {
    const api = lite.api();
    const before = stand.calls.length;
    const { handle } = await api[HostMethod.PreviewAcquire]({ label: "evidence" });
    await api[HostMethod.PreviewRelease]({ handle });
    for (const hostile of ["evil", "../live", handle, "h999999", " "]) {
      await assert.rejects(api[HostMethod.PreviewWitness]({ handle: hostile, ms: 32 }), String(hostile));
      await assert.rejects(api[HostMethod.PreviewEmptyScene]({ handle: hostile }), String(hostile));
      await assert.rejects(api[HostMethod.PreviewCameraPose]({ handle: hostile }), String(hostile));
    }
    assert.equal(stand.calls.length, before, "no game was stepped");
  });
});

describe("native.build's admission facts", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
    await lite.core.games.scaffold("native-pong", {
      title: "Native Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
  });

  /** A Mac build's `out/` holding one synthetic headless executable importing `dylibs`. */
  async function outWith(dylibs: string[]): Promise<string> {
    const out = path.join(await realpath(await tmpDir("native-out-")), "out");
    await mkdir(out, { recursive: true });
    const commands = gameCommands({ dylibs });
    await writeFile(path.join(out, NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless]), machO({ commands }), {
      mode: 0o755,
    });
    return out;
  }

  /** The lane answers `out` for every build; the store's lock and ANGLE are the test's. */
  function laneAnswers(t: TestContext, out: string) {
    const { core } = lite;
    t.mock.method(core.cppBuilds, "ensure", async () => ({ ok: true, output: out, problem: null }));
    t.mock.method(core.toolchains, "currentLock", async () => ({ digest: "5e0433cfc3877af8", components: {} }));
    t.mock.method(core.toolchains, "locate", async () => ({
      ok: true,
      toolchain: {
        angle: { dir: "/angle", egl: "/angle/libEGL.dylib", gles: "/angle/libGLESv2.dylib", manifestSha256: "d1a8" },
      },
    }));
    const started = t.mock.method(core.nativeRuns, "start");
    return () => started.mock.callCount();
  }

  it("a synthetic Mac build importing OpenGL is refused links-opengl, and nothing is assembled, signed or started", async (t) => {
    const out = await outWith([...MAC_ANGLE_IMPORTS, OPENGL]);
    const before = await readdir(out);
    const starts = laneAnswers(t, out);
    const answer = await lite.api()[HostMethod.NativeBuild]({ project: "native-pong", target: BuildTarget.Mac });
    assert.equal(answer.ok, true);
    assert.equal(answer.admission?.refusal, NativeRefusal.LinksOpenGl);
    assert.ok(answer.admission?.imports.includes(OPENGL), "the import that failed it is in the facts");
    assert.equal(answer.admission?.angleManifestSha256, "d1a8");
    assert.deepEqual(await readdir(out), before, "nothing was written beside the build");
    assert.equal(starts(), 0, "no run");
    const runs = await readdir(lite.core.layout.nativeRuns).catch(() => [] as string[]);
    assert.deepEqual(runs, [], "no run directory was assembled");
  });

  it("an admitted build answers its imports and rpaths; the web target answers no facts", async (t) => {
    const out = await outWith([...MAC_ANGLE_IMPORTS, "/usr/lib/libSystem.B.dylib"]);
    laneAnswers(t, out);
    const mac = await lite.api()[HostMethod.NativeBuild]({ project: "native-pong", target: BuildTarget.Mac });
    assert.equal(mac.admission?.refusal, null);
    assert.deepEqual(mac.admission?.rpaths, [MAC_GAME_RPATH]);
    assert.ok(MAC_ANGLE_IMPORTS.every((name) => mac.admission?.imports.includes(name)));
    const web = await lite.api()[HostMethod.NativeBuild]({ project: "native-pong", target: BuildTarget.Web });
    assert.equal(web.admission, null);
  });

  it("a Rust · wgpu Mac build is judged by the Rust policy, never by raylib's ANGLE rule", async () => {
    // A Rust game draws through Metal and links no ANGLE: the harness's native parity, fork and
    // health checks refused every Rust Mac build `missing-angle-import` before this row.
    const out = path.join(await realpath(await tmpDir("native-out-rust-")), "out");
    await mkdir(out, { recursive: true });
    for (const name of Object.values(NATIVE_MAC_EXECUTABLES)) {
      await writeFile(path.join(out, name), macBinary(), { mode: 0o755 });
    }
    const before = await readdir(out);
    const rust = await admissionFacts(out, GameStack.RustWgpu, null);
    assert.equal(rust.refusal, null, `admitted: ${rust.detail}`);
    assert.deepEqual(rust.imports, [...M2.mac.dylibs]);
    assert.equal(rust.angleManifestSha256, null, "a Rust build names no store ANGLE");
    const raylib = await admissionFacts(out, GameStack.RaylibCpp, null);
    assert.equal(raylib.refusal, NativeRefusal.MissingAngleImport, "the same image under raylib's rule");
    const opengl = path.join(await realpath(await tmpDir("native-out-rust-gl-")), "out");
    await mkdir(opengl, { recursive: true });
    const withGl = macBinary({ dylibs: [...M2.mac.dylibs, OPENGL] });
    await writeFile(path.join(opengl, NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless]), withGl, { mode: 0o755 });
    const refused = await admissionFacts(opengl, GameStack.RustWgpu, null);
    assert.equal(refused.refusal, NativeRefusal.LinksOpenGl, "the Rust policy still refuses OpenGL");
    assert.ok(refused.imports.includes(OPENGL), "the import that failed it is in the facts");
    assert.deepEqual(await readdir(out), before, "nothing was written beside the build");
  });

  it("hostile executables answer a refusal with whatever facts could be read, and nothing runs", async () => {
    const rows: Array<{ label: string; bytes: Buffer | null; refusal: string }> = [
      { label: "missing", bytes: null, refusal: NativeRefusal.NotAnExecutable },
      { label: "not Mach-O", bytes: Buffer.from("#!/bin/sh\nexit 0\n"), refusal: NativeRefusal.NotAnExecutable },
      {
        label: "a foreign rpath",
        bytes: machO({ commands: gameCommands({ rpaths: ["/tmp"] }) }),
        refusal: NativeRefusal.ForeignRpath,
      },
      {
        label: "a dyld environment",
        bytes: machO({
          commands: [...gameCommands(), { cmd: LoadCommand.DyldEnvironment, value: "DYLD_LIBRARY_PATH=/tmp" }],
        }),
        refusal: NativeRefusal.ForeignRpath,
      },
    ];
    for (const { label, bytes, refusal } of rows) {
      const out = path.join(await realpath(await tmpDir("native-out-hostile-")), "out");
      await mkdir(out, { recursive: true });
      if (bytes) await writeFile(path.join(out, NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless]), bytes);
      const facts = await admissionFacts(out, GameStack.RaylibCpp, null);
      assert.equal(facts.refusal, refusal, label);
      assert.equal(facts.angleManifestSha256, null, label);
      assert.deepEqual(await readdir(out), bytes ? [NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless]] : [], label);
    }
  });
});

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};
const MAC_HOST =
  process.platform === "darwin" && process.arch === "arm64"
    ? {}
    : { skip: "not run: native runs need an Apple silicon Mac" };

describe("the probes against a real headless run of the starter", {
  ...MAC_HOST,
  ...needsTools("devStore", "angleMac"),
  ...(process.platform === "darwin" ? needsPrewarmed(BuildTarget.Mac) : {}),
  timeout: REAL_BUILD_TIMEOUT_MS,
}, () => {
  let sandbox: ProcessSandbox;
  let runs: NativeRuns;
  let lane: CppBuilds;
  let game: GameProject;
  const evidence: string[] = [];
  before(async () => {
    const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
    const toolchains = await realpath(DEV_TOOLCHAINS);
    const scratch = await realpath(await tmpDir("native-probes-real-"));
    const layout = layoutFor(path.join(scratch, "userData"));
    const dir = path.join(scratch, "games", "pong");
    await cp(TEMPLATE, dir, { recursive: true });
    await mkdir(layout.nativeRuns, { recursive: true, mode: 0o700 });
    sandbox = await ProcessSandbox.create({
      writableRoots: [path.join(scratch, "games")],
      scratchDir: layout.scratch,
      secretPaths: [],
      denyWrite: [...studioBaseDenyWrites(layout, [dir]), store, toolchains],
      nativeRunsRoot: layout.nativeRuns,
    });
    lane = new CppBuilds({
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
    game = {
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
      destinations: DESTINATIONS,
    };
    const deps: NativePrepareDeps = {
      root: layout.nativeRuns,
      host: StudioPlatform.Mac,
      gameBox: () => sandbox.gameBoxAvailable(),
      games: { list: async () => [game], bundleIdFor: async () => "games.genex.game.0123456789ab" },
      gameBuilds: raylibLanes(lane),
      toolchains: {
        currentLock: () => currentLock(store),
        locate: (lock, targets) => locateToolchain(store, lock, targets),
      },
      exec: execHost,
    };
    runs = new NativeRuns({
      root: layout.nativeRuns,
      prepare: (request, signal) => prepareNativeRun(deps, request, signal),
      spawn: (request) => sandbox.spawnGame(request),
      connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
      emit: () => {},
      timers: REAL_TIMERS,
    });
  });
  after(async () => {
    await runs?.stopAll();
    await sandbox?.dispose();
    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(path.join(EVIDENCE, "native-probes-real.txt"), `${evidence.join("\n")}\n`);
  });

  it("the starter's Mac build is admitted by the host's facts, and a real headless lease answers witness, emptyScene and cameraPose", async () => {
    const lease = new NativeLeasePort({
      start: (request) => runs.start(request),
      stop: (runId) => runs.stop(runId),
      target: BuildTarget.Mac,
      owner: "harness:test",
    });
    try {
      await lease.load("pong");
      const lock = await currentLock(path.join(DEV_TOOLCHAINS, "dev-store"));
      const built = await lane.ensure({
        project: "pong",
        dir: game.dir,
        shape: game.shape,
        target: BuildTarget.Mac,
        destinations: DESTINATIONS,
        purpose: CppBuildPurpose.Judging,
        lock,
        recordLock: false,
      });
      assert.ok(built.ok && built.output, JSON.stringify(built.problem));
      const facts = await admissionFacts(built.output, GameStack.RaylibCpp, null);
      evidence.push(`admission ${JSON.stringify(facts)}`);
      assert.equal(facts.refusal, null, JSON.stringify(facts));
      assert.ok(MAC_ANGLE_IMPORTS.every((name) => facts.imports.includes(name)));
      const witness = await witnessOf(lease, 320);
      const empty = await emptySceneOf(lease);
      const pose = await cameraPoseOf(lease);
      evidence.push(
        `witness ${JSON.stringify(witness)}`,
        `emptyScene ${JSON.stringify(empty)}`,
        `cameraPose ${JSON.stringify(pose)}`,
      );
      assert.ok(witness.frameAfter > witness.frameBefore, JSON.stringify(witness));
      assert.ok(witness.simulatedMs > 0);
      // The starter reports its placed camera's name and no phase.
      assert.equal(pose.measured, true, JSON.stringify(pose));
      assert.equal(typeof empty.measured, "boolean");
    } finally {
      await lease.dispose();
    }
  });
});
