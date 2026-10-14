/**
 * A Rust · wgpu game's Android packages (M5.2): a development APK signed with Studio's
 * per-profile debug key, and an Android App Bundle signed with the person's own release keystore.
 *
 * - **The manifest** is written by the host from a fixed table ({@link androidManifestXml}): the
 *   game's application id, title, version and an orientation from {@link AndroidOrientation};
 *   `minSdkVersion` 29, `targetSdkVersion` 36 and the required `android.hardware.vulkan.version`
 *   0x401000 `uses-feature` (WebGPU core needs Vulkan 1.1; there is no GLES tier); no permission
 *   of any kind; NativeActivity with no code ({@link PACKAGED_ACTIVITY}); native libraries loaded
 *   in place (`extractNativeLibs` false); every configuration change handled in place
 *   ({@link ANDROID_CONFIG_CHANGES}). {@link checkAndroidManifest} holds the text to that.
 * - **The payload** is the lane's admitted `out/` and nothing else ({@link readAndroidPayload}):
 *   `game` (the shared object the Android gate admitted) becomes `lib/arm64-v8a/libmain.so`, each
 *   asset goes in at the digest the lane admitted it with, and any other native library, in `out/`
 *   or among the assets, is refused. The licence notices go in under `assets/genex-notices/`.
 * - **The tools** (`aapt2`, `zipalign -P 16`, `apksigner`, `bundletool`, `jarsigner`) each run in a
 *   sandbox of their own over a host-staged copy ({@link AndroidPackageContext.sandboxFor}): the
 *   staging folder their one writable root, no network domain. A held secret in any staged file is
 *   refused before anything is compressed (`fileWithSecret`), and every packaged entry is read back
 *   and held to the admitted digests ({@link verifyPackagedEntries}) before and after signing.
 * - **Signing** is `mobile-sign.ts`'s for the APK; the bundle's `jarsigner` run is here. A release
 *   keystore and an AAB are the person's only: the harness is refused before anything runs.
 *
 * GameActivity (AAR 4.4.0 with its AppCompat closure, `d8` and the JDK) is the other activity M0a
 * measured; it stays refused (`activity-unavailable`) until the owner ratifies the AAR's source and
 * its notice row. Nothing here installs or launches anything: containment stage 1.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRaw, inflateRawSync } from "node:zlib";
import { StudioPlatform } from "../shared/boot.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import {
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
  type SigningPasswordReference,
} from "../shared/game-export-contract.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { RUST_ADMITTED_EXECUTABLES } from "../shared/native-contract.ts";
import { ANDROID_PINS } from "../shared/toolchain.ts";
import { redactValues } from "../shared/redact.ts";
import { readBundleFile } from "./bundle-walk.ts";
import { fileWithSecret } from "./game-export.ts";
import {
  ANDROID_KEY_PASS_ENV,
  androidDebugKeyPaths,
  ensureAndroidDebugKey,
  MobileSignError,
  MobileSignProblem,
  mobileSignSandboxOptions,
  signApk,
} from "./mobile-sign.ts";
import { admitRustBinary } from "./native-cross-admission.ts";
import type { NoticeFile } from "./native-export.ts";
import { isInside } from "./paths.ts";
import type { RustRuntimePart as RuntimePart } from "./rust-notices.ts";
import { RustRuntimePart } from "./rust-notices.ts";
import { shellQuote } from "./shell-quote.ts";
import type { RunRequest, RunResult, SandboxOptions } from "./spawn.ts";
import { SigningRequester } from "./windows-sign.ts";
import type { NoticeSource } from "./native-export.ts";

/** The one ABI Genex builds for Android. */
export const ANDROID_ABI = "arm64-v8a";
/** Where the game's shared object goes in an APK (`android.app.lib_name` "main"). */
export const ANDROID_LIBRARY_ENTRY = `lib/${ANDROID_ABI}/libmain.so`;
/** The folder under `assets/` the export's licence notices go in; a game asset may not use it. */
export const ANDROID_NOTICES_ASSET_FOLDER = "genex-notices";
/** The lane's admitted executable for Android: the shared object packed as `libmain.so`. */
const GAME_FILE = RUST_ADMITTED_EXECUTABLES[BuildTarget.Android].files[0];
const ASSETS_FOLDER = "assets";
/** `android.app.lib_name`: NativeActivity loads `lib<name>.so`. */
const LIB_NAME = "main";
/** zipalign's alignment for stored entries, and its page-aligned mode for `.so` files (16 KB). */
const ZIP_ALIGN_BYTES = 4;
const ZIP_PAGE_ALIGN_KB = 16;
/**
 * Every `android:configChanges` flag targetSdk 36 knows, with its `ActivityInfo` bit, so the system
 * hands each change to the running activity instead of relaunching it. NativeActivity under winit
 * 0.30 cannot survive a relaunch: winit ignores onDestroy, so `android_main` never returns and
 * onDestroy blocks the UI thread (a second event loop could not be built anyway). `assetsPaths` is
 * the change the theme overlays SystemUI applies after a first boot make; `resourcesUnused` is left
 * out, as the platform's own attribute docs advise.
 */
export const ANDROID_CONFIG_CHANGES: ReadonlyArray<readonly [name: string, bit: number]> = [
  ["mcc", 0x1],
  ["mnc", 0x2],
  ["locale", 0x4],
  ["touchscreen", 0x8],
  ["keyboard", 0x10],
  ["keyboardHidden", 0x20],
  ["navigation", 0x40],
  ["orientation", 0x80],
  ["screenLayout", 0x100],
  ["uiMode", 0x200],
  ["screenSize", 0x400],
  ["smallestScreenSize", 0x800],
  ["density", 0x1000],
  ["layoutDirection", 0x2000],
  ["colorMode", 0x4000],
  ["grammaticalGender", 0x8000],
  ["fontScale", 0x40000000],
  ["fontWeightAdjustment", 0x10000000],
  ["assetsPaths", 0x80000000],
];
const CONFIG_CHANGES = ANDROID_CONFIG_CHANGES.map(([name]) => name).join("|");
const TOOL_TIMEOUT_MS = 10 * MINUTE_MS;
const TOOL_OUTPUT_MAX_BYTES = 256 * 1024;
/** The largest game library, asset or package read. */
const FILE_MAX_BYTES = 512 * 1024 ** 2;
const PACKAGE_MAX_BYTES = 1024 ** 3;
/** The largest password file read: a password is one line. */
const PASSWORD_FILE_MAX_BYTES = 4096;
const APPLICATION_ID_MAX_CHARS = 150;
const LABEL_MAX_CHARS = 100;
/** Google Play's largest version code. */
const VERSION_CODE_MAX = 2_100_000_000;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const APPLICATION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const BUNDLE_ID = /^games\.genex\.game\.([0-9a-f]{12})$/;
const CONTROL = /\p{Cc}/u;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const SHARED_OBJECT = /\.so(\.\d+)*$/;
const TOOL_LABEL = {
  Aapt2: "aapt2",
  Zipalign: "zipalign",
  Apksigner: "apksigner",
  Bundletool: "bundletool",
  Jarsigner: "jarsigner",
} as const;

/** The two activities M0a measured for a Rust game. Wire values: never rename one. */
export const AndroidActivity = { NativeActivity: "native-activity", GameActivity: "game-activity" } as const;
export type AndroidActivity = (typeof AndroidActivity)[keyof typeof AndroidActivity];

/** What each activity puts in the manifest. */
export const ANDROID_ACTIVITIES = {
  [AndroidActivity.NativeActivity]: {
    className: "android.app.NativeActivity",
    hasCode: false,
    theme: "@android:style/Theme.NoTitleBar.Fullscreen",
  },
  [AndroidActivity.GameActivity]: {
    className: "com.google.androidgamesdk.GameActivity",
    hasCode: true,
    theme: "@style/Theme.AppCompat.NoActionBar",
  },
} as const satisfies Record<AndroidActivity, { className: string; hasCode: boolean; theme: string }>;

/** The activity Genex packages: NativeActivity (no Java code, no AAR closure; M0a.12 left the choice open). */
export const PACKAGED_ACTIVITY = AndroidActivity.NativeActivity;

/** The orientations a game may ask for. Wire values: never rename one. */
export const AndroidOrientation = { Landscape: "landscape", Portrait: "portrait", Any: "any" } as const;
export type AndroidOrientation = (typeof AndroidOrientation)[keyof typeof AndroidOrientation];

/** Each orientation as `android:screenOrientation`: the sensor picks between the two sides. */
const SCREEN_ORIENTATION = {
  [AndroidOrientation.Landscape]: "sensorLandscape",
  [AndroidOrientation.Portrait]: "sensorPortrait",
  [AndroidOrientation.Any]: "fullSensor",
} as const satisfies Record<AndroidOrientation, string>;

/** Why an Android package was refused or failed. Wire values: never rename one. */
export const AndroidPackageProblem = {
  /** A manifest field is outside the fixed table (id, label, version, orientation), or the text breaks a rule. */
  ManifestField: "manifest-field",
  /** The activity asked for is not packaged in this build. */
  ActivityUnavailable: "activity-unavailable",
  /** A file is not the lane's admitted copy: unlisted, a link, unreadable, or the gate refused it. */
  NotAdmitted: "not-admitted",
  /** The game's bytes are not the digest the lane admitted. */
  DigestMismatch: "digest-mismatch",
  /** A native library besides the game's own `libmain.so`. */
  ExtraLibrary: "extra-library",
  /** A game asset in the folder the notices go in. */
  ReservedAsset: "reserved-asset",
  /** A staged file holds a credential Studio holds. */
  SecretFound: "secret-found",
  /** A tool or the target path is not an absolute path, or the target is not a new file in a real folder. */
  Target: "target",
  /** A packaging tool failed or timed out. */
  ToolFailed: "tool-failed",
  /** The APK does not pass `zipalign -c -P 16`. */
  NotAligned: "not-aligned",
  /** `bundletool validate` refused the bundle. */
  BundleInvalid: "bundle-invalid",
  /** A packaged entry is not the admitted bytes, is compressed where it must be stored, or is missing. */
  PackagedEntryChanged: "packaged-entry-changed",
  /** A zip is malformed or holds an entry no package may (an unsafe or duplicate name, encryption, zip64). */
  ZipInvalid: "zip-invalid",
  /** Only the person signs with their own keystore or makes an AAB: the export's own refusal, not a second spelling of it. */
  HarnessMayNotSign: ExportRefusal.HarnessMayNotSign,
  /** The signing does not fit the artifact (an AAB is signed with a release keystore only). */
  SigningKind: "signing-kind",
  /** The signer failed, or changed more than the signature. */
  SigningFailed: "signing-failed",
} as const;
export type AndroidPackageProblem = (typeof AndroidPackageProblem)[keyof typeof AndroidPackageProblem];

const MESSAGE = {
  ApplicationId: "the application id is not a lowercase Java package name of two or more segments",
  NotABundleId: "the game's bundle id is not one Studio chose",
  Label: `the title must be 1 to ${LABEL_MAX_CHARS} characters with no control character`,
  VersionCode: `the version code must be a whole number from 1 to ${VERSION_CODE_MAX}`,
  VersionName: "the version name must be letters, digits, dots, plus signs, underscores and dashes",
  Orientation: (value: string) => `${JSON.stringify(value)} is not an orientation Genex packages`,
  Activity: (value: string) => `the ${value} activity is not packaged in this build of Genex`,
  ManifestRule: (rule: string) => `the manifest breaks a packaging rule: ${rule}`,
  NotAdmitted: (rel: string, why: string) => `${rel} is not the build's admitted copy: ${why}`,
  Digest: (rel: string) => `${rel} is not the bytes the build admitted; build again, then export`,
  ExtraLibrary: (rel: string) => `${rel} is a native library besides the game's own; nothing else is packaged`,
  Reserved: (rel: string) => `${rel} is in ${ASSETS_FOLDER}/${ANDROID_NOTICES_ASSET_FOLDER}/, where the notices go`,
  Secret: (rel: string) => `${rel} holds a credential Studio holds`,
  Target: (what: string) => `${what} is not an absolute path to a new file in an existing real folder`,
  Tool: (what: string) => `${what} must be named by its absolute path`,
  ToolFailed: (label: string) => `${label} failed`,
  NotAligned: "the APK does not pass zipalign -c -P 16",
  BundleInvalid: "bundletool refused the bundle",
  Entry: (name: string, why: string) => `the packaged ${name} ${why}`,
  Zip: (why: string) => `the package is not a zip Genex reads: ${why}`,
  Harness: "Only you can sign with your own keystore or make an Android App Bundle.",
  Kind: "An Android App Bundle is signed with your own release keystore; a development APK with Studio's key or yours.",
  SignChanged: "the signer changed more than the signature",
} as const;

/** A refused or failed Android package, typed; `output` is a tool's redacted output, if any. */
export class AndroidPackageError extends Error {
  readonly code: AndroidPackageProblem;
  readonly output: string;

  constructor(code: AndroidPackageProblem, message: string, output = "") {
    super(message);
    this.name = "AndroidPackageError";
    this.code = code;
    this.output = output;
  }
}

const fail = (code: AndroidPackageProblem, message: string) => new AndroidPackageError(code, message);

// ---------- the manifest ----------

/** What the host writes into a game's manifest. */
export interface AndroidManifestSpec {
  /** {@link androidApplicationId} of the game's once-chosen bundle id. */
  applicationId: string;
  /** The game's title, the launcher's label. */
  label: string;
  versionCode: number;
  versionName: string;
  orientation: AndroidOrientation;
  /** Absent: {@link PACKAGED_ACTIVITY}. */
  activity?: AndroidActivity;
}

/**
 * The Android application id of a game's bundle id (`games.genex.game.<12 hex>`): a Java package
 * segment cannot start with a digit, so the digest segment gains a `g`.
 */
export function androidApplicationId(bundleId: string): string {
  const match = BUNDLE_ID.exec(bundleId);
  if (!match) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.NotABundleId);
  return `games.genex.game.g${match[1]}`;
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);

/** The checked fields; a refusal names the field, never echoes a hostile value. */
function checkedSpec(spec: AndroidManifestSpec) {
  const { applicationId, label, versionCode, versionName, orientation } = spec;
  const idOk = APPLICATION_ID.test(applicationId) && applicationId.length <= APPLICATION_ID_MAX_CHARS;
  if (!idOk) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.ApplicationId);
  const labelOk = label.length > 0 && [...label].length <= LABEL_MAX_CHARS && !CONTROL.test(label);
  if (!labelOk) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.Label);
  const codeOk = Number.isInteger(versionCode) && versionCode >= 1 && versionCode <= VERSION_CODE_MAX;
  if (!codeOk) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.VersionCode);
  if (!VERSION_NAME.test(versionName)) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.VersionName);
  const screen: string | undefined = (SCREEN_ORIENTATION as Readonly<Record<string, string>>)[orientation];
  if (screen === undefined) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.Orientation(String(orientation)));
  const activity = spec.activity ?? PACKAGED_ACTIVITY;
  if (activity !== PACKAGED_ACTIVITY) throw fail(AndroidPackageProblem.ActivityUnavailable, MESSAGE.Activity(activity));
  return { applicationId, label, versionCode, versionName, screen, activity: ANDROID_ACTIVITIES[activity] };
}

/**
 * The game's `AndroidManifest.xml`, written from the fixed table: every value checked (a refusal
 * is `manifest-field` or `activity-unavailable`), the title XML-escaped, and nothing a game's own
 * files say. No `<uses-permission>` of any kind; the Vulkan 1.1 feature required.
 */
export function androidManifestXml(spec: AndroidManifestSpec): string {
  const field = checkedSpec(spec);
  const vulkan = `0x${ANDROID_PINS.vulkanVersionFeature.toString(16)}`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    `    package="${field.applicationId}"`,
    `    android:versionCode="${field.versionCode}"`,
    `    android:versionName="${field.versionName}">`,
    `  <uses-sdk android:minSdkVersion="${ANDROID_PINS.minSdk}" android:targetSdkVersion="${ANDROID_PINS.targetSdk}" />`,
    `  <uses-feature android:name="android.hardware.vulkan.version" android:version="${vulkan}" android:required="true" />`,
    "  <application",
    `      android:label="${escapeXml(field.label)}"`,
    `      android:hasCode="${field.activity.hasCode}"`,
    '      android:extractNativeLibs="false"',
    '      android:allowBackup="false"',
    `      android:theme="${field.activity.theme}">`,
    "    <activity",
    `        android:name="${field.activity.className}"`,
    '        android:exported="true"',
    `        android:screenOrientation="${field.screen}"`,
    `        android:configChanges="${CONFIG_CHANGES}"`,
    '        android:launchMode="singleTask">',
    `      <meta-data android:name="android.app.lib_name" android:value="${LIB_NAME}" />`,
    "      <intent-filter>",
    '        <action android:name="android.intent.action.MAIN" />',
    '        <category android:name="android.intent.category.LAUNCHER" />',
    "      </intent-filter>",
    "    </activity>",
    "  </application>",
    "</manifest>",
    "",
  ].join("\n");
}

/** What a manifest's text says, read back for {@link checkAndroidManifest} and the tests. */
export interface AndroidManifestFacts {
  packageName: string | null;
  label: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  /** Every `<uses-permission*>` element's name (or `?` when it names none). */
  permissions: string[];
  vulkanVersion: number | null;
  vulkanRequired: boolean;
  activity: string | null;
  hasCode: boolean | null;
  extractNativeLibs: boolean | null;
  debuggable: boolean | null;
  screenOrientation: string | null;
  /** The activity's `android:configChanges` flags (empty when it declares none). */
  configChanges: string[];
  libName: string | null;
}

const XML_UNESCAPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(XML_ESCAPES).map(([char, entity]) => [entity, char]),
);
const unescapeXml = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_UNESCAPES[e] ?? e);

/** The value of `name` on the element text `tag` (unescaped), or null. */
function attributeOf(tag: string | undefined, name: string): string | null {
  if (tag === undefined) return null;
  const match = new RegExp(`\\s${name.replace(":", "\\:")}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? null : unescapeXml(match[1]);
}

const numberOf = (text: string | null): number | null => (text === null ? null : Number(text.trim()));
const booleanOf = (text: string | null): boolean | null => (text === null ? null : text === "true");

/** Every start tag of `element` in `xml`. */
function tagsOf(xml: string, element: string): string[] {
  return xml.match(new RegExp(`<${element}\\b[^>]*>`, "g")) ?? [];
}

/** The facts of a manifest's text (comments removed first). */
export function androidManifestFacts(text: string): AndroidManifestFacts {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const [manifest] = tagsOf(xml, "manifest");
  const [sdk] = tagsOf(xml, "uses-sdk");
  const [application] = tagsOf(xml, "application");
  const [activity] = tagsOf(xml, "activity");
  const vulkan = tagsOf(xml, "uses-feature").find(
    (tag) => attributeOf(tag, "android:name") === "android.hardware.vulkan.version",
  );
  const libName = tagsOf(xml, "meta-data").find((tag) => attributeOf(tag, "android:name") === "android.app.lib_name");
  return {
    packageName: attributeOf(manifest, "package"),
    label: attributeOf(application, "android:label"),
    minSdk: numberOf(attributeOf(sdk, "android:minSdkVersion")),
    targetSdk: numberOf(attributeOf(sdk, "android:targetSdkVersion")),
    permissions: tagsOf(xml, "uses-permission[\\w-]*").map((tag) => attributeOf(tag, "android:name") ?? "?"),
    vulkanVersion: numberOf(attributeOf(vulkan, "android:version")),
    vulkanRequired: vulkan !== undefined && attributeOf(vulkan, "android:required") !== "false",
    activity: attributeOf(activity, "android:name"),
    hasCode: booleanOf(attributeOf(application, "android:hasCode")),
    extractNativeLibs: booleanOf(attributeOf(application, "android:extractNativeLibs")),
    debuggable: booleanOf(attributeOf(application, "android:debuggable")),
    screenOrientation: attributeOf(activity, "android:screenOrientation"),
    configChanges: (attributeOf(activity, "android:configChanges") ?? "").split("|").filter((flag) => flag !== ""),
    libName: attributeOf(libName, "android:value"),
  };
}

/** The rules a packaged manifest keeps, each named by the sentence a refusal gives. */
const MANIFEST_RULES: ReadonlyArray<readonly [string, (facts: AndroidManifestFacts) => boolean]> = [
  ["no permission of any kind", (facts) => facts.permissions.length === 0],
  [`minSdkVersion ${ANDROID_PINS.minSdk}`, (facts) => facts.minSdk === ANDROID_PINS.minSdk],
  [`targetSdkVersion ${ANDROID_PINS.targetSdk}`, (facts) => facts.targetSdk === ANDROID_PINS.targetSdk],
  [
    "the required Vulkan 1.1 uses-feature",
    (facts) => facts.vulkanRequired && (facts.vulkanVersion ?? 0) >= ANDROID_PINS.vulkanVersionFeature,
  ],
  ["no debuggable application", (facts) => facts.debuggable !== true],
  ["no code (NativeActivity)", (facts) => facts.hasCode === false],
  ["native libraries loaded in place", (facts) => facts.extractNativeLibs === false],
  [`android.app.lib_name ${LIB_NAME}`, (facts) => facts.libName === LIB_NAME],
  [
    "every configuration change handled in place (the activity cannot survive a relaunch)",
    (facts) => ANDROID_CONFIG_CHANGES.every(([name]) => facts.configChanges.includes(name)),
  ],
];

/** Refuses (`manifest-field`) a manifest text that breaks a packaging rule. */
export function checkAndroidManifest(xml: string): AndroidManifestFacts {
  const facts = androidManifestFacts(xml);
  const broken = MANIFEST_RULES.find(([, holds]) => !holds(facts));
  if (broken) throw fail(AndroidPackageProblem.ManifestField, MESSAGE.ManifestRule(broken[0]));
  return facts;
}

// ---------- zip ----------

/** The compression methods a package entry may use. */
export const ZipMethod = { Stored: 0, Deflated: 8 } as const;
export type ZipMethod = (typeof ZipMethod)[keyof typeof ZipMethod];

const ZIP = {
  Local: 0x04034b50,
  Central: 0x02014b50,
  End: 0x06054b50,
  LocalBytes: 30,
  CentralBytes: 46,
  EndBytes: 22,
  MaxComment: 0xffff,
  Encrypted: 0x1,
  Utf8: 0x0800,
  Zip64: 0xffffffff,
  Version: 20,
  /** MS-DOS 1980-01-01 00:00. */
  DosDate: (1 << 5) | 1,
} as const;

/** One entry of a package zip: its name, method, CRC, uncompressed size and the bytes as stored. */
export interface ZipEntry {
  name: string;
  method: ZipMethod;
  crc: number;
  size: number;
  stored: Buffer;
}

const zipFail = (why: string) => fail(AndroidPackageProblem.ZipInvalid, MESSAGE.Zip(why));

/** A name a package entry may have: relative, `/`-separated, no `..`, no control character, not a folder. */
function safeEntryName(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.endsWith("/") || name.includes("\\")) return false;
  return !CONTROL.test(name) && !name.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** The end-of-central-directory record's offset, searched back over a comment. */
function endOf(bytes: Buffer): number {
  const lowest = Math.max(0, bytes.length - ZIP.EndBytes - ZIP.MaxComment);
  for (let at = bytes.length - ZIP.EndBytes; at >= lowest; at -= 1) {
    if (bytes.readUInt32LE(at) === ZIP.End && at + ZIP.EndBytes + bytes.readUInt16LE(at + 20) === bytes.length)
      return at;
  }
  throw zipFail("no end record");
}

/** One central-directory entry at `at` and its stored bytes; answers it and where the next starts. */
function centralEntry(bytes: Buffer, at: number): { entry: ZipEntry; next: number } {
  if (at + ZIP.CentralBytes > bytes.length || bytes.readUInt32LE(at) !== ZIP.Central) throw zipFail("a bad directory");
  const flags = bytes.readUInt16LE(at + 8);
  const method = bytes.readUInt16LE(at + 10);
  const [crc, compressed, size] = [
    bytes.readUInt32LE(at + 16),
    bytes.readUInt32LE(at + 20),
    bytes.readUInt32LE(at + 24),
  ];
  const [nameLength, extra, comment] = [
    bytes.readUInt16LE(at + 28),
    bytes.readUInt16LE(at + 30),
    bytes.readUInt16LE(at + 32),
  ];
  const local = bytes.readUInt32LE(at + 42);
  const name = bytes.toString("utf8", at + ZIP.CentralBytes, at + ZIP.CentralBytes + nameLength);
  if (flags & ZIP.Encrypted) throw zipFail("an encrypted entry");
  if (method !== ZipMethod.Stored && method !== ZipMethod.Deflated) throw zipFail("an unknown compression method");
  if ([compressed, size, local].includes(ZIP.Zip64)) throw zipFail("a zip64 entry");
  if (!safeEntryName(name)) throw zipFail("an unsafe entry name");
  const fits = local + ZIP.LocalBytes <= bytes.length && bytes.readUInt32LE(local) === ZIP.Local;
  if (!fits) throw zipFail("an entry's header is missing");
  const data = local + ZIP.LocalBytes + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (data + compressed > bytes.length) throw zipFail("an entry runs past the file");
  const entry = { name, method, crc, size, stored: bytes.subarray(data, data + compressed) };
  return { entry, next: at + ZIP.CentralBytes + nameLength + extra + comment };
}

/**
 * Every entry of a package zip, from its central directory. Refuses (`zip-invalid`) a zip it
 * cannot read whole, an encrypted or zip64 entry, an unknown method, and an unsafe or repeated
 * name. Reads only.
 */
export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  const bytes = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  if (bytes.length < ZIP.EndBytes || bytes.length > PACKAGE_MAX_BYTES) throw zipFail("its size");
  const end = endOf(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const { entry, next } = centralEntry(bytes, at);
    if (names.has(entry.name)) throw zipFail("a repeated entry name");
    names.add(entry.name);
    entries.push(entry);
    at = next;
  }
  return entries;
}

/** An entry's uncompressed bytes, checked against its size and CRC. */
export function zipEntryData(entry: ZipEntry): Buffer {
  const data =
    entry.method === ZipMethod.Stored
      ? entry.stored
      : inflateRawSync(entry.stored, { maxOutputLength: FILE_MAX_BYTES });
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw zipFail(`${entry.name} does not match its CRC`);
  return data;
}

/** One member a package zip is written with. */
export interface ZipMember {
  name: string;
  data: Buffer;
  method: ZipMethod;
}

const deflateRawAsync = promisify(deflateRaw);

/** A local or central header's shared fields, "version needed" through the name length. */
function memberFields(method: ZipMethod, crc: number, stored: number, size: number, nameLength: number): Buffer {
  const fields = Buffer.alloc(24);
  fields.writeUInt16LE(ZIP.Version, 0);
  fields.writeUInt16LE(ZIP.Utf8, 2);
  fields.writeUInt16LE(method, 4);
  fields.writeUInt16LE(ZIP.DosDate, 8);
  fields.writeUInt32LE(crc, 10);
  fields.writeUInt32LE(stored, 14);
  fields.writeUInt32LE(size, 18);
  fields.writeUInt16LE(nameLength, 22);
  return fields;
}

/**
 * A deterministic zip of `members` in order: each stored or deflated as asked (an `.so` and
 * `resources.arsc` must be stored for the loader to map them), no timestamps, no extra fields.
 * zipalign adds the alignment afterwards.
 */
export async function writeZipMembers(members: readonly ZipMember[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    if (!safeEntryName(member.name)) throw zipFail("an unsafe entry name");
    const stored = member.method === ZipMethod.Stored ? member.data : await deflateRawAsync(member.data, { level: 9 });
    const name = Buffer.from(member.name, "utf8");
    const fields = memberFields(member.method, crc32(member.data), stored.length, member.data.length, name.length);
    const local = Buffer.concat([u32(ZIP.Local), fields, Buffer.alloc(2), name]);
    const tail = Buffer.alloc(16);
    tail.writeUInt32LE(offset, 12);
    central.push(Buffer.concat([u32(ZIP.Central), u16(ZIP.Version), fields, tail, name]));
    parts.push(local, stored);
    offset += local.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(ZIP.EndBytes);
  end.writeUInt32LE(ZIP.End, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

// ---------- the admitted payload ----------

/** One file of the lane's admitted `out/`, as its receipt lists it. */
export interface AdmittedOutput {
  path: string;
  sha256: string;
}

/** What a package carries of the game: its admitted library and assets, with their digests. */
export interface AndroidPayload {
  library: Buffer;
  librarySha256: string;
  /** `/`-separated under `assets/`, sorted. */
  assets: Array<{ path: string; bytes: Buffer; sha256: string }>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isNativeLibrary = (rel: string, bytes?: Uint8Array): boolean =>
  SHARED_OBJECT.test(rel) || (bytes !== undefined && Buffer.from(bytes.subarray(0, 4)).equals(ELF_MAGIC));

/** Every file under `out/`, `/`-separated, read without following a link (a link refuses). */
async function filesUnder(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw fail(AndroidPackageProblem.NotAdmitted, MESSAGE.NotAdmitted(child, "a link or special file"));
  }
  return files;
}

/** Refuses a path no Android payload may hold: a native library, an unlisted file, the notices' folder. */
function checkListed(rel: string, digests: ReadonlyMap<string, string>): void {
  if (rel !== GAME_FILE && isNativeLibrary(rel))
    throw fail(AndroidPackageProblem.ExtraLibrary, MESSAGE.ExtraLibrary(rel));
  if (rel !== GAME_FILE && !rel.startsWith(`${ASSETS_FOLDER}/`))
    throw fail(AndroidPackageProblem.NotAdmitted, MESSAGE.NotAdmitted(rel, "not the game or an asset"));
  if (!digests.has(rel)) throw fail(AndroidPackageProblem.NotAdmitted, MESSAGE.NotAdmitted(rel, "unlisted"));
  if (rel.startsWith(`${ASSETS_FOLDER}/${ANDROID_NOTICES_ASSET_FOLDER}/`))
    throw fail(AndroidPackageProblem.ReservedAsset, MESSAGE.Reserved(rel));
}

/** One admitted file's bytes, read without a link, at its admitted digest. */
async function admittedBytes(out: string, rel: string, digests: ReadonlyMap<string, string>): Promise<Buffer> {
  const read = await readBundleFile(out, rel, { realRoot: await realpath(out), maxBytes: FILE_MAX_BYTES });
  if (!read.ok) throw fail(AndroidPackageProblem.NotAdmitted, MESSAGE.NotAdmitted(rel, read.detail));
  if (digests.get(rel) !== sha256(read.bytes)) throw fail(AndroidPackageProblem.DigestMismatch, MESSAGE.Digest(rel));
  return Buffer.from(read.bytes);
}

/**
 * The payload of the lane's admitted Android `out/`: the game as admitted by the Android gate (no
 * transport, 16 KB loads, allow-listed libraries) and each asset, every byte at the digest the
 * receipt lists. Refuses an extra native library anywhere (`extra-library`, also an ELF file among
 * the assets), a file the receipt does not list or a link (`not-admitted`), a changed file
 * (`digest-mismatch`) and an asset in the notices' folder (`reserved-asset`). Reads only.
 */
export async function readAndroidPayload(out: string, outputs: readonly AdmittedOutput[]): Promise<AndroidPayload> {
  const digests = new Map(outputs.map((output) => [output.path, output.sha256]));
  for (const rel of digests.keys()) checkListed(rel, digests);
  const present = await filesUnder(out).catch((error: unknown) => {
    if (error instanceof AndroidPackageError) throw error;
    throw fail(AndroidPackageProblem.NotAdmitted, MESSAGE.NotAdmitted("out/", "unreadable"));
  });
  for (const rel of present) checkListed(rel, digests);
  const library = await admittedBytes(out, GAME_FILE, digests);
  const admission = admitRustBinary({ target: BuildTarget.Android, bytes: library, servesStudio: false });
  if (!admission.ok) throw fail(AndroidPackageProblem.NotAdmitted, MESSAGE.NotAdmitted(GAME_FILE, admission.detail));
  const assets: AndroidPayload["assets"] = [];
  for (const rel of [...digests.keys()].filter((name) => name !== GAME_FILE).sort()) {
    const bytes = await admittedBytes(out, rel, digests);
    if (isNativeLibrary(rel, bytes)) throw fail(AndroidPackageProblem.ExtraLibrary, MESSAGE.ExtraLibrary(rel));
    assets.push({ path: rel.slice(ASSETS_FOLDER.length + 1), bytes, sha256: sha256(bytes) });
  }
  return { library, librarySha256: admission.sha256, assets };
}

/** The payload's members: the library stored (loaded in place), each asset and notice deflated. */
function payloadMembers(payload: AndroidPayload, notices: readonly NoticeFile[], prefix: string): ZipMember[] {
  const notice = (file: NoticeFile): ZipMember => ({
    name: `${prefix}${ASSETS_FOLDER}/${ANDROID_NOTICES_ASSET_FOLDER}/${file.rel}`,
    data: Buffer.from(file.bytes),
    method: ZipMethod.Deflated,
  });
  return [
    { name: `${prefix}${ANDROID_LIBRARY_ENTRY}`, data: payload.library, method: ZipMethod.Stored },
    ...payload.assets.map((asset) => ({
      name: `${prefix}${ASSETS_FOLDER}/${asset.path}`,
      data: asset.bytes,
      method: ZipMethod.Deflated,
    })),
    ...notices.map(notice),
  ];
}

/** Where a package keeps the game's entries, and whether its library must be stored. */
export interface PackageLayout {
  /** `base/` in a bundle, nothing in an APK. */
  prefix: string;
  /** An APK stores `libmain.so` (loaded in place); a bundle compresses it, and Play's APKs store it again. */
  libraryStored: boolean;
}

/** The two layouts: an APK's and an App Bundle's base module. */
export const PACKAGE_LAYOUT = {
  Apk: { prefix: "", libraryStored: true },
  Bundle: { prefix: "base/", libraryStored: false },
} as const satisfies Record<string, PackageLayout>;

/**
 * Holds a package's game entries to the admitted payload: `libmain.so` byte-identical (and stored
 * in an APK), no other native library, and every asset present at its digest. Refuses
 * `packaged-entry-changed` or `extra-library`.
 */
export function verifyPackagedEntries(zip: Uint8Array, payload: AndroidPayload, layout: PackageLayout): void {
  const { prefix } = layout;
  const entries = new Map(readZipEntries(zip).map((entry) => [entry.name, entry]));
  const library = `${prefix}${ANDROID_LIBRARY_ENTRY}`;
  for (const name of entries.keys()) {
    const native = name.startsWith(`${prefix}lib/`) || isNativeLibrary(name);
    if (native && name !== library) throw fail(AndroidPackageProblem.ExtraLibrary, MESSAGE.ExtraLibrary(name));
  }
  const lib = entries.get(library);
  const placed = lib !== undefined && (!layout.libraryStored || lib.method === ZipMethod.Stored);
  if (!placed)
    throw fail(AndroidPackageProblem.PackagedEntryChanged, MESSAGE.Entry(library, "is missing or compressed"));
  const changed = (name: string, digest: string) => {
    const entry = entries.get(name);
    return entry === undefined || sha256(zipEntryData(entry)) !== digest;
  };
  if (changed(library, payload.librarySha256))
    throw fail(AndroidPackageProblem.PackagedEntryChanged, MESSAGE.Entry(library, "is not the admitted library"));
  for (const asset of payload.assets) {
    const name = `${prefix}${ASSETS_FOLDER}/${asset.path}`;
    if (changed(name, asset.sha256))
      throw fail(AndroidPackageProblem.PackagedEntryChanged, MESSAGE.Entry(name, "is not the admitted asset"));
  }
}

// ---------- tools and their sandboxes ----------

/** The packaging tools, each by its absolute path: the person's SDK and the store's JDK and bundletool. */
export interface AndroidPackageTools {
  aapt2: string;
  zipalign: string;
  /** Build-Tools' `apksigner` launcher (it runs on `JAVA_HOME`). */
  apksigner: string;
  /** `platforms/android-36/android.jar`: the compile SDK. */
  androidJar: string;
  /** The store's Temurin JDK home: `java`, `keytool` and `jarsigner` come from it. */
  javaHome: string;
  bundletoolJar: string;
}

/** One sandbox a tool run gets to itself. */
export interface AndroidToolSandbox {
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** Studio's signing facts for the APK: where the person's keys may not come from, and Studio's own key. */
export interface AndroidSigner {
  host: StudioPlatform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  forbiddenRoots: readonly string[];
  /** Studio's per-profile debug key folder (`<userData>/signing-keys/android-debug`), a protected path. */
  keyHome: string;
}

/** What packaging reaches: the tools, a sandbox per run, the host-only staging root and the signer. */
export interface AndroidPackageContext {
  tools: AndroidPackageTools;
  sandboxFor(options: SandboxOptions): Promise<AndroidToolSandbox>;
  /** `layout.exportStaging`: host-only, on the exports' volume. */
  stagingRoot: string;
  secretPaths: readonly string[];
  denyWrite: readonly string[];
  /** Values no packaged file may hold. */
  secretValues: readonly string[];
  signer: AndroidSigner;
}

const isPlainAbsolute = (value: string): boolean => path.isAbsolute(value) && !CONTROL.test(value);

function checkTools(tools: AndroidPackageTools): void {
  for (const [name, file] of Object.entries(tools))
    if (!isPlainAbsolute(file)) throw fail(AndroidPackageProblem.Target, MESSAGE.Tool(name));
}

/** The folders every packaging tool reads besides the staging folder. */
function toolReads(tools: AndroidPackageTools): string[] {
  const dirs = [tools.aapt2, tools.zipalign, tools.apksigner, tools.androidJar, tools.bundletoolJar].map((file) =>
    path.dirname(file),
  );
  return [...new Set([...dirs, tools.javaHome])];
}

/** The tool environment: the store's JDK on PATH, nothing of the person's. */
function toolEnv(tools: AndroidPackageTools): Record<string, string> {
  return { JAVA_HOME: tools.javaHome, PATH: `${path.join(tools.javaHome, "bin")}:/usr/bin:/bin` };
}

/** The sandbox options one tool run gets: the staging folder its one writable root, a private scratch. */
function toolSandboxOptions(context: AndroidPackageContext, staging: string): SandboxOptions {
  return {
    writableRoots: [staging],
    scratchDir: path.join(staging, ".tmp"),
    secretPaths: [...context.secretPaths],
    denyWrite: context.denyWrite.filter((deny) => !isInside(deny, staging)),
    readableRoots: toolReads(context.tools),
  };
}

/** Runs one tool in a sandbox of its own over `staging`; a failure or timeout refuses `tool-failed`. */
async function runTool(
  context: AndroidPackageContext,
  staging: string,
  label: string,
  argv: readonly string[],
  env: Record<string, string> = {},
  secrets: readonly string[] = [],
): Promise<RunResult> {
  await mkdir(path.join(staging, ".tmp"), { recursive: true });
  const sandbox = await context.sandboxFor(toolSandboxOptions(context, staging));
  try {
    const result = await sandbox.run({
      command: argv.map(shellQuote).join(" "),
      cwd: staging,
      env: { ...toolEnv(context.tools), ...env },
      timeoutMs: TOOL_TIMEOUT_MS,
      policy: { allowedDomains: [], allowWrite: [staging] },
      label,
      maxOutputBytes: TOOL_OUTPUT_MAX_BYTES,
      reapGroup: true,
    });
    if (result.code !== 0 || result.timedOut) {
      const output = redactValues(`${result.stdout}\n${result.stderr}`.trim(), [...secrets, ...context.secretValues]);
      throw new AndroidPackageError(AndroidPackageProblem.ToolFailed, MESSAGE.ToolFailed(label), output);
    }
    return result;
  } finally {
    await sandbox.dispose();
  }
}

const java = (tools: AndroidPackageTools): string => path.join(tools.javaHome, "bin", "java");
/** Java's temporary folder inside the run's own scratch: on a Mac it is the user's temp folder otherwise, which the sandbox denies. */
const javaTmp = (staging: string): string => `-Djava.io.tmpdir=${path.join(staging, ".tmp")}`;
const jdkTool = (tools: AndroidPackageTools, name: string): string => path.join(tools.javaHome, "bin", name);

// ---------- staging ----------

/** A new package file's path: absolute, the suffix, in an existing real folder, not there yet. */
async function checkedTarget(target: string, suffix: string): Promise<string> {
  const named = isPlainAbsolute(target) && target.endsWith(suffix);
  const dir = named ? await realpath(path.dirname(target)).catch(() => null) : null;
  const folder = dir === null ? null : await stat(dir).catch(() => null);
  const there = await lstat(target).catch(() => null);
  if (!folder?.isDirectory() || there !== null || dir === null)
    throw fail(AndroidPackageProblem.Target, MESSAGE.Target(target));
  return path.join(dir, path.basename(target));
}

/**
 * Writes the payload and notices into `<staging>/payload/` and refuses (`secret-found`) any of them
 * holding a held credential, before anything is compressed.
 */
async function stagePayload(
  staging: string,
  members: readonly ZipMember[],
  secretValues: readonly string[],
): Promise<void> {
  const root = path.join(staging, "payload");
  for (const member of members) {
    const file = path.join(root, ...member.name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, member.data, { flag: "wx" });
  }
  const names = members.map((member) => member.name);
  const found = await fileWithSecret(root, names, secretValues, () => true);
  if (found !== undefined) throw fail(AndroidPackageProblem.SecretFound, MESSAGE.Secret(found));
}

/** A fresh staging folder under the staging root (0700), removed by the caller. */
async function stagingFolder(root: string, prefix: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(await mkdtemp(path.join(root, prefix)));
}

/** Moves the finished package from staging to its target, which must still not exist. */
async function deliver(file: string, target: string, suffix: string): Promise<AndroidPackage> {
  const to = await checkedTarget(target, suffix);
  await rename(file, to);
  const bytes = await readFile(to);
  return { file: to, sha256: sha256(bytes), bytes: bytes.length };
}

/** A written package: its path, digest and size. */
export interface AndroidPackage {
  file: string;
  sha256: string;
  bytes: number;
}

/** One package request: the manifest's fields, the admitted payload, the notices, the signing and where it goes. */
export interface AndroidPackageRequest {
  manifest: AndroidManifestSpec;
  payload: AndroidPayload;
  notices: readonly NoticeFile[];
  signing: ExportSigningChoice;
  requestedBy: SigningRequester;
  /** The package file to write: absolute, `.apk` or `.aab`, in an existing real folder, not there yet. */
  target: string;
}

/** The signings each artifact takes, and who may ask: refused before anything is read or run. */
function checkSigning(request: AndroidPackageRequest, bundle: boolean): void {
  const { kind } = request.signing;
  const person = request.requestedBy === SigningRequester.Person;
  if ((bundle || kind === ExportSigning.AndroidRelease) && !person)
    throw fail(AndroidPackageProblem.HarnessMayNotSign, MESSAGE.Harness);
  const fits = bundle
    ? kind === ExportSigning.AndroidRelease
    : kind === ExportSigning.AndroidDebug || kind === ExportSigning.AndroidRelease;
  if (!fits) throw fail(AndroidPackageProblem.SigningKind, MESSAGE.Kind);
}

/** The manifest written into staging, checked against the rules first. */
async function stageManifest(staging: string, spec: AndroidManifestSpec): Promise<string> {
  const xml = androidManifestXml(spec);
  checkAndroidManifest(xml);
  const file = path.join(staging, "AndroidManifest.xml");
  await writeFile(file, xml, { flag: "wx" });
  return file;
}

/** `aapt2 link`'s arguments for the manifest (binary for an APK, proto for a bundle module). */
function aapt2Link(tools: AndroidPackageTools, manifest: string, output: string, proto: boolean): string[] {
  return [
    tools.aapt2,
    "link",
    ...(proto ? ["--proto-format"] : []),
    ...["-o", output, "-I", tools.androidJar, "--manifest", manifest],
    ...["--min-sdk-version", String(ANDROID_PINS.minSdk), "--target-sdk-version", String(ANDROID_PINS.targetSdk)],
  ];
}

/** aapt2's entries, their bytes and methods as aapt2 chose them (`resources.arsc` stays stored). */
async function aapt2Members(file: string, rename: (name: string) => string = (name) => name): Promise<ZipMember[]> {
  return readZipEntries(await readFile(file)).map((entry) => ({
    name: rename(entry.name),
    data: zipEntryData(entry),
    method: entry.method,
  }));
}

// ---------- the APK ----------

/** Studio's debug key, made once in a sandbox whose one writable root is its own folder. */
async function ensureDebugKey(context: AndroidPackageContext, staging: string): Promise<void> {
  const { signer, tools } = context;
  const key = androidDebugKeyPaths(signer.keyHome);
  await mkdir(key.home, { recursive: true, mode: 0o700 });
  const sandbox = await context.sandboxFor({
    ...mobileSignSandboxOptions({
      staging: await realpath(key.home),
      scratch: path.join(staging, ".tmp-keytool"),
      secretPaths: context.secretPaths,
      denyWrite: context.denyWrite,
      keyHome: key.home,
    }),
    readableRoots: [tools.javaHome],
  });
  try {
    await mkdir(path.join(staging, ".tmp-keytool"), { recursive: true });
    const tool = { file: jdkTool(tools, "keytool"), args: [] };
    await ensureAndroidDebugKey(sandbox, { key, tool, home: signer.home, toolEnv: toolEnv(tools) });
  } finally {
    await sandbox.dispose();
  }
}

/** Signs the aligned APK with `apksigner` (`mobile-sign.ts`) in a sandbox of its own; answers the signed file. */
async function signAlignedApk(
  context: AndroidPackageContext,
  request: AndroidPackageRequest,
  staging: string,
  aligned: string,
): Promise<string> {
  const { signer, tools } = context;
  const debug = request.signing.kind === ExportSigning.AndroidDebug;
  if (debug) await ensureDebugKey(context, staging);
  await mkdir(path.join(staging, ".tmp-sign"), { recursive: true });
  const options = mobileSignSandboxOptions({
    staging,
    scratch: path.join(staging, ".tmp-sign"),
    secretPaths: context.secretPaths,
    denyWrite: context.denyWrite,
    ...(debug ? { keyHome: signer.keyHome } : {}),
  });
  const sandbox = await context.sandboxFor({ ...options, readableRoots: toolReads(tools) });
  try {
    const signed = await signApk(sandbox, {
      choice: request.signing,
      requestedBy: request.requestedBy,
      host: signer.host,
      tool: { file: tools.apksigner, args: [] },
      stagingDir: staging,
      input: aligned,
      output: path.join(staging, "signed.apk"),
      debugKey: androidDebugKeyPaths(signer.keyHome),
      forbiddenRoots: signer.forbiddenRoots,
      home: signer.home,
      env: signer.env,
      toolEnv: toolEnv(tools),
    });
    return signed.output;
  } catch (error) {
    if (!(error instanceof MobileSignError)) throw error;
    throw new AndroidPackageError(AndroidPackageProblem.SigningFailed, error.message, error.output);
  } finally {
    await sandbox.dispose();
  }
}

/**
 * Packages a development APK: the host's manifest linked by `aapt2`, the admitted library stored
 * and the assets and notices added by the host, `zipalign -P 16` and its `-c` check, every game
 * entry held to its admitted digest, signed by `apksigner` (Studio's debug key, or the person's
 * release keystore) and verified, then moved to `request.target`. Each tool runs in a sandbox of
 * its own. Every refusal is an {@link AndroidPackageError}; staging is removed whatever happens.
 */
export async function packageAndroidApk(
  context: AndroidPackageContext,
  request: AndroidPackageRequest,
): Promise<AndroidPackage> {
  checkSigning(request, false);
  checkTools(context.tools);
  const members = payloadMembers(request.payload, request.notices, "");
  await checkedTarget(request.target, ".apk");
  const { tools } = context;
  const staging = await stagingFolder(context.stagingRoot, "android-apk-");
  try {
    const manifest = await stageManifest(staging, request.manifest);
    await stagePayload(staging, members, context.secretValues);
    const base = path.join(staging, "base.apk");
    await runTool(context, staging, TOOL_LABEL.Aapt2, aapt2Link(tools, manifest, base, false));
    const unaligned = path.join(staging, "unaligned.apk");
    await writeFile(unaligned, await writeZipMembers([...(await aapt2Members(base)), ...members]));
    const aligned = path.join(staging, "aligned.apk");
    const page = ["-P", String(ZIP_PAGE_ALIGN_KB)];
    await runTool(context, staging, TOOL_LABEL.Zipalign, [
      tools.zipalign,
      ...page,
      "-f",
      `${ZIP_ALIGN_BYTES}`,
      unaligned,
      aligned,
    ]);
    await zipalignCheck(context, staging, aligned);
    verifyPackagedEntries(await readFile(aligned), request.payload, PACKAGE_LAYOUT.Apk);
    const signed = await signAlignedApk(context, request, staging, aligned);
    const verify = [tools.apksigner, "verify", "--min-sdk-version", String(ANDROID_PINS.minSdk), signed];
    await runTool(context, staging, TOOL_LABEL.Apksigner, verify);
    await zipalignCheck(context, staging, signed);
    verifyPackagedEntries(await readFile(signed), request.payload, PACKAGE_LAYOUT.Apk);
    return await deliver(signed, request.target, ".apk");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** `zipalign -c -P 16 4` over `apk`; a failure is `not-aligned`. */
async function zipalignCheck(context: AndroidPackageContext, staging: string, apk: string): Promise<void> {
  const argv = [context.tools.zipalign, "-c", "-P", String(ZIP_PAGE_ALIGN_KB), `${ZIP_ALIGN_BYTES}`, apk];
  await runTool(context, staging, TOOL_LABEL.Zipalign, argv).catch((error: unknown) => {
    if (!(error instanceof AndroidPackageError)) throw error;
    throw new AndroidPackageError(AndroidPackageProblem.NotAligned, MESSAGE.NotAligned, error.output);
  });
}

// ---------- the App Bundle ----------

/** The bundle's config: native libraries stored and 16 KB page-aligned in every APK Play makes from it. */
const BUNDLE_CONFIG = {
  optimizations: { uncompressNativeLibraries: { enabled: true, alignment: "PAGE_ALIGNMENT_16K" } },
} as const;

/** aapt2's proto output as a bundle module: the manifest under `manifest/`, everything else as it was. */
const moduleName = (name: string): string => (name === "AndroidManifest.xml" ? `manifest/${name}` : name);

/** The person's release keystore and password, checked as `mobile-sign.ts` checks an APK's. */
/** The person's release key, checked: its keystore's real path, alias and password (read by the host). */
interface ReleaseKey {
  keystore: string;
  alias: string;
  password: string;
}

async function releaseKey(signing: ExportSigningChoice, signer: AndroidSigner): Promise<ReleaseKey> {
  if (signing.kind !== ExportSigning.AndroidRelease) throw fail(AndroidPackageProblem.SigningKind, MESSAGE.Kind);
  if (signer.host === StudioPlatform.Windows)
    throw new AndroidPackageError(
      AndroidPackageProblem.SigningFailed,
      new MobileSignError(MobileSignProblem.WindowsHostPassword).message,
    );
  const keystore = await personFile(signing.keystore, signer, KEYSTORE_CODES, FILE_MAX_BYTES);
  const password = await releasePassword(signing.password, signer);
  const valid = password !== undefined && password.length > 0 && password.length <= 1024 && !password.includes("\0");
  if (!valid) throw signFail(MobileSignProblem.Password);
  return { keystore, alias: signing.alias, password };
}

const firstLine = (text: string): string | undefined => text.split(/\r?\n/u)[0];

/** The password a reference names, read by the host: an environment variable, or a small file's first line. */
async function releasePassword(
  reference: SigningPasswordReference,
  signer: AndroidSigner,
): Promise<string | undefined> {
  if ("env" in reference) return signer.env[reference.env];
  const file = await personFile(reference.file, signer, PASSWORD_CODES, PASSWORD_FILE_MAX_BYTES);
  return firstLine(await readFile(file, "utf8"));
}
const signFail = (code: MobileSignProblem) =>
  new AndroidPackageError(AndroidPackageProblem.SigningFailed, new MobileSignError(code).message);

/** The refusals a person's file earns: one for a missing or unusable file, one for a forbidden place. */
interface PersonFileCodes {
  missing: MobileSignProblem;
  forbidden: MobileSignProblem;
}
const KEYSTORE_CODES = { missing: MobileSignProblem.Keystore, forbidden: MobileSignProblem.KeystoreForbidden } as const;
const PASSWORD_CODES = {
  missing: MobileSignProblem.Password,
  forbidden: MobileSignProblem.PasswordFileForbidden,
} as const;

/**
 * A file the person named: absolute, a regular file of at most `maxBytes` by its real path, outside
 * every forbidden root and `~/.android`.
 */
async function personFile(
  file: string,
  signer: AndroidSigner,
  codes: PersonFileCodes,
  maxBytes: number,
): Promise<string> {
  if (!isPlainAbsolute(file)) throw signFail(codes.missing);
  const real = await realpath(file).catch(() => null);
  const info = real === null ? null : await stat(real).catch(() => null);
  if (real === null || !info?.isFile() || info.size > maxBytes) throw signFail(codes.missing);
  const roots = [...signer.forbiddenRoots, path.join(signer.home, ".android")];
  for (const root of roots) {
    const resolved = await realpath(root).catch(() => path.resolve(root));
    if (isInside(resolved, real)) throw signFail(codes.forbidden);
  }
  return real;
}

/** The entries a JAR signature adds under `META-INF/`. */
const JAR_SIGNATURE = /^META-INF\/(MANIFEST\.MF|[^/]+\.(SF|RSA|EC|DSA))$/;

/**
 * Whether `signed` is `original` with a JAR signature added and nothing else: every original entry
 * there with the same CRC, size and method, and only `META-INF/` signature files besides.
 */
export function jarSignatureOnlyChange(original: Uint8Array, signed: Uint8Array): boolean {
  const before = readZipEntries(original);
  const after = new Map(readZipEntries(signed).map((entry) => [entry.name, entry]));
  if (before.some((entry) => JAR_SIGNATURE.test(entry.name))) return false;
  const same = before.every((entry) => {
    const now = after.get(entry.name);
    return now !== undefined && now.crc === entry.crc && now.size === entry.size;
  });
  const names = new Set(before.map((entry) => entry.name));
  const added = [...after.keys()].filter((name) => !names.has(name));
  return same && added.length > 0 && added.every((name) => JAR_SIGNATURE.test(name));
}

/** Signs the validated bundle with `jarsigner` and the person's keystore in a sandbox of its own. */
async function signBundle(
  context: AndroidPackageContext,
  staging: string,
  unsigned: string,
  key: ReleaseKey,
): Promise<string> {
  const signed = path.join(staging, "signed.aab");
  const pass = ANDROID_KEY_PASS_ENV;
  const argv = [
    jdkTool(context.tools, "jarsigner"),
    `-J${javaTmp(staging)}`,
    ...["-keystore", key.keystore, `-storepass:env`, pass, `-keypass:env`, pass, "-digestalg", "SHA-256"],
    ...["-signedjar", signed, unsigned, key.alias],
  ];
  await runTool(context, staging, TOOL_LABEL.Jarsigner, argv, { [pass]: key.password }, [key.password]).catch(
    (error: unknown) => {
      if (!(error instanceof AndroidPackageError)) throw error;
      throw new AndroidPackageError(AndroidPackageProblem.SigningFailed, error.message, error.output);
    },
  );
  if (!jarSignatureOnlyChange(await readFile(unsigned), await readFile(signed)))
    throw fail(AndroidPackageProblem.SigningFailed, MESSAGE.SignChanged);
  return signed;
}

/**
 * Packages an Android App Bundle (the person's only, signed with their release keystore): the
 * host's manifest linked by `aapt2 --proto-format` into a base module with the admitted library,
 * assets and notices, `bundletool build-bundle` with 16 KB-aligned stored native libraries,
 * `bundletool validate`, every game entry held to its admitted digest, then `jarsigner`. Each tool
 * runs in a sandbox of its own; staging is removed whatever happens.
 */
export async function packageAndroidAab(
  context: AndroidPackageContext,
  request: AndroidPackageRequest,
): Promise<AndroidPackage> {
  checkSigning(request, true);
  checkTools(context.tools);
  const key = await releaseKey(request.signing, context.signer);
  const members = payloadMembers(request.payload, request.notices, "");
  await checkedTarget(request.target, ".aab");
  const { tools } = context;
  const staging = await stagingFolder(context.stagingRoot, "android-aab-");
  try {
    const manifest = await stageManifest(staging, request.manifest);
    await stagePayload(staging, members, context.secretValues);
    const proto = path.join(staging, "proto.apk");
    await runTool(context, staging, TOOL_LABEL.Aapt2, aapt2Link(tools, manifest, proto, true));
    const module = path.join(staging, "base.zip");
    await writeFile(module, await writeZipMembers([...(await aapt2Members(proto, moduleName)), ...members]));
    const config = path.join(staging, "BundleConfig.json");
    await writeFile(config, JSON.stringify(BUNDLE_CONFIG), { flag: "wx" });
    const unsigned = path.join(staging, "unsigned.aab");
    const bundletool = [java(tools), javaTmp(staging), "-jar", tools.bundletoolJar];
    const build = [...bundletool, "build-bundle", `--modules=${module}`, `--output=${unsigned}`, `--config=${config}`];
    await runTool(context, staging, TOOL_LABEL.Bundletool, build);
    await runTool(context, staging, TOOL_LABEL.Bundletool, [...bundletool, "validate", `--bundle=${unsigned}`]).catch(
      (error: unknown) => {
        if (!(error instanceof AndroidPackageError)) throw error;
        throw new AndroidPackageError(AndroidPackageProblem.BundleInvalid, MESSAGE.BundleInvalid, error.output);
      },
    );
    verifyPackagedEntries(await readFile(unsigned), request.payload, PACKAGE_LAYOUT.Bundle);
    const signed = await signBundle(context, staging, unsigned, key);
    verifyPackagedEntries(await readFile(signed), request.payload, PACKAGE_LAYOUT.Bundle);
    return await deliver(signed, request.target, ".aab");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---------- notices ----------

/**
 * The runtime licence texts an Android export's row needs beyond the shared ones: the NDK's LLVM
 * libunwind (Rust's `unwind` links the NDK's static `libunwind.a`) is under the same Apache-2.0
 * WITH LLVM-exception texts as compiler-rt, so it takes those. A fresh object; the input is not changed.
 */
export function androidRuntimeSources(
  sources: Partial<Record<RuntimePart, readonly NoticeSource[]>>,
): Partial<Record<RuntimePart, readonly NoticeSource[]>> {
  const llvm = sources[RustRuntimePart.CompilerRt];
  const libunwind = sources[RustRuntimePart.Libunwind] ?? llvm;
  return libunwind === undefined ? { ...sources } : { ...sources, [RustRuntimePart.Libunwind]: libunwind };
}
