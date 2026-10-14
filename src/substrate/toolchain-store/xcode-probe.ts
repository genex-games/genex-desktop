/**
 * The Xcode probe for iPhone builds: the selected (or default) Xcode's version and the newest iOS
 * and Simulator SDKs it holds, read from plain files. Only `xcode-select -p` runs, never
 * `xcodebuild` (which can stop on Apple's licence prompt), `xcrun` or a shim that can open Apple's
 * installer. Nothing is reached through a link out of place: a `version.plist` that is one counts
 * as none, and an SDK name that is a link counts only when it leads to a real folder in the same
 * SDKs folder (Xcode 26 ships `iPhoneOS26.5.sdk -> iPhoneOS.sdk`).
 *
 * The gate each iPhone build passes ({@link XCODE_PINS}): a device or distribution build needs
 * Xcode 26 or later with the iOS 26 SDK; a Simulator build needs any Xcode with a Simulator SDK.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { XcodeStatus, xcodeStatusOf } from "../../shared/toolchain.ts";
import { readRegularFile } from "../fsx.ts";
import { isInside } from "../paths.ts";
import type { XcodeExec } from "./locate.ts";

/** `xcode-select -p` prints the selected developer folder; it never opens Apple's installer. */
const XCODE_SELECT = "/usr/bin/xcode-select";
/** Where the App Store installs Xcode. */
const DEFAULT_XCODE_APP = "/Applications/Xcode.app";
/** How long `xcode-select -p` may take. */
const XCODE_PROBE_TIMEOUT_MS = 10 * SECOND_MS;
/** The most of Xcode's `version.plist` the probe reads. */
const VERSION_PLIST_MAX_BYTES = 64 * 1024;
/** The most entries of an SDKs folder the probe looks at. */
const SDK_FOLDER_MAX_ENTRIES = 256;
/** A selected developer folder inside an app bundle: `<…>.app/Contents/Developer`. */
const SELECTED_APP = /^(.+\.app)\/Contents\/Developer\/?$/;
/** Xcode's marketing version in its `version.plist`. */
const SHORT_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([0-9][0-9.]{0,31})<\/string>/;

/** Why an iPhone build cannot run on this Mac. Wire values: the lanes' refusal lines name them. */
export const XcodeRefusal = {
  /** No Xcode at all (the Command Line Tools build no iPhone app). */
  XcodeMissing: "xcode-missing",
  /** A device or distribution build needs Xcode {@link XCODE_PINS}`.minMajor` or later. */
  XcodeTooOld: "xcode-too-old",
  /** A device or distribution build needs the iOS {@link XCODE_PINS}`.iosSdkMinMajor` SDK. */
  IosSdkMissing: "ios-sdk-missing",
  /** A Simulator build needs Xcode's Simulator SDK. */
  SimulatorSdkMissing: "simulator-sdk-missing",
} as const;
export type XcodeRefusal = (typeof XcodeRefusal)[keyof typeof XcodeRefusal];

/** The SDK folders an Xcode keeps, per kind: `Platforms/<platform>/Developer/SDKs/<name><version>.sdk`. */
const SDK_KINDS = {
  ios: { platform: "iPhoneOS.platform", pattern: /^iPhoneOS(\d+(?:\.\d+){0,2})\.sdk$/ },
  simulator: { platform: "iPhoneSimulator.platform", pattern: /^iPhoneSimulator(\d+(?:\.\d+){0,2})\.sdk$/ },
} as const;
type SdkKind = keyof typeof SDK_KINDS;

/** What the gates read: whether Xcode is there, its version and its newest iOS and Simulator SDKs. */
export interface XcodeSdks {
  present: boolean;
  version: string | null;
  iosSdk: string | null;
  simulatorSdk: string | null;
}

/** What the probe reports: {@link XcodeSdks} with its status against {@link XCODE_PINS}. */
export interface XcodeProbe extends XcodeSdks {
  status: XcodeStatus;
}

/** What the probe reaches, injected. */
export interface XcodeSdkProbeOptions {
  exec: XcodeExec;
  platform: NodeJS.Platform | string;
  /** Where Xcode is looked for when the selected developer folder is not inside one (default: /Applications/Xcode.app). */
  defaultApp?: string;
}

const ABSENT: XcodeProbe = Object.freeze({
  present: false,
  version: null,
  iosSdk: null,
  simulatorSdk: null,
  status: XcodeStatus.Absent,
});

/** A dotted version's numbers. */
const numbersOf = (version: string): number[] => version.split(".").map(Number);

/** Orders dotted versions oldest first. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [numbersOf(a), numbersOf(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The Xcode bundle `xcode-select -p` names, or null when it names the Command Line Tools or nothing. */
async function selectedApp(exec: XcodeExec): Promise<string | null> {
  const selected = await exec(XCODE_SELECT, ["-p"], { timeoutMs: XCODE_PROBE_TIMEOUT_MS });
  if (selected.code !== 0) return null;
  return SELECTED_APP.exec(selected.stdout.trim())?.[1] ?? null;
}

/** The version an Xcode bundle's `version.plist` names, never read through a link; undefined when it cannot be read. */
async function appVersion(app: string): Promise<string | null | undefined> {
  const plist = await readRegularFile(path.join(app, "Contents", "version.plist"), VERSION_PLIST_MAX_BYTES).catch(
    () => null,
  );
  if (!plist) return undefined;
  return SHORT_VERSION.exec(plist.toString("utf8"))?.[1] ?? null;
}

/**
 * Whether the SDK entry `name` in the realpath'd `sdks` folder is a folder there: a real one, or a
 * link (Xcode 26's versioned name) that resolves to a folder directly in the same SDKs folder.
 */
async function isSdkFolder(sdks: string, name: string): Promise<boolean> {
  const entry = path.join(sdks, name);
  const info = await lstat(entry).catch(() => null);
  if (info?.isDirectory()) return true;
  if (!info?.isSymbolicLink()) return false;
  const target = await realpath(entry).catch(() => null);
  if (target === null || path.dirname(target) !== sdks) return false;
  const resolved = await lstat(target).catch(() => null);
  return resolved?.isDirectory() ?? false;
}

/** The newest SDK of `kind` in `app`: only folders in the bundle's SDKs folder, never a link out of it. */
async function newestSdk(app: string, kind: SdkKind): Promise<string | null> {
  const { platform, pattern } = SDK_KINDS[kind];
  const bundle = await realpath(app).catch(() => null);
  const sdks = await realpath(
    path.join(app, "Contents", "Developer", "Platforms", platform, "Developer", "SDKs"),
  ).catch(() => null);
  if (bundle === null || sdks === null || !isInside(bundle, sdks)) return null;
  const names = await readdir(sdks).catch((): string[] => []);
  const versions: string[] = [];
  for (const name of names.slice(0, SDK_FOLDER_MAX_ENTRIES)) {
    const version = pattern.exec(name)?.[1];
    if (version === undefined) continue;
    if (await isSdkFolder(sdks, name)) versions.push(version);
  }
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** What one Xcode bundle holds, or null when its `version.plist` cannot be read. */
async function probeApp(app: string): Promise<XcodeProbe | null> {
  const version = await appVersion(app);
  if (version === undefined) return null;
  const sdks: XcodeSdks = {
    present: true,
    version,
    iosSdk: await newestSdk(app, "ios"),
    simulatorSdk: await newestSdk(app, "simulator"),
  };
  return { ...sdks, status: xcodeStatusOf(sdks) };
}

/**
 * The Xcode iPhone builds use on this Mac: the one `xcode-select -p` names, else the one in the
 * default place, with its version and newest iOS and Simulator SDKs. Not a Mac, or no readable
 * Xcode: absent.
 */
export async function probeXcodeSdks(options: XcodeSdkProbeOptions): Promise<XcodeProbe> {
  if (options.platform !== StudioPlatform.Mac) return ABSENT;
  const selected = await selectedApp(options.exec).catch(() => null);
  for (const app of [selected, options.defaultApp ?? DEFAULT_XCODE_APP]) {
    if (app === null) continue;
    const found = await probeApp(app);
    if (found) return found;
  }
  return ABSENT;
}

/** The refusal each status gives a device or distribution build. */
const DEVICE_REFUSAL = {
  [XcodeStatus.Absent]: XcodeRefusal.XcodeMissing,
  [XcodeStatus.TooOld]: XcodeRefusal.XcodeTooOld,
  [XcodeStatus.IosSdkMissing]: XcodeRefusal.IosSdkMissing,
  [XcodeStatus.Ready]: null,
} as const satisfies Record<XcodeStatus, XcodeRefusal | null>;

/** Why a device or distribution build cannot run with this Xcode, or null when it can. */
export function deviceBuildRefusal(found: XcodeSdks): XcodeRefusal | null {
  return DEVICE_REFUSAL[xcodeStatusOf(found)];
}

/** Why a Simulator build cannot run with this Xcode, or null when it can (any Xcode with a Simulator SDK). */
export function simulatorBuildRefusal(found: XcodeSdks): XcodeRefusal | null {
  if (!found.present) return XcodeRefusal.XcodeMissing;
  return found.simulatorSdk === null ? XcodeRefusal.SimulatorSdkMissing : null;
}
