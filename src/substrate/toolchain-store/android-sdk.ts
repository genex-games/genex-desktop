/**
 * The Android store pieces: the person's own SDK (the platform, Build-Tools and NDK they install
 * under Google's SDK licence, `USER_SIDE_COMPONENTS`), found and probed from plain files and never
 * run; the licence a person accepted in the Toolchain sheet, recorded the way `sdkmanager` records
 * it; the `sdkmanager` install of the pinned parts, refused before anything runs or downloads
 * without that licence; the sandboxed probes of the store's own Android tools (the JDK), which read
 * the store and nothing else, never the person's home, `~/.android` or Studio's debug keystore;
 * and the quarterly lane's rule for Play's yearly target-API bump.
 *
 * The probe never hands out the SDK's device tools (`platform-tools`, `emulator`): no agent-driven
 * device run reaches them (containment stage 1).
 */
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { ANDROID_PINS, AndroidLicence, JDK_PIN, ToolchainId, UserSideState } from "../../shared/toolchain.ts";
import { readRegularFile, writeFileNoFollow } from "../fsx.ts";
import { containedReal, isInside } from "../paths.ts";
import { shellQuote } from "../shell-quote.ts";
import type { RunRequest, RunResult, SandboxOptions } from "../spawn.ts";
import { compareVersions } from "./xcode-probe.ts";

/** Why an Android store piece refused. Wire values: the sheet and the lane's refusal lines name them. */
export const AndroidSdkRefusal = {
  /** No Android SDK where the person keeps one. */
  SdkMissing: "sdk-missing",
  /** The person has not accepted the Android SDK licence: nothing is installed under it. */
  LicenceNotAccepted: "licence-not-accepted",
  /** The SDK has no `sdkmanager` (the command-line tools) to install its parts with. */
  SdkmanagerMissing: "sdkmanager-missing",
  /** `sdkmanager` ran and failed. */
  InstallFailed: "install-failed",
  /** A licence record that is a link (or sits in a linked folder): never written through. */
  LinkRefused: "link-refused",
  /** A store that holds (or sits in) a credential home or the debug keystore. */
  ForbiddenRoot: "forbidden-root",
  /** A probe whose program or folder resolves outside the store. */
  OutsideStore: "outside-store",
  /** The store's JDK did not answer its probe. */
  JdkProbeFailed: "jdk-probe-failed",
  /** The store's JDK is not Temurin's pinned feature release. */
  JdkWrongVersion: "jdk-wrong-version",
} as const;
export type AndroidSdkRefusal = (typeof AndroidSdkRefusal)[keyof typeof AndroidSdkRefusal];

/** A typed refusal of an Android store piece. */
export class AndroidSdkError extends Error {
  readonly code: AndroidSdkRefusal;
  constructor(code: AndroidSdkRefusal, message: string) {
    super(message);
    this.name = "AndroidSdkError";
    this.code = code;
  }
}

/** Where a user-side component stands: the sheet reads it, so its home is `shared/toolchain.ts`. */
export { UserSideState } from "../../shared/toolchain.ts";

/** Where a target SDK stands against Play's target-API floor. */
export const PlayTargetState = {
  Ok: "ok",
  /** The floor rises within a quarter and the target does not meet the next one. */
  DueSoon: "due-soon",
  /** The target is below the floor in force: Play refuses new apps and updates. */
  Behind: "behind",
} as const;
export type PlayTargetState = (typeof PlayTargetState)[keyof typeof PlayTargetState];

/**
 * The hash `sdkmanager` records in `licenses/android-sdk-license` once the current Android SDK
 * licence is accepted: the one licence the platform, Build-Tools and the NDK install under.
 */
export const ANDROID_SDK_LICENCE_SHA1 = "24333f8a63b6825ea9c5514f83c2829b004d1fee";

/** Each licence a person accepts, by the hash its record file holds. */
const LICENCE_HASH = {
  [AndroidLicence.Sdk]: ANDROID_SDK_LICENCE_SHA1,
} as const satisfies Record<AndroidLicence, string>;

/** The Build-Tools programs the packaging steps run. */
const BUILD_TOOLS = ["aapt2", "zipalign", "apksigner", "d8"] as const;
/** The folder `sdkmanager` keeps accepted licences in. */
const LICENCES_FOLDER = "licenses";
/** The folders one of which every SDK holds. */
const SDK_MARKERS = ["platforms", "build-tools", "ndk", "cmdline-tools", LICENCES_FOLDER] as const;
/** Where the command-line tools keep `sdkmanager`, newest layout first. */
const SDKMANAGER_PLACES = ["cmdline-tools/latest/bin", "tools/bin"] as const;
/** The most of a licence record or an NDK's `source.properties` the probe reads. */
const SMALL_FILE_MAX_BYTES = 64 * 1024;
/** The most entries of an SDK folder the probe looks at. */
const SDK_FOLDER_MAX_ENTRIES = 256;
/** How long one `sdkmanager` install may take (the NDK is over a gigabyte). */
const SDKMANAGER_TIMEOUT_MS = 60 * MINUTE_MS;
/** How long a store probe may take. */
const STORE_PROBE_TIMEOUT_MS = 30 * SECOND_MS;
/** The only hosts `sdkmanager` downloads from. */
const ANDROID_REPOSITORY_DOMAINS = ["dl.google.com", "dl-ssl.google.com"] as const;
/** How long before Play's floor rises the lane calls the target due. */
const PLAY_DUE_WINDOW_MS = 92 * DAY_MS;
/**
 * Play's target-API rule: from 31 August of a year, new apps and updates target the API level
 * released the year before (API 35 from 2025-08-31, 36 from 2026-08-31). The lane moves
 * `targetSdk`, `compileSdk`, the platform and Build-Tools together ahead of each rise.
 */
const PLAY_FLOOR = { month: 7, day: 31, apiOffset: 1990 } as const;
/** An NDK's revision in its `source.properties`. */
const NDK_REVISION = /^Pkg\.Revision\s*=\s*(\d+\.\d+\.\d+)\s*$/m;
/** A Build-Tools folder's version. */
const BUILD_TOOLS_VERSION = /^(\d+)\.\d+\.\d+$/;
/** An SDK platform folder's name. */
const PLATFORM_NAME = /^android-\d+$/;
/** The release `java -version` names. */
const JAVA_VERSION = /version "(\d+)(?:\.[\d.]+)?[^"]*"/;
/** Temurin's runtime banner in `java -version`. */
const TEMURIN = /Temurin/;

const MESSAGE = {
  sdkMissing: "No Android SDK was found: install Android Studio's SDK, then accept its licence in Genex.",
  licence: "The Android SDK licence has not been accepted: accept it in the Toolchain sheet first.",
  sdkmanager: "This Android SDK has no command-line tools (sdkmanager) to install its parts with.",
  installFailed: (stderr: string) => `sdkmanager could not install the Android parts: ${stderr.trim().slice(-400)}`,
  link: (file: string) => `${file} is a link: the licence is never recorded through one.`,
  forbidden: (store: string) => `The toolchain store ${store} holds a credential home or the debug keystore.`,
  outside: (file: string) => `${file} is outside the toolchain store.`,
  jdkFailed: "The store's JDK did not answer its version probe.",
  jdkVersion: (banner: string) => `The store's JDK is not Temurin ${JDK_PIN.feature}: ${banner.trim().slice(0, 200)}`,
} as const;

/** One found part of the SDK: its pinned version and its folder (realpath'd inside the SDK). */
export interface SdkPart {
  version: string;
  dir: string;
}

/** What the probe found in the person's Android SDK; every path is realpath'd inside `root`. */
export interface AndroidSdkFound {
  root: string;
  /** `licenses/android-sdk-license` names {@link ANDROID_SDK_LICENCE_SHA1}. */
  licenceAccepted: boolean;
  /** The pinned platform's `android.jar`, or null. */
  platformJar: string | null;
  /** Every `android-<n>` platform installed. */
  platforms: string[];
  /** The newest Build-Tools of the pinned major holding every packaging program, or null. */
  buildTools: SdkPart | null;
  /** Every Build-Tools version installed, oldest first. */
  buildToolsVersions: string[];
  /** The pinned NDK revision, or null. */
  ndk: SdkPart | null;
  /** Every NDK revision installed (read from its `source.properties`), oldest first. */
  ndkVersions: string[];
  /** The SDK's `sdkmanager`, or null without the command-line tools. */
  sdkmanager: string | null;
}

/** Where the probe looks for an SDK and what it must never take one from. */
export interface AndroidSdkProbeOptions {
  /** Places in order ({@link androidSdkCandidates}); the first that is an SDK wins. */
  candidates: readonly string[];
  /** Credential homes and the debug keystore's folder: an SDK in one (followed through links) is never taken. */
  forbiddenRoots: readonly string[];
  platform: NodeJS.Platform | string;
}

/** An environment's absolute value for `name`, or null. */
function absoluteEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  return value && path.isAbsolute(value) ? value : null;
}

/** Where the person's SDK may be: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then Android Studio's default place. */
export function androidSdkCandidates(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform | string,
): string[] {
  const named = [absoluteEnv(env, "ANDROID_HOME"), absoluteEnv(env, "ANDROID_SDK_ROOT")];
  const local = absoluteEnv(env, "LOCALAPPDATA");
  const defaults: Record<string, string | null> = {
    [StudioPlatform.Mac]: path.join(home, "Library", "Android", "sdk"),
    [StudioPlatform.Linux]: path.join(home, "Android", "Sdk"),
    [StudioPlatform.Windows]: local ? path.join(local, "Android", "Sdk") : null,
  };
  const places = [...named, defaults[platform] ?? null].filter((place): place is string => place !== null);
  return [...new Set(places)];
}

/** The credential homes the Android tools keep keys in: `~/.android` and `ANDROID_USER_HOME`. */
export function androidCredentialHomes(home: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const named = [absoluteEnv(env, "ANDROID_USER_HOME"), absoluteEnv(env, "ANDROID_SDK_HOME")];
  return [...new Set([path.join(home, ".android"), ...named.filter((place): place is string => place !== null)])];
}

/** `rel` inside `root` as a real folder (links followed only while they stay inside), or null. */
async function folderIn(root: string, rel: string): Promise<string | null> {
  const dir = await containedReal(root, rel).catch(() => null);
  if (dir === null) return null;
  const info = await lstat(dir).catch(() => null);
  return info?.isDirectory() ? dir : null;
}

/** `rel` inside `root` as a regular file that is not itself a link, its folder realpath'd inside; or null. */
async function fileIn(root: string, rel: string): Promise<string | null> {
  const dir = await folderIn(root, path.posix.dirname(rel));
  if (dir === null) return null;
  const file = path.join(dir, path.posix.basename(rel));
  const info = await lstat(file).catch(() => null);
  return info?.isFile() ? file : null;
}

/** A small text file inside `root`, never through a link; null when it cannot be read. */
async function smallTextIn(root: string, rel: string): Promise<string | null> {
  const dir = await folderIn(root, path.posix.dirname(rel));
  if (dir === null) return null;
  const bytes = await readRegularFile(path.join(dir, path.posix.basename(rel)), SMALL_FILE_MAX_BYTES).catch(() => null);
  return bytes?.toString("utf8") ?? null;
}

/** The names in a folder inside `root`, bounded; empty when it is not there. */
async function namesIn(root: string, rel: string): Promise<string[]> {
  const dir = await folderIn(root, rel);
  if (dir === null) return [];
  const names = await readdir(dir).catch((): string[] => []);
  return names.sort().slice(0, SDK_FOLDER_MAX_ENTRIES);
}

/** Whether a licence record's lines name `hash`. */
const namesHash = (text: string | null, hash: string): boolean =>
  text !== null && text.split(/\r?\n/).some((line) => line.trim() === hash);

/** The Build-Tools folders holding every packaging program, by version, oldest first. */
async function probeBuildTools(root: string): Promise<{ all: string[]; pinned: SdkPart | null }> {
  const all: SdkPart[] = [];
  for (const version of await namesIn(root, "build-tools")) {
    if (!BUILD_TOOLS_VERSION.test(version)) continue;
    const dir = await folderIn(root, `build-tools/${version}`);
    if (dir === null) continue;
    const tools = await Promise.all(BUILD_TOOLS.map((tool) => fileIn(root, `build-tools/${version}/${tool}`)));
    if (tools.every((tool) => tool !== null)) all.push({ version, dir });
  }
  all.sort((a, b) => compareVersions(a.version, b.version));
  const major = String(ANDROID_PINS.buildToolsMajor);
  const pinned = all.filter((part) => BUILD_TOOLS_VERSION.exec(part.version)?.[1] === major).at(-1) ?? null;
  return { all: all.map((part) => part.version), pinned };
}

/** The NDKs whose `source.properties` names a revision, oldest first, and the pinned one. */
async function probeNdks(root: string): Promise<{ all: string[]; pinned: SdkPart | null }> {
  const all: SdkPart[] = [];
  for (const name of await namesIn(root, "ndk")) {
    const dir = await folderIn(root, `ndk/${name}`);
    const revision = NDK_REVISION.exec((await smallTextIn(root, `ndk/${name}/source.properties`)) ?? "")?.[1];
    if (dir !== null && revision !== undefined) all.push({ version: revision, dir });
  }
  all.sort((a, b) => compareVersions(a.version, b.version));
  return {
    all: all.map((part) => part.version),
    pinned: all.find((part) => part.version === ANDROID_PINS.ndk) ?? null,
  };
}

/** The SDK's `sdkmanager`, newest command-line tools first. */
async function probeSdkmanager(root: string, platform: NodeJS.Platform | string): Promise<string | null> {
  const name = platform === StudioPlatform.Windows ? "sdkmanager.bat" : "sdkmanager";
  for (const place of SDKMANAGER_PLACES) {
    const found = await fileIn(root, `${place}/${name}`);
    if (found) return found;
  }
  return null;
}

/** Whether `dir` is an SDK: it holds one of the folders every SDK has. */
async function isSdk(dir: string): Promise<boolean> {
  const present = await Promise.all(SDK_MARKERS.map((marker) => folderIn(dir, marker)));
  return present.some((found) => found !== null);
}

/** What one SDK root holds. */
async function probeSdkAt(root: string, platform: NodeJS.Platform | string): Promise<AndroidSdkFound> {
  const licence = await smallTextIn(root, `${LICENCES_FOLDER}/${AndroidLicence.Sdk}`);
  const buildTools = await probeBuildTools(root);
  const ndks = await probeNdks(root);
  return {
    root,
    licenceAccepted: namesHash(licence, ANDROID_SDK_LICENCE_SHA1),
    platformJar: await fileIn(root, `platforms/${ANDROID_PINS.platform}/android.jar`),
    platforms: (await namesIn(root, "platforms")).filter((name) => PLATFORM_NAME.test(name)),
    buildTools: buildTools.pinned,
    buildToolsVersions: buildTools.all,
    ndk: ndks.pinned,
    ndkVersions: ndks.all,
    sdkmanager: await probeSdkmanager(root, platform),
  };
}

/** Whether a real path lies in (or holds) one of the forbidden roots. */
async function touchesForbidden(real: string, forbiddenRoots: readonly string[]): Promise<boolean> {
  for (const forbidden of forbiddenRoots) {
    const resolved = await realpath(forbidden).catch(() => path.resolve(forbidden));
    if (isInside(resolved, real) || isInside(real, resolved)) return true;
  }
  return false;
}

/**
 * The person's Android SDK: the first candidate that is one, realpath'd, outside every forbidden
 * root, read from its files only (nothing in it runs). Null when there is none.
 */
export async function probeAndroidSdk(options: AndroidSdkProbeOptions): Promise<AndroidSdkFound | null> {
  for (const candidate of options.candidates) {
    const root = await realpath(candidate).catch(() => null);
    if (root === null || (await touchesForbidden(root, options.forbiddenRoots))) continue;
    if (await isSdk(root)) return probeSdkAt(root, options.platform);
  }
  return null;
}

/** A part's state: ready at the pin, another version installed, or none. */
const stateOf = (ready: boolean, others: readonly string[]): UserSideState => {
  if (ready) return UserSideState.Ready;
  return others.length > 0 ? UserSideState.OtherVersion : UserSideState.Missing;
};

/** Where each user-side component stands, for the Toolchain sheet's rows. */
export function userSideStatus(
  found: AndroidSdkFound | null,
): Record<
  typeof ToolchainId.AndroidSdk | typeof ToolchainId.AndroidBuildTools | typeof ToolchainId.AndroidNdk,
  UserSideState
> {
  return {
    [ToolchainId.AndroidSdk]: stateOf(Boolean(found?.platformJar), found?.platforms ?? []),
    [ToolchainId.AndroidBuildTools]: stateOf(Boolean(found?.buildTools), found?.buildToolsVersions ?? []),
    [ToolchainId.AndroidNdk]: stateOf(Boolean(found?.ndk), found?.ndkVersions ?? []),
  };
}

/** The `sdkmanager` packages the pins name that the SDK lacks, in install order. */
export function missingSdkPackages(found: AndroidSdkFound): string[] {
  const wanted = [
    [found.platformJar, `platforms;${ANDROID_PINS.platform}`],
    [found.buildTools, `build-tools;${ANDROID_PINS.buildToolsMajor}.0.0`],
    [found.ndk, `ndk;${ANDROID_PINS.ndk}`],
  ] as const;
  return wanted.filter(([part]) => part === null).map(([, name]) => name);
}

/** What an `sdkmanager` install runs with. */
export interface SdkInstallDeps {
  /** The core's `ProcessSandbox.run`. */
  run: (request: RunRequest) => Promise<RunResult>;
  /** The store's JDK home (`JAVA_HOME`) `sdkmanager` runs on. */
  jdkHome: string;
  /** A scratch `ANDROID_USER_HOME`: never the person's `~/.android`, which holds their keys. */
  userHome: string;
}

/**
 * Installs the pinned platform, Build-Tools and NDK the SDK lacks, in one sandboxed `sdkmanager`
 * run that writes only the SDK and reaches only Google's repository. Refused before anything runs
 * or downloads without an SDK, without the licence the person accepted, or without `sdkmanager`;
 * the licence prompt is never answered for the person (no `--licenses`, no piped `yes`).
 */
export async function installAndroidSdkComponents(
  found: AndroidSdkFound | null,
  deps: SdkInstallDeps,
): Promise<{ installed: string[] }> {
  if (found === null) throw new AndroidSdkError(AndroidSdkRefusal.SdkMissing, MESSAGE.sdkMissing);
  if (!found.licenceAccepted) throw new AndroidSdkError(AndroidSdkRefusal.LicenceNotAccepted, MESSAGE.licence);
  const packages = missingSdkPackages(found);
  if (packages.length === 0) return { installed: [] };
  if (found.sdkmanager === null) throw new AndroidSdkError(AndroidSdkRefusal.SdkmanagerMissing, MESSAGE.sdkmanager);
  const argv = [found.sdkmanager, `--sdk_root=${found.root}`, ...packages];
  const result = await deps.run({
    command: argv.map(shellQuote).join(" "),
    cwd: found.root,
    env: { JAVA_HOME: deps.jdkHome, ANDROID_USER_HOME: deps.userHome },
    timeoutMs: SDKMANAGER_TIMEOUT_MS,
    label: "android-sdkmanager",
    policy: {
      allowWrite: [found.root],
      allowRead: [found.root, deps.jdkHome],
      allowedDomains: [...ANDROID_REPOSITORY_DOMAINS],
    },
  });
  if (result.code !== 0)
    throw new AndroidSdkError(AndroidSdkRefusal.InstallFailed, MESSAGE.installFailed(result.stderr));
  return { installed: packages };
}

/** Refuses a path that is a link (a missing one is fine); returns whether something is there. */
async function refuseLink(file: string): Promise<boolean> {
  const info = await lstat(file).catch(() => null);
  if (info?.isSymbolicLink()) throw new AndroidSdkError(AndroidSdkRefusal.LinkRefused, MESSAGE.link(file));
  return info !== null;
}

/**
 * Records that the person accepted `licence` in the SDK at `root` (the sheet's control, M5.5): its
 * hash appended to `licenses/<licence>` once, keeping the hashes already there. Never written
 * through a link: a linked `licenses` folder or record is refused and left as it was.
 */
export async function recordAndroidLicence(root: string, licence: AndroidLicence): Promise<void> {
  const sdk = await realpath(root);
  const folder = path.join(sdk, LICENCES_FOLDER);
  if (!(await refuseLink(folder))) await mkdir(folder);
  const file = path.join(folder, licence);
  const exists = await refuseLink(file);
  const text = exists ? (await readRegularFile(file, SMALL_FILE_MAX_BYTES)).toString("utf8") : "";
  const hash = LICENCE_HASH[licence];
  if (namesHash(text, hash)) return;
  const kept = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  await writeFileNoFollow(file, `${kept}${hash}\n`);
}

/** What the store probes' sandbox is built from. */
export interface MobileProbeSandboxInput {
  /** The toolchain store: the only folder a probe reads beyond the system's. */
  store: string;
  scratchDir: string;
  /** The core's secret paths (credential homes, safeStorage blobs). */
  secretPaths: readonly string[];
  /** Studio's Android debug keystore folder: never readable by any probe. */
  debugKeyHome: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The sandbox every store probe of the mobile tools runs in: it writes nothing (scratch aside),
 * reads the store and denies the person's home, with the Android credential homes and Studio's
 * debug keystore as secret paths. A store that holds or sits in one of them is refused.
 */
export function mobileProbeSandboxOptions(input: MobileProbeSandboxInput): SandboxOptions {
  const credentialHomes = androidCredentialHomes(input.home, input.env);
  const secrets = [...new Set([...input.secretPaths, input.debugKeyHome, ...credentialHomes])];
  const clashes = secrets.some((secret) => isInside(secret, input.store) || isInside(input.store, secret));
  const holdsHome = isInside(input.store, input.home);
  if (clashes || holdsHome) throw new AndroidSdkError(AndroidSdkRefusal.ForbiddenRoot, MESSAGE.forbidden(input.store));
  return {
    writableRoots: [],
    scratchDir: input.scratchDir,
    secretPaths: secrets,
    readableRoots: [input.store],
    denyRead: [input.home],
  };
}

/** One probe of a store component's program. */
export interface StoreProbe {
  store: string;
  /** The component's install folder. */
  folder: string;
  /** The program, relative to `folder`. */
  bin: string;
  args: readonly string[];
  label: string;
}

/**
 * The sandboxed run of a store program: its folder and the program realpath'd inside the store (a
 * link out of it, an absolute or a `..` path is refused before anything runs), with no network
 * and no writes.
 */
export async function storeProbeRequest(probe: StoreProbe): Promise<RunRequest> {
  const outside = () => new AndroidSdkError(AndroidSdkRefusal.OutsideStore, MESSAGE.outside(probe.bin));
  const store = await realpath(probe.store).catch(() => null);
  const folder = await realpath(probe.folder).catch(() => null);
  if (store === null || folder === null || !isInside(store, folder)) throw outside();
  const program = await containedReal(folder, probe.bin).catch(() => null);
  if (program === null) throw outside();
  const info = await lstat(program).catch(() => null);
  if (!info?.isFile()) throw outside();
  return {
    command: [program, ...probe.args].map(shellQuote).join(" "),
    cwd: folder,
    timeoutMs: STORE_PROBE_TIMEOUT_MS,
    label: `store-probe-${probe.label}`,
    policy: { allowWrite: [], allowedDomains: [], allowRead: [store] },
  };
}

/** What the store's JDK probe found. */
export interface JdkProbe {
  feature: number;
  banner: string;
}

/**
 * Probes the store's JDK (`bin/java -version`) in its sandbox and checks it is Temurin's pinned
 * feature release ({@link JDK_PIN}).
 */
export async function probeStoreJdk(input: {
  store: string;
  folder: string;
  run: (request: RunRequest) => Promise<RunResult>;
  platform?: NodeJS.Platform | string;
}): Promise<JdkProbe> {
  const bin = input.platform === StudioPlatform.Windows ? "bin/java.exe" : "bin/java";
  const request = await storeProbeRequest({
    store: input.store,
    folder: input.folder,
    bin,
    args: ["-version"],
    label: ToolchainId.Jdk,
  });
  const result = await input.run(request);
  if (result.code !== 0) throw new AndroidSdkError(AndroidSdkRefusal.JdkProbeFailed, MESSAGE.jdkFailed);
  const banner = `${result.stderr}\n${result.stdout}`;
  const feature = Number(JAVA_VERSION.exec(banner)?.[1] ?? Number.NaN);
  if (feature !== JDK_PIN.feature || !TEMURIN.test(banner))
    throw new AndroidSdkError(AndroidSdkRefusal.JdkWrongVersion, MESSAGE.jdkVersion(banner));
  return { feature, banner: banner.trim() };
}

/** The UTC instant Play's floor rises in `year`. */
const floorRiseAt = (year: number): number => Date.UTC(year, PLAY_FLOOR.month, PLAY_FLOOR.day);

/** Play's target-API floor in force at `at`. */
function playFloorAt(at: number): number {
  const year = new Date(at).getUTCFullYear();
  const risen = at >= floorRiseAt(year) ? year : year - 1;
  return risen - PLAY_FLOOR.apiOffset;
}

/** What the quarterly lane's rule says about a target SDK. */
export interface PlayTargetCheck {
  state: PlayTargetState;
  /** The floor in force. */
  required: number;
  /** The next rise: its floor and the day it takes effect (`YYYY-MM-DD`). */
  next: { required: number; from: string };
}

/**
 * The rule for Play's yearly target-API bump, at an injected `now` (meant for a quarterly scheduled
 * check; no workflow runs it yet, since a schedule is billed CI the owner adds): `behind`
 * below the floor in force, `due-soon` within a quarter of a rise the target does not meet, else
 * `ok`. The target defaults to the shipped pin.
 */
export function playTargetApiCheck(now: Date, targetSdk: number = ANDROID_PINS.targetSdk): PlayTargetCheck {
  const at = now.getTime();
  const required = playFloorAt(at);
  const year = now.getUTCFullYear();
  const nextYear = at >= floorRiseAt(year) ? year + 1 : year;
  const nextAt = floorRiseAt(nextYear);
  const next = { required: nextYear - PLAY_FLOOR.apiOffset, from: new Date(nextAt).toISOString().slice(0, 10) };
  if (targetSdk < required) return { state: PlayTargetState.Behind, required, next };
  const due = targetSdk < next.required && nextAt - at <= PLAY_DUE_WINDOW_MS;
  return { state: due ? PlayTargetState.DueSoon : PlayTargetState.Ok, required, next };
}
