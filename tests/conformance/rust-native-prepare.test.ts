/**
 * A Rust · wgpu game's Mac run, prepared (`prepareNativeRun`) through the real wgpu admission and
 * run-directory assembly (`native-bundle.ts`) over Mach-O images written in the test: Live's
 * embedded run and an agent's headless run build the Rust lane's Mac output with the Rust lock,
 * never look for the store's ANGLE, and assemble `Game.app` with the executable, a host-written
 * `Info.plist` and the staged assets, signed ad hoc as one app. A Window run stays `lane-missing`
 * (the facade's studio mode serves headless: a window run would show no window), and so does a
 * Windows or Linux run. Every hostile build is refused with its typed refusal, and nothing is
 * signed and no run directory is left behind. Only `codesign` is stood in: the images carry load
 * commands and no code, so they run on every platform.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import type { NativePrepareRequest } from "../../src/main/core/native-runs.ts";
import { type BuildOutcome, type GameBuildGame, GameBuildLanes } from "../../src/main/game-build.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NATIVE_BUNDLE_APP, NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { removeRunDir } from "../../src/substrate/native-bundle.ts";
import { CPU_X86_64, fat, LoadCommand, loadCommand, MachOFile, machO } from "../helpers/macho.ts";
import { ApplePlatform, buildVersion } from "../fixtures/rust-bundles/binaries.ts";
import { admittedReport } from "../helpers/rust-admitted.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const PROJECT = "ferris";
const RUN_ID = "0123456789abcdef";
const BUNDLE_ID = "games.genex.game.0123456789ab";
const RUST_LOCK = { version: 1, entries: {}, digest: "ab".repeat(32) } as ToolchainLock;
const HEADLESS_EXE = "game-headless";
const CODESIGN = "/usr/bin/codesign";

/** What the real pond imports: Apple's frameworks and `/usr/lib` only, no rpath. */
const SYSTEM_IMPORTS = [
  "/System/Library/Frameworks/Metal.framework/Versions/A/Metal",
  "/System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore",
  "/System/Library/Frameworks/IOSurface.framework/Versions/A/IOSurface",
  "/usr/lib/libSystem.B.dylib",
  "/usr/lib/libobjc.A.dylib",
];

/**
 * A thin arm64 macOS executable importing `dylibs`, plus any `extra` load commands. It names macOS
 * in `LC_BUILD_VERSION` as every rustc build does: the Rust Mac policy (M3.5) refuses an image
 * that names no platform.
 */
function wgpuGame(dylibs: readonly string[] = SYSTEM_IMPORTS, extra: { cmd: LoadCommand; value: string }[] = []) {
  const commands = [...dylibs.map((value) => ({ cmd: LoadCommand.LoadDylib, value })), ...extra];
  return machO({}, [...commands.map((command) => loadCommand(command)), buildVersion(ApplePlatform.MacOs, "11.0")]);
}

function rustGame(dir: string, targets: BuildTarget[] = [BuildTarget.Web, BuildTarget.Mac]): GameProject {
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
    destinations: { stack: GameStack.RustWgpu, targets },
  };
}

interface Rig {
  root: string;
  out: string;
  deps: NativePrepareDeps;
  locks: Array<string | undefined>;
  located: number;
  builds: Array<{ game: GameBuildGame; target: BuildTarget; purpose: CppBuildPurpose }>;
  signed: string[][];
}

/** A Rust lane's Mac `out/` (`game`, `game-headless`, `assets/`) and the deps that prepare a run of it. */
async function rig(options: { targets?: BuildTarget[]; host?: StudioPlatform } = {}): Promise<Rig> {
  const home = await tmpDir("rust-native-prepare-");
  const root = path.join(home, "runs");
  const out = path.join(home, "build", "out");
  await mkdir(path.join(out, "assets", "models"), { recursive: true });
  await writeFile(path.join(out, "game"), wgpuGame(), { mode: 0o755 });
  await writeFile(path.join(out, HEADLESS_EXE), wgpuGame(), { mode: 0o755 });
  await writeFile(path.join(out, "assets", "models", "pond.glb"), "glTF model bytes");
  const state: Omit<Rig, "deps"> = { root, out, locks: [], located: 0, builds: [], signed: [] };
  const lane = {
    ensure: async (game: GameBuildGame, target: BuildTarget, purpose: CppBuildPurpose): Promise<BuildOutcome> => {
      state.builds.push({ game, target, purpose });
      // The lane's digests of what it admitted: the run is assembled from these very bytes.
      return { ok: true, output: out, lastGood: out, problem: null, ran: true, rust: await admittedReport(out) };
    },
    cancelAll: () => {},
    cancelGame: () => {},
    sweep: async () => 0,
  };
  const deps: NativePrepareDeps = {
    root,
    host: options.host ?? StudioPlatform.Mac,
    gameBox: () => true,
    games: {
      list: async () => [rustGame(path.join(home, "ferris"), options.targets)],
      bundleIdFor: async () => BUNDLE_ID,
    },
    gameBuilds: new GameBuildLanes({ [GameStack.RustWgpu]: lane }),
    toolchains: {
      currentLock: async (stack?: string) => {
        state.locks.push(stack);
        return RUST_LOCK;
      },
      locate: async () => {
        state.located += 1;
        return { ok: false, missing: ["angle-macos"] };
      },
    } as unknown as NativePrepareDeps["toolchains"],
    exec: async (file, args) => {
      state.signed.push([file, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return Object.assign(state, { deps });
}

function request(mode: NativeRunMode, target: BuildTarget = BuildTarget.Mac): NativePrepareRequest {
  return { project: PROJECT, target, mode, runId: RUN_ID };
}

/** The typed refusal `work` is rejected with. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => assert.fail("prepared, not refused"),
    (error: unknown) => {
      assert.ok(error instanceof NativeError, `typed: ${String(error)}`);
      return error.refusal;
    },
  );
}

/** The run root's entries; none when it was never made. */
const runsIn = (root: string): Promise<string[]> => readdir(root).catch(() => []);

const mode = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

const RUNS = [
  { mode: NativeRunMode.Embedded, purpose: CppBuildPurpose.Live },
  { mode: NativeRunMode.Headless, purpose: CppBuildPurpose.Judging },
] as const;

describe("a Rust game's Mac run, prepared through the wgpu admission and assembly", () => {
  for (const run of RUNS) {
    it(`${run.mode} run: builds ${run.purpose} with the Rust lock, never asks for ANGLE, and assembles Game.app`, async (t) => {
      const r = await rig();
      const prepared = await prepareNativeRun(r.deps, request(run.mode), new AbortController().signal);
      // The bundle is read-only: the temp folder's cleanup cannot remove it, so the row does.
      t.after(() => removeRunDir(prepared.runDir));
      assert.deepEqual(r.locks, [GameStack.RustWgpu], "the Rust lock, not the C++ default");
      assert.equal(r.located, 0, "the store's ANGLE is never looked for");
      assert.deepEqual(
        r.builds.map(({ target, purpose }) => ({ target, purpose })),
        [{ target: BuildTarget.Mac, purpose: run.purpose }],
      );
      assert.equal(r.builds[0]?.game.lock, RUST_LOCK);
      assert.equal(prepared.bundleId, BUNDLE_ID);
      assert.equal(prepared.runDir, path.join(await realpath(r.root), RUN_ID), "macOS's temp folder sits behind /var");
      const contents = path.join(prepared.bundle, NATIVE_BUNDLE_APP, "Contents");
      assert.equal(prepared.exe, path.join(contents, "MacOS", "game"));
      assert.deepEqual(await readFile(prepared.exe), await readFile(path.join(r.out, HEADLESS_EXE)));
      assert.equal(await mode(prepared.exe), 0o555, "the executable is read-only to the game");
      assert.deepEqual((await readdir(contents)).sort(), ["Info.plist", "MacOS", "Resources"], "no Frameworks");
      const plist = await readFile(path.join(contents, "Info.plist"), "utf8");
      assert.match(plist, new RegExp(`<string>${BUNDLE_ID.replaceAll(".", "\\.")}</string>`));
      assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/, "no Dock icon for a run Live or an agent drives");
      const asset = path.join(contents, "Resources", "assets", "models", "pond.glb");
      assert.equal(await readFile(asset, "utf8"), "glTF model bytes");
      assert.ok((await lstat(path.join(prepared.state, "captures"))).isDirectory());
      assert.equal(await mode(prepared.state), 0o700, "state/ is the game's only writable folder");
      assert.deepEqual(r.signed, [[CODESIGN, "--force", "-s", "-", "--timestamp=none", path.dirname(contents)]]);
      // A crash record of this run is named from the admitted output's executable (CRASH-7b).
      const crashExe = prepared.crashBuild?.exe ?? "";
      const crashDigest = createHash("sha256")
        .update(await readFile(path.join(r.out, crashExe)))
        .digest("hex");
      assert.deepEqual(prepared.crashBuild, { output: r.out, exe: crashExe, digest: crashDigest });
      assert.equal(prepared.build?.digest, crashDigest);
    });
  }

  it("a bake session's prebuilt headless run (NAV-14b) never asks the lane and assembles its admitted output", async (t) => {
    const r = await rig();
    const admittedFiles = (await admittedReport(r.out)).receipt?.outputs ?? [];
    const prebuilt = { output: r.out, lock: RUST_LOCK, admittedFiles };
    const asked = { ...request(NativeRunMode.Headless), prebuilt };
    const prepared = await prepareNativeRun(r.deps, asked, new AbortController().signal);
    t.after(() => removeRunDir(prepared.runDir));
    assert.deepEqual(r.builds, [], "the build in flight, which waits on this run, is not asked again");
    assert.deepEqual(r.locks, [], "the prebuilt output's own lock");
    assert.deepEqual(await readFile(prepared.exe), await readFile(path.join(r.out, HEADLESS_EXE)));
    assert.equal(prepared.build?.lock, RUST_LOCK.digest);
  });

  it("a Window run is lane-missing before any build: the studio mode serves headless, so no window would show", async () => {
    const r = await rig();
    assert.equal(
      await refusalOf(prepareNativeRun(r.deps, request(NativeRunMode.Window), new AbortController().signal)),
      NativeRefusal.LaneMissing,
    );
    assert.deepEqual(r.builds, []);
    assert.deepEqual(await runsIn(r.root), []);
  });

  for (const target of [BuildTarget.Windows, BuildTarget.Linux]) {
    for (const runMode of [NativeRunMode.Window, NativeRunMode.Embedded, NativeRunMode.Headless]) {
      it(`a ${target} ${runMode} run of a Rust game naming it is lane-missing, with no build`, async () => {
        const host = target === BuildTarget.Windows ? StudioPlatform.Windows : StudioPlatform.Linux;
        const r = await rig({ targets: [BuildTarget.Web, target], host });
        const refused = await refusalOf(
          prepareNativeRun(r.deps, request(runMode, target), new AbortController().signal),
        );
        assert.equal(refused, NativeRefusal.LaneMissing);
        assert.deepEqual(r.builds, []);
        assert.deepEqual(await runsIn(r.root), []);
      });
    }
  }

  it("a Rust game that does not name the Mac is not-a-destination, with no build", async () => {
    const r = await rig({ targets: [BuildTarget.Web] });
    const refused = await refusalOf(
      prepareNativeRun(r.deps, request(NativeRunMode.Embedded), new AbortController().signal),
    );
    assert.equal(refused, NativeRefusal.NotADestination);
    assert.deepEqual(r.builds, []);
  });
});

/** A hostile Mac build: what the lane's `out/` holds instead, and the refusal it must get. */
interface HostileBuild {
  name: string;
  refusal: NativeRefusal;
  make: (out: string, outside: string) => Promise<void>;
}

const writeExe = (out: string, bytes: Buffer) => writeFile(path.join(out, HEADLESS_EXE), bytes, { mode: 0o755 });

const HOSTILE: readonly HostileBuild[] = [
  {
    name: "a universal (fat) binary",
    refusal: NativeRefusal.NotAnExecutable,
    make: (out) => writeExe(out, fat([wgpuGame(), machO({ cpuType: CPU_X86_64, commands: [] })])),
  },
  {
    name: "a thin x86_64 binary",
    refusal: NativeRefusal.NotAnExecutable,
    make: (out) => writeExe(out, machO({ cpuType: CPU_X86_64, commands: [] })),
  },
  {
    name: "a library, not an executable",
    refusal: NativeRefusal.NotAnExecutable,
    make: (out) => writeExe(out, machO({ fileType: MachOFile.Dylib, commands: [] })),
  },
  {
    name: "an OpenGL framework import",
    refusal: NativeRefusal.LinksOpenGl,
    make: (out) =>
      writeExe(out, wgpuGame([...SYSTEM_IMPORTS, "/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL"])),
  },
  {
    name: "a libGL import",
    refusal: NativeRefusal.LinksOpenGl,
    make: (out) => writeExe(out, wgpuGame([...SYSTEM_IMPORTS, "/usr/lib/libGL.dylib"])),
  },
  {
    name: "a non-system dylib (Homebrew's)",
    refusal: NativeRefusal.ForeignImport,
    make: (out) => writeExe(out, wgpuGame([...SYSTEM_IMPORTS, "/opt/homebrew/lib/libfoo.dylib"])),
  },
  {
    name: "an @rpath dylib (ANGLE)",
    refusal: NativeRefusal.ForeignImport,
    make: (out) => writeExe(out, wgpuGame([...SYSTEM_IMPORTS, "@rpath/libEGL.dylib"])),
  },
  {
    name: "a system-looking path that climbs out of /usr/lib",
    refusal: NativeRefusal.ForeignImport,
    make: (out) => writeExe(out, wgpuGame([...SYSTEM_IMPORTS, "/usr/lib/../../tmp/libevil.dylib"])),
  },
  {
    name: "an LC_RPATH",
    refusal: NativeRefusal.ForeignRpath,
    make: (out) => writeExe(out, wgpuGame(SYSTEM_IMPORTS, [{ cmd: LoadCommand.Rpath, value: "@executable_path/." }])),
  },
  {
    name: "an LC_DYLD_ENVIRONMENT",
    refusal: NativeRefusal.ForeignRpath,
    make: (out) =>
      writeExe(out, wgpuGame(SYSTEM_IMPORTS, [{ cmd: LoadCommand.DyldEnvironment, value: "DYLD_LIBRARY_PATH=/tmp" }])),
  },
  {
    name: "an executable that is a link",
    refusal: NativeRefusal.Symlink,
    make: async (out, outside) => {
      await writeFile(path.join(outside, "elsewhere"), wgpuGame(), { mode: 0o755 });
      await rm(path.join(out, HEADLESS_EXE));
      await symlink(path.join(outside, "elsewhere"), path.join(out, HEADLESS_EXE));
    },
  },
  {
    name: "a symlinked asset escaping the run directory",
    refusal: NativeRefusal.Symlink,
    make: async (out, outside) => {
      await writeFile(path.join(outside, "secret.txt"), "not the game's");
      await symlink(path.join(outside, "secret.txt"), path.join(out, "assets", "secret.txt"));
    },
  },
  {
    name: "an extra Mach-O among the assets",
    refusal: NativeRefusal.ExtraMachO,
    make: (out) => writeFile(path.join(out, "assets", "models", "helper.bin"), wgpuGame()),
  },
];

describe("a hostile Rust Mac build is refused, typed, and leaves nothing behind", () => {
  for (const row of HOSTILE) {
    for (const run of RUNS) {
      it(`${row.name}: ${row.refusal} for the ${run.mode} run, nothing signed, no run directory`, async () => {
        const r = await rig();
        const outside = await tmpDir("rust-native-outside-");
        await row.make(r.out, outside);
        const refused = await refusalOf(prepareNativeRun(r.deps, request(run.mode), new AbortController().signal));
        assert.equal(refused, row.refusal);
        assert.deepEqual(r.signed, [], "nothing was signed");
        assert.deepEqual(await runsIn(r.root), [], "no run directory");
        assert.equal(r.located, 0, "no ANGLE lookup either");
      });
    }
  }
});
