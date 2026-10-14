/**
 * The C++ lane for real: the shipped C++ template built by the real CMake, Ninja and emcc from the
 * developer's store (`$GENEX_DEV_TOOLCHAINS/dev-store`, derived by `scripts/toolchains/dev-store.ts`)
 * under the real `ProcessSandbox`, with the network off and the store write-denied.
 *
 * Skipped with `not run: devStore absent` where the store is not there (the CI runners); required
 * under `GENEX_REQUIRE_TOOLCHAINS=1`. The steps run in order on one game. The run's argv,
 * environment, timings and sizes go to `.studio-dev/evidence/raylib-w1-lane/`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BuildProblemCode, DiagnosticTool, type BuildDiagnostic } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind, type ProjectShape } from "../../src/shared/game-project.ts";
import {
  MAC_ANGLE_IMPORTS,
  MAC_GAME_RPATH,
  MAC_MINIMUM_SYSTEM_VERSION,
  NATIVE_MAC_EXECUTABLES,
  NativeRunMode,
} from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { CppBuildPurpose, CppBuilds, type CppBuildInput } from "../../src/main/cpp-build.ts";
import type { BuildOutcome } from "../../src/main/game-build.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { locateToolchain, type LocateResult } from "../../src/substrate/toolchain-store/locate.ts";
import { DEV_TOOLCHAINS, devStoreLock, devTool, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-w1-lane");
/** A real emcc build of the template, configure included, on a cold build folder. */
const REAL_BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
/** What genex.cmake may leave in `out/`: the page, its glue, its module and its preloaded assets. */
const SERVED_FILES = new Set(["index.html", "index.js", "index.wasm", "index.data"]);
/** Bytes an asset of the game's own carries, which index.data must hold. */
const PUBLIC_ASSET = "GENEX_PUBLIC_ASSET_7c1e";
/** Bytes a dotfile in assets/ and a file outside the game carry, which index.data must never hold. */
const ENV_SECRET = "GENEX_ENV_SECRET_9f2a";
const OUTSIDE_SECRET = "GENEX_OUTSIDE_SECRET_3ad0";
/** An asset's bytes before and after it is replaced, and a second asset that is then removed. */
const LEVEL_OLD = "GENEX_LEVEL_ONE_OLD_51c3";
const LEVEL_NEW = "GENEX_LEVEL_TWO_NEW_AND_LONGER_51c3";
const OTHER_ASSET = "GENEX_OTHER_ASSET_e08d";
/** Matches what a fetch, a port or a download prints in a build's log. */
const FETCH_TRACE = /\bports?\b|embuilder|https?:\/\/|\bfetch(?:ing)?\b|\bdownload/i;
/** The Mac rows' evidence, beside the web rows'. */
const MAC_EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-W2-MAC-LANE");
/** GLFW's EGL library name in the windowed raylib, which the window's game carries as a C string. */
const GLFW_EGL_NAME = "@executable_path/../Frameworks/libEGL.dylib";
/** A line the template's own code never has, so the error is ours. */
const FORCED_ERROR = "int genex_lane_forced_error = genex_undeclared_identifier;";

const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};

/** Every entry under `dir` (links not followed) with its size, mtime and mode: a store that was written differs. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const rel of await readdir(dir, { recursive: true })) {
    const info = await lstat(path.join(dir, rel));
    found.set(rel, `${info.size}:${info.mtimeMs}:${info.mode}`);
  }
  return found;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

async function timed(work: () => Promise<BuildOutcome>): Promise<{ outcome: BuildOutcome; ms: number }> {
  const started = performance.now();
  const outcome = await work();
  return { outcome, ms: Math.round(performance.now() - started) };
}

async function sizes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await readdir(dir)) out[name] = (await stat(path.join(dir, name))).size;
  return out;
}

/** Everything the steps share: the store, the game, the sandbox, the lane and what they recorded. */
interface RealLane {
  store: string;
  lock: ToolchainLock;
  located: LocateResult;
  root: string;
  game: string;
  sandbox: ProcessSandbox;
  builds: CppBuilds;
  runs: Array<{ request: RunRequest; result: RunResult }>;
  writtenLocks: Array<[string, string]>;
  storeBefore: Map<string, string>;
  emsdk: { dir: string; before: Map<string, string> } | null;
  timings: Record<string, number>;
  out: string;
  diagnostic: BuildDiagnostic | null;
}

async function setUp(target: BuildTarget = BuildTarget.Web): Promise<RealLane> {
  const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
  const toolchains = await realpath(DEV_TOOLCHAINS);
  const lock = await devStoreLock();
  assert.ok(lock, "the dev store has a current lock");
  const located = await locateToolchain(store, lock, [target]);
  assert.equal(located.ok, true, JSON.stringify(located));
  const root = await realpath(await tmpDir("cpp-lane-real-"));
  const layout = layoutFor(path.join(root, "userData"));
  const game = path.join(root, "games", "pong");
  await cp(TEMPLATE, game, { recursive: true });
  const emsdkTool = devTool("emsdk");
  const emsdkDir = "path" in emsdkTool ? await realpath(emsdkTool.path) : null;
  const sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: layout.scratch,
    secretPaths: [],
    denyWrite: [...studioBaseDenyWrites(layout, [game]), store, toolchains],
  });
  const runs: RealLane["runs"] = [];
  const writtenLocks: RealLane["writtenLocks"] = [];
  const builds = new CppBuilds({
    root: layout.cppBuilds,
    run: async (request) => {
      const result = await sandbox.run(request);
      runs.push({ request, result });
      return result;
    },
    locate: (wanted, targets) => locateToolchain(store, wanted, targets),
    currentLock: () => devStoreLock(),
    emit: () => {},
    platform: process.platform,
    cores: os.availableParallelism(),
    denyWrite: [store, toolchains, layout.nativeRuns],
    writeLock: async (project, digest) => {
      writtenLocks.push([project, digest]);
    },
  });
  return {
    store,
    lock,
    located,
    root,
    game,
    sandbox,
    builds,
    runs,
    writtenLocks,
    storeBefore: await snapshot(store),
    emsdk: emsdkDir ? { dir: emsdkDir, before: await snapshot(emsdkDir) } : null,
    timings: {},
    out: "",
    diagnostic: null,
  };
}

/** A build of `dir`; the game folder's own records its lock, a worker's never does. */
function input(dir: string, recordLock = true, target: BuildTarget = BuildTarget.Web): CppBuildInput {
  return {
    project: "pong",
    dir,
    shape: RAYLIB_SHAPE,
    target,
    destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] },
    purpose: CppBuildPurpose.Live,
    lock: null,
    recordLock,
  };
}

async function writeEvidence(lane: RealLane): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  const evidence = {
    at: new Date().toISOString(),
    lock: lane.lock,
    located: lane.located.ok ? lane.located.toolchain : lane.located,
    argv: lane.runs.map(({ request }) => request.command),
    env: lane.runs[0]?.request.env ?? null,
    policy: lane.runs[0]?.request.policy ?? null,
    sandboxed: lane.runs.map(({ result }) => result.sandboxed),
    timingsMs: lane.timings,
    runMs: lane.runs.map(({ request, result }) => ({
      step: request.command.includes("'--build'") ? "build" : "configure",
      code: result.code,
      ms: result.durationMs,
    })),
    outSizes: lane.out ? await sizes(lane.out) : null,
    diagnostic: lane.diagnostic,
    storeEntries: lane.storeBefore.size,
  };
  await writeFile(path.join(EVIDENCE, "lane-real.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

describe("the C++ lane, for real", { ...needsTools("devStore", "emsdk"), timeout: REAL_BUILD_TIMEOUT_MS }, () => {
  let lane: RealLane;
  before(async () => {
    lane = await setUp();
  });
  after(async () => {
    if (!lane) return;
    await writeEvidence(lane);
    await lane.sandbox.dispose();
  });

  it("builds the template cold, under the sandbox, into out/ with nothing of CMake's there", async () => {
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game)));
    lane.timings.cold = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    lane.out = outcome.output ?? "";
    const served = await readdir(lane.out);
    for (const name of ["index.html", "index.js", "index.wasm"]) assert.ok(served.includes(name), name);
    assert.deepEqual(
      served.filter((name) => !SERVED_FILES.has(name)),
      [],
      "out/ holds only what is served",
    );
    assert.ok(
      lane.runs.every(({ result }) => result.sandboxed),
      "every run was sandboxed",
    );
    assert.deepEqual(lane.writtenLocks, [["pong", lane.lock.digest]]);
  });

  it("finds no work when nothing changed", async () => {
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game)));
    lane.timings.noWork = ms;
    assert.equal(outcome.ok, true);
    assert.match(lane.runs.at(-1)?.result.stdout ?? "", /ninja: no work to do/);
  });

  it("rebuilds after an edit to src/main.cpp", async () => {
    const main = path.join(lane.game, "src", "main.cpp");
    const wasmBefore = (await stat(path.join(lane.out, "index.wasm"))).mtimeMs;
    await writeFile(main, `${await readFile(main, "utf8")}\n// an edit\n`);
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game)));
    lane.timings.editedMain = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    assert.match(lane.runs.at(-1)?.result.stdout ?? "", /main\.cpp/);
    assert.ok((await stat(path.join(lane.out, "index.wasm"))).mtimeMs > wasmBefore, "index.wasm was relinked");
  });

  it("says where a real compile error is: clang's file, line and message", async () => {
    const main = path.join(lane.game, "src", "main.cpp");
    const source = await readFile(main, "utf8");
    const lines = source.split("\n");
    await writeFile(main, [...lines, FORCED_ERROR, ""].join("\n"));
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game)));
    lane.timings.compileError = ms;
    await writeFile(main, source);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.lastGood, lane.out, "the live stage keeps the build that worked");
    const [diagnostic] = outcome.problem?.diagnostics ?? [];
    lane.diagnostic = diagnostic ?? null;
    assert.equal(diagnostic?.tool, DiagnosticTool.Clang);
    assert.equal(diagnostic?.file, "src/main.cpp");
    assert.equal(diagnostic?.line, lines.length + 1);
    assert.match(diagnostic?.message ?? "", /genex_undeclared_identifier/);
  });

  it("seeds a worker's first build folder from the lead's, and builds it", async () => {
    const worker = path.join(lane.root, "games", "pong-worker");
    await cp(lane.game, worker, { recursive: true });
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(worker, false)));
    lane.timings.seededWorker = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    const workerBin = path.dirname(outcome.output ?? "");
    assert.equal((await readFile(path.join(workerBin, ".seeded-from"), "utf8")).trim(), path.dirname(lane.out));
  });

  it("packs the game's own assets into index.data, never a dotfile, and fails on a link out of the game", async () => {
    const assets = path.join(lane.game, "assets");
    await writeFile(path.join(assets, "genex-public.txt"), PUBLIC_ASSET);
    await writeFile(path.join(assets, ".env"), ENV_SECRET);
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game)));
    lane.timings.assets = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    const packed = await readFile(path.join(lane.out, "index.data"));
    assert.ok(packed.includes(PUBLIC_ASSET), "the game's own asset is packed");
    assert.ok(!packed.includes(ENV_SECRET), "assets/.env is never packed");
    const outside = path.join(lane.root, "outside-secret.txt");
    await writeFile(outside, OUTSIDE_SECRET);
    await symlink(outside, path.join(assets, "linked.txt"));
    const linked = await lane.builds.ensure(input(lane.game));
    await rm(path.join(assets, "linked.txt"));
    assert.equal(linked.ok, false);
    assert.match(linked.problem?.lines.join("\n") ?? "", /is a link/);
    assert.equal(linked.lastGood, lane.out, "the live stage keeps the build that worked");
    assert.ok(!(await readFile(path.join(lane.out, "index.data"))).includes(OUTSIDE_SECRET));
  });

  it("repacks an asset replaced by one with an older time, and drops a removed one from index.data", async () => {
    const assets = path.join(lane.game, "assets");
    const level = path.join(assets, "genex-level.txt");
    const other = path.join(assets, "genex-other.txt");
    await writeFile(level, LEVEL_OLD);
    await writeFile(other, OTHER_ASSET);
    const first = await lane.builds.ensure(input(lane.game));
    assert.equal(first.ok, true, JSON.stringify(first.problem, null, 2));
    assert.ok((await readFile(path.join(lane.out, "index.data"))).includes(LEVEL_OLD));
    // As unzip, tar x, cp -p or rsync -t leave it: new bytes, an older time.
    const was = await stat(level);
    await rm(level);
    await writeFile(level, LEVEL_NEW);
    await utimes(level, was.atime, new Date(was.mtimeMs - MINUTE_MS));
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(lane.game)));
    lane.timings.replacedAsset = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    const replaced = await readFile(path.join(lane.out, "index.data"));
    assert.ok(replaced.includes(LEVEL_NEW), "the replacement is packed");
    assert.ok(!replaced.includes(LEVEL_OLD), "the old bytes are gone");
    await rm(other);
    const removed = await lane.builds.ensure(input(lane.game));
    assert.equal(removed.ok, true, JSON.stringify(removed.problem, null, 2));
    const repacked = await readFile(path.join(lane.out, "index.data"));
    assert.ok(!repacked.includes(OTHER_ASSET), "a removed asset is no longer packed");
    assert.ok(repacked.includes(LEVEL_NEW));
  });

  it("leaves no index.data in out/ once the game's last asset is gone", async () => {
    await rm(path.join(lane.game, "assets"), { recursive: true, force: true });
    const outcome = await lane.builds.ensure(input(lane.game));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    assert.equal(
      await lstat(path.join(lane.out, "index.data")).catch(() => null),
      null,
      "nothing stale to serve or export",
    );
    assert.ok(!(await readFile(path.join(lane.out, "index.js"), "utf8")).includes("index.data"), "the page loads none");
  });

  it("wrote nothing under the store, nor under the emsdk it was made from", async () => {
    assert.deepEqual(changed(lane.storeBefore, await snapshot(lane.store)), [], "the dev store is unchanged");
    if (lane.emsdk) {
      assert.deepEqual(changed(lane.emsdk.before, await snapshot(lane.emsdk.dir)), [], "the cached emsdk is unchanged");
    }
  });
});

/** `xcrun <tool> <args>`'s output: Apple's binary tools, reached only through xcrun. */
async function xcrun(tool: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/xcrun", [tool, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The `LC_RPATH` paths of a Mach-O, in file order, from `otool -l`. */
function rpaths(loadCommands: string): string[] {
  return [...loadCommands.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (\S+)/g)].map((match) => match[1] ?? "");
}

/** The `minos` of a Mach-O's `LC_BUILD_VERSION`, from `otool -l`. */
function minos(loadCommands: string): string | null {
  return /cmd LC_BUILD_VERSION[\s\S]*?minos (\S+)/.exec(loadCommands)?.[1] ?? null;
}

const MAC_HOST =
  process.platform === "darwin" && process.arch === "arm64"
    ? {}
    : { skip: "not run: Mac builds need an Apple silicon Mac" };

describe("the C++ lane for the Mac, for real", {
  ...needsTools("devStore"),
  ...MAC_HOST,
  ...(process.platform === "darwin" ? needsPrewarmed(BuildTarget.Mac) : {}),
  timeout: REAL_BUILD_TIMEOUT_MS,
}, () => {
  let lane: RealLane;
  const macInput = (dir: string) => input(dir, true, BuildTarget.Mac);
  before(async () => {
    lane = await setUp(BuildTarget.Mac);
  });
  after(async () => {
    if (!lane) return;
    await mkdir(MAC_EVIDENCE, { recursive: true });
    const logs = lane.runs.map(({ request, result }) => `$ ${request.command}\n${result.stdout}\n${result.stderr}`);
    await writeFile(
      path.join(MAC_EVIDENCE, "mac-lane-real.log"),
      `${JSON.stringify(lane.timings)}\n${logs.join("\n---\n")}\n`,
    );
    await lane.sandbox.dispose();
  });

  it("builds the template for the Mac under the sandbox: out/ holds exactly game, game-headless and assets/", async () => {
    await writeFile(path.join(lane.game, "assets", "genex-public.txt"), PUBLIC_ASSET);
    await writeFile(path.join(lane.game, "assets", ".env"), ENV_SECRET);
    const { outcome, ms } = await timed(() => lane.builds.ensure(macInput(lane.game)));
    lane.timings.macCold = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    lane.out = outcome.output ?? "";
    assert.deepEqual((await readdir(lane.out)).sort(), ["assets", "game", "game-headless"]);
    assert.ok(
      lane.runs.every(({ result }) => result.sandboxed),
      "every run was sandboxed",
    );
    assert.equal(await readFile(path.join(lane.out, "assets", "genex-public.txt"), "utf8"), PUBLIC_ASSET);
    assert.equal(await lstat(path.join(lane.out, "assets", ".env")).catch(() => null), null, "assets/.env never lands");
    assert.ok((await lstat(path.join(lane.out, "assets", "genex-public.txt"))).isFile(), "a regular file, not a link");
  });

  it("imports both ANGLE libraries and no OpenGL, carries one rpath, and is thin arm64 at the deployment target", async () => {
    const seen: string[] = [];
    for (const name of Object.values(NATIVE_MAC_EXECUTABLES)) {
      const exe = path.join(lane.out, name);
      const imports = await xcrun("otool", "-L", exe);
      seen.push(`$ otool -L ${name}\n${imports}`, `$ lipo -archs ${name}\n${await xcrun("lipo", "-archs", exe)}`);
      for (const library of MAC_ANGLE_IMPORTS) assert.ok(imports.includes(library), `${name} imports ${library}`);
      assert.doesNotMatch(imports, /OpenGL\.framework/, `${name} imports no OpenGL`);
      const commands = await xcrun("otool", "-l", exe);
      assert.deepEqual(rpaths(commands), [MAC_GAME_RPATH], `${name} carries exactly one LC_RPATH`);
      assert.equal((await xcrun("lipo", "-archs", exe)).trim(), "arm64", `${name} is thin arm64`);
      const min = minos(commands);
      seen.push(`${name}: LC_RPATH ${JSON.stringify(rpaths(commands))}, minos ${min}`);
      assert.ok(min && Number.parseFloat(min) >= Number.parseFloat(MAC_MINIMUM_SYSTEM_VERSION), `${name} minos ${min}`);
    }
    await mkdir(MAC_EVIDENCE, { recursive: true });
    await writeFile(path.join(MAC_EVIDENCE, "mac-binaries.txt"), `${seen.join("\n")}\n`);
    const window = await readFile(path.join(lane.out, NATIVE_MAC_EXECUTABLES[NativeRunMode.Window]));
    assert.ok(window.includes(GLFW_EGL_NAME), "GLFW loads EGL from the bundle's Frameworks");
    assert.doesNotMatch(await xcrun("otool", "-L", path.join(lane.out, "game-headless")), /AppKit|Cocoa/);
  });

  it("rebuilds after an edit to src/main.cpp", async () => {
    const main = path.join(lane.game, "src", "main.cpp");
    const before = (await stat(path.join(lane.out, "game"))).mtimeMs;
    await writeFile(main, `${await readFile(main, "utf8")}\n// a Mac edit\n`);
    const { outcome, ms } = await timed(() => lane.builds.ensure(macInput(lane.game)));
    lane.timings.macEdited = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    assert.ok((await stat(path.join(lane.out, "game"))).mtimeMs > before, "out/game was relinked");
  });

  it("says where a real compile error is and keeps the last build that worked", async () => {
    const main = path.join(lane.game, "src", "main.cpp");
    const source = await readFile(main, "utf8");
    const lines = source.split("\n");
    await writeFile(main, [...lines, FORCED_ERROR, ""].join("\n"));
    const { outcome, ms } = await timed(() => lane.builds.ensure(macInput(lane.game)));
    lane.timings.macCompileError = ms;
    await writeFile(main, source);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.lastGood, lane.out);
    const [diagnostic] = outcome.problem?.diagnostics ?? [];
    assert.equal(diagnostic?.tool, DiagnosticTool.Clang);
    assert.equal(diagnostic?.file, "src/main.cpp");
    assert.equal(diagnostic?.line, lines.length + 1);
    assert.match(diagnostic?.message ?? "", /genex_undeclared_identifier/);
  });

  it("seeds a worker's Mac build from the lead's, assets included", async () => {
    const worker = path.join(lane.root, "games", "pong-mac-worker");
    await cp(lane.game, worker, { recursive: true });
    const { outcome, ms } = await timed(() => lane.builds.ensure(input(worker, false, BuildTarget.Mac)));
    lane.timings.macSeededWorker = ms;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    const workerOut = outcome.output ?? "";
    assert.equal(
      (await readFile(path.join(path.dirname(workerOut), ".seeded-from"), "utf8")).trim(),
      path.dirname(lane.out),
    );
    assert.equal(await readFile(path.join(workerOut, "assets", "genex-public.txt"), "utf8"), PUBLIC_ASSET);
  });

  it("copies the assets again when out/assets is gone, and drops a removed asset from it", async () => {
    await rm(path.join(lane.out, "assets"), { recursive: true });
    const again = await lane.builds.ensure(macInput(lane.game));
    assert.equal(again.ok, true, JSON.stringify(again.problem, null, 2));
    assert.equal(await readFile(path.join(lane.out, "assets", "genex-public.txt"), "utf8"), PUBLIC_ASSET);
    await rm(path.join(lane.game, "assets", "genex-public.txt"));
    const outcome = await lane.builds.ensure(macInput(lane.game));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem, null, 2));
    assert.equal(await lstat(path.join(lane.out, "assets", "genex-public.txt")).catch(() => null), null);
  });

  it("fetched nothing and wrote nothing under the store", async () => {
    const hits = lane.runs.flatMap(({ result }) =>
      `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => FETCH_TRACE.test(line)),
    );
    assert.deepEqual(hits, [], "no fetch, port or download in any log");
    assert.deepEqual(changed(lane.storeBefore, await snapshot(lane.store)), [], "the dev store is unchanged");
  });
});
