/**
 * The late-writer gate for a Rust · wgpu game's Mac run (plan: immutable admitted outputs, a Mac
 * promotion gate): the Rust lane (`RustBuilds`) admits a copy of the build's `out/` outside every
 * build-writable folder and records its digests in the receipt; preparing a run
 * (`prepareNativeRun`, `native-prepare.ts`) assembles `Game.app` only from those very bytes
 * (`assembleWgpuRunDir`, `native-bundle.ts`). A write that reaches the admitted copy after
 * admission (the executable or an asset changed in place or replaced, an asset added or removed,
 * an asset rewritten while the host copies it) is refused with nothing signed and no run directory
 * left, and so is a build whose lane recorded no digests. Under the real Seatbelt sandbox, a
 * build-script stand-in that leaves a process group writing `out/` after the build never reaches
 * the run: the run gets the admitted bytes.
 *
 * The toolchain is a stub cargo and rustc (POSIX shell) whose build emits a Mach-O image written
 * in the test (load commands only, so admission reads it on every platform); only `codesign` is
 * stood in. The Seatbelt row runs only on macOS; `GENEX_REQUIRE_TOOLCHAINS=1` turns its skip into
 * a failure.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import type { NativePrepareRequest, PreparedRun } from "../../src/main/core/native-runs.ts";
import { type BuildOutcome, type GameBuildLane, GameBuildLanes } from "../../src/main/game-build.ts";
import {
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import {
  BuildTarget,
  destinationsOf,
  type GameProject,
  GameStack,
  ProjectKind,
} from "../../src/shared/game-project.ts";
import { NATIVE_BUNDLE_APP, NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { assembleWgpuRunDir, removeRunDir } from "../../src/substrate/native-bundle.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { ApplePlatform, buildVersion } from "../fixtures/rust-bundles/binaries.ts";
import { LoadCommand, loadCommand, machO } from "../helpers/macho.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const PROJECT = "ferris";
const RUN_ID = "0123456789abcdef";
const BUNDLE_ID = "games.genex.game.0123456789ab";
const HEADLESS_EXE = "game-headless";
const ASSET = "assets/fish.txt";
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};
const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
const RUSTC_VV = [
  "rustc 1.99.0 (1d4e1a2b3 2026-09-17)",
  "binary: rustc",
  "commit-hash: 1d4e1a2b3c4d5e6f",
  "commit-date: 2026-09-17",
  "host: aarch64-apple-darwin",
  "release: 1.99.0",
  "LLVM version: 21.1.2",
].join("\n");
const LOCK_FILE = [
  "version = 4",
  "",
  "[[package]]",
  'name = "game"',
  'version = "0.0.0"',
  'dependencies = ["genex"]',
  "",
  "[[package]]",
  'name = "genex"',
  'version = "0.1.0"',
  "",
].join("\n");
/** How long the left-behind writer waits after starting before it writes. */
const LATE_WRITER_DELAY_S = 1;
/** How long the Seatbelt row gives that writer: twice its delay. */
const LATE_WRITER_GRACE_MS = 2 * LATE_WRITER_DELAY_S * SECOND_MS;
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub cargo is a POSIX shell script" : false;
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";

/** The Seatbelt row's skip: macOS only, a failure under `GENEX_REQUIRE_TOOLCHAINS=1`. */
function needsSeatbelt(): { skip?: string } {
  if (process.platform === "darwin") return {};
  if (REQUIRED) throw new Error("GENEX_REQUIRE_TOOLCHAINS=1: the late-writer gate needs macOS's Seatbelt sandbox");
  return { skip: "the Seatbelt sandbox is macOS's" };
}

/** What the real pond imports: Apple's frameworks and `/usr/lib` only, no rpath. */
const SYSTEM_IMPORTS = [
  "/System/Library/Frameworks/Metal.framework/Versions/A/Metal",
  "/System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore",
  "/usr/lib/libSystem.B.dylib",
];

/** A thin arm64 macOS executable the Rust Mac policy admits; `minos` tells two of them apart. */
function wgpuGame(minos = "11.0"): Buffer {
  const commands = SYSTEM_IMPORTS.map((value) => loadCommand({ cmd: LoadCommand.LoadDylib, value }));
  return machO({}, [...commands, buildVersion(ApplePlatform.MacOs, minos)]);
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** `text` as one single-quoted shell word. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The stub cargo: the lock, a passing clippy, and a build that copies `image` as the game's
 * executable, runs `onBuild` (with `$exe` set) and reports the artifact as Cargo's JSON does.
 */
function stubCargo(image: string, onBuild: string): string {
  const artifact =
    '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
    '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';
  return `#!/bin/sh
sub=$1
shift
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  generate-lockfile)
    printf '%s' ${shellWord(LOCK_FILE)} > "$(dirname "$manifest")/Cargo.lock"
    ;;
  clippy)
    echo '{"reason":"build-finished","success":true}'
    ;;
  build)
    exe="$CARGO_TARGET_DIR/aarch64-apple-darwin/debug/game"
    mkdir -p "$(dirname "$exe")"
    cat ${shellWord(image)} > "$exe"
    chmod +x "$exe"
    ${onBuild || ":"}
    echo '${artifact}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;
}

/** A Rust game folder: its genex.toml, its sources and one asset. */
async function rustGameDir(parent: string): Promise<string> {
  const dir = path.join(parent, PROJECT);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Ferris"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  await writeFile(path.join(dir, ASSET), "fish");
  return dir;
}

/** A stand-in for the shipped stager: copies src/ and assets/ and writes a manifest naming genex. */
async function stage(game: { dir: string }, into: string): Promise<RustStaged> {
  for (const folder of ["src", "assets"]) {
    await mkdir(path.join(into, folder), { recursive: true });
    for (const name of await readdir(path.join(game.dir, folder))) {
      await writeFile(path.join(into, folder, name), await readFile(path.join(game.dir, folder, name)));
    }
  }
  const manifest =
    '[package]\nname = "game"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\ngenex = "=0.1.0"\n';
  await writeFile(path.join(into, "Cargo.toml"), manifest);
  return { ok: true, dependencies: ["genex"], nativeFeatures: [] };
}

/** The Command Line Tools as `xcode-select -p` and `xcrun --show-sdk-path` answer them. */
const xcode: XcodeExec = async (file) =>
  file.endsWith("xcode-select")
    ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
    : { code: 0, stdout: `${MAC_SDK}\n`, stderr: "" };

/** `request` run by /bin/sh with no containment, as a build sandbox's `run` answers it. */
async function runShell(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false,
        sandboxed: false,
        command: request.command,
        cwd: request.cwd,
      }),
    );
  });
}

/** The build sandbox without containment: for the rows where the host itself writes late. */
async function openSandbox(_spec: RustBuildSandboxSpec): Promise<RustBuildSandbox> {
  return { run: runShell, dispose: async () => {} };
}

interface Rig {
  parent: string;
  game: GameProject;
  builds: RustBuilds;
  runs: string;
  signed: string[][];
  deps: (overrides?: Partial<NativePrepareDeps>) => NativePrepareDeps;
}

/** The Rust lane over the stub toolchain, a game in the library, and the deps that prepare its runs. */
async function rig(name: string, sandbox: RustBuildsOptions["sandbox"], onBuild = ""): Promise<Rig> {
  const parent = await realpath(await tmpDir(name));
  const toolchain = path.join(parent, "toolchain");
  const bin = path.join(toolchain, "bin");
  await mkdir(bin, { recursive: true });
  const image = path.join(toolchain, "game-image");
  await writeFile(image, wgpuGame());
  await writeFile(path.join(bin, "cargo"), stubCargo(image, onBuild), { mode: 0o755 });
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s\\n' ${shellWord(RUSTC_VV)}\n`, { mode: 0o755 });
  const vendor = path.join(toolchain, "vendor");
  const conf = path.join(toolchain, "clippy");
  await mkdir(vendor, { recursive: true });
  await mkdir(conf, { recursive: true });
  await writeFile(path.join(conf, "clippy.toml"), "disallowed-types = []\n");
  const builds = new RustBuilds({
    root: path.join(parent, "rust-builds"),
    sandbox,
    locate: async () => ({ ok: true, toolchain: { bin, vendor, clippyConf: conf, reads: [toolchain] } }),
    currentLock: async () => LOCK,
    stage,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    exec: xcode,
  });
  const game = rustProject(await rustGameDir(parent));
  const runs = path.join(parent, "runs");
  const signed: string[][] = [];
  const deps = (overrides: Partial<NativePrepareDeps> = {}): NativePrepareDeps => ({
    root: runs,
    host: StudioPlatform.Mac,
    gameBox: () => true,
    games: { list: async () => [game], bundleIdFor: async () => BUNDLE_ID },
    gameBuilds: new GameBuildLanes({ [GameStack.RustWgpu]: builds }),
    toolchains: {
      currentLock: async () => LOCK,
      locate: async () => assert.fail("a wgpu game's run never asks the store for ANGLE"),
    },
    exec: async (file, args) => {
      signed.push([file, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  });
  return { parent, game, builds, runs, signed, deps };
}

function rustProject(dir: string): GameProject {
  return {
    name: PROJECT,
    dir,
    title: "Ferris",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/ferris",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    built: false,
    shape: {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
  };
}

function headless(): NativePrepareRequest {
  return { project: PROJECT, target: BuildTarget.Mac, mode: NativeRunMode.Headless, runId: RUN_ID };
}

/** The lane's admitted Mac build: its `out/` copy and the digests its receipt recorded. */
async function admitted(r: Rig): Promise<{ out: string; digests: Map<string, string> }> {
  const outcome = await r.builds.ensure(
    { project: PROJECT, dir: r.game.dir, shape: r.game.shape, destinations: destinationsOf(r.game), lock: LOCK },
    BuildTarget.Mac,
    CppBuildPurpose.Judging,
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
  const outputs = outcome.rust?.receipt?.outputs ?? [];
  return { out: outcome.output ?? "", digests: new Map(outputs.map((file) => [file.path, file.sha256])) };
}

/** The typed refusal `work` is rejected with. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    (prepared) => assert.fail(`prepared, not refused: ${JSON.stringify(prepared)}`),
    (error: unknown) => {
      assert.ok(error instanceof NativeError, `typed: ${String(error)}`);
      return error.refusal;
    },
  );
}

/**
 * The real lane, with `late` writing its admitted `out/` once the lane has answered: every write
 * lands after admission and before the run is assembled, as a writer the build left behind would.
 */
function writingLate(lane: GameBuildLane, late: LateWrite): GameBuildLane {
  return {
    ensure: async (game, target, purpose, options) => {
      const outcome = await lane.ensure(game, target, purpose, options);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      await late.write(outcome.output ?? "");
      return outcome;
    },
    cancelAll: () => lane.cancelAll(),
    cancelGame: (project) => lane.cancelGame(project),
    sweep: () => lane.sweep(),
  };
}

const runsIn = (root: string): Promise<string[]> => readdir(root).catch(() => []);

/** A write that reaches the admitted `out/` after admission, and what it does there. */
interface LateWrite {
  name: string;
  write: (out: string) => Promise<void>;
}

const LATE_WRITES: readonly LateWrite[] = [
  {
    name: "the executable rewritten in place with another admissible image",
    write: (out) => writeFile(path.join(out, HEADLESS_EXE), wgpuGame("12.0"), { flag: "r+" }),
  },
  {
    name: "the executable replaced by a new file",
    write: async (out) => {
      const next = path.join(out, "next");
      await writeFile(next, wgpuGame("13.0"), { mode: 0o755 });
      await rename(next, path.join(out, HEADLESS_EXE));
    },
  },
  { name: "an asset rewritten", write: (out) => writeFile(path.join(out, ASSET), "shark", { flag: "r+" }) },
  { name: "an asset added", write: (out) => writeFile(path.join(out, "assets", "extra.txt"), "extra") },
  { name: "an asset removed", write: (out) => rm(path.join(out, ASSET)) },
];

describe("a Rust game's Mac run uses only the bytes its lane admitted", { skip: SKIP_ON_WINDOWS }, () => {
  it("assembles the run from the admitted copy and names its digest and lock in the run's build", async (t) => {
    const r = await rig("rust-late-writer-ok-", openSandbox);
    const { out, digests } = await admitted(r);
    const prepared: PreparedRun = await prepareNativeRun(r.deps(), headless(), new AbortController().signal);
    t.after(() => removeRunDir(prepared.runDir));
    const exe = await readFile(prepared.exe);
    assert.equal(sha256(exe), digests.get(HEADLESS_EXE));
    assert.deepEqual(exe, await readFile(path.join(out, HEADLESS_EXE)));
    const asset = path.join(prepared.bundle, NATIVE_BUNDLE_APP, "Contents", "Resources", ASSET);
    assert.equal(await readFile(asset, "utf8"), "fish");
    assert.deepEqual(prepared.build, {
      stack: GameStack.RustWgpu,
      target: BuildTarget.Mac,
      digest: digests.get(HEADLESS_EXE),
      lock: LOCK.digest,
    });
    assert.equal(r.signed.length, 1);
  });

  for (const late of LATE_WRITES) {
    it(`${late.name} after admission: refused, nothing signed, no run directory`, async () => {
      const r = await rig("rust-late-writer-", openSandbox);
      const deps = r.deps({ gameBuilds: new GameBuildLanes({ [GameStack.RustWgpu]: writingLate(r.builds, late) }) });
      const refused = await refusalOf(prepareNativeRun(deps, headless(), new AbortController().signal));
      assert.equal(refused, NativeRefusal.NotAnExecutable);
      assert.deepEqual(r.signed, []);
      assert.deepEqual(await runsIn(r.runs), []);
    });
  }

  it("an asset rewritten in place while the host copies it: refused, the run directory removed", async () => {
    const r = await rig("rust-late-writer-copy-", openSandbox);
    const { out } = await admitted(r);
    const assembleWgpu: typeof assembleWgpuRunDir = (request) =>
      assembleWgpuRunDir({
        ...request,
        afterListing: () => writeFile(path.join(out, ASSET), "eels", { flag: "r+" }),
      });
    const raylibOnly = async () => assert.fail("a wgpu game's run takes the wgpu steps");
    const bundle = { admit: raylibOnly, checkAngle: raylibOnly, assemble: raylibOnly, assembleWgpu };
    const refused = await refusalOf(prepareNativeRun(r.deps({ bundle }), headless(), new AbortController().signal));
    assert.equal(refused, NativeRefusal.NotAnExecutable);
    assert.deepEqual(r.signed, []);
    assert.deepEqual(await runsIn(r.runs), []);
  });

  it("a build whose lane recorded no digests is refused: nothing it holds was admitted", async () => {
    const r = await rig("rust-late-writer-unrecorded-", openSandbox);
    const { out } = await admitted(r);
    const lane: GameBuildLane = {
      ensure: async (): Promise<BuildOutcome> => ({ ok: true, output: out, lastGood: out, problem: null, ran: true }),
      cancelAll: () => {},
      cancelGame: () => {},
      sweep: async () => 0,
    };
    const deps = r.deps({ gameBuilds: new GameBuildLanes({ [GameStack.RustWgpu]: lane }) });
    const refused = await refusalOf(prepareNativeRun(deps, headless(), new AbortController().signal));
    assert.equal(refused, NativeRefusal.NotAnExecutable);
    assert.deepEqual(r.signed, []);
    assert.deepEqual(await runsIn(r.runs), []);
  });
});

describe("the late-writer gate under the real Seatbelt sandbox (macOS)", () => {
  it(
    "a build-script stand-in's process group writing out/ after the build never reaches the run",
    needsSeatbelt(),
    async (t) => {
      // The stand-in starts a writer that tries to leave the build's process group (`set -m`) and,
      // once the build is over, writes the admitted copy, its own target folder (which a build may
      // write) and a marker. The build waits until the writer has started, so it is there to reap.
      const late = [
        'bin=$(cd "$CARGO_TARGET_DIR/.." && pwd -P)',
        "set -m",
        "(",
        '  : > "$bin/late-started"',
        `  sleep ${LATE_WRITER_DELAY_S}`,
        `  printf late > "$bin.out/${HEADLESS_EXE}"`,
        `  printf late > "$bin.out/${ASSET}"`,
        '  printf late > "$bin.out/planted"',
        '  printf late > "$exe"',
        '  : > "$bin/late-done"',
        ") >/dev/null 2>&1 &",
        "set +m",
        'i=0; while [ ! -f "$bin/late-started" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done',
      ].join("\n");
      const r = await rig("rust-late-writer-seatbelt-", rustBuildSandboxes({ secretPaths: [], enabled: true }), late);
      const { out, digests } = await admitted(r);
      const bin = out.slice(0, -".out".length);
      assert.ok(await stat(path.join(bin, "late-started")), "the writer was started inside the build");
      await sleep(LATE_WRITER_GRACE_MS);
      await assert.rejects(stat(path.join(bin, "late-done")), "the writer was reaped with the build's group");
      const target = path.join(bin, "target", "aarch64-apple-darwin", "debug", "game");
      assert.notEqual(await readFile(target, "utf8"), "late", "nothing the build left behind wrote after it");
      assert.equal(sha256(await readFile(path.join(out, HEADLESS_EXE))), digests.get(HEADLESS_EXE));
      assert.equal(await readFile(path.join(out, ASSET), "utf8"), "fish");
      await assert.rejects(stat(path.join(out, "planted")), "nothing was added to the admitted copy");
      const prepared = await prepareNativeRun(r.deps(), headless(), new AbortController().signal);
      t.after(() => removeRunDir(prepared.runDir));
      assert.equal(sha256(await readFile(prepared.exe)), digests.get(HEADLESS_EXE), "the run got the admitted bytes");
    },
  );
});
