/**
 * Everything before a native game starts (`prepareNativeRun`): the destination and host checks,
 * the lane's Mac build, bundle admission, the game's own bundle id, the store's ANGLE and the run
 * directory. Every refusal is a typed `NativeError` and leaves nothing assembled; a Stop between
 * steps stops everything after it. All over fakes: the lane, the store and the bundle are stood in.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { BuildTarget, GameStack, type GameProject } from "../../src/shared/game-project.ts";
import { GameBoxProblem, NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { type CppBuildInput, CppBuildPurpose, refusalProblem } from "../../src/main/cpp-build.ts";
import type { BuildOutcome } from "../../src/main/game-build.ts";
import {
  type NativeBundleSteps,
  type NativePrepareDeps,
  prepareNativeRun,
} from "../../src/main/core/native-prepare.ts";
import type { NativePrepareRequest } from "../../src/main/core/native-runs.ts";
import type { AdmittedMacBundle, MacAngle, RunDirRequest } from "../../src/substrate/native-bundle.ts";
import type { CrossAdmission, CrossAdmissionRequest } from "../../src/substrate/native-cross-admission.ts";
import type { CrossRunDirRequest } from "../../src/substrate/native-rundir-cross.ts";
import { raylibLanes } from "../helpers/game-lanes.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const ROOT = "/runs";
const GAME_DIR = "/games/pong";
const LOCK = { digest: "d84d34a63e45d84d34a63e45d84d34a63e45d84d34a63e45d84d34a63e45d84d" } as unknown as ToolchainLock;
const ANGLE: MacAngle = {
  dir: "/store/angle",
  egl: "/store/angle/libEGL.dylib",
  gles: "/store/angle/libGLESv2.dylib",
  manifestSha256: "d1a8c476",
};

function raylibGame(targets: BuildTarget[] = [BuildTarget.Web, BuildTarget.Mac]): GameProject {
  return {
    name: "pong",
    dir: GAME_DIR,
    title: "Pong",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/pong",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    shape: {
      entry: "index.html",
      main: "src/main.cpp",
      build: null,
      install: null,
      own: false,
      kind: "raylib-cpp",
      serve: ".",
    },
    built: false,
    destinations: { stack: GameStack.RaylibCpp, targets },
  } as GameProject;
}

interface Calls {
  steps: string[];
  builds: CppBuildInput[];
  assembled: RunDirRequest[];
}

function deps(
  overrides: {
    games?: GameProject[];
    host?: StudioPlatform | null;
    gameBox?: boolean;
    build?: Partial<BuildOutcome>;
    admit?: Awaited<ReturnType<NonNullable<NativePrepareDeps["bundle"]>["admit"]>>;
    angleRefusal?: NativeRefusal | null;
    locate?: "ok" | "no-angle" | "missing" | "not-hosted";
    onStep?: (step: string) => void;
  } = {},
): { deps: NativePrepareDeps; calls: Calls } {
  const calls: Calls = { steps: [], builds: [], assembled: [] };
  const step = (name: string) => {
    calls.steps.push(name);
    overrides.onStep?.(name);
  };
  const admitted: AdmittedMacBundle = {
    mode: NativeRunMode.Headless,
    exe: "/builds/out/game-headless",
    image: {
      fileType: "execute",
      dylibs: ["@rpath/libEGL.dylib", "@rpath/libGLESv2.dylib"],
      rpaths: [],
      id: null,
      environment: [],
    },
    assets: null,
  };
  const value: NativePrepareDeps = {
    root: ROOT,
    host: overrides.host === undefined ? StudioPlatform.Mac : overrides.host,
    gameBox: () => overrides.gameBox ?? true,
    games: {
      list: async () => overrides.games ?? [raylibGame()],
      bundleIdFor: async () => {
        step("bundleId");
        return "games.genex.game.0123456789ab";
      },
    },
    gameBuilds: raylibLanes({
      ensure: async (input) => {
        step("build");
        calls.builds.push(input);
        return { ok: true, output: "/builds/out", lastGood: null, problem: null, ran: true, ...overrides.build };
      },
    }),
    toolchains: {
      currentLock: async () => LOCK,
      locate: async () => {
        step("locate");
        if (overrides.locate === "missing") return { ok: false, missing: ["angle-macos"] };
        if (overrides.locate === "not-hosted") return { ok: false, missing: ["angle-macos"], notHosted: true };
        return { ok: true, toolchain: { lock: LOCK, angle: overrides.locate === "no-angle" ? null : ANGLE } };
      },
    } as unknown as NativePrepareDeps["toolchains"],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    bundle: {
      admit: async (_out, options) => {
        step("admit");
        return overrides.admit ?? { ok: true, bundle: { ...admitted, mode: options.mode } };
      },
      checkAngle: async () => {
        step("checkAngle");
        return overrides.angleRefusal ?? null;
      },
      assemble: async (request) => {
        step("assemble");
        calls.assembled.push(request);
        const runDir = path.join(request.root, request.runId);
        return {
          runDir,
          exe: path.join(runDir, "bundle", "Game.app", "Contents", "MacOS", "game"),
          bundle: path.join(runDir, "bundle"),
          state: path.join(runDir, "state"),
        };
      },
    },
  };
  return { deps: value, calls };
}

function request(extra: Partial<NativePrepareRequest> = {}): NativePrepareRequest {
  return { project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Headless, runId: "0123456789ab", ...extra };
}

async function refusal(promise: Promise<unknown>): Promise<{ refusal: string; problem: unknown } | null> {
  return promise.then(
    () => null,
    (error: unknown) => {
      assert.ok(error instanceof NativeError, `typed: ${String(error)}`);
      return { refusal: error.refusal, problem: error.problem };
    },
  );
}

describe("prepareNativeRun refuses before anything is assembled", () => {
  const rows: Array<[string, Parameters<typeof deps>[0], Partial<NativePrepareRequest>, string]> = [
    ["an unlisted project", { games: [] }, {}, NativeRefusal.NotADestination],
    [
      "a destination the game does not name",
      { games: [raylibGame([BuildTarget.Web])] },
      {},
      NativeRefusal.NotADestination,
    ],
    [
      "a Three.js game",
      { games: [{ ...raylibGame(), shape: { ...raylibGame().shape, kind: "studio-template" } }] },
      {},
      NativeRefusal.NotADestination,
    ],
    // Flipped (FIX-LIVE): a Rust game's Mac headless and embedded runs now prepare through the
    // wgpu admission (`rust-native-prepare.test.ts`); its window run alone has no lane.
    [
      "a Rust game's window run on the Mac, which its studio mode cannot show",
      {
        games: [
          {
            ...raylibGame(),
            shape: { ...raylibGame().shape, kind: "rust-wgpu", main: "src/main.rs" },
            destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
          },
        ],
      },
      { mode: NativeRunMode.Window },
      NativeRefusal.LaneMissing,
    ],
    ["no game box on this host", { gameBox: false }, {}, NativeRefusal.NoGameBox],
    [
      "a destination this host cannot run",
      { games: [raylibGame([BuildTarget.Windows])] },
      { target: BuildTarget.Windows },
      NativeRefusal.NotRunnableHere,
    ],
    ["a host the studio does not build for", { host: null }, {}, NativeRefusal.NotRunnableHere],
    [
      "an embedded run of a game with no Mac destination",
      { games: [raylibGame([BuildTarget.Web])] },
      { mode: NativeRunMode.Embedded },
      NativeRefusal.NotADestination,
    ],
  ];
  for (const [label, given, extra, expected] of rows) {
    it(`${label}: ${expected}, with no build`, async () => {
      const { deps: d, calls } = deps(given);
      const refused = await refusal(prepareNativeRun(d, request(extra), new AbortController().signal));
      assert.equal(refused?.refusal, expected);
      assert.deepEqual(calls.steps, [], "nothing built, admitted or assembled");
    });
  }

  it("a failed build is build-failed with the lane's problem, and nothing is admitted", async () => {
    const problem = refusalProblem({
      project: "pong",
      target: BuildTarget.Mac,
      reason: BuildProblemCode.ToolchainMissing,
      at: new Date(0).toISOString(),
    });
    const { deps: d, calls } = deps({ build: { ok: false, output: null, problem } });
    const refused = await refusal(prepareNativeRun(d, request(), new AbortController().signal));
    assert.deepEqual(refused, { refusal: NativeRefusal.BuildFailed, problem });
    assert.deepEqual(calls.steps, ["build"]);
  });

  it("an admission refusal is its own refusal, and nothing is assembled", async () => {
    const { deps: d, calls } = deps({
      admit: { ok: false, refusal: NativeRefusal.LinksOpenGl, detail: "OpenGL.framework" },
    });
    const refused = await refusal(prepareNativeRun(d, request(), new AbortController().signal));
    assert.equal(refused?.refusal, NativeRefusal.LinksOpenGl);
    assert.deepEqual(calls.assembled, []);
  });

  it("a store with no ANGLE for the lock, or one that fails its check, is refused and nothing is assembled", async () => {
    for (const [given, expected] of [
      [{ locate: "no-angle" as const }, NativeRefusal.BuildFailed],
      [{ locate: "missing" as const }, NativeRefusal.BuildFailed],
      [{ angleRefusal: NativeRefusal.AngleDigest }, NativeRefusal.AngleDigest],
    ] as const) {
      const { deps: d, calls } = deps(given);
      const refused = await refusal(prepareNativeRun(d, request(), new AbortController().signal));
      assert.equal(refused?.refusal, expected, JSON.stringify(given));
      assert.deepEqual(calls.assembled, []);
    }
  });
});

describe("what a refusal of the store's ANGLE says", () => {
  it("a store with no ANGLE is a toolchain-missing problem stamped by the injected clock", async () => {
    const at = Date.UTC(2026, 9, 1, 12, 0, 0);
    const { deps: d } = deps({ locate: "missing" });
    const refused = await prepareNativeRun({ ...d, now: () => at }, request(), new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof NativeError);
    assert.equal(refused.problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.equal(refused.problem?.at, new Date(at).toISOString());
  });

  it("a store whose Mac ANGLE has no download yet says so, not that tools are missing", async () => {
    const { deps: d } = deps({ locate: "not-hosted" });
    const refused = await prepareNativeRun(d, request(), new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof NativeError);
    assert.equal(refused.refusal, NativeRefusal.BuildFailed);
    assert.equal(refused.problem?.reason, BuildProblemCode.ToolchainNotHosted);
  });

  it("an ANGLE that fails its check is refused with that check's refusal, not as a missing ANGLE", async () => {
    const missing = await prepareNativeRun(
      deps({ locate: "no-angle" }).deps,
      request(),
      new AbortController().signal,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const failed = await prepareNativeRun(
      deps({ angleRefusal: NativeRefusal.AngleDigest }).deps,
      request(),
      new AbortController().signal,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(missing instanceof NativeError && failed instanceof NativeError);
    assert.equal(failed.refusal, NativeRefusal.AngleDigest);
    assert.notEqual(failed.message, missing.message, "a failed check is not said as a missing ANGLE");
    assert.ok(failed.message.includes(NativeRefusal.AngleDigest), failed.message);
  });
});

describe("prepareNativeRun builds what the run needs", () => {
  it("a window run builds Live's purpose from the game folder and records its lock; a headless one judges", async () => {
    for (const [mode, purpose] of [
      [NativeRunMode.Window, CppBuildPurpose.Live],
      [NativeRunMode.Headless, CppBuildPurpose.Judging],
    ] as const) {
      const { deps: d, calls } = deps();
      const prepared = await prepareNativeRun(d, request({ mode }), new AbortController().signal);
      const [build] = calls.builds;
      assert.equal(build?.purpose, purpose, mode);
      assert.equal(build?.dir, GAME_DIR);
      assert.equal(build?.target, BuildTarget.Mac);
      assert.equal(build?.lock, LOCK);
      assert.equal(build?.recordLock, true);
      assert.equal(calls.assembled[0]?.uiElement, mode !== NativeRunMode.Window, "agent runs have no Dock icon");
      assert.equal(calls.assembled[0]?.bundleId, "games.genex.game.0123456789ab");
      assert.equal(calls.assembled[0]?.angle, ANGLE);
      assert.equal(calls.assembled[0]?.gameName, "Pong", 'the window and the Dock name the game, not "Game"');
      assert.equal(prepared.runDir, path.join(ROOT, "0123456789ab"));
      assert.deepEqual(calls.steps, ["build", "admit", "bundleId", "locate", "checkAngle", "assemble"]);
    }
  });

  it("an embedded run builds Live's purpose and admits and assembles the headless executable, with no Dock icon", async () => {
    const { deps: d, calls } = deps();
    const admitted: NativeRunMode[] = [];
    const bundle = d.bundle;
    assert.ok(bundle);
    const prepared = await prepareNativeRun(
      {
        ...d,
        bundle: {
          ...bundle,
          admit: async (out, options) => {
            admitted.push(options.mode);
            return bundle.admit(out, options);
          },
        },
      },
      request({ mode: NativeRunMode.Embedded }),
      new AbortController().signal,
    );
    assert.equal(calls.builds[0]?.purpose, CppBuildPurpose.Live, "Live's Native view is the person's");
    assert.deepEqual(admitted, [NativeRunMode.Headless], "it draws headless, into Live's frames ring");
    assert.equal(calls.assembled[0]?.admitted.mode, NativeRunMode.Headless);
    assert.equal(calls.assembled[0]?.uiElement, true, "no Dock icon");
    assert.deepEqual(calls.steps, ["build", "admit", "bundleId", "locate", "checkAngle", "assemble"]);
    assert.equal(prepared.runDir, path.join(ROOT, "0123456789ab"));
  });

  it("a checked worktree root is built instead of the game folder, and records no lock", async () => {
    const { deps: d, calls } = deps();
    await prepareNativeRun(d, request({ root: "/scratch/wt/pong" }), new AbortController().signal);
    assert.equal(calls.builds[0]?.dir, "/scratch/wt/pong");
    assert.equal(calls.builds[0]?.recordLock, false);
  });

  it("says when the build is done and admission begins", async () => {
    const heard: string[] = [];
    const { deps: d } = deps({ onStep: (step) => heard.push(step) });
    await prepareNativeRun(d, request({ onAdmitting: () => heard.push("admitting") }), new AbortController().signal);
    assert.deepEqual(heard.slice(0, 3), ["build", "admitting", "admit"]);
  });

  it("a Stop between any two steps stops everything after it", async () => {
    const steps = ["build", "admit", "bundleId", "locate", "checkAngle"];
    for (const stopAfter of steps) {
      const controller = new AbortController();
      const { deps: d, calls } = deps({ onStep: (step) => step === stopAfter && controller.abort() });
      await assert.rejects(prepareNativeRun(d, request(), controller.signal), stopAfter);
      assert.equal(calls.steps.at(-1), stopAfter, `nothing after ${stopAfter}`);
      assert.deepEqual(calls.assembled, []);
    }
  });
});

// ── a Windows or Linux host's own OS ─────────────────────────────────────────────────────────

const CROSS_ANGLE = { dir: "/store/angle-cross", manifestSha256: "c5bf49e78850c5bf" };
const CROSS_OUT = "/builds/out-cross";

/** Deps for a Windows or Linux host running its own OS: the cross gate and run dir stood in, each step recorded. */
function crossDeps(
  host: typeof StudioPlatform.Windows | typeof StudioPlatform.Linux,
  overrides: {
    admit?: CrossAdmission;
    noAngle?: boolean;
    gameBox?: boolean;
    gameBoxProblem?: GameBoxProblem | null;
    onStep?: (step: string) => void;
  } = {},
) {
  const target = host === StudioPlatform.Windows ? BuildTarget.Windows : BuildTarget.Linux;
  const exeName = host === StudioPlatform.Windows ? "game.exe" : "game";
  const { deps: base, calls } = deps({
    host,
    games: [raylibGame([BuildTarget.Web, target])],
    ...(overrides.gameBox === undefined ? {} : { gameBox: overrides.gameBox }),
  });
  const admitted: CrossAdmission = {
    ok: true,
    target,
    out: CROSS_OUT,
    outFolder: { real: CROSS_OUT, dev: 1, ino: 1 },
    facts: { imports: [], maxGlibc: null },
  };
  const crossCalls = { admitted: [] as CrossAdmissionRequest[], assembled: [] as CrossRunDirRequest[] };
  const step = (name: string) => {
    calls.steps.push(name);
    overrides.onStep?.(name);
  };
  const value: NativePrepareDeps = {
    ...base,
    gameBuilds: raylibLanes({
      ensure: async (input) => {
        step("build");
        calls.builds.push(input);
        return { ok: true, output: CROSS_OUT, lastGood: null, problem: null, ran: true };
      },
    }),
    toolchains: {
      currentLock: async () => LOCK,
      locate: async () => {
        step("locate");
        const cross = overrides.noAngle ? {} : { [target]: { toolchainFile: "/store/zig.cmake", angle: CROSS_ANGLE } };
        return { ok: true, toolchain: { lock: LOCK, angle: null, cross } };
      },
    } as unknown as NativePrepareDeps["toolchains"],
    ...(overrides.gameBoxProblem === undefined ? {} : { gameBoxProblem: () => overrides.gameBoxProblem ?? null }),
    bundle: {
      ...(base.bundle as NativeBundleSteps),
      admitCross: async (request) => {
        step("admitCross");
        crossCalls.admitted.push(request);
        return overrides.admit ?? admitted;
      },
      assembleCross: async (request) => {
        step("assembleCross");
        crossCalls.assembled.push(request);
        const runDir = path.join(request.root, request.runId);
        const bundle = path.join(runDir, "bundle");
        return { runDir, exe: path.join(bundle, exeName), bundle, state: path.join(runDir, "state") };
      },
    },
  };
  return { deps: value, calls, crossCalls, target };
}

describe("prepareNativeRun on a Windows or Linux host, for its own OS", () => {
  for (const host of [StudioPlatform.Windows, StudioPlatform.Linux] as const) {
    it(`${host}: a window run builds, re-admits the output through the gate, assembles, and the game sits in the run dir`, async () => {
      const { deps: d, calls, crossCalls, target } = crossDeps(host);
      const prepared = await prepareNativeRun(
        d,
        request({ target, mode: NativeRunMode.Window }),
        new AbortController().signal,
      );
      assert.deepEqual(calls.steps, ["build", "locate", "admitCross", "assembleCross"]);
      assert.equal(calls.builds[0]?.target, target);
      assert.equal(calls.builds[0]?.purpose, CppBuildPurpose.Live);
      assert.deepEqual(crossCalls.admitted, [{ target, out: CROSS_OUT, angle: CROSS_ANGLE }]);
      assert.equal(crossCalls.assembled[0]?.angle, CROSS_ANGLE);
      assert.equal(crossCalls.assembled[0]?.root, ROOT);
      assert.equal(prepared.runDir, path.join(ROOT, "0123456789ab"));
      assert.equal(path.dirname(path.dirname(prepared.exe)), prepared.runDir, "the game is in the run's own bundle");
      assert.equal(prepared.bundleId, null, "no bundle id and no codesign off the Mac");
    });

    it(`${host}: an agent's headless run is no-game-box with no-headless-build, and nothing is built`, async () => {
      const { deps: d, calls, target } = crossDeps(host);
      const refused = await prepareNativeRun(
        d,
        request({ target, mode: NativeRunMode.Headless }),
        new AbortController().signal,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof NativeError);
      assert.equal(refused.refusal, NativeRefusal.NoGameBox);
      assert.equal(refused.box, GameBoxProblem.NoHeadlessBuild);
      assert.deepEqual(calls.steps, []);
    });

    it(`${host}: an embedded run is embed-unsupported, and nothing is built`, async () => {
      const { deps: d, calls, target } = crossDeps(host);
      const refused = await refusal(
        prepareNativeRun(d, request({ target, mode: NativeRunMode.Embedded }), new AbortController().signal),
      );
      assert.equal(refused?.refusal, NativeRefusal.EmbedUnsupported);
      assert.deepEqual(calls.steps, []);
    });
  }
});

describe("prepareNativeRun on a Windows or Linux host: refusals and Stop", () => {
  for (const host of [StudioPlatform.Windows, StudioPlatform.Linux] as const) {
    it(`${host}: a gate refusal is the run's typed refusal, and nothing is assembled`, async () => {
      const {
        deps: d,
        calls,
        crossCalls,
        target,
      } = crossDeps(host, {
        admit: { ok: false, refusal: NativeRefusal.ForeignImport, file: "game", detail: "imports libssl" },
      });
      const refused = await refusal(
        prepareNativeRun(d, request({ target, mode: NativeRunMode.Window }), new AbortController().signal),
      );
      assert.equal(refused?.refusal, NativeRefusal.ForeignImport);
      assert.deepEqual(crossCalls.assembled, []);
      assert.equal(calls.steps.includes("assembleCross"), false);
    });

    it(`${host}: a store with no ANGLE for this destination is build-failed, toolchain-missing, and nothing is admitted`, async () => {
      const { deps: d, calls, target } = crossDeps(host, { noAngle: true });
      const refused = await refusal(
        prepareNativeRun(d, request({ target, mode: NativeRunMode.Window }), new AbortController().signal),
      );
      assert.equal(refused?.refusal, NativeRefusal.BuildFailed);
      assert.equal((refused?.problem as { reason?: string } | null)?.reason, BuildProblemCode.ToolchainMissing);
      assert.deepEqual(calls.steps, ["build", "locate"]);
    });

    it(`${host}: no game box is no-game-box carrying why, when the sandbox says, with no build`, async () => {
      const {
        deps: d,
        calls,
        target,
      } = crossDeps(host, {
        gameBox: false,
        gameBoxProblem: GameBoxProblem.WaylandUnrestricted,
      });
      const refused = await prepareNativeRun(
        d,
        request({ target, mode: NativeRunMode.Window }),
        new AbortController().signal,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof NativeError);
      assert.equal(refused.refusal, NativeRefusal.NoGameBox);
      assert.equal(refused.box, GameBoxProblem.WaylandUnrestricted);
      assert.deepEqual(calls.steps, []);
    });

    it(`${host}: a Stop between any two steps stops everything after it`, async () => {
      for (const stopAfter of ["build", "locate", "admitCross"]) {
        const controller = new AbortController();
        const {
          deps: d,
          calls,
          crossCalls,
          target,
        } = crossDeps(host, {
          onStep: (step) => step === stopAfter && controller.abort(),
        });
        await assert.rejects(
          prepareNativeRun(d, request({ target, mode: NativeRunMode.Window }), controller.signal),
          stopAfter,
        );
        assert.equal(calls.steps.at(-1), stopAfter, `nothing after ${stopAfter}`);
        assert.deepEqual(crossCalls.assembled, []);
      }
    });
  }
});
