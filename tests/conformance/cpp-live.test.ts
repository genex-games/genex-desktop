/**
 * A C++ · raylib game in Live: the preview load serves the build lane's own `out/` (never the
 * folder, never an in-tree `build/`), with no loopback origin and without the studio's `three`
 * import map, which an Emscripten page has no use for. The Live slot of a game with no browser
 * destination loads nothing and says why, while a judged load still builds the web for the judges.
 * Playing a snapshot builds the snapshot's worktree the same way. A Three.js game's load does not change.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { describe, it, mock } from "node:test";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { LivePrepare } from "../../src/shared/live-behind.ts";
import { PreviewIdentityState } from "../../src/main/core/internals.ts";
import {
  BuildTarget,
  GameStack,
  ProjectKind,
  type GameDestinations,
  type GameProject,
} from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { CppBuildPurpose, CppBuilds, type CppBuildInput } from "../../src/main/cpp-build.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const LOCK: ToolchainLock = { version: 1, entries: {}, digest: "fedcba9876543210".repeat(4) };

/** One load a port was asked for, with its options as given. */
interface Load {
  project: string;
  entry: string;
  root: string | null;
  options: { loopback?: boolean; insertMap?: boolean } | undefined;
}

/** A preview port that records what it served and answers the ready probe as a settled page. */
function fakePort() {
  const port = {
    loads: [] as Load[],
    notes: [] as string[],
    async load(project: string, entry: string, root?: string, options?: Load["options"]) {
      port.loads.push({ project, entry, root: root ?? null, options });
      return `game://${project}/${entry}`;
    },
    note(_level: string, message: string) {
      port.notes.push(message);
    },
    async reload() {},
    async input() {},
    status: () => ({ project: port.loads.at(-1)?.project ?? null, loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
    async dispose() {},
  };
  return port;
}
type FakePort = ReturnType<typeof fakePort>;

/** A sandbox stand-in for CMake and Ninja: the build writes the page, its glue and its module, or fails. */
function fakeRun(fails: boolean) {
  const calls: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    const building = request.command.includes(" '--build' ");
    if (building && fails) {
      return {
        code: 1,
        signal: null,
        stdout: "src/main.cpp:3:1: error: expected ';'\n",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
        sandboxed: false,
        command: request.command,
        cwd: request.cwd,
      };
    }
    if (building) {
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

interface Stage {
  lite: CoreLite;
  live: FakePort;
  standIn: FakePort[];
  runs: RunRequest[];
  ensured: CppBuildInput[];
}

/** A lite core whose lane builds with a fake store and a fake sandbox (whose builds fail when `failing`). */
async function stage({ failing = false }: { failing?: boolean } = {}): Promise<Stage> {
  const live = fakePort();
  const standIn: FakePort[] = [];
  const lite = await coreLite({
    preview: live as never,
    gamesRoot: await realpath(await tmpDir("cpp-live-games-")),
    previewPoolMax: 2,
    createHeadlessPreview: async () => {
      const port = fakePort();
      standIn.push(port);
      return port as never;
    },
  });
  const store = await realpath(await tmpDir("cpp-live-store-"));
  const cache = path.join(store, "locks", "fedcba987654", "em-cache");
  await mkdir(cache, { recursive: true });
  const runner = fakeRun(failing);
  const ensured: CppBuildInput[] = [];
  const builds = new CppBuilds({
    root: lite.core.layout.cppBuilds,
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
  });
  const ensure = builds.ensure.bind(builds);
  mock.method(builds, "ensure", (input: CppBuildInput, options?: { signal?: AbortSignal }) => {
    ensured.push(input);
    return ensure(input, options);
  });
  lite.core.cppBuilds = builds;
  return { lite, live, standIn, runs: runner.calls, ensured };
}

/** A raylib game in the games folder, listed with `destinations` (the library's own detection is `project-shape.ts`'s). */
async function raylibGame(
  lite: CoreLite,
  destinations: GameDestinations,
  declared: Pick<GameProject, "mouseLook"> = {},
): Promise<string> {
  const dir = path.join(lite.gamesRoot, "pong");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "CMakeLists.txt"), `include("\${GENEX_CMAKE}")\ngenex_add_game(SOURCES src/*.cpp)\n`);
  await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 0; }\n");
  // An in-tree build the agent made: never what Live shows.
  await mkdir(path.join(dir, "build", "web"), { recursive: true });
  await writeFile(path.join(dir, "build", "web", "index.html"), "a stale in-tree build");
  const game: GameProject = {
    name: "pong",
    dir,
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
      kind: ProjectKind.RaylibCpp,
      serve: ".",
    },
    built: false,
    destinations,
    ...declared,
  };
  mock.method(lite.core.games, "list", async () => [game]);
  return dir;
}

const BROWSER_AND_MAC: GameDestinations = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] };
const MAC_ONLY: GameDestinations = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Mac] };

describe("a C++ game in Live", () => {
  it("loads the lane's index.html with no loopback and no studio import map", async () => {
    const { lite, live, runs, ensured } = await stage();
    await raylibGame(lite, BROWSER_AND_MAC);
    await lite.core.loadPreview({ project: "pong" });
    assert.equal(live.loads.length, 1);
    const [load] = live.loads;
    assert.equal(load?.entry, "index.html");
    assert.ok(load?.root?.startsWith(lite.core.layout.cppBuilds), load?.root ?? "");
    assert.equal(path.basename(load?.root ?? ""), "out");
    assert.equal(load?.options?.loopback, false);
    assert.equal(load?.options?.insertMap, false);
    assert.equal(runs.length, 2, "configured and built");
    assert.deepEqual(
      ensured.map((input) => [input.target, input.purpose, input.lock, input.recordLock]),
      [[BuildTarget.Web, CppBuildPurpose.Live, null, true]],
    );
    assert.equal(lite.core.buildProblem("pong"), null);
  });

  it("ends the strip's Loading in the Live slot of a Mac-only game, and nothing waits for a Reload with nothing to show", async () => {
    const { lite } = await stage();
    const dir = await raylibGame(lite, MAC_ONLY);
    await lite.core.loadPreview({ project: "pong" });
    await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 1; }\n");
    await lite.core.offerLive({ project: "pong", root: null, note: null });
    assert.notEqual(lite.core.liveState("pong").reason, null, "the change waits for Reload");
    await lite.core.loadPreview({ project: "pong" });
    const identity = lite.core.runPreviewIdentity();
    assert.equal(identity.project, "pong");
    assert.notEqual(identity.state, PreviewIdentityState.Loading);
    assert.equal(lite.core.liveState("pong").reason, null);
  });

  it("puts the strip on failed, not loading, when the first build fails with nothing to fall back on", async () => {
    const { lite, live } = await stage({ failing: true });
    await raylibGame(lite, BROWSER_AND_MAC);
    await lite.core.loadPreview({ project: "pong" });
    assert.deepEqual(live.loads, []);
    const identity = lite.core.runPreviewIdentity();
    assert.equal(identity.state, PreviewIdentityState.Failed);
    assert.ok(identity.error, "the strip says why");
    assert.equal(lite.core.buildProblem("pong")?.reason, BuildProblemCode.CommandFailed);
  });

  it("loads nothing in the Live slot of a Mac-only game and says it is not a destination; a judged load still builds the web", async () => {
    const { lite, live, standIn, ensured } = await stage();
    await raylibGame(lite, MAC_ONLY);
    await lite.core.loadPreview({ project: "pong" });
    assert.deepEqual(live.loads, []);
    assert.equal(ensured.length, 0, "nothing was built for the Live slot");
    const problem = lite.core.buildProblem("pong");
    assert.equal(problem?.reason, BuildProblemCode.NotADestination);
    assert.equal(problem?.target, BuildTarget.Web);
    assert.equal(live.notes.length, 1, "the game's console says why the slot is empty");
    // The harness looks through its stand-in, and judges a judging-only web build.
    await lite.api()["preview.load"]({ project: "pong" });
    assert.deepEqual(
      ensured.map((input) => [input.target, input.purpose]),
      [[BuildTarget.Web, CppBuildPurpose.Judging]],
    );
    const judged = standIn[0]?.loads.at(-1);
    assert.equal(path.basename(judged?.root ?? ""), "out");
    assert.equal(judged?.options?.insertMap, false);
  });
});

describe("a compiled game played with mouse look (studio.json game.mouseLook)", () => {
  it("opens Live's page and a played snapshot asking for mouse look, and a judged page without it", async () => {
    const { lite, live, standIn } = await stage();
    await raylibGame(lite, BROWSER_AND_MAC, { mouseLook: true });
    await lite.core.loadPreview({ project: "pong" });
    assert.equal(live.loads.at(-1)?.entry, "index.html?mouseLook", "Live's page takes the pointer lock on a click");
    const v1 = await lite.core.snapshot("game", "v1", "pong");
    await lite.core.playGameSnapshot(v1.snapshot_id, "pong");
    assert.equal(live.loads.at(-1)?.entry, "index.html?mouseLook", "a played snapshot is Live's too");
    await lite.api()["preview.load"]({ project: "pong" });
    assert.equal(standIn[0]?.loads.at(-1)?.entry, "index.html", "the judges drive look through the input verb");
  });

  it("opens Live's page of a game without mouse look as it always did: drag to look, the cursor free", async () => {
    const { lite, live } = await stage();
    await raylibGame(lite, BROWSER_AND_MAC);
    await lite.core.loadPreview({ project: "pong" });
    assert.equal(live.loads.at(-1)?.entry, "index.html");
  });
});

describe("Play of a C++ game's snapshot", () => {
  it("builds the snapshot's worktree with the lane and serves its out/, never recording the lock", async () => {
    const { lite, live, ensured } = await stage();
    const dir = await raylibGame(lite, BROWSER_AND_MAC);
    const v1 = await lite.core.snapshot("game", "v1", "pong");
    await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 2; }\n");
    const played = await lite.core.playGameSnapshot(v1.snapshot_id, "pong");
    const load = live.loads.at(-1);
    assert.equal(load?.entry, "index.html");
    assert.ok(load?.root?.startsWith(lite.core.layout.cppBuilds), load?.root ?? "");
    assert.equal(path.basename(load?.root ?? ""), "out");
    assert.equal(load?.options?.insertMap, false);
    assert.equal(load?.options?.loopback, false);
    const built = ensured.at(-1);
    assert.equal(built?.dir, played.dir);
    assert.equal(built?.purpose, CppBuildPurpose.Live);
    assert.notEqual(built?.recordLock, true, "a snapshot's build never writes the person's studio.json");
  });

  it("refuses to play a snapshot of a game not made for the browser in Live, and builds nothing", async () => {
    const { lite, live, ensured } = await stage();
    await raylibGame(lite, MAC_ONLY);
    const v1 = await lite.core.snapshot("game", "v1", "pong");
    await assert.rejects(lite.core.playGameSnapshot(v1.snapshot_id, "pong"), /not made for the browser/);
    assert.deepEqual(live.loads, []);
    assert.deepEqual(ensured, []);
  });
});

describe("Live's background build after the game folder changed", () => {
  it("builds the folder for the web view through Live's own lane and purpose, and leaves Live as it is", async () => {
    const { lite, live, ensured } = await stage();
    const dir = await raylibGame(lite, BROWSER_AND_MAC);
    await lite.core.loadPreview({ project: "pong" });
    const loads = live.loads.length;
    assert.equal(await lite.core.prepareLiveBuild("pong", BuildTarget.Web), LivePrepare.Built);
    const asked = ensured.at(-1);
    assert.equal(asked?.target, BuildTarget.Web);
    assert.equal(asked?.purpose, CppBuildPurpose.Live);
    assert.equal(asked?.dir, dir, "the game folder itself, as Reload builds it");
    assert.equal(live.loads.length, loads, "nothing reaches Live: the person's Update does");
  });

  it("builds the Mac version for the Native view the way its embedded run does", async () => {
    const { lite, live, ensured } = await stage();
    const dir = await raylibGame(lite, BROWSER_AND_MAC);
    await lite.core.loadPreview({ project: "pong" });
    const loads = live.loads.length;
    await lite.core.prepareLiveBuild("pong", BuildTarget.Mac);
    const asked = ensured.at(-1);
    assert.equal(asked?.target, BuildTarget.Mac);
    assert.equal(asked?.purpose, CppBuildPurpose.Live);
    assert.equal(asked?.dir, dir);
    assert.equal(asked?.recordLock, true);
    assert.equal(live.loads.length, loads);
  });

  it("says a failed build, so the stage keeps the earlier version and offers Try again", async () => {
    const { lite } = await stage();
    await raylibGame(lite, BROWSER_AND_MAC);
    await lite.core.loadPreview({ project: "pong" });
    const problem = { code: BuildProblemCode.CommandFailed, target: BuildTarget.Web, lines: [], at: "" };
    mock.method(lite.core.cppBuilds, "ensure", async () => ({
      ok: false,
      output: null,
      lastGood: null,
      problem,
      ran: true,
    }));
    assert.equal(await lite.core.prepareLiveBuild("pong", BuildTarget.Web), LivePrepare.Failed);
  });

  it("builds nothing for a game Live does not show, a destination it lacks, or a Three.js game", async () => {
    const { lite, ensured } = await stage();
    await raylibGame(lite, MAC_ONLY);
    assert.equal(await lite.core.prepareLiveBuild("pong", BuildTarget.Mac), LivePrepare.Skipped, "Live holds nothing");
    await lite.core.loadPreview({ project: "pong" });
    const before = ensured.length;
    assert.equal(await lite.core.prepareLiveBuild("pong", BuildTarget.Web), LivePrepare.Skipped, "not a destination");
    assert.equal(await lite.core.prepareLiveBuild("tetris", BuildTarget.Web), LivePrepare.Skipped, "another game");
    assert.equal(ensured.length, before);
  });
});

describe("a Three.js game in Live", () => {
  it("loads as before: the folder itself, no loopback, the studio's import map allowed, no C++ build", async () => {
    const { lite, live, ensured, runs } = await stage();
    await lite.core.games.scaffold("tetris");
    await lite.core.loadPreview({ project: "tetris" });
    assert.equal(live.loads.length, 1);
    const [load] = live.loads;
    assert.equal(load?.project, "tetris");
    assert.equal(load?.entry, "index.html");
    assert.equal(load?.root, null);
    assert.equal(load?.options?.loopback, false);
    assert.notEqual(load?.options?.insertMap, false);
    assert.equal(ensured.length, 0);
    assert.equal(runs.length, 0);
  });
});

describe("the lane's build folders", () => {
  it("are the host's own: outside every folder an agent process may write", async () => {
    const lite = await coreLite();
    const root = lite.core.cppBuilds.options.root;
    assert.equal(root, lite.core.layout.cppBuilds);
    for (const writable of lite.core.sandbox.policy.allowWrite)
      assert.ok(!isInside(writable, root), `${root} is inside the writable ${writable}`);
    assert.ok(!isInside(lite.core.layout.scratch, root), "not in the agents' scratch");
  });

  it("are swept after a worktree is removed: a folder whose source is gone goes, a live game's stays", async () => {
    // The dev execution policy compares canonical paths, and the temp folder is behind /var → /private/var.
    const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("studio-games-")) });
    const { core } = lite;
    await core.games.scaffold("pong");
    await core.api()["snapshot.worktree"]!({ project: "pong", name: "w", runId: "run-sweep" });
    const root = core.cppBuilds.options.root;
    const gone = path.join(root, `pong-${"a".repeat(12)}`, `web-${"b".repeat(12)}`);
    const live = path.join(root, `pong-${"c".repeat(12)}`, `web-${"d".repeat(12)}`);
    for (const bin of [gone, live]) await mkdir(path.join(bin, "em-cache"), { recursive: true });
    await writeFile(`${gone}.source`, path.join(core.layout.scratch, "autopilot", "run-gone", "pong"));
    await writeFile(`${live}.source`, core.games.dirFor("pong"));
    const worktree = path.join(core.layout.scratch, "autopilot", "run-sweep", "w");
    await core.snapshots.removeWorktree("pong", worktree);
    const deadline = Date.now() + 10_000;
    while ((await exists(path.dirname(gone))) && Date.now() < deadline) await sleep(10);
    assert.equal(await exists(path.dirname(gone)), false, "the removed source's folder went");
    assert.equal(await exists(live), true, "the game's own folder stayed");
    await lite.close();
  });
});

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}
