/**
 * The build-lane seam (`GameBuildLanes`, `src/main/game-build.ts`): one `ensure(game, target,
 * purpose)` for every compiled stack, dispatched by the stack the game's files make it. The
 * raylib lane is `CppBuilds` itself behind an adapter, so a raylib build through the seam is the
 * build the C++ lane made before it (characterized here against a direct `CppBuilds.ensure`); a
 * stack with no lane registered (a Rust game until its lane lands, a browser game, which
 * `GameBuilds` builds) is refused `lane-missing` before any lane runs or anything is written.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import {
  BuildTarget,
  type GameDestinations,
  GameStack,
  ProjectKind,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { cppBinaryDir, CppBuilds, type CppBuildInput } from "../../src/main/cpp-build.ts";
import {
  type BuildOutcome,
  type GameBuildGame,
  type GameBuildLane,
  GameBuildLanes,
  GameBuildRefusal,
  raylibLane,
} from "../../src/main/game-build.ts";
import { coreGameBuilds } from "../../src/main/core/internals.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LOCK: ToolchainLock = { version: 1, entries: {}, digest: "fedcba9876543210".repeat(4) };

const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};
const THREE_SHAPE: ProjectShape = { ...RAYLIB_SHAPE, main: "src/main.js", kind: ProjectKind.StudioTemplate };
const RUST_SHAPE: ProjectShape = { ...RAYLIB_SHAPE, main: "src/main.rs", kind: ProjectKind.RustWgpu };

const BROWSER_AND_MAC: GameDestinations = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] };

/** A sandbox stand-in for CMake and Ninja: records every request; the build writes the page, its glue and its module. */
function fakeRun() {
  const calls: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    if (request.command.includes(" '--build' ")) {
      const out = path.join(request.cwd, "out");
      await mkdir(out, { recursive: true });
      for (const name of ["index.html", "index.js", "index.wasm"]) await writeFile(path.join(out, name), name);
    }
    return {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: false,
      command: request.command,
      cwd: request.cwd,
    };
  };
  return { calls, run };
}

/** A real C++ lane over `root`, with a minimal fake store and a fake sandbox. */
async function cppLane(parent: string, root: string) {
  const store = path.join(parent, "store");
  const cache = path.join(store, "locks", "fedcba987654", "em-cache");
  await mkdir(cache, { recursive: true });
  const runner = fakeRun();
  const builds = new CppBuilds({
    root,
    run: runner.run,
    locate: async () => ({
      ok: true,
      toolchain: {
        lock: LOCK,
        cmake: path.join(store, "cmake"),
        ninja: path.join(store, "ninja"),
        emscripten: {
          root: path.join(store, "emscripten"),
          toolchainFile: path.join(store, "emscripten", "cmake", "Modules", "Platform", "Emscripten.cmake"),
          python: path.join(store, "python3"),
          node: path.join(store, "node"),
          config: path.join(store, "emscripten.config"),
          cache,
        },
        genexCmake: { [BuildTarget.Web]: path.join(store, "genex-web.cmake") },
      },
    }),
    currentLock: async () => LOCK,
    emit: () => {},
    platform: process.platform,
    cores: 4,
    denyWrite: [],
    writeLock: async () => {},
    now: () => 1_000,
  });
  return { builds, calls: runner.calls };
}

/** A raylib game folder: the template's CMakeLists and one source file. */
async function raylibGame(parent: string): Promise<string> {
  const dir = path.join(parent, "pong");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "CMakeLists.txt"), `include("\${GENEX_CMAKE}")\ngenex_add_game(SOURCES src/*.cpp)\n`);
  await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 0; }\n");
  return realpath(dir);
}

/** The game as Live's load hands it to the seam: the game folder itself, which records its lock. */
function liveGame(dir: string, shape: ProjectShape = RAYLIB_SHAPE): GameBuildGame {
  return { project: "pong", dir, shape, destinations: BROWSER_AND_MAC, lock: null, recordLock: true };
}

/** `outcome` with its folders written relative to `root`, so two lanes' outcomes compare. */
function relativeTo(root: string, outcome: BuildOutcome) {
  const rel = (dir: string | null) => (dir === null ? null : path.relative(root, dir));
  return { ...outcome, output: rel(outcome.output), lastGood: rel(outcome.lastGood) };
}

/** What a lane ran, with its root written `<root>`, so two lanes' commands compare. */
function commandsUnder(root: string, calls: RunRequest[]) {
  return calls.map((call) => ({
    ...call,
    command: call.command.replaceAll(root, "<root>"),
    cwd: path.relative(root, call.cwd),
    env: Object.fromEntries(
      Object.entries(call.env ?? {}).map(([key, value]) => [key, value.replaceAll(root, "<root>")]),
    ),
    policy: JSON.parse(JSON.stringify(call.policy ?? null).replaceAll(root, "<root>")) as unknown,
  }));
}

/** A C++ lane stand-in that records every call and answers `outcome`. */
function recordingLane(outcome: BuildOutcome) {
  const calls: Array<{ input: CppBuildInput; signal: AbortSignal | undefined }> = [];
  const counts = { cancelAll: 0, sweep: 0 };
  const cpp = {
    ensure: async (input: CppBuildInput, options: { signal?: AbortSignal } = {}) => {
      calls.push({ input, signal: options.signal });
      return outcome;
    },
    cancelAll: () => {
      counts.cancelAll += 1;
    },
    sweep: async () => {
      counts.sweep += 1;
      return 2;
    },
  };
  return { cpp, calls, counts };
}

const BUILT: BuildOutcome = { ok: true, output: "/builds/out", lastGood: "/builds/out", problem: null, ran: true };

describe("the build-lane seam's raylib lane", () => {
  it("builds a raylib game's web build for Live into the same folder, with the same outcome and commands, as the C++ lane did", async () => {
    const parent = await realpath(await tmpDir("game-build-lane-"));
    const dir = await raylibGame(parent);
    const directRoot = path.join(parent, "cpp-builds-direct");
    const seamRoot = path.join(parent, "cpp-builds-seam");
    const direct = await cppLane(parent, directRoot);
    const behind = await cppLane(parent, seamRoot);
    const lanes = new GameBuildLanes({ [GameStack.RaylibCpp]: raylibLane(behind.builds) });

    // What Live's load asked of the C++ lane before the seam (`previews.ts`).
    const before = await direct.builds.ensure({
      project: "pong",
      dir,
      shape: RAYLIB_SHAPE,
      target: BuildTarget.Web,
      destinations: BROWSER_AND_MAC,
      purpose: CppBuildPurpose.Live,
      lock: null,
      recordLock: true,
    });
    const receipt = await lanes.ensure(liveGame(dir), BuildTarget.Web, CppBuildPurpose.Live);

    assert.equal(receipt.refusal, null);
    assert.equal(receipt.stack, GameStack.RaylibCpp);
    assert.equal(receipt.target, BuildTarget.Web);
    assert.equal(receipt.purpose, CppBuildPurpose.Live);
    const outcome = receipt.outcome;
    assert.ok(outcome, "the raylib lane ran");
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.deepEqual(relativeTo(seamRoot, outcome), relativeTo(directRoot, before));
    assert.equal(outcome.output, path.join(cppBinaryDir(seamRoot, "pong", dir, BuildTarget.Web, LOCK), "out"));
    assert.ok(behind.calls.length > 0, "the lane ran its commands");
    assert.deepEqual(commandsUnder(seamRoot, behind.calls), commandsUnder(directRoot, direct.calls));
  });

  it("hands the C++ lane exactly the input its callers built, with the caller's signal, and answers its outcome as it was", async () => {
    const { cpp, calls } = recordingLane(BUILT);
    const lanes = new GameBuildLanes({ [GameStack.RaylibCpp]: raylibLane(cpp) });
    const controller = new AbortController();
    const game: GameBuildGame = { ...liveGame("/games/pong"), lock: LOCK, recordLock: false };

    const receipt = await lanes.ensure(game, BuildTarget.Mac, CppBuildPurpose.Judging, { signal: controller.signal });

    assert.equal(receipt.outcome, BUILT, "the lane's own outcome, not a copy");
    assert.deepEqual(calls, [
      {
        input: {
          project: "pong",
          dir: "/games/pong",
          shape: RAYLIB_SHAPE,
          target: BuildTarget.Mac,
          destinations: BROWSER_AND_MAC,
          purpose: CppBuildPurpose.Judging,
          lock: LOCK,
          recordLock: false,
        },
        signal: controller.signal,
      },
    ]);
  });

  it("builds with the store's current lock, and records none, when the caller names neither", async () => {
    const { cpp, calls } = recordingLane(BUILT);
    const lanes = new GameBuildLanes({ [GameStack.RaylibCpp]: raylibLane(cpp) });
    await lanes.ensure(
      { project: "pong", dir: "/games/pong", shape: RAYLIB_SHAPE, destinations: BROWSER_AND_MAC },
      BuildTarget.Web,
      CppBuildPurpose.Export,
    );
    assert.equal(calls[0]?.input.lock, null);
    assert.equal(calls[0]?.input.recordLock, undefined);
  });
});

describe("the build-lane seam's dispatch", () => {
  const refused: Array<[string, ProjectShape, GameStack]> = [
    ["a Rust game (until its lane registers)", RUST_SHAPE, GameStack.RustWgpu],
    ["a browser game (GameBuilds builds those)", THREE_SHAPE, GameStack.ThreeJs],
  ];
  for (const [name, shape, stack] of refused) {
    it(`refuses lane-missing for ${name}, typed, before any lane runs or anything is written`, async () => {
      const parent = await realpath(await tmpDir("game-build-refused-"));
      const root = path.join(parent, "cpp-builds");
      const real = await cppLane(parent, root);
      const lanes = new GameBuildLanes({ [GameStack.RaylibCpp]: raylibLane(real.builds) });

      const receipt = await lanes.ensure(
        liveGame(path.join(parent, "game"), shape),
        BuildTarget.Web,
        CppBuildPurpose.Live,
      );

      assert.deepEqual(receipt, {
        stack,
        target: BuildTarget.Web,
        purpose: CppBuildPurpose.Live,
        refusal: GameBuildRefusal.LaneMissing,
        outcome: null,
      });
      assert.equal(GameBuildRefusal.LaneMissing, "lane-missing");
      assert.deepEqual(real.calls, [], "no command ran");
      assert.deepEqual(await readdir(parent), ["store"], "no build folder was made");
    });
  }

  it("dispatches by the stack the game's files make it, not by the stack studio.json records", async () => {
    const raylib = recordingLane(BUILT);
    const lanes = new GameBuildLanes({ [GameStack.RaylibCpp]: raylibLane(raylib.cpp) });
    const recordsThree: GameDestinations = { stack: GameStack.ThreeJs, targets: [BuildTarget.Web] };

    const built = await lanes.ensure(
      { ...liveGame("/games/pong"), destinations: recordsThree },
      BuildTarget.Web,
      CppBuildPurpose.Live,
    );
    const browser = await lanes.ensure(liveGame("/games/site", THREE_SHAPE), BuildTarget.Web, CppBuildPurpose.Live);

    assert.equal(built.refusal, null);
    assert.equal(browser.refusal, GameBuildRefusal.LaneMissing);
    assert.deepEqual(
      raylib.calls.map((call) => call.input.dir),
      ["/games/pong"],
    );
  });

  it("dispatches each stack to its own registered lane", async () => {
    const asked: string[] = [];
    const stand = (name: string): GameBuildLane => ({
      ensure: async (game) => {
        asked.push(`${name}:${game.project}`);
        return BUILT;
      },
      cancelAll: () => {},
      sweep: async () => 0,
    });
    const lanes = new GameBuildLanes({ [GameStack.RaylibCpp]: stand("raylib"), [GameStack.ThreeJs]: stand("three") });
    await lanes.ensure({ ...liveGame("/games/a"), project: "a" }, BuildTarget.Web, CppBuildPurpose.Live);
    await lanes.ensure({ ...liveGame("/games/b", THREE_SHAPE), project: "b" }, BuildTarget.Web, CppBuildPurpose.Live);
    assert.deepEqual(asked, ["raylib:a", "three:b"]);
    assert.notEqual(lanes.laneFor(GameStack.RaylibCpp), null);
  });

  it("stops and sweeps every registered lane, answering how many build folders went in all", async () => {
    const first = recordingLane(BUILT);
    const second = recordingLane(BUILT);
    const lanes = new GameBuildLanes({
      [GameStack.RaylibCpp]: raylibLane(first.cpp),
      [GameStack.ThreeJs]: raylibLane(second.cpp),
    });
    lanes.cancelAll();
    assert.equal(await lanes.sweep(), 4);
    assert.deepEqual(first.counts, { cancelAll: 1, sweep: 1 });
    assert.deepEqual(second.counts, { cancelAll: 1, sweep: 1 });
    assert.equal(new GameBuildLanes({}).laneFor(GameStack.RaylibCpp), null);
    assert.equal(await new GameBuildLanes({}).sweep(), 0);
  });
});

describe("the core's build lanes", () => {
  it("register the core's own C++ lane for raylib games and no lane yet for Rust games", async () => {
    const raylib = recordingLane(BUILT);
    const lanes = coreGameBuilds({ cppBuilds: raylib.cpp });

    const built = await lanes.ensure(liveGame("/games/pong"), BuildTarget.Web, CppBuildPurpose.Live);
    const rust = await lanes.ensure(liveGame("/games/pond", RUST_SHAPE), BuildTarget.Web, CppBuildPurpose.Live);

    assert.equal(built.outcome, BUILT);
    assert.equal(rust.refusal, GameBuildRefusal.LaneMissing);
    assert.deepEqual(
      raylib.calls.map((call) => call.input.dir),
      ["/games/pong"],
    );
  });
});
