/**
 * The phones' toolchain store pieces (M5.4): the person's Android SDK found and probed from plain
 * files (never run), the SDK licence a person accepted, the sdkmanager install that is refused
 * before anything runs without it, the sandboxed store probes that read nothing outside the store
 * (and never the debug keystore), the store's mobile tools located by realpath, and the quarterly
 * lane's rule for Play's yearly target-API bump.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ANDROID_PINS, AndroidLicence, JDK_PIN, ToolchainId, type ToolchainLock } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import {
  ANDROID_SDK_LICENCE_SHA1,
  AndroidSdkError,
  AndroidSdkRefusal,
  androidSdkCandidates,
  installAndroidSdkComponents,
  mobileProbeSandboxOptions,
  PlayTargetState,
  playTargetApiCheck,
  probeAndroidSdk,
  probeStoreJdk,
  recordAndroidLicence,
  storeProbeRequest,
  UserSideState,
  userSideStatus,
} from "../../src/substrate/toolchain-store/android-sdk.ts";
import { componentFolder, locateMobileStoreTools, RECEIPT_FILE } from "../../src/substrate/toolchain-store/locate.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BUILD_TOOLS = ["aapt2", "zipalign", "apksigner", "d8"] as const;
const PINNED_BUILD_TOOLS = `${ANDROID_PINS.buildToolsMajor}.0.0`;

interface SdkShape {
  licence?: string | null;
  platform?: boolean;
  buildTools?: readonly string[];
  ndks?: readonly string[];
  sdkmanager?: boolean;
}

async function touch(file: string, text = ""): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** A fake SDK at `root`: the files the probe reads, and nothing it may run. */
async function makeSdk(root: string, shape: SdkShape = {}): Promise<string> {
  const licence = shape.licence === undefined ? ANDROID_SDK_LICENCE_SHA1 : shape.licence;
  if (licence !== null) await touch(path.join(root, "licenses", "android-sdk-license"), `\n${licence}\n`);
  if (shape.platform ?? true) await touch(path.join(root, "platforms", ANDROID_PINS.platform, "android.jar"), "jar");
  for (const version of shape.buildTools ?? [PINNED_BUILD_TOOLS])
    for (const tool of BUILD_TOOLS) await touch(path.join(root, "build-tools", version, tool), "#!/bin/sh\n");
  for (const revision of shape.ndks ?? [ANDROID_PINS.ndk])
    await touch(
      path.join(root, "ndk", revision, "source.properties"),
      `Pkg.Desc = Android NDK\nPkg.Revision = ${revision}\n`,
    );
  if (shape.sdkmanager ?? true) {
    const manager = path.join(root, "cmdline-tools", "latest", "bin", "sdkmanager");
    await touch(manager, "#!/bin/sh\nexit 0\n");
    await chmod(manager, 0o755);
  }
  // Device tools are in a real SDK too; the probe never hands them out.
  await touch(path.join(root, "platform-tools", "adb"), "#!/bin/sh\n");
  return root;
}

const okRun = (stdout = "", stderr = "") =>
  ({
    code: 0,
    signal: null,
    stdout,
    stderr,
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: "",
    cwd: "",
  }) satisfies RunResult;

/** A sandbox `run` that records each request and answers `result`. */
function recordingRun(result: RunResult = okRun()) {
  const calls: RunRequest[] = [];
  return {
    calls,
    run: async (request: RunRequest) => {
      calls.push(request);
      return result;
    },
  };
}

async function probeAt(root: string, forbiddenRoots: readonly string[] = []) {
  return probeAndroidSdk({ candidates: [root], forbiddenRoots, platform: "darwin" });
}

const refusal = (code: AndroidSdkRefusal) => (error: unknown) =>
  error instanceof AndroidSdkError && error.code === code;

describe("the person's Android SDK, probed from its files", () => {
  it("finds the pinned platform, Build-Tools 36.x and the pinned NDK, and never hands out the device tools", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), {
      buildTools: ["35.0.0", PINNED_BUILD_TOOLS, "36.1.0"],
      ndks: ["27.1.12297006", ANDROID_PINS.ndk],
    });
    const found = await probeAt(root);
    assert.ok(found);
    assert.equal(found.licenceAccepted, true);
    assert.ok(found.platformJar?.endsWith(path.join(ANDROID_PINS.platform, "android.jar")));
    assert.equal(found.buildTools?.version, "36.1.0", "the newest Build-Tools of the pinned major");
    assert.equal(found.ndk?.version, ANDROID_PINS.ndk);
    assert.deepEqual(found.ndkVersions, ["27.1.12297006", ANDROID_PINS.ndk]);
    assert.ok(!JSON.stringify(found).includes("platform-tools"), "adb's folder is never part of the answer");
    assert.deepEqual(userSideStatus(found), {
      [ToolchainId.AndroidSdk]: UserSideState.Ready,
      [ToolchainId.AndroidBuildTools]: UserSideState.Ready,
      [ToolchainId.AndroidNdk]: UserSideState.Ready,
    });
  });

  it("reads an NDK of another revision as other-version, and an SDK without the platform as missing", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), {
      platform: false,
      buildTools: ["35.0.0"],
      ndks: ["27.1.12297006"],
    });
    const found = await probeAt(root);
    assert.ok(found);
    assert.equal(found.ndk, null);
    assert.equal(found.buildTools, null);
    assert.deepEqual(userSideStatus(found), {
      [ToolchainId.AndroidSdk]: UserSideState.Missing,
      [ToolchainId.AndroidBuildTools]: UserSideState.OtherVersion,
      [ToolchainId.AndroidNdk]: UserSideState.OtherVersion,
    });
    assert.deepEqual(userSideStatus(null), {
      [ToolchainId.AndroidSdk]: UserSideState.Missing,
      [ToolchainId.AndroidBuildTools]: UserSideState.Missing,
      [ToolchainId.AndroidNdk]: UserSideState.Missing,
    });
  });

  it("takes the first candidate that is an SDK, and none that sits inside a credential home", async () => {
    const base = await tmpDir("android-sdk-");
    const credentialHome = path.join(base, ".android");
    const inside = await makeSdk(path.join(credentialHome, "sdk"));
    const linkedIn = path.join(base, "linked-sdk");
    await symlink(inside, linkedIn);
    const good = await makeSdk(path.join(base, "good-sdk"));
    const found = await probeAndroidSdk({
      candidates: [path.join(base, "absent"), inside, linkedIn, good],
      forbiddenRoots: [credentialHome],
      platform: "darwin",
    });
    assert.equal(found?.root, await realpath(good));
  });

  it("names the default SDK places and the ones the environment names, without duplicates", () => {
    const home = "/Users/person";
    const env = { ANDROID_HOME: "/opt/sdk", ANDROID_SDK_ROOT: "/opt/sdk" };
    assert.deepEqual(androidSdkCandidates(env, home, "darwin"), ["/opt/sdk", "/Users/person/Library/Android/sdk"]);
    assert.deepEqual(androidSdkCandidates({}, "/home/p", "linux"), ["/home/p/Android/Sdk"]);
    assert.deepEqual(androidSdkCandidates({ ANDROID_HOME: "relative/sdk" }, "/home/p", "linux"), [
      "/home/p/Android/Sdk",
    ]);
  });

  describe("hostile layouts: a part reached through a link out of the SDK, or an oversized file, is not found", () => {
    const rows = [
      {
        name: "NDK folder linked outside",
        plant: async (root: string, outside: string) => {
          const ndk = await makeSdk(path.join(outside, "other"), {});
          await mkdir(path.join(root, "ndk"), { recursive: true });
          await symlink(path.join(ndk, "ndk", ANDROID_PINS.ndk), path.join(root, "ndk", ANDROID_PINS.ndk));
        },
        check: (found: Awaited<ReturnType<typeof probeAt>>) => assert.equal(found?.ndk, null),
      },
      {
        name: "source.properties is a link",
        plant: async (root: string, outside: string) => {
          await touch(path.join(outside, "props"), `Pkg.Revision = ${ANDROID_PINS.ndk}\n`);
          await mkdir(path.join(root, "ndk", ANDROID_PINS.ndk), { recursive: true });
          await symlink(path.join(outside, "props"), path.join(root, "ndk", ANDROID_PINS.ndk, "source.properties"));
        },
        check: (found: Awaited<ReturnType<typeof probeAt>>) => assert.equal(found?.ndk, null),
      },
      {
        name: "source.properties is huge",
        plant: async (root: string) =>
          touch(
            path.join(root, "ndk", ANDROID_PINS.ndk, "source.properties"),
            `Pkg.Revision = ${ANDROID_PINS.ndk}\n${"x".repeat(200_000)}`,
          ),
        check: (found: Awaited<ReturnType<typeof probeAt>>) => assert.equal(found?.ndk, null),
      },
      {
        name: "build-tools folder linked outside",
        plant: async (root: string, outside: string) => {
          for (const tool of BUILD_TOOLS) await touch(path.join(outside, "bt", tool));
          await mkdir(path.join(root, "build-tools"), { recursive: true });
          await symlink(path.join(outside, "bt"), path.join(root, "build-tools", PINNED_BUILD_TOOLS));
        },
        check: (found: Awaited<ReturnType<typeof probeAt>>) => assert.equal(found?.buildTools, null),
      },
      {
        name: "platform jar linked outside",
        plant: async (root: string, outside: string) => {
          await touch(path.join(outside, "android.jar"));
          await mkdir(path.join(root, "platforms", ANDROID_PINS.platform), { recursive: true });
          await symlink(
            path.join(outside, "android.jar"),
            path.join(root, "platforms", ANDROID_PINS.platform, "android.jar"),
          );
        },
        check: (found: Awaited<ReturnType<typeof probeAt>>) => assert.equal(found?.platformJar, null),
      },
      {
        name: "licence file is a link to an accepted one",
        plant: async (root: string, outside: string) => {
          await touch(path.join(outside, "lic"), ANDROID_SDK_LICENCE_SHA1);
          await mkdir(path.join(root, "licenses"), { recursive: true });
          await symlink(path.join(outside, "lic"), path.join(root, "licenses", "android-sdk-license"));
        },
        check: (found: Awaited<ReturnType<typeof probeAt>>) => assert.equal(found?.licenceAccepted, false),
      },
    ];
    for (const row of rows) {
      it(row.name, async () => {
        const base = await tmpDir("android-sdk-");
        const root = await makeSdk(path.join(base, "sdk"), {
          licence: null,
          platform: false,
          buildTools: [],
          ndks: [],
        });
        await row.plant(root, path.join(base, "outside"));
        row.check(await probeAt(root));
      });
    }
  });
});

describe("installing the SDK's parts: only under a licence the person accepted", () => {
  const jdkHome = "/store/jdk/21";

  it("refuses licence-not-accepted before anything runs or downloads", async () => {
    const base = await tmpDir("android-sdk-");
    const root = await makeSdk(path.join(base, "sdk"), { licence: null, platform: false, buildTools: [], ndks: [] });
    const found = await probeAt(root);
    assert.ok(found);
    const { calls, run } = recordingRun();
    await assert.rejects(
      installAndroidSdkComponents(found, { run, jdkHome, userHome: path.join(base, "scratch-android") }),
      refusal(AndroidSdkRefusal.LicenceNotAccepted),
    );
    assert.equal(calls.length, 0, "sdkmanager, the only downloader, never ran");
    assert.equal(await stat(path.join(root, "platforms")).catch(() => null), null, "nothing was written");
  });

  it("refuses a licence file naming another licence's hash the same way", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), { licence: "0".repeat(40), ndks: [] });
    const found = await probeAt(root);
    assert.ok(found);
    const { calls, run } = recordingRun();
    await assert.rejects(
      installAndroidSdkComponents(found, { run, jdkHome, userHome: "/scratch/android" }),
      refusal(AndroidSdkRefusal.LicenceNotAccepted),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses without an SDK, and without sdkmanager, before anything runs", async () => {
    const { calls, run } = recordingRun();
    await assert.rejects(
      installAndroidSdkComponents(null, { run, jdkHome, userHome: "/scratch/android" }),
      refusal(AndroidSdkRefusal.SdkMissing),
    );
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), { sdkmanager: false, ndks: [] });
    const found = await probeAt(root);
    assert.ok(found);
    await assert.rejects(
      installAndroidSdkComponents(found, { run, jdkHome, userHome: "/scratch/android" }),
      refusal(AndroidSdkRefusal.SdkmanagerMissing),
    );
    assert.equal(calls.length, 0);
  });

  it("installs only what is missing, in one sandboxed sdkmanager run that never answers a licence prompt", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), {
      platform: false,
      buildTools: ["35.0.0"],
      ndks: ["27.1.12297006"],
    });
    const found = await probeAt(root);
    assert.ok(found);
    const { calls, run } = recordingRun();
    const result = await installAndroidSdkComponents(found, { run, jdkHome, userHome: "/scratch/android" });
    assert.deepEqual(result.installed, [
      `platforms;${ANDROID_PINS.platform}`,
      `build-tools;${PINNED_BUILD_TOOLS}`,
      `ndk;${ANDROID_PINS.ndk}`,
    ]);
    assert.equal(calls.length, 1);
    const [request] = calls;
    assert.ok(request.command.includes(`'platforms;${ANDROID_PINS.platform}'`));
    assert.ok(request.command.includes(`'--sdk_root=${found.root}'`));
    assert.ok(!request.command.includes("--licenses"), "never the licence prompt");
    assert.equal(request.stdin, undefined, "never a piped yes");
    assert.equal(request.env?.JAVA_HOME, jdkHome);
    assert.equal(request.env?.ANDROID_USER_HOME, "/scratch/android", "never the person's ~/.android");
    assert.deepEqual(request.policy?.allowWrite, [found.root]);
  });

  it("runs nothing when every part is there", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"));
    const found = await probeAt(root);
    assert.ok(found);
    const { calls, run } = recordingRun();
    assert.deepEqual((await installAndroidSdkComponents(found, { run, jdkHome, userHome: "/s" })).installed, []);
    assert.equal(calls.length, 0);
  });

  it("reports a failed sdkmanager run as install-failed", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), { ndks: [] });
    const found = await probeAt(root);
    assert.ok(found);
    const { run } = recordingRun({ ...okRun("", "boom"), code: 1 });
    await assert.rejects(
      installAndroidSdkComponents(found, { run, jdkHome, userHome: "/s" }),
      refusal(AndroidSdkRefusal.InstallFailed),
    );
  });
});

describe("recording the licence the person accepted", () => {
  it("writes the licence's hash once, and the probe then reads it accepted", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), { licence: null });
    await recordAndroidLicence(root, AndroidLicence.Sdk);
    await recordAndroidLicence(root, AndroidLicence.Sdk);
    const text = await readFile(path.join(root, "licenses", "android-sdk-license"), "utf8");
    assert.equal(text.split("\n").filter((line) => line === ANDROID_SDK_LICENCE_SHA1).length, 1);
    assert.equal((await probeAt(root))?.licenceAccepted, true);
  });

  it("keeps the hashes already there", async () => {
    const root = await makeSdk(path.join(await tmpDir("android-sdk-"), "sdk"), { licence: "a".repeat(40) });
    await recordAndroidLicence(root, AndroidLicence.Sdk);
    const lines = (await readFile(path.join(root, "licenses", "android-sdk-license"), "utf8")).split("\n");
    assert.ok(lines.includes("a".repeat(40)));
    assert.ok(lines.includes(ANDROID_SDK_LICENCE_SHA1));
  });

  it("never writes through a link: a linked licenses folder or file is refused and left as it was", async () => {
    const base = await tmpDir("android-sdk-");
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    const linkedFolder = await makeSdk(path.join(base, "sdk-a"), { licence: null });
    await symlink(outside, path.join(linkedFolder, "licenses"));
    await assert.rejects(
      recordAndroidLicence(linkedFolder, AndroidLicence.Sdk),
      refusal(AndroidSdkRefusal.LinkRefused),
    );
    assert.equal(await stat(path.join(outside, "android-sdk-license")).catch(() => null), null);

    const linkedFile = await makeSdk(path.join(base, "sdk-b"), { licence: null });
    await touch(path.join(outside, "victim"), "keep\n");
    await mkdir(path.join(linkedFile, "licenses"), { recursive: true });
    await symlink(path.join(outside, "victim"), path.join(linkedFile, "licenses", "android-sdk-license"));
    await assert.rejects(recordAndroidLicence(linkedFile, AndroidLicence.Sdk), refusal(AndroidSdkRefusal.LinkRefused));
    assert.equal(await readFile(path.join(outside, "victim"), "utf8"), "keep\n");
  });
});

describe("store probes: sandboxed, reading the store and nothing else", () => {
  it("denies the home folder, the credential homes and Studio's debug keystore; reads only the store", () => {
    const options = mobileProbeSandboxOptions({
      store: "/data/toolchains",
      scratchDir: "/data/scratch/probe",
      secretPaths: ["/data/secrets"],
      debugKeyHome: "/data/signing-keys/android-debug",
      home: "/Users/person",
      env: {},
    });
    assert.deepEqual(options.writableRoots, []);
    assert.deepEqual(options.readableRoots, ["/data/toolchains"]);
    assert.ok(options.denyRead?.includes("/Users/person"));
    for (const secret of ["/data/secrets", "/data/signing-keys/android-debug", "/Users/person/.android"])
      assert.ok(options.secretPaths.includes(secret), secret);
  });

  it("refuses a store that holds the debug keystore", () => {
    assert.throws(
      () =>
        mobileProbeSandboxOptions({
          store: "/data",
          scratchDir: "/data/scratch",
          secretPaths: [],
          debugKeyHome: "/data/signing-keys/android-debug",
          home: "/Users/person",
          env: {},
        }),
      refusal(AndroidSdkRefusal.ForbiddenRoot),
    );
  });

  it("refuses to run a probe whose program resolves outside the store, and runs nothing", async () => {
    const base = await tmpDir("android-store-");
    const store = path.join(base, "store");
    const folder = path.join(store, ToolchainId.Jdk, "21.0.12-abcdefabcdef");
    await mkdir(path.join(folder, "bin"), { recursive: true });
    await touch(path.join(base, "elsewhere", "java"), "#!/bin/sh\n");
    await symlink(path.join(base, "elsewhere", "java"), path.join(folder, "bin", "java"));
    await assert.rejects(
      storeProbeRequest({ store, folder, bin: "bin/java", args: ["-version"], label: "jdk" }),
      refusal(AndroidSdkRefusal.OutsideStore),
    );
    await assert.rejects(
      storeProbeRequest({ store, folder: base, bin: "elsewhere/java", args: [], label: "jdk" }),
      refusal(AndroidSdkRefusal.OutsideStore),
    );
    await assert.rejects(
      storeProbeRequest({ store, folder, bin: "../../../elsewhere/java", args: [], label: "jdk" }),
      refusal(AndroidSdkRefusal.OutsideStore),
    );
    const { calls, run } = recordingRun();
    await assert.rejects(probeStoreJdk({ store, folder, run }), refusal(AndroidSdkRefusal.OutsideStore));
    assert.equal(calls.length, 0);
  });

  it("probes the store's JDK in its folder with no network and no writes, and checks it is Temurin's pinned feature", async () => {
    const base = await tmpDir("android-store-");
    const store = path.join(base, "store");
    const folder = path.join(store, ToolchainId.Jdk, "21.0.12-abcdefabcdef");
    await touch(path.join(folder, "bin", "java"), "#!/bin/sh\n");
    const banner = `openjdk version "${JDK_PIN.feature}.0.12" 2026-07-14 LTS\nOpenJDK Runtime Environment Temurin-21.0.12+1`;
    const good = recordingRun(okRun("", banner));
    await probeStoreJdk({ store, folder, run: good.run });
    const [request] = good.calls;
    assert.deepEqual(request.policy?.allowWrite, []);
    assert.deepEqual(request.policy?.allowedDomains, []);
    assert.ok(request.command.startsWith(`'${await realpath(path.join(folder, "bin", "java"))}'`));
    const old = recordingRun(okRun("", 'openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime Environment Temurin-17'));
    await assert.rejects(probeStoreJdk({ store, folder, run: old.run }), refusal(AndroidSdkRefusal.JdkWrongVersion));
  });
});

describe("the store's mobile tools, located by realpath", () => {
  async function install(store: string, id: ToolchainId, version: string, files: readonly string[]) {
    const pin = { version, sha12: "abcdefabcdef" };
    const folder = componentFolder(store, id, pin);
    for (const file of files) await touch(path.join(folder, file));
    const receipt = {
      id,
      version,
      sha256: `abcdefabcdef${"0".repeat(52)}`,
      sha12: pin.sha12,
      bytes: 1,
      host: "darwin-arm64",
      target: null,
      source: "archive",
      installedAt: "2026-10-07T00:00:00.000Z",
    };
    await writeFile(path.join(folder, RECEIPT_FILE), JSON.stringify(receipt));
    return { folder, pin };
  }

  async function androidStore() {
    const base = await tmpDir("android-store-");
    const store = path.join(base, "store");
    const jdk = await install(store, ToolchainId.Jdk, "21.0.12", ["bin/java"]);
    const bundletool = await install(store, ToolchainId.Bundletool, "1.18.1", ["bundletool.jar"]);
    const std = await install(store, ToolchainId.RustStdAndroid, "1.99.0", ["lib/rustlib/aarch64-linux-android/lib/x"]);
    const lock: ToolchainLock = lockOf({
      [ToolchainId.Jdk]: jdk.pin,
      [ToolchainId.Bundletool]: bundletool.pin,
      [ToolchainId.RustStdAndroid]: std.pin,
    });
    return { base, store, lock, jdk };
  }

  it("names java, bundletool and the Android standard library, realpath'd inside the store", async () => {
    const { store, lock } = await androidStore();
    const located = await locateMobileStoreTools(store, lock, BuildTarget.Android);
    assert.ok(located.ok, JSON.stringify(located));
    const real = await realpath(store);
    assert.ok(located.tools.java?.startsWith(real));
    assert.ok(located.tools.bundletool?.endsWith("bundletool.jar"));
    assert.equal(located.tools.std.length, 1);
  });

  it("reads a tool that links out of the store as missing", async () => {
    const { base, store, lock, jdk } = await androidStore();
    await touch(path.join(base, "elsewhere", "java"));
    const java = path.join(jdk.folder, "bin", "java");
    await rm(java);
    await symlink(path.join(base, "elsewhere", "java"), java);
    const located = await locateMobileStoreTools(store, lock, BuildTarget.Android);
    assert.deepEqual(located, { ok: false, missing: [ToolchainId.Jdk] });
  });

  it("names what the lock lacks, and never the person's SDK parts", async () => {
    const { store } = await androidStore();
    const located = await locateMobileStoreTools(store, lockOf({}), BuildTarget.Android);
    assert.deepEqual(located, {
      ok: false,
      missing: [ToolchainId.RustStdAndroid, ToolchainId.Bundletool, ToolchainId.Jdk],
    });
    const ios = await locateMobileStoreTools(store, lockOf({}), BuildTarget.Ios);
    assert.deepEqual(ios, { ok: false, missing: [ToolchainId.RustStdIos, ToolchainId.RustStdIosSim] });
  });
});

describe("the quarterly lane's rule: Play's yearly target-API bump", () => {
  it("is ok with API 36 in October 2026, due soon a quarter before 31 August 2027, behind after it", () => {
    const now = playTargetApiCheck(new Date("2026-10-07T00:00:00Z"), 36);
    assert.equal(now.state, PlayTargetState.Ok);
    assert.equal(now.required, 36);
    assert.equal(now.next.required, 37);
    assert.equal(now.next.from, "2027-08-31");
    assert.equal(playTargetApiCheck(new Date("2027-06-15T00:00:00Z"), 36).state, PlayTargetState.DueSoon);
    assert.equal(playTargetApiCheck(new Date("2027-09-01T00:00:00Z"), 36).state, PlayTargetState.Behind);
    assert.equal(playTargetApiCheck(new Date("2027-09-01T00:00:00Z"), 37).state, PlayTargetState.Ok);
    assert.equal(playTargetApiCheck(new Date("2026-08-30T00:00:00Z"), 35).state, PlayTargetState.DueSoon);
  });

  it("holds the shipped pin: targetSdk meets Play's floor on the pin's date", () => {
    // Injected date, not the clock: a scheduled check against today is the owner's to add (billed CI).
    assert.notEqual(playTargetApiCheck(new Date("2026-10-07T00:00:00Z")).state, PlayTargetState.Behind);
  });
});
