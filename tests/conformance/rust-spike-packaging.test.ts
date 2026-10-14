/**
 * The M0a.16 spike packaging (`scripts/spike/rust-wgpu/ios-app.sh`, `android-apk.sh`): every
 * package is statically checked before anything else happens, and nothing is ever booted or
 * installed (containment stage 1: the Simulator, the emulator and the iPhone are the person's).
 *
 * Hostile inputs are refused with one typed line on stderr (`genex-mobile: {"code":…}`, exit 1)
 * and leave no package behind:
 * - an Info.plist missing a required key, or with a MinimumOSVersion other than 16.0;
 * - an AndroidManifest.xml with minSdk below 29, or without the required
 *   `android.hardware.vulkan.version` 0x401000 uses-feature;
 * - a shared library with a PT_LOAD aligned to 4 KB (Android 15+ devices use 16 KB pages);
 * - an unsigned APK.
 *
 * The plist rows need macOS (`plutil`); the APK rows need the Android SDK build-tools and a JDK
 * (the spike's Temurin): they skip without them, and `GENEX_REQUIRE_ANDROID_SDK=1` turns that
 * skip into a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SPIKE = path.join(REPO, "scripts", "spike", "rust-wgpu");
const IOS_APP = path.join(SPIKE, "ios-app.sh");
const ANDROID_APK = path.join(SPIKE, "android-apk.sh");
const PLIST_TEMPLATE = path.join(SPIKE, "ios", "Info.plist");
const MANIFEST_TEMPLATE = path.join(SPIKE, "android", "AndroidManifest.xml");
const REFUSAL_PREFIX = "genex-mobile: ";
const REFUSAL_EXIT = 1;
const RUN_TIMEOUT_MS = 120_000;
const PAGE_16K = 0x4000;
const PAGE_4K = 0x1000;
const SDK_ROOT = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library", "Android", "sdk");
const SPIKE_JDK = path.join(REPO, ".studio-dev", "spike-toolchain", "tools", "jdk", "Contents", "Home");

/** The refusal codes both scripts print. */
const MobileRefusal = {
  Usage: "usage",
  BootNotAllowed: "boot-not-allowed",
  PlistKeyMissing: "plist-key-missing",
  PlistMinimumOs: "plist-minimum-os",
  ManifestMinSdk: "manifest-min-sdk",
  ManifestVulkanFeature: "manifest-vulkan-feature",
  SoNotAarch64: "so-not-aarch64",
  SoNot16k: "so-not-16k",
  ApkUnsigned: "apk-unsigned",
} as const;
type MobileRefusal = (typeof MobileRefusal)[keyof typeof MobileRefusal];

/** Info.plist keys the iOS check requires (the Simulator and the device both refuse without them). */
const REQUIRED_PLIST_KEYS = [
  "CFBundleIdentifier",
  "CFBundleExecutable",
  "CFBundlePackageType",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "MinimumOSVersion",
  "UISupportedInterfaceOrientations",
  "UILaunchScreen",
  "UIDeviceFamily",
] as const;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const exitCodeOf = (error: { code?: unknown }) => (typeof error.code === "number" ? error.code : 1);

function bash(script: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [script, ...args],
      { cwd: REPO, env: { ...process.env, ...env }, timeout: RUN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolve({ code: error ? exitCodeOf(error) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function refusalOf(result: Run): { code: string; detail: string } | null {
  const line = result.stderr.split("\n").find((l) => l.startsWith(REFUSAL_PREFIX));
  return line ? JSON.parse(line.slice(REFUSAL_PREFIX.length)) : null;
}

function assertRefused(result: Run, code: MobileRefusal): void {
  assert.equal(result.code, REFUSAL_EXIT, `exit ${result.code}; stderr: ${result.stderr}`);
  assert.equal(refusalOf(result)?.code, code, result.stderr);
}

function assertPassed(result: Run): void {
  assert.equal(result.code, 0, `exit ${result.code}; stderr: ${result.stderr}`);
  assert.equal(refusalOf(result), null, result.stderr);
}

/** Every file under `dir`, relative, to prove a refused run wrote nothing there. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

/** A minimal ELF64 shared object header with one PT_LOAD per alignment, for the .so checks. */
function elfWithLoads(machine: number, alignments: number[]): Buffer {
  const EHDR = 64;
  const PHDR = 56;
  const buf = Buffer.alloc(EHDR + PHDR * alignments.length);
  buf.write("\x7fELF", 0, "latin1");
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // little endian
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(3, 16); // ET_DYN
  buf.writeUInt16LE(machine, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(BigInt(EHDR), 32); // e_phoff
  buf.writeUInt16LE(EHDR, 52);
  buf.writeUInt16LE(PHDR, 54);
  buf.writeUInt16LE(alignments.length, 56);
  alignments.forEach((align, i) => {
    const at = EHDR + PHDR * i;
    buf.writeUInt32LE(1, at); // PT_LOAD
    buf.writeUInt32LE(5, at + 4); // R+X
    buf.writeBigUInt64LE(BigInt(align * i), at + 16); // p_vaddr
    buf.writeBigUInt64LE(BigInt(align * i), at + 24); // p_paddr
    buf.writeBigUInt64LE(BigInt(align), at + 48); // p_align
  });
  return buf;
}

const EM_AARCH64 = 183;
const EM_X86_64 = 62;

const MAC_ONLY = process.platform === "darwin" ? {} : { skip: "plutil and the iOS packaging are macOS-only" };
const POSIX_ONLY = process.platform === "win32" ? { skip: "the spike scripts are bash" } : {};

function newestBuildTools(): string | null {
  const dir = path.join(SDK_ROOT, "build-tools");
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).filter((v) => existsSync(path.join(dir, v, "apksigner")));
  return versions.length ? path.join(dir, versions.sort().at(-1) ?? "") : null;
}

function sdkSkip(): { skip?: string } {
  const ready = newestBuildTools() !== null && existsSync(path.join(SPIKE_JDK, "bin", "java"));
  if (ready) return {};
  if (process.env.GENEX_REQUIRE_ANDROID_SDK === "1") return {};
  return { skip: "no Android build-tools or spike JDK (GENEX_REQUIRE_ANDROID_SDK=1 makes this a failure)" };
}

describe("ios-app.sh refuses a bad Info.plist before packaging", MAC_ONLY, () => {
  it("passes the template for both platforms", async () => {
    assertPassed(await bash(IOS_APP, ["--check-plist", PLIST_TEMPLATE]));
  });

  for (const key of REQUIRED_PLIST_KEYS) {
    it(`refuses a plist without ${key}`, async () => {
      const dir = await tmpDir("genex-plist-");
      const plist = path.join(dir, "Info.plist");
      await copyFile(PLIST_TEMPLATE, plist);
      await new Promise<void>((resolve, reject) =>
        execFile("plutil", ["-remove", key, plist], (error) => (error ? reject(error) : resolve())),
      );
      const result = await bash(IOS_APP, ["--check-plist", plist]);
      assertRefused(result, MobileRefusal.PlistKeyMissing);
      assert.match(refusalOf(result)?.detail ?? "", new RegExp(key));
    });
  }

  it("refuses a MinimumOSVersion other than 16.0", async () => {
    const dir = await tmpDir("genex-plist-");
    const plist = path.join(dir, "Info.plist");
    await copyFile(PLIST_TEMPLATE, plist);
    await new Promise<void>((resolve, reject) =>
      execFile("plutil", ["-replace", "MinimumOSVersion", "-string", "15.0", plist], (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    assertRefused(await bash(IOS_APP, ["--check-plist", plist]), MobileRefusal.PlistMinimumOs);
  });

  it("refuses a bad plist before any build and leaves no .app", async () => {
    const dir = await tmpDir("genex-plist-");
    const plist = path.join(dir, "Info.plist");
    const out = path.join(dir, "out");
    await copyFile(PLIST_TEMPLATE, plist);
    await new Promise<void>((resolve, reject) =>
      execFile("plutil", ["-remove", "MinimumOSVersion", plist], (error) => (error ? reject(error) : resolve())),
    );
    const result = await bash(IOS_APP, ["--simulator", "--no-boot", "--plist", plist], {
      GENEX_MOBILE_OUT: out,
      // A build would fail loudly here: the refusal must come first.
      GENEX_SPIKE_TOOLCHAIN_DIR: path.join(dir, "no-toolchain"),
    });
    assertRefused(result, MobileRefusal.PlistKeyMissing);
    assert.deepEqual(filesUnder(out), []);
  });

  it("never boots: --boot is refused", async () => {
    assertRefused(await bash(IOS_APP, ["--simulator", "--boot"]), MobileRefusal.BootNotAllowed);
  });
});

describe("android-apk.sh refuses a bad manifest or library before packaging", POSIX_ONLY, () => {
  it("passes the manifest template", async () => {
    assertPassed(await bash(ANDROID_APK, ["--check-manifest", MANIFEST_TEMPLATE]));
  });

  const manifestRows: Array<{ name: string; edit: (xml: string) => string; code: MobileRefusal }> = [
    {
      name: "minSdk 28",
      edit: (xml) => xml.replace(/android:minSdkVersion="\d+"/, 'android:minSdkVersion="28"'),
      code: MobileRefusal.ManifestMinSdk,
    },
    {
      name: "no uses-sdk",
      edit: (xml) => xml.replace(/<uses-sdk[^>]*\/>/, ""),
      code: MobileRefusal.ManifestMinSdk,
    },
    {
      name: "no Vulkan uses-feature",
      edit: (xml) => xml.replace(/<uses-feature[^>]*android\.hardware\.vulkan\.version[^>]*\/>/, ""),
      code: MobileRefusal.ManifestVulkanFeature,
    },
    {
      name: "the Vulkan uses-feature not required",
      edit: (xml) => xml.replace(/android:required="true"/, 'android:required="false"'),
      code: MobileRefusal.ManifestVulkanFeature,
    },
    {
      name: "Vulkan 1.0.3 instead of 1.1",
      edit: (xml) => xml.replace(/android:version="0x401000"/, 'android:version="0x400003"'),
      code: MobileRefusal.ManifestVulkanFeature,
    },
  ];

  for (const row of manifestRows) {
    it(`refuses a manifest with ${row.name}`, async () => {
      const dir = await tmpDir("genex-manifest-");
      const manifest = path.join(dir, "AndroidManifest.xml");
      const xml = await readFile(MANIFEST_TEMPLATE, "utf8");
      const edited = row.edit(xml);
      assert.notEqual(edited, xml, "the fixture edit changed the manifest");
      await writeFile(manifest, edited);
      assertRefused(await bash(ANDROID_APK, ["--check-manifest", manifest]), row.code);
    });
  }

  it("refuses a bad manifest before any build and leaves no APK", async () => {
    const dir = await tmpDir("genex-manifest-");
    const manifest = path.join(dir, "AndroidManifest.xml");
    const out = path.join(dir, "out");
    const xml = await readFile(MANIFEST_TEMPLATE, "utf8");
    await writeFile(manifest, xml.replace(/android:minSdkVersion="\d+"/, 'android:minSdkVersion="26"'));
    const result = await bash(ANDROID_APK, ["--both-activities", "--manifest", manifest], {
      GENEX_MOBILE_OUT: out,
      GENEX_SPIKE_TOOLCHAIN_DIR: path.join(dir, "no-toolchain"),
    });
    assertRefused(result, MobileRefusal.ManifestMinSdk);
    assert.deepEqual(filesUnder(out), []);
  });

  const soRows: Array<{ name: string; elf: Buffer; code: MobileRefusal | null }> = [
    { name: "16 KB PT_LOADs", elf: elfWithLoads(EM_AARCH64, [PAGE_16K, PAGE_16K]), code: null },
    { name: "a 4 KB PT_LOAD", elf: elfWithLoads(EM_AARCH64, [PAGE_16K, PAGE_4K]), code: MobileRefusal.SoNot16k },
    { name: "no PT_LOAD", elf: elfWithLoads(EM_AARCH64, []), code: MobileRefusal.SoNot16k },
    { name: "an x86-64 library", elf: elfWithLoads(EM_X86_64, [PAGE_16K]), code: MobileRefusal.SoNotAarch64 },
    { name: "not an ELF file", elf: Buffer.from("MZ not an elf"), code: MobileRefusal.SoNotAarch64 },
  ];

  for (const row of soRows) {
    it(`${row.code ? "refuses" : "passes"} a library with ${row.name}`, async () => {
      const dir = await tmpDir("genex-so-");
      const so = path.join(dir, "libmain.so");
      await writeFile(so, row.elf);
      const result = await bash(ANDROID_APK, ["--check-so", so]);
      if (row.code) assertRefused(result, row.code);
      else assertPassed(result);
    });
  }

  it("never boots: --install is refused", async () => {
    assertRefused(await bash(ANDROID_APK, ["--both-activities", "--install"]), MobileRefusal.BootNotAllowed);
  });
});

describe("android-apk.sh refuses an unsigned or misaligned APK", { ...POSIX_ONLY, ...sdkSkip() }, () => {
  /** An APK-shaped zip holding one library, aligned with the SDK's zipalign but never signed. */
  async function unsignedApk(dir: string, so: Buffer): Promise<string> {
    const tools = newestBuildTools();
    assert.ok(tools, "Android build-tools are installed");
    const stage = path.join(dir, "stage");
    await mkdir(path.join(stage, "lib", "arm64-v8a"), { recursive: true });
    await writeFile(path.join(stage, "lib", "arm64-v8a", "libmain.so"), so);
    await writeFile(path.join(stage, "AndroidManifest.xml"), "not binary xml");
    const raw = path.join(dir, "raw.apk");
    const apk = path.join(dir, "unsigned.apk");
    const exec = (cmd: string, args: string[], cwd = dir) =>
      new Promise<void>((resolve, reject) =>
        execFile(cmd, args, { cwd }, (error, _o, stderr) => (error ? reject(new Error(String(stderr))) : resolve())),
      );
    await exec("zip", ["-q", "-0", "-r", raw, "."], stage);
    await exec(path.join(tools, "zipalign"), ["-P", "16", "-f", "4", raw, apk]);
    return apk;
  }

  it("refuses an unsigned APK", async () => {
    const dir = await tmpDir("genex-apk-");
    const apk = await unsignedApk(dir, elfWithLoads(EM_AARCH64, [PAGE_16K]));
    assertRefused(await bash(ANDROID_APK, ["--check-apk", apk]), MobileRefusal.ApkUnsigned);
  });

  it("refuses an APK carrying a 4 KB-aligned library before checking its signature", async () => {
    const dir = await tmpDir("genex-apk-");
    const apk = await unsignedApk(dir, elfWithLoads(EM_AARCH64, [PAGE_4K]));
    assertRefused(await bash(ANDROID_APK, ["--check-apk", apk]), MobileRefusal.SoNot16k);
  });
});
