/**
 * Android packaging with the real tools (M5.2): aapt2, zipalign, apksigner and bundletool from the
 * person's Android SDK (`ANDROID_HOME`, opt-in: never a default path) and the dev store's JDK and
 * bundletool (`GENEX_RUST_TOOLCHAIN_DIR`, `.studio-dev/spike-toolchain` by default), each run in a
 * real ProcessSandbox of its own. The dev APK is signed with a Studio debug key made in the test's
 * own folder and the AAB with a throwaway keystore made here: never a real identity, never
 * `~/.android`. Nothing is installed or launched. `GENEX_REQUIRE_TOOLCHAINS=1` turns a skip into a
 * failure naming the missing tool.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { ExportSigning } from "../../src/shared/game-export-contract.ts";
import { ANDROID_PINS } from "../../src/shared/toolchain.ts";
import {
  ANDROID_LIBRARY_ENTRY,
  type AndroidPackageContext,
  type AndroidPackageTools,
  AndroidOrientation,
  packageAndroidAab,
  packageAndroidApk,
  readAndroidPayload,
  readZipEntries,
  ZipMethod,
  zipEntryData,
} from "../../src/substrate/android-package.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { SigningRequester } from "../../src/substrate/windows-sign.ts";
import { androidBinary } from "../fixtures/rust-bundles/binaries.ts";
import { DEV_RUST_TOOLCHAIN } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
const KEY_PASSWORD = "throwaway-test-keystore-pass";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The tools, or why the rows do not run (a throw under `GENEX_REQUIRE_TOOLCHAINS=1`). */
function findTools(): AndroidPackageTools | string {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const javaHome = path.join(DEV_RUST_TOOLCHAIN, "tools", "jdk", "Contents", "Home");
  const bundletoolJar = path.join(DEV_RUST_TOOLCHAIN, "tools", "bundletool", "bundletool.jar");
  const buildTools = sdk ? path.join(sdk, "build-tools") : "";
  const pinned = existsSync(buildTools)
    ? readdirSync(buildTools)
        .filter((version) => version.startsWith(`${ANDROID_PINS.buildToolsMajor}.`))
        .sort()
        .at(-1)
    : undefined;
  const tools: AndroidPackageTools = {
    aapt2: path.join(buildTools, pinned ?? "?", "aapt2"),
    zipalign: path.join(buildTools, pinned ?? "?", "zipalign"),
    apksigner: path.join(buildTools, pinned ?? "?", "apksigner"),
    androidJar: path.join(sdk ?? "", "platforms", ANDROID_PINS.platform, "android.jar"),
    javaHome,
    bundletoolJar,
  };
  const missing = sdk
    ? Object.entries(tools).find(([, file]) => !existsSync(file))?.[0]
    : "ANDROID_HOME (the Android SDK)";
  if (missing === undefined && process.platform === "darwin") return tools;
  const why = `not run: ${missing ?? "a Mac host"} absent`;
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${why}`);
  return why;
}

const found = findTools();
const skip = typeof found === "string" ? found : false;

/** A lane `out/`, the packaging context over real sandboxes, and the folders it uses. */
async function rig(tools: AndroidPackageTools, library: Uint8Array = androidBinary()) {
  const root = await realpath(await tmpDir("android-real-"));
  const out = path.join(root, "game.out");
  const files: Record<string, Uint8Array> = {
    game: library,
    "assets/level.json": Buffer.from('{"fish":3}'),
    "assets/sfx/splash.ogg": Buffer.alloc(4096, 7),
  };
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(out, rel)), { recursive: true });
    await writeFile(path.join(out, rel), bytes);
  }
  const outputs = Object.entries(files).map(([rel, bytes]) => ({ path: rel, sha256: sha256(bytes) }));
  const exportsDir = path.join(root, "exports");
  await mkdir(exportsDir);
  const context: AndroidPackageContext = {
    tools,
    sandboxFor: (options) => ProcessSandbox.create(options),
    stagingRoot: path.join(root, "staging"),
    secretPaths: [path.join(root, "userData", "secrets"), path.join(root, "keys", "android-debug")],
    denyWrite: [path.join(root, "games")],
    secretValues: [],
    signer: {
      host: StudioPlatform.Mac,
      home: path.join(root, "home"),
      env: { GENEX_TEST_KEY_PASS: KEY_PASSWORD },
      forbiddenRoots: [path.join(root, "games")],
      keyHome: path.join(root, "keys", "android-debug"),
    },
  };
  return { root, out, outputs, exportsDir, context, payload: await readAndroidPayload(out, outputs) };
}

const MANIFEST = {
  applicationId: "games.genex.game.g0123456789ab",
  label: 'Pond & "Friends"',
  versionCode: 1,
  versionName: "1.0",
  orientation: AndroidOrientation.Landscape,
};

async function run(file: string, args: string[], tools: AndroidPackageTools) {
  return execFileAsync(file, args, {
    env: { ...process.env, JAVA_HOME: tools.javaHome, PATH: `${path.join(tools.javaHome, "bin")}:/usr/bin:/bin` },
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * The APK Play would make from a bundle (bundletool's universal APK, signed with the throwaway key,
 * never `~/.android`'s): the library stored, and the APK passing `zipalign -c -P 16`.
 */
async function assertUniversalApkAligned(tools: AndroidPackageTools, root: string, aab: string, keystore: string) {
  const apks = path.join(root, "pond.apks");
  const keyArgs = [`--ks=${keystore}`, `--ks-pass=pass:${KEY_PASSWORD}`, "--ks-key-alias=upload"];
  await run(
    path.join(tools.javaHome, "bin", "java"),
    [
      ...["-jar", tools.bundletoolJar, "build-apks", "--mode=universal", `--bundle=${aab}`, `--output=${apks}`],
      ...keyArgs,
      `--key-pass=pass:${KEY_PASSWORD}`,
    ],
    tools,
  );
  const universal = readZipEntries(await readFile(apks)).find((entry) => entry.name === "universal.apk");
  assert.ok(universal);
  const apk = path.join(root, "universal.apk");
  await writeFile(apk, zipEntryData(universal));
  await run(tools.zipalign, ["-c", "-P", "16", "4", apk], tools);
  const lib = readZipEntries(await readFile(apk)).find((entry) => entry.name === ANDROID_LIBRARY_ENTRY);
  assert.equal(lib?.method, ZipMethod.Stored);
}

/** What aapt2 compiles API 36's configuration changes to (every flag but resourcesUnused). */
const COMPILED_CONFIG_CHANGES = 0xd000ffff;

describe("real Android packaging", { skip }, () => {
  it("a dev APK: no permission, minSdk 29, targetSdk 36, Vulkan 1.1 required, zipalign -P 16, apksigner verified", async () => {
    if (typeof found === "string") return;
    const r = await rig(found);
    const made = await packageAndroidApk(r.context, {
      manifest: MANIFEST,
      payload: r.payload,
      notices: [{ rel: "rust-runtime/std/LICENSE-MIT", bytes: Buffer.from("MIT licence text\n") }],
      signing: { kind: ExportSigning.AndroidDebug },
      requestedBy: SigningRequester.Harness,
      target: path.join(r.exportsDir, "pond-debug.apk"),
    });
    const badging = (await run(found.aapt2, ["dump", "badging", made.file], found)).stdout;
    assert.match(badging, /^minSdkVersion:'29'$/m);
    assert.match(badging, /^targetSdkVersion:'36'$/m);
    assert.doesNotMatch(badging, /uses-permission/);
    assert.match(badging, /uses-feature.*android\.hardware\.vulkan\.version.*version='4198400'/);
    assert.match(badging, /^application: label='Pond & \\"Friends\\"'/m);
    assert.match(badging, /native-code: 'arm64-v8a'/);
    // Pass-1 fix: the compiled activity handles every configuration change in place, the theme
    // overlays' assetsPaths (0x80000000) included, so the system never relaunches it.
    const tree = (await run(found.aapt2, ["dump", "xmltree", made.file, "--file", "AndroidManifest.xml"], found))
      .stdout;
    const handled = Number.parseInt(/configChanges\(0x0101001f\)=0x([0-9a-f]+)/.exec(tree)?.[1] ?? "0", 16);
    assert.equal(handled, COMPILED_CONFIG_CHANGES, `configChanges compiled as 0x${handled.toString(16)}`);
    await run(found.zipalign, ["-c", "-P", "16", "4", made.file], found);
    const verify = await run(found.apksigner, ["verify", "--min-sdk-version", "29", "--print-certs", made.file], found);
    assert.match(verify.stdout, /CN=Genex Debug/);
    const entries = readZipEntries(await readFile(made.file));
    const lib = entries.find((entry) => entry.name === ANDROID_LIBRARY_ENTRY);
    assert.equal(lib?.method, ZipMethod.Stored);
    assert.deepEqual(
      entries.filter((entry) => entry.name.startsWith("lib/")).map((entry) => entry.name),
      [ANDROID_LIBRARY_ENTRY],
    );
    assert.ok(entries.some((entry) => entry.name === "assets/genex-notices/rust-runtime/std/LICENSE-MIT"));
    assert.ok(!entries.some((entry) => entry.name === "classes.dex"));
  });

  it("an AAB: bundletool validates it, 16 KB-aligned stored native libraries, signed with the person's keystore", async () => {
    if (typeof found === "string") return;
    const r = await rig(found);
    const keystore = path.join(r.root, "person", "release.p12");
    await mkdir(path.dirname(keystore), { recursive: true });
    await run(
      path.join(found.javaHome, "bin", "keytool"),
      [
        ...["-genkeypair", "-noprompt", "-keystore", keystore, "-storetype", "PKCS12", "-alias", "upload"],
        ...["-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=Throwaway Test"],
        ...["-storepass", KEY_PASSWORD, "-keypass", KEY_PASSWORD],
      ],
      found,
    );
    const made = await packageAndroidAab(r.context, {
      manifest: MANIFEST,
      payload: r.payload,
      notices: [],
      signing: {
        kind: ExportSigning.AndroidRelease,
        keystore,
        alias: "upload",
        password: { env: "GENEX_TEST_KEY_PASS" },
      },
      requestedBy: SigningRequester.Person,
      target: path.join(r.exportsDir, "pond.aab"),
    });
    const bundletool = [`-jar`, found.bundletoolJar];
    const java = path.join(found.javaHome, "bin", "java");
    await run(java, [...bundletool, "validate", `--bundle=${made.file}`], found);
    const manifest = (await run(java, [...bundletool, "dump", "manifest", `--bundle=${made.file}`], found)).stdout;
    assert.doesNotMatch(manifest, /uses-permission/);
    assert.match(manifest, /android:minSdkVersion="29"/);
    assert.match(manifest, /android:targetSdkVersion="36"/);
    const config = (await run(java, [...bundletool, "dump", "config", `--bundle=${made.file}`], found)).stdout;
    assert.match(config, /PAGE_ALIGNMENT_16K/);
    const verify = await run(path.join(found.javaHome, "bin", "jarsigner"), ["-verify", made.file], found);
    assert.match(verify.stdout, /jar verified/);
    await assertUniversalApkAligned(found, r.root, made.file, keystore);
  });

  it("the pond's real Android library (when the M0a spike built it) packages the same way", {
    skip: existsSync(path.resolve(".studio-dev/spike-mobile/out/android/pond-native-activity-debug.apk"))
      ? false
      : "not run: no M0a pond APK to take a real libmain.so from",
  }, async () => {
    if (typeof found === "string") return;
    const spike = path.resolve(".studio-dev/spike-mobile/out/android/pond-native-activity-debug.apk");
    const entry = readZipEntries(await readFile(spike)).find((each) => each.name === ANDROID_LIBRARY_ENTRY);
    assert.ok(entry);
    const r = await rig(found, zipEntryData(entry));
    const made = await packageAndroidApk(r.context, {
      manifest: { ...MANIFEST, label: "Pond" },
      payload: r.payload,
      notices: [],
      signing: { kind: ExportSigning.AndroidDebug },
      requestedBy: SigningRequester.Harness,
      target: path.join(r.exportsDir, "pond-debug.apk"),
    });
    await run(found.zipalign, ["-c", "-P", "16", "4", made.file], found);
  });
});
