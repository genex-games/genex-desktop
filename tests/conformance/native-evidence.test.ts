/**
 * The native parity gate and the judging target (M3b): a C++ · raylib game whose judging target is
 * its Mac build is looked at through native captures, never a page probe; a Browser + Mac game
 * passes the parity gate in the order plan §8.4 names (admission, ready, witness, captures, frame
 * verdicts, seeded replay, fixed-horizon cross-target agreement, frame similarity); what a target
 * cannot measure is `unmeasured` and never a pass; the host's admission fact beats the game's claim.
 *
 * Every row drives the seed's own functions over a recording ctx (`ctxRecorder`) whose handlers play
 * a small deterministic game on each lease: the web lease answers the page's verbs, the native lease
 * answers the native protocol's shapes, and the typed probes are answered by the host's own probe
 * functions over that game's `state()`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askVisionBoard, blindCompare, type VisionAsk } from "../../src/harness-seed/loop/judge.ts";
import { PARITY_CHECK_ID, runDeterministicChecks } from "../../src/harness-seed/loop/checks.ts";
import { acquireWindow, gatherEvidence, withLease } from "../../src/harness-seed/loop/evidence.ts";
import * as frameVerdicts from "../../src/harness-seed/loop/frame-verdicts.ts";
import * as webPass from "../../src/harness-seed/loop/evidence.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import {
  BuildTarget,
  GameStack,
  NativeBackend,
  NativeLifecycle,
  NativeProbe,
  NativeRefusal,
  RAYLIB_NATIVE_UNMEASURED,
  RAYLIB_WEB_UNMEASURED,
  RUST_WEB_UNMEASURED,
  StudioPlatform,
  TargetRefusal,
} from "../../src/harness-seed/loop/native-contract.ts";
import {
  CROSS_TARGET_TICKS,
  compareStates,
  nativeEvidence,
  ParityRow,
  parityFor,
  REQUIRED_PARITY_ROWS,
  runParityGate,
  type TargetParity,
  type ToleranceStore,
  tightenTolerance,
  unrunnableParity,
  weighParity,
  withParity,
  workspaceTolerances,
} from "../../src/harness-seed/loop/native-evidence.ts";
import type { Evidence } from "../../src/harness-seed/loop/evidence.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { PageMethod } from "../../src/harness-seed/loop/page-contract.ts";
import type { Check } from "../../src/harness-seed/loop/spec.ts";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import { cameraPoseOf, emptySceneOf } from "../../src/main/harness-rpc/preview.ts";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { ctxRecorder, type CtxRecorder } from "../helpers/ctx-recorder.ts";

/** A Mac host with a game box, as `preview.capacity` reports it. */
const MAC_HOST = {
  max: 4,
  inUse: 0,
  free: 4,
  live: true,
  headless: true,
  memory: { freeMb: 8000, totalMb: 16000 },
  host: StudioPlatform.Mac,
  native: { gameBox: true, leases: 0, max: 4 },
};
const NATIVE = "n1";
const WEB = "w1";
const SEED = 1234;
const OPENGL = "/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL";

/** Host facts for an admitted Mac build: ANGLE through the one rpath, no OpenGL. */
const ADMITTED = {
  target: BuildTarget.Mac,
  refusal: null,
  detail: null,
  imports: ["@rpath/libEGL.dylib", "@rpath/libGLESv2.dylib", "/usr/lib/libSystem.B.dylib"],
  rpaths: ["@executable_path/../Frameworks"],
  angleManifestSha256: "d1a8c476a1c471404b6b353161033f3a9ef4f53249fa42b2eb9909e84fad22cc",
};

/** Host facts for admitted Windows and Linux builds: ANGLE by its bare name, `$ORIGIN` the one RUNPATH. */
const CROSS_FACTS: Record<string, Record<string, unknown>> = {
  [BuildTarget.Windows]: {
    target: BuildTarget.Windows,
    refusal: null,
    detail: null,
    imports: ["libGLESv2.dll", "libEGL.dll", "KERNEL32.dll", "USER32.dll"],
    rpaths: [],
    angleManifestSha256: "7c9e0ab1".padEnd(64, "0"),
  },
  [BuildTarget.Linux]: {
    target: BuildTarget.Linux,
    refusal: null,
    detail: null,
    imports: ["libGLESv2.so", "libEGL.so", "libm.so.6", "libc.so.6"],
    rpaths: ["$ORIGIN"],
    angleManifestSha256: "41d2e6f0".padEnd(64, "0"),
  },
};

/** What `native.build` answers for a Windows or Linux build the lane made and the host's gate admitted. */
const builtCross = (target: string, admission: Record<string, unknown> | null = CROSS_FACTS[target] ?? null) => ({
  ok: true,
  problem: null,
  lock: "5e0433cfc387",
  output: `/cpp-builds/pong/${target}/out`,
  admission,
});

/** What `native.build` answers for a build that did not finish: the lane's typed problem. */
const failedBuild = (target: string, problem: Record<string, unknown>) => ({
  ok: false,
  problem: {
    project: "pong",
    command: "cmake --build",
    code: 1,
    lines: [],
    needsInstall: false,
    install: null,
    showingLastBuild: false,
    at: "2026-10-02T03:00:00.000Z",
    target,
    ...problem,
  },
  lock: "5e0433cfc387",
  output: null,
  admission: null,
});

type Targets = readonly BuildTarget[];
const raylibGame = (targets: Targets) => ({ destinations: { stack: GameStack.RaylibCpp, targets: [...targets] } });

/** A raylib night's run, as run-dispatch stamps it. */
function raylibRun(overrides: Record<string, unknown> = {}): Run {
  return {
    runId: "run_native",
    goal: "a pong you can play on the Mac",
    project: "pong",
    stack: GameStack.RaylibCpp,
    reference: { name: "pong", shots: [], kind: "direction" },
    budgets: {},
    ...overrides,
  } as unknown as Run;
}

/** What one fake game does differently from a well-behaved one. */
interface GameQuirks {
  /** The litFraction every capture reports (default 0.4). */
  lit?: number;
  /** Every camera photographs the same picture. */
  oneFrame?: boolean;
  /** Every capture throws. */
  blind?: boolean;
  /** Added to `player.x` every tick, per target: a cross-target drift. */
  drift?: Partial<Record<string, number>>;
  /** Added to `player.x` every tick on the second native run only: a replay that is not deterministic. */
  replayDrift?: number;
  /** Extra state keys (`phase`, `camera`, …). */
  extra?: Record<string, unknown>;
  /** State keys reported differently by each target. */
  stateByTarget?: Partial<Record<BuildTarget, Record<string, unknown>>>;
  /** State keys that change only in the second native replay. */
  replayState?: Record<string, unknown>;
  /** The admission facts `native.build` answers. */
  admission?: Record<string, unknown>;
  /** What `native.build` answers for a Windows or Linux destination (default: an admitted build), or throws. */
  cross?: Partial<Record<string, Record<string, unknown> | Error>>;
  /** The backend the native run reports. */
  backend?: string;
  /** The web judging build fails to load. */
  webLoadFails?: boolean;
  /** No native lease is free. */
  noNativeLease?: boolean;
  /** The native run's capture of these cameras throws. */
  failCameras?: string[];
  /** The replay's screenshot answers without pixels. */
  replayUncaptured?: boolean;
  /** The cameras the game names (default: default and top). */
  cameras?: string[];
  /** These cameras photograph the same picture. */
  sameFrame?: string[];
  /** The native run's first capture of these cameras is refused `device-lost` (the device is being re-created). */
  deviceLostOnce?: string[];
  /** The web build cannot run in this preview: every web verb is refused `gpu-unsupported` (no WebGPU). */
  webWithoutWebGpu?: boolean;
}

/** One lease's game: the deterministic simulation the host's handlers step. */
interface FakeGame {
  frame: number;
  x: number;
  seed: number;
  held: Set<string>;
  camera: string;
  runs: number;
}

const TARGET_OF: Record<string, BuildTarget> = { [NATIVE]: BuildTarget.Mac, [WEB]: BuildTarget.Web };

/** A ctx whose host plays one deterministic game per lease. */
function fakeHost(quirks: GameQuirks = {}): CtxRecorder & { games: Map<string, FakeGame> } {
  const games = new Map<string, FakeGame>();
  const game = (handle: unknown): FakeGame => {
    const key = String(handle ?? WEB);
    const found = games.get(key);
    if (found) return found;
    const made = { frame: 0, x: 0, seed: 0, held: new Set<string>(), camera: "default", runs: 1 };
    games.set(key, made);
    return made;
  };
  const stateOf = (handle: unknown) => {
    const g = game(handle);
    return {
      version: 1,
      seed: g.seed,
      frame: g.frame,
      simulatedMs: g.frame * 16,
      running: false,
      fps: handle === NATIVE ? 59.9 + g.runs : 60,
      volatile: { fps: handle === NATIVE ? 59.9 + g.runs : 60 },
      held: [...g.held].sort(),
      player: { x: g.x, lives: 3 },
      score: Math.floor(g.frame / 30),
      __render: { drawCalls: handle === NATIVE ? 4 : 9 },
      ...(quirks.extra ?? {}),
      ...(quirks.stateByTarget?.[TARGET_OF[String(handle)] ?? BuildTarget.Web] ?? {}),
      ...(handle === NATIVE && g.runs > 1 ? (quirks.replayState ?? {}) : {}),
    };
  };
  const tick = (handle: unknown) => {
    const g = game(handle);
    g.frame += 1;
    const target = TARGET_OF[String(handle)] ?? BuildTarget.Web;
    const replay = handle === NATIVE && g.runs > 1 ? (quirks.replayDrift ?? 0) : 0;
    g.x += (g.held.has("KeyD") ? 1.5 : 0) + (quirks.drift?.[target] ?? 0) + replay;
  };
  const pageCall = (p: Record<string, unknown>) => {
    const g = game(p.handle);
    switch (p.method) {
      case PageMethod.Seed:
        Object.assign(g, { frame: 0, x: 0, seed: Number(p.arg), held: new Set<string>() });
        return p.handle === NATIVE ? { seed: g.seed, paused: true } : g.seed;
      case PageMethod.Pause:
      case PageMethod.Start:
        return p.handle === NATIVE ? { running: p.method === PageMethod.Start } : true;
      case PageMethod.Step: {
        const ticks = Math.max(1, Math.round(Number(p.arg ?? 16) / 16.67));
        for (let i = 0; i < ticks; i++) tick(p.handle);
        return { frame: g.frame, simulatedMs: g.frame * 16, steppedFrames: ticks, drawCalls: 4 };
      }
      case PageMethod.DebugCamera:
        g.camera = String(p.arg ?? "default");
        return { ok: true, camera: g.camera };
      case PageMethod.Cameras: {
        const names = quirks.cameras ?? ["default", "top"];
        return p.handle === NATIVE ? { cameras: names } : names;
      }
      case PageMethod.Eyes:
        return p.handle === NATIVE ? { eyes: [] } : [];
      case PageMethod.Demos:
        return p.handle === NATIVE ? { demos: [] } : [];
      case PageMethod.Audio:
        return p.handle === NATIVE ? { rms: 0.2, centroid: 900 } : { __missing: true };
      case "input": {
        const arg = (p.arg ?? {}) as { down?: string[]; up?: string[] };
        for (const key of arg.down ?? []) g.held.add(key);
        for (const key of arg.up ?? []) g.held.delete(key);
        return { held: [...g.held] };
      }
      default:
        return { __missing: true };
    }
  };
  const port = (handle: unknown) => ({
    studioState: async () => stateOf(handle),
    studioCall: async (method: string, arg?: unknown) => pageCall({ method, arg, handle }),
  });
  const recorder = ctxRecorder({
    handlers: {
      [HostMethod.PreviewCapacity]: () => MAC_HOST,
      [HostMethod.PreviewAcquire]: (p) => {
        if (p.target === BuildTarget.Mac && quirks.noNativeLease) throw new Error("no native lease free");
        return { handle: p.target === BuildTarget.Mac ? NATIVE : WEB };
      },
      [HostMethod.PreviewRelease]: () => true,
      [HostMethod.GameList]: () => [{ name: "pong", ...raylibGame([BuildTarget.Web, BuildTarget.Mac]) }],
      [HostMethod.NativeBuild]: (p) => {
        const target = String(p.target);
        const cross = quirks.cross?.[target];
        if (cross instanceof Error) throw cross;
        if (cross) return cross;
        if (target !== BuildTarget.Mac) return builtCross(target);
        return {
          ok: true,
          problem: null,
          lock: "5e0433cfc387",
          output: "/cpp-builds/pong/macos/out",
          admission: quirks.admission ?? ADMITTED,
        };
      },
      [HostMethod.NativeStatus]: () => ({ backend: quirks.backend ?? NativeBackend.MetalAngle, state: "ready" }),
      [HostMethod.PreviewLoad]: (p) => {
        if (p.handle !== NATIVE && quirks.webLoadFails) throw new Error("the web judging build failed");
        game(p.handle);
        return p.handle === NATIVE ? "native://pong/r1" : "http://127.0.0.1/pong/";
      },
      [HostMethod.PreviewReload]: (p) => {
        const g = game(p.handle);
        g.runs += 1;
        return true;
      },
      [HostMethod.PreviewReady]: () => ({
        ready: true,
        ms: 12,
        pageMs: null,
        timedOut: false,
        pageTimedOut: false,
        budgetMs: 20000,
        via: "contract",
        phase: "ready",
        reason: null,
        polls: 1,
        gesture: { needed: false, done: false, reasons: [] },
      }),
      [HostMethod.PreviewStatus]: (p) => ({
        project: "pong",
        url: null,
        crashed: false,
        unresponsive: false,
        loadError: p.handle !== NATIVE && quirks.webLoadFails ? "the web judging build failed" : null,
        consoleErrors: 0,
      }),
      [HostMethod.PreviewCall]: (p) => {
        if (p.handle !== NATIVE && quirks.webWithoutWebGpu)
          throw Object.assign(new Error("this preview offers no WebGPU"), { refusal: NativeRefusal.GpuUnsupported });
        return pageCall(p);
      },
      [HostMethod.PreviewInput]: (p) => {
        const g = game(p.handle);
        for (const action of (p.actions ?? []) as Array<{ type: string; keys?: string[] }>) {
          if (action.type === "down") for (const key of action.keys ?? []) g.held.add(key);
          if (action.type === "up") for (const key of action.keys ?? []) g.held.delete(key);
        }
        return { ok: true, applied: 1, width: 640, height: 360 };
      },
      [HostMethod.PreviewState]: (p) => stateOf(p.handle),
      [HostMethod.PreviewWitness]: (p) => {
        const before = game(p.handle).frame;
        pageCall({ method: PageMethod.Step, arg: p.ms ?? 320, handle: p.handle });
        return { frameBefore: before, frameAfter: game(p.handle).frame, simulatedMs: 320, drawCalls: 4 };
      },
      [HostMethod.PreviewEmptyScene]: (p) => emptySceneOf(port(p.handle)),
      [HostMethod.PreviewCameraPose]: (p) => cameraPoseOf(port(p.handle)),
      [HostMethod.PreviewScreenshot]: (p) => {
        if (quirks.blind) throw new Error("the capture failed");
        const g = game(p.handle);
        if (p.handle === NATIVE && quirks.failCameras?.includes(g.camera)) throw new Error("the capture failed");
        const lost = quirks.deviceLostOnce ?? [];
        if (p.handle === NATIVE && lost.includes(g.camera)) {
          lost.splice(lost.indexOf(g.camera), 1);
          throw Object.assign(new Error("capture: device-lost"), { refusal: NativeRefusal.DeviceLost });
        }
        if (quirks.replayUncaptured && String(p.label).endsWith("/replay"))
          return { base64: null, bytes: 0, path: `/runs/run_native/${String(p.label)}.jpg`, stats: null };
        const same = quirks.oneFrame || quirks.sameFrame?.includes(g.camera);
        const picture = same ? "same" : `${g.camera}@${g.frame}:${g.x.toFixed(6)}`;
        return {
          base64: Buffer.from(`${p.handle === NATIVE ? "NATIVE" : "WEB"}:${picture}`).toString("base64"),
          bytes: 100,
          path: `/runs/run_native/${String(p.label)}.jpg`,
          stats: { litFraction: quirks.lit ?? 0.4, meanLuma: 0.3, canvas: true, width: 640, height: 360 },
          surface: "canvas",
        };
      },
      [HostMethod.PreviewEvaluate]: (p) => {
        if (p.handle === NATIVE) throw Object.assign(new Error("evaluate is unsupported"), { refusal: "unsupported" });
        const g = game(p.handle);
        return { steppedFrames: g.frame, drawCalls: g.frame * 4, now: g.frame * 16, canvas: true, simulatedMs: null };
      },
      [HostMethod.PreviewConsole]: () => [],
      [HostMethod.PreviewGpuErrors]: () => [],
      [HostMethod.PreviewPageUi]: () => ({ entries: [], coverage: 0, uiPrimary: false }),
      [HostMethod.PreviewDiff]: () => null,
      [HostMethod.PreviewGesture]: () => ({ knocked: true, trusted: true }),
      [HostMethod.RunArtifact]: () => "/runs/run_native/x",
    },
  });
  return Object.assign(recorder, { games });
}

/** A tolerance store in memory, as the harness workspace keeps one per game. */
function memoryTolerances(start: number | null = null): ToleranceStore & { writes: number[] } {
  let value = start;
  const writes: number[] = [];
  return {
    writes,
    read: async () => value,
    write: async (_project: string, tolerance: number) => {
      writes.push(tolerance);
      value = tolerance;
    },
  };
}

const ctxOf = (recorder: CtxRecorder) => recorder.ctx as unknown as HarnessCtx;
/** The native pass with the parts evidence.ts hands it. */
const nativePass = (ctx: HarnessCtx, options: Parameters<typeof nativeEvidence>[1]) =>
  nativeEvidence(ctx, options, { applySetup: webPass.applySetup, consoleProblems: webPass.consoleProblems });
const rowOf = <R extends { row: string }>(rows: readonly R[], row: string): R | undefined =>
  rows.find((entry) => entry.row === row);

/** The Browser + Mac gate on a fake host, with the web lease already holding the web build. */
async function gate(recorder: CtxRecorder, tolerances = memoryTolerances()) {
  return runParityGate(ctxOf(recorder), {
    run: raylibRun(),
    target: BuildTarget.Mac,
    webHandle: WEB,
    seed: SEED,
    cameras: ["default", "top"],
    tolerances,
    retriesMs: [],
  });
}

describe("the native parity gate (plan §8.4)", () => {
  it("the gate's call sequence matches plan §8.4 in order", async () => {
    const recorder = fakeHost();
    const verdict = await gate(recorder);
    assert.equal(verdict.pass, true, JSON.stringify(verdict.rows));
    const order = recorder.calls.map((call) => call.method);
    const first = (method: string, from = 0) => order.indexOf(method, from);
    const built = first(HostMethod.NativeBuild);
    const acquired = first(HostMethod.PreviewAcquire);
    const ready = first(HostMethod.PreviewReady);
    const witness = first(HostMethod.PreviewWitness);
    const shot = first(HostMethod.PreviewScreenshot);
    const reload = first(HostMethod.PreviewReload);
    const webSeed = recorder.calls.findIndex(
      (call) =>
        call.method === HostMethod.PreviewCall && call.params.method === PageMethod.Seed && call.params.handle === WEB,
    );
    const released = first(HostMethod.PreviewRelease);
    const milestones = [built, acquired, ready, witness, shot, reload, webSeed, released];
    assert.ok(
      milestones.every((at, index) => at >= 0 && at > (milestones[index - 1] ?? -1)),
      `native.build → acquire → ready → witness → captures → replay → cross-target → release: ${JSON.stringify(milestones)}`,
    );
    assert.deepEqual(recorder.paramsOf(HostMethod.NativeBuild)[0], { project: "pong", target: BuildTarget.Mac });
    assert.deepEqual(recorder.paramsOf(HostMethod.PreviewAcquire)[0]?.target, BuildTarget.Mac);
    assert.deepEqual(
      verdict.rows.map((row) => row.row),
      Object.values(ParityRow),
      "every row, in the plan's order",
    );
    assert.deepEqual(
      recorder.paramsOf(HostMethod.PreviewRelease),
      [{ handle: NATIVE }],
      "the native lease is given back",
    );
    assert.equal(recorder.paramsOf(HostMethod.PreviewEvaluate).length, 0, "no JavaScript reaches a native run");
  });

  it("a duplicate camera's warning names the file the game's cameras are wired in", async () => {
    const twins = await nativePass(
      ctxOf(fakeHost({ cameras: ["default", "top", "side"], sameFrame: ["top", "side"] })),
      {
        run: raylibRun(),
        handle: NATIVE,
        seed: SEED,
      },
    );
    const warned = twins.warnings.find((warning) => /camera returned the same frame as another/.test(warning));
    assert.match(warned ?? "", /fix the camera wiring in src\/main\.cpp$/, JSON.stringify(twins.warnings));
    const look = {
      shots: [
        { camera: "a", base64: "x" },
        { camera: "b", base64: "x" },
        { camera: "c", base64: "y" },
      ],
      problems: [],
      warnings: [] as string[],
      emptyScene: false,
      declaredViewpoints: ["a", "b", "c"],
    };
    frameVerdicts.weighDuplicates(look);
    assert.deepEqual(look.warnings, [
      "the b camera returned the same frame as another camera — each named camera must frame a distinct view; fix the camera wiring in main.js",
    ]);
  });

  it("frame verdicts run on native shots with the same functions", async () => {
    const black = await nativePass(ctxOf(fakeHost({ lit: 0 })), { run: raylibRun(), handle: NATIVE, seed: SEED });
    assert.ok(
      black.problems.includes("every camera renders effectively black (<0.5% pixels above luma 8)"),
      JSON.stringify(black.problems),
    );
    assert.ok(black.shots.every((shot) => Buffer.from(String(shot.base64), "base64").toString().startsWith("NATIVE")));
    const same = await nativePass(ctxOf(fakeHost({ oneFrame: true })), {
      run: raylibRun(),
      handle: NATIVE,
      seed: SEED,
    });
    assert.ok(
      same.problems.includes(
        "every camera returned the same frame — debugCamera switches nothing, the cameras contract is dead",
      ),
      JSON.stringify(same.problems),
    );
    // The same functions, not copies: the web pass's home passes on the very bindings.
    assert.equal(webPass.weighDraws, frameVerdicts.weighDraws);
    assert.equal(webPass.weighBlackness, frameVerdicts.weighBlackness);
    assert.equal(webPass.weighDuplicates, frameVerdicts.weighDuplicates);
    assert.equal(webPass.sameFrameEverywhere, frameVerdicts.sameFrameEverywhere);
    const gated = await gate(fakeHost({ lit: 0 }));
    assert.equal(rowOf(gated.rows, ParityRow.FrameVerdicts)?.pass, false);
    assert.equal(gated.pass, false);
  });

  it("frame similarity is unmeasured before PX10, never pass", async () => {
    const verdict = await gate(fakeHost());
    const similarity = rowOf(verdict.rows, ParityRow.FrameSimilarity);
    assert.equal(similarity?.pass, null);
    assert.match(String(similarity?.reason), /PX10/);
    assert.ok(!REQUIRED_PARITY_ROWS.includes(ParityRow.FrameSimilarity), "not required: reported, never counted");
    assert.equal(
      weighParity([{ row: ParityRow.FrameSimilarity, pass: null, reason: "PX10", refusal: null }]).pass,
      null,
    );
  });

  it("unsupported -> unmeasured for every RAYLIB_NATIVE_UNMEASURED and RAYLIB_WEB_UNMEASURED row; emptyScene/cameraPose measured exactly when state().phase/state().camera exist", async () => {
    const plain = await nativePass(ctxOf(fakeHost()), { run: raylibRun(), handle: NATIVE, seed: SEED });
    for (const probe of RAYLIB_NATIVE_UNMEASURED) assert.equal(typeof plain.unmeasured?.[probe], "string", probe);
    assert.equal(plain.gpuErrors.length, 0);
    assert.equal(plain.pageUi, null);
    assert.equal(typeof plain.unmeasured?.emptyScene, "string", "no state().phase: unmeasured");
    assert.equal(typeof plain.unmeasured?.cameraPose, "string", "no state().camera: unmeasured");
    assert.equal(plain.audio?.rms, 0.2, "audioLevel answered: audio measured on a native run");

    const placed = await nativePass(ctxOf(fakeHost({ extra: { phase: "playing", camera: "default" } })), {
      run: raylibRun(),
      handle: NATIVE,
      seed: SEED,
    });
    assert.equal(placed.unmeasured?.emptyScene, undefined, "state().phase: measured");
    assert.equal(placed.unmeasured?.cameraPose, undefined, "state().camera: measured");
    assert.equal(placed.probes?.emptyScene?.phase, "playing");
    assert.equal(placed.probes?.cameraPose?.camera, "default");

    const recorder = fakeHost();
    const handle = await acquireWindow(ctxOf(recorder), "judge", { game: raylibGame([BuildTarget.Web]) });
    assert.equal(handle, WEB);
    const web = await gatherEvidence(ctxOf(recorder), { run: raylibRun(), handle: WEB, seed: SEED, motion: 0 });
    for (const probe of RAYLIB_WEB_UNMEASURED) assert.equal(typeof web.unmeasured?.[probe], "string", probe);
    assert.equal(web.audio, null, "a raylib web build's audio is unmeasured, never read");
    assert.ok(RAYLIB_WEB_UNMEASURED.includes(NativeProbe.Audio));
  });

  it("a run with no screenshots fails, never skips", async () => {
    const blind = await nativePass(ctxOf(fakeHost({ blind: true })), {
      run: raylibRun(),
      handle: NATIVE,
      seed: SEED,
    });
    assert.equal(blind.ok, false);
    assert.equal(blind.shots.length, 0);
    assert.equal(blind.captureFailed, true);
    assert.ok(
      blind.problems.some((problem) => /no camera produced a frame/.test(problem)),
      JSON.stringify(blind.problems),
    );
    const verdict = await gate(fakeHost({ blind: true }));
    assert.equal(rowOf(verdict.rows, ParityRow.Captures)?.pass, false);
    assert.equal(verdict.pass, false, "a gate without a frame fails");
  });

  it("Windows/Linux targets on a Mac report not-runnable-here, never pass", async () => {
    for (const target of [BuildTarget.Windows, BuildTarget.Linux]) {
      const parity = unrunnableParity(target);
      assert.equal(parity.pass, null, target);
      for (const row of parity.rows) {
        assert.equal(row.pass, null, `${target} ${row.row}`);
        assert.equal(row.refusal, TargetRefusal.NotRunnableHere);
      }
    }
    const recorder = fakeHost();
    const verdict = await parityFor(ctxOf(recorder), {
      run: raylibRun(),
      destinations: raylibGame([BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux]).destinations,
      capacity: MAC_HOST,
      webHandle: WEB,
      seed: SEED,
      cameras: ["default"],
      judged: true,
    });
    assert.equal(verdict?.pass, null, "never pass");
    assert.deepEqual(
      verdict?.targets.map((entry) => entry.target),
      [BuildTarget.Windows, BuildTarget.Linux],
    );
    // FLIPPED in wave 6 (§3.9 U6): each is built and admitted, never run (was: nothing built).
    assert.deepEqual(
      recorder.paramsOf(HostMethod.NativeBuild).map((params) => params.target),
      [BuildTarget.Windows, BuildTarget.Linux],
      "each is built, never run",
    );
    assert.equal(recorder.paramsOf(HostMethod.PreviewAcquire).length, 0, "nothing is run here");
  });

  it("a destination this host does not run is never said to be built: each refusal says why in its own words", async () => {
    const recorder = fakeHost();
    const noBox = { ...MAC_HOST, native: { gameBox: false, leases: 0, max: 4 } };
    const look = {
      run: raylibRun(),
      destinations: raylibGame([BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows]).destinations,
      capacity: noBox,
      webHandle: WEB,
      seed: SEED,
      cameras: ["default"],
      judged: true,
    };
    const onMac = await parityFor(ctxOf(recorder), look);
    const linux = await parityFor(ctxOf(recorder), { ...look, capacity: { ...MAC_HOST, host: StudioPlatform.Linux } });
    // FLIPPED in wave 6 (§3.9 U6): Windows is now built on both hosts, and only then said to be
    // built (was: nothing built, "not built or run on this host: windows runs only on its own OS").
    assert.deepEqual(
      recorder.paramsOf(HostMethod.NativeBuild).map((params) => params.target),
      [BuildTarget.Windows, BuildTarget.Windows],
      "only the destination built here was built",
    );
    const reasons = (verdict: typeof onMac, row: string) =>
      Object.fromEntries((verdict?.targets ?? []).map((entry) => [entry.target, rowOf(entry.rows, row)?.reason ?? ""]));
    const unbuilt = {
      mac: reasons(onMac, ParityRow.Ready)[BuildTarget.Mac],
      linuxMac: reasons(linux, ParityRow.Ready)[BuildTarget.Mac],
    };
    for (const [label, said] of Object.entries(unbuilt)) assert.doesNotMatch(said ?? "", /\bbuilt\b/, label);
    assert.match(reasons(onMac, ParityRow.Admission)[BuildTarget.Mac] ?? "", /no game box for macos/);
    assert.match(reasons(linux, ParityRow.Admission)[BuildTarget.Mac] ?? "", /Mac builds need a Mac/);
    assert.equal(reasons(onMac, ParityRow.Ready)[BuildTarget.Windows], "built, not run on this Mac");
    assert.equal(reasons(linux, ParityRow.Ready)[BuildTarget.Windows], "built, not run on this Linux PC");
  });

  it("a capture that throws fails the captures row by camera; a camera the game lacks is skipped", async () => {
    const verdict = await gate(fakeHost({ failCameras: ["top"] }));
    const captures = rowOf(verdict.rows, ParityRow.Captures);
    assert.equal(captures?.pass, false, JSON.stringify(captures));
    assert.match(captures?.reason ?? "", /top/);
    assert.equal(verdict.pass, false);
  });

  it("a replay whose frames were not captured compares no pixels and never passes", async () => {
    const verdict = await gate(fakeHost({ replayUncaptured: true }));
    const replay = rowOf(verdict.rows, ParityRow.Replay);
    assert.equal(replay?.pass, null, JSON.stringify(replay));
    assert.match(replay?.reason ?? "", /not captured/);
    assert.notEqual(verdict.pass, true);
  });

  it("a native lease that cannot be had leaves every run row unmeasured, never a pass", async () => {
    const verdict = await gate(fakeHost({ noNativeLease: true }));
    assert.equal(verdict.pass, null);
    assert.equal(rowOf(verdict.rows, ParityRow.Admission)?.pass, true, "the host's facts were read");
    assert.equal(rowOf(verdict.rows, ParityRow.Ready)?.pass, null);
  });
});

describe("the cross-target comparator (plan §8.6)", () => {
  const volatile = ["volatile", "fps"];

  it("equal at tolerance passes, tolerance + epsilon fails", () => {
    const tolerance = 1e-3;
    const at = compareStates({ player: { x: 0.5 } }, { player: { x: 0.5 + tolerance } }, { tolerance, volatile });
    assert.equal(at.agree, true, JSON.stringify(at));
    const past = compareStates(
      { player: { x: 0.5 } },
      { player: { x: 0.5 + tolerance + 1e-6 } },
      { tolerance, volatile },
    );
    assert.equal(past.agree, false);
    assert.deepEqual(
      past.disagreements.map((entry) => entry.path),
      ["player.x"],
    );
  });

  it("volatile paths are excluded", () => {
    const compared = compareStates(
      { fps: 60, volatile: { fps: 60, wall: 1 }, score: 1 },
      { fps: 30, volatile: { fps: 30 }, score: 1 },
      { tolerance: 0, volatile },
    );
    assert.equal(compared.agree, true, JSON.stringify(compared));
  });

  it("a path missing on one side disagrees by name", () => {
    const compared = compareStates({ a: 1, b: { c: 2 } }, { a: 1 }, { tolerance: 1, volatile });
    assert.equal(compared.agree, false);
    assert.deepEqual(
      compared.disagreements.map((entry) => entry.path),
      ["b"],
    );
    const other = compareStates({ a: 1 }, { a: 1, d: [1] }, { tolerance: 1, volatile });
    assert.deepEqual(
      other.disagreements.map((entry) => entry.path),
      ["d"],
    );
  });

  it("integer, string, boolean and enum leaves compare exactly", () => {
    const rows: Array<[unknown, unknown]> = [
      [3, 4],
      ["menu", "playing"],
      [true, false],
      [null, 0],
    ];
    for (const [a, b] of rows) {
      const compared = compareStates({ leaf: a }, { leaf: b }, { tolerance: 10, volatile });
      assert.equal(compared.agree, false, JSON.stringify([a, b]));
    }
    assert.equal(compareStates({ leaf: 0.25 }, { leaf: 0.2500001 }, { tolerance: 1e-3, volatile }).agree, true);
  });

  it("exactly 120 step calls with identical input on each target", async () => {
    const recorder = fakeHost();
    await gate(recorder);
    const steps = (handle: string) =>
      recorder.calls.filter(
        (call) =>
          call.method === HostMethod.PreviewCall &&
          call.params.method === PageMethod.Step &&
          call.params.handle === handle,
      );
    // The web lease steps only the cross-target drive; the native lease steps two replay runs.
    assert.equal(steps(WEB).length, CROSS_TARGET_TICKS);
    assert.equal(CROSS_TARGET_TICKS, 120);
    assert.equal(steps(NATIVE).length, 2 * CROSS_TARGET_TICKS);
    const webKeys = recorder.calls
      .filter((call) => call.method === HostMethod.PreviewCall && call.params.method === "input")
      .map((call) => call.params.arg);
    const nativeKeys = recorder
      .paramsOf(HostMethod.PreviewInput)
      .map((params) => params.actions as Array<{ type: string; keys: string[] }>)
      .map((actions) => ({
        down: actions.filter((a) => a.type === "down").flatMap((a) => a.keys),
        up: actions.filter((a) => a.type === "up").flatMap((a) => a.keys),
      }));
    assert.ok(webKeys.length > 0);
    assert.deepEqual(
      nativeKeys,
      [...webKeys, ...webKeys],
      "each native run gets the web drive's input, at the same ticks",
    );
  });

  it("a game whose two targets drift apart fails cross-target agreement by name", async () => {
    const verdict = await gate(fakeHost({ drift: { [BuildTarget.Mac]: 0.01 } }));
    const cross = rowOf(verdict.rows, ParityRow.CrossTarget);
    assert.equal(cross?.pass, false);
    assert.match(String(cross?.reason), /player\.x/);
    assert.equal(rowOf(verdict.rows, ParityRow.Replay)?.pass, true, "each target is still deterministic");
  });

  it("web-only root render counter aliases do not fail cross-target agreement", async () => {
    const verdict = await gate(fakeHost({ stateByTarget: { [BuildTarget.Web]: { drawCalls: 52, triangles: 36194 } } }));
    assert.equal(rowOf(verdict.rows, ParityRow.Replay)?.pass, true);
    assert.equal(rowOf(verdict.rows, ParityRow.CrossTarget)?.pass, true, JSON.stringify(verdict.rows));
    assert.equal(verdict.pass, true);
  });

  it("differing root render counter aliases do not fail cross-target agreement", async () => {
    const verdict = await gate(
      fakeHost({
        stateByTarget: {
          [BuildTarget.Web]: { drawCalls: 52, triangles: 36194 },
          [BuildTarget.Mac]: { drawCalls: 8, triangles: 10420 },
        },
      }),
    );
    assert.equal(rowOf(verdict.rows, ParityRow.Replay)?.pass, true);
    assert.equal(rowOf(verdict.rows, ParityRow.CrossTarget)?.pass, true, JSON.stringify(verdict.rows));
    assert.equal(verdict.pass, true);
  });

  it("ignoring root render counter aliases still rejects gameplay drift", async () => {
    const verdict = await gate(
      fakeHost({
        drift: { [BuildTarget.Mac]: 0.01 },
        stateByTarget: {
          [BuildTarget.Web]: { drawCalls: 52, triangles: 36194 },
          [BuildTarget.Mac]: { drawCalls: 8, triangles: 10420 },
        },
      }),
    );
    const cross = rowOf(verdict.rows, ParityRow.CrossTarget);
    assert.equal(cross?.pass, false);
    assert.match(String(cross?.reason), /player\.x/);
    assert.equal(rowOf(verdict.rows, ParityRow.Replay)?.pass, true);
    assert.equal(verdict.pass, false);
  });

  it("nested probe fields named after render counters still reject cross-target drift", async () => {
    for (const counter of ["drawCalls", "triangles"]) {
      const verdict = await gate(
        fakeHost({
          stateByTarget: {
            [BuildTarget.Web]: { [counter]: 52, probes: { [counter]: 2 } },
            [BuildTarget.Mac]: { [counter]: 8, probes: { [counter]: 3 } },
          },
        }),
      );
      const cross = rowOf(verdict.rows, ParityRow.CrossTarget);
      assert.equal(cross?.pass, false, counter);
      assert.ok(cross?.reason.includes(`probes.${counter}`), JSON.stringify(cross));
      assert.equal(rowOf(verdict.rows, ParityRow.Replay)?.pass, true);
      assert.equal(verdict.pass, false);
    }
  });

  it("root render counter aliases still have to agree within a native replay", async () => {
    for (const counter of ["drawCalls", "triangles"]) {
      const verdict = await gate(
        fakeHost({
          extra: { [counter]: 52 },
          replayState: { [counter]: 53 },
        }),
      );
      const replay = rowOf(verdict.rows, ParityRow.Replay);
      assert.equal(replay?.pass, false, counter);
      assert.ok(replay?.reason.includes(counter), JSON.stringify(replay));
      assert.equal(verdict.pass, false);
    }
  });

  it("a second native run that differs fails the seeded replay", async () => {
    const verdict = await gate(fakeHost({ replayDrift: 0.25 }));
    assert.equal(rowOf(verdict.rows, ParityRow.Replay)?.pass, false);
    assert.equal(verdict.pass, false);
  });

  it("the tolerance is recorded by the first passing run and only ever tightened", async () => {
    assert.equal(tightenTolerance(null, 0), tightenTolerance(null, 0), "deterministic");
    for (const [recorded, observed] of [
      [1e-3, 0],
      [1e-3, 5e-4],
      [1e-3, 1],
      [1e-6, 1e-9],
    ] as const) {
      assert.ok(tightenTolerance(recorded, observed) <= recorded, JSON.stringify([recorded, observed]));
    }
    const store = memoryTolerances();
    await gate(fakeHost({ drift: { [BuildTarget.Mac]: 1e-7 } }), store);
    assert.equal(store.writes.length, 1, "the first passing run records one");
    const [first = Number.NaN] = store.writes;
    await gate(fakeHost({ drift: { [BuildTarget.Mac]: 0.01 } }), store);
    assert.equal(store.writes.length, 1, "a failing run records nothing");
    await gate(fakeHost(), store);
    assert.ok(store.writes.every((written, index) => written <= (store.writes[index - 1] ?? written)));
    assert.ok((store.writes.at(-1) ?? Number.NaN) <= first);
  });
});

describe("the host fact beats the game's claim", () => {
  it("an admission refusal fails the gate before any run, whatever the game would report", async () => {
    const recorder = fakeHost({
      admission: { ...ADMITTED, refusal: NativeRefusal.LinksOpenGl, detail: OPENGL, imports: [OPENGL] },
    });
    const verdict = await gate(recorder);
    const admission = rowOf(verdict.rows, ParityRow.Admission);
    assert.equal(admission?.pass, false);
    assert.equal(admission?.refusal, NativeRefusal.LinksOpenGl);
    assert.equal(verdict.pass, false);
    assert.equal(recorder.paramsOf(HostMethod.PreviewAcquire).length, 0, "no run of a refused bundle");
  });
});

describe("the judging target (D2)", () => {
  it("(a) a Mac-only raylib spec sends vision, play and blind-compare inputs built from native captures, and the recorded judge call receives at least one native image", async () => {
    const recorder = fakeHost();
    recorder.handle(HostMethod.EngineComplete, () => ({
      message: {
        role: "assistant",
        content: '{"facets":{"works":"A","visuals":"A","feel":"A","play":"A"},"defects":[],"reason":"ok","answers":{}}',
      },
    }));
    recorder.handle(HostMethod.EngineDescribe, () => []);
    const run = raylibRun();
    const evidence = await withLease(
      ctxOf(recorder),
      "judge",
      (handle) => gatherEvidence(ctxOf(recorder), { run, handle, seed: SEED, motion: 0 }),
      { game: raylibGame([BuildTarget.Mac]) },
    );
    assert.ok(!("noWindow" in evidence));
    assert.deepEqual(recorder.paramsOf(HostMethod.PreviewAcquire)[0]?.target, BuildTarget.Mac);
    assert.equal(recorder.paramsOf(HostMethod.PreviewEvaluate).length, 0, "no page probe reaches the native run");
    assert.ok(evidence.ok, JSON.stringify(evidence.problems));
    const native = (data: string) => Buffer.from(data, "base64").toString().startsWith("NATIVE");
    assert.ok(evidence.shots.length > 0 && evidence.shots.every((shot) => native(String(shot.base64))));

    const vision = {
      id: "lit",
      kind: "vision",
      weight: "normal",
      camera: "default",
      ask: "is it lit?",
    } as unknown as Check;
    const play = { id: "dash", kind: "play", weight: "normal", ask: "can you dash?" } as unknown as Check;
    const { pending } = await runDeterministicChecks(ctxOf(recorder), {
      spec: { checks: [vision, play] },
      evidence,
      handle: NATIVE,
    });
    assert.deepEqual(
      pending.map((check) => check.kind),
      ["vision", "play"],
      "with frames, vision and play wait for their models",
    );
    const shot = evidence.shots.find((entry) => entry.camera === "default");
    await askVisionBoard(ctxOf(recorder), {
      run,
      asks: [{ check: vision, crop: shot, camera: "default" } as VisionAsk],
    });
    await blindCompare(ctxOf(recorder), {
      run,
      challenger: evidence,
      incumbentEvidence: null,
      random: () => 0,
    });
    const judged = recorder.paramsOf(HostMethod.EngineComplete);
    assert.equal(judged.length, 2, "one vision call and one blind compare");
    for (const call of judged) {
      const images = ((call.messages as Array<{ images?: Array<{ data: string }> }>)[0]?.images ?? []).map(
        (image) => image.data,
      );
      assert.ok(images.some(native), "the judge received a native image");
    }
  });

  it("(b) a Windows/Linux-only game on a Mac builds a judging-only web target and judges it; when that build fails the gate fails with no-judging-target and never passes", async () => {
    for (const target of [BuildTarget.Windows, BuildTarget.Linux]) {
      const recorder = fakeHost();
      const run = raylibRun();
      const evidence = await withLease(
        ctxOf(recorder),
        "judge",
        (handle) => gatherEvidence(ctxOf(recorder), { run, handle, seed: SEED, motion: 0 }),
        { game: raylibGame([target]) },
      );
      assert.ok(!("noWindow" in evidence));
      assert.deepEqual(recorder.paramsOf(HostMethod.PreviewAcquire)[0]?.target, BuildTarget.Web, "judging-only web");
      assert.ok(evidence.shots.length > 0, "judged on real frames");
      assert.equal(evidence.parity?.pass, null, `${target}: never pass`);
      // FLIPPED in wave 6 (§3.9 U6): the admission row is the host's verdict on the build it made
      // (was: rows[0] refused not-runnable-here); every row after it is not run here.
      assert.equal(rowOf(evidence.parity?.targets[0]?.rows ?? [], ParityRow.Admission)?.pass, true);
      assert.equal(
        rowOf(evidence.parity?.targets[0]?.rows ?? [], ParityRow.Ready)?.refusal,
        TargetRefusal.NotRunnableHere,
      );

      const failing = fakeHost({ webLoadFails: true });
      const broken = await withLease(
        ctxOf(failing),
        "judge",
        (handle) => gatherEvidence(ctxOf(failing), { run, handle, seed: SEED, motion: 0 }),
        { game: raylibGame([target]) },
      );
      assert.ok(!("noWindow" in broken));
      assert.equal(broken.parity?.pass, false);
      assert.equal(broken.parity?.refusal, TargetRefusal.NoJudgingTarget);
      assert.equal(broken.ok, false);
      const { results } = await runDeterministicChecks(ctxOf(failing), { spec: { checks: [] }, evidence: broken });
      const row = results.find((entry) => entry.id === "native-parity");
      assert.equal(row?.pass, false, "the gate's row fails the board");
    }
  });

  it("(c) a failed capture turns vision and play into fail, not unmeasured", async () => {
    const recorder = fakeHost({ blind: true });
    const evidence = await nativePass(ctxOf(recorder), { run: raylibRun(), handle: NATIVE, seed: SEED });
    const vision = {
      id: "lit",
      kind: "vision",
      weight: "normal",
      camera: "default",
      ask: "is it lit?",
    } as unknown as Check;
    const play = { id: "dash", kind: "play", weight: "normal", ask: "can you dash?" } as unknown as Check;
    const { results, pending } = await runDeterministicChecks(ctxOf(recorder), {
      spec: { checks: [vision, play] },
      evidence,
      handle: NATIVE,
    });
    assert.deepEqual(pending, [], "no model is asked about frames that do not exist");
    for (const kind of ["vision", "play"]) {
      const entry = results.find((result) => result.kind === kind);
      assert.equal(entry?.pass, false, `${kind} fails`);
      assert.notEqual(entry?.state, "unmeasured");
    }
    const [answer] = await askVisionBoard(ctxOf(recorder), {
      run: raylibRun(),
      asks: [{ check: vision, crop: null, camera: "default" } as VisionAsk],
    });
    assert.equal(answer?.pass, false, "a raylib camera nobody captured fails the question");
  });

  it("a capture refused device-lost once is retried and answered: a shot, and no check fails for it", async () => {
    const recorder = fakeHost({ deviceLostOnce: ["default"] });
    const evidence = await nativePass(ctxOf(recorder), {
      run: raylibRun({ stack: GameStack.RustWgpu }),
      handle: NATIVE,
      seed: SEED,
      deviceLostRetriesMs: [0],
    });
    assert.notEqual(evidence.captureFailed, true, JSON.stringify(evidence.problems));
    assert.ok(
      evidence.shots.some((shot) => shot.camera === "default"),
      "the camera re-captured after the device came back",
    );
    assert.ok(!evidence.problems.some((problem) => /device-lost/.test(problem)), JSON.stringify(evidence.problems));
    const vision = { id: "lit", kind: "vision", weight: "normal", camera: "default", ask: "lit?" } as unknown as Check;
    const { results, pending } = await runDeterministicChecks(ctxOf(recorder), {
      spec: { checks: [vision] },
      evidence,
      handle: NATIVE,
    });
    assert.deepEqual(
      results.filter((entry) => entry.pass === false),
      [],
    );
    assert.deepEqual(
      pending.map((check) => check.id),
      ["lit"],
      "the judge is asked about the frame",
    );
  });

  it("a play script whose touches the preview cannot take says so: those controls went untested", async () => {
    const recorder = fakeHost();
    recorder.handle(HostMethod.PreviewInput, (p) => {
      const actions = (p.actions ?? []) as Array<{ type: string }>;
      if (actions.some((action) => action.type === "touch"))
        throw Object.assign(new Error("no touch here"), { refusal: NativeRefusal.TouchNotTaken });
      return { ok: true, applied: actions.length, width: 640, height: 360 };
    });
    const game = {
      playScript: [
        { type: "touch", x: 4, y: 5 },
        { type: "tap", keys: ["Space"] },
      ],
    };
    const evidence = await nativePass(ctxOf(recorder), {
      run: raylibRun({ stack: GameStack.RustWgpu, game }),
      handle: NATIVE,
      seed: SEED,
    });
    assert.ok(
      evidence.warnings.some((warning) => /1 touch of the play script went untested/.test(warning)),
      JSON.stringify(evidence.warnings),
    );
  });

  it("a capture refused device-lost past its retries fails by camera, never silently", async () => {
    const recorder = fakeHost({ deviceLostOnce: ["default", "default"] });
    const evidence = await nativePass(ctxOf(recorder), {
      run: raylibRun({ stack: GameStack.RustWgpu }),
      handle: NATIVE,
      seed: SEED,
      deviceLostRetriesMs: [0],
    });
    assert.equal(evidence.captureFailed, true);
    assert.ok(evidence.problems.some((problem) => /screenshot\(default\)/.test(problem)));
  });

  it("a Browser + Mac game's web look carries the gate's verdict as one board row", async () => {
    const recorder = fakeHost();
    const run = raylibRun();
    const evidence = await withLease(
      ctxOf(recorder),
      "judge",
      (handle) => gatherEvidence(ctxOf(recorder), { run, handle, seed: SEED, motion: 0 }),
      { game: raylibGame([BuildTarget.Web, BuildTarget.Mac]) },
    );
    assert.ok(!("noWindow" in evidence));
    assert.equal(evidence.parity?.pass, true, JSON.stringify(evidence.parity));
    const { results } = await runDeterministicChecks(ctxOf(recorder), { spec: { checks: [] }, evidence });
    assert.equal(results.find((entry) => entry.id === "native-parity")?.pass, true);

    const opengl = fakeHost({
      admission: { ...ADMITTED, refusal: NativeRefusal.LinksOpenGl, detail: OPENGL, imports: [OPENGL] },
    });
    const refused = await withLease(
      ctxOf(opengl),
      "judge",
      (handle) => gatherEvidence(ctxOf(opengl), { run, handle, seed: SEED, motion: 0 }),
      { game: raylibGame([BuildTarget.Web, BuildTarget.Mac]) },
    );
    assert.ok(!("noWindow" in refused));
    assert.equal(refused.ok, false, "a failed gate fails acceptance like a failed check");
    const board = await runDeterministicChecks(ctxOf(opengl), { spec: { checks: [] }, evidence: refused });
    assert.equal(board.results.find((entry) => entry.id === "native-parity")?.pass, false);
  });
});

describe("the Mac and web gates (characterized before Windows and Linux destinations were built)", () => {
  const similarity = "frame similarity is unmeasured until PX10 sets its threshold";
  const lookOf = (targets: Targets, capacity: Omit<typeof MAC_HOST, "host"> & { host: StudioPlatform } = MAC_HOST) => ({
    run: raylibRun(),
    destinations: raylibGame(targets).destinations,
    capacity,
    webHandle: WEB,
    seed: SEED,
    cameras: ["default", "top"],
    judged: true,
    tolerances: memoryTolerances(),
    retriesMs: [],
  });
  /** Every row of a gate this host does not run: unmeasured for `reason`, refused `refusal`. */
  const unrun = (reason: string, refusal: string) =>
    Object.values(ParityRow).map((row) => ({ row, pass: null, reason, refusal }));

  it("the Mac and web gates are unchanged", async () => {
    const recorder = fakeHost();
    const verdict = await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, BuildTarget.Mac]));
    assert.deepEqual(verdict, {
      pass: true,
      reason: "",
      refusal: null,
      targets: [
        {
          target: BuildTarget.Mac,
          pass: true,
          reason: "",
          rows: [
            ...REQUIRED_PARITY_ROWS.map((row) => ({ row, pass: true, reason: "", refusal: null })),
            { row: ParityRow.FrameSimilarity, pass: null, reason: similarity, refusal: null },
          ],
        },
      ],
    });
    assert.deepEqual(recorder.paramsOf(HostMethod.NativeBuild), [{ project: "pong", target: BuildTarget.Mac }]);

    const web = fakeHost();
    assert.equal(await parityFor(ctxOf(web), lookOf([BuildTarget.Web])), null, "a web-only game owes no gate");
    assert.equal(web.calls.length, 0, "and asks the host nothing");

    const noBox = fakeHost();
    const boxless = { ...MAC_HOST, native: { gameBox: false, leases: 0, max: 4 } };
    const unboxed = await parityFor(ctxOf(noBox), lookOf([BuildTarget.Web, BuildTarget.Mac], boxless));
    assert.deepEqual(unboxed?.targets[0]?.rows, unrun("this host has no game box for macos", TargetRefusal.NoGameBox));
    assert.equal(unboxed?.pass, null);

    const linux = fakeHost();
    const onLinux = await parityFor(
      ctxOf(linux),
      lookOf([BuildTarget.Web, BuildTarget.Mac], { ...MAC_HOST, host: StudioPlatform.Linux }),
    );
    assert.deepEqual(onLinux?.targets[0]?.rows, unrun("Mac builds need a Mac", TargetRefusal.MacBuildsNeedAMac));
    assert.equal(noBox.paramsOf(HostMethod.NativeBuild).length + linux.paramsOf(HostMethod.NativeBuild).length, 0);

    const pass = await nativePass(ctxOf(fakeHost()), { run: raylibRun(), handle: NATIVE, seed: SEED });
    assert.deepEqual(pass.admission, { row: ParityRow.Admission, pass: true, reason: "", refusal: null });
  });
});

describe("Windows and Linux destinations a host builds but does not run (§3.9 U6)", () => {
  const NOT_RUN_ON_MAC = "built, not run on this Mac";
  const lookOf = (targets: Targets, host: StudioPlatform = StudioPlatform.Mac, root: string | null = null) => ({
    run: raylibRun(),
    destinations: raylibGame(targets).destinations,
    capacity: { ...MAC_HOST, host },
    webHandle: WEB,
    root,
    seed: SEED,
    cameras: ["default"],
    judged: true,
    retriesMs: [],
  });
  /** The rows after admission, as one sentence each: what the gate could not do here. */
  const restOf = <T extends { row: string }>(rows: ReadonlyArray<T>) =>
    rows.filter((entry) => entry.row !== ParityRow.Admission);
  /** A look on a Mac at a [Browser, `target`] game, judged on the web build, with the native.build answer given. */
  async function lookAt(target: BuildTarget, cross?: Record<string, unknown> | Error) {
    const recorder = fakeHost(cross ? { cross: { [target]: cross } } : {});
    const evidence = await withLease(
      ctxOf(recorder),
      "judge",
      (handle) => gatherEvidence(ctxOf(recorder), { run: raylibRun(), handle, seed: SEED, motion: 0 }),
      { game: raylibGame([BuildTarget.Web, target]) },
    );
    assert.ok(!("noWindow" in evidence));
    const board = await runDeterministicChecks(ctxOf(recorder), { spec: { checks: [] }, evidence });
    return { recorder, evidence, parityRow: board.results.find((entry) => entry.id === "native-parity") };
  }

  for (const target of [BuildTarget.Windows, BuildTarget.Linux])
    it(`on a Mac host a ${target} destination is built and reported unmeasured '${NOT_RUN_ON_MAC}', never pass`, async () => {
      const recorder = fakeHost();
      const verdict = await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, target]));
      assert.deepEqual(recorder.paramsOf(HostMethod.NativeBuild), [{ project: "pong", target }], "built once");
      const gated = verdict?.targets[0];
      assert.equal(gated?.target, target);
      assert.deepEqual(
        gated?.rows.map((entry) => entry.row),
        Object.values(ParityRow),
        "every row, in the plan's order",
      );
      assert.deepEqual(rowOf(gated?.rows ?? [], ParityRow.Admission), {
        row: ParityRow.Admission,
        pass: true,
        reason: "",
        refusal: null,
      });
      for (const entry of restOf(gated?.rows ?? []))
        assert.deepEqual(
          entry,
          { row: entry.row, pass: null, reason: NOT_RUN_ON_MAC, refusal: TargetRefusal.NotRunnableHere },
          entry.row,
        );
      assert.equal(gated?.pass, null, "never pass");
      assert.equal(verdict?.pass, null, "never pass");
      assert.match(verdict?.reason ?? "", new RegExp(`native parity \\(${target}\\): ready: ${NOT_RUN_ON_MAC}`));
      assert.equal(recorder.paramsOf(HostMethod.PreviewAcquire).length, 0, "nothing is run");
      const { evidence, parityRow } = await lookAt(target);
      assert.equal(evidence.ok, true, JSON.stringify(evidence.problems));
      assert.equal(parityRow?.pass, null, "the board row is never a pass");
    });

  it("a worktree's look builds the destination in that worktree", async () => {
    const recorder = fakeHost();
    await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, BuildTarget.Windows], StudioPlatform.Mac, "/wt/pong"));
    assert.deepEqual(recorder.paramsOf(HostMethod.NativeBuild), [
      { project: "pong", target: BuildTarget.Windows, root: "/wt/pong" },
    ]);
  });

  it("a gate refusal of the Linux build fails the Admission row with foreign-import", async () => {
    const detail = "needs libGL.so.1, which neither glibc nor the bundle provides";
    const answers: Record<string, Record<string, unknown>> = {
      "the lane's gate refused it": failedBuild(BuildTarget.Linux, {
        reason: BuildProblemCode.GateRefused,
        lines: [detail],
        gate: { refusal: NativeRefusal.ForeignImport, file: "game" },
      }),
      "the host's facts refuse it": builtCross(BuildTarget.Linux, {
        ...CROSS_FACTS[BuildTarget.Linux],
        refusal: NativeRefusal.ForeignImport,
        detail,
        imports: ["libGLESv2.so", "libEGL.so", "libGL.so.1", "libc.so.6"],
      }),
    };
    for (const [label, answer] of Object.entries(answers)) {
      const recorder = fakeHost({ cross: { [BuildTarget.Linux]: answer } });
      const verdict = await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, BuildTarget.Linux]));
      const rows = verdict?.targets[0]?.rows ?? [];
      const admission = rowOf(rows, ParityRow.Admission);
      assert.equal(admission?.pass, false, label);
      assert.equal(admission?.refusal, NativeRefusal.ForeignImport, label);
      assert.equal(admission?.reason, `the host refused the build: foreign-import (${detail})`, label);
      assert.ok(
        restOf(rows).every((entry) => entry.pass === null),
        `${label}: the rest stay unmeasured`,
      );
      assert.ok(
        restOf(rows).every((entry) => !/\bbuilt\b/.test(entry.reason)),
        `${label}: a refused build is never called built`,
      );
      assert.equal(verdict?.pass, false, label);
    }
    const { evidence, parityRow } = await lookAt(BuildTarget.Linux, answers["the lane's gate refused it"]);
    assert.equal(evidence.ok, false, "the game is broken for a destination it names");
    assert.equal(parityRow?.pass, false);
  });

  it("a Windows build that does not compile fails the look", async () => {
    const error = "src/main.cpp:12:3: error: use of undeclared identifier 'DrawCirlce'";
    const { evidence, parityRow } = await lookAt(
      BuildTarget.Windows,
      failedBuild(BuildTarget.Windows, { reason: BuildProblemCode.CommandFailed, lines: [error] }),
    );
    const admission = rowOf(evidence.parity?.targets[0]?.rows ?? [], ParityRow.Admission);
    assert.equal(admission?.pass, false);
    assert.equal(admission?.refusal, NativeRefusal.BuildFailed);
    assert.equal(admission?.reason, `the windows build failed: ${error}`);
    assert.equal(evidence.ok, false);
    assert.ok(
      evidence.problems.includes(`native parity (windows): admission: the windows build failed: ${error}`),
      JSON.stringify(evidence.problems),
    );
    assert.equal(parityRow?.pass, false, "the board row fails");
  });

  it("a missing zig leaves every row unmeasured (toolchain-missing)", async () => {
    for (const reason of [BuildProblemCode.ToolchainMissing, BuildProblemCode.ToolchainUnprepared]) {
      const answer = failedBuild(BuildTarget.Windows, { reason, lines: ["zig 0.16.0 is not installed"] });
      const recorder = fakeHost({ cross: { [BuildTarget.Windows]: answer } });
      const verdict = await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, BuildTarget.Windows]));
      const rows = verdict?.targets[0]?.rows ?? [];
      assert.deepEqual(
        rows.map((entry) => entry.row),
        Object.values(ParityRow),
      );
      for (const entry of rows) {
        assert.equal(entry.pass, null, `${reason} ${entry.row}`);
        assert.equal(entry.refusal, BuildProblemCode.ToolchainMissing, `${reason} ${entry.row}`);
        assert.doesNotMatch(entry.reason, /\bbuilt\b/, "nothing was built");
        assert.match(entry.reason, /zig 0\.16\.0 is not installed/);
      }
      assert.equal(verdict?.pass, null, `${reason}: never fails the board for a missing toolchain`);
      const look = await lookAt(BuildTarget.Windows, answer);
      assert.equal(look.evidence.ok, true, JSON.stringify(look.evidence.problems));
      assert.notEqual(look.parityRow?.pass, false);
    }
  });

  it("a Linux host's Windows destination is built and reported the same way", async () => {
    const said: Record<string, string> = {};
    for (const [host, target] of [
      [StudioPlatform.Linux, BuildTarget.Windows],
      [StudioPlatform.Windows, BuildTarget.Linux],
    ] as const) {
      const recorder = fakeHost();
      const verdict = await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, target], host));
      assert.deepEqual(recorder.paramsOf(HostMethod.NativeBuild), [{ project: "pong", target }], host);
      const rows = verdict?.targets[0]?.rows ?? [];
      assert.equal(rowOf(rows, ParityRow.Admission)?.pass, true, host);
      assert.ok(restOf(rows).every((entry) => entry.pass === null && entry.refusal === TargetRefusal.NotRunnableHere));
      said[host] = rowOf(rows, ParityRow.Ready)?.reason ?? "";
      assert.equal(verdict?.pass, null, host);
    }
    assert.deepEqual(said, {
      [StudioPlatform.Linux]: "built, not run on this Linux PC",
      [StudioPlatform.Windows]: "built, not run on this Windows PC",
    });
  });

  it("a native.build that throws leaves every row unmeasured in the error's words", async () => {
    const recorder = fakeHost({ cross: { [BuildTarget.Windows]: new Error("the host went away") } });
    const verdict = await parityFor(ctxOf(recorder), lookOf([BuildTarget.Web, BuildTarget.Windows]));
    for (const entry of verdict?.targets[0]?.rows ?? []) {
      assert.equal(entry.pass, null, entry.row);
      assert.equal(entry.reason, "the host went away", entry.row);
    }
    assert.equal(verdict?.pass, null);
  });
});

describe("a Rust · wgpu game's evidence (M3.2)", () => {
  /** A Rust night's run, as run-dispatch stamps it. */
  const rustRun = (overrides: Record<string, unknown> = {}) =>
    raylibRun({ project: "pond", goal: "a pond you can fish in", stack: GameStack.RustWgpu, ...overrides });
  const rustGame = (targets: Targets) => ({ destinations: { stack: GameStack.RustWgpu, targets: [...targets] } });

  it("reports the logical draw count equal to the game's tags, never the GPU encoder count under volatile.gpu", async () => {
    const tags = { world: { drawCalls: 7, triangles: 900 }, hud: { drawCalls: 2, triangles: 40 } };
    const gpu = { drawCalls: 2, multiDraws: 1, passes: 3 };
    const recorder = fakeHost({
      backend: NativeBackend.Metal,
      extra: { __render: { drawCalls: 9, triangles: 940, tags, exact: false }, volatile: { fps: 60, gpu } },
    });
    const evidence = await nativePass(ctxOf(recorder), {
      run: rustRun(),
      iterationId: "i1",
      seed: SEED,
      handle: NATIVE,
    });
    assert.equal(evidence.stack, GameStack.RustWgpu, "the pass says which stack it looked at");
    assert.equal(evidence.render?.drawCalls, 9, "seven world draws and two HUD paints, as the game tagged them");
    assert.deepEqual(evidence.render?.tags, { world: 7, hud: 2 });
    assert.deepEqual(evidence.render?.gpu, gpu, "the encoder's counts are reported apart, under volatile.gpu");
  });

  it("names what a Rust web build cannot measure in its own words, never a pass", async () => {
    const recorder = fakeHost();
    recorder.handle(HostMethod.GameList, () => [{ name: "pond", ...rustGame([BuildTarget.Web]) }]);
    const evidence = { ok: true, problems: [], warnings: [], shots: [] } as unknown as Evidence;
    const looked = await withParity(ctxOf(recorder), { run: rustRun(), iterationId: "i1" } as never, evidence, null);
    for (const probe of RUST_WEB_UNMEASURED)
      assert.match(String(looked.unmeasured?.[probe]), /Rust · wgpu web build/, probe);
    assert.equal(looked.audio, null, "no level answered: the sound is unmeasured");
    assert.equal(typeof looked.unmeasured?.[NativeProbe.Audio], "string");
  });

  it("measures a Rust web build's sound exactly when its page's audio() answers available (AU-9)", async () => {
    const heard = { available: true, rms: 0.0886, centroid: 459 };
    const answers = [
      { audio: heard, measured: true },
      { audio: { available: false, rms: 0, centroid: 0 }, measured: false },
      { audio: { rms: 0.1, centroid: 900 }, measured: false },
      { audio: null, measured: false },
    ];
    for (const { audio, measured } of answers) {
      const recorder = fakeHost();
      recorder.handle(HostMethod.GameList, () => [{ name: "pond", ...rustGame([BuildTarget.Web]) }]);
      const evidence = { ok: true, problems: [], warnings: [], shots: [], audio } as unknown as Evidence;
      const looked = await withParity(ctxOf(recorder), { run: rustRun(), iterationId: "i1" } as never, evidence, null);
      const label = JSON.stringify(audio);
      assert.deepEqual(looked.audio, measured ? heard : null, label);
      assert.equal(looked.unmeasured?.[NativeProbe.Audio] === undefined, measured, label);
      assert.match(String(looked.unmeasured?.[NativeProbe.Profiler]), /Rust · wgpu web build/, label);
    }
  });

  it("a phone destination is never run or said to be built: every row unmeasured, its gameplay judged on this computer's build", async () => {
    const recorder = fakeHost();
    const verdict = await parityFor(ctxOf(recorder), {
      run: rustRun(),
      destinations: rustGame([BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android]).destinations,
      capacity: MAC_HOST,
      webHandle: WEB,
      seed: SEED,
      cameras: ["default"],
      judged: true,
      tolerances: memoryTolerances(),
      retriesMs: [],
    });
    assert.equal(verdict?.pass, null, "never pass");
    for (const target of [BuildTarget.Ios, BuildTarget.Android]) {
      const phone: TargetParity | undefined = (verdict?.targets ?? []).find((entry) => entry.target === target);
      assert.equal(phone?.rows.length, Object.values(ParityRow).length, target);
      for (const row of phone?.rows ?? []) {
        assert.equal(row.pass, null, `${target} ${row.row}`);
        assert.equal(row.refusal, TargetRefusal.NotRunnableHere);
        assert.match(row.reason, /device the person starts/, "not the Mac-only sentence");
      }
    }
    assert.equal(recorder.paramsOf(HostMethod.NativeBuild).length, 0, "nothing the host cannot build is asked of it");
    assert.equal(recorder.paramsOf(HostMethod.PreviewAcquire).length, 0, "no device or simulator is run");
  });

  /** A Rust game's Browser + Mac gate on a fake host. */
  const rustGate = (recorder: CtxRecorder) =>
    runParityGate(ctxOf(recorder), {
      run: rustRun(),
      target: BuildTarget.Mac,
      webHandle: WEB,
      seed: SEED,
      cameras: ["default", "top"],
      tolerances: memoryTolerances(),
      retriesMs: [],
    });
  /** What a contract v2 native run adds to every `state()` and the protocol 1 web build never has. */
  const V2_ENVELOPE = {
    contractVersion: 2,
    lifecycle: NativeLifecycle.Resumed,
    safeArea: { top: 0, left: 0, bottom: 0, right: 0 },
  };

  it("a Rust web build at protocol 1 agrees with its contract v2 native run: the contract envelope is never gameplay", async () => {
    const recorder = fakeHost({
      stateByTarget: { [BuildTarget.Mac]: V2_ENVELOPE, [BuildTarget.Web]: { contractVersion: 1 } },
    });
    const verdict = await rustGate(recorder);
    assert.equal(rowOf(verdict.rows, ParityRow.CrossTarget)?.pass, true, JSON.stringify(verdict.rows));
    assert.equal(verdict.pass, true);
  });

  it("the contract envelope left out still rejects a Rust game's gameplay drift", async () => {
    const recorder = fakeHost({
      drift: { [BuildTarget.Mac]: 0.01 },
      stateByTarget: { [BuildTarget.Mac]: V2_ENVELOPE, [BuildTarget.Web]: { contractVersion: 1 } },
    });
    const cross = rowOf((await rustGate(recorder)).rows, ParityRow.CrossTarget);
    assert.equal(cross?.pass, false);
    assert.match(String(cross?.reason), /player\.x/);
    assert.doesNotMatch(String(cross?.reason), /contractVersion|lifecycle|safeArea/);
  });

  it("a web build this preview cannot run for want of WebGPU is unavailable through parityFor, never a failed game", async () => {
    const recorder = fakeHost({ webWithoutWebGpu: true });
    const verdict = await parityFor(ctxOf(recorder), {
      run: rustRun(),
      destinations: rustGame([BuildTarget.Web, BuildTarget.Mac]).destinations,
      capacity: MAC_HOST,
      webHandle: WEB,
      seed: SEED,
      cameras: ["default"],
      judged: true,
      tolerances: memoryTolerances(),
      retriesMs: [],
    });
    const mac = verdict?.targets.find((entry) => entry.target === BuildTarget.Mac);
    const cross = rowOf(mac?.rows ?? [], ParityRow.CrossTarget);
    assert.equal(cross?.pass, null, JSON.stringify(cross));
    assert.equal(cross?.refusal, NativeRefusal.GpuUnsupported);
    assert.equal(mac?.pass, true, "the Mac gate stands on its own rows");
    assert.notEqual(verdict?.pass, false, "the preview's limit never fails the game");
    const evidence = { stack: GameStack.RustWgpu, shots: [], parity: verdict };
    const { results } = await runDeterministicChecks(ctxOf(recorder), {
      spec: { checks: [] },
      evidence: evidence as never,
    });
    const row = results.find((entry) => entry.id === PARITY_CHECK_ID);
    assert.equal(row?.pass, true, JSON.stringify(row));
    assert.deepEqual(row?.unavailableTargets, [BuildTarget.Web]);
  });

  it("a native run refused gpu-unsupported still fails its gate: only the web preview's limit is unavailable", async () => {
    const recorder = fakeHost();
    recorder.handle(HostMethod.PreviewLoad, (p) => {
      if (p.handle === NATIVE)
        throw Object.assign(new Error("no WebGPU-core adapter"), { refusal: NativeRefusal.GpuUnsupported });
      return "http://127.0.0.1/pond/";
    });
    const verdict = await rustGate(recorder);
    assert.equal(verdict.pass, false, JSON.stringify(verdict.rows));
  });

  it("keeps a tolerance per (stack, target, target): a raylib game's never loosens or tightens a Rust pair", async () => {
    const workspace = await tmpDir("parity-tolerances-");
    const store = workspaceTolerances(workspace);
    const raylibMac = { stack: GameStack.RaylibCpp, a: BuildTarget.Web, b: BuildTarget.Mac };
    const rustMac = { stack: GameStack.RustWgpu, a: BuildTarget.Web, b: BuildTarget.Mac };
    await store.write("pond", 5e-4, raylibMac);
    assert.equal(await store.read("pond", rustMac), null, "a Rust pair starts from the default");
    assert.equal(await store.read("pond", raylibMac), 5e-4);
    await store.write("pond", 2e-5, rustMac);
    assert.equal(await store.read("pond", rustMac), 2e-5);
    assert.equal(await store.read("pond", raylibMac), 5e-4, "the raylib pair is untouched");
    assert.equal(await store.read("pond"), 5e-4, "a reader written before pairs reads the raylib pair");
  });
});
