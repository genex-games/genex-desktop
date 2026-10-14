/**
 * A Rust · wgpu game's iPhone package (M5.1): the lane's admitted iOS build assembled into a flat
 * `<Title>.app` (the executable `game`, the assets beside it, where the facade looks for them) with
 * host-written files only around it: `Info.plist` from a fixed table (identity, orientations, the
 * launch screen, `MinimumOSVersion` 16.0, the Xcode and SDK it was built with), `PkgInfo`, the
 * privacy manifest (`PrivacyInfo.xcprivacy`: no tracking, the required-reason APIs Rust's runtime
 * calls), generated app icons, and the licence notices under `notices/`.
 *
 * - **Two artifacts.** A Simulator `.app` signed ad hoc (the harness may ask for one), or an
 *   `.ipa` (`Payload/<Title>.app` zipped) signed with the person's own Apple Development or
 *   Distribution identity and provisioning profile; only a person signs one.
 * - **The Xcode gate** runs before anything is read: a device or distribution build needs Xcode 26
 *   with the iOS 26 SDK ({@link iosXcodeRefusal}); a Simulator build any Xcode with a Simulator SDK.
 * - **Admission.** The executable is read once (no link, one name), admitted by the Rust iOS
 *   policy (`admitRustMachO`) for the artifact's own platform (Simulator or device), and held to
 *   the lane's admitted digest; the asset listing must be exactly the admitted set.
 * - **Verification.** After staging, every file of the app is re-read and held to the digest it
 *   was admitted or written with (nothing missing, nothing added); `fileWithSecret` scans what the
 *   game made before anything is signed or compressed; the signer may change the signature only
 *   (`signIosApp`); and each IPA entry is the signed app's file, byte for byte.
 * - **Entitlements.** A Simulator app's are empty. An IPA's are the identity entitlements the
 *   profile grants for this bundle id (`application-identifier`, the team, and `get-task-allow`
 *   for a development signing only): no capability is ever asked for.
 *
 * `codesign` runs in a sandbox of its own over the host-staged copy (`mobile-sign.ts`); the IPA is
 * written by the host's deterministic zip writer, so no packaging program needs to run. Nothing
 * here installs or launches anything on a Simulator or a device (containment stage 1). The app is
 * staged in the host's own folder and swapped into place with the web export's helpers, with the
 * export marker (the build receipt: artifact, bundle id, signing, minimum iOS, Xcode and SDK) and a
 * README beside it.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { errorMessage } from "../shared/errors.ts";
import {
  ARTIFACT_SIGNINGS,
  ExportError,
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
  MobileArtifact,
} from "../shared/game-export-contract.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { IOS_MINIMUM_OS_VERSION, NativeError } from "../shared/native-contract.ts";
import { realpathNearest } from "./fsx.ts";
import {
  EXPORT_MANIFEST,
  fileWithSecret,
  makeStaging,
  resolveExportTarget,
  secretFoundError,
  swapIntoPlace,
} from "./game-export.ts";
import {
  MobileSignError,
  MobileSignProblem,
  type MobileSignSandbox,
  type MobileSignTool,
  codesignIosPlan,
  readBundleFiles,
  signIosApp,
} from "./mobile-sign.ts";
import {
  type AdmittedOutputFile,
  ApplePlatformCode,
  type AssetListing,
  admitRustMachO,
  CODESIGN_PATH,
  copyListedAssets,
  isBundleId,
  listAdmittedAssets,
  type PlistEntry,
  plistDocument,
  plistString,
  plistText,
  readAssetFile,
  readHostFile,
  RunDirLayout,
} from "./native-bundle.ts";
import { type ArchiveItem, ArchiveItemKind, writeZip } from "./native-export-archive.ts";
import { appNameOf, type MacNotice, type NoticeFile, noticesIndex, readNotices } from "./native-export.ts";
import { isBelow } from "./paths.ts";
import { deviceBuildRefusal, simulatorBuildRefusal, type XcodeSdks } from "./toolchain-store/xcode-probe.ts";
import { SigningRequester } from "./windows-sign.ts";

/** How an iPhone game may be held. Wire values (a game's export options): never rename one. */
export const IosOrientation = {
  Portrait: "portrait",
  PortraitUpsideDown: "portrait-upside-down",
  LandscapeLeft: "landscape-left",
  LandscapeRight: "landscape-right",
} as const;
export type IosOrientation = (typeof IosOrientation)[keyof typeof IosOrientation];

/** Each orientation as `UISupportedInterfaceOrientations` names it: the only values the plist takes. */
const ORIENTATION_KEY = {
  [IosOrientation.Portrait]: "UIInterfaceOrientationPortrait",
  [IosOrientation.PortraitUpsideDown]: "UIInterfaceOrientationPortraitUpsideDown",
  [IosOrientation.LandscapeLeft]: "UIInterfaceOrientationLandscapeLeft",
  [IosOrientation.LandscapeRight]: "UIInterfaceOrientationLandscapeRight",
} as const satisfies Record<IosOrientation, string>;

/** The orientations a game is held in when it names none: landscape, either way up. */
export const IOS_DEFAULT_ORIENTATIONS: readonly IosOrientation[] = Object.freeze([
  IosOrientation.LandscapeLeft,
  IosOrientation.LandscapeRight,
]);

/** Why an iPhone package was refused, beside the export's code (`ExportError.refusal`). Never rename a value. */
export const IosPackageRefusal = {
  /** An orientation outside {@link IosOrientation}, none, or one twice. */
  Orientation: "orientation",
  /** A bundle id Studio did not choose. */
  Identity: "identity",
  /** The executable is the other platform's (a device build for the Simulator, or the reverse). */
  PlatformMismatch: "platform-mismatch",
  /** A packaged file is not the one admitted or written: changed, missing or added. */
  EntryChanged: "entry-changed",
  /** The provisioning profile is unreadable, or grants no identity for this bundle id. */
  ProvisioningProfile: "provisioning-profile",
} as const;
export type IosPackageRefusal = (typeof IosPackageRefusal)[keyof typeof IosPackageRefusal];

/**
 * The required-reason API categories the privacy manifest declares, each with Apple's reason
 * code: Rust's `std` reads file metadata (`stat`, `fstat`: timestamps of the app's own files) and
 * `Instant` reads `mach_absolute_time` (elapsed time between frames).
 */
export const IOS_PRIVACY_CATEGORIES = {
  NSPrivacyAccessedAPICategoryFileTimestamp: "C617.1",
  NSPrivacyAccessedAPICategorySystemBootTime: "35F9.1",
} as const;

/** The app's icons, as `CFBundleIconFiles` names them (`<base>@<scale>x[~ipad].png`), and their pixel size. */
const IOS_ICONS = [
  { file: "AppIcon60x60@2x.png", pixels: 120 },
  { file: "AppIcon60x60@3x.png", pixels: 180 },
  { file: "AppIcon76x76@2x~ipad.png", pixels: 152 },
  { file: "AppIcon83.5x83.5@2x~ipad.png", pixels: 167 },
] as const;
const IPHONE_ICON_FILES = ["AppIcon60x60"] as const;
const IPAD_ICON_FILES = ["AppIcon60x60", "AppIcon76x76", "AppIcon83.5x83.5"] as const;
/** The icon's colours (RGB): Genex's ink and the lighter square in its middle. */
const ICON_BACKGROUND = [0x1f, 0x2a, 0x44] as const;
const ICON_MARK = [0x7d, 0xd3, 0xc0] as const;

/** Each artifact's platform: the Mach-O platform its executable names, `CFBundleSupportedPlatforms` and the SDK. */
const ARTIFACT_PLATFORM = {
  [MobileArtifact.SimulatorApp]: {
    macho: ApplePlatformCode.IosSimulator,
    bundle: "iPhoneSimulator",
    sdk: "iphonesimulator",
  },
  [MobileArtifact.Ipa]: { macho: ApplePlatformCode.Ios, bundle: "iPhoneOS", sdk: "iphoneos" },
} as const;

/** The iPhone artifacts this module makes. */
export type IosArtifact = keyof typeof ARTIFACT_PLATFORM;

const APP_SUFFIX = ".app";
const IPA_SUFFIX = ".ipa";
const PAYLOAD = "Payload";
const ASSETS_FOLDER = "assets";
const NOTICES_FOLDER = "notices";
const NOTICES_INDEX = "NOTICES.txt";
const THIRD_PARTY = "third_party";
const INFO_PLIST = "Info.plist";
const PKG_INFO = "PkgInfo";
const PRIVACY_MANIFEST = "PrivacyInfo.xcprivacy";
const ENTITLEMENTS = "entitlements.plist";
const README = "README.txt";
const PKG_INFO_TEXT = "APPL????";
const SHORT_VERSION = "1.0";
/** The largest executable read whole. */
const EXECUTABLE_MAX_BYTES = 512 * 1024 * 1024;
/** The largest provisioning profile read (`mobile-sign.ts` refuses a larger one before this). */
const PROFILE_MAX_BYTES = 1024 * 1024;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
/** A team id, as Apple writes it: ten upper-case letters and digits. */
const TEAM_ID = /^[A-Z0-9]{10}$/;
/** The provisioning profile's plist, which its CMS envelope carries as plain text. */
const PROFILE_PLIST = /<\?xml[\s\S]*?<\/plist>/;

const MESSAGE = {
  orientation:
    "The game's orientations must be one or more of portrait, portrait-upside-down, landscape-left and landscape-right, each once.",
  identity: (id: string) => `${JSON.stringify(id)} is not a bundle id Genex chose for a game`,
  xcode: (refusal: string) =>
    `This Mac's Xcode cannot make that iPhone build (${refusal}): a device or App Store build needs Xcode 26 or later with the iOS 26 SDK.`,
  artifact: (artifact: string, signing: string) => `A ${artifact} is not signed with ${signing}.`,
  harness: "Only you can sign an iPhone app with your own identity; the agent makes Simulator apps only.",
  notAdmitted: (detail: string) => `The iPhone build did not pass Genex's checks, so no app was made: ${detail}`,
  platform: (artifact: string) => `The iPhone build is not the ${artifact}'s platform, so no app was made.`,
  changed: (file: string) => `${file} is not the file Genex admitted or wrote; build again, then export.`,
  profile: "The provisioning profile does not grant an app identity for this game's bundle id.",
  signing: (detail: string) => `The iPhone app could not be signed: ${detail}`,
  outsideExports: (target: string) => `Export destination must be inside the studio's exports folder: ${target}`,
  readmeSimulator: (app: string) =>
    [
      `${app} is an iPhone game built for the iOS Simulator (iOS 16 or later), signed ad hoc.`,
      "",
      `To try it, start a Simulator from Xcode and drag ${app} onto it. It does not run on a real iPhone:`,
      "for that, export it again signed with your own Apple Development identity.",
      "",
      `The licences of the software it includes are in ${app}/notices.`,
      "",
    ].join("\n"),
  readmeIpa: (ipa: string, app: string) =>
    [
      `${ipa} is an iPhone game for iOS 16 or later, signed with your own Apple identity.`,
      "",
      "Install it on a device your provisioning profile names (Xcode's Devices window, or Apple",
      "Configurator), or upload a distribution build with Transporter.",
      "",
      `The licences of the software it includes are in Payload/${app}/notices inside the IPA.`,
      "",
    ].join("\n"),
} as const;

/** The sandboxed `codesign` the package is signed with, and the folders a profile may not come from. */
export interface IosSigner {
  sandbox: MobileSignSandbox;
  /** `codesign` by its absolute path (default `/usr/bin/codesign`). */
  tool?: MobileSignTool;
  /** Folders a provisioning profile may never come from: the games root, Genex's own data. */
  forbiddenRoots: readonly string[];
  /** The person's home. */
  home: string;
}

/** Everything one iPhone package is made from. */
export interface IosPackageRequest {
  artifact: IosArtifact;
  /** The lane's admitted `out/` for the artifact's platform: `game` and `assets/`. */
  out: string;
  /** The lane's admitted digests of every file of `out/` (the Rust receipt's `outputs`). */
  outputs: readonly AdmittedOutputFile[];
  /** The licences `notices/` carries (`rust-notices.ts`, the iOS row). */
  notices: readonly MacNotice[];
  /** The game's once-chosen bundle id. */
  bundleId: string;
  /** The game's title: the app's name and `CFBundleDisplayName`. */
  title: string;
  /** The name the app takes when the title leaves nothing. */
  fallbackName: string;
  orientations: readonly IosOrientation[];
  /** Checked by `parseExportSigning`; ad hoc makes a Simulator app, an identity an IPA. */
  signing: ExportSigningChoice;
  requestedBy: SigningRequester;
  /** What the Xcode probe found (`probeXcodeSdks`). */
  xcode: XcodeSdks;
  /** The game folder: the target may never hold it or sit inside it. */
  source: string;
  /** The export folder: empty, or an earlier Genex export. */
  target: string;
  /** The target must resolve below it (`layout.exports`). */
  exportsRoot: string;
  /** The host-only folder the app is staged and signed in (`layout.exportStaging`). */
  stagingRoot: string;
  /** Values no exported file may hold (`StudioCore.knownSecretValues`). */
  secretValues: readonly string[];
  signer: IosSigner;
  now?: () => number;
  /** Runs on the staged app before it is verified; a test's way to change it as a racing process would. */
  afterStage?: (app: string) => Promise<void>;
  /**
   * Runs on a signed Simulator app while it is still in the host's own staging, before the swap
   * into the exports folder: the core admits it for the person's device launch. A throw fails the
   * export and leaves the target as it was.
   */
  admitStaged?: (app: string) => Promise<void>;
}

/** The build receipt the export marker carries. */
export interface IosReceipt {
  artifact: IosArtifact;
  bundleId: string;
  signed: ExportSigning;
  minimumOS: string;
  xcode: { version: string | null; sdk: string };
}

/** What an iPhone package wrote. */
export interface IosPackageResult {
  dir: string;
  /** The `.app` (Simulator) or the `.ipa`, inside `dir`. */
  artifact: string;
  files: number;
  /** The app's files, `/`-separated from `dir` (inside the IPA: from its root), sorted. */
  included: string[];
  receipt: IosReceipt;
}

/** What the Info.plist is written from. */
export interface IosPlistInput {
  bundleId: string;
  title: string;
  /** The app's name (`CFBundleName`). */
  name: string;
  orientations: readonly IosOrientation[];
  artifact: IosArtifact;
  xcode: XcodeSdks;
  /** The clock, for `CFBundleVersion`. */
  now: number;
}

const refuse = (code: ExportRefusal, message: string, refusal: string | null = null, file: string | null = null) =>
  new ExportError(code, message, { refusal, file });

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const isOrientation = (value: unknown): value is IosOrientation =>
  typeof value === "string" && Object.hasOwn(ORIENTATION_KEY, value);

/** The orientations a game asked for, checked against the table: one or more, each once, in order. */
export function iosOrientationsOf(value: unknown): IosOrientation[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  const unique = new Set(list);
  const valid = list.length > 0 && unique.size === list.length && list.every(isOrientation);
  if (!valid) throw refuse(ExportRefusal.ArchiveRefused, MESSAGE.orientation, IosPackageRefusal.Orientation);
  return list.filter(isOrientation);
}

/** Why `artifact` cannot be built with `xcode`, or null: an IPA needs Xcode 26 and the iOS 26 SDK. */
export function iosXcodeRefusal(artifact: IosArtifact, xcode: XcodeSdks): string | null {
  return artifact === MobileArtifact.Ipa ? deviceBuildRefusal(xcode) : simulatorBuildRefusal(xcode);
}

/** The SDK an artifact is built against, as `xcrun --sdk` and `DTSDKName` name it. */
function sdkOf(artifact: IosArtifact, xcode: XcodeSdks): { name: string; version: string | null } {
  const version = artifact === MobileArtifact.Ipa ? xcode.iosSdk : xcode.simulatorSdk;
  return { name: `${ARTIFACT_PLATFORM[artifact].sdk}${version ?? ""}`, version };
}

/** Xcode's version as `DTXcode` writes it (26.6 is `2660`), or null when it is not a version. */
function dtXcode(version: string | null): string | null {
  const match = /^(\d{1,3})(?:\.(\d))?(?:\.(\d))?$/.exec(version ?? "");
  if (!match) return null;
  const [, major = "0", minor = "0", patch = "0"] = match;
  return `${major}${minor}${patch}`.padStart(4, "0");
}

/** The build number from the clock: `<year>.<month><day>.<hour><minute>` in UTC, three integers. */
function bundleVersion(now: number): string {
  const at = new Date(now);
  const day = (at.getUTCMonth() + 1) * 100 + at.getUTCDate();
  const minute = at.getUTCHours() * 100 + at.getUTCMinutes();
  return `${at.getUTCFullYear()}.${day}.${minute}`;
}

const stringArray = (values: readonly string[]) => `<array>${values.map(plistString).join("")}</array>`;
const iconsDict = (files: readonly string[]) =>
  `<dict><key>CFBundlePrimaryIcon</key><dict><key>CFBundleIconFiles</key>${stringArray(files)}</dict></dict>`;

/** The `DT*` entries naming the platform, its SDK and Xcode; one Xcode could not name is left out. */
function toolEntries(artifact: IosArtifact, xcode: XcodeSdks): PlistEntry[] {
  const sdk = sdkOf(artifact, xcode);
  const xcodeNumber = dtXcode(xcode.version);
  const entries: PlistEntry[] = [["DTPlatformName", plistString(ARTIFACT_PLATFORM[artifact].sdk)]];
  if (sdk.version !== null) entries.push(["DTPlatformVersion", plistString(sdk.version)]);
  entries.push(["DTSDKName", plistString(sdk.name)]);
  if (xcodeNumber !== null) entries.push(["DTXcode", plistString(xcodeNumber)]);
  return entries;
}

/**
 * The app's `Info.plist`: its fixed table of keys in order, every value host text (the title
 * escaped by `plistText`, the orientations from {@link ORIENTATION_KEY}), nothing from the build.
 * Refuses a bundle id Studio did not choose and an orientation outside the table.
 */
export function iosInfoPlist(input: IosPlistInput): string {
  if (!isBundleId(input.bundleId)) {
    throw refuse(ExportRefusal.ArchiveRefused, MESSAGE.identity(input.bundleId), IosPackageRefusal.Identity);
  }
  const orientations = stringArray(iosOrientationsOf(input.orientations).map((o) => ORIENTATION_KEY[o]));
  return plistDocument([
    ["CFBundleDevelopmentRegion", plistString("en")],
    ["CFBundleDisplayName", plistString(input.title || input.name)],
    ["CFBundleExecutable", plistString(RunDirLayout.Executable)],
    ["CFBundleIcons", iconsDict(IPHONE_ICON_FILES)],
    ["CFBundleIcons~ipad", iconsDict(IPAD_ICON_FILES)],
    ["CFBundleIdentifier", plistString(input.bundleId)],
    ["CFBundleInfoDictionaryVersion", plistString("6.0")],
    ["CFBundleName", plistString(plistText(input.name) ? input.name : "Game")],
    ["CFBundlePackageType", plistString("APPL")],
    ["CFBundleShortVersionString", plistString(SHORT_VERSION)],
    ["CFBundleSupportedPlatforms", stringArray([ARTIFACT_PLATFORM[input.artifact].bundle])],
    ["CFBundleVersion", plistString(bundleVersion(input.now))],
    ...toolEntries(input.artifact, input.xcode),
    ["LSRequiresIPhoneOS", "<true/>"],
    ["MinimumOSVersion", plistString(IOS_MINIMUM_OS_VERSION)],
    ["UIDeviceFamily", "<array><integer>1</integer><integer>2</integer></array>"],
    ["UILaunchScreen", "<dict/>"],
    ["UIRequiredDeviceCapabilities", stringArray(["arm64", "metal"])],
    ["UIRequiresFullScreen", "<true/>"],
    ["UIStatusBarHidden", "<true/>"],
    ["UISupportedInterfaceOrientations", orientations],
    ["UISupportedInterfaceOrientations~ipad", orientations],
  ]);
}

/** The privacy manifest: no tracking, no data collected, and {@link IOS_PRIVACY_CATEGORIES}. */
export function iosPrivacyManifest(): string {
  const accessed = Object.entries(IOS_PRIVACY_CATEGORIES).map(
    ([category, reason]) =>
      `<dict><key>NSPrivacyAccessedAPIType</key>${plistString(category)}<key>NSPrivacyAccessedAPITypeReasons</key>${stringArray([reason])}</dict>`,
  );
  return plistDocument([
    ["NSPrivacyAccessedAPITypes", `<array>${accessed.join("")}</array>`],
    ["NSPrivacyCollectedDataTypes", "<array/>"],
    ["NSPrivacyTracking", "<false/>"],
    ["NSPrivacyTrackingDomains", "<array/>"],
  ]);
}

/** One PNG chunk: length, type, data and its CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A square RGB PNG of `pixels`: the background with a lighter square in its middle third. */
export function iosIconPng(pixels: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels, 0);
  header.writeUInt32BE(pixels, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const [low, high] = [Math.floor(pixels / 3), Math.ceil((pixels * 2) / 3)];
  const raw = Buffer.alloc((pixels * 3 + 1) * pixels);
  for (let y = 0; y < pixels; y += 1) {
    const row = y * (pixels * 3 + 1);
    for (let x = 0; x < pixels; x += 1) {
      const inside = x >= low && x < high && y >= low && y < high;
      raw.set(inside ? ICON_MARK : ICON_BACKGROUND, row + 1 + x * 3);
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))];
  return Buffer.concat([signature, ...chunks]);
}

/** An entitlements document holding `entries`, or an empty one. */
function entitlementsPlist(entries: readonly PlistEntry[] = []): string {
  return plistDocument(entries);
}

// ---------- checks before anything is read ----------

/** Refuses a signing that does not make the artifact, the harness an identity, and an Xcode that cannot build it. */
function assertCanPackage(request: IosPackageRequest): void {
  const signings: readonly ExportSigning[] = ARTIFACT_SIGNINGS[request.artifact];
  if (!signings.includes(request.signing.kind)) {
    throw refuse(ExportRefusal.SigningInvalid, MESSAGE.artifact(request.artifact, request.signing.kind));
  }
  if (request.artifact === MobileArtifact.Ipa && request.requestedBy !== SigningRequester.Person) {
    throw refuse(ExportRefusal.HarnessMayNotSign, MESSAGE.harness, MobileSignProblem.HarnessMayNotSign);
  }
  const xcode = iosXcodeRefusal(request.artifact, request.xcode);
  if (xcode !== null) throw refuse(ExportRefusal.ToolchainUnusable, MESSAGE.xcode(xcode), xcode);
}

/** Refuses a target that does not resolve below the exports root. */
async function assertInsideExports(exportsRoot: string, target: string): Promise<void> {
  const lexical = isBelow(path.resolve(exportsRoot), path.resolve(target));
  const root = await realpathNearest(exportsRoot);
  const real = await realpathNearest(target).catch(() => null);
  if (!lexical || !real || !isBelow(root, real)) throw new Error(MESSAGE.outsideExports(target));
}

// ---------- the admitted build ----------

/** The admitted parts an app is made from, read once, with every packaged file's expected digest. */
interface AdmittedParts {
  exe: Buffer;
  assets: AssetListing | null;
  /** The admitted digest of `game` and each `assets/…` file, by its path in the app. */
  digests: Map<string, string>;
}

const changed = (file: string) =>
  refuse(ExportRefusal.BuildChanged, MESSAGE.changed(file), IosPackageRefusal.EntryChanged, file);

/** The executable's bytes, admitted for the artifact's platform and held to the lane's digest. */
async function admittedExecutable(
  request: IosPackageRequest,
  out: string,
  digests: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const exe = await readAssetFile(path.join(out, RunDirLayout.Executable), EXECUTABLE_MAX_BYTES);
  const admission = admitRustMachO(exe, BuildTarget.Ios);
  if (!admission.ok) {
    throw refuse(ExportRefusal.AdmissionRefused, MESSAGE.notAdmitted(admission.detail), admission.refusal);
  }
  if (admission.version.platform !== ARTIFACT_PLATFORM[request.artifact].macho) {
    const message = MESSAGE.platform(request.artifact);
    throw refuse(ExportRefusal.AdmissionRefused, message, IosPackageRefusal.PlatformMismatch, RunDirLayout.Executable);
  }
  if (digests.get(RunDirLayout.Executable) !== sha256(exe)) throw changed(RunDirLayout.Executable);
  return exe;
}

/** The `out/assets` listing, refused unless it is exactly the admitted set of `assets/…` files. */
async function admittedAssets(out: string, digests: ReadonlyMap<string, string>): Promise<AssetListing | null> {
  const folder = path.join(out, ASSETS_FOLDER);
  const listing = await listAdmittedAssets((await readdir(out)).includes(ASSETS_FOLDER) ? folder : null);
  const listed = (listing?.files ?? []).map((file) => [ASSETS_FOLDER, ...file.rel.split(path.sep)].join("/"));
  const recorded = [...digests.keys()].filter((file) => file.startsWith(`${ASSETS_FOLDER}/`));
  const extra = listed.find((file) => !digests.has(file));
  const missing = recorded.find((file) => !listed.includes(file));
  if (extra ?? missing) throw changed(extra ?? missing ?? ASSETS_FOLDER);
  return listing;
}

/** Reads and admits every part; a native refusal (a link, a hard link, a program among the assets) is `admission-refused`. */
async function readAdmitted(request: IosPackageRequest): Promise<AdmittedParts> {
  const digests = new Map(request.outputs.map((file) => [file.path, file.sha256]));
  try {
    // The lane's `out/` is the host's; only links above it (macOS's `/var`) are resolved, so a
    // link inside it is still refused by every read below.
    const out = await realpath(request.out);
    const exe = await admittedExecutable(request, out, digests);
    const assets = await admittedAssets(out, digests);
    return { exe, assets, digests };
  } catch (error) {
    if (!(error instanceof NativeError)) throw error;
    throw refuse(ExportRefusal.AdmissionRefused, MESSAGE.notAdmitted(error.message), error.refusal);
  }
}

// ---------- staging and verification ----------

/** Writes one host file into the app, recording its digest. */
async function hostFile(
  app: string,
  expected: Map<string, string>,
  rel: string,
  bytes: Buffer | string,
): Promise<void> {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const to = path.join(app, ...rel.split("/"));
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, data, { flag: "wx", mode: FILE_MODE });
  expected.set(rel, sha256(data));
}

/** What the staged app is written from besides the admitted parts. */
interface HostParts {
  plist: string;
  notices: { files: readonly NoticeFile[]; index: string };
}

/** Writes the flat `.app` at `app`; answers every file's expected digest by its path in the app. */
async function writeApp(app: string, parts: AdmittedParts, host: HostParts): Promise<Map<string, string>> {
  const expected = new Map<string, string>();
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, RunDirLayout.Executable), parts.exe, { flag: "wx", mode: EXECUTABLE_MODE });
  expected.set(RunDirLayout.Executable, sha256(parts.exe));
  if (parts.assets) await copyListedAssets(parts.assets, path.join(app, ASSETS_FOLDER));
  for (const [file, digest] of parts.digests) if (file.startsWith(`${ASSETS_FOLDER}/`)) expected.set(file, digest);
  await hostFile(app, expected, INFO_PLIST, host.plist);
  await hostFile(app, expected, PKG_INFO, PKG_INFO_TEXT);
  await hostFile(app, expected, PRIVACY_MANIFEST, iosPrivacyManifest());
  for (const icon of IOS_ICONS) await hostFile(app, expected, icon.file, iosIconPng(icon.pixels));
  for (const file of host.notices.files) await hostFile(app, expected, `${NOTICES_FOLDER}/${file.rel}`, file.bytes);
  await hostFile(app, expected, `${NOTICES_FOLDER}/${NOTICES_INDEX}`, host.notices.index);
  return expected;
}

/** Refuses an app whose files are not exactly `expected`, each with its digest: changed, missing or added. */
async function verifyApp(app: string, expected: ReadonlyMap<string, string>): Promise<Map<string, Buffer>> {
  const files = await readBundleFiles(app).catch((error: unknown) => {
    if (error instanceof MobileSignError) throw changed(".");
    throw error;
  });
  for (const [rel, bytes] of files) if (expected.get(rel) !== sha256(bytes)) throw changed(rel);
  for (const rel of expected.keys()) if (!files.has(rel)) throw changed(rel);
  return files;
}

/** The files a held credential is looked for in: what the game made (executable, assets, its own notices). */
function gameMade(appName: string, expected: ReadonlyMap<string, string>): string[] {
  const made = [RunDirLayout.Executable, `${ASSETS_FOLDER}/`, `${NOTICES_FOLDER}/${THIRD_PARTY}/`];
  return [...expected.keys()]
    .filter((rel) => made.some((prefix) => rel === prefix || (prefix.endsWith("/") && rel.startsWith(prefix))))
    .map((rel) => `${appName}/${rel}`);
}

// ---------- signing ----------

/** The identity entitlements a profile grants for `bundleId`, or the refusal. */
export function profileEntitlements(profile: Buffer, bundleId: string, development: boolean): PlistEntry[] {
  const plist = PROFILE_PLIST.exec(profile.toString("latin1"))?.[0] ?? "";
  const team = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? "";
  const appId = /<key>application-identifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? "";
  const wanted = `${team}.${bundleId}`;
  const prefix = appId.endsWith("*") ? appId.slice(0, -1) : null;
  const covers = appId === wanted || (prefix !== null && prefix.startsWith(`${team}.`) && wanted.startsWith(prefix));
  if (!TEAM_ID.test(team) || !covers) {
    throw refuse(ExportRefusal.SigningInvalid, MESSAGE.profile, IosPackageRefusal.ProvisioningProfile);
  }
  return [
    ["application-identifier", plistString(wanted)],
    ["com.apple.developer.team-identifier", plistString(team)],
    ["get-task-allow", development ? "<true/>" : "<false/>"],
  ];
}

/** The signer's refusals that are the signing's own fault (a kind or profile it does not take), not a failed run. */
const INVALID_SIGNING_PROBLEMS: ReadonlySet<MobileSignProblem> = new Set([
  MobileSignProblem.Kind,
  MobileSignProblem.ProvisioningProfile,
  MobileSignProblem.ProvisioningProfileForbidden,
]);

/** A signer's refusal as the export's: the harness, a profile or kind it refused, or a failed run. */
function signingRefusal(error: MobileSignError): ExportError {
  const message = MESSAGE.signing(error.message);
  if (error.code === MobileSignProblem.HarnessMayNotSign)
    return refuse(ExportRefusal.HarnessMayNotSign, message, error.code);
  if (INVALID_SIGNING_PROBLEMS.has(error.code)) return refuse(ExportRefusal.SigningInvalid, message, error.code);
  return refuse(ExportRefusal.SigningFailed, message, error.code);
}

/** The entitlements the app is signed with: empty for the Simulator, the profile's identity for an IPA. */
async function entitlementsFor(request: IosPackageRequest, staging: string, app: string): Promise<string> {
  if (request.signing.kind === ExportSigning.AdHoc) return entitlementsPlist();
  const checked = await codesignIosPlan({ ...codesignRequest(request, staging, app), entitlements: null });
  const profile = await readHostFile(checked.provisioningProfile ?? "", PROFILE_MAX_BYTES).catch(() => {
    throw refuse(ExportRefusal.SigningInvalid, MESSAGE.profile, IosPackageRefusal.ProvisioningProfile);
  });
  const development = request.signing.kind === ExportSigning.IosDevelopment;
  return entitlementsPlist(profileEntitlements(profile, request.bundleId, development));
}

function codesignRequest(request: IosPackageRequest, staging: string, app: string) {
  const { signer } = request;
  return {
    choice: request.signing,
    requestedBy: request.requestedBy,
    tool: signer.tool ?? { file: CODESIGN_PATH, args: [] },
    stagingDir: staging,
    app,
    forbiddenRoots: signer.forbiddenRoots,
    home: signer.home,
  };
}

/**
 * Signs the staged app in `codesign`'s own sandbox with the artifact's entitlements (written into
 * staging and removed after), and admits the signed executable again for the artifact's platform.
 */
async function signApp(request: IosPackageRequest, staging: string, app: string): Promise<void> {
  const entitlements = path.join(staging, ENTITLEMENTS);
  try {
    await writeFile(entitlements, await entitlementsFor(request, staging, app), { flag: "wx", mode: FILE_MODE });
    await signIosApp(request.signer.sandbox, { ...codesignRequest(request, staging, app), entitlements });
  } catch (error) {
    if (error instanceof MobileSignError) throw signingRefusal(error);
    throw error;
  } finally {
    await rm(entitlements, { force: true });
  }
  const signed = await readAssetFile(path.join(app, RunDirLayout.Executable), EXECUTABLE_MAX_BYTES);
  const again = admitRustMachO(signed, BuildTarget.Ios);
  if (!again.ok || again.version.platform !== ARTIFACT_PLATFORM[request.artifact].macho) {
    throw refuse(ExportRefusal.SigningFailed, MESSAGE.signing(again.ok ? request.artifact : again.detail));
  }
}

// ---------- the IPA ----------

/** Zips the signed app as `Payload/<app>/…` into `ipa`, each entry held to the signed app's file. */
async function writeIpa(ipa: string, appName: string, signed: ReadonlyMap<string, Buffer>, secrets: readonly string[]) {
  const digests = new Map([...signed].map(([rel, bytes]) => [`${PAYLOAD}/${appName}/${rel}`, sha256(bytes)]));
  const items: ArchiveItem[] = [...signed].map(([rel, bytes]) => ({
    kind: ArchiveItemKind.File,
    path: `${PAYLOAD}/${appName}/${rel}`,
    content: { bytes },
    executable: rel === RunDirLayout.Executable,
  }));
  const handle = await open(ipa, "wx", FILE_MODE);
  try {
    const sink = {
      async write(chunk: Uint8Array) {
        await handle.write(chunk);
      },
    };
    const inspect = (entry: string, data: Buffer) => {
      if (digests.get(entry) !== sha256(data)) throw changed(entry);
    };
    return await writeZip(items, sink, { secretValues: secrets, inspect });
  } finally {
    await handle.close();
  }
}

// ---------- the package ----------

/** Stages the app in `root`; answers its path and the files it was verified with. */
async function stageApp(request: IosPackageRequest, parts: AdmittedParts, root: string, name: string) {
  const app = path.join(root, `${name}${APP_SUFFIX}`);
  const files = await readNotices(request.notices);
  const index = noticesIndex(`${name}${APP_SUFFIX}`, request.notices, files);
  const plist = iosInfoPlist({ ...request, name, now: (request.now ?? Date.now)() });
  const expected = await writeApp(app, parts, { plist, notices: { files, index } });
  await request.afterStage?.(app);
  await verifyApp(app, expected);
  const leaked = await fileWithSecret(
    root,
    gameMade(`${name}${APP_SUFFIX}`, expected),
    request.secretValues,
    () => true,
  );
  if (leaked) throw secretFoundError(leaked);
  return app;
}

/** The receipt: what was made, for whom, and with which Xcode and SDK. */
function receiptOf(request: IosPackageRequest): IosReceipt {
  return {
    artifact: request.artifact,
    bundleId: request.bundleId,
    signed: request.signing.kind,
    minimumOS: IOS_MINIMUM_OS_VERSION,
    xcode: { version: request.xcode.version, sdk: sdkOf(request.artifact, request.xcode).name },
  };
}

/** Builds the export folder's contents in `staging`: the signed app, or the IPA made from it. */
async function buildArtifact(request: IosPackageRequest, parts: AdmittedParts, staging: string, name: string) {
  const appName = `${name}${APP_SUFFIX}`;
  if (request.artifact === MobileArtifact.SimulatorApp) {
    const app = await stageApp(request, parts, staging, name);
    await signApp(request, staging, app);
    const signed = await readBundleFiles(app);
    const included = [...signed.keys()].map((rel) => `${appName}/${rel}`).sort();
    await writeFile(path.join(staging, README), MESSAGE.readmeSimulator(appName), { flag: "wx" });
    return { artifact: appName, included };
  }
  const payload = path.join(staging, PAYLOAD);
  const app = await stageApp(request, parts, payload, name);
  await signApp(request, staging, app);
  const signed = await readBundleFiles(app);
  const ipa = `${name}${IPA_SUFFIX}`;
  const entries = await writeIpa(path.join(staging, ipa), appName, signed, request.secretValues);
  await rm(payload, { recursive: true, force: true });
  await writeFile(path.join(staging, README), MESSAGE.readmeIpa(ipa, appName), { flag: "wx" });
  return { artifact: ipa, included: entries.sort() };
}

/**
 * Packages one iPhone build into `request.target`: the checks first (signing, caller, Xcode),
 * then the admitted build read once, the app staged in the host's own folder and verified, signed
 * in its sandbox, zipped for an IPA, and swapped into place with its receipt and README. Throws
 * `ExportError` and leaves the target as it was.
 */
export async function packageIosApp(request: IosPackageRequest): Promise<IosPackageResult> {
  assertCanPackage(request);
  const parts = await readAdmitted(request);
  const name = appNameOf(request.title, request.fallbackName);
  await assertInsideExports(request.exportsRoot, request.target);
  const { target, parent, existing } = await resolveExportTarget(await realpath(request.source), request.target);
  // By its real path: every read of the staged app refuses a link anywhere on its path.
  const staging = await realpath(await makeStaging(parent, request.stagingRoot));
  try {
    const built = await buildArtifact(request, parts, staging, name);
    if (request.artifact === MobileArtifact.SimulatorApp)
      await request.admitStaged?.(path.join(staging, built.artifact));
    const receipt = receiptOf(request);
    const marker = {
      studioExport: 1,
      destination: BuildTarget.Ios,
      ...receipt,
      file: built.artifact,
      included: built.included,
    };
    await writeFile(path.join(staging, EXPORT_MANIFEST), JSON.stringify(marker), { flag: "wx" });
    await swapIntoPlace(staging, target, existing, request.now);
    const artifact = path.join(target, built.artifact);
    return { dir: target, artifact, files: built.included.length, included: built.included, receipt };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof ExportError || !(error instanceof NativeError)) throw error;
    throw refuse(ExportRefusal.AdmissionRefused, MESSAGE.notAdmitted(errorMessage(error)), error.refusal);
  }
}
