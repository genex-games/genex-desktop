/**
 * Where a C++ · raylib game can be built and run (`src/shared/game-targets.ts`), what each
 * destination needs installed (`src/shared/toolchain.ts`), and the wire values several tables
 * share: one home per value, every other table an alias of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { ExportError, ExportRefusal } from "../../src/shared/game-export-contract.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import {
  BUILD_TARGETS,
  BuildTarget,
  DEFAULT_DESTINATIONS,
  DESKTOP_TARGETS,
  destinationsOf,
  GameStack,
  isBuildTarget,
  isGameStack,
  ProjectKind,
  stackForTargets,
  stackOf,
} from "../../src/shared/game-project.ts";
import {
  buildRefusal,
  crossCheckBadge,
  DestinationBadge,
  HOST_MATRIX,
  hostOf,
  hostTarget,
  judgingTarget,
  runRefusal,
  TargetRefusal,
} from "../../src/shared/game-targets.ts";
import {
  CLT_TARGETS,
  missingFor,
  PrewarmState,
  REQUIRED_COMPONENTS,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainProblem,
  type ToolchainStatus,
  toolchainHostOf,
} from "../../src/shared/toolchain.ts";

const HOSTS = [StudioPlatform.Mac, StudioPlatform.Windows, StudioPlatform.Linux] as const;
const OWN_OS = {
  [StudioPlatform.Mac]: BuildTarget.Mac,
  [StudioPlatform.Windows]: BuildTarget.Windows,
  [StudioPlatform.Linux]: BuildTarget.Linux,
} as const;

/** Every non-empty set of destinations, each in the create dialog's order. */
function everyDestinationSet(): BuildTarget[][] {
  const sets: BuildTarget[][] = [];
  for (let mask = 1; mask < 1 << BUILD_TARGETS.length; mask++)
    sets.push(BUILD_TARGETS.filter((_, index) => (mask & (1 << index)) !== 0));
  return sets;
}

/** The run rule, written out: the browser always; a Mac only on a Mac; the host's own OS through a game box. */
function expectedRunRefusal(host: StudioPlatform, target: BuildTarget, gameBox: boolean): TargetRefusal | null {
  if (target === BuildTarget.Web) return null;
  if (host !== StudioPlatform.Mac && target === BuildTarget.Mac) return TargetRefusal.MacBuildsNeedAMac;
  if (target !== OWN_OS[host]) return TargetRefusal.NotRunnableHere;
  return gameBox ? null : TargetRefusal.NoGameBox;
}

/** The judging rule, written out: the browser build, else the host's own OS through a game box, else a judging-only web build. */
function expectedJudging(targets: readonly BuildTarget[], host: StudioPlatform, gameBox: boolean) {
  if (targets.includes(BuildTarget.Web)) return { target: BuildTarget.Web, judgingOnly: false };
  if (gameBox && targets.includes(OWN_OS[host])) return { target: OWN_OS[host], judgingOnly: false };
  return { target: BuildTarget.Web, judgingOnly: true };
}

describe("the stack follows the destinations", () => {
  // Flipped (M6.0): desktop destinations used to imply C++ · raylib and a raylib override forced it;
  // raylib creation is retired, so they imply Rust · wgpu and a raylib override is ignored.
  it("any desktop destination makes a Rust · wgpu game; browser only stays Three.js unless Rust is chosen", () => {
    assert.deepEqual(BUILD_TARGETS, ["web", "macos", "windows", "linux"]);
    assert.deepEqual(DESKTOP_TARGETS, ["macos", "windows", "linux"]);
    for (const targets of everyDestinationSet()) {
      const desktop = targets.some((target) => target !== BuildTarget.Web);
      assert.equal(stackForTargets(targets), desktop ? GameStack.RustWgpu : GameStack.ThreeJs, targets.join());
      assert.equal(stackForTargets(targets, GameStack.RaylibCpp), stackForTargets(targets), targets.join());
      assert.equal(stackForTargets(targets, GameStack.ThreeJs), stackForTargets(targets), targets.join());
      assert.equal(stackForTargets(targets, GameStack.RustWgpu), GameStack.RustWgpu, targets.join());
    }
  });

  it("only the raylib kind is C++, the Rust kind is Rust, and a game that records no destinations is a Three.js browser game", () => {
    const compiled: Partial<Record<ProjectKind, GameStack>> = {
      [ProjectKind.RaylibCpp]: GameStack.RaylibCpp,
      [ProjectKind.RustWgpu]: GameStack.RustWgpu,
    };
    for (const kind of Object.values(ProjectKind))
      assert.equal(stackOf({ kind }), compiled[kind] ?? GameStack.ThreeJs, kind);
    assert.deepEqual(destinationsOf({}), { stack: "three-js", targets: ["web"] });
    assert.equal(destinationsOf({}), DEFAULT_DESTINATIONS);
    const pong = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] };
    assert.equal(destinationsOf({ destinations: pong }), pong);
  });

  it("the guards accept exactly the wire values", () => {
    for (const value of BUILD_TARGETS) assert.equal(isBuildTarget(value), true, value);
    for (const value of ["three-js", "raylib-cpp"]) assert.equal(isGameStack(value), true, value);
    for (const value of ["mac", "Web", "", "toString", "__proto__", 1, null, undefined, ["web"], { web: 1 }]) {
      assert.equal(isBuildTarget(value), false, String(value));
      assert.equal(isGameStack(value), false, String(value));
    }
  });
});

describe("the host matrix", () => {
  it("knows the three hosts and nothing else", () => {
    assert.equal(hostOf("darwin"), StudioPlatform.Mac);
    assert.equal(hostOf("win32"), StudioPlatform.Windows);
    assert.equal(hostOf("linux"), StudioPlatform.Linux);
    for (const other of ["freebsd", "aix", "android", "", "Darwin", "constructor"]) assert.equal(hostOf(other), null);
    for (const host of HOSTS) assert.equal(hostTarget(host), OWN_OS[host], host);
  });

  it("a Mac builds all four; Windows and Linux build all but Mac, whose SDK licence keeps it on a Mac", () => {
    for (const host of HOSTS)
      for (const target of BUILD_TARGETS) {
        const refused = host !== StudioPlatform.Mac && target === BuildTarget.Mac;
        assert.equal(
          buildRefusal(host, target),
          refused ? TargetRefusal.MacBuildsNeedAMac : null,
          `${host} building ${target}`,
        );
        const builds: readonly BuildTarget[] = HOST_MATRIX[host].build;
        assert.equal(builds.includes(target), !refused, `${host} matrix lists ${target}`);
      }
  });

  it("the browser runs everywhere; the host's own OS runs through a game box; any other OS is only built here", () => {
    for (const host of HOSTS)
      for (const gameBox of [false, true])
        for (const target of BUILD_TARGETS)
          assert.equal(
            runRefusal(host, target, { gameBox }),
            expectedRunRefusal(host, target, gameBox),
            `${host} running ${target}, gameBox ${gameBox}`,
          );
    for (const host of HOSTS)
      assert.deepEqual([...HOST_MATRIX[host].run].sort(), [BuildTarget.Web, OWN_OS[host]].sort());
  });

  it("judges the browser build when there is one, else the one destination this host runs, else a judging-only web build", () => {
    let rows = 0;
    for (const targets of everyDestinationSet())
      for (const host of HOSTS)
        for (const gameBox of [false, true]) {
          const destinations = { stack: stackForTargets(targets), targets };
          assert.deepEqual(
            judgingTarget(destinations, host, { gameBox }),
            expectedJudging(targets, host, gameBox),
            `${targets.join("+")} on ${host}, gameBox ${gameBox}`,
          );
          rows++;
        }
    assert.equal(rows, 15 * 3 * 2);
  });

  it("a destination check's badge is Built where the host runs the build (with a game box), else Built, not run here", () => {
    const { Built, NotRunHere } = DestinationBadge;
    const expected: Record<StudioPlatform, Partial<Record<BuildTarget, DestinationBadge>>> = {
      [StudioPlatform.Mac]: {
        [BuildTarget.Web]: Built,
        [BuildTarget.Mac]: Built,
        [BuildTarget.Windows]: NotRunHere,
        [BuildTarget.Linux]: NotRunHere,
      },
      [StudioPlatform.Windows]: {
        [BuildTarget.Web]: Built,
        [BuildTarget.Mac]: NotRunHere,
        [BuildTarget.Windows]: Built,
        [BuildTarget.Linux]: NotRunHere,
      },
      [StudioPlatform.Linux]: {
        [BuildTarget.Web]: Built,
        [BuildTarget.Mac]: NotRunHere,
        [BuildTarget.Windows]: NotRunHere,
        [BuildTarget.Linux]: Built,
      },
    };
    for (const host of HOSTS)
      for (const target of BUILD_TARGETS)
        assert.equal(crossCheckBadge(host, target), expected[host][target], `${target} checked on ${host}`);
  });
});

describe("one home per wire value", () => {
  it("the build problem, export and toolchain tables alias the refusal they share", () => {
    assert.equal(BuildProblemCode.MacBuildsNeedAMac, TargetRefusal.MacBuildsNeedAMac);
    assert.equal(BuildProblemCode.NotADestination, TargetRefusal.NotADestination);
    assert.equal(BuildProblemCode.CltMissing, ToolchainProblem.CltMissing);
    assert.equal(ExportRefusal.NotADestination, TargetRefusal.NotADestination);
    assert.equal(ExportRefusal.MacBuildsNeedAMac, TargetRefusal.MacBuildsNeedAMac);
    assert.equal(ExportRefusal.LaneMissing, NativeRefusal.LaneMissing);
    // Wave 3 adds the signing and Mac app refusals, wave 6 the Windows and Linux archives' (flipped:
    // six appended); the web export's four keep their spellings. Flipped (M1 review): `lane-missing`
    // appended, the build-lane seam's code for a stack with no lane in this build. Flipped (M7.3):
    // `conformance-required`, the run refusal of the same name, for an ejected game's export.
    assert.equal(ExportRefusal.ConformanceRequired, NativeRefusal.ConformanceRequired);
    assert.deepEqual(Object.values(ExportRefusal).sort(), [
      "admission-refused",
      "archive-refused",
      "build-changed",
      "build-failed",
      "conformance-required",
      "harness-may-not-sign",
      "lane-missing",
      "mac-builds-need-a-mac",
      "missing-notice",
      "not-a-destination",
      "not-an-export-folder",
      "secret-found",
      "signing-failed",
      "signing-invalid",
      "signing-unavailable",
      "target-refused",
      "toolchain-unusable",
    ]);
  });

  it("the typed errors carry their code beside the sentence", () => {
    const exported = new ExportError(ExportRefusal.BuildFailed, "the build failed");
    assert.ok(exported instanceof Error);
    assert.equal(exported.code, "build-failed");
    assert.equal(exported.message, "the build failed");
    const toolchain = new ToolchainError(ToolchainProblem.Unpinned, "emsdk has no pinned digest");
    assert.ok(toolchain instanceof Error);
    assert.equal(toolchain.problem, "unpinned");
    assert.equal(toolchain.message, "emsdk has no pinned digest");
  });
});

describe("what a destination needs installed", () => {
  it("pins toolchains for Apple silicon Macs, x64 Windows and x64 Linux only", () => {
    assert.equal(toolchainHostOf("darwin", "arm64"), ToolchainHost.MacArm64);
    assert.equal(toolchainHostOf("win32", "x64"), ToolchainHost.WindowsX64);
    assert.equal(toolchainHostOf("linux", "x64"), ToolchainHost.LinuxX64);
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["win32", "arm64"],
      ["freebsd", "x64"],
      ["darwin-arm64", ""],
    ] as const)
      assert.equal(toolchainHostOf(platform, arch), null, `${platform} ${arch}`);
  });

  const status = (overrides: Partial<ToolchainStatus> = {}): ToolchainStatus => ({
    host: ToolchainHost.MacArm64,
    clt: { present: false, version: null },
    installed: [],
    lock: null,
    job: null,
    storeBytes: 0,
    ...overrides,
  });
  const installed = (id: ToolchainId, version = "1", sha12 = "aaaaaaaaaaaa") => ({ id, version, sha12, bytes: 1 });

  it("the browser needs CMake, Ninja, Emscripten and the raylib source, and never the Command Line Tools", () => {
    assert.deepEqual(REQUIRED_COMPONENTS[BuildTarget.Web], ["cmake", "ninja", "emsdk", "raylib"]);
    assert.deepEqual(CLT_TARGETS, ["macos"]);
    // Flipped: missingFor also names destinations whose prewarm must be redone; none here.
    assert.deepEqual(missingFor(status(), [BuildTarget.Web]), {
      clt: false,
      components: ["cmake", "ninja", "emsdk", "raylib"],
      prewarm: [],
    });
  });

  it("Windows and Linux need zig, the raylib source and their ANGLE, and Linux its headers' sysroot", () => {
    // Flipped: no raylib-windows-x64 or raylib-linux-x64 component (decision T1): prewarm builds
    // those prebuilds from the raylib source, as it does the Mac's.
    assert.deepEqual(REQUIRED_COMPONENTS[BuildTarget.Windows], ["cmake", "ninja", "zig", "raylib", "angle-windows"]);
    assert.deepEqual(REQUIRED_COMPONENTS[BuildTarget.Linux], [
      "cmake",
      "ninja",
      "zig",
      "raylib",
      "angle-linux",
      "linux-sysroot",
    ]);
    assert.deepEqual(missingFor(status(), [BuildTarget.Windows]), {
      clt: false,
      components: ["cmake", "ninja", "zig", "raylib", "angle-windows"],
      prewarm: [],
    });
    const windowsParts = REQUIRED_COMPONENTS[BuildTarget.Windows].map((id) => installed(id));
    const crossReady = status({ installed: windowsParts, prewarm: { [BuildTarget.Linux]: PrewarmState.Missing } });
    assert.deepEqual(missingFor(crossReady, [BuildTarget.Windows, BuildTarget.Linux]), {
      clt: false,
      components: ["angle-linux", "linux-sysroot"],
      prewarm: [],
    });
    const linuxParts = REQUIRED_COMPONENTS[BuildTarget.Linux].map((id) => installed(id));
    const unprewarmed = status({
      installed: [...windowsParts, ...linuxParts],
      prewarm: { [BuildTarget.Windows]: PrewarmState.Stale, [BuildTarget.Linux]: PrewarmState.Ready },
    });
    assert.deepEqual(missingFor(unprewarmed, [BuildTarget.Linux, BuildTarget.Windows]), {
      clt: false,
      components: [],
      prewarm: [BuildTarget.Windows],
    });
    for (const id of Object.values(ToolchainId)) assert.doesNotMatch(id, /^raylib-(windows|linux)/);
  });

  it("the Command Line Tools are missing only for a Mac destination on a Mac without them", () => {
    for (const targets of everyDestinationSet())
      for (const present of [false, true])
        assert.equal(
          missingFor(status({ clt: { present, version: present ? "26.6" : null } }), targets).clt,
          !present && targets.includes(BuildTarget.Mac),
          `${targets.join("+")}, CLT present ${present}`,
        );
  });

  it("lists each missing component once, in table order, whatever order the destinations came in", () => {
    assert.deepEqual(missingFor(status(), [BuildTarget.Linux, BuildTarget.Web, BuildTarget.Mac]).components, [
      "cmake",
      "ninja",
      "emsdk",
      "raylib",
      "angle-macos",
      "zig",
      "angle-linux",
      // Flipped: the Linux raylib prebuild is built in the lock folder (never a component); the
      // Linux X11 and Wayland headers are.
      "linux-sysroot",
    ]);
    const some = status({ installed: [installed(ToolchainId.Cmake), installed(ToolchainId.Emsdk)] });
    assert.deepEqual(missingFor(some, [BuildTarget.Web]).components, ["ninja", "raylib"]);
    assert.deepEqual(missingFor(some, []), { clt: false, components: [], prewarm: [] });
  });

  it("an installed component the lock names at another version is still missing", () => {
    const lock = {
      version: 1 as const,
      entries: { [ToolchainId.Emsdk]: { version: "6.0.10", sha12: "bbbbbbbbbbbb" } },
      digest: "d",
    };
    const web = [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.RaylibSource].map((id) => installed(id));
    const stale = status({ lock, installed: [...web, installed(ToolchainId.Emsdk, "6.0.9", "cccccccccccc")] });
    assert.deepEqual(missingFor(stale, [BuildTarget.Web]).components, ["emsdk"]);
    const current = status({ lock, installed: [...web, installed(ToolchainId.Emsdk, "6.0.10", "bbbbbbbbbbbb")] });
    assert.deepEqual(missingFor(current, [BuildTarget.Web]).components, []);
  });
});
