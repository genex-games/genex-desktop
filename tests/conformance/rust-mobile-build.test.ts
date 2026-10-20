/**
 * The phone destinations' Rust builds (`src/main/rust-build-mobile.ts`, M2.10): the builder per
 * phone build (iOS device and simulator, Android), the settings a build of each needs (the iOS
 * deployment target and SDK, the NDK linker and the 16 KB page link arguments) and the admission
 * facts read back from what was built (LC_BUILD_VERSION platform and minos, every PT_LOAD's
 * alignment, DT_NEEDED). The policies over those facts are M3.5's admission gates.
 *
 * The real rows cross-compile the Rust template offline with the pinned toolchain
 * (`scripts/toolchains/rust-env.ts`): for aarch64-linux-android (with the NDK the helper finds)
 * on any host, and for aarch64-apple-ios and aarch64-apple-ios-sim on a Mac with Xcode. Without a
 * toolchain they skip, and `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure; the iOS
 * rows always skip off a Mac. Nothing here installs or launches anything on a device, a Simulator
 * or an emulator (containment stage 1).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ANDROID_API_LEVELS,
  ANDROID_PAGE_BYTES,
  AppleSdk,
  appleSdkPath,
  elfMobileFacts,
  firstFrameOf,
  IOS_DEPLOYMENT_TARGET,
  MachOPlatform,
  MobileBuild,
  MobileFactRefusal,
  MobileSettingsRefusal,
  machOMobileFacts,
  mobileBuildSettings,
  RUST_MOBILE_BUILDERS,
  RUST_MOBILE_TARGET_BUILDERS,
  ShellSmoke,
  shellSmokeVerdict,
} from "../../src/main/rust-build-mobile.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ELF_PROGRAM_HEADER, ElfMachine, ElfType, programHeaderField, writeElf } from "../helpers/elf.ts";
import { CPU_X86_64, machO } from "../helpers/macho.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const FACADE = path.join(REPO, "native", "genex-rust", "crates", "genex");
const WORKSPACE_LOCK = path.join(REPO, "native", "genex-rust", "Cargo.lock");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR || path.join(REPO, ".studio-dev", "spike-toolchain");
const SYSROOT = path.join(TOOLCHAIN_DIR, "sysroot");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** A cold cross build compiles the facade's whole dependency graph for the triple. */
const CROSS_BUILD_MS = 30 * MINUTE_MS;
const OUTPUT_BYTES = 64 * 1024 * 1024;
/** The page size of an older Android link: what a 16 KB check has to refuse. */
const SMALL_PAGE_BYTES = 4096;
/** LC_BUILD_VERSION and its fixed size (cmd, cmdsize, platform, minos, sdk, ntools). */
const LC_BUILD_VERSION = 0x32;
const BUILD_VERSION_BYTES = 24;
/** LC_VERSION_MIN_IPHONEOS (cmd, cmdsize, version, sdk). */
const LC_VERSION_MIN_IPHONEOS = 0x25;
const VERSION_MIN_BYTES = 16;
const PAGE_4K = 4096;

/** `major.minor.patch` as Mach-O's nibbles: xxxx.yy.zz. */
const machoVersion = (major: number, minor: number, patch = 0): number => (major << 16) | (minor << 8) | patch;

function buildVersion(platform: number, minos: number): Buffer {
  const bytes = Buffer.alloc(BUILD_VERSION_BYTES);
  bytes.writeUInt32LE(LC_BUILD_VERSION, 0);
  bytes.writeUInt32LE(BUILD_VERSION_BYTES, 4);
  bytes.writeUInt32LE(platform, 8);
  bytes.writeUInt32LE(minos, 12);
  bytes.writeUInt32LE(machoVersion(26, 5), 16);
  return bytes;
}

function versionMinIphoneos(version: number): Buffer {
  const bytes = Buffer.alloc(VERSION_MIN_BYTES);
  bytes.writeUInt32LE(LC_VERSION_MIN_IPHONEOS, 0);
  bytes.writeUInt32LE(VERSION_MIN_BYTES, 4);
  bytes.writeUInt32LE(version, 8);
  return bytes;
}

/** An Android shared object (AArch64) whose one PT_LOAD is aligned to `align`. */
function androidObject(align: number, needed = ["libandroid.so", "liblog.so", "libc.so"]): Buffer {
  const { bytes, layout } = writeElf({
    type: ElfType.Shared,
    machine: ElfMachine.Aarch64,
    interpreter: null,
    needed,
    runpath: [],
    versionNeeds: [],
  });
  bytes.writeBigUInt64LE(BigInt(align), programHeaderField(layout, layout.segment.load, ELF_PROGRAM_HEADER.Align));
  return bytes;
}

describe("the phone builders and the settings each build needs", () => {
  it("names the iOS device, iOS simulator and Android triples, and the two lane builders the lane registers", () => {
    assert.equal(RUST_MOBILE_BUILDERS[MobileBuild.IosDevice].triple, "aarch64-apple-ios");
    assert.equal(RUST_MOBILE_BUILDERS[MobileBuild.IosSimulator].triple, "aarch64-apple-ios-sim");
    assert.equal(RUST_MOBILE_BUILDERS[MobileBuild.Android].triple, "aarch64-linux-android");
    assert.equal(RUST_MOBILE_BUILDERS[MobileBuild.IosDevice].appleSdk, AppleSdk.Device);
    assert.equal(RUST_MOBILE_BUILDERS[MobileBuild.IosSimulator].appleSdk, AppleSdk.Simulator);
    assert.equal(RUST_MOBILE_BUILDERS[MobileBuild.Android].appleSdk, null);
    const ios = RUST_MOBILE_TARGET_BUILDERS[BuildTarget.Ios];
    const android = RUST_MOBILE_TARGET_BUILDERS[BuildTarget.Android];
    assert.equal(ios.ready && ios.triple, "aarch64-apple-ios");
    assert.equal(android.ready && android.triple, "aarch64-linux-android");
    // The Mac SDK is the wrong SDK for a phone: the iOS SDK goes in through the settings.
    assert.equal(ios.ready && ios.macSdk, false);
    assert.deepEqual(ANDROID_API_LEVELS, { min: 29, target: 36, compile: 36 });
  });

  it("an iOS build carries the 16.0 deployment target and the SDK xcrun named, and is refused without one", () => {
    const sdk = "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk";
    const settings = mobileBuildSettings(MobileBuild.IosDevice, { sdkRoot: sdk, ndk: null, host: "darwin" });
    assert.ok(settings.ok);
    assert.equal(settings.env.IPHONEOS_DEPLOYMENT_TARGET, IOS_DEPLOYMENT_TARGET);
    assert.equal(settings.env.SDKROOT, sdk);
    assert.deepEqual(settings.rustflags, []);
    assert.deepEqual(settings.reads, [sdk]);
    const missing = mobileBuildSettings(MobileBuild.IosSimulator, { sdkRoot: null, ndk: null, host: "darwin" });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.code, MobileSettingsRefusal.SdkMissing);
    const offMac = mobileBuildSettings(MobileBuild.IosDevice, { sdkRoot: sdk, ndk: null, host: "linux" });
    assert.equal(!offMac.ok && offMac.code, MobileSettingsRefusal.NeedsAMac);
  });

  it("an Android build links with the NDK's API 29 clang and 16 KB pages, and is refused without the NDK", () => {
    const ndk = "/opt/android/ndk/27.1.12297006";
    const settings = mobileBuildSettings(MobileBuild.Android, { ndk, sdkRoot: null, host: "darwin" });
    assert.ok(settings.ok);
    const clang = path.join(
      ndk,
      "toolchains",
      "llvm",
      "prebuilt",
      "darwin-x86_64",
      "bin",
      "aarch64-linux-android29-clang",
    );
    assert.equal(settings.env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER, clang);
    assert.equal(settings.env.CC_aarch64_linux_android, clang);
    assert.deepEqual(settings.rustflags, [
      "-C",
      `link-arg=-Wl,-z,max-page-size=${ANDROID_PAGE_BYTES}`,
      "-C",
      `link-arg=-Wl,-z,common-page-size=${ANDROID_PAGE_BYTES}`,
    ]);
    assert.deepEqual(settings.reads, [ndk]);
    const linux = mobileBuildSettings(MobileBuild.Android, { ndk, sdkRoot: null, host: "linux" });
    assert.ok(linux.ok && linux.env.CC_aarch64_linux_android.includes(`${path.sep}linux-x86_64${path.sep}`));
  });
});

describe("a phone build without its NDK or SDK", () => {
  const hostileNdks: Array<[string, string | null]> = [
    ["no NDK found", null],
    ["a relative NDK path", "ndk/27.1.12297006"],
    ["an NDK path with a newline", "/opt/ndk\n/evil"],
    ["an NDK path with a NUL", "/opt/ndk\0/evil"],
    ["an empty NDK path", ""],
  ];
  for (const [label, ndk] of hostileNdks) {
    it(`an Android build with ${label} is refused ndk-missing and carries no settings`, () => {
      const settings = mobileBuildSettings(MobileBuild.Android, { ndk, sdkRoot: null, host: "darwin" });
      assert.equal(settings.ok, false);
      assert.equal(!settings.ok && settings.code, MobileSettingsRefusal.NdkMissing);
      assert.equal("env" in settings, false);
    });
  }

  it("the iOS SDK is asked of xcrun by name only once a developer folder is selected, never off a Mac", async () => {
    const calls: string[][] = [];
    const sdk = "/Xcode/iPhoneSimulator.sdk";
    const exec = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: file.endsWith("xcode-select") ? "/Xcode/Developer\n" : `${sdk}\n`, stderr: "" };
    };
    assert.equal(await appleSdkPath(exec, AppleSdk.Simulator, "darwin"), sdk);
    assert.deepEqual(calls, [
      ["/usr/bin/xcode-select", "-p"],
      ["/usr/bin/xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"],
    ]);
    calls.length = 0;
    assert.equal(await appleSdkPath(exec, AppleSdk.Device, "linux"), null);
    assert.deepEqual(calls, []);
    const noXcode = async () => ({ code: 2, stdout: "", stderr: "no developer tools" });
    assert.equal(await appleSdkPath(noXcode, AppleSdk.Device, "darwin"), null);
    const odd = async (file: string) => ({
      code: 0,
      stdout: file.endsWith("xcode-select") ? "/X\n" : "relative/sdk\n",
      stderr: "",
    });
    assert.equal(await appleSdkPath(odd, AppleSdk.Device, "darwin"), null);
  });
});

describe("the admission facts read back from a phone build", () => {
  it("reads LC_BUILD_VERSION's platform and minos from an iOS device and a simulator executable", () => {
    const device = machOMobileFacts(machO({}, [buildVersion(2, machoVersion(16, 0))]));
    assert.ok(device.ok);
    assert.equal(device.facts.platform, MachOPlatform.Ios);
    assert.equal(device.facts.minos, "16.0");
    const sim = machOMobileFacts(machO({}, [buildVersion(7, machoVersion(16, 0, 1))]));
    assert.ok(sim.ok);
    assert.equal(sim.facts.platform, MachOPlatform.IosSimulator);
    assert.equal(sim.facts.minos, "16.0.1");
  });

  it("reports rustc's 10.0 default and a Mac platform as they are (refusing them is M3.5's policy)", () => {
    const old = machOMobileFacts(machO({}, [buildVersion(2, machoVersion(10, 0))]));
    assert.ok(old.ok && old.facts.minos === "10.0");
    const mac = machOMobileFacts(machO({}, [buildVersion(1, machoVersion(11, 0))]));
    assert.ok(mac.ok && mac.facts.platform === MachOPlatform.Other);
    const legacy = machOMobileFacts(machO({}, [versionMinIphoneos(machoVersion(9, 3))]));
    assert.ok(legacy.ok && legacy.facts.platform === MachOPlatform.Ios && legacy.facts.minos === "9.3");
    const none = machOMobileFacts(machO({}, []));
    assert.ok(none.ok && none.facts.platform === null && none.facts.minos === null);
  });

  const shortBuildVersion = buildVersion(2, machoVersion(16, 0)).subarray(0, 16);
  shortBuildVersion.writeUInt32LE(16, 4);
  const hostileMachOs: Array<[string, Uint8Array]> = [
    ["empty bytes", new Uint8Array()],
    ["a fat header", Buffer.from([0xca, 0xfe, 0xba, 0xbe, ...new Array(28).fill(0)])],
    ["an x86_64 image", machO({ cpuType: CPU_X86_64 }, [buildVersion(7, machoVersion(16, 0))])],
    ["an ELF file", androidObject(ANDROID_PAGE_BYTES)],
    ["a command count past the commands", machO({ ncmds: 5 }, [buildVersion(2, machoVersion(16, 0))])],
    ["an LC_BUILD_VERSION shorter than its fields", machO({}, [shortBuildVersion])],
  ];
  for (const [label, bytes] of hostileMachOs) {
    it(`refuses ${label} as not-macho, typed, without throwing`, () => {
      const read = machOMobileFacts(bytes);
      assert.equal(read.ok, false);
      assert.equal(!read.ok && read.code, MobileFactRefusal.NotMachO);
    });
  }
  it("reads every PT_LOAD's alignment and DT_NEEDED from an Android shared object", () => {
    const aligned = elfMobileFacts(androidObject(ANDROID_PAGE_BYTES));
    assert.ok(aligned.ok);
    assert.equal(aligned.facts.machine, ElfMachine.Aarch64);
    assert.deepEqual(aligned.facts.loadAlignments, [ANDROID_PAGE_BYTES]);
    assert.deepEqual(aligned.facts.needed, ["libandroid.so", "liblog.so", "libc.so"]);
    const fourK = elfMobileFacts(androidObject(PAGE_4K));
    assert.ok(fourK.ok);
    assert.deepEqual(fourK.facts.loadAlignments, [PAGE_4K], "without the link args the linker aligns to 4 KB");
  });

  const notElf32 = Buffer.from(androidObject(ANDROID_PAGE_BYTES));
  notElf32[4] = 1;
  const hostileElves: Array<[string, Uint8Array]> = [
    ["empty bytes", new Uint8Array()],
    ["a Mach-O file", machO({}, [buildVersion(2, machoVersion(16, 0))])],
    ["a 32-bit ELF", notElf32],
    ["a truncated ELF", androidObject(ANDROID_PAGE_BYTES).subarray(0, 100)],
  ];
  for (const [label, bytes] of hostileElves) {
    it(`refuses ${label} as not-elf, typed, without throwing`, () => {
      const read = elfMobileFacts(bytes);
      assert.equal(read.ok, false);
      assert.equal(!read.ok && read.code, MobileFactRefusal.NotElf);
    });
  }
});

describe("the CI smoke's verdict on a phone shell's lifecycle log", () => {
  const ndjson = (...events: object[]) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const resumed = { event: "resumed", resumes: 1 };
  const receipt = (backend: string, tier: string) =>
    JSON.stringify({ tier, backend, adapter: "SwiftShader Device", nativeEnhanced: [] });

  it("passes on a WebGPU-core adapter on the expected backend, whatever came before it", () => {
    const log = ndjson(
      resumed,
      { event: "self-test", record: "/x" },
      { event: "gpu", receipt: receipt("vulkan", "core") },
    );
    assert.deepEqual(shellSmokeVerdict(log, "vulkan"), {
      pass: true,
      outcome: ShellSmoke.Adapter,
      detail: "SwiftShader Device (vulkan, core)",
    });
  });

  it("passes on the typed gpu-unsupported refusal and carries its reason", () => {
    const log = ndjson(resumed, { event: "gpu-unsupported", code: "gpu-unsupported", detail: "Apple2 family only" });
    assert.deepEqual(shellSmokeVerdict(log, "metal"), {
      pass: true,
      outcome: ShellSmoke.GpuUnsupported,
      detail: "Apple2 family only",
    });
  });

  const failing: Array<[string, string, ShellSmoke]> = [
    [
      "a failure event",
      ndjson(resumed, { event: "failed", code: "surface-failed", detail: "no layer" }),
      ShellSmoke.Failed,
    ],
    ["another backend", ndjson({ event: "gpu", receipt: receipt("metal", "core") }), ShellSmoke.WrongAdapter],
    ["another tier", ndjson({ event: "gpu", receipt: receipt("vulkan", "downlevel") }), ShellSmoke.WrongAdapter],
    ["a log a crash cut off", `${ndjson(resumed)}{"event":"gp`, ShellSmoke.NoOutcome],
    ["an empty log", "", ShellSmoke.NoOutcome],
    ["a receipt that is not JSON", ndjson({ event: "gpu", receipt: "{not json" }), ShellSmoke.NoOutcome],
  ];
  for (const [label, log, outcome] of failing) {
    it(`fails on ${label} (${outcome})`, () => {
      const verdict = shellSmokeVerdict(log, "vulkan");
      assert.equal(verdict.pass, false);
      assert.equal(verdict.outcome, outcome);
    });
  }

  // Seen in a CI run: the log ended at `surface-created` and `safe-area` with an
  // adapter, and the capture showed no scene. The shell now logs the first frame it presents on a
  // surface, so a smoke can wait for a drawn frame instead of an admitted adapter.
  it("reads the first frame the shell presented: the world frames rendered and the window it went to", () => {
    const presented = { event: "frame-presented", rendered: 1, window: [640, 320] };
    assert.deepEqual(firstFrameOf(ndjson(resumed, { event: "gpu", receipt: receipt("vulkan", "core") }, presented)), {
      rendered: 1,
      window: [640, 320],
    });
    const again = { event: "frame-presented", rendered: 9, window: [320, 640] };
    assert.deepEqual(firstFrameOf(ndjson(presented, again)), { rendered: 1, window: [640, 320] }, "the first one");
    const none: Array<[string, string]> = [
      ["no frame event", ndjson(resumed, { event: "surface-created", configured: true })],
      ["a frame of no rendered world", ndjson({ event: "frame-presented", rendered: 0, window: [640, 320] })],
      ["a malformed count", ndjson({ event: "frame-presented", rendered: "1", window: [640, 320] })],
      ["a malformed window", ndjson({ event: "frame-presented", rendered: 1, window: [640] })],
      ["a line a crash cut off", '{"event":"frame-presented","rend'],
    ];
    for (const [label, log] of none) assert.equal(firstFrameOf(log), null, label);
  });
});

/** Why the real rows cannot run here, or null. */
function absent(build: MobileBuild): string | null {
  const ios = build !== MobileBuild.Android;
  if (ios && process.platform !== "darwin") return "a Mac (iOS builds need Xcode's SDKs)";
  if (!existsSync(path.join(SYSROOT, "bin", "cargo"))) return `the Rust toolchain (${SYSROOT})`;
  if (!existsSync(path.join(TOOLCHAIN_DIR, "vendor"))) return `the vendored crates (${TOOLCHAIN_DIR}/vendor)`;
  const triple = RUST_MOBILE_BUILDERS[build].triple;
  if (!existsSync(path.join(SYSROOT, "lib", "rustlib", triple, "lib"))) return `rust-std for ${triple}`;
  return null;
}

function needs(build: MobileBuild): { skip?: string } {
  const missing = absent(build);
  if (!missing) return {};
  const offMac = build !== MobileBuild.Android && process.platform !== "darwin";
  if (REQUIRED && !offMac) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/**
 * The host's manifest for the template on the facade by path, as M2.2's writer writes it, with a
 * dev profile without debug info (the rows read link facts, not symbols, and keep the target small).
 */
const HOST_MANIFEST = [
  "[package]",
  'name = "game"',
  'version = "0.0.0"',
  'edition = "2024"',
  "publish = false",
  "",
  "[[bin]]",
  'name = "game"',
  'path = "src/main.rs"',
  "",
  "[dependencies]",
  `genex = { path = ${JSON.stringify(FACADE)} }`,
  "",
  "[profile.dev]",
  "debug = false",
  "",
  "[workspace]",
  "",
].join("\n");

/** The template's sources under the host's manifest and the workspace lock, in a fresh crate folder. */
async function stageTemplate(): Promise<string> {
  const crate = await tmpDir("studio-rust-mobile-");
  await cp(path.join(TEMPLATE, "src"), path.join(crate, "src"), { recursive: true });
  await mkdir(path.join(crate, "assets"), { recursive: true });
  await writeFile(path.join(crate, "Cargo.toml"), HOST_MANIFEST);
  await writeFile(path.join(crate, "Cargo.lock"), readFileSync(WORKSPACE_LOCK));
  return crate;
}

/** The executable cargo reported for the `game` bin (never a path guessed from the target folder). */
function executableOf(stdout: string): string {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string | null };
    if (message.reason === "compiler-artifact" && message.target?.name === "game" && message.executable)
      return message.executable;
  }
  throw new Error(`cargo reported no executable for the game:\n${stdout.slice(-2000)}`);
}

/**
 * Cross-compile the staged template offline for `build` through the env helper (the game's lock
 * line is added offline from the vendored registry, as the lane's `generate-lockfile` does), with `rustflags`
 * passed to the game's own link (`cargo rustc -- …`: the env helper drops RUSTFLAGS) and `env`
 * over the helper's own (the deployment target). Answers the executable's bytes.
 */
async function crossBuild(
  crate: string,
  build: MobileBuild,
  rustflags: readonly string[],
  env: Record<string, string>,
) {
  const triple = RUST_MOBILE_BUILDERS[build].triple;
  const args = ["rustc", "--offline", "--bin", "game", "--target", triple, "--message-format=json"];
  const { stdout } = await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", ...args, "--", ...rustflags], {
    cwd: REPO,
    env: { ...process.env, ...env, GENEX_RUST_WORKSPACE: crate },
    timeout: CROSS_BUILD_MS,
    maxBuffer: OUTPUT_BYTES,
  });
  return await readFile(executableOf(stdout));
}

describe("the Rust template cross-compiles offline for the phones", () => {
  it(
    "for aarch64-linux-android every PT_LOAD is 16 KB aligned with the link args, and a 4 KB link is caught",
    needs(MobileBuild.Android),
    async () => {
      const settings = mobileBuildSettings(MobileBuild.Android, {
        ndk: "/ndk-from-the-env-helper",
        sdkRoot: null,
        host: "darwin",
      });
      assert.ok(settings.ok);
      const crate = await stageTemplate();
      const built = elfMobileFacts(await crossBuild(crate, MobileBuild.Android, settings.rustflags, {}));
      assert.ok(built.ok, !built.ok ? built.detail : "");
      assert.equal(built.facts.machine, ElfMachine.Aarch64);
      assert.ok(built.facts.loadAlignments.length > 0);
      for (const align of built.facts.loadAlignments)
        assert.ok(align >= ANDROID_PAGE_BYTES, `a PT_LOAD aligned to ${align}`);
      // Flipped in GC: this compared against a bare link, which NDK r27 aligns to 4 KB. The pinned
      // NDK r30 (like every NDK since r28) aligns arm64 to 16 KB on its own, so a bare link proves
      // nothing either way. A link that asks for 4 KB pages shows the check tells the two apart.
      const small = elfMobileFacts(
        await crossBuild(crate, MobileBuild.Android, ["-C", `link-arg=-Wl,-z,max-page-size=${SMALL_PAGE_BYTES}`], {}),
      );
      assert.ok(small.ok);
      assert.ok(
        small.facts.loadAlignments.some((align) => align < ANDROID_PAGE_BYTES),
        `a 4 KB link aligned to ${small.facts.loadAlignments.join(", ")}: the check would prove nothing`,
      );
    },
  );

  for (const build of [MobileBuild.IosDevice, MobileBuild.IosSimulator] as const) {
    const builder = RUST_MOBILE_BUILDERS[build];
    it(
      `for ${builder.triple} LC_BUILD_VERSION names ${builder.machoPlatform} with minos ${IOS_DEPLOYMENT_TARGET}`,
      needs(build),
      async () => {
        const crate = await stageTemplate();
        const bytes = await crossBuild(crate, build, [], { IPHONEOS_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET });
        const facts = machOMobileFacts(bytes);
        assert.ok(facts.ok, !facts.ok ? facts.detail : "");
        assert.equal(facts.facts.platform, builder.machoPlatform);
        assert.equal(facts.facts.minos, IOS_DEPLOYMENT_TARGET);
        assert.deepEqual(facts.facts.environment, []);
        for (const dylib of facts.facts.dylibs) assert.match(dylib, /^(\/System\/Library\/Frameworks\/|\/usr\/lib\/)/);
      },
    );
  }

  it(
    "rustc's own iOS deployment target is below 16.0, so a build that does not set it fails admission",
    needs(MobileBuild.IosDevice),
    async () => {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" };
      const { stdout } = await execFileAsync(
        path.join(SYSROOT, "bin", "rustc"),
        ["--print", "deployment-target", "--target", RUST_MOBILE_BUILDERS[MobileBuild.IosDevice].triple],
        { env },
      );
      const version = /(?:IPHONEOS_DEPLOYMENT_TARGET|deployment_target)=([0-9.]+)/.exec(stdout)?.[1];
      assert.ok(version, stdout);
      assert.ok(Number.parseFloat(version) < Number.parseFloat(IOS_DEPLOYMENT_TARGET), `rustc defaults to ${version}`);
    },
  );
});
