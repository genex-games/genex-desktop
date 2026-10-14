/**
 * The Windows destination of the Rust lane (`src/main/rust-build-windows.ts`, M4.1):
 * `x86_64-pc-windows-gnullvm` cross-built with llvm-mingw, the static C runtime and a
 * timestamp-free link; refused `llvm-mingw-missing` with no setting for a missing or hostile
 * llvm-mingw path; every `out/` admitted by the Rust PE policy (desktop OpenGL, a DXC compiler, a
 * Vulkan loader or a shipped runtime DLL refuse the build, typed, and nothing reaches `out/`).
 *
 * The lane rows run `RustBuilds` over a stub cargo without containment (`rust-build.test.ts` holds
 * the sandbox rows). The real row cross-builds the Rust template for Windows from the Mac offline
 * with the pinned toolchain and the dev store's llvm-mingw under the real Seatbelt sandbox, twice
 * from a cold target folder, admits both, and exports both: the two zips are byte-identical. It
 * skips without the toolchain; `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure. Nothing
 * here runs the game: the D3D12-under-WARP row is CI's (M4.4).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import {
  admittedBuildLock,
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
  type RustToolchain,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import {
  RUST_WINDOWS_BUILDER,
  WindowsSettingsRefusal,
  windowsBuildSettings,
  windowsTargetSettings,
} from "../../src/main/rust-build-windows.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { GpuQualification } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NativeRefusal, RustAdmissionProblem } from "../../src/shared/native-contract.ts";
import { admitRustOutput } from "../../src/substrate/native-cross-admission.ts";
import { exportRustWindowsZip } from "../../src/substrate/native-export-desktop.ts";
import { admitRustPe, PeMachine } from "../../src/substrate/native-gate-pe.ts";
import {
  parseLockClosure,
  readVendoredLicences,
  rustNotices,
  rustRuntimeSources,
} from "../../src/substrate/rust-notices.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { windowsBinary } from "../fixtures/rust-bundles/binaries.ts";
import { PeFixtureMachine } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TRIPLE = "x86_64-pc-windows-gnullvm";
const LINKER_VAR = "CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER";
const LLVM_MINGW = "/store/llvm-mingw-20260922-ucrt";
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub cargo is a POSIX shell script" : false;
const LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });
const RUSTC_VV = "rustc 1.99.0 (1d4e1a2b3 2026-09-17)\nhost: aarch64-apple-darwin\nrelease: 1.99.0\n";
const LOCK_FILE = 'version = 4\n\n[[package]]\nname = "game"\nversion = "0.0.0"\n';
const WINDOWS_GAME = {
  stack: GameStack.RustWgpu,
  targets: [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows],
} as const;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const shellWord = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

describe("the Windows builder and the settings a build needs", () => {
  it("builds x86_64-pc-windows-gnullvm into one game.exe beside the assets, without the Mac SDK", () => {
    assert.equal(RUST_WINDOWS_BUILDER.ready, true);
    assert.equal(RUST_WINDOWS_BUILDER.triple, TRIPLE);
    assert.deepEqual(RUST_WINDOWS_BUILDER.executables, ["game.exe"]);
    assert.equal(RUST_WINDOWS_BUILDER.assets, true);
    assert.equal(RUST_WINDOWS_BUILDER.macSdk, false);
  });

  it("links with llvm-mingw's clang scoped to the target, the static CRT and no link timestamp", () => {
    const settings = windowsBuildSettings({ llvmMingw: LLVM_MINGW, bin: "/builds/pond/windows-0123" });
    assert.ok(settings.ok);
    const clang = `${LLVM_MINGW}/bin/x86_64-w64-mingw32-clang`;
    assert.equal(settings.env[LINKER_VAR], clang);
    assert.equal(settings.env.CC_x86_64_pc_windows_gnullvm, clang);
    assert.equal(settings.env.AR_x86_64_pc_windows_gnullvm, `${LLVM_MINGW}/bin/llvm-ar`);
    assert.equal(settings.env.CC, undefined, "a host build script never sees the cross compiler");
    assert.deepEqual(settings.rustflags, [
      "-C",
      "target-feature=+crt-static",
      "-C",
      "link-arg=-Wl,--no-insert-timestamp",
    ]);
    assert.deepEqual(settings.reads, [LLVM_MINGW]);
  });

  const hostile: Array<[string, string | null]> = [
    ["no llvm-mingw found", null],
    ["an empty path", ""],
    ["a relative path", "store/llvm-mingw"],
    ["a path holding ':'", "/store/llvm:mingw"],
    ["a path with a newline", "/store/llvm-mingw\n/evil"],
    ["a path with a NUL", "/store/llvm-mingw\0/evil"],
  ];
  for (const [label, llvmMingw] of hostile) {
    it(`refuses ${label} as llvm-mingw-missing and carries no setting`, () => {
      const settings = windowsBuildSettings({ llvmMingw, bin: "/builds/pond/windows-0123" });
      assert.equal(settings.ok, false);
      assert.equal(!settings.ok && settings.code, WindowsSettingsRefusal.LlvmMingwMissing);
      assert.equal("env" in settings, false);
      assert.equal("reads" in settings, false);
    });
  }

  it("answers only for Windows, asking the store for llvm-mingw then", async () => {
    let asked = 0;
    const settingsFor = windowsTargetSettings(async () => {
      asked += 1;
      return LLVM_MINGW;
    });
    for (const target of [BuildTarget.Mac, BuildTarget.Web, BuildTarget.Linux, BuildTarget.Ios])
      assert.equal(await settingsFor(target, { bin: "/b" }), null);
    assert.equal(asked, 0);
    const windows = await settingsFor(BuildTarget.Windows, { bin: "/b" });
    assert.ok(windows?.ok);
    assert.equal(asked, 1);
    const failing = windowsTargetSettings(async () => {
      throw new Error("store unreadable");
    });
    const refused = await failing(BuildTarget.Windows, { bin: "/b" });
    assert.equal(refused?.ok === false && refused.code, WindowsSettingsRefusal.LlvmMingwMissing);
  });
});

/**
 * What the Rust template's Windows build imports (the lane's real cross build, M4.1): winit's and
 * egui's Win32 DLLs, the UCRT through API sets, dxgi, and COM's `combase.dll` with the WinRT core
 * API set (gilrs reads gamepads through Windows.Gaming.Input).
 */
const TEMPLATE_WINDOWS_IMPORTS = [
  "user32.dll",
  "kernel32.dll",
  "api-ms-win-core-synch-l1-2-0.dll",
  "api-ms-win-crt-stdio-l1-1-0.dll",
  "api-ms-win-crt-runtime-l1-1-0.dll",
  "api-ms-win-crt-heap-l1-1-0.dll",
  "imm32.dll",
  "ole32.dll",
  "gdi32.dll",
  "dwmapi.dll",
  "shell32.dll",
  "combase.dll",
  "oleaut32.dll",
  "ntdll.dll",
  "bcryptprimitives.dll",
  "uxtheme.dll",
  "api-ms-win-core-winrt-l1-1-0.dll",
  "setupapi.dll",
  "dxgi.dll",
];

describe("the PE policy over the template's real Windows link set", () => {
  it("admits it, COM's combase.dll included", () => {
    const admitted = admitRustPe(windowsBinary({ imports: TEMPLATE_WINDOWS_IMPORTS }));
    assert.ok(admitted.ok, JSON.stringify(admitted));
  });
});

// ---------- the lane over a stub cargo ----------

/** A stub cargo that logs its arguments and the variables a Windows build sets, and writes `exeFrom` as the game. */
function stubCargo(exeFrom: string, log: string): string {
  const artifact =
    '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
    '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';
  return `#!/bin/sh
sub=$1
printf '%s\\n' "$sub $*" >> ${shellWord(log)}
printf 'LINKER=%s\\nRUSTFLAGS=%s\\n' "$${LINKER_VAR}" "$RUSTFLAGS" >> ${shellWord(log)}
shift
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  generate-lockfile) printf '%s' ${shellWord(LOCK_FILE)} > "$(dirname "$manifest")/Cargo.lock" ;;
  clippy) echo '{"reason":"build-finished","success":true}' ;;
  build)
    exe="$CARGO_TARGET_DIR/${TRIPLE}/release/game.exe"
    mkdir -p "$(dirname "$exe")"
    cp ${shellWord(exeFrom)} "$exe"
    echo '${artifact}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;
}

/** Runs `request` with /bin/sh, uncontained. */
async function runShell(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, stdio: ["ignore", "pipe", "pipe"] });
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

/** The game's sources and one asset, staged as M2.2's stager would. */
async function stage(game: { dir: string }, into: string): Promise<RustStaged> {
  for (const folder of ["src", "assets"]) {
    await mkdir(path.join(into, folder), { recursive: true });
    for (const name of await readdir(path.join(game.dir, folder)))
      await writeFile(path.join(into, folder, name), await readFile(path.join(game.dir, folder, name)));
  }
  await writeFile(path.join(into, "Cargo.toml"), '[package]\nname = "game"\nversion = "0.0.0"\n\n[dependencies]\n');
  return { ok: true, dependencies: [] };
}

async function rustGame(parent: string): Promise<string> {
  const dir = path.join(parent, "pond");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Pond"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  await writeFile(path.join(dir, "assets", "fish.txt"), "fish");
  return dir;
}

const gameOf = (dir: string): GameBuildGame => ({
  project: "pond",
  dir,
  shape: {
    entry: "index.html",
    main: "src/main.rs",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  },
  destinations: { ...WINDOWS_GAME, targets: [...WINDOWS_GAME.targets] },
});

/** A Windows lane over a stub cargo writing `exe` as the game; every sandbox spec recorded. */
async function windowsLane(exe: Buffer, overrides: Partial<RustBuildsOptions> = {}) {
  const parent = await realpath(await tmpDir("rust-windows-"));
  const bin = path.join(parent, "toolchain", "bin");
  await mkdir(bin, { recursive: true });
  const exeFrom = path.join(parent, "exe-bytes");
  await writeFile(exeFrom, exe);
  const log = path.join(parent, "cargo.log");
  await writeFile(path.join(bin, "cargo"), stubCargo(exeFrom, log), { mode: 0o755 });
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s' ${shellWord(RUSTC_VV)}\n`, { mode: 0o755 });
  const vendor = path.join(parent, "toolchain", "vendor");
  await mkdir(vendor, { recursive: true });
  const toolchain: RustToolchain = { bin, vendor, clippyConf: bin, reads: [path.join(parent, "toolchain")] };
  const specs: RustBuildSandboxSpec[] = [];
  const sandbox = async (spec: RustBuildSandboxSpec): Promise<RustBuildSandbox> => {
    specs.push(spec);
    return { run: runShell, dispose: async () => {} };
  };
  const builds = new RustBuilds({
    root: path.join(parent, "rust-builds"),
    sandbox,
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage,
    emit: () => {},
    platform: StudioPlatform.Mac,
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    builders: { [BuildTarget.Windows]: RUST_WINDOWS_BUILDER },
    targetSettings: windowsTargetSettings(async () => LLVM_MINGW),
    admit: admitRustOutput,
    ...overrides,
  });
  return { builds, parent, log, specs, dir: await rustGame(parent) };
}

const exists = (at: string) =>
  stat(at).then(
    () => true,
    () => false,
  );

describe("the lane builds a Rust game for Windows", { skip: SKIP_ON_WINDOWS }, () => {
  it("cross-builds with llvm-mingw for gnullvm and admits game.exe with the assets", async () => {
    const { builds, log, specs, dir } = await windowsLane(windowsBinary());
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Windows, CppBuildPurpose.Export);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const out = outcome.output ?? "";
    assert.deepEqual((await readdir(out)).sort(), ["assets", "game.exe"]);
    assert.deepEqual(await readFile(path.join(out, "game.exe")), windowsBinary());
    assert.equal(outcome.rust?.receipt?.triple, TRIPLE);
    assert.equal(outcome.rust?.receipt?.target, BuildTarget.Windows);
    const calls = await readFile(log, "utf8");
    const build = calls.split("\n").find((line) => line.startsWith("build "));
    assert.ok(build?.includes(`--target ${TRIPLE}`), build);
    assert.ok(build?.includes("--release"), "an export builds release");
    assert.match(calls, new RegExp(`LINKER=${LLVM_MINGW}/bin/x86_64-w64-mingw32-clang`));
    assert.match(
      calls,
      /RUSTFLAGS=-F unsafe_code -C target-feature=\+crt-static -C link-arg=-Wl,--no-insert-timestamp/,
    );
    assert.ok(specs[0]?.reads.includes(LLVM_MINGW), "the build's sandbox reads llvm-mingw");
  });

  it("refuses a build without llvm-mingw before anything runs", async () => {
    const { builds, specs, dir } = await windowsLane(windowsBinary(), {
      targetSettings: windowsTargetSettings(async () => null),
    });
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Windows, CppBuildPurpose.Export);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.TargetSettings);
    assert.ok(outcome.problem?.lines[0]?.startsWith(WindowsSettingsRefusal.LlvmMingwMissing));
    assert.equal(outcome.ran, false);
    assert.deepEqual(specs, [], "no sandbox was opened");
  });

  const hostile: Array<[string, Buffer, NativeRefusal, RustAdmissionProblem]> = [
    [
      "desktop OpenGL",
      windowsBinary({ imports: ["kernel32.dll", "opengl32.dll"] }),
      NativeRefusal.ImportsOpengl32,
      RustAdmissionProblem.OpenGl,
    ],
    [
      "GLU (which imports OpenGL), delay-loaded",
      windowsBinary({ delayImports: ["GLU32.dll"] }),
      NativeRefusal.ImportsOpengl32,
      RustAdmissionProblem.OpenGl,
    ],
    [
      "ANGLE's GLES",
      windowsBinary({ imports: ["kernel32.dll", "libGLESv2.dll"] }),
      NativeRefusal.ImportsOpengl32,
      RustAdmissionProblem.OpenGl,
    ],
    [
      "the DXC compiler",
      windowsBinary({ imports: ["kernel32.dll", "dxcompiler.dll"] }),
      NativeRefusal.ForeignImport,
      RustAdmissionProblem.DxCompiler,
    ],
    [
      "DXIL, delay-loaded",
      windowsBinary({ delayImports: ["DXIL.dll"] }),
      NativeRefusal.ForeignImport,
      RustAdmissionProblem.DxCompiler,
    ],
    [
      "the Vulkan loader",
      windowsBinary({ imports: ["kernel32.dll", "vulkan-1.dll"] }),
      NativeRefusal.ForeignImport,
      RustAdmissionProblem.ForeignImport,
    ],
    [
      "a shipped libunwind (no static CRT)",
      windowsBinary({ imports: ["kernel32.dll", "libunwind.dll"] }),
      NativeRefusal.ForeignImport,
      RustAdmissionProblem.ForeignImport,
    ],
    [
      "a DLL by path",
      windowsBinary({ imports: ["kernel32.dll", "C:\\evil\\d3d12.dll"] }),
      NativeRefusal.ForeignImport,
      RustAdmissionProblem.ForeignImport,
    ],
    [
      "an arm64 image",
      windowsBinary({ machine: PeFixtureMachine.Arm64 }),
      NativeRefusal.WrongMachine,
      RustAdmissionProblem.WrongMachine,
    ],
    [
      "the studio transport in an export",
      windowsBinary({ trailer: "\\\\.\\pipe\\genex-game-" }),
      NativeRefusal.NotAnExecutable,
      RustAdmissionProblem.TransportLinked,
    ],
  ];
  for (const [label, exe, refusal, problem] of hostile) {
    it(`refuses an executable importing ${label}, typed, and nothing reaches out/`, async () => {
      const { builds, parent, dir } = await windowsLane(exe);
      const outcome = await builds.ensure(gameOf(dir), BuildTarget.Windows, CppBuildPurpose.Export);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.rust?.refusal, RustBuildRefusal.AdmissionRefused);
      assert.deepEqual(outcome.rust?.admission, { file: "game.exe", refusal, problem });
      const outs = (await readdir(path.join(parent, "rust-builds"), { recursive: true })).filter((rel) =>
        rel.endsWith(".out"),
      );
      assert.deepEqual(outs, [], "nothing reached out/");
    });
  }

  it("lets a dev build that serves the studio carry the transport", async () => {
    const { builds, dir } = await windowsLane(windowsBinary({ trailer: "\\\\.\\pipe\\genex-game-" }));
    const live = await builds.ensure(gameOf(dir), BuildTarget.Windows, CppBuildPurpose.Live);
    assert.equal(live.ok, true, JSON.stringify(live.problem));
    assert.ok(await exists(path.join(live.output ?? "", "game.exe")));
  });
});

// ---------- the real cross build ----------

const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const LLVM_MINGW_DIR = process.env.GENEX_LLVM_MINGW_DIR ?? path.join(TOOLCHAIN_DIR, "tools", "llvm-mingw");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** A cold cross build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 40 * MINUTE_MS;
/** Free disk below which the real row refuses to start a cold cross build, in bytes. */
const MIN_FREE_BYTES = 5 * 1024 ** 3;

/** Why the real row cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  for (const need of ["sysroot/bin/cargo", "sysroot/bin/cargo-clippy", `sysroot/lib/rustlib/${TRIPLE}/lib`])
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the Rust toolchain (${path.join(TOOLCHAIN_DIR, need)})`;
  if (!existsSync(path.join(LLVM_MINGW_DIR, "bin", "x86_64-w64-mingw32-clang")))
    return `llvm-mingw (${LLVM_MINGW_DIR})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0"))) return `the release's vendored crates (${VENDOR_DIR})`;
  return null;
}

function needsToolchain(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** The template as a created game, its title filled in. */
async function templateGame(parent: string): Promise<string> {
  const dir = path.join(parent, "pond");
  await cp(TEMPLATE, dir, { recursive: true });
  for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
  return dir;
}

/** The Windows notices of the admitted build at `out`, generated as an export generates them. */
async function windowsNotices(out: string, vendor: string, toolchainDir: string, llvmMingw: string) {
  const lock = await readFile(admittedBuildLock(out), "utf8");
  const closure = parseLockClosure(lock);
  assert.ok(closure.ok);
  return rustNotices({
    target: BuildTarget.Windows,
    lock,
    // The game's own path packages are first-party: listed in no notice.
    roots: closure.crates.filter((crate) => crate.source === null).map((crate) => crate.name),
    licences: await readVendoredLicences([vendor], closure.crates),
    runtime: await rustRuntimeSources({
      sysroot: path.join(toolchainDir, "sysroot"),
      vendorDirs: [vendor],
      crates: closure.crates,
      llvmMingw,
    }),
  });
}

describe("the Windows lane for real: the template cross-built from the Mac offline", () => {
  const options = needsToolchain();

  it("builds game.exe the PE policy admits, twice from cold to the same bytes, and exports byte-identical zips", {
    ...options,
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    const disk = await statfs(REPO);
    assert.ok(
      disk.bavail * disk.bsize > MIN_FREE_BYTES,
      "free disk for a cold cross build (cargo clean the shared target)",
    );
    const toolchainDir = realpathSync(TOOLCHAIN_DIR);
    const llvmMingw = realpathSync(LLVM_MINGW_DIR);
    const home = await realpath(await tmpDir("rust-windows-real-"));
    const games = path.join(home, "games");
    await mkdir(games, { recursive: true });
    const dir = await templateGame(games);
    const vendor = await realpath(VENDOR_DIR);
    const payload = rustPayloadDir(path.join(home, "resources"));
    await mkdir(payload, { recursive: true });
    for (const file of ["Cargo.lock", "clippy.toml"])
      await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
    const toolchain: RustToolchain = {
      bin: path.join(toolchainDir, "sysroot", "bin"),
      vendor,
      clippyConf: payload,
      reads: [toolchainDir, vendor, payload],
    };
    const builds = new RustBuilds({
      root: path.join(home, "app-data", "rust-builds"),
      sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
      locate: async () => ({ ok: true, toolchain }),
      currentLock: async () => LOCK,
      stage: shippedRustStage(payload),
      emit: () => {},
      platform: process.platform,
      cores: os.availableParallelism(),
      denyWrite: [],
      writeLock: async () => {},
      builders: { [BuildTarget.Windows]: RUST_WINDOWS_BUILDER },
      targetSettings: windowsTargetSettings(async () => llvmMingw),
      admit: admitRustOutput,
    });
    const game = { ...gameOf(dir), project: "pond" };
    const exports = path.join(home, "exports");
    await mkdir(exports, { recursive: true });

    const zips: string[] = [];
    for (const round of [1, 2]) {
      const built = await builds.ensure(game, BuildTarget.Windows, CppBuildPurpose.Export);
      assert.equal(built.ok, true, JSON.stringify(built.problem));
      const out = built.output ?? "";
      const exe = await readFile(path.join(out, "game.exe"));
      const pe = admitRustPe(exe);
      assert.ok(pe.ok, JSON.stringify(pe));
      assert.equal(pe.image.machine, PeMachine.X64);
      const imports = [...pe.image.imports, ...pe.image.delayImports].map((name) => name.toLowerCase());
      for (const refused of ["opengl32.dll", "dxcompiler.dll", "dxil.dll", "vulkan-1.dll", "libunwind.dll"])
        assert.ok(!imports.includes(refused), `${refused} is not imported`);
      console.log(
        `round ${round}: game.exe ${exe.length} bytes, sha256 ${sha256(exe)}, steps ${JSON.stringify(built.rust?.receipt?.steps)}`,
      );

      const notices = await windowsNotices(out, vendor, toolchainDir, llvmMingw);
      assert.ok(notices.ok, JSON.stringify(notices));
      const archive = path.join(exports, `round-${round}`, "Pond-windows-x64.zip");
      await mkdir(path.dirname(archive));
      const exported = await exportRustWindowsZip({
        title: "Pond",
        game: dir,
        out,
        outputs: built.rust?.receipt?.outputs ?? [],
        notices: notices.notices,
        archive,
        builtOn: StudioPlatform.Mac,
        secretValues: [],
      });
      assert.equal(exported.gpuQualification, GpuQualification.Untested);
      zips.push(archive);
      // The second round rebuilds from a cold target folder in the same build folder.
      await rm(path.join(path.dirname(out), path.basename(out, ".out"), "target"), { recursive: true, force: true });
    }
    const [first, second] = await Promise.all(zips.map((zip) => readFile(zip)));
    assert.equal(sha256(first ?? ""), sha256(second ?? ""), "two cold builds export byte-identical zips");
  });
});
