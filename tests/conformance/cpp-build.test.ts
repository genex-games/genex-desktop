/**
 * The C++ build lane (`CppBuilds`): a raylib game built out of source, per destination and lock,
 * with the host's own argv and environment, the source root write-denied, typed refusals before
 * anything runs, parsed diagnostics, a Stop that leaves no process behind, and no host write or
 * serve through a link planted in the build root.
 *
 * The runner here is a fake that records every `RunRequest`; the quoting rows hand the recorded
 * command to a real `/bin/sh` with a stub `cmake` that writes down the argv it received, so a
 * root with a quote, `$(` or a newline in it is proven by what a shell actually does with it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { BuildPhase, BuildProblemCode, DiagnosticTool } from "../../src/shared/build-problem.ts";
import { MAC_MINIMUM_SYSTEM_VERSION, NATIVE_MAC_EXECUTABLES, NativeRunMode } from "../../src/shared/native-contract.ts";
import { type DestinationCheck, NATIVE_CROSS_EXECUTABLES, NativeRefusal } from "../../src/shared/native-contract.ts";
import { DestinationBadge } from "../../src/shared/game-targets.ts";
import type { CrossAdmission, CrossAdmissionRequest } from "../../src/substrate/native-cross-admission.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import {
  BUILD_TARGETS,
  BuildTarget,
  GameStack,
  ProjectKind,
  type GameDestinations,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import { ToolchainId, type ToolchainLock } from "../../src/shared/toolchain.ts";
import type { UiEventMap } from "../../src/shared/ui-events.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import type { LocatedToolchain, LocateResult, XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import {
  CPP_BUILD_TIMEOUT_MS,
  CPP_CONFIGURE_TIMEOUT_MS,
  CppBuildPurpose,
  CppBuilds,
  cppBuildJobs,
  cppBuildsMax,
  parseDiagnostics,
  type CppBuildInput,
  type CppBuildsOptions,
} from "../../src/main/cpp-build.ts";
import { running } from "../helpers/processes.ts";
import { writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const exec = promisify(execFile);

const LOCK: ToolchainLock = {
  version: 1,
  entries: { cmake: { version: "4.4.3", sha12: "0123456789ab" } },
  digest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
};
const DIGEST12 = LOCK.digest.slice(0, 12);
const TOOLCHAINS = "/profile/toolchains";
const NATIVE_RUNS = "/profile/native-runs";

/** The Command Line Tools as `xcode-select -p` and `xcrun --show-sdk-path` answer them; every call recorded. */
function xcode(sdk: string | null) {
  const calls: string[][] = [];
  const exec: XcodeExec = async (file, args) => {
    calls.push([file, ...args]);
    if (file.endsWith("xcode-select"))
      return sdk
        ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
        : { code: 2, stdout: "", stderr: "xcode-select: error" };
    return { code: 0, stdout: `${sdk}\n`, stderr: "" };
  };
  return { exec, calls };
}

const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";

const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};
const BROWSER_AND_MAC: GameDestinations = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] };
const MAC_ONLY: GameDestinations = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Mac] };
const EVERYWHERE: GameDestinations = {
  stack: GameStack.RaylibCpp,
  targets: [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux],
};

/** A fake store in the product's layout: stub executables, a toolchain file, a lock's em-cache and genex files. */
interface FakeStore {
  dir: string;
  located: LocatedToolchain;
  /** Where the stub cmake writes each argv it receives, one JSON line per call. */
  argvLog: string;
}

/** A node script that runs as `name`: every stub here is one, so no stub depends on the PATH. */
async function stub(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}

/**
 * `cmake` for the quoting rows: records its argv, and on `--build <dir>` writes the three files
 * genex.cmake's output folder holds.
 */
function recordingCmake(argvLog: string): string {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'if (process.argv[2] === "--build") {',
    '  const out = path.join(process.argv[3], "out");',
    "  fs.mkdirSync(out, { recursive: true });",
    '  const mac = path.basename(process.argv[3]).startsWith("macos-");',
    '  const names = mac ? ["game", "game-headless"] : ["index.html", "index.js", "index.wasm"];',
    "  for (const name of names) fs.writeFileSync(path.join(out, name), name);",
    '  if (mac) fs.mkdirSync(path.join(out, "assets"), { recursive: true });',
    "}",
  ].join("\n");
}

/** Python that prints the argv it was started with, so the `-B` wrapper can be watched. */
const ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(2)));";

async function fakeStore(parent: string): Promise<FakeStore> {
  const dir = path.join(parent, "store");
  const argvLog = path.join(parent, "cmake-argv.jsonl");
  const cmake = path.join(dir, "cmake", "4.4.3-aaaaaaaaaaaa", "bin", "cmake");
  const ninja = path.join(dir, "ninja", "1.13.2-bbbbbbbbbbbb", "ninja");
  const emsdk = path.join(dir, "emsdk", "6.0.10-cccccccccccc");
  const emscripten = path.join(emsdk, "install", "emscripten");
  const lockDir = path.join(dir, "locks", DIGEST12);
  const angle = path.join(dir, "angle-macos", "c5bf49e78850-dddddddddddd");
  await stub(cmake, recordingCmake(argvLog));
  await stub(ninja, "");
  await stub(path.join(emsdk, "python", "bin", "python3"), ECHO_ARGV);
  await stub(path.join(emsdk, "node", "bin", "node"), "");
  const toolchainFile = path.join(emscripten, "cmake", "Modules", "Platform", "Emscripten.cmake");
  await mkdir(path.dirname(toolchainFile), { recursive: true });
  await writeFile(toolchainFile, "# Emscripten.cmake\n");
  await mkdir(path.join(lockDir, "em-cache", "sysroot"), { recursive: true });
  await writeFile(path.join(lockDir, "em-cache", "sysroot", "prewarmed.txt"), "prewarmed\n");
  await writeFile(path.join(lockDir, "emscripten.config"), "LLVM_ROOT = ''\n");
  const genexCmake: LocatedToolchain["genexCmake"] = {};
  for (const target of Object.values(BuildTarget)) {
    const file = path.join(lockDir, `genex-${target}.cmake`);
    await writeFile(file, `# genex ${target}\n`);
    genexCmake[target] = file;
  }
  return {
    dir,
    argvLog,
    located: {
      lock: LOCK,
      cmake,
      ninja,
      emscripten: {
        root: emscripten,
        toolchainFile,
        python: path.join(emsdk, "python", "bin", "python3"),
        node: path.join(emsdk, "node", "bin", "node"),
        config: path.join(lockDir, "emscripten.config"),
        cache: path.join(lockDir, "em-cache"),
      },
      genexCmake,
      angle: {
        dir: angle,
        egl: path.join(angle, "libEGL.dylib"),
        gles: path.join(angle, "libGLESv2.dylib"),
        manifestSha256: "d".repeat(64),
      },
    },
  };
}

/** The template's CMakeLists.txt: genex.cmake does the rest. */
const CMAKE_LISTS = `include("\${GENEX_CMAKE}")\ngenex_add_game(SOURCES src/*.cpp)\n`;

/** A raylib game folder: the template's CMakeLists and one source file. */
async function cppGame(parent: string, name = "game"): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "CMakeLists.txt"), CMAKE_LISTS);
  await writeFile(path.join(dir, "src", "main.cpp"), "int main() { return 0; }\n");
  return realpath(dir);
}

function result(request: RunRequest, over: Partial<RunResult> = {}): RunResult {
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
    ...over,
  };
}

const isBuildStep = (request: RunRequest) => request.command.includes(" '--build' ");

/** The single-quoted arguments of a command the lane wrote (plain paths only; hostile rows use a real shell). */
function quotedArgs(command: string): string[] {
  return [...command.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
}

/**
 * What CMake does with a build folder: it refuses a `CMakeCache.txt` made for another folder, and
 * otherwise records where it is.
 */
async function fakeConfigure(request: RunRequest): Promise<Partial<RunResult>> {
  const args = quotedArgs(request.command);
  const source = args[args.indexOf("-S") + 1] ?? "";
  const bin = args[args.indexOf("-B") + 1] ?? "";
  const cache = path.join(bin, "CMakeCache.txt");
  const text = await readFile(cache, "utf8").catch(() => null);
  if (text !== null && !text.includes(`CMAKE_CACHEFILE_DIR:INTERNAL=${bin}\n`)) {
    return { code: 1, stderr: `CMake Error: The current CMakeCache.txt directory ${cache} is different\n` };
  }
  await writeFile(cache, `CMAKE_CACHEFILE_DIR:INTERNAL=${bin}\nCMAKE_HOME_DIRECTORY:INTERNAL=${source}\n`);
  return {};
}

/** What genex.cmake's build leaves: the page, its glue and its module in `out/` (a Mac build: both executables and `assets/`). */
async function fakeBuild(request: RunRequest): Promise<Partial<RunResult>> {
  const bin = quotedArgs(request.command)[2] ?? "";
  const out = path.join(bin, "out");
  await mkdir(out, { recursive: true });
  if (path.basename(bin).startsWith(`${BuildTarget.Mac}-`)) return fakeMacBuild(out);
  for (const name of ["index.html", "index.js", "index.wasm"])
    await writeFile(path.join(out, name), `${name} of ${bin}`);
  return {
    stdout:
      "[1/2] Building CXX object CMakeFiles/game.dir/src/main.cpp.o\n[2/2] Linking CXX executable out/index.html\n",
  };
}

/** What genex-macos.cmake's build leaves in `out/`: the window's game, the headless one and the copied assets. */
async function fakeMacBuild(out: string): Promise<Partial<RunResult>> {
  await mkdir(path.join(out, "assets"), { recursive: true });
  for (const name of ["game", "game-headless"]) await writeFile(path.join(out, name), `${name} of ${out}`);
  return { stdout: "[1/3] Linking CXX executable out/game\n[2/3] Linking CXX executable out/game-headless\n" };
}

type Step = (request: RunRequest) => Promise<Partial<RunResult>> | Partial<RunResult>;

/** A sandbox stand-in: records every request; configure and build do what CMake and Ninja would unless a step says otherwise. */
function fakeRun(steps: { configure?: Step; build?: Step } = {}) {
  const calls: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    const step = isBuildStep(request) ? (steps.build ?? fakeBuild) : (steps.configure ?? fakeConfigure);
    return result(request, await step(request));
  };
  return { calls, run };
}

/** A run that hands the command to a real `/bin/sh`, as the sandbox would, and records it. */
function shellRunner() {
  const calls: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    const { stdout, stderr } = await exec("/bin/sh", ["-c", request.command], { cwd: request.cwd, env: request.env });
    return result(request, { stdout, stderr });
  };
  return { calls, run };
}

/** A run that holds until its signal aborts, then answers as a killed process group. */
function holdingRun() {
  const calls: RunRequest[] = [];
  const run = (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    return new Promise((resolve) => {
      const done = () => resolve(result(request, { code: null, signal: "SIGKILL" }));
      if (request.signal?.aborted) done();
      else request.signal?.addEventListener("abort", done, { once: true });
    });
  };
  return { calls, run };
}

interface Lane {
  builds: CppBuilds;
  root: string;
  store: FakeStore;
  progress: Array<UiEventMap["build.progress"]>;
  writtenLocks: Array<[string, string]>;
  located: Array<readonly BuildTarget[]>;
}

async function lane(
  run: CppBuildsOptions["run"],
  over: Partial<CppBuildsOptions> & { parent?: string } = {},
): Promise<Lane> {
  const { parent: given, ...options } = over;
  const parent = given ?? (await realpath(await tmpDir("cpp-lane-")));
  const store = await fakeStore(parent);
  const progress: Lane["progress"] = [];
  const writtenLocks: Lane["writtenLocks"] = [];
  const located: Lane["located"] = [];
  const root = path.join(parent, "cpp-builds");
  const builds = new CppBuilds({
    root,
    run,
    locate: async (_lock, targets): Promise<LocateResult> => {
      located.push(targets);
      return { ok: true, toolchain: store.located };
    },
    currentLock: async () => LOCK,
    emit: (event) => progress.push(event),
    platform: process.platform,
    cores: 8,
    denyWrite: [TOOLCHAINS, NATIVE_RUNS],
    writeLock: async (project, digest) => {
      writtenLocks.push([project, digest]);
    },
    now: () => 1_000,
    exec: xcode(MAC_SDK).exec,
    ...options,
  });
  return { builds, root, store, progress, writtenLocks, located };
}

function input(dir: string, over: Partial<CppBuildInput> = {}): CppBuildInput {
  return {
    project: "pong",
    dir,
    shape: RAYLIB_SHAPE,
    target: BuildTarget.Web,
    destinations: BROWSER_AND_MAC,
    purpose: CppBuildPurpose.Live,
    lock: null,
    ...over,
  };
}

const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** `text` as one POSIX shell word. */
const shellWord = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Every file named `name` anywhere under `dir`. */
async function findNamed(dir: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.name === name) found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** How long a row waits for the lane to reach a state it is about to assert on. */
const SETTLE_MS = 10_000;

/** Wait until `reached()` holds (or give up after {@link SETTLE_MS}, leaving the assertion to say so). */
async function waitFor(reached: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (!(await reached()) && Date.now() < deadline) await sleep(10);
}

/** Roots a person can really have: a space, a quote, a command substitution and a newline. */
const HOSTILE_PARENTS = ["with space", "it's mine", "a$(touch PWNED)b`touch PWNED`", "new\nline"];

describe("the C++ build lane's commands", () => {
  for (const hostile of HOSTILE_PARENTS) {
    it(`configures and builds with exactly the host's argv, every path quoted (${JSON.stringify(hostile)})`, async () => {
      const parent = path.join(await realpath(await tmpDir("cpp-quote-")), hostile);
      await mkdir(parent, { recursive: true });
      const { builds, root, store } = await lane(shellRunner().run, { parent });
      const dir = await cppGame(parent);
      const outcome = await builds.ensure(input(dir));
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const bin = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}`);
      assert.equal(outcome.output, path.join(bin, "out"));
      const { located } = store;
      const argv = (await readFile(store.argvLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(argv, [
        [
          "-S",
          dir,
          "-B",
          bin,
          "-G",
          "Ninja",
          `-DCMAKE_MAKE_PROGRAM=${located.ninja}`,
          `-DGENEX_CMAKE=${located.genexCmake.web}`,
          `-DCMAKE_TOOLCHAIN_FILE=${located.emscripten?.toolchainFile}`,
          `-DGENEX_ASSETS=${bin}.assets`,
          `-DGENEX_ASSETS_STAMP=${bin}.assets.stamp`,
          "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
        ],
        ["--build", bin, "-j4"],
      ]);
      assert.deepEqual(await findNamed(path.dirname(parent), "PWNED"), [], "no command substitution ran");
    });
  }

  it("builds in <root>/<project>-<sha12 of the real source root>/<target>-<lock digest12>, and never wipes it", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const first = await builds.ensure(input(dir));
    const bin = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}`);
    assert.equal(first.output, path.join(bin, "out"));
    await writeFile(path.join(bin, "marker"), "still here");
    const second = await builds.ensure(input(dir));
    assert.equal(second.ok, true);
    assert.equal(await readFile(path.join(bin, "marker"), "utf8"), "still here");
    assert.deepEqual(
      runner.calls.map((call) => call.cwd),
      [bin, bin, bin, bin],
    );
  });

  it("never serves an in-tree build/web: the output is the lane's own out/", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    await mkdir(path.join(dir, "build", "web"), { recursive: true });
    await writeFile(path.join(dir, "build", "web", "index.html"), "a stale in-tree build");
    const outcome = await builds.ensure(input(dir));
    assert.equal(outcome.ok, true);
    assert.ok(outcome.output?.startsWith(`${root}${path.sep}`), outcome.output ?? "");
    assert.notEqual(await readFile(path.join(outcome.output ?? "", "index.html"), "utf8"), "a stale in-tree build");
  });

  it("runs with the source root, the toolchain store and the native runs write-denied, its own folder writable, and no domain of its own", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run);
    const parent = await realpath(await tmpDir("cpp-game-"));
    const dir = await cppGame(parent);
    await builds.ensure(input(dir));
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      for (const denied of [dir, TOOLCHAINS, NATIVE_RUNS]) {
        assert.ok(call.policy?.denyWrite?.includes(denied), `${denied} is not write-denied`);
      }
      // The network is the sandbox's base policy: the lane opens no domain for a build.
      assert.equal(call.policy?.allowedDomains, undefined, "the lane names no domain");
      assert.deepEqual(call.policy?.allowWrite, [call.cwd], "the one write the lane opens is its build folder");
    }
  });
});

/** Every file under `dir` (folders left out), `/`-joined and sorted; none when `dir` is not there. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** A game whose `assets/` holds what a web build packs and what it must never pack. */
async function gameWithAssets(parent: string): Promise<string> {
  const dir = await cppGame(parent);
  const assets = path.join(dir, "assets");
  await mkdir(path.join(assets, "levels"), { recursive: true });
  await mkdir(path.join(assets, ".hidden"), { recursive: true });
  await mkdir(path.join(assets, "docs"), { recursive: true });
  const files: Record<string, string> = {
    "player.png": "png bytes",
    "levels/one.json": "{}",
    ".env": "GENEX_SECRET_ENV=1",
    "server.key": "a key",
    "secrets.json": "{}",
    "notes.md": "a note",
    "README.md": "what the assets are",
    ".hidden/x.png": "hidden",
    "docs/a.png": "a working folder",
  };
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(assets, ...rel.split("/")), text);
  return dir;
}

/** Links planted under `assets/`: each one fails a web build before anything runs. */
const PLANTED_ASSET_LINKS: ReadonlyArray<{ name: string; plant: (dir: string, outside: string) => Promise<void> }> = [
  { name: "assets itself", plant: (dir, outside) => symlink(outside, path.join(dir, "assets")) },
  {
    name: "a file in assets/",
    plant: async (dir, outside) => {
      await mkdir(path.join(dir, "assets"), { recursive: true });
      await symlink(path.join(outside, "secret.txt"), path.join(dir, "assets", "secret.png"));
    },
  },
  {
    name: "a folder in assets/",
    plant: async (dir, outside) => {
      await mkdir(path.join(dir, "assets"), { recursive: true });
      await symlink(outside, path.join(dir, "assets", "sprites"));
    },
  },
  {
    name: "a file two folders down",
    plant: async (dir, outside) => {
      await mkdir(path.join(dir, "assets", "a", "b"), { recursive: true });
      await symlink(path.join(outside, "secret.txt"), path.join(dir, "assets", "a", "b", "c.png"));
    },
  },
];

/**
 * Whether a macOS sandbox with `denies` refuses a write to `target`, matched as sandbox-runtime
 * matches its deny paths (a path holding `*`, `?`, `[` or `]` is a glob).
 */
async function macDenies(denies: readonly string[], target: string): Promise<boolean> {
  const { containsGlobChars, globToRegex, normalizePathForSandbox } = (await import(
    "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js"
  )) as {
    containsGlobChars: (p: string) => boolean;
    globToRegex: (glob: string) => string;
    normalizePathForSandbox: (p: string) => string;
  };
  return denies.some((deny) => {
    const normalized = normalizePathForSandbox(deny);
    if (containsGlobChars(normalized)) return new RegExp(`${globToRegex(normalized).slice(0, -1)}(/.*)?$`).test(target);
    return target === normalized || target.startsWith(`${normalized}/`);
  });
}

/** Game folder names a person can pick that a macOS sandbox glob would read as a pattern. */
const GLOB_NAMED_GAMES = ["pong [v2]", "star*", "what?", "a]b", "x[_]__GLOBSTAR"];

describe("a game whose folder name reads as a pattern", () => {
  for (const name of GLOB_NAMED_GAMES) {
    it(`stays write-denied on a Mac while it builds (${JSON.stringify(name)})`, {
      skip: process.platform === "win32",
    }, async () => {
      const runner = fakeRun();
      const { builds } = await lane(runner.run, { platform: "darwin" });
      const dir = await cppGame(await realpath(await tmpDir("cpp-glob-")), name);
      await builds.ensure(input(dir));
      assert.ok(runner.calls.length > 0, "the build ran");
      for (const call of runner.calls) {
        const denies = call.policy?.denyWrite ?? [];
        assert.ok(
          await macDenies(denies, path.join(dir, "src", "main.cpp")),
          `${dir} is writable: ${denies.join(", ")}`,
        );
        assert.ok(await macDenies(denies, path.join(dir, "CMakeLists.txt")));
      }
    });
  }
});

describe("the assets a web build packs", () => {
  it("are the host's copy beside the build folder: regular files only, never a dotfile, key, env, note or working folder", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await gameWithAssets(await realpath(await tmpDir("cpp-assets-")));
    const outcome = await builds.ensure(input(dir));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const bin = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}`);
    const staged = `${bin}.assets`;
    assert.deepEqual(await filesUnder(staged), ["levels/one.json", "player.png"]);
    assert.equal(await readFile(path.join(staged, "player.png"), "utf8"), "png bytes");
    const [source, copy] = await Promise.all([
      stat(path.join(dir, "assets", "player.png")),
      stat(path.join(staged, "player.png")),
    ]);
    assert.equal(
      Math.trunc(copy.mtimeMs),
      Math.trunc(source.mtimeMs),
      "the copy keeps its source's time: it is how the next build sees the copy is still current",
    );
    assert.ok(quotedArgs(runner.calls[0]?.command ?? "").includes(`-DGENEX_ASSETS=${staged}`));
    assert.ok(!isInside(bin, staged), "never inside the folder the build run writes");
  });

  /**
   * The link (and with it emcc's --preload-file) re-runs only for a link dependency newer than its
   * output. A copy keeps its source's time, so the stage's stamp, rewritten whenever the stage
   * changed, is that dependency: an asset replaced by one with an older time (unzip, tar x,
   * cp -p, rsync -t) and a removed one relink too.
   */
  it("rewrites the stage's stamp whenever the stage changed, whatever the files' times, and never otherwise", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await gameWithAssets(await realpath(await tmpDir("cpp-assets-")));
    await builds.ensure(input(dir));
    const bin = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}`);
    const stamp = `${bin}.assets.stamp`;
    assert.ok(quotedArgs(runner.calls[0]?.command ?? "").includes(`-DGENEX_ASSETS_STAMP=${stamp}`));
    assert.ok(!isInside(bin, stamp), "never inside the folder the build run writes");
    const first = { text: await readFile(stamp, "utf8"), at: (await stat(stamp)).mtimeMs };

    await builds.ensure(input(dir));
    assert.equal(
      (await stat(stamp)).mtimeMs,
      first.at,
      "nothing changed: the stamp is not touched, so nothing relinks",
    );

    const player = path.join(dir, "assets", "player.png");
    const was = await stat(player);
    await rm(player);
    await writeFile(player, "different and longer png bytes");
    await utimes(player, was.atime, new Date(was.mtimeMs - MINUTE_MS));
    await builds.ensure(input(dir));
    assert.equal(await readFile(`${bin}.assets/player.png`, "utf8"), "different and longer png bytes");
    const second = { text: await readFile(stamp, "utf8"), at: (await stat(stamp)).mtimeMs };
    assert.notEqual(second.text, first.text);
    assert.ok(second.at > first.at, "an older replacement still makes the stamp newer than the last link");

    await rm(path.join(dir, "assets", "levels", "one.json"));
    await builds.ensure(input(dir));
    assert.deepEqual(await filesUnder(`${bin}.assets`), ["player.png"]);
    assert.ok((await stat(stamp)).mtimeMs > second.at, "a removed asset relinks");
  });

  it("drops index.data an earlier build packed once the game has no asset left", async () => {
    const packing = async (request: RunRequest) => {
      const done = await fakeBuild(request);
      const bin = quotedArgs(request.command)[2] ?? "";
      if ((await filesUnder(`${bin}.assets`)).length > 0)
        await writeFile(path.join(bin, "out", "index.data"), "packed");
      return done;
    };
    const { builds, root } = await lane(fakeRun({ build: packing }).run);
    const dir = await gameWithAssets(await realpath(await tmpDir("cpp-assets-")));
    await builds.ensure(input(dir));
    const out = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}`, "out");
    assert.equal(await readFile(path.join(out, "index.data"), "utf8"), "packed");
    await rm(path.join(dir, "assets"), { recursive: true });
    const outcome = await builds.ensure(input(dir));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.deepEqual(
      await filesUnder(out),
      ["index.html", "index.js", "index.wasm"],
      "no stale assets to serve or export",
    );
  });

  it("follows the game's assets from build to build: a removed one goes, a changed one is copied again", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await gameWithAssets(await realpath(await tmpDir("cpp-assets-")));
    await builds.ensure(input(dir));
    await rm(path.join(dir, "assets", "levels", "one.json"));
    await writeFile(path.join(dir, "assets", "player.png"), "new png bytes");
    await writeFile(path.join(dir, "assets", "music.ogg"), "ogg bytes");
    const outcome = await builds.ensure(input(dir));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const staged = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}.assets`);
    assert.deepEqual(await filesUnder(staged), ["music.ogg", "player.png"]);
    assert.equal(await readFile(path.join(staged, "player.png"), "utf8"), "new png bytes");
  });

  for (const planting of PLANTED_ASSET_LINKS) {
    it(`fails before anything runs when ${planting.name} is a link, and copies nothing from where it points`, async () => {
      const runner = fakeRun();
      const { builds, root } = await lane(runner.run);
      const parent = await realpath(await tmpDir("cpp-assets-"));
      const dir = await cppGame(parent);
      const outside = path.join(parent, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "GENEX_OUTSIDE_SECRET");
      await planting.plant(dir, outside);
      const outcome = await builds.ensure(input(dir));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
      assert.match(outcome.problem?.lines.join("\n") ?? "", /is a link/);
      assert.equal(runner.calls.length, 0, "nothing ran");
      const staged = path.join(root, `pong-${sha12(dir)}`, `web-${DIGEST12}.assets`);
      assert.deepEqual(await filesUnder(staged), [], "nothing staged");
      assert.deepEqual(await filesUnder(outside), ["secret.txt"]);
      assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "GENEX_OUTSIDE_SECRET");
    });
  }
});

describe("the C++ build lane's environment and limits", () => {
  it("gives every run the store's tools first, a private EM_CACHE cloned from the lock's, and Python that writes no bytecode", async () => {
    const runner = shellRunner();
    const parent = path.join(await realpath(await tmpDir("cpp-env-")), "it's $(x)");
    await mkdir(parent, { recursive: true });
    const { builds, store, root } = await lane(runner.run, { parent });
    const dir = await cppGame(parent);
    await builds.ensure(input(dir));
    const bin = runner.calls[0]?.cwd ?? "";
    const env = runner.calls[0]?.env ?? {};
    const emscripten = store.located.emscripten ?? assert.fail("the fake store has Emscripten");
    assert.equal(env.EM_CACHE, path.join(bin, "em-cache"));
    assert.equal(env.EM_CONFIG, emscripten.config);
    assert.equal(env.EMCC_SKIP_SANITY_CHECK, "1");
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.ok(env.CLANG_MODULE_CACHE_PATH?.startsWith(`${bin}${path.sep}`), "the module cache is in the build folder");
    const pathDirs = (env.PATH ?? "").split(path.delimiter);
    const cmakeAt = pathDirs.indexOf(path.dirname(store.located.cmake));
    const ninjaAt = pathDirs.indexOf(path.dirname(store.located.ninja));
    assert.ok(cmakeAt >= 0 && ninjaAt >= 0, env.PATH);
    assert.ok(pathDirs.indexOf("/usr/bin") > Math.max(cmakeAt, ninjaAt), "the store's tools come before the system's");
    // The clone is the lock's prewarmed cache, and the store's own copy is untouched.
    assert.equal(await readFile(path.join(bin, "em-cache", "sysroot", "prewarmed.txt"), "utf8"), "prewarmed\n");
    assert.deepEqual((await readdir(emscripten.cache, { recursive: true })).sort(), [
      "sysroot",
      path.join("sysroot", "prewarmed.txt"),
    ]);
    // emcc starts Python with -E, which ignores PYTHONDONTWRITEBYTECODE: the wrapper adds -B.
    const { stdout } = await exec(env.EMSDK_PYTHON ?? "", ["-E", "emcc.py", "it's"]);
    assert.deepEqual(JSON.parse(stdout), ["-B", "-E", "emcc.py", "it's"]);
    // The host writes the wrapper; a build can write its own folder, so the wrapper is never in one.
    const wrapper = env.EMSDK_PYTHON ?? "";
    assert.ok(isInside(root, wrapper), "the wrapper lives in the lane's root, not the store");
    assert.equal(isInside(path.dirname(bin), wrapper), false, "the wrapper is in no build folder of the game");
  });

  it("clones the em-cache once: a second build reuses the folder's own", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    await builds.ensure(input(dir));
    const cache = path.join(runner.calls[0]?.cwd ?? "", "em-cache");
    await writeFile(path.join(cache, "built-by-emcc.a"), "a library emcc made on demand");
    await builds.ensure(input(dir));
    assert.equal(await readFile(path.join(cache, "built-by-emcc.a"), "utf8"), "a library emcc made on demand");
  });

  it("carries -j<cap> on every build, the cores shared among the builds that may run at once", async () => {
    const table: Array<[number, number, number]> = [
      [1, 1, 1],
      [2, 1, 2],
      [4, 1, 4],
      [8, 2, 4],
      [14, 3, 4],
      [16, 4, 4],
      [0, 1, 1],
    ];
    for (const [cores, max, jobs] of table) {
      assert.equal(cppBuildsMax(cores), max, `CPP_BUILDS_MAX for ${cores} cores`);
      assert.equal(cppBuildJobs(cores), jobs, `-j for ${cores} cores`);
    }
    const runner = fakeRun();
    const { builds } = await lane(runner.run, { cores: 14 });
    await builds.ensure(input(await cppGame(await realpath(await tmpDir("cpp-game-")))));
    assert.ok(runner.calls[1]?.command.endsWith(" '-j4'"), runner.calls[1]?.command);
  });

  it("gives configure three minutes and each destination its own build timeout", async () => {
    assert.equal(CPP_CONFIGURE_TIMEOUT_MS, 3 * MINUTE_MS);
    assert.deepEqual(CPP_BUILD_TIMEOUT_MS, {
      [BuildTarget.Web]: 15 * MINUTE_MS,
      [BuildTarget.Mac]: 10 * MINUTE_MS,
      [BuildTarget.Windows]: 15 * MINUTE_MS,
      [BuildTarget.Linux]: 15 * MINUTE_MS,
      // Rows that only keep the table exhaustive: raylib builds no mobile destination.
      [BuildTarget.Ios]: 15 * MINUTE_MS,
      [BuildTarget.Android]: 15 * MINUTE_MS,
    });
    // A store with zig and the cross files: Windows and Linux build too.
    const runner = fakeRun({ build: fakeCrossBuild });
    const { builds } = await crossLane(runner.run, { platform: "darwin" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    for (const target of BUILD_TARGETS) {
      runner.calls.length = 0;
      await builds.ensure(input(dir, { target, destinations: EVERYWHERE }));
      assert.deepEqual(
        runner.calls.map((call) => call.timeoutMs),
        [CPP_CONFIGURE_TIMEOUT_MS, CPP_BUILD_TIMEOUT_MS[target]],
        target,
      );
    }
  });
});

describe("what the lane refuses before anything runs", () => {
  it("refuses a source root holding CMakeCache.txt as an in-source build, naming the file", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    await writeFile(path.join(dir, "CMakeCache.txt"), "CMAKE_HOME_DIRECTORY:INTERNAL=.\n");
    const outcome = await builds.ensure(input(dir));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.InSourceBuild);
    assert.deepEqual(outcome.problem?.lines, [path.join(dir, "CMakeCache.txt")]);
    assert.equal(runner.calls.length, 0);
    assert.equal(await exists(root), false, "no build folder was made");
  });

  it("refuses a Mac destination on a host that is not a Mac", async () => {
    const runner = fakeRun();
    const { builds, root, located } = await lane(runner.run, { platform: "linux" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(outcome.problem?.reason, BuildProblemCode.MacBuildsNeedAMac);
    assert.equal(outcome.problem?.target, BuildTarget.Mac);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(located, []);
    assert.equal(await exists(root), false);
  });

  /**
   * Windows' sandbox grants a write to the whole session, never to one run: a build's own folder
   * there would be writable by every agent command. Until the lane has a Windows design of its
   * own, a build there is refused before anything is made or run, never left to fail as
   * NotGranted (and the build root is never made a session-wide grant).
   */
  it("refuses every build on Windows before anything is made or run", async () => {
    const runner = fakeRun();
    const { builds, root, located } = await lane(runner.run, { platform: "win32" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    for (const target of [BuildTarget.Web, BuildTarget.Windows]) {
      const outcome = await builds.ensure(input(dir, { target, destinations: EVERYWHERE }));
      assert.equal(outcome.problem?.reason, BuildProblemCode.UnsupportedHost, target);
      assert.equal(outcome.ran, false);
    }
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(located, []);
    assert.equal(await exists(root), false);
  });

  it("refuses a desktop target the game does not name, while Web always builds (judging a Mac-only game)", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run, { platform: "darwin" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const windows = await builds.ensure(input(dir, { target: BuildTarget.Windows, destinations: BROWSER_AND_MAC }));
    assert.equal(windows.problem?.reason, BuildProblemCode.NotADestination);
    assert.equal(runner.calls.length, 0);
    const judged = await builds.ensure(
      input(dir, { target: BuildTarget.Web, destinations: MAC_ONLY, purpose: CppBuildPurpose.Judging }),
    );
    assert.equal(judged.ok, true, JSON.stringify(judged.problem));
    assert.equal(runner.calls.length, 2);
  });

  it("refuses a lock the store does not hold, and a store with no lock at all, as a missing toolchain", async () => {
    const runner = fakeRun();
    const missing = await lane(runner.run, {
      locate: async () => ({ ok: false, missing: ["emsdk"] }),
    });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await missing.builds.ensure(input(dir));
    assert.equal(outcome.problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.deepEqual(outcome.problem?.lines, ["emsdk"]);
    const none = await lane(runner.run, { currentLock: async () => null });
    assert.equal((await none.builds.ensure(input(dir))).problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.equal(runner.calls.length, 0);
  });
});

describe("a store the lane cannot read", () => {
  it("is a missing toolchain, with the reason, and nothing runs", async () => {
    const runner = fakeRun();
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const unreadable = await lane(runner.run, {
      locate: async () => {
        throw new Error("receipt.json is not JSON");
      },
    });
    const located = await unreadable.builds.ensure(input(dir));
    assert.equal(located.problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.deepEqual(located.problem?.lines, ["receipt.json is not JSON"]);
    const noLock = await lane(runner.run, {
      currentLock: async () => {
        throw new Error("current-lock.json is not JSON");
      },
    });
    const locked = await noLock.builds.ensure(input(dir));
    assert.equal(locked.problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.deepEqual(locked.problem?.lines, ["current-lock.json is not JSON"]);
    assert.equal(runner.calls.length, 0);
  });

  it("write-denies a store reached through a link at its real path too", async () => {
    const parent = await realpath(await tmpDir("cpp-link-"));
    const realStore = path.join(parent, "real-store");
    const linked = path.join(parent, "toolchains");
    await mkdir(realStore);
    await symlink(realStore, linked, "dir");
    const runner = fakeRun();
    const { builds } = await lane(runner.run, { denyWrite: [linked, NATIVE_RUNS] });
    await builds.ensure(input(await cppGame(parent)));
    for (const call of runner.calls) {
      for (const denied of [linked, realStore, NATIVE_RUNS]) {
        assert.ok(call.policy?.denyWrite?.includes(denied), `${denied} is not write-denied`);
      }
    }
  });
});

describe("hostile names and locks", () => {
  it("keeps every build folder inside the root, whatever the project is called", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    for (const project of ["../escape", "a/b", "..", ".", "", "x\u0000y", "/abs", "a\nb"]) {
      runner.calls.length = 0;
      const outcome = await builds.ensure(input(dir, { project }));
      assert.equal(outcome.ok, true, `${JSON.stringify(project)}: ${JSON.stringify(outcome.problem)}`);
      for (const call of runner.calls) {
        assert.ok(call.cwd.startsWith(`${root}${path.sep}`), `${JSON.stringify(project)} built in ${call.cwd}`);
        assert.equal(path.relative(root, call.cwd).split(path.sep).length, 2, call.cwd);
      }
    }
    assert.deepEqual((await readdir(path.dirname(root))).sort(), ["cpp-builds", "store"], "nothing beside the root");
  });

  it("refuses a lock whose digest is not the store's hex, and writes nothing", async () => {
    const runner = fakeRun();
    const parent = await realpath(await tmpDir("cpp-lock-"));
    const { builds, root } = await lane(runner.run, { parent });
    const dir = await cppGame(parent);
    for (const digest of ["../../../../tmp/owned", "ABCDEF0123456789", "abc", "", "0123456789ab/../x"]) {
      const lock = { ...LOCK, digest };
      const outcome = await builds.ensure(input(dir, { lock }));
      assert.equal(outcome.problem?.reason, BuildProblemCode.ToolchainMissing, digest);
    }
    assert.equal(runner.calls.length, 0);
    assert.equal(await exists(root), false);
  });
});

describe("what a failed build says", () => {
  const ninjaOutput = [
    "[1/4] Building CXX object CMakeFiles/game.dir/src/hud.cpp.o",
    "FAILED: CMakeFiles/game.dir/src/main.cpp.o",
    "/store/emsdk/em++ -std=c++20 -c /GAME/src/main.cpp -o CMakeFiles/game.dir/src/main.cpp.o",
    "/GAME/src/hud.cpp:3:10: warning: unused variable 'x' [-Wunused-variable]",
    "/GAME/src/main.cpp:12:5: error: use of undeclared identifier 'DrawCircel'",
    "/GAME/src/main.cpp:12:5: note: did you mean 'DrawCircle'?",
    "em++: error: '/store/emsdk/clang++ -c /GAME/src/main.cpp' failed (returned 1)",
    "CMake Error at CMakeLists.txt:4 (genex_add_game):",
    "  genex_add_game was given no SOURCES",
    "",
    "wasm-ld: error: undefined symbol: studio_frame",
    "emcc: error: a fourth error the stage has no room for",
    "ninja: build stopped: subcommand failed.",
  ];

  it("keeps the first three clang, CMake and wasm-ld errors over progress lines, and the first lines as before", async () => {
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const stdout = ninjaOutput.join("\n").replaceAll("/GAME", dir);
    const runner = fakeRun({ build: () => ({ code: 1, stdout }) });
    const { builds } = await lane(runner.run);
    const outcome = await builds.ensure(input(dir));
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.problem?.code, 1);
    assert.equal(outcome.problem?.target, BuildTarget.Web);
    assert.deepEqual(
      outcome.problem?.lines,
      ninjaOutput.slice(0, 3).map((line) => line.replaceAll("/GAME", dir)),
    );
    assert.deepEqual(outcome.problem?.diagnostics, [
      {
        tool: DiagnosticTool.Clang,
        file: "src/main.cpp",
        line: 12,
        column: 5,
        message: "use of undeclared identifier 'DrawCircel'",
      },
      {
        tool: DiagnosticTool.CMake,
        file: "CMakeLists.txt",
        line: 4,
        column: null,
        message: "genex_add_game was given no SOURCES",
      },
      { tool: DiagnosticTool.WasmLd, file: null, line: null, column: null, message: "undefined symbol: studio_frame" },
    ]);
  });
});

describe("the diagnostics parser", () => {
  it("reads each tool's error shape, and a file outside the game keeps its own path", () => {
    const table: Array<[string, ReturnType<typeof parseDiagnostics>]> = [
      [
        "/elsewhere/raylib.h:7:1: fatal error: 'GLFW/glfw3.h' file not found",
        [
          {
            tool: DiagnosticTool.Clang,
            file: "/elsewhere/raylib.h",
            line: 7,
            column: 1,
            message: "'GLFW/glfw3.h' file not found",
          },
        ],
      ],
      [
        "CMake Error: The source directory does not appear to contain CMakeLists.txt.",
        [
          {
            tool: DiagnosticTool.CMake,
            file: null,
            line: null,
            column: null,
            message: "The source directory does not appear to contain CMakeLists.txt.",
          },
        ],
      ],
      [
        "emcc: error: invalid export name: _x",
        [{ tool: DiagnosticTool.Emcc, file: null, line: null, column: null, message: "invalid export name: _x" }],
      ],
      [
        "ninja: error: loading 'build.ninja': No such file or directory",
        [
          {
            tool: DiagnosticTool.Ninja,
            file: null,
            line: null,
            column: null,
            message: "loading 'build.ninja': No such file or directory",
          },
        ],
      ],
      [
        "error: unable to find target 'x86_64-windows-gnu'",
        [
          {
            tool: DiagnosticTool.Zig,
            file: null,
            line: null,
            column: null,
            message: "unable to find target 'x86_64-windows-gnu'",
          },
        ],
      ],
      ["[3/9] Building C object raylib/rcore.c.o\n-- Configuring done (0.4s)\nsrc/a.cpp:1:1: warning: w", []],
    ];
    for (const [output, expected] of table) assert.deepEqual(parseDiagnostics(output, "/game"), expected, output);
  });

  it("says an error once when a Mac build compiles the file twice, once per executable", () => {
    const twice = [
      "[1/6] Building CXX object CMakeFiles/game.dir/src/main.cpp.o",
      "/game/src/main.cpp:88:31: error: use of undeclared identifier 'x'",
      "1 error generated.",
      "[2/6] Building CXX object CMakeFiles/game-headless.dir/src/main.cpp.o",
      "/game/src/main.cpp:88:31: error: use of undeclared identifier 'x'",
      "/game/src/hud.cpp:3:1: error: unknown type name 'y'",
    ].join("\n");
    assert.deepEqual(
      parseDiagnostics(twice, "/game").map((found) => `${found.file}:${found.line}`),
      ["src/main.cpp:88", "src/hud.cpp:3"],
    );
  });
});

const MAC_OUTPUTS = [
  "assets",
  NATIVE_MAC_EXECUTABLES[NativeRunMode.Window],
  NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless],
].sort();

describe("the Mac lane", () => {
  it("refuses a Mac build without the Command Line Tools as clt-missing, before anything is made or run", async () => {
    const runner = fakeRun();
    const tools = xcode(null);
    const { builds, root, located } = await lane(runner.run, { platform: "darwin", exec: tools.exec });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CltMissing);
    assert.equal(outcome.problem?.target, BuildTarget.Mac);
    assert.deepEqual(
      tools.calls,
      [["/usr/bin/xcode-select", "-p"]],
      "only xcode-select ran: nothing that opens Apple's installer",
    );
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(located, []);
    assert.equal(await exists(root), false, "no build folder was made");
  });

  for (const hostile of HOSTILE_PARENTS) {
    it(`configures with the SDK xcrun names, arm64, the deployment target and genex-macos.cmake, every path quoted (${JSON.stringify(hostile)})`, async () => {
      const parent = path.join(await realpath(await tmpDir("cpp-mac-quote-")), hostile);
      await mkdir(parent, { recursive: true });
      // xcrun names its SDK on one line: a newline never reaches the argv from there.
      const sdk = path.join(parent.replaceAll("\n", "-"), "SDKs", "MacOSX 26.sdk");
      const { builds, root, store } = await lane(shellRunner().run, {
        parent,
        platform: "darwin",
        exec: xcode(sdk).exec,
      });
      const dir = await cppGame(parent);
      const outcome = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const bin = path.join(root, `pong-${sha12(dir)}`, `macos-${DIGEST12}`);
      assert.equal(outcome.output, path.join(bin, "out"));
      const argv = (await readFile(store.argvLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(argv, [
        [
          "-S",
          dir,
          "-B",
          bin,
          "-G",
          "Ninja",
          `-DCMAKE_MAKE_PROGRAM=${store.located.ninja}`,
          `-DGENEX_CMAKE=${store.located.genexCmake.macos}`,
          `-DCMAKE_OSX_SYSROOT=${sdk}`,
          "-DCMAKE_OSX_ARCHITECTURES=arm64",
          `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MAC_MINIMUM_SYSTEM_VERSION}`,
          `-DGENEX_ASSETS=${bin}.assets`,
          `-DGENEX_ASSETS_STAMP=${bin}.assets.stamp`,
          "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
        ],
        ["--build", bin, "-j4"],
      ]);
      assert.deepEqual(await findNamed(path.dirname(parent), "PWNED"), [], "no command substitution ran");
    });
  }

  it("builds under the same per-run sandbox: its own folder writable, the game, the store and the native runs denied, no Emscripten", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run, { platform: "darwin", exec: xcode(MAC_SDK).exec });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.deepEqual(call.policy?.allowWrite, [call.cwd]);
      for (const denied of [dir, TOOLCHAINS, NATIVE_RUNS]) assert.ok(call.policy?.denyWrite?.includes(denied), denied);
      assert.equal(call.policy?.allowedDomains, undefined, "the lane names no domain");
      assert.equal(call.env?.EM_CACHE, undefined, "a Mac build runs no emcc");
      assert.equal(call.env?.CLANG_MODULE_CACHE_PATH, path.join(call.cwd, "clang-module-cache"));
    }
    assert.equal(
      await exists(path.join(path.dirname(outcome.output ?? ""), "em-cache")),
      false,
      "no em-cache is cloned",
    );
  });
});

describe("the Mac lane's output", () => {
  it("asks genex.cmake to copy the assets again when out/assets is gone: its marker goes before the build", async () => {
    const markers: boolean[] = [];
    const build: Step = async (request) => {
      const bin = quotedArgs(request.command)[2] ?? "";
      markers.push(await exists(path.join(bin, "genex-assets.done")));
      await writeFile(path.join(bin, "genex-assets.done"), "");
      return fakeBuild(request);
    };
    const runner = fakeRun({ build });
    const { builds } = await lane(runner.run, { platform: "darwin" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const first = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(first.ok, true, JSON.stringify(first.problem));
    await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    await rm(path.join(first.output ?? "", "assets"), { recursive: true });
    await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.deepEqual(markers, [false, true, false], "kept while out/assets is there, gone once it is not");
  });

  it("leaves exactly game, game-headless and assets/ in out/, and stages the game's assets beside its folder", {
    skip: process.platform === "win32" && "POSIX links",
  }, async () => {
    const extras: Step = async (request) => {
      const built = await fakeBuild(request);
      const out = path.join(quotedArgs(request.command)[2] ?? "", "out");
      await writeFile(path.join(out, "libextra.dylib"), "an agent's extra output");
      await mkdir(path.join(out, "CMakeFiles"), { recursive: true });
      await symlink("/etc", path.join(out, "linked"));
      return built;
    };
    const runner = fakeRun({ build: extras });
    const { builds } = await lane(runner.run, { platform: "darwin", exec: xcode(MAC_SDK).exec });
    const dir = await gameWithAssets(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const out = outcome.output ?? "";
    assert.deepEqual((await readdir(out)).sort(), MAC_OUTPUTS);
    const bin = path.dirname(out);
    assert.deepEqual(await filesUnder(`${bin}.assets`), ["levels/one.json", "player.png"]);
    assert.equal(await exists("/etc/hosts"), true, "a link in out/ is removed, never followed");
  });

  it("says a Mac build that left no game-headless failed, with no half-built out/ to fall back on", async () => {
    let half = false;
    const halfBuild: Step = async (request) => {
      const built = await fakeBuild(request);
      if (half) await rm(path.join(quotedArgs(request.command)[2] ?? "", "out", "game-headless"));
      return built;
    };
    const runner = fakeRun({ build: halfBuild });
    const { builds } = await lane(runner.run, { platform: "darwin", exec: xcode(MAC_SDK).exec });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const good = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(good.ok, true, JSON.stringify(good.problem));
    half = true;
    const bad = await builds.ensure(input(dir, { target: BuildTarget.Mac }));
    assert.equal(bad.ok, false);
    assert.equal(bad.problem?.reason, BuildProblemCode.CommandFailed);
    assert.match(bad.problem?.lines[0] ?? "", /game-headless/);
    assert.equal(bad.lastGood, null, "a Mac out/ missing an executable is no build to fall back on");
  });
});

/** A link a Mac build run plants in its own `out/`, pointing outside the root, once its own build is done. */
interface MacOutPlanting {
  name: string;
  plant: (out: string, victim: string) => Promise<void>;
}

const MAC_OUT_PLANTINGS: MacOutPlanting[] = [
  { name: "out/ itself", plant: (out, victim) => linkAt(out, victim) },
  { name: "out/assets", plant: (out, victim) => linkAt(path.join(out, "assets"), victim) },
  { name: "out/game", plant: (out, victim) => linkAt(path.join(out, "game"), path.join(victim, "game")) },
];

describe("links a Mac build plants in its own out/", { skip: process.platform === "win32" && "POSIX links" }, () => {
  for (const planting of MAC_OUT_PLANTINGS) {
    it(`never trims, writes or serves outside the root through ${planting.name}, and says the build left no output`, async () => {
      const parent = await realpath(await tmpDir("cpp-mac-planted-"));
      const victim = path.join(parent, "victim");
      await mkdir(path.join(victim, "src"), { recursive: true });
      await writeFile(path.join(victim, "game"), "the person's own game\n");
      await writeFile(path.join(victim, "precious.txt"), "the person's own file\n");
      await writeFile(path.join(victim, "src", "main.cpp"), "int main() { return 1; }\n");
      let armed = false;
      const build: Step = async (request) => {
        const built = await fakeBuild(request);
        if (armed) await planting.plant(path.join(quotedArgs(request.command)[2] ?? "", "out"), victim);
        return built;
      };
      const { builds } = await lane(fakeRun({ build }).run, { parent, platform: "darwin" });
      const game = await cppGame(parent, "game");
      assert.equal((await builds.ensure(input(game, { target: BuildTarget.Mac }))).ok, true);
      const before = await contents(victim);
      armed = true;
      const outcome = await builds.ensure(input(game, { target: BuildTarget.Mac }));
      assert.deepEqual(await contents(victim), before, "nothing outside the root changed");
      assert.equal(outcome.ok, false, "a build that planted a link has no output");
      assert.equal(outcome.output, null);
      assert.equal(outcome.lastGood, null, "and nothing to fall back on");
      assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    });
  }
});

describe("what else a failed build says", () => {
  it("says a build that finished without writing out/index.html failed", async () => {
    const runner = fakeRun({ build: () => ({ code: 0 }) });
    const { builds } = await lane(runner.run);
    const outcome = await builds.ensure(input(await cppGame(await realpath(await tmpDir("cpp-game-")))));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.ok((outcome.problem?.lines.length ?? 0) > 0);
  });

  it("says a build that ran out of time timed out", async () => {
    const runner = fakeRun({ build: () => ({ code: null, signal: "SIGKILL", timedOut: true }) });
    const { builds } = await lane(runner.run);
    const outcome = await builds.ensure(input(await cppGame(await realpath(await tmpDir("cpp-game-")))));
    assert.equal(outcome.problem?.reason, BuildProblemCode.TimedOut);
  });

  it("keeps the last output that worked for the live stage when a later build fails", async () => {
    let broken = false;
    const runner = fakeRun({ build: (request) => (broken ? { code: 1, stdout: "x" } : fakeBuild(request)) });
    const { builds } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const good = await builds.ensure(input(dir));
    broken = true;
    const bad = await builds.ensure(input(dir));
    assert.equal(bad.ok, false);
    assert.equal(bad.lastGood, good.output);
    assert.equal(bad.problem?.showingLastBuild, true);
  });
});

describe("the lane's progress, lock and sharing", () => {
  it("reports configure, build and done in order, and failed where it stopped", async () => {
    const good = await lane(fakeRun().run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    await good.builds.ensure(input(dir));
    assert.deepEqual(good.progress, [
      {
        project: "pong",
        target: BuildTarget.Web,
        purpose: CppBuildPurpose.Live,
        phase: BuildPhase.Configure,
        at: 1_000,
      },
      { project: "pong", target: BuildTarget.Web, purpose: CppBuildPurpose.Live, phase: BuildPhase.Build, at: 1_000 },
      { project: "pong", target: BuildTarget.Web, purpose: CppBuildPurpose.Live, phase: BuildPhase.Done, at: 1_000 },
    ]);
    const configureFails = await lane(fakeRun({ configure: () => ({ code: 1, stderr: "CMake Error: no" }) }).run);
    await configureFails.builds.ensure(input(dir));
    assert.deepEqual(
      configureFails.progress.map((event) => event.phase),
      [BuildPhase.Configure, BuildPhase.Failed],
    );
  });

  it("records the lock once, and only after a build of the game folder that worked", async () => {
    let broken = true;
    const runner = fakeRun({ build: (request) => (broken ? { code: 1 } : fakeBuild(request)) });
    const { builds, writtenLocks } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    await builds.ensure(input(dir, { recordLock: true }));
    assert.deepEqual(writtenLocks, []);
    broken = false;
    await builds.ensure(input(dir, { recordLock: true }));
    await builds.ensure(input(dir, { recordLock: true }));
    assert.deepEqual(writtenLocks, [["pong", LOCK.digest]]);
  });

  it("never records the lock for a worktree's build: the person's game folder is not written mid-run", async () => {
    const runner = fakeRun();
    const { builds, writtenLocks } = await lane(runner.run);
    const parent = await realpath(await tmpDir("cpp-game-"));
    const worktree = await cppGame(parent, "worktree");
    const judged = await builds.ensure(input(worktree, { purpose: CppBuildPurpose.Judging }));
    const worker = await builds.ensure(input(worktree));
    assert.equal(judged.ok && worker.ok, true);
    assert.deepEqual(writtenLocks, []);
  });

  it("says why a store cannot build: tools to install, a first build never prepared, a prewarm from an older Genex, or a part with no download yet", async () => {
    const parent = await realpath(await tmpDir("cpp-game-"));
    const dir = await cppGame(parent);
    const rows: Array<[LocateResult, BuildProblemCode]> = [
      [{ ok: false, missing: [ToolchainId.Emsdk] }, BuildProblemCode.ToolchainMissing],
      // Every tool installed, the lock's first build never made: set it up, nothing to install.
      [{ ok: false, missing: [ToolchainId.RaylibSource], needsPrewarm: true }, BuildProblemCode.ToolchainUnprepared],
      [
        { ok: false, missing: [ToolchainId.RaylibSource], needsPrewarm: true, stale: true },
        BuildProblemCode.ToolchainStale,
      ],
      [{ ok: false, missing: [ToolchainId.AngleMac], notHosted: true }, BuildProblemCode.ToolchainNotHosted],
    ];
    for (const [located, reason] of rows) {
      const runner = fakeRun();
      const { builds } = await lane(runner.run, { parent, locate: async () => located });
      const outcome = await builds.ensure(input(dir));
      assert.equal(outcome.problem?.reason, reason, JSON.stringify(located));
      assert.equal(runner.calls.length, 0, "nothing ran");
    }
  });

  it("ends whatever a configure or build left running once it exits: the host reads out/ next", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    assert.equal((await builds.ensure(input(dir))).ok, true);
    assert.deepEqual(
      runner.calls.map((call) => call.reapGroup),
      [true, true],
    );
  });

  it("shares one build between two looks at the same game", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const [first, second] = await Promise.all([builds.ensure(input(dir)), builds.ensure(input(dir))]);
    assert.equal(runner.calls.length, 2, "one configure and one build");
    assert.deepEqual(first, second);
  });

  it("seeds a worker's first build folder by cloning the lead's, marked, with CMake's cache moved to it", async () => {
    const runner = fakeRun();
    const { builds } = await lane(runner.run);
    const parent = await realpath(await tmpDir("cpp-game-"));
    const lead = await cppGame(parent, "lead");
    const worker = await cppGame(parent, "worker");
    const leadOutcome = await builds.ensure(input(lead));
    const leadBin = path.dirname(leadOutcome.output ?? "");
    await writeFile(path.join(leadBin, "object-from-the-lead.o"), "compiled once");
    const workerOutcome = await builds.ensure(input(worker));
    assert.equal(workerOutcome.ok, true, JSON.stringify(workerOutcome.problem));
    const workerBin = path.dirname(workerOutcome.output ?? "");
    assert.notEqual(workerBin, leadBin);
    assert.equal(await readFile(path.join(workerBin, "object-from-the-lead.o"), "utf8"), "compiled once");
    assert.equal((await readFile(path.join(workerBin, ".seeded-from"), "utf8")).trim(), leadBin);
    assert.equal(await readFile(path.join(workerBin, "out", "index.html"), "utf8"), `index.html of ${workerBin}`);
  });

  it("lets CPP_BUILDS_MAX builds run at once; the rest wait their turn", async () => {
    const holding = holdingRun();
    const { builds } = await lane(holding.run, { cores: 8 });
    const parent = await realpath(await tmpDir("cpp-game-"));
    const games = await Promise.all(["a", "b", "c"].map((name) => cppGame(parent, name)));
    const outcomes = games.map((dir, index) => builds.ensure(input(dir, { project: `game-${index}` })));
    await waitFor(() => holding.calls.length >= cppBuildsMax(8));
    await sleep(100);
    assert.equal(holding.calls.length, cppBuildsMax(8), "two run, the third waits");
    builds.cancelAll();
    const settled = await Promise.all(outcomes);
    assert.deepEqual(
      settled.map((outcome) => outcome.problem?.reason),
      [BuildProblemCode.Cancelled, BuildProblemCode.Cancelled, BuildProblemCode.Cancelled],
    );
    assert.equal(holding.calls.length, 2, "the waiting build never started");
  });
});

describe("Stop", () => {
  it("resolves an aborted build as cancelled, and cancelAll cancels every build in flight", async () => {
    const holding = holdingRun();
    const { builds } = await lane(holding.run);
    const parent = await realpath(await tmpDir("cpp-game-"));
    const controller = new AbortController();
    const one = builds.ensure(input(await cppGame(parent, "one"), { project: "one" }), { signal: controller.signal });
    await waitFor(() => holding.calls.length === 1);
    controller.abort();
    const aborted = await one;
    assert.equal(aborted.ok, false);
    assert.equal(aborted.problem?.reason, BuildProblemCode.Cancelled);
    assert.equal(holding.calls[0]?.signal?.aborted, true, "the run's own signal was aborted");
    const two = builds.ensure(input(await cppGame(parent, "two"), { project: "two" }));
    const three = builds.ensure(input(await cppGame(parent, "three"), { project: "three" }));
    await waitFor(() => holding.calls.length === 3);
    builds.cancelAll();
    for (const outcome of await Promise.all([two, three])) {
      assert.equal(outcome.problem?.reason, BuildProblemCode.Cancelled);
    }
  });

  /** Long enough for a second `ensure` to pass its host-side checks and join the build in flight. */
  const JOIN_MS = 50;

  /** Whether `promise` has settled once pending callbacks ran: a shared build's caller waits on nothing else. */
  async function settledNow(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await sleep(20);
    return settled;
  }

  it("a joiner's abort ends only its own wait at once: the build it joined keeps running for its first caller", async () => {
    // Play on Mac joins a harness lease's Mac build of the same folder; the person's Stop must end
    // Play's wait now, not when the lease's build ends (up to ten minutes), and leave the lease's build alone.
    const holding = holdingRun();
    const { builds } = await lane(holding.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const lease = builds.ensure(input(dir, { purpose: CppBuildPurpose.Judging }));
    await waitFor(() => holding.calls.length === 1);
    const play = new AbortController();
    const joined = builds.ensure(input(dir), { signal: play.signal });
    play.abort();
    assert.equal(await settledNow(joined), true, "the joiner's wait ended at once");
    assert.equal((await joined).problem?.reason, BuildProblemCode.Cancelled);
    assert.equal(holding.calls[0]?.signal?.aborted, false, "the build the lease waits on runs on");
    assert.equal(await settledNow(lease), false, "the lease still waits for its build");
    builds.cancelAll();
    assert.equal((await lease).problem?.reason, BuildProblemCode.Cancelled);
  });

  it("the first caller's abort leaves a build another caller still waits on running", async () => {
    const holding = holdingRun();
    const { builds } = await lane(holding.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const play = new AbortController();
    const first = builds.ensure(input(dir), { signal: play.signal });
    await waitFor(() => holding.calls.length === 1);
    const lease = builds.ensure(input(dir, { purpose: CppBuildPurpose.Judging }), {
      signal: new AbortController().signal,
    });
    await sleep(JOIN_MS);
    play.abort();
    assert.equal(await settledNow(first), true, "the first caller's wait ended at once");
    assert.equal((await first).problem?.reason, BuildProblemCode.Cancelled);
    assert.equal(holding.calls[0]?.signal?.aborted, false, "the lease never aborted anything");
    assert.equal(await settledNow(lease), false, "the lease's build was not cancelled by someone else's Stop");
    builds.cancelAll();
    assert.equal((await lease).problem?.reason, BuildProblemCode.Cancelled);
  });

  it("a shared build is cancelled once every caller waiting on it has aborted", async () => {
    const holding = holdingRun();
    const { builds } = await lane(holding.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const [one, two] = [new AbortController(), new AbortController()];
    const first = builds.ensure(input(dir), { signal: one.signal });
    await waitFor(() => holding.calls.length === 1);
    const second = builds.ensure(input(dir), { signal: two.signal });
    await sleep(JOIN_MS);
    one.abort();
    await sleep(20);
    assert.equal(holding.calls[0]?.signal?.aborted, false, "one caller still waits");
    two.abort();
    await waitFor(() => holding.calls[0]?.signal?.aborted === true);
    for (const outcome of await Promise.all([first, second]))
      assert.equal(outcome.problem?.reason, BuildProblemCode.Cancelled);
    // The cancelled build stays known until it settles: a new look at the folder starts after it, never beside it.
    const again = builds.ensure(input(dir));
    await waitFor(() => holding.calls.length === 2);
    builds.cancelAll();
    assert.equal((await again).problem?.reason, BuildProblemCode.Cancelled);
  });

  for (const sandboxed of [false, true]) {
    const where = sandboxed ? "under the Seatbelt sandbox" : "with the sandbox off";
    const skip = sandboxed && process.platform !== "darwin" && "the Seatbelt sandbox is macOS's";
    it(`leaves no process behind: a stub cmake that sleeps is gone after cancelAll (${where})`, { skip }, async () => {
      const parent = await realpath(await tmpDir("cpp-stop-"));
      const sandbox = await ProcessSandbox.create({
        enabled: sandboxed,
        writableRoots: [parent],
        scratchDir: path.join(parent, "scratch"),
        secretPaths: [],
      });
      try {
        const pids = path.join(parent, "pids");
        const { builds, store } = await lane((request) => sandbox.run(request), { parent });
        await writeFile(
          store.located.cmake,
          `#!/bin/sh\necho $$ >> '${pids}'\nsleep 300 &\necho $! >> '${pids}'\nwait\n`,
          { mode: 0o755 },
        );
        const building = builds.ensure(input(await cppGame(parent)));
        await waitFor(async () => (await readFile(pids, "utf8").catch(() => "")).trim().includes("\n"));
        const children = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
        assert.equal(children.length, 2);
        builds.cancelAll();
        const outcome = await building;
        assert.equal(outcome.problem?.reason, BuildProblemCode.Cancelled);
        await waitFor(() => !children.some(running));
        assert.deepEqual(children.filter(running), [], "the stub and its sleep are gone");
      } finally {
        await sandbox.dispose();
      }
    });
  }
});

describe("Stop around a run", () => {
  it("starts nothing after a Stop that lands as configure returns, and says cancelled", async () => {
    const calls: RunRequest[] = [];
    let stop = () => {};
    const run = async (request: RunRequest): Promise<RunResult> => {
      // As ProcessSandbox.run does: a signal that is already aborted throws before anything starts.
      request.signal?.throwIfAborted();
      calls.push(request);
      if (isBuildStep(request)) return result(request, await fakeBuild(request));
      const configured = result(request, await fakeConfigure(request));
      stop();
      return configured;
    };
    const { builds, progress } = await lane(run);
    stop = () => builds.cancelAll();
    const outcome = await builds.ensure(input(await cppGame(await realpath(await tmpDir("cpp-game-")))));
    assert.equal(outcome.problem?.reason, BuildProblemCode.Cancelled);
    assert.deepEqual(calls.filter(isBuildStep), [], "the build step never started");
    assert.equal(progress.at(-1)?.phase, BuildPhase.Failed, "the stage hears the build stopped");
  });

  it("says a run the sandbox would not start failed, as a typed problem the stage hears", async () => {
    const run = async (): Promise<RunResult> => {
      throw new Error("sandbox-exec is not available");
    };
    const { builds, progress } = await lane(run);
    const outcome = await builds.ensure(input(await cppGame(await realpath(await tmpDir("cpp-game-")))));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.deepEqual(outcome.problem?.lines, ["sandbox-exec is not available"]);
    assert.equal(progress.at(-1)?.phase, BuildPhase.Failed);
  });

  it("starts a build in a folder only once the build Stop cancelled there has settled", async () => {
    const calls: RunRequest[] = [];
    let active = 0;
    let most = 0;
    const run = async (request: RunRequest): Promise<RunResult> => {
      calls.push(request);
      active++;
      most = Math.max(most, active);
      try {
        if (calls.length > 1) {
          return result(request, await (isBuildStep(request) ? fakeBuild(request) : fakeConfigure(request)));
        }
        // The first configure dies a moment after Stop, as a process group does.
        await aborted(request.signal);
        await sleep(DYING_MS);
        return result(request, { code: null, signal: "SIGKILL" });
      } finally {
        active--;
      }
    };
    const { builds } = await lane(run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const first = builds.ensure(input(dir));
    await waitFor(() => calls.length === 1);
    builds.cancelAll();
    const second = builds.ensure(input(dir));
    const [cancelled, rebuilt] = await Promise.all([first, second]);
    assert.equal(cancelled.problem?.reason, BuildProblemCode.Cancelled);
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.problem));
    assert.equal(most, 1, "the two builds never ran in the same folder at once");
  });
});

/**
 * A host-side copy (a clone of the lead's folder or the lock's em-cache) is part of the build:
 * Stop ends it and frees the slot, as it ends a run. The lane's `cp` is a stub that records its
 * pid and then never finishes while `hang` exists, and is the real `cp` otherwise.
 */
describe("Stop during a host-side copy", { skip: process.platform === "win32" && "POSIX cp" }, () => {
  it("kills the copy, says cancelled, and frees the slot for the next build", async () => {
    const parent = await realpath(await tmpDir("cpp-copy-"));
    const pidFile = path.join(parent, "cp.pid");
    const hang = path.join(parent, "hang");
    const cp = path.join(parent, "slow-cp");
    await writeFile(
      cp,
      `#!/bin/sh\nif [ -e ${shellWord(hang)} ]; then echo $$ > ${shellWord(pidFile)}; exec sleep 60; fi\nexec /bin/cp "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(hang, "");
    const runner = fakeRun();
    // One core: one slot, so the next build can start only once Stop has freed it.
    const { builds } = await lane(runner.run, { cores: 1, cp, parent });
    const first = builds.ensure(input(await cppGame(parent, "first"), { project: "first" }));
    await waitFor(() => exists(pidFile));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(running(pid), "the copy is running");
    builds.cancelAll();
    const cancelled = await first;
    assert.equal(cancelled.problem?.reason, BuildProblemCode.Cancelled);
    await waitFor(() => !running(pid));
    assert.equal(running(pid), false, "the copy is gone");
    assert.equal(runner.calls.length, 0, "nothing ran after the copy was stopped");
    await rm(hang);
    const next = await builds.ensure(input(await cppGame(parent, "second"), { project: "second" }));
    assert.equal(next.ok, true, JSON.stringify(next.problem));
    const leftovers = (await readdir(path.join(parent, "cpp-builds"), { recursive: true })).filter((name) =>
      path.basename(String(name)).startsWith(".clone-"),
    );
    assert.deepEqual(leftovers, [], "no half-made clone is left behind");
  });
});

/**
 * Build folders nothing will build again: a worktree's after the worktree is gone, and one of a
 * lock the store no longer builds with. Each holds a clone of the lock's em-cache, hundreds of
 * megabytes, so the lane sweeps them; a project with a build in flight is left whole.
 */
describe("sweeping the build root", () => {
  const OLD_LOCK: ToolchainLock = { ...LOCK, digest: "0123456789ab".padEnd(64, "0") };

  it("removes the folders of a source that is gone and of an old lock, with what sits beside them, and keeps the rest", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const parent = await realpath(await tmpDir("cpp-sweep-"));
    const game = await gameWithAssets(parent);
    const worktree = await cppGame(parent, "worktree");
    assert.equal((await builds.ensure(input(game))).ok, true);
    assert.equal((await builds.ensure(input(game, { lock: OLD_LOCK }))).ok, true);
    assert.equal((await builds.ensure(input(worktree, { purpose: CppBuildPurpose.Judging }))).ok, true);
    // A worker that never built: its folder is still a clone of the em-cache.
    await rm(path.join(worktree, "src", "main.cpp"));
    await rm(worktree, { recursive: true });
    const kept = path.join(root, `pong-${sha12(game)}`, `web-${DIGEST12}`);
    const before = await filesUnder(kept);

    assert.equal(await builds.sweep(), 2);
    assert.deepEqual(await readdir(root).then((names) => names.sort()), [".genex-tools", `pong-${sha12(game)}`]);
    assert.deepEqual(
      (await readdir(path.dirname(kept))).sort(),
      [
        `web-${DIGEST12}`,
        `web-${DIGEST12}.assets`,
        `web-${DIGEST12}.assets.stamp`,
        `web-${DIGEST12}.built`,
        `web-${DIGEST12}.source`,
      ],
      "the old lock's folder and everything beside it went; the current one is whole",
    );
    assert.deepEqual(await filesUnder(kept), before);
    assert.deepEqual(await readdir(path.join(root, ".genex-tools")), [DIGEST12], "the old lock's helpers went too");
    assert.equal(await builds.sweep(), 0, "a second sweep finds nothing");
    assert.equal((await builds.ensure(input(game))).ok, true, "the kept folder still builds");
  });

  it("leaves a project with a build in flight whole", async () => {
    const holding = holdingRun();
    const { builds, root } = await lane(holding.run);
    const parent = await realpath(await tmpDir("cpp-sweep-"));
    const game = await cppGame(parent);
    const project = path.join(root, `pong-${sha12(game)}`);
    await mkdir(path.join(project, `web-${OLD_LOCK.digest.slice(0, 12)}`), { recursive: true });
    const building = builds.ensure(input(game));
    await waitFor(() => holding.calls.length === 1);
    assert.equal(await builds.sweep(), 0);
    assert.ok(
      await exists(path.join(project, `web-${OLD_LOCK.digest.slice(0, 12)}`)),
      "nothing in a busy project goes",
    );
    builds.cancelAll();
    await building;
    assert.equal(await builds.sweep(), 1, "once it settled, the old lock's folder goes");
  });

  it("never follows a link in the root, and removes nothing outside it", async () => {
    const runner = fakeRun();
    const { builds, root } = await lane(runner.run);
    const parent = await realpath(await tmpDir("cpp-sweep-"));
    const game = await cppGame(parent);
    assert.equal((await builds.ensure(input(game))).ok, true);
    const victim = path.join(parent, "victim");
    await mkdir(path.join(victim, `web-${DIGEST12}`), { recursive: true });
    await writeFile(path.join(victim, `web-${DIGEST12}`, "keep.txt"), "mine");
    await symlink(victim, path.join(root, `other-${"f".repeat(12)}`));
    await symlink(
      path.join(victim, `web-${DIGEST12}`),
      path.join(root, `pong-${sha12(game)}`, `web-${"e".repeat(12)}`),
    );
    await builds.sweep();
    assert.equal(await readFile(path.join(victim, `web-${DIGEST12}`, "keep.txt"), "utf8"), "mine");
  });
});

/** How long the first configure of the overlap row takes to die after Stop. */
const DYING_MS = 200;

/** Resolves once `signal` aborts (at once when it already has). */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** What a victim folder holds, links not followed: each entry's kind, size, mtime and bytes. */
async function contents(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const rel of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, rel);
    const info = await lstat(file);
    const bytes = info.isFile()
      ? createHash("sha256")
          .update(await readFile(file))
          .digest("hex")
      : "";
    found.set(rel, `${kindOf(info)}:${info.size}:${info.mtimeMs}:${bytes}`);
  }
  return found;
}

function kindOf(info: Stats): string {
  if (info.isSymbolicLink()) return "link";
  return info.isDirectory() ? "folder" : "file";
}

/** Where a planting row puts its links: the lane's own names, and the folder outside the root they point at. */
interface Places {
  root: string;
  /** `<root>/<project>-<sha12>`. */
  project: string;
  /** The (lead's) build folder. */
  bin: string;
  /** The wrapper the first build ran, when one did. */
  wrapper: string | null;
  /** Outside the root: a page, a CMake cache and a file of the person's. */
  victim: string;
  victimFile: string;
}

/** Replace whatever is at `at` with a link to `to`, as an agent process that can write there would. */
async function linkAt(at: string, to: string): Promise<void> {
  await rm(at, { recursive: true, force: true });
  await mkdir(path.dirname(at), { recursive: true });
  await symlink(to, at);
}

/** The built stamp's names: beside the build folder, and inside it where an older lane kept it. */
const stamps = (at: Places) => [`${at.bin}.built`, path.join(at.bin, ".genex-built")];

/** One link a row plants, when, and what else it checks. */
interface Planting {
  name: string;
  /** Plant after a first build of the game that worked (so its folder exists), or before any. */
  built: boolean;
  /** Plant from the configure run itself instead of before the build. */
  byConfigure?: boolean;
  /** The build step writes nothing: whatever `out/` is then, it is what the host would serve. */
  buildWritesNothing?: boolean;
  /** Build a second checkout (a worker), seeded from the first, after planting. */
  worker?: boolean;
  plant: (at: Places) => Promise<void>;
  check?: (outcome: Awaited<ReturnType<CppBuilds["ensure"]>>, workerBin: string) => Promise<void>;
}

const PLANTINGS: Planting[] = [
  { name: "the root", built: false, plant: (at) => linkAt(at.root, at.victim) },
  { name: "the project folder", built: false, plant: (at) => linkAt(at.project, at.victim) },
  { name: "the build folder", built: false, plant: (at) => linkAt(at.bin, at.victim) },
  { name: "the build folder, after a build", built: true, plant: (at) => linkAt(at.bin, at.victim) },
  { name: "the wrappers' folder", built: false, plant: (at) => linkAt(path.join(at.root, ".genex-tools"), at.victim) },
  {
    name: "the wrapper",
    built: true,
    plant: async (at) => {
      for (const wrapper of [at.wrapper ?? "", path.join(at.bin, ".genex-tools", "python3")]) {
        await linkAt(wrapper, at.victimFile);
      }
    },
  },
  { name: "the em-cache", built: true, plant: (at) => linkAt(path.join(at.bin, "em-cache"), at.victim) },
  {
    name: "the built stamp",
    built: true,
    plant: async (at) => {
      for (const stamp of stamps(at)) await linkAt(stamp, at.victimFile);
    },
  },
  { name: "out/", built: true, plant: (at) => linkAt(path.join(at.bin, "out"), at.victim) },
  {
    name: "a lead's CMake cache",
    built: true,
    worker: true,
    plant: (at) => linkAt(path.join(at.bin, "CMakeCache.txt"), at.victimFile),
  },
  {
    name: "a lead's build folder",
    built: true,
    worker: true,
    plant: async (at) => {
      await linkAt(at.bin, at.victim);
      for (const stamp of stamps(at)) await writeFile(stamp, at.victim);
    },
    check: async (_outcome, workerBin) => {
      assert.equal(await exists(path.join(workerBin, ".seeded-from")), false, "never seeded through a link");
    },
  },
  {
    name: "out/, by the configure run",
    built: false,
    byConfigure: true,
    buildWritesNothing: true,
    plant: (at) => linkAt(path.join(at.bin, "out"), at.victim),
  },
  {
    name: "the built stamp, by the configure run",
    built: false,
    byConfigure: true,
    plant: async (at) => {
      for (const stamp of stamps(at)) await linkAt(stamp, at.victimFile);
    },
  },
  {
    name: "the build folder, by the configure run",
    built: false,
    byConfigure: true,
    buildWritesNothing: true,
    plant: async (at) => {
      await rename(at.bin, `${at.bin}.moved`);
      await symlink(at.victim, at.bin);
    },
  },
];

/** A folder outside the build root that a followed link would write into or serve from. */
async function victimFolder(parent: string): Promise<{ victim: string; victimFile: string }> {
  const victim = path.join(parent, "victim");
  await mkdir(path.join(victim, "out"), { recursive: true });
  await writeFile(path.join(victim, "index.html"), "<h1>not the game</h1>\n");
  await writeFile(path.join(victim, "out", "index.html"), "<h1>not the game either</h1>\n");
  await writeFile(path.join(victim, "CMakeCache.txt"), "CMAKE_CACHEFILE_DIR:INTERNAL=/victim\n");
  const victimFile = path.join(victim, "file.txt");
  await writeFile(victimFile, "the person's own file\n");
  return { victim, victimFile };
}

/**
 * The fake sandbox of a planting row: once `armed`, its configure plants (for a row that plants
 * from the configure run) and its build writes nothing (for a row that asks so).
 */
function plantingRun(planting: Planting, state: { armed: boolean; places: Places | null }) {
  const configure: Step = async (request) => {
    const configured = await fakeConfigure(request);
    if (state.armed && planting.byConfigure && state.places) await planting.plant(state.places);
    return configured;
  };
  const build: Step = (request) => (state.armed && planting.buildWritesNothing ? { code: 0 } : fakeBuild(request));
  return fakeRun({ configure, build });
}

/** Neither the output nor the fallback of `outcome` is served from inside `victim`. */
async function assertNotServedFrom(victim: string, outcome: Awaited<ReturnType<CppBuilds["ensure"]>>): Promise<void> {
  const realVictim = await realpath(victim);
  for (const served of [outcome.output, outcome.lastGood].filter((p) => p !== null)) {
    assert.equal(isInside(realVictim, await realpath(served)), false, `${served} is outside the root`);
  }
}

describe("links planted in the build root", () => {
  for (const planting of PLANTINGS) {
    it(`never writes or serves outside the root through a link at ${planting.name}`, async () => {
      const parent = await realpath(await tmpDir("cpp-planted-"));
      const { victim, victimFile } = await victimFolder(parent);
      const state: { armed: boolean; places: Places | null } = { armed: false, places: null };
      const runner = plantingRun(planting, state);
      const { builds, root } = await lane(runner.run, { parent });
      const game = await cppGame(parent, "game");
      const project = path.join(root, `pong-${sha12(game)}`);
      const places: Places = {
        root,
        project,
        bin: path.join(project, `web-${DIGEST12}`),
        wrapper: null,
        victim,
        victimFile,
      };
      state.places = places;
      if (planting.built) {
        assert.equal((await builds.ensure(input(game))).ok, true);
        places.wrapper = runner.calls[0]?.env?.EMSDK_PYTHON ?? null;
      }
      if (!planting.byConfigure) await planting.plant(places);
      const before = await contents(victim);
      state.armed = true;
      const worker = planting.worker ? await cppGame(parent, "worker") : game;
      const outcome = await builds.ensure(input(worker));
      assert.deepEqual(await contents(victim), before, "nothing outside the root changed");
      await assertNotServedFrom(victim, outcome);
      const workerBin = path.join(root, `pong-${sha12(worker)}`, `web-${DIGEST12}`);
      await planting.check?.(outcome, workerBin);
    });
  }
});

// ── Windows and Linux, cross-built with the store's zig ─────────────────────────────────────

/** The destinations the lane cross-builds with zig. */
const CROSS_TARGETS = [BuildTarget.Windows, BuildTarget.Linux] as const;
type CrossTarget = (typeof CROSS_TARGETS)[number];

/** The executable a cross build leaves in `out/`. */
const crossExe = (target: CrossTarget): string => NATIVE_CROSS_EXECUTABLES[target];

/** The cross destination a build folder is for, from its name (`windows-<digest12>`). */
function crossTargetOf(bin: string): CrossTarget | null {
  return CROSS_TARGETS.find((target) => path.basename(bin).startsWith(`${target}-`)) ?? null;
}

/**
 * The store's zig and the lock's cross files, as a locate names them once Windows and Linux are
 * prewarmed: `toolchain-<x>.cmake` per destination, its store ANGLE and (Linux) the headers' sysroot.
 * The zig stub fails if anything runs it: the lane only names it through the toolchain file.
 */
async function withCross(store: FakeStore): Promise<void> {
  const lockDir = path.join(store.dir, "locks", DIGEST12);
  const zig = path.join(store.dir, "zig", "0.16.0-eeeeeeeeeeee", "zig");
  await stub(zig, "process.exit(70);");
  const toolchain = (name: string) => path.join(lockDir, `toolchain-${name}.cmake`);
  const zigCache = (name: string) => path.join(lockDir, `zig-cache-${name}`);
  for (const name of ["windows-x64", "linux-x64"]) {
    await writeFile(toolchain(name), `# ${name}\n`);
    // What the prewarm leaves: zig's global cache, holding the libc it built for the target.
    await mkdir(path.join(zigCache(name), "global", "o"), { recursive: true });
    await writeFile(path.join(zigCache(name), "global", "o", "libc.txt"), `${name} libc\n`);
  }
  store.located.zig = zig;
  store.located.cross = {
    [BuildTarget.Windows]: {
      toolchainFile: toolchain("windows-x64"),
      zigCache: zigCache("windows-x64"),
      angle: {
        dir: path.join(store.dir, "angle-windows", "c5bf49e78850-111111111111"),
        manifestSha256: "1".repeat(64),
      },
    },
    [BuildTarget.Linux]: {
      toolchainFile: toolchain("linux-x64"),
      zigCache: zigCache("linux-x64"),
      angle: { dir: path.join(store.dir, "angle-linux", "c5bf49e78850-222222222222"), manifestSha256: "2".repeat(64) },
      sysroot: path.join(store.dir, "linux-sysroot", "almalinux-8.10-0405db2d151e"),
    },
  };
}

/** What genex-<target>.cmake's cross build leaves in `out/`: the game's one executable. */
async function fakeCrossBuild(request: RunRequest): Promise<Partial<RunResult>> {
  const bin = quotedArgs(request.command)[2] ?? "";
  const target = crossTargetOf(bin);
  if (!target) return fakeBuild(request);
  await mkdir(path.join(bin, "out"), { recursive: true });
  await writeFile(path.join(bin, "out", crossExe(target)), `${target} game of ${bin}`);
  return { stdout: `[1/1] Linking CXX executable out/${crossExe(target)}\n` };
}

/** `cmake` for the cross quoting rows: records its argv and the zig caches it was given, and builds the executable. */
function crossRecordingCmake(argvLog: string): string {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const zig = { global: process.env.ZIG_GLOBAL_CACHE_DIR, local: process.env.ZIG_LOCAL_CACHE_DIR };",
    `fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), zig }) + "\\n");`,
    'if (process.argv[2] === "--build") {',
    '  const out = path.join(process.argv[3], "out");',
    "  fs.mkdirSync(out, { recursive: true });",
    '  const exe = path.basename(process.argv[3]).startsWith("windows-") ? "game.exe" : "game";',
    "  fs.writeFileSync(path.join(out, exe), exe);",
    "}",
  ].join("\n");
}

/** A gate stand-in: records every request and answers what `answer` says (admitted by default). */
function fakeGate(answer: (request: CrossAdmissionRequest) => CrossAdmission = admitted) {
  const calls: CrossAdmissionRequest[] = [];
  const admitCross = async (request: CrossAdmissionRequest): Promise<CrossAdmission> => {
    calls.push(request);
    return answer(request);
  };
  return { calls, admitCross };
}

function admitted(request: CrossAdmissionRequest): CrossAdmission {
  return {
    ok: true,
    target: request.target,
    out: request.out,
    outFolder: { real: request.out, dev: 1, ino: 1 },
    facts: { imports: ["libGLESv2.dll"], maxGlibc: null },
  };
}

const OPENGL_DETAIL = "game.exe imports OPENGL32.dll: the game must draw through the bundled ANGLE";
const OPENGL_REFUSAL: CrossAdmission = {
  ok: false,
  refusal: NativeRefusal.ImportsOpengl32,
  file: "game.exe",
  detail: OPENGL_DETAIL,
};

interface CrossLane extends Lane {
  gate: ReturnType<typeof fakeGate>;
  checks: Array<[string, BuildTarget, DestinationCheck]>;
}

/** A lane whose store has zig and both cross destinations, whose gate and library are recorded. */
async function crossLane(
  run: CppBuildsOptions["run"],
  over: Partial<CppBuildsOptions> & { parent?: string; gate?: ReturnType<typeof fakeGate> } = {},
): Promise<CrossLane> {
  const { gate = fakeGate(), ...rest } = over;
  const checks: CrossLane["checks"] = [];
  const made = await lane(run, {
    platform: "darwin",
    admitCross: gate.admitCross,
    writeCheck: async (project, target, check) => {
      checks.push([project, target, check]);
    },
    ...rest,
  });
  await withCross(made.store);
  return { ...made, gate, checks };
}

/** A build of the game folder for a cross destination, recorded in the library. */
const crossInput = (dir: string, target: CrossTarget, over: Partial<CppBuildInput> = {}) =>
  input(dir, { target, destinations: EVERYWHERE, recordLock: true, ...over });

/** The check the lane records at the fake clock (1 000 ms). */
const check = (badge: DestinationBadge, refusal?: NativeRefusal): DestinationCheck => ({
  badge,
  lock: DIGEST12,
  at: new Date(1_000).toISOString(),
  ...(refusal ? { refusal } : {}),
});

describe("the Windows and Linux lane's commands", () => {
  for (const target of CROSS_TARGETS) {
    for (const hostile of HOSTILE_PARENTS.filter((name) => !name.includes("\n"))) {
      it(`configures ${target} with the lock's toolchain and genex files, zig's caches in its own folder, every path quoted (${JSON.stringify(hostile)})`, async () => {
        const parent = path.join(await realpath(await tmpDir("cpp-cross-quote-")), hostile);
        await mkdir(parent, { recursive: true });
        const { builds, root, store } = await crossLane(shellRunner().run, { parent });
        await stub(store.located.cmake, crossRecordingCmake(store.argvLog));
        const dir = await cppGame(parent);
        const outcome = await builds.ensure(crossInput(dir, target));
        assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
        const bin = path.join(root, `pong-${sha12(dir)}`, `${target}-${DIGEST12}`);
        assert.equal(outcome.output, path.join(bin, "out"));
        const runs = (await readFile(store.argvLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { argv: string[]; zig: { global?: string; local?: string } });
        assert.deepEqual(
          runs.map((run) => run.argv),
          [
            [
              "-S",
              dir,
              "-B",
              bin,
              "-G",
              "Ninja",
              `-DCMAKE_MAKE_PROGRAM=${store.located.ninja}`,
              `-DGENEX_CMAKE=${store.located.genexCmake[target]}`,
              `-DCMAKE_TOOLCHAIN_FILE=${store.located.cross?.[target]?.toolchainFile}`,
              `-DGENEX_ASSETS=${bin}.assets`,
              `-DGENEX_ASSETS_STAMP=${bin}.assets.stamp`,
              "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
            ],
            ["--build", bin, "-j4"],
          ],
        );
        const caches = { global: path.join(bin, "zig-cache", "global"), local: path.join(bin, "zig-cache", "local") };
        assert.deepEqual(
          runs.map((run) => run.zig),
          [caches, caches],
          "zig caches inside the build folder, never the home folder",
        );
        assert.deepEqual(await findNamed(path.dirname(parent), "PWNED"), [], "no command substitution ran");
      });
    }
  }

  for (const [target, cross] of [
    [BuildTarget.Windows, "windows-x64"],
    [BuildTarget.Linux, "linux-x64"],
  ] as const) {
    it(`a new ${target} build folder starts from the lock's prewarmed zig cache, cloned once`, async () => {
      // Without it, a new game's first cross build compiles zig's libc and libc++ for the target
      // again: minutes on a small Linux host, past the configure deadline.
      const runner = fakeRun({ build: fakeCrossBuild });
      const { builds } = await crossLane(runner.run);
      const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
      assert.equal((await builds.ensure(crossInput(dir, target))).ok, true);
      const bin = runner.calls[0]?.cwd ?? "";
      const libc = path.join(bin, "zig-cache", "global", "o", "libc.txt");
      assert.equal(await readFile(libc, "utf8"), `${cross} libc\n`);
      await writeFile(libc, "this folder's own\n");
      await writeFile(path.join(dir, "src", "main.cpp"), "// changed\n");
      assert.equal((await builds.ensure(crossInput(dir, target))).ok, true);
      assert.equal(await readFile(libc, "utf8"), "this folder's own\n", "a folder's own cache is never replaced");
    });
  }

  it("refuses a cross build whose folder CMake cannot be told (a newline), before anything runs", async () => {
    const parent = path.join(await realpath(await tmpDir("cpp-cross-newline-")), "new\nline");
    await mkdir(parent, { recursive: true });
    const runner = fakeRun({ build: fakeCrossBuild });
    const { builds, gate, checks } = await crossLane(runner.run, { parent });
    const outcome = await builds.ensure(crossInput(await cppGame(parent), BuildTarget.Linux));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.deepEqual(runner.calls, [], "nothing ran");
    assert.deepEqual(gate.calls, []);
    assert.deepEqual(checks, [], "a folder the host could not use is no check of the destination");
  });

  it("names no zig in a Mac or a web build's argv or environment", async () => {
    const runner = fakeRun();
    const { builds, store } = await crossLane(runner.run, { exec: xcode(MAC_SDK).exec });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    for (const target of [BuildTarget.Web, BuildTarget.Mac]) {
      const outcome = await builds.ensure(input(dir, { target, destinations: EVERYWHERE }));
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    }
    assert.equal(runner.calls.length, 4);
    const zigFiles = [
      store.located.zig ?? "",
      ...CROSS_TARGETS.map((t) => store.located.cross?.[t]?.toolchainFile ?? ""),
    ];
    for (const call of runner.calls) {
      for (const named of zigFiles) assert.ok(!call.command.includes(named), `${call.command} names ${named}`);
      assert.doesNotMatch(call.command, /zig|toolchain-(?:windows|linux)/);
      assert.deepEqual(
        Object.keys(call.env ?? {}).filter((key) => key.startsWith("ZIG_")),
        [],
        "no zig cache for a build that runs no zig",
      );
    }
  });

  it("runs a cross build under the same per-run sandbox: its own folder writable, the game, the store and the native runs denied", async () => {
    const runner = fakeRun({ build: fakeCrossBuild });
    const { builds } = await crossLane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(crossInput(dir, BuildTarget.Windows));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.deepEqual(call.policy?.allowWrite, [call.cwd]);
      for (const denied of [dir, TOOLCHAINS, NATIVE_RUNS]) assert.ok(call.policy?.denyWrite?.includes(denied), denied);
      assert.equal(call.policy?.allowedDomains, undefined, "the lane names no domain");
      assert.equal(call.env?.EM_CACHE, undefined, "a cross build runs no emcc");
      assert.equal(call.timeoutMs, isBuildStep(call) ? CPP_BUILD_TIMEOUT_MS.windows : CPP_CONFIGURE_TIMEOUT_MS);
    }
  });
});

describe("what the Windows and Linux lane refuses before anything runs", () => {
  const withoutZig = (located: LocatedToolchain): LocatedToolchain => {
    const { zig: _zig, ...rest } = located;
    return rest;
  };
  const withoutCross =
    (target: CrossTarget) =>
    (located: LocatedToolchain): LocatedToolchain => {
      const cross = { ...located.cross };
      delete cross[target];
      return { ...located, cross };
    };
  for (const target of CROSS_TARGETS) {
    for (const [name, strip] of [
      ["no zig", withoutZig],
      ["no cross files for it", withoutCross(target)],
    ] as const) {
      it(`refuses ${target} with ${name} in the store as a missing toolchain naming zig`, async () => {
        const runner = fakeRun({ build: fakeCrossBuild });
        const { builds, gate, checks, root, store } = await crossLane(runner.run);
        store.located = strip(store.located);
        const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
        const outcome = await builds.ensure(crossInput(dir, target));
        assert.equal(outcome.ok, false);
        assert.equal(outcome.ran, false);
        assert.equal(outcome.problem?.reason, BuildProblemCode.ToolchainMissing);
        assert.deepEqual(outcome.problem?.lines, [ToolchainId.Zig]);
        assert.deepEqual(runner.calls, []);
        assert.deepEqual(gate.calls, []);
        assert.deepEqual(checks, [], "a missing toolchain is no check of the destination");
        assert.equal(await exists(path.join(root, `pong-${sha12(dir)}`, `${target}-${DIGEST12}`)), false);
      });
    }
  }

  it("builds Windows and Linux on a Linux host, and refuses the Mac there as mac-builds-need-a-mac", async () => {
    const runner = fakeRun({ build: fakeCrossBuild });
    const { builds, located } = await crossLane(runner.run, { platform: "linux" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const mac = await builds.ensure(crossInput(dir, BuildTarget.Windows, { target: BuildTarget.Mac }));
    assert.equal(mac.problem?.reason, BuildProblemCode.MacBuildsNeedAMac);
    assert.equal(mac.ran, false);
    assert.deepEqual(located, [], "nothing was located for the Mac");
    assert.equal(runner.calls.length, 0);
    for (const target of CROSS_TARGETS) {
      const outcome = await builds.ensure(crossInput(dir, target));
      assert.equal(outcome.ok, true, `${target}: ${JSON.stringify(outcome.problem)}`);
    }
  });

  it("refuses a cross destination the game does not name, before anything runs", async () => {
    const runner = fakeRun({ build: fakeCrossBuild });
    const { builds, gate } = await crossLane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(crossInput(dir, BuildTarget.Linux, { destinations: BROWSER_AND_MAC }));
    assert.equal(outcome.problem?.reason, BuildProblemCode.NotADestination);
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(gate.calls, []);
  });
});

describe("the Windows and Linux lane's gate and check", () => {
  for (const target of CROSS_TARGETS) {
    it(`admits ${target}'s out/ through the gate with the lock's store ANGLE, serves it, and records not-run-here on a Mac`, async () => {
      const runner = fakeRun({ build: fakeCrossBuild });
      const { builds, root, store, gate, checks, progress } = await crossLane(runner.run);
      const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
      const outcome = await builds.ensure(crossInput(dir, target));
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const out = path.join(root, `pong-${sha12(dir)}`, `${target}-${DIGEST12}`, "out");
      assert.equal(outcome.output, out);
      assert.equal(outcome.lastGood, out);
      assert.deepEqual(gate.calls, [{ target, out, angle: store.located.cross?.[target]?.angle }]);
      assert.deepEqual(checks, [["pong", target, check(DestinationBadge.NotRunHere)]]);
      assert.equal(progress.at(-1)?.phase, BuildPhase.Done);
    });
  }

  it("records built for Linux on a Linux host, and not-run-here for Windows there", async () => {
    const runner = fakeRun({ build: fakeCrossBuild });
    const { builds, checks } = await crossLane(runner.run, { platform: "linux" });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    for (const target of CROSS_TARGETS) assert.equal((await builds.ensure(crossInput(dir, target))).ok, true);
    assert.deepEqual(checks, [
      ["pong", BuildTarget.Windows, check(DestinationBadge.NotRunHere)],
      ["pong", BuildTarget.Linux, check(DestinationBadge.Built)],
    ]);
  });

  it("refuses what the gate refuses as gate-refused, with its refusal and file, records the failed check, and serves nothing", async () => {
    const runner = fakeRun({
      build: async (request) => {
        const result = await fakeCrossBuild(request);
        const bin = quotedArgs(request.command)[2] ?? "";
        await writeFile(
          path.join(bin, "out", "game.exe"),
          writePe({ imports: ["opengl32.dll", "KERNEL32.dll"] }).bytes,
        );
        return result;
      },
    });
    const gate = fakeGate(() => OPENGL_REFUSAL);
    const { builds, checks, progress } = await crossLane(runner.run, { gate });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(crossInput(dir, BuildTarget.Windows));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, true);
    assert.equal(outcome.output, null, "a refused build is never served");
    assert.equal(outcome.lastGood, null, "nor fallen back on");
    assert.equal(outcome.problem?.reason, BuildProblemCode.GateRefused);
    assert.equal(outcome.nativeAdmission?.refusal, NativeRefusal.ImportsOpengl32);
    assert.deepEqual(outcome.nativeAdmission?.imports, ["opengl32.dll", "KERNEL32.dll"]);
    assert.equal(outcome.problem?.target, BuildTarget.Windows);
    assert.deepEqual(outcome.problem?.gate, { refusal: NativeRefusal.ImportsOpengl32, file: "game.exe" });
    assert.deepEqual(outcome.problem?.lines, [OPENGL_DETAIL]);
    assert.equal(outcome.problem?.at, new Date(1_000).toISOString());
    assert.equal(progress.at(-1)?.phase, BuildPhase.Failed);
    assert.deepEqual(checks, [
      ["pong", BuildTarget.Windows, check(DestinationBadge.Failed, NativeRefusal.ImportsOpengl32)],
    ]);
  });

  it("falls back only on an out/ the gate admitted, and only while its executable is the one admitted", async () => {
    let refuse = true;
    let step: Step = fakeCrossBuild;
    const runner = fakeRun({ build: (request) => step(request) });
    const gate = fakeGate((request) => (refuse ? OPENGL_REFUSAL : admitted(request)));
    const { builds } = await crossLane(runner.run, { gate });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const failing: Step = () => ({ code: 1, stderr: "ld.lld: error: undefined symbol: genex_missing\n" });
    assert.equal((await builds.ensure(crossInput(dir, BuildTarget.Linux))).ok, false);
    step = failing;
    const afterRefusal = await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.equal(afterRefusal.lastGood, null, "the refused out/ is no fallback");
    refuse = false;
    step = fakeCrossBuild;
    const good = await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.equal(good.ok, true, JSON.stringify(good.problem));
    step = failing;
    const afterGood = await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.equal(afterGood.lastGood, good.output, "the admitted out/ is the fallback");
    step = async () => {
      await writeFile(path.join(good.output ?? "", "game"), "not the admitted game");
      return { code: 1, stderr: "error: the build changed the game and failed" };
    };
    const tampered = await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.equal(tampered.lastGood, null, "an executable changed since admission is no fallback");
  });

  it("records a failed check when the build itself fails, and none when it is cancelled", async () => {
    const runner = fakeRun({ configure: () => ({ code: 1, stderr: "CMake Error: no zig\n" }) });
    const { builds, gate, checks } = await crossLane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const failed = await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.equal(failed.problem?.reason, BuildProblemCode.CommandFailed);
    assert.deepEqual(gate.calls, [], "a build that failed is never admitted");
    assert.deepEqual(checks, [["pong", BuildTarget.Linux, check(DestinationBadge.Failed)]]);
    const holding = holdingRun();
    const stopped = await crossLane(holding.run);
    const building = stopped.builds.ensure(crossInput(dir, BuildTarget.Windows));
    await waitFor(() => holding.calls.length === 1);
    stopped.builds.cancelAll();
    const cancelled = await building;
    assert.equal(cancelled.problem?.reason, BuildProblemCode.Cancelled);
    assert.equal(holding.calls[0]?.signal?.aborted, true, "Stop reached the run");
    assert.deepEqual(stopped.gate.calls, []);
    assert.deepEqual(stopped.checks, [], "a cancelled build is no check");
  });

  it("says a cross build that left no executable failed, asks no gate, and records the failure", async () => {
    const runner = fakeRun({ build: () => ({ code: 0 }) });
    const { builds, gate, checks } = await crossLane(runner.run);
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const outcome = await builds.ensure(crossInput(dir, BuildTarget.Windows));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.match(outcome.problem?.lines[0] ?? "", /out\/game\.exe/);
    assert.deepEqual(gate.calls, []);
    assert.deepEqual(checks, [["pong", BuildTarget.Windows, check(DestinationBadge.Failed)]]);
  });

  it("writes a check once per change, and again after a write that failed", async () => {
    let refuse = false;
    let broken = true;
    const runner = fakeRun({ build: fakeCrossBuild });
    const gate = fakeGate((request) => (refuse ? OPENGL_REFUSAL : admitted(request)));
    const checks: Array<[string, BuildTarget, DestinationCheck]> = [];
    const { builds } = await crossLane(runner.run, {
      gate,
      writeCheck: async (project, target, written) => {
        if (broken) {
          broken = false;
          throw new Error("the library is busy");
        }
        checks.push([project, target, written]);
      },
    });
    const dir = await cppGame(await realpath(await tmpDir("cpp-game-")));
    const first = await builds.ensure(crossInput(dir, BuildTarget.Windows));
    assert.equal(first.ok, true, "a check that cannot be written does not undo a build");
    await builds.ensure(crossInput(dir, BuildTarget.Windows));
    await builds.ensure(crossInput(dir, BuildTarget.Windows));
    refuse = true;
    await builds.ensure(crossInput(dir, BuildTarget.Windows));
    await builds.ensure(crossInput(dir, BuildTarget.Windows));
    refuse = false;
    await builds.ensure(crossInput(dir, BuildTarget.Windows));
    assert.deepEqual(
      checks.map(([, , written]) => written.badge),
      [DestinationBadge.NotRunHere, DestinationBadge.Failed, DestinationBadge.NotRunHere],
    );
  });

  it("never records a check for a worktree's build, though the gate still decides what is served", async () => {
    const runner = fakeRun({ build: fakeCrossBuild });
    const gate = fakeGate(() => OPENGL_REFUSAL);
    const { builds, checks } = await crossLane(runner.run, { gate });
    const worktree = await cppGame(await realpath(await tmpDir("cpp-game-")), "worktree");
    for (const recordLock of [false, undefined]) {
      const outcome = await builds.ensure(crossInput(worktree, BuildTarget.Linux, { recordLock }));
      assert.equal(outcome.problem?.reason, BuildProblemCode.GateRefused);
      assert.equal(outcome.output, null);
    }
    assert.equal(gate.calls.length, 2);
    assert.deepEqual(checks, []);
  });

  it("stages the game's assets beside its folder and asks genex.cmake to copy them again once out/assets is gone", async () => {
    const markers: boolean[] = [];
    const build: Step = async (request) => {
      const bin = quotedArgs(request.command)[2] ?? "";
      markers.push(await exists(path.join(bin, "genex-assets.done")));
      await writeFile(path.join(bin, "genex-assets.done"), "");
      const built = await fakeCrossBuild(request);
      await mkdir(path.join(bin, "out", "assets"), { recursive: true });
      return built;
    };
    const runner = fakeRun({ build });
    const { builds } = await crossLane(runner.run);
    const dir = await gameWithAssets(await realpath(await tmpDir("cpp-game-")));
    const first = await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.equal(first.ok, true, JSON.stringify(first.problem));
    assert.deepEqual(await filesUnder(`${path.dirname(first.output ?? "")}.assets`), ["levels/one.json", "player.png"]);
    await builds.ensure(crossInput(dir, BuildTarget.Linux));
    await rm(path.join(first.output ?? "", "assets"), { recursive: true });
    await builds.ensure(crossInput(dir, BuildTarget.Linux));
    assert.deepEqual(markers, [false, true, false], "kept while out/assets is there, gone once it is not");
  });

  it("never asks the gate about, serves or writes through an out/ its run replaced with a link", {
    skip: process.platform === "win32" && "POSIX links",
  }, async () => {
    const parent = await realpath(await tmpDir("cpp-cross-planted-"));
    const { victim } = await victimFolder(parent);
    await writeFile(path.join(victim, "game.exe"), "not the game");
    const build: Step = async (request) => {
      await linkAt(path.join(quotedArgs(request.command)[2] ?? "", "out"), victim);
      return { code: 0 };
    };
    const runner = fakeRun({ build });
    const { builds, gate } = await crossLane(runner.run, { parent });
    const before = await contents(victim);
    const outcome = await builds.ensure(crossInput(await cppGame(parent), BuildTarget.Windows));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output, null);
    assert.equal(outcome.lastGood, null);
    assert.deepEqual(gate.calls, [], "nothing reached through a link is admitted");
    assert.deepEqual(await contents(victim), before, "nothing outside the root changed");
  });
});

describe("zig's diagnostics", () => {
  it("reads the linkers zig drives (lld-link for Windows, ld.lld for Linux) as zig's errors", () => {
    const output = [
      "[2/2] Linking CXX executable out/game.exe",
      "lld-link: error: undefined symbol: genex_missing()",
      ">>> referenced by /GAME/src/main.cpp:2",
      "ld.lld: error: undefined symbol: genex_other()",
      "error: unable to find dynamic system library 'foo'",
    ].join("\n");
    assert.deepEqual(parseDiagnostics(output, "/GAME"), [
      { tool: DiagnosticTool.Zig, file: null, line: null, column: null, message: "undefined symbol: genex_missing()" },
      { tool: DiagnosticTool.Zig, file: null, line: null, column: null, message: "undefined symbol: genex_other()" },
      {
        tool: DiagnosticTool.Zig,
        file: null,
        line: null,
        column: null,
        message: "unable to find dynamic system library 'foo'",
      },
    ]);
  });
});

describe("a cold zig build's output", () => {
  /**
   * zig builds libc++ for the target into a new build folder's cache on its first build and prints
   * some 5 MB of its own warnings doing it (`-Wnullability-completeness`, measured with zig 0.16.0):
   * the game's own error comes after them.
   */
  const ZIG_FLOOD_BYTES = 5 * 1024 * 1024;
  const floodingCmake = [
    'if (process.argv[2] === "--build") {',
    '  const line = "zig/lib/libcxx/include/string:1078:80: warning: pointer is missing a nullability type specifier\\n";',
    `  process.stdout.write(line.repeat(Math.ceil(${ZIG_FLOOD_BYTES} / line.length)));`,
    '  process.stdout.write("ld.lld: error: undefined symbol: genex_missing\\n");',
    "  process.exitCode = 1;",
    "}",
  ].join("\n");

  it("keeps the game's error after zig's own libc++ warnings, through the real sandbox's capture", async () => {
    const parent = await realpath(await tmpDir("cpp-cross-flood-"));
    const sandbox = await ProcessSandbox.create({
      enabled: false,
      writableRoots: [parent],
      scratchDir: path.join(parent, "scratch"),
      secretPaths: [],
    });
    try {
      const { builds, store } = await crossLane((request) => sandbox.run(request), { parent });
      await stub(store.located.cmake, floodingCmake);
      const outcome = await builds.ensure(crossInput(await cppGame(parent), BuildTarget.Linux));
      assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
      assert.deepEqual(outcome.problem?.diagnostics, [
        { tool: DiagnosticTool.Zig, file: null, line: null, column: null, message: "undefined symbol: genex_missing" },
      ]);
    } finally {
      await sandbox.dispose();
    }
  });
});
