/**
 * Android product packaging (`src/substrate/android-package.ts`, M5.2) and the Android export run
 * (`src/main/core/android-export-run.ts`): the host-written manifest from a fixed table (no
 * permission ever, minSdk 29, targetSdk 36, the required Vulkan 1.1 uses-feature), the admitted
 * payload (only `libmain.so` from the lane's admitted `game`, assets at their admitted digests,
 * no other native library), packaged entries re-verified against those digests, the zip reader's
 * hostile table, and every refusal that comes before a tool runs. The real aapt2, zipalign,
 * apksigner and bundletool rows are `android-package-real.test.ts`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  ExportError,
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
  MobileArtifact,
} from "../../src/shared/game-export-contract.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, type GameProject, GameStack } from "../../src/shared/game-project.ts";
import { ANDROID_PINS } from "../../src/shared/toolchain.ts";
import { bundleIdOf } from "../../src/substrate/native-bundle.ts";
import { NoticeSourceKind } from "../../src/substrate/native-export.ts";
import {
  ANDROID_LIBRARY_ENTRY,
  PACKAGE_LAYOUT,
  AndroidActivity,
  type AndroidManifestSpec,
  AndroidOrientation,
  AndroidPackageError,
  AndroidPackageProblem,
  type AndroidPackageContext,
  androidApplicationId,
  androidManifestFacts,
  androidManifestXml,
  androidRuntimeSources,
  checkAndroidManifest,
  packageAndroidAab,
  packageAndroidApk,
  readAndroidPayload,
  readZipEntries,
  verifyPackagedEntries,
  writeZipMembers,
  ZipMethod,
} from "../../src/substrate/android-package.ts";
import { RustRuntimePart, rustNotices } from "../../src/substrate/rust-notices.ts";
import type { RunRequest, RunResult, SandboxOptions } from "../../src/substrate/spawn.ts";
import { SigningRequester } from "../../src/substrate/windows-sign.ts";
import {
  type AndroidExportDeps,
  androidVersionCode,
  exportAndroidGame,
} from "../../src/main/core/android-export-run.ts";
import type { MobileExportGameRequest } from "../../src/main/core/native-export-run.ts";
import { androidBinary } from "../fixtures/rust-bundles/binaries.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SPEC: AndroidManifestSpec = {
  applicationId: "games.genex.game.g0123456789ab",
  label: "Pond",
  versionCode: 1,
  versionName: "1.0",
  orientation: AndroidOrientation.Landscape,
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A packaging refusal's code, or a failure naming what was thrown instead. */
async function problemOf(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    if (error instanceof AndroidPackageError) return error.code;
    throw error;
  }
  assert.fail("expected an AndroidPackageError");
}

/**
 * Every `android:configChanges` flag of API 36 (`platforms/android-36/data/res/values/attrs_manifest.xml`)
 * except `resourcesUnused`, which that file itself steers away from.
 */
const API_36_CONFIG_CHANGES = [
  "mcc",
  "mnc",
  "locale",
  "touchscreen",
  "keyboard",
  "keyboardHidden",
  "navigation",
  "orientation",
  "screenLayout",
  "uiMode",
  "screenSize",
  "smallestScreenSize",
  "density",
  "layoutDirection",
  "colorMode",
  "grammaticalGender",
  "fontScale",
  "fontWeightAdjustment",
  "assetsPaths",
];

describe("the manifest comes from a fixed table", () => {
  it("never holds a permission and carries minSdk 29, targetSdk 36 and the required Vulkan 1.1 uses-feature", () => {
    const xml = androidManifestXml(SPEC);
    const facts = androidManifestFacts(xml);
    assert.deepEqual(facts.permissions, []);
    assert.equal(facts.minSdk, ANDROID_PINS.minSdk);
    assert.equal(facts.targetSdk, ANDROID_PINS.targetSdk);
    assert.equal(facts.vulkanVersion, ANDROID_PINS.vulkanVersionFeature);
    assert.equal(facts.vulkanRequired, true);
    assert.equal(facts.packageName, SPEC.applicationId);
    assert.equal(facts.activity, "android.app.NativeActivity");
    assert.equal(facts.hasCode, false);
    assert.equal(facts.extractNativeLibs, false);
    assert.equal(facts.libName, "main");
    assert.doesNotThrow(() => checkAndroidManifest(xml));
  });

  // Pass-1 fix (Android emulator smoke): the system relaunches an activity for every configuration
  // change it does not declare. NativeActivity under winit 0.30 cannot survive one (winit ignores
  // onDestroy, so android_main never returns and onDestroy blocks the UI thread; a second event
  // loop cannot be built), so the manifest declares every change targetSdk 36 knows. The one CI
  // met was assetsPaths: the theme overlays SystemUI applies after first boot (0x80000000).
  it("declares every configuration change targetSdk 36 can relaunch the activity for, theme overlays included", () => {
    const facts = androidManifestFacts(androidManifestXml(SPEC));
    assert.deepEqual([...facts.configChanges].sort(), [...API_36_CONFIG_CHANGES].sort());
    assert.doesNotThrow(() => checkAndroidManifest(androidManifestXml(SPEC)));
  });

  it("escapes a hostile title so it stays the label's text", () => {
    const label = `A "<b>" & 'friends' </application><uses-permission android:name="android.permission.INTERNET"/>`;
    const xml = androidManifestXml({ ...SPEC, label });
    const facts = androidManifestFacts(xml);
    assert.equal(facts.label, label);
    assert.deepEqual(facts.permissions, []);
    assert.doesNotThrow(() => checkAndroidManifest(xml));
  });

  it("maps each orientation through the table and refuses one outside it", async () => {
    const seen = Object.values(AndroidOrientation).map(
      (orientation) => androidManifestFacts(androidManifestXml({ ...SPEC, orientation })).screenOrientation,
    );
    assert.deepEqual(seen, ["sensorLandscape", "sensorPortrait", "fullSensor"]);
    const odd = { ...SPEC, orientation: "reverseLandscape" } as unknown as AndroidManifestSpec;
    assert.equal(await problemOf(() => androidManifestXml(odd)), AndroidPackageProblem.ManifestField);
  });

  const hostile: Array<[string, Partial<AndroidManifestSpec>]> = [
    ["an application id segment starting with a digit", { applicationId: "games.genex.game.0123" }],
    ["a one-segment application id", { applicationId: "pond" }],
    ["an application id with a dash", { applicationId: "games.genex.my-game" }],
    ["an application id with an empty segment", { applicationId: "games..pond" }],
    ["an application id over 150 characters", { applicationId: `games.${"a".repeat(150)}` }],
    ["an empty label", { label: "" }],
    ["a label with a control character", { label: "Pond\u0007" }],
    ["a label with a newline", { label: "Pond\nPermissions" }],
    ["a label over 100 characters", { label: "P".repeat(101) }],
    ["a version code of 0", { versionCode: 0 }],
    ["a fractional version code", { versionCode: 1.5 }],
    ["a version code above Play's ceiling", { versionCode: 2_100_000_001 }],
    ["a version name with a quote", { versionName: '1.0" android:debuggable="true' }],
    ["an empty version name", { versionName: "" }],
  ];
  for (const [name, change] of hostile) {
    it(`refuses ${name}`, async () => {
      const spec = { ...SPEC, ...change } as AndroidManifestSpec;
      assert.equal(await problemOf(() => androidManifestXml(spec)), AndroidPackageProblem.ManifestField);
    });
  }

  it("refuses GameActivity until its AAR closure is ratified (NativeActivity is the packaged activity)", async () => {
    const spec = { ...SPEC, activity: AndroidActivity.GameActivity };
    assert.equal(await problemOf(() => androidManifestXml(spec)), AndroidPackageProblem.ActivityUnavailable);
  });

  const broken: Array<[string, (xml: string) => string]> = [
    [
      "a permission",
      (xml) =>
        xml.replace("<application", '<uses-permission android:name="android.permission.INTERNET" />\n<application'),
    ],
    [
      "a permission spelled uses-permission-sdk-23",
      (xml) => xml.replace("<application", '<uses-permission-sdk-23 android:name="x" />\n<application'),
    ],
    ["minSdk 28", (xml) => xml.replace('android:minSdkVersion="29"', 'android:minSdkVersion="28"')],
    ["targetSdk 35", (xml) => xml.replace('android:targetSdkVersion="36"', 'android:targetSdkVersion="35"')],
    ["Vulkan 1.0", (xml) => xml.replace('android:version="0x401000"', 'android:version="0x400000"')],
    ["an optional Vulkan feature", (xml) => xml.replace('android:required="true"', 'android:required="false"')],
    ["no Vulkan feature", (xml) => xml.replace(/<uses-feature[^>]*>/, "")],
    ["a debuggable application", (xml) => xml.replace("<application", '<application android:debuggable="true"')],
    ["code in the APK", (xml) => xml.replace('android:hasCode="false"', 'android:hasCode="true"')],
    ["an activity a theme overlay relaunches (no assetsPaths)", (xml) => xml.replace("|assetsPaths", "")],
    ["an activity a locale change relaunches", (xml) => xml.replace("|locale", "")],
    ["no configChanges", (xml) => xml.replace(/\s+android:configChanges="[^"]*"/, "")],
  ];
  for (const [name, edit] of broken) {
    it(`the manifest check refuses ${name}`, async () => {
      const xml = edit(androidManifestXml(SPEC));
      assert.notEqual(xml, androidManifestXml(SPEC));
      assert.equal(await problemOf(() => checkAndroidManifest(xml)), AndroidPackageProblem.ManifestField);
    });
  }

  it("derives an application id from the game's bundle id, never from the game's own files", async () => {
    const id = androidApplicationId(bundleIdOf("/Users/me/AI Games/pond"));
    assert.match(id, /^games\.genex\.game\.g[0-9a-f]{12}$/);
    assert.doesNotThrow(() => androidManifestXml({ ...SPEC, applicationId: id }));
    assert.equal(await problemOf(() => androidApplicationId("com.evil.app")), AndroidPackageProblem.ManifestField);
  });
});

/** A lane `out/` as the Rust lane admits it for Android: `game` (the shared object) and assets. */
async function laneOut(extra: Record<string, Uint8Array> = {}) {
  const out = path.join(await tmpDir("android-out-"), "game.out");
  const files: Record<string, Uint8Array> = {
    game: androidBinary(),
    "assets/level.json": Buffer.from('{"fish":3}'),
    "assets/sfx/splash.ogg": Buffer.from("OggS fake"),
    ...extra,
  };
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(out, rel)), { recursive: true });
    await writeFile(path.join(out, rel), bytes);
  }
  const outputs = Object.entries(files).map(([rel, bytes]) => ({ path: rel, sha256: sha256(bytes) }));
  return { out, outputs, files };
}

describe("the payload is the lane's admitted copy and nothing else", () => {
  it("packs the admitted game as libmain.so and the assets at their digests", async () => {
    const { out, outputs, files } = await laneOut();
    const payload = await readAndroidPayload(out, outputs);
    assert.equal(sha256(payload.library), sha256(files.game ?? Buffer.alloc(0)));
    assert.deepEqual(
      payload.assets.map((asset) => asset.path),
      ["level.json", "sfx/splash.ogg"],
    );
  });

  it("refuses an extra .so in out/ that the lane never admitted", async () => {
    const { out, outputs } = await laneOut();
    await writeFile(path.join(out, "libc++_shared.so"), androidBinary());
    assert.equal(await problemOf(readAndroidPayload(out, outputs)), AndroidPackageProblem.ExtraLibrary);
  });

  it("refuses an extra .so even when the receipt lists it", async () => {
    const { out, outputs } = await laneOut({ "libextra.so": androidBinary() });
    assert.equal(await problemOf(readAndroidPayload(out, outputs)), AndroidPackageProblem.ExtraLibrary);
  });

  it("refuses a native library hidden among the assets (by name or by ELF magic)", async () => {
    const named = await laneOut({ "assets/plugin.so": Buffer.from("not even elf") });
    assert.equal(await problemOf(readAndroidPayload(named.out, named.outputs)), AndroidPackageProblem.ExtraLibrary);
    const magic = await laneOut({ "assets/data.bin": androidBinary() });
    assert.equal(await problemOf(readAndroidPayload(magic.out, magic.outputs)), AndroidPackageProblem.ExtraLibrary);
  });

  it("refuses a game whose bytes are not the admitted digest, and an unlisted asset", async () => {
    const changed = await laneOut();
    await writeFile(path.join(changed.out, "game"), androidBinary({ needed: ["libandroid.so", "liblog.so"] }));
    assert.equal(
      await problemOf(readAndroidPayload(changed.out, changed.outputs)),
      AndroidPackageProblem.DigestMismatch,
    );
    const unlisted = await laneOut();
    await writeFile(path.join(unlisted.out, "assets", "late.txt"), "written after admission");
    assert.equal(
      await problemOf(readAndroidPayload(unlisted.out, unlisted.outputs)),
      AndroidPackageProblem.NotAdmitted,
    );
  });

  it("refuses a game the Android gate refuses, a link, and an asset in the notices' reserved folder", async () => {
    const elf = await laneOut({ game: androidBinary({ align: 4096 }) });
    assert.equal(await problemOf(readAndroidPayload(elf.out, elf.outputs)), AndroidPackageProblem.NotAdmitted);
    const linked = await laneOut();
    await symlink("/etc/hosts", path.join(linked.out, "assets", "hosts"));
    assert.equal(await problemOf(readAndroidPayload(linked.out, linked.outputs)), AndroidPackageProblem.NotAdmitted);
    const reserved = await laneOut({ "assets/genex-notices/NOTICES.txt": Buffer.from("fake") });
    assert.equal(
      await problemOf(readAndroidPayload(reserved.out, reserved.outputs)),
      AndroidPackageProblem.ReservedAsset,
    );
  });
});

describe("the package zip", () => {
  it("round-trips members with their methods, deterministically", async () => {
    const members = [
      { name: "AndroidManifest.xml", data: Buffer.from("manifest"), method: ZipMethod.Deflated },
      { name: ANDROID_LIBRARY_ENTRY, data: androidBinary(), method: ZipMethod.Stored },
    ];
    const one = await writeZipMembers(members);
    const two = await writeZipMembers(members);
    assert.equal(sha256(one), sha256(two));
    const entries = readZipEntries(one);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.method]),
      [
        ["AndroidManifest.xml", ZipMethod.Deflated],
        [ANDROID_LIBRARY_ENTRY, ZipMethod.Stored],
      ],
    );
  });

  const hostileNames = ["../escape", "/abs", "a/../../b", "back\\slash", "nul\0name", "lib/arm64-v8a/"];
  for (const name of hostileNames) {
    it(`the reader refuses an entry named ${JSON.stringify(name)}`, async () => {
      const zip = await writeZipMembers([
        { name: "placeholder-name-0000", data: Buffer.from("x"), method: ZipMethod.Stored },
      ]);
      const forged = renameEntry(zip, "placeholder-name-0000", name);
      assert.equal(await problemOf(() => readZipEntries(forged)), AndroidPackageProblem.ZipInvalid);
    });
  }

  it("the reader refuses a duplicate name and an encrypted entry", async () => {
    const twice = await writeZipMembers([
      { name: "a", data: Buffer.from("1"), method: ZipMethod.Stored },
      { name: "b", data: Buffer.from("2"), method: ZipMethod.Stored },
    ]);
    assert.equal(await problemOf(() => readZipEntries(renameEntry(twice, "b", "a"))), AndroidPackageProblem.ZipInvalid);
    const encrypted = Buffer.from(
      await writeZipMembers([{ name: "a", data: Buffer.from("1"), method: ZipMethod.Stored }]),
    );
    const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    encrypted.writeUInt16LE(1, central + 8);
    assert.equal(await problemOf(() => readZipEntries(encrypted)), AndroidPackageProblem.ZipInvalid);
  });

  it("a packaged entry whose bytes differ from the admitted digest is refused", async () => {
    const { out, outputs } = await laneOut();
    const payload = await readAndroidPayload(out, outputs);
    const good = await writeZipMembers([
      { name: ANDROID_LIBRARY_ENTRY, data: payload.library, method: ZipMethod.Stored },
      ...payload.assets.map((asset) => ({
        name: `assets/${asset.path}`,
        data: asset.bytes,
        method: ZipMethod.Deflated,
      })),
    ]);
    assert.doesNotThrow(() => verifyPackagedEntries(good, payload, PACKAGE_LAYOUT.Apk));
    const tampered = await writeZipMembers([
      { name: ANDROID_LIBRARY_ENTRY, data: androidBinary({ needed: ["libc.so"] }), method: ZipMethod.Stored },
      ...payload.assets.map((asset) => ({
        name: `assets/${asset.path}`,
        data: asset.bytes,
        method: ZipMethod.Deflated,
      })),
    ]);
    assert.equal(
      await problemOf(() => verifyPackagedEntries(tampered, payload, PACKAGE_LAYOUT.Apk)),
      AndroidPackageProblem.PackagedEntryChanged,
    );
    const extra = await writeZipMembers([
      { name: ANDROID_LIBRARY_ENTRY, data: payload.library, method: ZipMethod.Stored },
      { name: "lib/arm64-v8a/libevil.so", data: payload.library, method: ZipMethod.Stored },
      ...payload.assets.map((asset) => ({
        name: `assets/${asset.path}`,
        data: asset.bytes,
        method: ZipMethod.Deflated,
      })),
    ]);
    assert.equal(
      await problemOf(() => verifyPackagedEntries(extra, payload, PACKAGE_LAYOUT.Apk)),
      AndroidPackageProblem.ExtraLibrary,
    );
    const compressed = await writeZipMembers([
      { name: ANDROID_LIBRARY_ENTRY, data: payload.library, method: ZipMethod.Deflated },
      ...payload.assets.map((asset) => ({
        name: `assets/${asset.path}`,
        data: asset.bytes,
        method: ZipMethod.Deflated,
      })),
    ]);
    assert.equal(
      await problemOf(() => verifyPackagedEntries(compressed, payload, PACKAGE_LAYOUT.Apk)),
      AndroidPackageProblem.PackagedEntryChanged,
    );
  });
});

/** Overwrites a member's name (same length) in the local and central headers. */
function renameEntry(zip: Uint8Array, from: string, to: string): Buffer {
  const bytes = Buffer.from(zip);
  const fromBytes = Buffer.from(from);
  const toBytes = Buffer.alloc(fromBytes.length, 0x5f);
  Buffer.from(to).copy(toBytes);
  const nameLength = Buffer.byteLength(to);
  for (let at = bytes.indexOf(fromBytes); at >= 0; at = bytes.indexOf(fromBytes, at + 1)) {
    toBytes.copy(bytes, at);
    // The name length sits 4 bytes before a local header's name (offset 26 of 30) or 18 before a central's (28 of 46).
    const local = bytes.readUInt32LE(at - 30) === 0x04034b50;
    bytes.writeUInt16LE(nameLength, local ? at - 4 : at - 18);
  }
  return bytes;
}

/** A sandbox factory that records every sandbox and run, and fails the test if a tool would run. */
function recordingContext(root: string, overrides: Partial<AndroidPackageContext> = {}) {
  const sandboxes: SandboxOptions[] = [];
  const runs: RunRequest[] = [];
  const context: AndroidPackageContext = {
    tools: {
      aapt2: "/sdk/build-tools/36.0.0/aapt2",
      zipalign: "/sdk/build-tools/36.0.0/zipalign",
      apksigner: "/sdk/build-tools/36.0.0/apksigner",
      androidJar: "/sdk/platforms/android-36/android.jar",
      javaHome: "/store/jdk",
      bundletoolJar: "/store/bundletool/bundletool.jar",
    },
    async sandboxFor(options) {
      sandboxes.push(options);
      return {
        async run(request): Promise<RunResult> {
          runs.push(request);
          return { code: 1, signal: null, stdout: "", stderr: "no tool in this row", timedOut: false } as RunResult;
        },
        async dispose() {},
      };
    },
    stagingRoot: path.join(root, "staging"),
    secretPaths: [path.join(root, "secrets")],
    denyWrite: [path.join(root, "games")],
    secretValues: [],
    signer: {
      host: StudioPlatform.Mac,
      home: path.join(root, "home"),
      env: {},
      forbiddenRoots: [path.join(root, "games")],
      keyHome: path.join(root, "keys", "android-debug"),
    },
    ...overrides,
  };
  return { context, sandboxes, runs };
}

/** A rig root with keystores inside a game, inside `~/.android`, in a fine place, and a link into the game. */
async function keystorePlaces() {
  const root = await tmpDir("android-pkg-");
  for (const dir of ["staging", "games/pond", "home/.android", "person"])
    await mkdir(path.join(root, ...dir.split("/")), { recursive: true });
  const inGame = path.join(root, "games", "pond", "release.p12");
  const inAndroid = path.join(root, "home", ".android", "release.p12");
  const fine = path.join(root, "person", "release.p12");
  const linked = path.join(root, "person", "linked.p12");
  for (const file of [inGame, inAndroid, fine]) await writeFile(file, "keystore");
  await symlink(inGame, linked);
  return { root, inGame, inAndroid, fine, linked };
}

describe("refusals come before any tool runs", () => {
  const release: ExportSigningChoice = {
    kind: ExportSigning.AndroidRelease,
    keystore: "/Users/me/keys/release.p12",
    alias: "upload",
    password: { env: "MY_PASS" },
  };

  it("the harness may not sign an APK with a release keystore, nor make an AAB", async () => {
    const root = await tmpDir("android-pkg-");
    await mkdir(path.join(root, "staging"), { recursive: true });
    const { out, outputs } = await laneOut();
    const payload = await readAndroidPayload(out, outputs);
    const { context, sandboxes } = recordingContext(root);
    const base = { manifest: SPEC, payload, notices: [], requestedBy: SigningRequester.Harness };
    const apk = packageAndroidApk(context, { ...base, signing: release, target: path.join(root, "pond.apk") });
    assert.equal(await problemOf(apk), AndroidPackageProblem.HarnessMayNotSign);
    const aab = packageAndroidAab(context, { ...base, signing: release, target: path.join(root, "pond.aab") });
    assert.equal(await problemOf(aab), AndroidPackageProblem.HarnessMayNotSign);
    const debugAab = packageAndroidAab(context, {
      ...base,
      requestedBy: SigningRequester.Person,
      signing: { kind: ExportSigning.AndroidDebug },
      target: path.join(root, "pond.aab"),
    });
    assert.equal(await problemOf(debugAab), AndroidPackageProblem.SigningKind);
    assert.equal(sandboxes.length, 0);
  });

  it("an AAB's keystore or password file in a forbidden place is refused before any tool runs", async () => {
    const { root, inGame, inAndroid, fine, linked } = await keystorePlaces();
    const { out, outputs } = await laneOut();
    const payload = await readAndroidPayload(out, outputs);
    const { context, sandboxes } = recordingContext(root, {
      signer: { ...recordingContext(root).context.signer, env: { PASS: "a-good-password" } },
    });
    const rows: Array<[string, ExportSigningChoice]> = [
      ["inside a game", { ...release, keystore: inGame, password: { env: "PASS" } }],
      ["inside ~/.android", { ...release, keystore: inAndroid, password: { env: "PASS" } }],
      ["a link into a game", { ...release, keystore: linked, password: { env: "PASS" } }],
      ["a relative keystore", { ...release, keystore: "release.p12", password: { env: "PASS" } }],
      ["a password file inside a game", { ...release, keystore: fine, password: { file: inGame } }],
      ["an unset password variable", { ...release, keystore: fine, password: { env: "UNSET" } }],
    ];
    for (const [name, signing] of rows) {
      const work = packageAndroidAab(context, {
        manifest: SPEC,
        payload,
        notices: [],
        signing,
        requestedBy: SigningRequester.Person,
        target: path.join(root, "pond.aab"),
      });
      assert.equal(await problemOf(work), AndroidPackageProblem.SigningFailed, name);
    }
    assert.equal(sandboxes.length, 0);
  });

  it("a held secret in an asset is refused before aapt2 runs (the scan precedes compression)", async () => {
    const root = await tmpDir("android-pkg-");
    await mkdir(path.join(root, "staging"), { recursive: true });
    const secret = "sk-test-0123456789abcdef";
    const { out, outputs } = await laneOut({ "assets/config.txt": Buffer.from(`key=${secret}\n`) });
    const payload = await readAndroidPayload(out, outputs);
    const { context, runs } = recordingContext(root, { secretValues: [secret] });
    const work = packageAndroidApk(context, {
      manifest: SPEC,
      payload,
      notices: [],
      signing: { kind: ExportSigning.AndroidDebug },
      requestedBy: SigningRequester.Harness,
      target: path.join(root, "pond.apk"),
    });
    assert.equal(await problemOf(work), AndroidPackageProblem.SecretFound);
    assert.equal(runs.length, 0);
  });

  it("each tool runs in a sandbox of its own: no domain, the staging folder its one writable root", async () => {
    const root = await tmpDir("android-pkg-");
    await mkdir(path.join(root, "staging"), { recursive: true });
    const { out, outputs } = await laneOut();
    const payload = await readAndroidPayload(out, outputs);
    const { context, sandboxes, runs } = recordingContext(root);
    const work = packageAndroidApk(context, {
      manifest: SPEC,
      payload,
      notices: [],
      signing: { kind: ExportSigning.AndroidDebug },
      requestedBy: SigningRequester.Harness,
      target: path.join(root, "pond.apk"),
    });
    assert.equal(await problemOf(work), AndroidPackageProblem.ToolFailed);
    assert.equal(runs.length, 1);
    assert.match(runs[0]?.command ?? "", /aapt2' 'link'/);
    assert.deepEqual(runs[0]?.policy?.allowedDomains, []);
    assert.equal(sandboxes.length, 1);
    assert.equal(sandboxes[0]?.writableRoots.length, 1);
    assert.ok(sandboxes[0]?.secretPaths.includes(path.join(root, "secrets")));
  });
});

describe("Android notices go through the M3.5 generator", () => {
  it("the Android row is the core runtime plus the NDK's LLVM libunwind, whose text is LLVM's", () => {
    const llvm = [
      { kind: NoticeSourceKind.Text, name: "LICENSE.txt", text: "Apache-2.0 WITH LLVM-exception" } as const,
    ];
    const rust = [{ kind: NoticeSourceKind.Text, name: "LICENSE-MIT", text: "MIT" } as const];
    const runtime = androidRuntimeSources({
      [RustRuntimePart.Std]: rust,
      [RustRuntimePart.CompilerBuiltins]: rust,
      [RustRuntimePart.CompilerRt]: llvm,
    });
    assert.deepEqual(runtime[RustRuntimePart.Libunwind], llvm);
    const lock = 'version = 4\n\n[[package]]\nname = "pond"\nversion = "0.1.0"\n';
    const notices = rustNotices({ target: BuildTarget.Android, lock, roots: ["pond"], licences: new Map(), runtime });
    assert.equal(notices.ok, true);
    const folders = notices.ok ? notices.notices.map((notice) => notice.folder) : [];
    assert.ok(folders.includes(`rust-runtime/${RustRuntimePart.Libunwind}`));
    assert.ok(!folders.includes(`rust-runtime/${RustRuntimePart.GameActivity}`));
  });
});

describe("the Android export run", () => {
  const game: GameProject = { name: "pond", dir: "/games/pond", title: "Pond" } as unknown as GameProject;
  const request = (overrides: Partial<MobileExportGameRequest> = {}): MobileExportGameRequest => ({
    destination: BuildTarget.Android,
    game,
    targetDir: "/exports/pond.android",
    signing: { kind: ExportSigning.AndroidDebug },
    artifact: MobileArtifact.ApkDev,
    person: false,
    ...overrides,
  });

  async function refusalOf(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (error) {
      if (error instanceof ExportError) return error.code;
      throw error;
    }
    assert.fail("expected an ExportError");
  }

  it("without the core's packaging services it refuses lane-missing, building nothing", async () => {
    assert.equal(await refusalOf(exportAndroidGame(request())), ExportRefusal.LaneMissing);
  });

  it("the harness asking for an AAB is refused before anything is built", async () => {
    let built = 0;
    const deps = {
      gameBuilds: {
        async ensure() {
          built += 1;
          throw new Error("must not build");
        },
      },
    } as unknown as Parameters<typeof exportAndroidGame>[1];
    const aab = request({
      artifact: MobileArtifact.Aab,
      signing: { kind: ExportSigning.AndroidRelease, keystore: "/k.p12", alias: "a", password: { env: "P" } },
    });
    assert.equal(await refusalOf(exportAndroidGame(aab, deps)), ExportRefusal.HarnessMayNotSign);
    assert.equal(built, 0);
  });

  it("versionCode counts whole minutes since 2024, so a later export's is larger, within Play's range", () => {
    const at = Date.UTC(2026, 9, 7, 3, 0);
    assert.ok(androidVersionCode(at + MINUTE_MS) > androidVersionCode(at));
    assert.equal(androidVersionCode(Date.UTC(2024, 0, 1, 0, 10)), 10);
    assert.equal(androidVersionCode(Date.UTC(2024, 0, 1)), 1, "never below 1");
    assert.equal(androidVersionCode(Date.UTC(2020, 0, 1)), 1);
    assert.equal(androidVersionCode(Number.MAX_SAFE_INTEGER), 2_100_000_000, "never above Play's ceiling");
  });

  it("the export folder resolves as every export's: a folder Genex did not export, a link or a path out of exports is refused, nothing written", async () => {
    const root = await realpath(await tmpDir("android-export-target-"));
    const exportsRoot = path.join(root, "exports");
    const gameDir = path.join(root, "games", "pond");
    const elsewhere = path.join(root, "elsewhere");
    const mine = path.join(exportsRoot, "notes");
    for (const dir of [gameDir, elsewhere, mine]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(mine, "todo.txt"), "the person's own file");
    await symlink(elsewhere, path.join(exportsRoot, "pond.android"));
    await symlink(elsewhere, path.join(exportsRoot, "inner"));
    const { out, outputs } = await laneOut();
    const { context, runs } = recordingContext(root);
    const { tools, secretValues: _held, ...packaging } = context;
    const built = {
      ok: true,
      output: out,
      lastGood: out,
      problem: null,
      ran: true,
      rust: { refusal: null, diagnostics: [], receipt: { outputs } },
    };
    const deps = {
      gameBuilds: {
        ensure: async (_game: unknown, target: BuildTarget, purpose: string) => ({
          stack: GameStack.RustWgpu,
          target,
          purpose,
          refusal: null,
          outcome: built,
        }),
      },
      toolchains: { currentLock: async () => null },
      games: { bundleIdFor: async () => bundleIdOf(gameDir) },
      tools: async () => tools,
      notices: async () => [],
      packaging,
      secretValues: () => [],
      exportsRoot,
      admitDevApk: async () => assert.fail("nothing is admitted for a refused export"),
    } as unknown as AndroidExportDeps;
    const real = {
      ...game,
      dir: gameDir,
      destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Android] },
    } as unknown as GameProject;
    const rows: Array<[string, string, ExportRefusal]> = [
      ["a folder Genex did not export", mine, ExportRefusal.NotAnExportFolder],
      ["a link under exports", path.join(exportsRoot, "pond.android"), ExportRefusal.TargetRefused],
      [
        "a folder through a link under exports",
        path.join(exportsRoot, "inner", "pond.android"),
        ExportRefusal.TargetRefused,
      ],
      ["a path out of exports", path.join(exportsRoot, "..", "outside"), ExportRefusal.TargetRefused],
      ["the game's own folder", gameDir, ExportRefusal.TargetRefused],
    ];
    for (const [label, targetDir, code] of rows)
      assert.equal(await refusalOf(exportAndroidGame(request({ game: real, targetDir }), deps)), code, label);
    assert.equal(await readFile(path.join(mine, "todo.txt"), "utf8"), "the person's own file");
    assert.deepEqual(await readdir(mine), ["todo.txt"]);
    assert.deepEqual(await readdir(elsewhere), [], "nothing written through a link");
    assert.equal(await lstat(path.join(root, "outside")).catch(() => null), null);
    assert.deepEqual(await readdir(gameDir), []);
    assert.equal(runs.length, 0, "no packaging tool ran");
    assert.deepEqual(await readdir(context.stagingRoot).catch(() => []), [], "no staging left behind");
  });
});
