/**
 * The glue the build lane admits a Windows or Linux build's `out/` through
 * (`substrate/native-cross-admission.ts`): the lock's ANGLE `manifest.json` must be the pinned one
 * before anything in `out/` is read, a hostile `out/` is refused with nothing written, and the
 * head start's real cross packages (zig-built on this Mac) pass the PE and ELF gates against the
 * store's ANGLE pins. Real rows are required when present (`GENEX_REQUIRE_TOOLCHAINS=1`).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, opendir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, it, type TestContext } from "node:test";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import {
  ANDROID_LOAD_ALIGN_BYTES,
  IOS_MINIMUM_OS_VERSION,
  NATIVE_CROSS_EXECUTABLES,
  NativeRefusal,
  RUST_ADMITTED_EXECUTABLES,
  RustAdmissionProblem,
} from "../../src/shared/native-contract.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { rustFlavourOf } from "../../src/main/rust-build.ts";
import { ANDROID_PAGE_BYTES, IOS_DEPLOYMENT_TARGET } from "../../src/main/rust-build-mobile.ts";
import { RustFlavour } from "../../src/main/rust-manifest.ts";
import { ToolchainHost, ToolchainId } from "../../src/shared/toolchain.ts";
import {
  admitCrossOutput,
  admitRustBinary,
  admitRustOutput,
  type CrossAngle,
  crossAdmissionFacts,
  type DesktopTarget,
  NATIVE_CROSS_MANIFEST_MAX_BYTES,
  RUST_STUDIO_SERVED_TARGETS,
  TRANSPORT_MARKERS,
} from "../../src/substrate/native-cross-admission.ts";
import { type OutputFolderReads, WindowsAngleDll } from "../../src/substrate/native-gate-pe.ts";
import { LINUX_HOST_FILES } from "../../src/substrate/native-gate-elf.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { devCrossPackage, devTool, needsCrossPackage, needsTools } from "../helpers/dev-toolchains.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { writeElf } from "../helpers/elf.ts";
import { writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  androidBinary,
  iosBinary,
  iosSimulatorBinary,
  linuxBinary,
  macBinary,
  wasmBinary,
  windowsBinary,
} from "../fixtures/rust-bundles/binaries.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

const POSIX = process.platform !== "win32";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Synthetic ANGLE DLLs and the game that imports them: what the PE gate admits. */
const ANGLE_DLLS = {
  [WindowsAngleDll.Egl]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["eglGetProcAddress"] }).bytes,
  [WindowsAngleDll.Gles]: writePe({ dll: true, imports: ["KERNEL32.dll", "dxgi.dll"], exports: ["glClear"] }).bytes,
  [WindowsAngleDll.D3dCompiler]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["D3DCompile"] }).bytes,
};
const GAME_IMPORTS = ["libGLESv2.dll", "KERNEL32.dll", "USER32.dll", "WINMM.dll"];

/** A manifest in the ANGLE format pinning `names` (digests of `bytes`, or a placeholder). */
function manifestOf(files: Record<string, Uint8Array | string>): string {
  const listed = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), size: bytes.length }]),
  );
  return `${JSON.stringify({ schema: 1, files: listed }, null, 2)}\n`;
}

/** An ANGLE folder for `target` with a well-formed manifest; its pin is that manifest's sha256. */
async function angleFolder(base: string, target: DesktopTarget): Promise<CrossAngle> {
  const dir = path.join(base, `angle-${target}`);
  await mkdir(dir, { recursive: true });
  const files =
    target === BuildTarget.Windows
      ? ANGLE_DLLS
      : Object.fromEntries(LINUX_HOST_FILES.map((name) => [name, `host ${name}`]));
  const manifest = manifestOf(files);
  await writeFile(path.join(dir, "manifest.json"), manifest);
  return { dir, manifestSha256: sha256(manifest) };
}

/** Reads that count every call, for rows that must not read `out/` at all. */
function countingReads(): { reads: OutputFolderReads; calls: () => number } {
  let calls = 0;
  const reads: OutputFolderReads = {
    lstat: async (file) => {
      calls += 1;
      return lstat(file);
    },
    opendir: async () => {
      calls += 1;
      throw new Error("opendir must not be called");
    },
  };
  return { reads, calls: () => calls };
}

/** Every entry under `root` with its kind, size and modification time: "nothing written" is checked by it. */
async function facts(root: string): Promise<string[]> {
  const seen: string[] = [];
  for (const rel of (await readdir(root, { recursive: true })).sort()) {
    const info = await lstat(path.join(root, rel));
    seen.push(`${rel}:${info.isSymbolicLink() ? "link" : info.size}:${info.mtimeMs}`);
  }
  return seen;
}

const TARGETS: readonly DesktopTarget[] = [BuildTarget.Windows, BuildTarget.Linux];

describe("the ANGLE manifest is checked before the output is read", () => {
  for (const target of TARGETS) {
    it(`${target}: a manifest whose digest is not the pin is refused angle-digest, and out/ is never read`, async () => {
      const base = await tmpDir("cross-admission-");
      const angle = await angleFolder(base, target);
      const out = path.join(base, "out");
      await mkdir(out);
      const { reads, calls } = countingReads();
      const before = await facts(base);
      const admission = await admitCrossOutput(
        { target, out, angle: { ...angle, manifestSha256: "0".repeat(64) } },
        reads,
      );
      assert.equal(admission.ok, false);
      assert.equal(admission.ok ? null : admission.refusal, NativeRefusal.AngleDigest);
      assert.equal(calls(), 0, "no read of out/");
      assert.deepEqual(await facts(base), before);
    });

    it(`${target}: a manifest that is a link, too large or pins nothing is refused angle-digest`, async () => {
      const base = await tmpDir("cross-admission-");
      const out = path.join(base, "out");
      await mkdir(out);
      const real = await angleFolder(base, target);
      const linked = path.join(base, "linked");
      await mkdir(linked);
      if (POSIX) await symlink(path.join(real.dir, "manifest.json"), path.join(linked, "manifest.json"));
      const huge = path.join(base, "huge");
      await mkdir(huge);
      const hugeText = " ".repeat(NATIVE_CROSS_MANIFEST_MAX_BYTES + 1);
      await writeFile(path.join(huge, "manifest.json"), hugeText);
      const empty = path.join(base, "empty");
      await mkdir(empty);
      const emptyText = manifestOf({});
      await writeFile(path.join(empty, "manifest.json"), emptyText);
      const rows: CrossAngle[] = [
        ...(POSIX ? [{ dir: linked, manifestSha256: real.manifestSha256 }] : []),
        { dir: huge, manifestSha256: sha256(hugeText) },
        { dir: empty, manifestSha256: sha256(emptyText) },
        { dir: path.join(base, "missing"), manifestSha256: real.manifestSha256 },
      ];
      const before = await facts(base);
      for (const angle of rows) {
        const { reads, calls } = countingReads();
        const admission = await admitCrossOutput({ target, out, angle }, reads);
        assert.equal(admission.ok ? null : admission.refusal, NativeRefusal.AngleDigest, angle.dir);
        assert.equal(calls(), 0, `no read of out/ for ${angle.dir}`);
      }
      assert.deepEqual(await facts(base), before);
    });
  }
});

/** An `out/` that is not a real folder. */
const HOSTILE_OUT: ReadonlyArray<{
  name: string;
  posixOnly?: boolean;
  plant: (out: string, base: string) => Promise<void>;
  refusal: NativeRefusal;
}> = [
  {
    name: "a link to a folder",
    posixOnly: true,
    plant: async (out, base) => {
      await mkdir(path.join(base, "elsewhere"));
      await symlink(path.join(base, "elsewhere"), out);
    },
    refusal: NativeRefusal.Symlink,
  },
  { name: "missing", plant: async () => {}, refusal: NativeRefusal.NotAnExecutable },
  { name: "a file", plant: (out) => writeFile(out, "not a folder"), refusal: NativeRefusal.NotAnExecutable },
  {
    name: "a FIFO (never opened)",
    posixOnly: true,
    plant: async (out) => {
      execFileSync("/usr/bin/mkfifo", [out]);
    },
    refusal: NativeRefusal.NotAnExecutable,
  },
];

describe("a hostile out/", () => {
  for (const target of TARGETS)
    for (const row of HOSTILE_OUT) {
      const skip = row.posixOnly && !POSIX ? "not run: POSIX links and FIFOs" : undefined;
      it(`${target}: ${row.name} is refused ${row.refusal} with nothing written`, { skip }, async () => {
        const base = await tmpDir("cross-admission-");
        const angle = await angleFolder(base, target);
        const out = path.join(base, "out");
        await row.plant(out, base);
        const before = await facts(base);
        const admission = await admitCrossOutput({ target, out, angle });
        assert.equal(admission.ok ? null : admission.refusal, row.refusal);
        assert.equal(admission.ok ? null : admission.file, ".");
        assert.deepEqual(await facts(base), before);
      });
    }
});

describe("the folder reads a caller injects", () => {
  for (const target of TARGETS)
    it(`${target}: are the ones the gate walks out/ with`, async () => {
      const base = await tmpDir("cross-admission-");
      const angle = await angleFolder(base, target);
      const out = path.join(base, "out");
      await mkdir(out);
      const listed: string[] = [];
      const reads: OutputFolderReads = {
        lstat,
        opendir: async (dir) => {
          listed.push(path.relative(base, dir));
          return opendir(dir);
        },
      };
      const admission = await admitCrossOutput({ target, out, angle }, reads);
      assert.equal(admission.ok, false, "an empty out/ has no game");
      assert.deepEqual(listed, ["out"]);
    });
});

describe("an admissible output", () => {
  it("windows: a game importing the pinned ANGLE is admitted with its imports as facts", async () => {
    const base = await tmpDir("cross-admission-");
    const angle = await angleFolder(base, BuildTarget.Windows);
    const out = path.join(base, "out");
    await mkdir(path.join(out, "assets"), { recursive: true });
    await writeFile(path.join(out, "game.exe"), writePe({ imports: GAME_IMPORTS }).bytes);
    await writeFile(path.join(out, "assets", "level.json"), "{}");
    const before = await facts(base);
    const admission = await admitCrossOutput({ target: BuildTarget.Windows, out, angle });
    assert.ok(admission.ok, admission.ok ? "" : admission.detail);
    assert.equal(admission.target, BuildTarget.Windows);
    assert.equal(admission.out, out);
    assert.deepEqual(admission.facts, { imports: GAME_IMPORTS, maxGlibc: null });
    assert.deepEqual(admission.windows?.assets, ["assets/level.json"]);
    assert.equal(admission.linux, undefined);
    assert.deepEqual(await facts(base), before);
  });
});

/** A game that would name `marker` among its imports, were it ever read: planted outside `out/`. */
const outsideGame = (target: DesktopTarget, marker: string): Uint8Array =>
  target === BuildTarget.Windows
    ? writePe({ imports: ["libGLESv2.dll", marker] }).bytes
    : writeElf({ needed: ["libGLESv2.so", marker, "libc.so.6"] }).bytes;
const OUTSIDE_IMPORT = { [BuildTarget.Windows]: "OUTSIDE_SECRET.dll", [BuildTarget.Linux]: "liboutside_secret.so.1" };

/** A fresh `out/` holding `exe` (bytes) as the destination's executable, beside the destination's store ANGLE. */
async function crossOut(target: DesktopTarget, exe: Uint8Array | null) {
  const base = await realpath(await tmpDir("cross-facts-"));
  const angle = await angleFolder(base, target);
  const out = path.join(base, "out");
  await mkdir(out);
  if (exe) await writeFile(path.join(out, NATIVE_CROSS_EXECUTABLES[target]), exe);
  return { base, angle, out };
}

describe("crossAdmissionFacts: the host's facts about a Windows or Linux build", () => {
  it("windows: an admitted game answers its import and delay-import DLLs as written, no rpaths, and the ANGLE pin", async () => {
    const exe = writePe({ imports: GAME_IMPORTS, delayImports: ["XInput1_4.dll"] }).bytes;
    const { base, angle, out } = await crossOut(BuildTarget.Windows, exe);
    const before = await facts(base);
    assert.deepEqual(await crossAdmissionFacts(out, BuildTarget.Windows, angle), {
      target: BuildTarget.Windows,
      refusal: null,
      detail: null,
      imports: [...GAME_IMPORTS, "XInput1_4.dll"],
      rpaths: [],
      angleManifestSha256: angle.manifestSha256,
    });
    assert.deepEqual(await facts(base), before, "read-only");
  });

  it("windows: a game importing opengl32.dll is refused imports-opengl32 and its facts name opengl32.dll", async () => {
    const exe = writePe({ imports: ["opengl32.dll", ...GAME_IMPORTS] }).bytes;
    const { base, angle, out } = await crossOut(BuildTarget.Windows, exe);
    const before = await facts(base);
    const answer = await crossAdmissionFacts(out, BuildTarget.Windows, angle);
    assert.equal(answer.refusal, NativeRefusal.ImportsOpengl32);
    assert.match(answer.detail ?? "", /opengl32\.dll/);
    assert.deepEqual(answer.imports, ["opengl32.dll", ...GAME_IMPORTS], "read even when refused");
    assert.deepEqual(answer.rpaths, []);
    assert.deepEqual(await facts(base), before, "read-only");
  });

  it("linux: an admitted game answers DT_NEEDED and DT_RUNPATH as written", async () => {
    const { base, angle, out } = await crossOut(BuildTarget.Linux, writeElf().bytes);
    const before = await facts(base);
    assert.deepEqual(await crossAdmissionFacts(out, BuildTarget.Linux, angle), {
      target: BuildTarget.Linux,
      refusal: null,
      detail: null,
      imports: ["libGLESv2.so", "libm.so.6", "libc.so.6"],
      rpaths: ["$ORIGIN"],
      angleManifestSha256: angle.manifestSha256,
    });
    assert.deepEqual(await facts(base), before, "read-only");
  });

  it("linux: a game whose RUNPATH is not $ORIGIN is refused runpath-not-origin and its facts name that RUNPATH", async () => {
    const exe = writeElf({ runpath: ["/opt/genex/lib"] }).bytes;
    const { angle, out } = await crossOut(BuildTarget.Linux, exe);
    const answer = await crossAdmissionFacts(out, BuildTarget.Linux, angle);
    assert.equal(answer.refusal, NativeRefusal.RunpathNotOrigin);
    assert.deepEqual(answer.rpaths, ["/opt/genex/lib"]);
    assert.deepEqual(answer.imports, ["libGLESv2.so", "libm.so.6", "libc.so.6"]);
  });

  it("a manifest that is not the lock's pin is refused angle-digest; the game's imports are still named", async () => {
    const { angle, out } = await crossOut(BuildTarget.Windows, writePe({ imports: GAME_IMPORTS }).bytes);
    const answer = await crossAdmissionFacts(out, BuildTarget.Windows, { ...angle, manifestSha256: "0".repeat(64) });
    assert.equal(answer.refusal, NativeRefusal.AngleDigest);
    assert.deepEqual(answer.imports, GAME_IMPORTS);
    assert.equal(answer.angleManifestSha256, "0".repeat(64), "the pin it was checked against");
  });
});

/** A hostile `out/` or executable: what admission refuses, and the facts it answers (never read outside `out/`). */
const HOSTILE_EXE: ReadonlyArray<{
  name: string;
  posixOnly?: boolean;
  plant: (target: DesktopTarget, out: string, outside: string) => Promise<void>;
  refusal: NativeRefusal;
}> = [
  {
    name: "a truncated header",
    plant: async (target, out) => {
      const whole = target === BuildTarget.Windows ? writePe().bytes : writeElf().bytes;
      await writeFile(path.join(out, NATIVE_CROSS_EXECUTABLES[target]), whole.subarray(0, 40));
    },
    refusal: NativeRefusal.NotAnExecutable,
  },
  {
    name: "a missing executable",
    plant: async () => {},
    refusal: NativeRefusal.NotAnExecutable,
  },
  {
    name: "a link at the executable to a game outside out/",
    posixOnly: true,
    plant: async (target, out, outside) => {
      await symlink(path.join(outside, "game"), path.join(out, NATIVE_CROSS_EXECUTABLES[target]));
    },
    refusal: NativeRefusal.Symlink,
  },
  {
    name: "a hard link at the executable to a game outside out/",
    posixOnly: true,
    plant: async (target, out, outside) => {
      await link(path.join(outside, "game"), path.join(out, NATIVE_CROSS_EXECUTABLES[target]));
    },
    refusal: NativeRefusal.HardLink,
  },
  {
    name: "a FIFO at the executable (never opened)",
    posixOnly: true,
    plant: async (target, out) => {
      execFileSync("/usr/bin/mkfifo", [path.join(out, NATIVE_CROSS_EXECUTABLES[target])]);
    },
    refusal: NativeRefusal.NotAnExecutable,
  },
];

describe("crossAdmissionFacts on hostile inputs", () => {
  for (const target of TARGETS) {
    for (const row of HOSTILE_EXE) {
      const skip = row.posixOnly && !POSIX ? "not run: POSIX links and FIFOs" : undefined;
      it(`${target}: ${row.name} is refused ${row.refusal}, names nothing outside out/ and writes nothing`, {
        skip,
      }, async () => {
        const { base, angle, out } = await crossOut(target, null);
        const outside = path.join(base, "outside");
        await mkdir(outside);
        await writeFile(path.join(outside, "game"), outsideGame(target, OUTSIDE_IMPORT[target]));
        await row.plant(target, out, outside);
        const before = await facts(base);
        const answer = await crossAdmissionFacts(out, target, angle);
        assert.equal(answer.target, target);
        assert.equal(answer.refusal, row.refusal, answer.detail ?? "");
        assert.deepEqual(answer.imports, [], "no import was read");
        assert.deepEqual(answer.rpaths, []);
        assert.deepEqual(await facts(base), before, "nothing written");
      });
    }

    it(`${target}: an out/ that is a link to a folder holding a game is refused symlink and never read`, {
      skip: POSIX ? undefined : "not run: POSIX links",
    }, async () => {
      const { base, angle } = await crossOut(target, null);
      const elsewhere = path.join(base, "elsewhere");
      await mkdir(elsewhere);
      await writeFile(
        path.join(elsewhere, NATIVE_CROSS_EXECUTABLES[target]),
        outsideGame(target, OUTSIDE_IMPORT[target]),
      );
      const linked = path.join(base, "linked-out");
      await symlink(elsewhere, linked);
      const before = await facts(base);
      const answer = await crossAdmissionFacts(linked, target, angle);
      assert.equal(answer.refusal, NativeRefusal.Symlink);
      assert.deepEqual(answer.imports, [], "nothing behind the link was read");
      assert.deepEqual(await facts(base), before);
    });
  }
});

describe("native.build answers the host's facts for a Windows or Linux build", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
    await lite.core.games.scaffold("native-pong", {
      title: "Native Pong",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux],
    });
  });

  /** The lane answers `outcome` for every build; the store's lock names `angle` for every cross destination. */
  function laneAnswers(t: TestContext, outcome: Record<string, unknown>, angle: CrossAngle | null) {
    const { core } = lite;
    const ensured = t.mock.method(core.cppBuilds, "ensure", async () => outcome);
    t.mock.method(core.toolchains, "currentLock", async () => ({ digest: "5e0433cfc3877af8", components: {} }));
    t.mock.method(core.toolchains, "locate", async (_lock: unknown, targets: readonly string[]) => ({
      ok: true,
      toolchain: {
        angle: null,
        cross: Object.fromEntries(
          angle ? targets.map((target) => [target, { toolchainFile: "/lock/genex.cmake", angle }]) : [],
        ),
      },
    }));
    const started = t.mock.method(core.nativeRuns, "start");
    return { ensured, starts: () => started.mock.callCount() };
  }

  for (const target of TARGETS)
    it(`${target}: an admitted build answers its facts against the lock's ANGLE, and nothing runs`, async (t) => {
      const exe = target === BuildTarget.Windows ? writePe({ imports: GAME_IMPORTS }).bytes : writeElf().bytes;
      const { base, angle, out } = await crossOut(target, exe);
      const { ensured, starts } = laneAnswers(t, { ok: true, output: out, problem: null }, angle);
      const before = await facts(base);
      const answer = await lite.api()[HostMethod.NativeBuild]({ project: "native-pong", target });
      assert.equal(answer.ok, true);
      assert.equal(answer.output, out);
      assert.equal(answer.admission?.target, target);
      assert.equal(answer.admission?.refusal, null, answer.admission?.detail ?? "");
      assert.equal(answer.admission?.angleManifestSha256, angle.manifestSha256);
      assert.deepEqual(
        answer.admission?.imports,
        target === BuildTarget.Windows ? GAME_IMPORTS : ["libGLESv2.so", "libm.so.6", "libc.so.6"],
      );
      assert.deepEqual(answer.admission?.rpaths, target === BuildTarget.Windows ? [] : ["$ORIGIN"]);
      assert.equal(ensured.mock.calls[0]?.arguments[0]?.recordLock, true, "the game folder records its check");
      assert.equal(starts(), 0, "nothing is started");
      assert.deepEqual(await facts(base), before, "nothing is written beside the build");
    });

  it("a build the gate refused keeps ok:false and its problem with the gate's refusal and file; no facts are made up", async (t) => {
    const problem = {
      project: "native-pong",
      command: "",
      code: null,
      lines: ['it imports "opengl32.dll"'],
      needsInstall: false,
      install: null,
      showingLastBuild: false,
      at: "2026-10-02T03:00:00.000Z",
      reason: BuildProblemCode.GateRefused,
      target: BuildTarget.Windows,
      gate: { refusal: NativeRefusal.ImportsOpengl32, file: "game.exe" },
    };
    const { angle, out } = await crossOut(
      BuildTarget.Windows,
      writePe({ imports: ["opengl32.dll", "KERNEL32.dll"] }).bytes,
    );
    const nativeAdmission = await crossAdmissionFacts(out, BuildTarget.Windows, angle);
    laneAnswers(t, { ok: false, output: null, problem, nativeAdmission }, angle);
    const answer = await lite.api()[HostMethod.NativeBuild]({ project: "native-pong", target: BuildTarget.Windows });
    assert.equal(answer.ok, false);
    assert.deepEqual(answer.problem, problem);
    assert.deepEqual(answer.admission, nativeAdmission);
    assert.deepEqual(answer.admission?.imports, ["opengl32.dll", "KERNEL32.dll"]);
  });

  it("a lock whose store has no ANGLE for the destination answers no facts rather than a verdict", async (t) => {
    const { out } = await crossOut(BuildTarget.Linux, writeElf().bytes);
    laneAnswers(t, { ok: true, output: out, problem: null }, null);
    const answer = await lite.api()[HostMethod.NativeBuild]({ project: "native-pong", target: BuildTarget.Linux });
    assert.equal(answer.ok, true);
    assert.equal(answer.admission, null);
  });
});

/** The pinned ANGLE folder for a destination, as the store's manifest pins it. */
function storeAngle(target: DesktopTarget): CrossAngle {
  const id = target === BuildTarget.Windows ? ToolchainId.AngleWindows : ToolchainId.AngleLinux;
  const tool = devTool(target === BuildTarget.Windows ? "angleWindows" : "angleLinux");
  const pin = manifestEntry(id, ToolchainHost.MacArm64)?.local?.manifestSha256;
  if ("skip" in tool || !pin) throw new Error(`no ${id} folder or pin`);
  return { dir: tool.path, manifestSha256: pin };
}

/** The head start's real package for a destination. */
function realPackage(target: DesktopTarget): string {
  const found = devCrossPackage(target);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}

describe("the head start's real cross packages", () => {
  it("windows: the zig-built starter is admitted, importing libGLESv2.dll and never opengl32.dll", {
    ...needsTools("angleWindows"),
    ...needsCrossPackage(BuildTarget.Windows),
  }, async () => {
    const out = realPackage(BuildTarget.Windows);
    const before = await facts(out);
    const admission = await admitCrossOutput({
      target: BuildTarget.Windows,
      out,
      angle: storeAngle(BuildTarget.Windows),
    });
    assert.ok(admission.ok, admission.ok ? "" : admission.detail);
    const imports = admission.facts.imports.map((name) => name.toLowerCase());
    assert.ok(imports.includes("libglesv2.dll"), imports.join(", "));
    assert.ok(!imports.includes("opengl32.dll"), imports.join(", "));
    assert.equal(admission.windows?.exe.path, "game.exe");
    assert.deepEqual(await facts(out), before, "admission writes nothing");
  });

  it("linux: the zig-built starter is admitted, importing libGLESv2.so on glibc 2.28 at most", {
    ...needsTools("angleLinux"),
    ...needsCrossPackage(BuildTarget.Linux),
  }, async () => {
    const out = realPackage(BuildTarget.Linux);
    const before = await facts(out);
    const admission = await admitCrossOutput({ target: BuildTarget.Linux, out, angle: storeAngle(BuildTarget.Linux) });
    assert.ok(admission.ok, admission.ok ? "" : admission.detail);
    assert.ok(admission.facts.imports.includes("libGLESv2.so"), admission.facts.imports.join(", "));
    assert.ok(!admission.facts.imports.some((name) => /^libGL\.so/.test(name)));
    assert.ok(admission.facts.maxGlibc !== null && Number(admission.facts.maxGlibc.split(".")[1]) <= 28);
    assert.equal(admission.linux?.exe, "game");
    assert.deepEqual(await facts(out), before, "admission writes nothing");
  });
});

describe("the six Rust · wgpu binaries, admitted per destination (M3.5)", () => {
  /** Each destination's M2 build, written with `trailer` after its bytes when given. */
  const builds = (trailer?: string): Array<[BuildTarget, Uint8Array]> => [
    [BuildTarget.Mac, macBinary({ trailer })],
    [BuildTarget.Ios, iosBinary({ trailer })],
    [BuildTarget.Ios, iosSimulatorBinary({ trailer })],
    [BuildTarget.Windows, windowsBinary({ trailer })],
    [BuildTarget.Linux, linuxBinary({ trailer })],
    [BuildTarget.Android, androidBinary({ trailer })],
    [BuildTarget.Web, wasmBinary(trailer === undefined ? {} : { custom: [{ name: "producers", payload: trailer }] })],
  ];
  const verdict = (target: BuildTarget, bytes: Uint8Array, servesStudio = false) => {
    const admission = admitRustBinary({ target, bytes, servesStudio });
    return admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`;
  };

  it("admits each destination's M2 build as an export, and reads it in the destination's format", () => {
    for (const [target, bytes] of builds()) {
      const admission = admitRustBinary({ target, bytes, servesStudio: false });
      assert.ok(admission.ok, `${target}: ${admission.ok ? "" : admission.detail}`);
      assert.equal(admission.format, RUST_ADMITTED_EXECUTABLES[target].format, target);
      assert.ok(admission.imports.length > 0, target);
    }
  });

  it("refuses another destination's binary as not this destination's format or machine", () => {
    assert.equal(
      verdict(BuildTarget.Linux, windowsBinary()),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`,
    );
    assert.equal(
      verdict(BuildTarget.Windows, linuxBinary()),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`,
    );
    assert.equal(
      verdict(BuildTarget.Web, macBinary()),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`,
    );
    assert.equal(
      verdict(BuildTarget.Android, linuxBinary()),
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongMachine}`,
    );
    assert.equal(
      verdict(BuildTarget.Mac, iosBinary()),
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongPlatform}`,
    );
  });

  for (const marker of TRANSPORT_MARKERS) {
    it(`refuses an export of every destination that carries the transport's ${JSON.stringify(marker)}`, () => {
      for (const [target, bytes] of builds(`..${marker}..`))
        assert.equal(
          verdict(target, bytes),
          `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.TransportLinked}`,
          target,
        );
    });
  }

  it("lets a desktop dev build link the transport, never a phone's or the web's", () => {
    const marker = TRANSPORT_MARKERS[0] ?? "";
    for (const [target, bytes] of builds(marker)) {
      const expected = RUST_STUDIO_SERVED_TARGETS.has(target)
        ? "admitted"
        : `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.TransportLinked}`;
      assert.equal(verdict(target, bytes, true), expected, target);
    }
  });

  it("serves the studio on exactly the destinations the lane links the dev flavour for", () => {
    for (const target of Object.values(BuildTarget))
      assert.equal(
        RUST_STUDIO_SERVED_TARGETS.has(target),
        rustFlavourOf(CppBuildPurpose.Live, target) === RustFlavour.Dev,
        target,
      );
  });

  it("holds the iOS minimum and the Android alignment to what the lane builds with", () => {
    assert.equal(IOS_MINIMUM_OS_VERSION, IOS_DEPLOYMENT_TARGET);
    assert.equal(ANDROID_LOAD_ALIGN_BYTES, ANDROID_PAGE_BYTES);
  });

  it("admits every executable the destination names in out/, and refuses a link or a missing one", async (t) => {
    const base = await tmpDir("rust-out-");
    try {
      const out = path.join(base, "out");
      await mkdir(out);
      await writeFile(path.join(out, "game"), macBinary());
      const missing = await admitRustOutput(out, BuildTarget.Mac, { servesStudio: true });
      assert.equal(
        !missing.ok && `${missing.file} ${missing.refusal}`,
        `game-headless ${NativeRefusal.NotAnExecutable}`,
      );
      await writeFile(path.join(out, "game-headless"), macBinary());
      const admitted = await admitRustOutput(out, BuildTarget.Mac, { servesStudio: true });
      assert.ok(admitted.ok);
      assert.deepEqual(
        admitted.files.map((file) => file.file),
        ["game", "game-headless"],
      );
      if (!POSIX) return t.skip("POSIX links");
      const linked = path.join(base, "linked");
      await mkdir(linked);
      await symlink(path.join(out, "game"), path.join(linked, "game"));
      const refused = await admitRustOutput(linked, BuildTarget.Ios, { servesStudio: false });
      assert.equal(
        !refused.ok && `${refused.refusal}/${refused.problem}`,
        `${NativeRefusal.Symlink}/${RustAdmissionProblem.Link}`,
      );
      const hard = path.join(base, "hard");
      await mkdir(hard);
      await link(path.join(out, "game"), path.join(hard, "game"));
      const twice = await admitRustOutput(hard, BuildTarget.Ios, { servesStudio: false });
      assert.equal(
        !twice.ok && `${twice.refusal}/${twice.problem}`,
        `${NativeRefusal.HardLink}/${RustAdmissionProblem.Link}`,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

/**
 * The real M2 builds in this checkout's dev store (`.studio-dev/`), read only with
 * `STUDIO_LOCAL_FIXTURES=1`: the binaries `tests/fixtures/rust-bundles/m2-binaries.json` describes.
 */
describe("the real M2 builds, admitted (M3.5, local fixtures)", () => {
  const LOCAL = process.env.STUDIO_LOCAL_FIXTURES === "1";
  const root = path.resolve(import.meta.dirname, "..", "..", ".studio-dev");
  const artifacts = path.join(root, "cross", "artifacts");
  const real: Array<[BuildTarget, string, boolean]> = [
    [BuildTarget.Mac, path.join(root, "cargo-target", "debug", "pond"), true],
    [BuildTarget.Ios, path.join(artifacts, "ios-device", "pond"), false],
    [BuildTarget.Ios, path.join(artifacts, "ios-sim", "pond"), false],
    [BuildTarget.Windows, path.join(artifacts, "windows", "pond.exe"), false],
    [BuildTarget.Linux, path.join(artifacts, "linux", "pond"), false],
    [BuildTarget.Android, path.join(artifacts, "android", "libpond_game.so"), false],
    [BuildTarget.Android, path.join(artifacts, "android", "pond"), false],
    [BuildTarget.Web, path.join(root, "cross", "export", "pond-web", "game_bg.wasm"), false],
  ];
  for (const [target, file, dev] of real) {
    it(`admits ${path.relative(root, file)} for ${target}${dev ? " as a dev build, and refuses it as an export" : ""}`, async (t) => {
      if (!LOCAL) return t.skip("set STUDIO_LOCAL_FIXTURES=1 to read this checkout's dev store");
      const bytes = await readFile(file).catch(() => null);
      if (!bytes) return t.skip(`${file} is not built here`);
      const admission = admitRustBinary({ target, bytes, servesStudio: dev });
      assert.ok(admission.ok, admission.ok ? "" : `${admission.problem}: ${admission.detail}`);
      if (!dev) return;
      const exported = admitRustBinary({ target, bytes, servesStudio: false });
      assert.equal(!exported.ok && exported.problem, RustAdmissionProblem.TransportLinked);
    });
  }
});
