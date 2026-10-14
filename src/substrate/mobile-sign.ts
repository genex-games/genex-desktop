/**
 * Phone signing (M3.6): `apksigner` for Android builds and `codesign` for iOS apps, each run in a
 * sandbox of its own over the host-staged, admitted copy, and checked afterwards to have changed
 * nothing but the signature.
 *
 * - **Studio's Android debug key** is per profile, in a folder of Genex's own that every agent
 *   process is denied ({@link androidDebugKeyPaths}); it is never `~/.android/debug.keystore`, and
 *   a key folder inside `~/.android` or reached through a link is refused. Its password is random,
 *   kept in a 0600 file beside it. {@link ensureAndroidDebugKey} makes it once with `keytool`.
 * - **The person's own keys** (an Android release keystore, an iOS development or distribution
 *   identity and its provisioning profile) are person-only: the harness is refused before anything
 *   is read. A keystore, password file or provisioning profile inside the games root, Genex's own
 *   data (the caller's `forbiddenRoots`) or `~/.android` is refused after `realpath`.
 * - **Passwords** come by reference (`{env}` or `{file}`), are read by the host, and travel to the
 *   signer only in its environment under {@link ANDROID_KEY_PASS_ENV}: never argv, the log line or
 *   an error. `secretValues` hands them to the redactor, as `windows-sign.ts` does. While Genex runs
 *   on Windows a release password is refused, as jsign's is: srt-win hands a run its environment
 *   in a file the sandbox user can read. Studio's own debug key is not the person's secret.
 * - **What a signature may change**: {@link apkSignatureOnlyChange} (zero padding and an APK
 *   Signing Block before the same central directory), {@link machOSignatureOnlyChange} (the code
 *   signature and `__LINKEDIT`'s size) and {@link iosBundleSignatureOnlyChange} (plus
 *   `_CodeSignature/CodeResources`).
 *
 * The Android App Bundle (AAB) is signed by `jarsigner`, not here: it lands with the Android
 * export lane (M5).
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import {
  ExportSigning,
  type ExportSigningChoice,
  type SigningPasswordReference,
} from "../shared/game-export-contract.ts";
import { redactValues } from "../shared/redact.ts";
import { isInside } from "./paths.ts";
import { shellQuote } from "./shell-quote.ts";
import type { RunRequest, RunResult, SandboxOptions } from "./spawn.ts";
import { SigningRequester } from "./windows-sign.ts";

/** The environment variable a signer reads its keystore password from, by `env:` reference. */
export const ANDROID_KEY_PASS_ENV = "GENEX_ANDROID_KEY_PASS";
/** The alias of Studio's debug key inside its keystore. */
export const ANDROID_DEBUG_KEY_ALIAS = "genexdebugkey";
/** The folder under Genex's data that holds Studio's own signing keys (one folder per key). */
export const SIGNING_KEYS_FOLDER = "signing-keys";
/** The lowest Android an APK is signed for: v2 and v3 schemes only, never v1 JAR signing. */
const ANDROID_MIN_SDK = 29;
const DEBUG_KEY_DNAME = "CN=Genex Debug,O=Genex,C=US";
const DEBUG_KEY_VALIDITY_DAYS = 10_000;
const DEBUG_KEY_BITS = 2048;
const DEBUG_PASSWORD_BYTES = 24;
const KEY_FOLDER_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
/** The longest password file read: a password is one line. */
const PASSWORD_FILE_MAX_BYTES = 4096;
const PASSWORD_MAX_CHARS = 1024;
/** The largest provisioning profile embedded. */
const PROFILE_MAX_BYTES = 1024 * 1024;
const SIGN_TIMEOUT_MS = 5 * MINUTE_MS;
const SIGN_OUTPUT_MAX_BYTES = 256 * 1024;
/** Apple's timestamp server: a distribution signature is timestamped, a development one is not. */
const APPLE_TIMESTAMP_HOST = "timestamp.apple.com";
const PROVISIONING_PROFILE_FILE = "embedded.mobileprovision";
/** The one file `codesign` adds to an app it signs (no `--deep`). */
const CODE_RESOURCES = "_CodeSignature/CodeResources";
const CONTROL = /\p{Cc}/u;
const LABEL = { Apksigner: "apksigner", Keytool: "keytool", Codesign: "codesign" } as const;

/** Why a phone signing was refused or failed. Never rename a value. */
export const MobileSignProblem = {
  HarnessMayNotSign: "harness-may-not-sign",
  /** A signing kind this signer does not take. */
  Kind: "kind",
  Keystore: "keystore",
  KeystoreForbidden: "keystore-forbidden",
  Password: "password",
  PasswordFileForbidden: "password-file-forbidden",
  ProvisioningProfile: "provisioning-profile",
  ProvisioningProfileForbidden: "provisioning-profile-forbidden",
  /** Studio's debug key folder is in `~/.android`, a link, or its keystore is not its own. */
  DebugKeyHome: "debug-key-home",
  /** Studio's debug key has not been made yet ({@link ensureAndroidDebugKey}). */
  DebugKeyMissing: "debug-key-missing",
  Target: "target",
  Tool: "tool",
  WindowsHostPassword: "windows-host-password",
  SignerFailed: "signer-failed",
  /** The signer changed more than the signature: the signed copy was removed. */
  SignatureChanged: "signature-changed",
} as const;
export type MobileSignProblem = (typeof MobileSignProblem)[keyof typeof MobileSignProblem];

/** Messages name the field, never a value typed into it. */
const MESSAGE = {
  [MobileSignProblem.HarnessMayNotSign]:
    "Only you can sign with your own key or identity; the agent signs with Studio's debug key or ad hoc only.",
  [MobileSignProblem.Kind]: "This signer does not take that kind of signing.",
  [MobileSignProblem.Keystore]: "The keystore must be an existing file named by its full path.",
  [MobileSignProblem.KeystoreForbidden]:
    "The keystore is inside a game, Genex's own data, ~/.android or another folder Genex does not sign from.",
  [MobileSignProblem.Password]:
    "The keystore password is missing, empty, too long or holds a character it cannot carry.",
  [MobileSignProblem.PasswordFileForbidden]:
    "The password file is inside a game, Genex's own data, ~/.android or another folder Genex does not read secrets from.",
  [MobileSignProblem.ProvisioningProfile]: "The provisioning profile must be an existing .mobileprovision file.",
  [MobileSignProblem.ProvisioningProfileForbidden]:
    "The provisioning profile is inside a game, Genex's own data or another folder Genex does not sign from.",
  [MobileSignProblem.DebugKeyHome]: "Studio's debug key folder is not its own (inside ~/.android, or a link).",
  [MobileSignProblem.DebugKeyMissing]: "Studio's debug key has not been made for this profile yet.",
  [MobileSignProblem.Target]:
    "Only the export's own staged files, inside its staging folder and with no links, are signed.",
  [MobileSignProblem.Tool]: "The signing tool must be named by its full path.",
  [MobileSignProblem.WindowsHostPassword]:
    "Signing with your own keystore password is not available while Genex runs on Windows yet.",
  [MobileSignProblem.SignerFailed]: "The signing tool failed.",
  [MobileSignProblem.SignatureChanged]:
    "The signing tool changed more than the signature; the signed copy was removed.",
} as const satisfies Record<MobileSignProblem, string>;

/** A refused or failed phone signing, typed. Its message never holds a password; `output` is redacted. */
export class MobileSignError extends Error {
  readonly code: MobileSignProblem;
  /** What the signer printed, with every secret it was handed removed; empty for a refusal. */
  readonly output: string;

  constructor(code: MobileSignProblem, output = "") {
    super(MESSAGE[code]);
    this.name = "MobileSignError";
    this.code = code;
    this.output = output;
  }
}

const fail = (code: MobileSignProblem) => new MobileSignError(code);

/** A signing tool: its absolute path and any leading arguments (`java -jar …`). */
export interface MobileSignTool {
  file: string;
  args: readonly string[];
}

/** Where Studio's per-profile Android debug key lives: its folder, keystore and password file. */
export interface AndroidDebugKey {
  home: string;
  keystore: string;
  passwordFile: string;
}

/** Studio's debug key in `home` (`<userData>/signing-keys/android-debug`), which the studio's secret paths deny. */
export function androidDebugKeyPaths(home: string): AndroidDebugKey {
  return { home, keystore: path.join(home, "debug.p12"), passwordFile: path.join(home, "storepass") };
}

/** A checked signer run. `display` is the log line (no secrets); `env` holds the password, if any. */
export interface MobileSignPlan {
  label: string;
  file: string;
  args: string[];
  env: Record<string, string>;
  display: string;
  secretValues: string[];
  allowedDomains: string[];
  /** The only folder the run writes, by its real path, and its working folder. */
  stagingDir: string;
}

/** The APK signing plan: what it reads and the one file it writes. */
export interface ApkSignPlan extends MobileSignPlan {
  input: string;
  output: string;
}

/** The iOS signing plan: the app it signs, and the profile the host embeds first (null when ad hoc). */
export interface IosSignPlan extends MobileSignPlan {
  app: string;
  provisioningProfile: string | null;
}

/** Everything one APK signing needs; the export flow supplies all but `choice`. */
export interface ApksignerRequest {
  choice: ExportSigningChoice;
  requestedBy: SigningRequester;
  /** The OS Genex runs on: on Windows a release password is refused. */
  host: StudioPlatform;
  tool: MobileSignTool;
  stagingDir: string;
  /** The admitted, aligned, unsigned APK. */
  input: string;
  /** The signed APK to write: inside staging, not there yet. */
  output: string;
  debugKey: AndroidDebugKey;
  /** Folders a keystore or password file may never come from: the games root, Genex's data. */
  forbiddenRoots: readonly string[];
  /** The person's home: `~/.android` is refused. */
  home: string;
  /** Where an `{env}` password reference is read. Nothing of it reaches the signer but the password. */
  env: Readonly<Record<string, string | undefined>>;
  /** What the tool itself needs in its environment (`JAVA_HOME`); never a secret. */
  toolEnv?: Readonly<Record<string, string>>;
}

/** Everything one iOS app signing needs. */
export interface CodesignRequest {
  choice: ExportSigningChoice;
  requestedBy: SigningRequester;
  tool: MobileSignTool;
  stagingDir: string;
  /** The staged `.app` folder. */
  app: string;
  /** A host-written entitlements plist inside staging, or null. */
  entitlements: string | null;
  forbiddenRoots: readonly string[];
  home: string;
  toolEnv?: Readonly<Record<string, string>>;
}

const PERSON_ONLY: ReadonlySet<ExportSigning> = new Set([
  ExportSigning.AndroidRelease,
  ExportSigning.IosDevelopment,
  ExportSigning.IosDistribution,
]);

/** Refuses the harness a person-only signing before anything is read. */
function checkCaller(choice: ExportSigningChoice, requestedBy: SigningRequester): void {
  if (requestedBy !== SigningRequester.Person && PERSON_ONLY.has(choice.kind)) {
    throw fail(MobileSignProblem.HarnessMayNotSign);
  }
}

const isPlainAbsolute = (value: string): boolean => path.isAbsolute(value) && !CONTROL.test(value);

function checkTool(tool: MobileSignTool): void {
  if (!isPlainAbsolute(tool.file) || tool.args.some((arg) => CONTROL.test(arg))) throw fail(MobileSignProblem.Tool);
}

async function realOrResolved(dir: string): Promise<string> {
  return realpath(dir).catch(() => path.resolve(dir));
}

/** The roots nothing the person names may come from: the caller's and `~/.android`. */
async function forbiddenReal(roots: readonly string[], home: string): Promise<string[]> {
  return Promise.all([...roots, path.join(home, ".android")].map(realOrResolved));
}

/**
 * The real path of a regular file the person named, checked outside every forbidden root; `missing`
 * for anything not an absolute path to an existing file, `forbidden` for a file in a forbidden root.
 */
async function personFile(
  file: string,
  roots: readonly string[],
  home: string,
  codes: { missing: MobileSignProblem; forbidden: MobileSignProblem },
): Promise<string> {
  if (!isPlainAbsolute(file)) throw fail(codes.missing);
  const real = await realpath(file).catch(() => null);
  const info = real === null ? null : await stat(real).catch(() => null);
  if (real === null || !info?.isFile()) throw fail(codes.missing);
  for (const root of await forbiddenReal(roots, home)) if (isInside(root, real)) throw fail(codes.forbidden);
  return real;
}

/** A password's characters checked: non-empty, at most 1,024, no NUL. */
function checkedPassword(value: string | undefined): string {
  const valid = value !== undefined && value.length > 0 && value.length <= PASSWORD_MAX_CHARS && !value.includes("\0");
  if (!valid) throw fail(MobileSignProblem.Password);
  return value;
}

/** The first line of a small password file. */
async function passwordFromFile(file: string): Promise<string> {
  const info = await stat(file);
  if (info.size > PASSWORD_FILE_MAX_BYTES) throw fail(MobileSignProblem.Password);
  const [line] = (await readFile(file, "utf8")).split(/\r?\n/u);
  return checkedPassword(line);
}

/** The password a reference names, read by the host. */
async function resolvePassword(
  reference: SigningPasswordReference,
  request: Pick<ApksignerRequest, "env" | "forbiddenRoots" | "home">,
): Promise<string> {
  if ("env" in reference) return checkedPassword(request.env[reference.env]);
  const codes = { missing: MobileSignProblem.Password, forbidden: MobileSignProblem.PasswordFileForbidden };
  return passwordFromFile(await personFile(reference.file, request.forbiddenRoots, request.home, codes));
}

/**
 * The password a reference's `file` holds, read exactly as the signer reads it (a regular file the
 * person named, by its real path outside every forbidden root and `~/.android`, its first line);
 * null wherever the signer would refuse it. Only for redacting what a signer echoed.
 */
export async function signerPasswordFile(file: string, roots: readonly string[], home: string): Promise<string | null> {
  const codes = { missing: MobileSignProblem.Password, forbidden: MobileSignProblem.PasswordFileForbidden };
  return personFile(file, roots, home, codes)
    .then(passwordFromFile)
    .catch(() => null);
}

/** Refuses a link at `file` (lstat), answering what is there or null when nothing is. */
async function notLink(file: string, code: MobileSignProblem) {
  const info = await lstat(file).catch(() => null);
  if (info?.isSymbolicLink()) throw fail(code);
  return info;
}

/** Studio's key folder by its real path: a real folder, no link, not inside `~/.android`. */
async function checkedKeyHome(key: AndroidDebugKey, home: string): Promise<string> {
  const info = await notLink(key.home, MobileSignProblem.DebugKeyHome);
  const android = await realOrResolved(path.join(home, ".android"));
  const real = await realOrResolved(key.home);
  if (isInside(android, real) || isInside(android, path.resolve(key.home))) throw fail(MobileSignProblem.DebugKeyHome);
  if (info !== null && !info.isDirectory()) throw fail(MobileSignProblem.DebugKeyHome);
  return real;
}

/** Studio's debug keystore and password, checked: both regular files of the key folder's own. */
async function debugKeyFor(key: AndroidDebugKey, home: string): Promise<{ keystore: string; password: string }> {
  const keyHome = await checkedKeyHome(key, home);
  const keystore = await notLink(key.keystore, MobileSignProblem.DebugKeyHome);
  const passwordFile = await notLink(key.passwordFile, MobileSignProblem.DebugKeyHome);
  if (keystore === null || passwordFile === null) throw fail(MobileSignProblem.DebugKeyMissing);
  if (!keystore.isFile() || !passwordFile.isFile()) throw fail(MobileSignProblem.DebugKeyHome);
  const real = await realpath(key.keystore);
  if (!isInside(keyHome, real)) throw fail(MobileSignProblem.DebugKeyHome);
  return { keystore: real, password: await passwordFromFile(key.passwordFile) };
}

/** The keystore, alias and password an APK is signed with. */
async function apkKey(request: ApksignerRequest): Promise<{ keystore: string; alias: string; password: string }> {
  const { choice } = request;
  if (choice.kind === ExportSigning.AndroidDebug) {
    return { ...(await debugKeyFor(request.debugKey, request.home)), alias: ANDROID_DEBUG_KEY_ALIAS };
  }
  if (choice.kind !== ExportSigning.AndroidRelease) throw fail(MobileSignProblem.Kind);
  if (request.host === StudioPlatform.Windows) throw fail(MobileSignProblem.WindowsHostPassword);
  const codes = { missing: MobileSignProblem.Keystore, forbidden: MobileSignProblem.KeystoreForbidden };
  const keystore = await personFile(choice.keystore, request.forbiddenRoots, request.home, codes);
  return { keystore, alias: choice.alias, password: await resolvePassword(choice.password, request) };
}

/** A staged input's real path: a regular non-link file named `suffix`, inside the staging folder. */
async function stagedInput(file: string, staging: string, suffix: string): Promise<string> {
  const named = isPlainAbsolute(file) && file.endsWith(suffix);
  const info = named ? await lstat(file).catch(() => null) : null;
  if (!info?.isFile()) throw fail(MobileSignProblem.Target);
  const real = await realpath(file);
  if (!isInside(staging, real) || real === staging) throw fail(MobileSignProblem.Target);
  return real;
}

/** A staged output: named `suffix`, in the staging folder itself, not there yet. */
async function stagedOutput(file: string, staging: string, suffix: string): Promise<string> {
  const named = isPlainAbsolute(file) && file.endsWith(suffix);
  if (!named) throw fail(MobileSignProblem.Target);
  const dir = await realOrResolved(path.dirname(file));
  const there = await lstat(file).catch(() => null);
  if (there !== null || !isInside(staging, dir)) throw fail(MobileSignProblem.Target);
  return path.join(dir, path.basename(file));
}

/** A checked plan's common fields. */
function plan(label: string, tool: MobileSignTool, args: string[], stagingDir: string): MobileSignPlan {
  const all = [...tool.args, ...args];
  return {
    label,
    file: tool.file,
    args: all,
    env: {},
    display: [tool.file, ...all].map(shellQuote).join(" "),
    secretValues: [],
    allowedDomains: [],
    stagingDir,
  };
}

/** `plan` with a password carried in the environment and handed to the redactor. */
function withPassword<T extends MobileSignPlan>(checked: T, password: string): T {
  return { ...checked, env: { [ANDROID_KEY_PASS_ENV]: password }, secretValues: [password] };
}

/**
 * The `apksigner sign` run for an APK: Studio's debug key or the person's release keystore, v2 and
 * v3 schemes only, alignment preserved (the admitted copy is already `zipalign -P 16`), password by
 * `env:` reference. Every field is checked first; a refusal is a {@link MobileSignError} and
 * nothing has been written or spawned.
 */
export async function apksignerPlan(request: ApksignerRequest): Promise<ApkSignPlan> {
  checkCaller(request.choice, request.requestedBy);
  checkTool(request.tool);
  const staging = await realOrResolved(request.stagingDir);
  const key = await apkKey(request);
  const input = await stagedInput(request.input, staging, ".apk");
  const output = await stagedOutput(request.output, staging, ".apk");
  const pass = `env:${ANDROID_KEY_PASS_ENV}`;
  const args = [
    "sign",
    ...["--ks", key.keystore, "--ks-key-alias", key.alias, "--ks-pass", pass, "--key-pass", pass],
    ...["--v1-signing-enabled", "false", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true"],
    ...["--v4-signing-enabled", "false", "--min-sdk-version", String(ANDROID_MIN_SDK), "--alignment-preserved"],
    ...["--in", input, "--out", output],
  ];
  const checked = { ...plan(LABEL.Apksigner, request.tool, args, staging), input, output };
  return withPassword(checked, key.password);
}

/** The person's provisioning profile, checked: a `.mobileprovision` file outside every forbidden root. */
async function provisioningProfileOf(request: CodesignRequest): Promise<string | null> {
  const { choice } = request;
  if (choice.kind !== ExportSigning.IosDevelopment && choice.kind !== ExportSigning.IosDistribution) return null;
  const codes = {
    missing: MobileSignProblem.ProvisioningProfile,
    forbidden: MobileSignProblem.ProvisioningProfileForbidden,
  };
  const real = await personFile(choice.provisioningProfile, request.forbiddenRoots, request.home, codes);
  const size = (await stat(real)).size;
  if (!real.endsWith(".mobileprovision") || size > PROFILE_MAX_BYTES) throw fail(MobileSignProblem.ProvisioningProfile);
  return real;
}

/** The identity and timestamp arguments for a signing kind codesign takes. */
function codesignIdentity(choice: ExportSigningChoice): { args: string[]; domains: string[] } {
  if (choice.kind === ExportSigning.AdHoc) return { args: ["--sign", "-", "--timestamp=none"], domains: [] };
  if (choice.kind === ExportSigning.IosDevelopment) {
    return { args: ["--sign", choice.identity, "--timestamp=none"], domains: [] };
  }
  if (choice.kind === ExportSigning.IosDistribution) {
    return { args: ["--sign", choice.identity, "--timestamp"], domains: [APPLE_TIMESTAMP_HOST] };
  }
  throw fail(MobileSignProblem.Kind);
}

/** A staged `.app` folder's real path: a real folder, no link, inside staging. */
async function stagedApp(app: string, staging: string): Promise<string> {
  const info = isPlainAbsolute(app) && app.endsWith(".app") ? await lstat(app).catch(() => null) : null;
  if (!info?.isDirectory()) throw fail(MobileSignProblem.Target);
  const real = await realpath(app);
  if (!isInside(staging, real) || real === staging) throw fail(MobileSignProblem.Target);
  return real;
}

/**
 * The `codesign` run for a staged iOS app: ad hoc for the Simulator (the harness may ask), or the
 * person's Apple Development (untimestamped) or Distribution (timestamped by Apple) identity, whose
 * provisioning profile the host embeds before the run ({@link signIosApp}). No `--deep`: every
 * nested binary was signed when it was staged.
 */
export async function codesignIosPlan(request: CodesignRequest): Promise<IosSignPlan> {
  checkCaller(request.choice, request.requestedBy);
  checkTool(request.tool);
  const identity = codesignIdentity(request.choice);
  const staging = await realOrResolved(request.stagingDir);
  const app = await stagedApp(request.app, staging);
  const provisioningProfile = await provisioningProfileOf(request);
  const entitlements =
    request.entitlements === null ? [] : ["--entitlements", await stagedInput(request.entitlements, staging, ".plist")];
  const args = ["--force", ...identity.args, ...entitlements, app];
  const checked = plan(LABEL.Codesign, request.tool, args, staging);
  return { ...checked, allowedDomains: identity.domains, app, provisioningProfile };
}

// ---------- running a signer ----------

/** One sandboxed signer run: the `ProcessSandbox.run` request and what its redactor removes. */
export interface MobileSignRun {
  request: RunRequest;
  secretValues: string[];
}

/** The signer's sandbox runner. */
export interface MobileSignSandbox {
  run(request: RunRequest): Promise<RunResult>;
}

/**
 * The `ProcessSandbox.run` request for a checked plan: writes only its staging folder, network only
 * to its domains, the plan's password under {@link ANDROID_KEY_PASS_ENV} over `toolEnv`. Pure.
 */
export function mobileSignRunRequest(
  checked: MobileSignPlan,
  toolEnv: Readonly<Record<string, string>> = {},
): MobileSignRun {
  return {
    request: {
      command: checked.display,
      cwd: checked.stagingDir,
      env: { ...toolEnv, ...checked.env },
      timeoutMs: SIGN_TIMEOUT_MS,
      policy: { allowedDomains: [...checked.allowedDomains], allowWrite: [checked.stagingDir] },
      label: checked.label,
      maxOutputBytes: SIGN_OUTPUT_MAX_BYTES,
    },
    secretValues: [...checked.secretValues],
  };
}

/** Runs one signer request and answers its result with every secret redacted from the output. */
export async function runMobileSign(
  sandbox: MobileSignSandbox,
  run: MobileSignRun,
): Promise<Pick<RunResult, "code" | "stdout" | "stderr" | "timedOut">> {
  const result = await sandbox.run(run.request);
  return {
    code: result.code,
    stdout: redactValues(result.stdout, run.secretValues),
    stderr: redactValues(result.stderr, run.secretValues),
    timedOut: result.timedOut,
  };
}

/** Runs a checked plan, refusing a failed or timed-out run with its redacted output. */
async function runChecked(
  sandbox: MobileSignSandbox,
  checked: MobileSignPlan,
  toolEnv: Readonly<Record<string, string>> = {},
): Promise<void> {
  const result = await runMobileSign(sandbox, mobileSignRunRequest(checked, toolEnv));
  if (result.code !== 0 || result.timedOut) {
    throw new MobileSignError(MobileSignProblem.SignerFailed, `${result.stdout}\n${result.stderr}`.trim());
  }
}

/** What a signer's own sandbox is made from. */
export interface MobileSignSandboxRequest {
  /** The one folder the signer writes: the export's staging folder, or the key folder for `keytool`. */
  staging: string;
  /** A private scratch folder for the run: never the agents'. */
  scratch: string;
  /** The studio's protected paths. */
  secretPaths: readonly string[];
  /** The studio's write denies; one holding the staging folder is left out. */
  denyWrite: readonly string[];
  /** Studio's debug key folder, when this signer uses it: the one secret path it may read. */
  keyHome?: string;
}

/**
 * The options of the sandbox one signer gets to itself: its staging folder the one writable root, a
 * private scratch, every studio secret denied but Studio's own key folder when it signs with it.
 * Throws when a secret path still holds the key folder (the signer could not read the key).
 */
export function mobileSignSandboxOptions(request: MobileSignSandboxRequest): SandboxOptions {
  const { keyHome } = request;
  const secretPaths =
    keyHome === undefined ? [...request.secretPaths] : request.secretPaths.filter((p) => !isInside(keyHome, p));
  if (keyHome !== undefined && secretPaths.some((p) => isInside(p, keyHome))) {
    throw new TypeError("Studio's key folder must be a protected path of its own, not inside another");
  }
  return {
    writableRoots: [request.staging],
    scratchDir: request.scratch,
    secretPaths,
    denyWrite: request.denyWrite.filter((deny) => !isInside(deny, request.staging)),
  };
}

// ---------- Studio's debug key ----------

/** What making Studio's debug key needs. */
export interface DebugKeyRequest {
  key: AndroidDebugKey;
  /** `keytool` from the JDK the Android lane uses. */
  tool: MobileSignTool;
  home: string;
  toolEnv?: Readonly<Record<string, string>>;
}

/** The key folder (0700) and its random password (0600), made once; the password. */
async function debugKeyPassword(key: AndroidDebugKey): Promise<string> {
  await mkdir(key.home, { recursive: true, mode: KEY_FOLDER_MODE });
  await chmod(key.home, KEY_FOLDER_MODE);
  const there = await notLink(key.passwordFile, MobileSignProblem.DebugKeyHome);
  if (there !== null) return passwordFromFile(key.passwordFile);
  const password = randomBytes(DEBUG_PASSWORD_BYTES).toString("base64url");
  const file = await open(key.passwordFile, "wx", SECRET_FILE_MODE);
  try {
    await file.writeFile(`${password}\n`);
  } finally {
    await file.close();
  }
  return password;
}

/**
 * Makes Studio's per-profile Android debug key once: a 0700 folder of Genex's own, a random
 * password in a 0600 file, and a PKCS12 keystore `keytool` writes in a sandbox whose one writable
 * root is that folder. A key already there is kept.
 */
export async function ensureAndroidDebugKey(sandbox: MobileSignSandbox, request: DebugKeyRequest): Promise<void> {
  const { key } = request;
  checkTool(request.tool);
  await checkedKeyHome(key, request.home);
  if ((await notLink(key.keystore, MobileSignProblem.DebugKeyHome)) !== null) return;
  const password = await debugKeyPassword(key);
  const keyHome = await realpath(key.home);
  const pass = ANDROID_KEY_PASS_ENV;
  const args = [
    ...["-genkeypair", "-noprompt", "-keystore", path.join(keyHome, path.basename(key.keystore))],
    ...["-storetype", "PKCS12", "-alias", ANDROID_DEBUG_KEY_ALIAS, "-keyalg", "RSA"],
    ...["-keysize", String(DEBUG_KEY_BITS), "-validity", String(DEBUG_KEY_VALIDITY_DAYS), "-dname", DEBUG_KEY_DNAME],
    ...["-storepass:env", pass, "-keypass:env", pass],
  ];
  const checked = withPassword(plan(LABEL.Keytool, request.tool, args, keyHome), password);
  await runChecked(sandbox, checked, request.toolEnv);
  await chmod(key.keystore, SECRET_FILE_MODE);
}

// ---------- signing ----------

/**
 * Signs an admitted APK: checks the request ({@link apksignerPlan}), runs `apksigner` in `sandbox`,
 * and keeps the output only if it is the admitted copy with a signing block added
 * ({@link apkSignatureOnlyChange}); otherwise removes it and refuses `signature-changed`.
 */
export async function signApk(sandbox: MobileSignSandbox, request: ApksignerRequest): Promise<{ output: string }> {
  const checked = await apksignerPlan(request);
  const admitted = await readFile(checked.input);
  try {
    await runChecked(sandbox, checked, request.toolEnv);
    const signed = await readFile(checked.output).catch(() => null);
    if (signed === null || !apkSignatureOnlyChange(admitted, signed)) throw fail(MobileSignProblem.SignatureChanged);
  } catch (error) {
    await rm(checked.output, { force: true });
    throw error;
  }
  return { output: checked.output };
}

/** Every file of a bundle by its `/`-separated relative path; a link anywhere is refused (`target`). */
export async function readBundleFiles(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw fail(MobileSignProblem.Target);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) files.set(relative, await readFile(full));
      else throw fail(MobileSignProblem.Target);
    }
  };
  await walk(dir, "");
  return files;
}

/**
 * Signs a staged iOS app: checks the request ({@link codesignIosPlan}), embeds the person's
 * provisioning profile, runs `codesign` in `sandbox`, and accepts the result only when every file
 * changed nothing but its signature ({@link iosBundleSignatureOnlyChange}). The files signed.
 */
export async function signIosApp(sandbox: MobileSignSandbox, request: CodesignRequest): Promise<{ files: string[] }> {
  const checked = await codesignIosPlan(request);
  if (checked.provisioningProfile !== null) {
    await copyFile(checked.provisioningProfile, path.join(checked.app, PROVISIONING_PROFILE_FILE));
  }
  const admitted = await readBundleFiles(checked.app);
  await runChecked(sandbox, checked, request.toolEnv);
  const signed = await readBundleFiles(checked.app);
  if (!iosBundleSignatureOnlyChange(admitted, signed)) throw fail(MobileSignProblem.SignatureChanged);
  return { files: [...signed.keys()].sort() };
}

// ---------- what an APK signature changes ----------

const ZIP_END = { Signature: 0x06054b50, Bytes: 22, CommentMax: 0xffff, CdSizeAt: 12, CdOffsetAt: 16 } as const;
const SIGNING_BLOCK = {
  Magic: Buffer.from("APK Sig Block 42", "ascii"),
  /** The trailing size (8 bytes) and magic (16). */
  FooterBytes: 24,
  SizeBytes: 8,
  PairHeaderBytes: 12,
  /** apksigner starts the block on a 4 KiB boundary, padding the entries before it with zeros. */
  Alignment: 4096,
} as const;
/** The block entries apksigner writes: schemes v2, v3 and v3.1, and verity padding. */
const BLOCK_ENTRY = { V2: 0x7109871a, V3: 0xf05368c0, V31: 0x1b93ad61, Padding: 0x42726577 } as const;
const SCHEME_ENTRIES: ReadonlySet<number> = new Set([BLOCK_ENTRY.V2, BLOCK_ENTRY.V3, BLOCK_ENTRY.V31]);
const KNOWN_ENTRIES: ReadonlySet<number> = new Set(Object.values(BLOCK_ENTRY));

/** A zip's end record: where it sits and the central directory it names (no zip64). */
interface ZipEnd {
  at: number;
  cdOffset: number;
}

/** The end record of `bytes`, found with its comment running exactly to the end of the file. */
function zipEndOf(bytes: Buffer): ZipEnd | null {
  const last = bytes.length - ZIP_END.Bytes;
  for (let at = last; at >= 0 && at >= last - ZIP_END.CommentMax; at -= 1) {
    const found =
      bytes.readUInt32LE(at) === ZIP_END.Signature && bytes.readUInt16LE(at + 20) === bytes.length - at - ZIP_END.Bytes;
    if (!found) continue;
    const cdOffset = bytes.readUInt32LE(at + ZIP_END.CdOffsetAt);
    const contiguous = cdOffset + bytes.readUInt32LE(at + ZIP_END.CdSizeAt) === at;
    return contiguous ? { at, cdOffset } : null;
  }
  return null;
}

const endsWithBlockMagic = (bytes: Buffer, cdOffset: number): boolean =>
  cdOffset >= SIGNING_BLOCK.Magic.length &&
  bytes.subarray(cdOffset - SIGNING_BLOCK.Magic.length, cdOffset).equals(SIGNING_BLOCK.Magic);

/** Whether the block's entries run exactly to its footer, all known, at least one a signature scheme. */
function blockEntriesValid(bytes: Buffer, from: number, to: number): boolean {
  let scheme = false;
  let at = from;
  while (at < to) {
    if (at + SIGNING_BLOCK.PairHeaderBytes > to) return false;
    const length = bytes.readBigUInt64LE(at);
    const id = bytes.readUInt32LE(at + SIGNING_BLOCK.SizeBytes);
    if (length < 4n || length > BigInt(to - at - SIGNING_BLOCK.SizeBytes) || !KNOWN_ENTRIES.has(id)) return false;
    scheme ||= SCHEME_ENTRIES.has(id);
    at += SIGNING_BLOCK.SizeBytes + Number(length);
  }
  return at === to && scheme;
}

/** Where the APK Signing Block ending at `cdOffset` starts, or null when there is no valid one. */
function signingBlockStart(bytes: Buffer, cdOffset: number): number | null {
  if (!endsWithBlockMagic(bytes, cdOffset) || cdOffset < SIGNING_BLOCK.FooterBytes + SIGNING_BLOCK.SizeBytes)
    return null;
  const size = bytes.readBigUInt64LE(cdOffset - SIGNING_BLOCK.FooterBytes);
  const start = cdOffset - Number(size) - SIGNING_BLOCK.SizeBytes;
  if (size > BigInt(cdOffset) || start < 0 || bytes.readBigUInt64LE(start) !== size) return null;
  const entries = blockEntriesValid(bytes, start + SIGNING_BLOCK.SizeBytes, cdOffset - SIGNING_BLOCK.FooterBytes);
  return entries ? start : null;
}

/** The end record (and comment) with the central-directory offset zeroed, the one field signing moves. */
function endWithoutOffset(bytes: Buffer, end: ZipEnd): Buffer {
  const copy = Buffer.from(bytes.subarray(end.at));
  copy.writeUInt32LE(0, ZIP_END.CdOffsetAt);
  return copy;
}

/**
 * Whether `signed` is the unsigned `original` with an APK Signing Block added and nothing else
 * changed: the same entries byte for byte, then fewer than 4,096 zero bytes, then a block of v2,
 * v3 or v3.1 signatures (and verity padding) only, then the same central directory and end record
 * (its central-directory offset aside), ending the file.
 */
export function apkSignatureOnlyChange(original: Uint8Array, signed: Uint8Array): boolean {
  const before = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
  const after = Buffer.from(signed.buffer, signed.byteOffset, signed.byteLength);
  const was = zipEndOf(before);
  const now = zipEndOf(after);
  if (was === null || now === null || endsWithBlockMagic(before, was.cdOffset)) return false;
  const start = signingBlockStart(after, now.cdOffset);
  if (start === null) return false;
  const padding = start - was.cdOffset;
  if (padding < 0 || padding >= SIGNING_BLOCK.Alignment) return false;
  if (after.subarray(was.cdOffset, start).some((byte) => byte !== 0)) return false;
  const sameEntries = before.subarray(0, was.cdOffset).equals(after.subarray(0, was.cdOffset));
  const sameDirectory = before.subarray(was.cdOffset, was.at).equals(after.subarray(now.cdOffset, now.at));
  return sameEntries && sameDirectory && endWithoutOffset(before, was).equals(endWithoutOffset(after, now));
}

// ---------- what a Mach-O signature changes ----------

const MACH_O = {
  Magic64: 0xfeedfacf,
  HeaderBytes: 32,
  NcmdsAt: 16,
  SizeofcmdsAt: 20,
  Segment64: 0x19,
  CodeSignature: 0x1d,
  SegmentNameAt: 8,
  SegmentNameBytes: 16,
  VmsizeAt: 32,
  FileoffAt: 40,
  FilesizeAt: 48,
  DataoffAt: 8,
  DatasizeAt: 12,
  /** `CSMAGIC_EMBEDDED_SIGNATURE`, big-endian. */
  EmbeddedSignature: 0xfade0cc0,
} as const;
const LINKEDIT = "__LINKEDIT";

/** Where a thin 64-bit Mach-O's `__LINKEDIT` command and code signature sit. */
interface MachOSignatureLayout {
  linkedit: number;
  signature: number;
  dataoff: number;
}

/** Which of the two commands a load command at `at` is, if either. */
function commandKind(bytes: Buffer, at: number, cmd: number): "linkedit" | "signature" | null {
  if (cmd === MACH_O.CodeSignature) return "signature";
  if (cmd !== MACH_O.Segment64) return null;
  const name = bytes.subarray(at + MACH_O.SegmentNameAt, at + MACH_O.SegmentNameAt + MACH_O.SegmentNameBytes);
  return name.toString("latin1").replace(/\0+$/u, "") === LINKEDIT ? "linkedit" : null;
}

/** The two commands' offsets, or null when either is missing, repeated or malformed. */
function signatureCommands(bytes: Buffer): { linkedit: number; signature: number } | null {
  const ncmds = bytes.readUInt32LE(MACH_O.NcmdsAt);
  const end = MACH_O.HeaderBytes + bytes.readUInt32LE(MACH_O.SizeofcmdsAt);
  if (end > bytes.length) return null;
  const found = { linkedit: -1, signature: -1 };
  let at = MACH_O.HeaderBytes;
  for (let index = 0; index < ncmds; index += 1) {
    if (at + 8 > end) return null;
    const cmd = bytes.readUInt32LE(at);
    const size = bytes.readUInt32LE(at + 4);
    if (size < 8 || at + size > end) return null;
    const key = commandKind(bytes, at, cmd);
    if (key !== null && found[key] !== -1) return null;
    if (key !== null) found[key] = at;
    at += size;
  }
  return found.linkedit === -1 || found.signature === -1 ? null : found;
}

/** The layout of a linker- or codesign-signed thin Mach-O whose signature ends the file, or null. */
function machOLayout(bytes: Buffer): MachOSignatureLayout | null {
  if (bytes.length < MACH_O.HeaderBytes || bytes.readUInt32LE(0) !== MACH_O.Magic64) return null;
  const commands = signatureCommands(bytes);
  if (commands === null) return null;
  const dataoff = bytes.readUInt32LE(commands.signature + MACH_O.DataoffAt);
  const datasize = bytes.readUInt32LE(commands.signature + MACH_O.DatasizeAt);
  const fileoff = Number(bytes.readBigUInt64LE(commands.linkedit + MACH_O.FileoffAt));
  const filesize = Number(bytes.readBigUInt64LE(commands.linkedit + MACH_O.FilesizeAt));
  const ends = dataoff + datasize === bytes.length && fileoff + filesize === bytes.length;
  if (!ends || dataoff + 4 > bytes.length || bytes.readUInt32BE(dataoff) !== MACH_O.EmbeddedSignature) return null;
  return { ...commands, dataoff };
}

/** The image before its signature with the three fields signing rewrites zeroed. */
function machOWithoutSignatureFields(bytes: Buffer, layout: MachOSignatureLayout): Buffer {
  const copy = Buffer.from(bytes.subarray(0, layout.dataoff));
  copy.fill(0, layout.linkedit + MACH_O.VmsizeAt, layout.linkedit + MACH_O.VmsizeAt + 8);
  copy.fill(0, layout.linkedit + MACH_O.FilesizeAt, layout.linkedit + MACH_O.FilesizeAt + 8);
  copy.fill(0, layout.signature + MACH_O.DatasizeAt, layout.signature + MACH_O.DatasizeAt + 4);
  return copy;
}

/**
 * Whether `signed` is the signed thin Mach-O `original` (arm64 binaries are always linker-signed)
 * re-signed and nothing else: the same image up to the code signature, which starts where it did,
 * the code signature's size and `__LINKEDIT`'s sizes aside, then a new embedded signature ending
 * the file. An identical file passes too (a binary codesign had nothing to change in).
 */
export function machOSignatureOnlyChange(original: Uint8Array, signed: Uint8Array): boolean {
  const before = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
  const after = Buffer.from(signed.buffer, signed.byteOffset, signed.byteLength);
  const was = machOLayout(before);
  const now = machOLayout(after);
  if (was === null || now === null) return false;
  const samePlaces = was.linkedit === now.linkedit && was.signature === now.signature && was.dataoff === now.dataoff;
  return samePlaces && machOWithoutSignatureFields(before, was).equals(machOWithoutSignatureFields(after, now));
}

const isMachO = (bytes: Buffer): boolean => bytes.length >= 4 && bytes.readUInt32LE(0) === MACH_O.Magic64;
const machOResigned = (before: Buffer, after: Buffer): boolean =>
  isMachO(before) && machOSignatureOnlyChange(before, after);

/**
 * Whether a signed app's files are the admitted app's with signatures changed only: every admitted
 * file still there, byte for byte, or (a Mach-O) re-signed per {@link machOSignatureOnlyChange};
 * `_CodeSignature/CodeResources` there, and the only file added or rewritten otherwise.
 */
export function iosBundleSignatureOnlyChange(
  original: ReadonlyMap<string, Buffer>,
  signed: ReadonlyMap<string, Buffer>,
): boolean {
  for (const [name, bytes] of original) {
    const after = signed.get(name);
    if (after === undefined) return false;
    const signatureOnly = bytes.equals(after) || name === CODE_RESOURCES || machOResigned(bytes, after);
    if (!signatureOnly) return false;
  }
  const added = [...signed.keys()].filter((name) => !original.has(name));
  return signed.has(CODE_RESOURCES) && added.every((name) => name === CODE_RESOURCES);
}
