/**
 * The toolchains: their status for the create dialog, the Toolchain sheet and Settings →
 * Toolchains, the install the person starts from the sheet (native: a download), cancel, prune,
 * the Command Line Tools install (native: Apple's dialog), and the phones' install and the
 * Android SDK licence the person accepts (native). Every other handler delegates to
 * `core.toolchains`; an install request names one to four distinct destinations or none. The status
 * carries each stack's setup beside the C++ store's when the registrar is given its source
 * (`core/stack-setup-status.ts`): Xcode, the Rust lock and the harness parts a Rust night refuses,
 * and, given a {@link MobileToolchainSource}, the person's Android SDK and its licence (never a path).
 *
 * The licence is recorded only by the sheet's own control, which a person presses: no harness
 * method reaches these channels, and a fixture profile refuses them (`native-policy.ts`). An
 * Android install is refused, typed, before anything installs or downloads until that licence is
 * in the person's SDK.
 */
import os from "node:os";
import { BUILD_TARGETS, BuildTarget, isBuildTarget } from "../../shared/game-project.ts";
import {
  type AndroidLicence,
  type AndroidSetupStatus,
  isMobileBuildTarget,
  type MobileBuildTarget,
  parseAndroidLicence,
  ToolchainError,
  type ToolchainInstallJob,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import {
  type AndroidSdkFound,
  AndroidSdkError,
  AndroidSdkRefusal,
  androidCredentialHomes,
  androidSdkCandidates,
  probeAndroidSdk,
  recordAndroidLicence,
  userSideStatus,
} from "../../substrate/toolchain-store/android-sdk.ts";
import type { XcodeExec } from "../../substrate/toolchain-store/locate.ts";
import { probeXcodeSdks, type XcodeProbe } from "../../substrate/toolchain-store/xcode-probe.ts";
import { type StackSetupSource, stackSetupStatus } from "../core/stack-setup-status.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a toolchain request from the renderer is refused, before any work. */
const MESSAGE = {
  badInstall: "Toolchain install refused: name one to four different destinations, or none.",
  badMobile: "Phone tools install refused: name iOS or Android.",
  mobileNotYet: "This build of Genex does not install the phones' tools yet.",
  licenceNotYet: "Accepting the Android SDK licence is not available in this build yet.",
  sdkMissing: "No Android SDK was found. Install Android Studio or its command-line tools first.",
  licence: "Accept the Android SDK licence in the Toolchain sheet first; nothing was installed.",
  mobileNotHosted:
    "Genex hasn't published the phones' Rust libraries, bundletool and Java runtime for this build yet; nothing was downloaded.",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` is one to four distinct known destinations. */
function isTargetList(value: unknown): value is BuildTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > BUILD_TARGETS.length) return false;
  return value.every(isBuildTarget) && new Set(value).size === value.length;
}

/** The destinations an install request names: undefined for the default, else a checked copy. Throws on anything else. */
export function installTargets(payload: unknown): BuildTarget[] | undefined {
  if (payload === undefined) return undefined;
  if (!isRecord(payload)) throw new Error(MESSAGE.badInstall);
  const targets = Object.hasOwn(payload, "targets") ? payload.targets : undefined;
  if (targets === undefined) return undefined;
  if (!isTargetList(targets)) throw new Error(MESSAGE.badInstall);
  return [...targets];
}

/** The phone a `studio:toolchain.installMobile` payload names; throws for anything else. */
export function mobileInstallTarget(payload: unknown): MobileBuildTarget {
  const target = isRecord(payload) && Object.hasOwn(payload, "target") ? payload.target : undefined;
  if (!isMobileBuildTarget(target)) throw new Error(MESSAGE.badMobile);
  return target;
}

/**
 * Where the phones' setup comes from: the person's Android SDK (probed from its files), the licence
 * record the sheet's control writes in it, and the store's install of a phone's parts.
 */
export interface MobileToolchainSource {
  /** The Xcode iPhone builds use: its version, newest iOS SDK and status (`probeXcodeSdks`). */
  xcode(): Promise<XcodeSdkStatus>;
  /** The person's Android SDK, or null when there is none where they keep one. */
  androidSdk(): Promise<AndroidSdkFound | null>;
  /** Records that the person accepted `licence` in the SDK at `root` (`recordAndroidLicence`). */
  recordLicence(root: string, licence: AndroidLicence): Promise<void>;
  /** Installs what `target`'s builds need; for Android, `sdk` is the SDK whose licence the person accepted. */
  install(target: MobileBuildTarget, sdk: AndroidSdkFound | null): Promise<ToolchainInstallJob>;
}

/** The Android SDK an action works in: refused `sdk-missing` when there is none. */
async function foundSdk(source: MobileToolchainSource): Promise<AndroidSdkFound> {
  const sdk = await source.androidSdk();
  if (sdk === null) throw new AndroidSdkError(AndroidSdkRefusal.SdkMissing, MESSAGE.sdkMissing);
  return sdk;
}

/**
 * `studio:toolchain.installMobile`: an Android install is refused `sdk-missing` without an SDK and
 * `licence-not-accepted` until the person accepted its licence, before anything installs or
 * downloads; the iPhone's install never waits on Android's licence.
 */
export async function installMobileFor(
  source: MobileToolchainSource,
  target: MobileBuildTarget,
): Promise<ToolchainInstallJob> {
  if (target === BuildTarget.Ios) return source.install(target, null);
  const sdk = await foundSdk(source);
  if (!sdk.licenceAccepted) throw new AndroidSdkError(AndroidSdkRefusal.LicenceNotAccepted, MESSAGE.licence);
  return source.install(target, sdk);
}

/** `studio:toolchain.acceptAndroidLicence`: records the licence the person accepted in their own SDK. */
export async function acceptAndroidLicenceFor(
  source: MobileToolchainSource,
  licence: AndroidLicence,
): Promise<boolean> {
  const sdk = await foundSdk(source);
  await source.recordLicence(sdk.root, licence);
  return true;
}

/** The status's view of the person's Android SDK: whether there is one, its licence and its parts, never a path. */
async function androidSetupOf(source: MobileToolchainSource): Promise<AndroidSetupStatus> {
  const found = await source.androidSdk();
  return { sdk: found !== null, licenceAccepted: found?.licenceAccepted === true, parts: userSideStatus(found) };
}

/** What the host's mobile source reads: the environment, the home folder, the platform and `xcode-select`. */
export interface HostMobileToolchainOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Runs `xcode-select -p` for the Xcode probe. */
  exec: XcodeExec;
  home?: string;
  platform: NodeJS.Platform | string;
  /** Studio's protected paths (`StudioCore.protectedPaths`): no SDK is taken from in or around one. */
  protectedPaths: readonly string[];
}

/**
 * The host's mobile source: the person's SDK where `ANDROID_HOME`, `ANDROID_SDK_ROOT` or Android
 * Studio keep it, never one inside a credential home (`~/.android`); the licence recorded the way
 * `sdkmanager` records it. The store's install refuses `not-hosted`: Genex has published no pinned
 * download of the phones' Rust libraries, bundletool or the JDK yet, so nothing is fetched.
 */
export function hostMobileToolchain(options: HostMobileToolchainOptions): MobileToolchainSource {
  const home = options.home ?? os.homedir();
  return {
    xcode: () => probeXcodeSdks({ exec: options.exec, platform: options.platform }),
    androidSdk: () =>
      probeAndroidSdk({
        candidates: androidSdkCandidates(options.env, home, options.platform),
        forbiddenRoots: [...androidCredentialHomes(home, options.env), ...options.protectedPaths],
        platform: options.platform,
      }),
    recordLicence: recordAndroidLicence,
    install: async () => {
      throw new ToolchainError(ToolchainProblem.NotHosted, MESSAGE.mobileNotHosted);
    },
  };
}

/**
 * Registers the seven `studio:toolchain.*` channels; `stackSetup` adds each stack's setup to the
 * status, and `mobile` the person's Android SDK and the phones' install and licence handlers.
 * Without `mobile` those two refuse before anything is read or written: `main/index.ts` passes
 * {@link hostMobileToolchain} outside fixture and smoke profiles.
 */
export function registerToolchainIpc(
  handle: IpcHandle,
  core: Pick<StudioCore, "toolchains" | "games">,
  stackSetup?: StackSetupSource,
  mobile?: MobileToolchainSource,
): void {
  // The sheet's download and disk sizes (`ToolchainService.plan`) ride along with the status.
  handle("studio:toolchain.status", async () => ({
    ...(await core.toolchains.status()),
    ...(await core.toolchains.plan()),
    ...(stackSetup ? await stackSetupStatus(stackSetup) : {}),
    ...(mobile ? await mobileStatusFields(mobile) : {}),
  }));
  handle("studio:toolchain.install", (payload) => core.toolchains.install(installTargets(payload)));
  handle("studio:toolchain.cancel", () => core.toolchains.cancel());
  // The locks the library's games last built with, from the host's own record, never a game's studio.json.
  handle("studio:toolchain.prune", async () => core.toolchains.prune(await core.games.nativeLocks()));
  handle("studio:toolchain.installClt", () => core.toolchains.installClt());
  handle("studio:toolchain.installMobile", (payload) => {
    const target = mobileInstallTarget(payload);
    if (!mobile) throw new ToolchainError(ToolchainProblem.NotHosted, MESSAGE.mobileNotYet);
    return installMobileFor(mobile, target);
  });
  handle("studio:toolchain.acceptAndroidLicence", (payload) => {
    const licence = parseAndroidLicence(payload);
    if (!mobile) throw new Error(MESSAGE.licenceNotYet);
    return acceptAndroidLicenceFor(mobile, licence);
  });
}

/** Xcode's fields as the status carries them: never the SDKs' folders. */
type XcodeSdkStatus = Pick<XcodeProbe, "present" | "version" | "iosSdk" | "status">;

/**
 * The status's phone fields: Xcode with its iOS SDK and status (over the stack setup's plain
 * probe) and the person's Android SDK; a probe that fails leaves its field out, never failing the status.
 */
async function mobileStatusFields(
  mobile: MobileToolchainSource,
): Promise<{ android?: AndroidSetupStatus; xcode?: XcodeSdkStatus }> {
  const [android, found] = await Promise.all([
    androidSetupOf(mobile).catch(() => null),
    mobile.xcode().catch(() => null),
  ]);
  const xcode = found
    ? { present: found.present, version: found.version, iosSdk: found.iosSdk, status: found.status }
    : null;
  return { ...(android ? { android } : {}), ...(xcode ? { xcode } : {}) };
}
