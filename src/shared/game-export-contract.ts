/**
 * Why an export was refused, how an exported Mac app, Windows game or phone build is signed, what a
 * phone export makes, and whether its GPU path ran on a real GPU, typed, so the export menu, the
 * harness and the publish flow never match an error's sentence. Every signing
 * field from the renderer or the harness passes {@link parseExportSigning} before any argv exists.
 */
import { BuildTarget, GameStack } from "./game-project.ts";
import { TargetRefusal } from "./game-targets.ts";
import { NativeRefusal } from "./native-contract.ts";
import type { MobileBuildTarget } from "./toolchain.ts";

/** Why an export was refused before anything was written. Never rename a value. */
export const ExportRefusal = {
  /** The game's current build failed, so no stale output is exported. */
  BuildFailed: "build-failed",
  /** No build lane for the game's stack exists in this build: nothing was built, so nothing is exported. */
  LaneMissing: NativeRefusal.LaneMissing,
  /** The destination is not one the game's studio.json names. */
  NotADestination: TargetRefusal.NotADestination,
  /** The target folder is not empty and not an export Studio made. */
  NotAnExportFolder: "not-an-export-folder",
  /** A known secret value appears in a file the export would publish. */
  SecretFound: "secret-found",
  /** A signing field failed `parseExportSigning`; nothing was spawned or written. */
  SigningInvalid: "signing-invalid",
  /** Developer ID signing is not available in this build (no identity was cleared for it). */
  SigningUnavailable: "signing-unavailable",
  /** The harness asked for a signing other than none or ad hoc: only the person signs with an identity. */
  HarnessMayNotSign: "harness-may-not-sign",
  /** The Mac build failed the host's bundle admission, so no app was assembled. */
  AdmissionRefused: "admission-refused",
  /** A Mac app is exported only on a Mac. */
  MacBuildsNeedAMac: TargetRefusal.MacBuildsNeedAMac,
  /** The build's output changed after the gate admitted it: build again, then export. */
  BuildChanged: "build-changed",
  /** A toolchain store part the export needs (ANGLE, zig, raylib's source, the Linux sysroot) is missing or not its pin. */
  ToolchainUnusable: "toolchain-unusable",
  /** jsign did not sign the Windows game, or a signed file changed more than its signature. */
  SigningFailed: "signing-failed",
  /** The archive's path was refused: not a plain new file in a real folder outside the game and its build. */
  TargetRefused: "target-refused",
  /** A licence the archive must carry (raylib, GLFW, ANGLE, zig's runtime, a game library) could not be read. */
  MissingNotice: "missing-notice",
  /** The archive writer refused an entry (an unsafe or duplicate name, a link, an unreadable or oversized file). */
  ArchiveRefused: "archive-refused",
  /** An ejected game (extension ladder level 5) whose current build has no green conformance run: nothing was exported. */
  ConformanceRequired: NativeRefusal.ConformanceRequired,
} as const;
export type ExportRefusal = (typeof ExportRefusal)[keyof typeof ExportRefusal];

/** What an export refusal may name beside its code: the gate's refusal and the file it is about. */
export interface ExportErrorDetail {
  /** The PE, ELF or Mach-O gate's refusal (a `NativeRefusal` value), when a gate refused. */
  refusal?: string | null;
  /** The file the refusal is about, relative to the build's `out/` or the archive's folder. */
  file?: string | null;
}

/** An export refusal with its typed code beside the sentence, and the gate's refusal and file when one refused. */
export class ExportError extends Error {
  readonly code: ExportRefusal;
  /** The gate's refusal, when a gate refused; else null. */
  readonly refusal: string | null;
  /** The file the refusal is about; else null. */
  readonly file: string | null;

  constructor(code: ExportRefusal, message: string, detail: ExportErrorDetail = {}) {
    super(message);
    this.name = "ExportError";
    this.code = code;
    this.refusal = detail.refusal ?? null;
    this.file = detail.file ?? null;
  }
}

/** One megabyte as the web budget counts it (`[web] wasm_budget_mb`, the export's warning): 2^20 bytes. */
export const WEB_BUDGET_MB_BYTES = 1024 * 1024;
/**
 * A browser game's code budget when its `genex.toml` names none, in MB of gzip: an optimized
 * `game_bg.wasm` past its game's budget is exported with {@link ExportWarningCode.WasmOverTarget},
 * never refused (owner decision 2026-10-11).
 */
export const WEB_WASM_BUDGET_DEFAULT_MB = 4;
/** The smallest budget a game may name. */
export const WEB_WASM_BUDGET_MIN_MB = 1;
/** The hard ceiling, in MB of gzip: no game may raise its budget past it, and a module past it is refused `wasm-over-budget`. */
export const WEB_WASM_CEILING_MB = 32;
/** {@link WEB_WASM_BUDGET_DEFAULT_MB} in bytes. */
export const WEB_WASM_BUDGET_DEFAULT_BYTES = WEB_WASM_BUDGET_DEFAULT_MB * WEB_BUDGET_MB_BYTES;
/** {@link WEB_WASM_CEILING_MB} in bytes. */
export const WEB_WASM_CEILING_BYTES = WEB_WASM_CEILING_MB * WEB_BUDGET_MB_BYTES;

/** Whether `mb` is a web budget a game may name: a whole number of MB from the minimum to the ceiling. */
export function isWebWasmBudgetMb(mb: number): boolean {
  return Number.isInteger(mb) && mb >= WEB_WASM_BUDGET_MIN_MB && mb <= WEB_WASM_CEILING_MB;
}

/** Why an export that was made carries a warning. Wire values (`ExportResult.warnings`): never rename one. */
export const ExportWarningCode = {
  /** The browser game's optimized code is past its game's budget: it loads slower on phones and weak devices. */
  WasmOverTarget: "wasm-over-target",
} as const;
export type ExportWarningCode = (typeof ExportWarningCode)[keyof typeof ExportWarningCode];

/** A warning on an export that was made: its code, the gzip size and the game's budget it passed. */
export interface ExportWarning {
  code: ExportWarningCode;
  gzipBytes: number;
  budgetBytes: number;
}

/**
 * Whether an export's GPU path has run on a real GPU of its destination, recorded on the export's
 * receipt (`ExportResult.gpuQualification`). Wire values (`studio:export`, `game.export`): never
 * rename one.
 */
export const GpuQualification = {
  /** Only software GPUs (WARP, SwiftShader) or emulators ran it: the export is labelled "untested on real GPUs". */
  Untested: "untested",
  /** A real machine of the destination ran its GPU row. */
  RealGpu: "real-gpu",
} as const;
export type GpuQualification = (typeof GpuQualification)[keyof typeof GpuQualification];

/**
 * Each destination's GPU qualification for a Rust · wgpu export, the record a real-GPU row flips
 * when the owner runs one: the Mac's and the browser's rows run on an M-series Mac (Metal); the
 * Windows build ran only under WARP and the Linux build only on SwiftShader; the phones wait for
 * their device rows.
 */
export const RUST_GPU_QUALIFICATION = {
  [BuildTarget.Web]: GpuQualification.RealGpu,
  [BuildTarget.Mac]: GpuQualification.RealGpu,
  [BuildTarget.Windows]: GpuQualification.Untested,
  [BuildTarget.Linux]: GpuQualification.Untested,
  [BuildTarget.Ios]: GpuQualification.Untested,
  [BuildTarget.Android]: GpuQualification.Untested,
} as const satisfies Record<BuildTarget, GpuQualification>;

/**
 * The GPU qualification an export of `stack` for `target` records, or null when its receipt carries
 * none (a three.js or raylib export: their GPU path is the browser's or ANGLE's).
 */
export function gpuQualificationOf(stack: GameStack, target: BuildTarget): GpuQualification | null {
  return stack === GameStack.RustWgpu ? RUST_GPU_QUALIFICATION[target] : null;
}

/**
 * How one export of a stack to a destination runs: the dispatch table's values. Never rename a
 * value. The phones' runs join with their export modules.
 */
export const ExportRun = {
  /** A three.js game's browser folder, from its own build when it has one. */
  BrowserFolder: "browser-folder",
  /** A compiled game's browser folder, from its lane's web build (purpose `export`). */
  CompiledWeb: "compiled-web",
  /** A Mac app (`exportMacGame`). */
  MacApp: "mac-app",
  /** A Windows zip or a Linux tarball (`exportDesktopGame`). */
  DesktopArchive: "desktop-archive",
  /** A Simulator app or an IPA (`core/ios-export-run.ts`). */
  IosApp: "ios-app",
  /** A development APK or an AAB (`core/android-export-run.ts`). */
  AndroidPackage: "android-package",
  /** The stack makes this destination, but this build exports none yet: refused `lane-missing`, nothing runs. */
  LaneMissing: "lane-missing",
  /** The stack never makes this destination: refused `not-a-destination`, nothing runs. */
  NotADestination: "not-a-destination",
} as const;
export type ExportRun = (typeof ExportRun)[keyof typeof ExportRun];

/**
 * The export-run dispatch (`runExport` in `main/core/native-export-run.ts`): which run exports
 * each stack to each destination. A three.js game has only its browser folder; C++ · raylib never
 * makes a phone game. A Rust · wgpu game exports its browser folder and its phone packages (a
 * Simulator app or an IPA, a development APK or an AAB); its Mac app and its Windows and Linux
 * archives are `lane-missing` until a run of their own exports them (the Mac app and the desktop
 * archives assemble raylib's bundle, ANGLE and licences).
 */
export const EXPORT_RUNS = {
  [GameStack.ThreeJs]: {
    [BuildTarget.Web]: ExportRun.BrowserFolder,
    [BuildTarget.Mac]: ExportRun.NotADestination,
    [BuildTarget.Windows]: ExportRun.NotADestination,
    [BuildTarget.Linux]: ExportRun.NotADestination,
    [BuildTarget.Ios]: ExportRun.NotADestination,
    [BuildTarget.Android]: ExportRun.NotADestination,
  },
  [GameStack.RaylibCpp]: {
    [BuildTarget.Web]: ExportRun.CompiledWeb,
    [BuildTarget.Mac]: ExportRun.MacApp,
    [BuildTarget.Windows]: ExportRun.DesktopArchive,
    [BuildTarget.Linux]: ExportRun.DesktopArchive,
    [BuildTarget.Ios]: ExportRun.NotADestination,
    [BuildTarget.Android]: ExportRun.NotADestination,
  },
  [GameStack.RustWgpu]: {
    [BuildTarget.Web]: ExportRun.CompiledWeb,
    [BuildTarget.Mac]: ExportRun.LaneMissing,
    [BuildTarget.Windows]: ExportRun.LaneMissing,
    [BuildTarget.Linux]: ExportRun.LaneMissing,
    [BuildTarget.Ios]: ExportRun.IosApp,
    [BuildTarget.Android]: ExportRun.AndroidPackage,
  },
} as const satisfies Record<GameStack, Record<BuildTarget, ExportRun>>;

/**
 * The runs that export nothing: the pair is refused before anything runs. A run leaves this set
 * once its module packages and the core binds it (the phone runs at the M5 integration).
 */
const UNLANDED_RUNS: ReadonlySet<ExportRun> = new Set([ExportRun.LaneMissing, ExportRun.NotADestination]);

/** Whether this build exports a `stack` game to `target` at all ({@link EXPORT_RUNS} names a run that has landed). */
export function exportsTo(stack: GameStack, target: BuildTarget): boolean {
  return !UNLANDED_RUNS.has(EXPORT_RUNS[stack][target]);
}

/** How an export is signed. Wire values (`studio:export`, `game.export`): never rename one. */
export const ExportSigning = {
  /** Unsigned: the web folder, and the Windows and Linux archives by default. */
  None: "none",
  /** `codesign -s -`: opens on this Mac; another Mac asks in Privacy & Security. */
  AdHoc: "adhoc",
  /** The person's own Developer ID Application identity, with an optional notary keychain profile. */
  DeveloperId: "developer-id",
  /** A Windows game signed by jsign with the person's own code-signing certificate and an RFC 3161 timestamp. */
  OwnCertificate: "own-certificate",
  /** An iOS device build signed with the person's own Apple Development identity and provisioning profile. Person only. */
  IosDevelopment: "ios-development",
  /** An iOS build for the App Store or ad hoc distribution, with the person's Apple Distribution identity. Person only. */
  IosDistribution: "ios-distribution",
  /** A development APK signed with Studio's own per-profile debug key (never `~/.android/debug.keystore`). */
  AndroidDebug: "android-debug",
  /** An APK or AAB signed with the person's own release keystore. Person only. */
  AndroidRelease: "android-release",
} as const;
export type ExportSigning = (typeof ExportSigning)[keyof typeof ExportSigning];

/** What a phone export makes. Wire values (the export's receipt): never rename one. */
export const MobileArtifact = {
  /** An `.app` for the iOS Simulator, signed ad hoc. */
  SimulatorApp: "simulator-app",
  /** An `.ipa` signed with the person's Apple Development or Distribution identity. Person only. */
  Ipa: "ipa",
  /** A development APK signed with Studio's per-profile debug key. */
  ApkDev: "apk-dev",
  /** An Android App Bundle (bundletool) signed with the person's release keystore. Person only. */
  Aab: "aab",
} as const;
export type MobileArtifact = (typeof MobileArtifact)[keyof typeof MobileArtifact];

/** The artifacts each phone makes, the one its default signing makes first. */
export const MOBILE_ARTIFACTS = {
  [BuildTarget.Ios]: [MobileArtifact.SimulatorApp, MobileArtifact.Ipa],
  [BuildTarget.Android]: [MobileArtifact.ApkDev, MobileArtifact.Aab],
} as const satisfies Record<MobileBuildTarget, readonly MobileArtifact[]>;

/** The signings each artifact takes; no signing makes two artifacts of one phone. */
export const ARTIFACT_SIGNINGS = {
  [MobileArtifact.SimulatorApp]: [ExportSigning.AdHoc],
  [MobileArtifact.Ipa]: [ExportSigning.IosDevelopment, ExportSigning.IosDistribution],
  [MobileArtifact.ApkDev]: [ExportSigning.AndroidDebug],
  [MobileArtifact.Aab]: [ExportSigning.AndroidRelease],
} as const satisfies Record<MobileArtifact, readonly ExportSigning[]>;

/**
 * The artifacts the harness's `game.export` may make: never an IPA or an AAB, whose signings are
 * the person's alone. The seed keeps a copy (`loop/native-contract.ts`).
 */
export const HARNESS_MOBILE_ARTIFACTS: readonly MobileArtifact[] = Object.freeze([
  MobileArtifact.SimulatorApp,
  MobileArtifact.ApkDev,
]);

/** The artifact a `target` export signed `signing` makes; `signing-invalid` when the phone takes no such signing. */
export function mobileArtifactOf(target: MobileBuildTarget, signing: ExportSigning): MobileArtifact {
  const artifacts: readonly MobileArtifact[] = MOBILE_ARTIFACTS[target];
  const artifact = artifacts.find((each) => {
    const signings: readonly ExportSigning[] = ARTIFACT_SIGNINGS[each];
    return signings.includes(signing);
  });
  return artifact ?? invalid(`a ${target} export is not signed with ${signing}`);
}

/**
 * What a person picks in the native file dialog for a signing (`studio:export.signingReference`):
 * a release keystore, a provisioning profile or a password file. Wire values: never rename one.
 */
export const SigningReference = {
  Keystore: "keystore",
  ProvisioningProfile: "provisioning-profile",
  PasswordFile: "password-file",
} as const;
export type SigningReference = (typeof SigningReference)[keyof typeof SigningReference];

const SIGNING_REFERENCES: ReadonlySet<string> = new Set<SigningReference>(Object.values(SigningReference));
const isSigningReference = (value: unknown): value is SigningReference =>
  typeof value === "string" && SIGNING_REFERENCES.has(value);

/** The file kind a `studio:export.signingReference` payload names; `signing-invalid` for anything else. */
export function parseSigningReference(payload: unknown): SigningReference {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return invalid("reference");
  const { kind }: Record<string, unknown> = { ...payload };
  return isSigningReference(kind) ? kind : invalid("reference");
}

/**
 * The keystore kinds a person may sign a Windows game with, in jsign's spelling. File stores name a
 * keystore file (PKCS11: the SunPKCS11 configuration file); hardware tokens find their key
 * themselves. Wire values: never rename one.
 */
export const JsignStoreType = {
  Pkcs12: "PKCS12",
  Jks: "JKS",
  Pkcs11: "PKCS11",
  Yubikey: "YUBIKEY",
  Piv: "PIV",
  Etoken: "ETOKEN",
} as const;
export type JsignStoreType = (typeof JsignStoreType)[keyof typeof JsignStoreType];

/**
 * The only timestamp authorities a Windows signature may name: a table the person picks from, never
 * free text. The vendors publish these RFC 3161 endpoints over http; the responses are signed, so
 * the fixed table (not the scheme) is the control.
 */
export const TIMESTAMP_AUTHORITIES = ["http://timestamp.sectigo.com", "http://timestamp.digicert.com"] as const;
export type TimestampAuthority = (typeof TIMESTAMP_AUTHORITIES)[number];

/**
 * Where a signing password comes from: an environment variable of Studio's own or a file the person
 * chose, read by the signer at signing time. Never the password itself, so it is never logged,
 * stored in a choice or put in argv.
 */
export type SigningPasswordReference = { env: string } | { file: string };

/** A checked signing choice: only the fields its kind knows. */
export type ExportSigningChoice =
  | { kind: typeof ExportSigning.None }
  | { kind: typeof ExportSigning.AdHoc }
  | { kind: typeof ExportSigning.DeveloperId; identity: string; keychainProfile: string | null }
  | {
      kind: typeof ExportSigning.OwnCertificate;
      storeType: JsignStoreType;
      /** The keystore file's absolute path; null for a hardware token, which finds its key itself. */
      keystore: string | null;
      alias: string;
      timestampUrl: TimestampAuthority;
      /** The keystore password or token PIN; null when jsign needs none. Never logged or put in argv. */
      password: string | null;
    }
  | {
      kind: typeof ExportSigning.IosDevelopment | typeof ExportSigning.IosDistribution;
      /** The person's Apple Development or Apple Distribution identity (by name or SHA-1), matching the kind. */
      identity: string;
      /** The `.mobileprovision` file's absolute path; its real path is checked by the signer. */
      provisioningProfile: string;
    }
  | { kind: typeof ExportSigning.AndroidDebug }
  | {
      kind: typeof ExportSigning.AndroidRelease;
      /** The person's release keystore's absolute path; refused inside the games root or Genex data by the signer. */
      keystore: string;
      alias: string;
      password: SigningPasswordReference;
    };

/** The longest identity `codesign -s` is handed. */
const IDENTITY_MAX_CHARS = 200;
/** A Developer ID Application certificate's common name, with its ten-character team id. */
const DEVELOPER_ID_NAME = /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/;
/** The Apple identity each iOS signing kind takes by name, with its ten-character team id. */
const IOS_IDENTITY_NAME = {
  [ExportSigning.IosDevelopment]: /^Apple Development: .+ \([A-Z0-9]{10}\)$/,
  [ExportSigning.IosDistribution]: /^Apple Distribution: .+ \([A-Z0-9]{10}\)$/,
} as const;
/** A provisioning profile's file name ends so. */
const PROVISIONING_PROFILE_SUFFIX = ".mobileprovision";
/** An environment variable a signing password may come from: upper case, digits and underscores. */
const PASSWORD_ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** A certificate named by its SHA-1, as `security find-identity` prints it. */
const CERTIFICATE_SHA1 = /^[0-9A-F]{40}$/;
/** A `notarytool` keychain profile: a plain name that cannot read as an option or a path. */
const KEYCHAIN_PROFILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Any control character, NUL, CR and LF included. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The longest keystore path and password a choice may carry. */
const KEYSTORE_MAX_CHARS = 1024;
const PASSWORD_MAX_CHARS = 1024;
/** An absolute path: POSIX, or a Windows drive path (never a UNC or device path, which would reach the network). */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
/** A key alias jsign takes as one argument: starts with a letter or digit, so it never reads as an option. */
const KEY_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Any control character, C1 included: a keystore path is handed to jsign whole. */
const ANY_CONTROL = /\p{Cc}/u;
const STORE_TYPES: ReadonlySet<string> = new Set<JsignStoreType>(Object.values(JsignStoreType));
const AUTHORITIES: ReadonlySet<string> = new Set<string>(TIMESTAMP_AUTHORITIES);

const isStoreType = (value: unknown): value is JsignStoreType => typeof value === "string" && STORE_TYPES.has(value);
const isAuthority = (value: unknown): value is TimestampAuthority =>
  typeof value === "string" && AUTHORITIES.has(value);

const MESSAGE = {
  invalid: (why: string) => `The export's signing is not valid: ${why}.`,
} as const;

/** Throws the typed refusal for a signing field outside its shape. */
function invalid(why: string): never {
  throw new ExportError(ExportRefusal.SigningInvalid, MESSAGE.invalid(why));
}

/** Whether `identity` is a signing identity `codesign -s` may be handed as one argument. */
function isIdentity(identity: unknown): identity is string {
  if (typeof identity !== "string" || identity.length === 0 || identity.length > IDENTITY_MAX_CHARS) return false;
  if (CONTROL.test(identity) || identity.startsWith("-")) return false;
  return DEVELOPER_ID_NAME.test(identity) || CERTIFICATE_SHA1.test(identity);
}

/** The keystore file a Windows signature reads, or null for a hardware token: an absolute plain path. */
function keystoreOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const plain = typeof value === "string" && value.length <= KEYSTORE_MAX_CHARS && !ANY_CONTROL.test(value);
  if (!plain || !ABSOLUTE_PATH.test(value)) return invalid("keystore");
  return value;
}

/** The keystore password or token PIN, or null when the choice names none: at most 1,024 characters, no NUL. */
function passwordOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > PASSWORD_MAX_CHARS || value.includes("\0"))
    return invalid("password");
  return value;
}

/** An absolute plain path a signer reads (a keystore, a profile, a password file): at most 1,024 characters, no control character. */
function signerPathOf(value: unknown, field: string): string {
  const plain = typeof value === "string" && value.length <= KEYSTORE_MAX_CHARS && !ANY_CONTROL.test(value);
  if (!plain || !ABSOLUTE_PATH.test(value)) return invalid(field);
  return value;
}

/** An iOS device or distribution signing, checked field by field; a fresh copy. */
function iosSigningOf(
  kind: typeof ExportSigning.IosDevelopment | typeof ExportSigning.IosDistribution,
  fields: Record<string, unknown>,
): ExportSigningChoice {
  const { identity, provisioningProfile } = fields;
  const named =
    typeof identity === "string" &&
    identity.length <= IDENTITY_MAX_CHARS &&
    !CONTROL.test(identity) &&
    IOS_IDENTITY_NAME[kind].test(identity);
  if (!named && !(typeof identity === "string" && CERTIFICATE_SHA1.test(identity))) return invalid("identity");
  const profile = signerPathOf(provisioningProfile, "provisioningProfile");
  if (!profile.endsWith(PROVISIONING_PROFILE_SUFFIX)) return invalid("provisioningProfile");
  return { kind, identity, provisioningProfile: profile };
}

/** A signing password's reference: one environment variable or one absolute file, never the secret. */
function passwordReferenceOf(value: unknown): SigningPasswordReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("password");
  const { env, file }: Record<string, unknown> = { ...value };
  if (file !== undefined) return { file: signerPathOf(file, "password") };
  if (typeof env !== "string" || !PASSWORD_ENV.test(env)) return invalid("password");
  return { env };
}

/** An Android release signing with the person's own keystore, checked field by field; a fresh copy. */
function androidReleaseOf(fields: Record<string, unknown>): ExportSigningChoice {
  const { keystore, alias, password } = fields;
  if (typeof alias !== "string" || !KEY_ALIAS.test(alias)) return invalid("alias");
  return {
    kind: ExportSigning.AndroidRelease,
    keystore: signerPathOf(keystore, "keystore"),
    alias,
    password: passwordReferenceOf(password),
  };
}

/** A Windows signature with the person's own certificate, checked field by field; a fresh copy. */
function ownCertificateOf(fields: Record<string, unknown>): ExportSigningChoice {
  const { storeType, keystore, alias, timestampUrl, password } = fields;
  if (!isStoreType(storeType)) return invalid("storeType");
  if (typeof alias !== "string" || !KEY_ALIAS.test(alias)) return invalid("alias");
  if (!isAuthority(timestampUrl)) return invalid("timestampUrl");
  return {
    kind: ExportSigning.OwnCertificate,
    storeType,
    keystore: keystoreOf(keystore),
    alias,
    timestampUrl,
    password: passwordOf(password),
  };
}

/** The keychain profile `notarytool` reads, or null when the choice names none. */
function keychainProfileOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !KEYCHAIN_PROFILE.test(value)) return invalid("keychainProfile");
  return value;
}

/**
 * Checks a signing choice from the renderer or the harness and answers a fresh copy holding only
 * its kind's fields; throws `ExportError(signing-invalid)` for anything else, before any argv. Shape
 * only: which destination may take which kind, and the keystore's real path, are checked later.
 *
 * - Developer ID: an identity of 1–200 characters, no control character, never starting with `-`,
 *   either a `Developer ID Application: … (TEAMID)` name or a certificate's 40 uppercase hex digits.
 * - Own certificate: `storeType` from {@link JsignStoreType} (case as written); `keystore` null or an
 *   absolute path of at most 1,024 characters with no control character; `alias` 1–64 letters,
 *   digits, dots, dashes and underscores starting with a letter or digit; `timestampUrl` exactly one
 *   of {@link TIMESTAMP_AUTHORITIES}; `password` null or at most 1,024 characters with no NUL.
 * - iOS development or distribution: an `Apple Development: … (TEAMID)` or `Apple Distribution: …
 *   (TEAMID)` name matching the kind, or a certificate's 40 uppercase hex digits; an absolute
 *   `.mobileprovision` path of at most 1,024 characters with no control character.
 * - Android debug: Studio's own per-profile key, no fields.
 * - Android release: an absolute keystore path, an alias as above, and the password as a reference
 *   (`{env}`: an upper-case variable name; `{file}`: an absolute path), never the password itself.
 */
export function parseExportSigning(value: unknown): ExportSigningChoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("not a choice");
  const fields = value as Record<string, unknown>;
  const { kind, identity, keychainProfile } = fields;
  if (kind === ExportSigning.None) return { kind: ExportSigning.None };
  if (kind === ExportSigning.AdHoc) return { kind: ExportSigning.AdHoc };
  if (kind === ExportSigning.OwnCertificate) return ownCertificateOf(fields);
  if (kind === ExportSigning.IosDevelopment || kind === ExportSigning.IosDistribution)
    return iosSigningOf(kind, fields);
  if (kind === ExportSigning.AndroidDebug) return { kind: ExportSigning.AndroidDebug };
  if (kind === ExportSigning.AndroidRelease) return androidReleaseOf(fields);
  if (kind !== ExportSigning.DeveloperId) return invalid("kind");
  if (!isIdentity(identity)) return invalid("identity");
  return { kind: ExportSigning.DeveloperId, identity, keychainProfile: keychainProfileOf(keychainProfile) };
}
