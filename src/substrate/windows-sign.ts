/**
 * The optional Windows signing step (D20 = A): Windows exports are unsigned by default, and only
 * when the person chooses to sign with their **own** code-signing certificate does the export get
 * a `jsign` argv that signs the executable and ANGLE's two DLLs with an RFC 3161 timestamp.
 * Microsoft's `d3dcompiler_47.dll` already carries Microsoft's signature and is never re-signed.
 *
 * Nothing here names a certificate, a keystore or a default: every field comes from the person's
 * choice, is checked against a fixed table or a strict pattern, and a keystore inside the games
 * root, Genex's own data or any other forbidden root (after `realpath`) is refused, so neither an
 * agent-written file nor Genex's identity can be signed with. The harness may never ask to sign.
 *
 * The keystore password (or token PIN) never enters argv, where `ps` and logs would show it: argv
 * names `env:GENEX_JSIGN_STOREPASS`, jsign's own environment reference, and the value travels only
 * in {@link JsignPlan.env}; `secretValues` hands it to the log redactor. When Genex runs on Windows
 * a password is refused (`windows-host-password`): srt-win hands a run its environment through a
 * file in the sandbox's scratch folder, which the sandbox user can read.
 *
 * {@link jsignRunRequest} turns a plan into one `ProcessSandbox.run` request: the sandbox's clean
 * environment plus the plan's, the staging folder writable, and the RFC 3161 server opened. That
 * confinement holds only in a sandbox of jsign's own ({@link jsignSandboxOptions}): its one
 * writable root the export's host-private staging folder, a private scratch, no domain another run
 * opened. Run in the studio's shared sandbox, the overlay would add to the agents' writable roots
 * and domains instead. {@link runJsign} runs it and redacts the password from what it answers.
 * A key on a token or HSM is refused there: the sandbox has no smart-card (PC/SC, USB) profile.
 * {@link signatureOnlyChange} is how the export checks that jsign changed nothing but the signature.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { JsignStoreType, TIMESTAMP_AUTHORITIES } from "../shared/game-export-contract.ts";
import { redactValues } from "../shared/redact.ts";
import { WindowsRuntimeFile } from "./native-runtime-files.ts";
import { isInside } from "./paths.ts";
import { shellQuote } from "./shell-quote.ts";
import type { RunRequest, RunResult, SandboxOptions } from "./spawn.ts";

/** Whether a Windows export is signed. Unsigned is the default. Never rename a value. */
export const WindowsSigningKind = { Unsigned: "unsigned", OwnCertificate: "own-certificate" } as const;
export type WindowsSigningKind = (typeof WindowsSigningKind)[keyof typeof WindowsSigningKind];

/** Who asked for the export: only a person may sign. */
export const SigningRequester = { Person: "person", Harness: "harness" } as const;
export type SigningRequester = (typeof SigningRequester)[keyof typeof SigningRequester];

/** Whether each store type takes a keystore file, and whether its key lives on hardware (PC/SC, USB). */
const STORE_NEEDS = {
  [JsignStoreType.Pkcs12]: { keystore: true, hardware: false },
  [JsignStoreType.Jks]: { keystore: true, hardware: false },
  [JsignStoreType.Pkcs11]: { keystore: true, hardware: true },
  [JsignStoreType.Yubikey]: { keystore: false, hardware: true },
  [JsignStoreType.Piv]: { keystore: false, hardware: true },
  [JsignStoreType.Etoken]: { keystore: false, hardware: true },
} as const satisfies Record<JsignStoreType, { keystore: boolean; hardware: boolean }>;

/** The environment variable argv names for the keystore password, by jsign's `env:` reference. */
export const JSIGN_STOREPASS_ENV = "GENEX_JSIGN_STOREPASS";

/** Starts with a letter or digit, so jsign's option parser never reads the alias as a flag. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTROL = /\p{Cc}/u;
const PASSWORD_MAX_CHARS = 1024;
const PROGRAM_NAME_MAX_CHARS = 200;
const PE_NAME = /\.(exe|dll)$/iu;
/** Already signed by Microsoft; re-signing would modify a Microsoft redistributable. */
const MICROSOFT_SIGNED = new Set([WindowsRuntimeFile.D3dCompiler.toLowerCase()]);
/** How long one jsign run may take: signing three files plus one timestamp request each. */
const JSIGN_TIMEOUT_MS = 5 * MINUTE_MS;
/** jsign's output kept for the error a failed run reports. */
const JSIGN_OUTPUT_MAX_BYTES = 256 * 1024;
/** The sandbox's label for the run, in its violation log. */
const JSIGN_LABEL = "jsign";
/** A proxy host a `-D` property can carry as one word: a name, an IPv4 address or a bracketed IPv6 one. */
const PROXY_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})|\[[0-9A-Fa-f:.]{2,45}\])$/u;
const PORT_MAX = 65_535;

/** Why a signing request was refused before any argv existed. Never rename a value. */
export const WindowsSignProblem = {
  HarnessMayNotSign: "harness-may-not-sign",
  StoreType: "store-type",
  Keystore: "keystore",
  KeystoreForbidden: "keystore-forbidden",
  Alias: "alias",
  Timestamp: "timestamp",
  Password: "password",
  ProgramName: "program-name",
  Target: "target",
  Tool: "tool",
  /** The key is on a token or HSM, and the sandbox gives jsign no smart-card access. */
  HardwareToken: "hardware-token",
  /** A keystore password while Genex runs on Windows: srt-win would hand it to jsign in a file the sandbox user can read. */
  WindowsHostPassword: "windows-host-password",
} as const;
export type WindowsSignProblem = (typeof WindowsSignProblem)[keyof typeof WindowsSignProblem];

/** Messages name the field, never a value the person typed into it (a password pasted into the alias stays private). */
const MESSAGE = {
  [WindowsSignProblem.HarnessMayNotSign]: "Only you can sign an export; the agent may export unsigned only.",
  [WindowsSignProblem.StoreType]: "The keystore type is not one Genex can sign with.",
  [WindowsSignProblem.Keystore]:
    "The keystore must be an existing file named by its full path (hardware tokens take none).",
  [WindowsSignProblem.KeystoreForbidden]:
    "The keystore is inside a game, Genex's own data or another folder Genex does not sign from.",
  [WindowsSignProblem.Alias]:
    "The key alias may hold only letters, digits, dots, dashes and underscores (1 to 64), starting with a letter or digit.",
  [WindowsSignProblem.Timestamp]: "The timestamp server must be one from Genex's list.",
  [WindowsSignProblem.Password]: "The keystore password is empty or holds a character it cannot carry.",
  [WindowsSignProblem.ProgramName]:
    "The program name for the signature is empty, too long or holds a control character.",
  [WindowsSignProblem.Target]: "Only the export's own .exe and ANGLE DLLs, inside the export folder, are signed.",
  [WindowsSignProblem.Tool]: "jsign must be named by its full path.",
  [WindowsSignProblem.HardwareToken]:
    "Signing with a key on a hardware token or HSM is not available yet: Genex runs jsign without smart-card access.",
  [WindowsSignProblem.WindowsHostPassword]:
    "Signing with a keystore password is not available while Genex runs on Windows yet: export unsigned, or sign on a Mac or Linux computer.",
} as const satisfies Record<WindowsSignProblem, string>;

/** A refused signing request, typed. Its message never holds a password. */
export class WindowsSignError extends Error {
  readonly code: WindowsSignProblem;

  constructor(code: WindowsSignProblem) {
    super(MESSAGE[code]);
    this.name = "WindowsSignError";
    this.code = code;
  }
}

/** The person's choice of certificate, as typed in the export sheet (strings until checked). */
export interface OwnCertificateChoice {
  kind: typeof WindowsSigningKind.OwnCertificate;
  storeType: string;
  /** Absolute path of the keystore file; null for a hardware token. */
  keystore: string | null;
  alias: string;
  timestampUrl: string;
  /** The keystore password or token PIN; null when jsign needs none. */
  password: string | null;
}

/** How a Windows export is signed. */
export type WindowsSigningChoice = { kind: typeof WindowsSigningKind.Unsigned } | OwnCertificateChoice;

/** Everything one jsign run needs; the export flow supplies all but `choice`. */
export interface JsignRequest {
  choice: WindowsSigningChoice;
  requestedBy: SigningRequester;
  /** The OS Genex itself runs on: on Windows a keystore password is refused (`windows-host-password`). */
  host: StudioPlatform;
  /** How jsign is launched: its script, or `java` with `["-jar", <jsign.jar>]`. */
  tool: { file: string; args: readonly string[] };
  /** The signature's program name, shown by Windows' prompts: the game's title. */
  programName: string;
  /** The staged export folder every target must be inside. */
  stagingDir: string;
  /** Absolute paths to sign (see {@link windowsSignTargets}). */
  targets: readonly string[];
  /** Folders a keystore may never come from: the games root, scratch, Genex's userData and resources. */
  forbiddenRoots: readonly string[];
}

/** A checked jsign run. `display` is the log line (no secrets); `env` holds the password, if any. */
export interface JsignPlan {
  file: string;
  args: string[];
  env: Record<string, string>;
  display: string;
  secretValues: string[];
  /** The only hosts the sandboxed run may reach: the chosen timestamp server. */
  allowedDomains: string[];
  /** The key is on a token or HSM, so the run needs smart-card (PC/SC) or USB access the default sandbox denies. */
  hardwareToken: boolean;
  /** The staging folder's real path: the run's working folder and the only place it writes. */
  stagingDir: string;
  /** The files signed, by their real paths, in argv order. */
  targets: string[];
}

/** What a signing request is checked for before anything is staged: all of it but the staged files. */
export type JsignPreflightRequest = Omit<JsignRequest, "stagingDir" | "targets">;

/** What the preflight learned about a choice that passes. */
export interface JsignPreflight {
  hardwareToken: boolean;
}

const fail = (code: WindowsSignProblem) => new WindowsSignError(code);

/** The files a signed export signs: the game's executable and ANGLE's two DLLs, never Microsoft's compiler. */
export function windowsSignTargets(gameDir: string, exeName: string): string[] {
  return [
    path.join(gameDir, exeName),
    path.join(gameDir, WindowsRuntimeFile.Egl),
    path.join(gameDir, WindowsRuntimeFile.Gles),
  ];
}

const isStoreType = (value: string): value is JsignStoreType => Object.values<string>(JsignStoreType).includes(value);
const isAuthority = (value: string): boolean => (TIMESTAMP_AUTHORITIES as readonly string[]).includes(value);
/** An absolute path a spawn can take as one argument: no control characters (absolute is never option-shaped). */
const isPlainAbsolute = (value: string): boolean => path.isAbsolute(value) && !CONTROL.test(value);

function checkTool(tool: JsignRequest["tool"]): void {
  const clean = isPlainAbsolute(tool.file) && tool.args.every((arg) => !CONTROL.test(arg));
  if (!clean) throw fail(WindowsSignProblem.Tool);
}

function checkProgramName(name: string): void {
  const length = Array.from(name).length;
  const valid = length > 0 && length <= PROGRAM_NAME_MAX_CHARS && !CONTROL.test(name) && !name.startsWith("-");
  if (!valid) throw fail(WindowsSignProblem.ProgramName);
}

function checkPassword(password: string | null): void {
  if (password === null) return;
  const valid = password.length > 0 && password.length <= PASSWORD_MAX_CHARS && !password.includes("\u0000");
  if (!valid) throw fail(WindowsSignProblem.Password);
}

/** The real path of an existing folder, or the resolved path of one that does not exist yet. */
async function realOrResolved(dir: string): Promise<string> {
  return realpath(dir).catch(() => path.resolve(dir));
}

/** The keystore's real path, checked: a regular file outside every forbidden root; null for a token. */
async function checkKeystore(
  storeType: JsignStoreType,
  keystore: string | null,
  forbidden: readonly string[],
): Promise<string | null> {
  if (!STORE_NEEDS[storeType].keystore) {
    if (keystore !== null) throw fail(WindowsSignProblem.Keystore);
    return null;
  }
  if (keystore === null || !isPlainAbsolute(keystore)) throw fail(WindowsSignProblem.Keystore);
  const real = await realpath(keystore).catch(() => null);
  const info = real === null ? null : await stat(real).catch(() => null);
  if (real === null || !info?.isFile()) throw fail(WindowsSignProblem.Keystore);
  for (const root of forbidden) {
    if (isInside(await realOrResolved(root), real)) throw fail(WindowsSignProblem.KeystoreForbidden);
  }
  return real;
}

/** One target's real path: a regular non-link .exe/.dll inside the staging folder that Microsoft did not sign. */
async function checkTarget(file: string, staging: string): Promise<string> {
  const named = isPlainAbsolute(file) && PE_NAME.test(file) && !MICROSOFT_SIGNED.has(path.basename(file).toLowerCase());
  if (!named) throw fail(WindowsSignProblem.Target);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) throw fail(WindowsSignProblem.Target);
  // A target removed between the lstat and here is refused like a missing one.
  const real = await realpath(file).catch(() => null);
  if (real === null || !isInside(staging, real) || real === staging) throw fail(WindowsSignProblem.Target);
  return real;
}

async function checkTargets(targets: readonly string[], stagingDir: string): Promise<string[]> {
  if (targets.length === 0) throw fail(WindowsSignProblem.Target);
  const staging = await realOrResolved(stagingDir);
  const real: string[] = [];
  for (const file of targets) real.push(await checkTarget(file, staging));
  if (new Set(real).size !== real.length) throw fail(WindowsSignProblem.Target);
  return real;
}

/** The person's choice, every field checked; the keystore resolved to its real path. */
async function checkChoice(choice: OwnCertificateChoice, forbidden: readonly string[]) {
  if (!isStoreType(choice.storeType)) throw fail(WindowsSignProblem.StoreType);
  if (!ALIAS.test(choice.alias)) throw fail(WindowsSignProblem.Alias);
  if (!isAuthority(choice.timestampUrl)) throw fail(WindowsSignProblem.Timestamp);
  checkPassword(choice.password);
  const keystore = await checkKeystore(choice.storeType, choice.keystore, forbidden);
  return { storeType: choice.storeType, keystore, alias: choice.alias, timestampUrl: choice.timestampUrl };
}

/** The person's checked choice, or null when unsigned; refused for the harness before anything is read. */
async function checkedRequest(request: JsignPreflightRequest) {
  const { choice } = request;
  if (choice.kind === WindowsSigningKind.Unsigned) return null;
  if (request.requestedBy !== SigningRequester.Person) throw fail(WindowsSignProblem.HarnessMayNotSign);
  const passwordOnWindows = request.host === StudioPlatform.Windows && choice.password !== null;
  if (passwordOnWindows) throw fail(WindowsSignProblem.WindowsHostPassword);
  checkTool(request.tool);
  checkProgramName(request.programName);
  return { choice, checked: await checkChoice(choice, request.forbiddenRoots) };
}

/**
 * Every check {@link jsignPlan} makes but the staged files', with the same refusals, so an export
 * refuses a signing request before it stages anything; null when the export is unsigned.
 */
export async function jsignPreflight(request: JsignPreflightRequest): Promise<JsignPreflight | null> {
  const passed = await checkedRequest(request);
  return passed === null ? null : { hardwareToken: STORE_NEEDS[passed.checked.storeType].hardware };
}

/**
 * The jsign run for an export the person chose to sign with their own certificate, or null when
 * the export is unsigned. Every field is checked first; a refusal is a {@link WindowsSignError}
 * and nothing has been read beyond `stat`/`realpath`, written or spawned.
 */
export async function jsignPlan(request: JsignRequest): Promise<JsignPlan | null> {
  const passed = await checkedRequest(request);
  if (passed === null) return null;
  const { choice, checked } = passed;
  const targets = await checkTargets(request.targets, request.stagingDir);
  const args = [
    ...request.tool.args,
    "--storetype",
    checked.storeType,
    ...(checked.keystore === null ? [] : ["--keystore", checked.keystore]),
    "--alias",
    checked.alias,
    ...(choice.password === null ? [] : ["--storepass", `env:${JSIGN_STOREPASS_ENV}`]),
    "--alg",
    "SHA-256",
    "--tsaurl",
    checked.timestampUrl,
    "--tsmode",
    "RFC3161",
    "--name",
    request.programName,
    ...targets,
  ];
  const password = choice.password;
  return {
    file: request.tool.file,
    args,
    env: password === null ? {} : { [JSIGN_STOREPASS_ENV]: password },
    display: [request.tool.file, ...args].map(shellQuote).join(" "),
    secretValues: password === null ? [] : [password],
    allowedDomains: [new URL(checked.timestampUrl).host],
    hardwareToken: STORE_NEEDS[checked.storeType].hardware,
    stagingDir: await realOrResolved(request.stagingDir),
    targets,
  };
}

/** The proxy a sandboxed run reaches the network through, as the host knows it. */
export interface JavaProxy {
  host: string;
  port: number;
}

/** One sandboxed jsign run: the `ProcessSandbox.run` request, what its redactor removes, and the files it signs. */
export interface JsignRun {
  request: RunRequest;
  secretValues: string[];
  targets: string[];
}

/** What the export needs back from a jsign run. */
export type JsignRunResult = Pick<RunResult, "code" | "stdout" | "stderr" | "timedOut">;

/** Java's proxy properties for `proxy`, which the JVM reads from `JAVA_TOOL_OPTIONS`; throws on a malformed proxy. */
function javaProxyOptions(proxy: JavaProxy): string {
  const valid = PROXY_HOST.test(proxy.host) && Number.isInteger(proxy.port) && proxy.port > 0 && proxy.port <= PORT_MAX;
  if (!valid) throw new TypeError("a jsign proxy is a host name or address and a port");
  const { host, port } = proxy;
  return [
    `-Dhttp.proxyHost=${host}`,
    `-Dhttp.proxyPort=${port}`,
    `-Dhttps.proxyHost=${host}`,
    `-Dhttps.proxyPort=${port}`,
  ].join(" ");
}

/**
 * The `ProcessSandbox.run` request for a checked plan: its argv as one quoted command line, run in
 * the staging folder, the sandbox's clean environment plus the plan's (and `JAVA_TOOL_OPTIONS`
 * naming the sandbox's proxy when the host knows it), writes only in the staging folder and
 * network only to the timestamp server. Pure. A key on a token or HSM is refused
 * ({@link WindowsSignProblem.HardwareToken}): the sandbox has no smart-card profile.
 */
export function jsignRunRequest(plan: JsignPlan, options: { proxy?: JavaProxy } = {}): JsignRun {
  if (plan.hardwareToken) throw fail(WindowsSignProblem.HardwareToken);
  const proxy: Record<string, string> = options.proxy ? { JAVA_TOOL_OPTIONS: javaProxyOptions(options.proxy) } : {};
  return {
    request: {
      command: plan.display,
      cwd: plan.stagingDir,
      env: { ...plan.env, ...proxy },
      timeoutMs: JSIGN_TIMEOUT_MS,
      policy: { allowedDomains: [...plan.allowedDomains], allowWrite: [plan.stagingDir] },
      label: JSIGN_LABEL,
      maxOutputBytes: JSIGN_OUTPUT_MAX_BYTES,
    },
    secretValues: [...plan.secretValues],
    targets: [...plan.targets],
  };
}

/** What a jsign run's own sandbox is made from. */
export interface JsignSandboxRequest {
  /** This export's staging folder, in the host-private signing folder no agent process may write. */
  staging: string;
  /** A private scratch folder for the run (its TMPDIR; on Windows its env file): never the agents'. */
  scratch: string;
  /** Paths no process may read or write (the studio's protected paths). */
  secretPaths: readonly string[];
  /** The write denies every studio sandbox starts with; one holding the staging folder is left out. */
  denyWrite: readonly string[];
}

/**
 * The options of the sandbox one jsign run gets to itself, as a prewarm does: its staging folder
 * the one writable root, a private scratch, no domain another run opened (the run's overlay opens
 * only the timestamp server). The studio's shared sandbox must not run jsign: its writable roots
 * are the agents', and on Windows its scratch (the agents' TMPDIR) would hold the run's env file.
 */
export function jsignSandboxOptions(request: JsignSandboxRequest): SandboxOptions {
  return {
    writableRoots: [request.staging],
    scratchDir: request.scratch,
    secretPaths: [...request.secretPaths],
    denyWrite: request.denyWrite.filter((deny) => !isInside(deny, request.staging)),
  };
}

/** Adds only the sandbox's validated filtering proxy to Java's environment. */
export function withJsignProxy(run: JsignRun, proxy: JavaProxy): JsignRun {
  return {
    ...run,
    request: { ...run.request, env: { ...run.request.env, JAVA_TOOL_OPTIONS: javaProxyOptions(proxy) } },
  };
}

/** Runs one jsign request in `sandbox` and answers its result with the password redacted from the output. */
export async function runJsign(
  sandbox: { run(request: RunRequest): Promise<RunResult> },
  run: JsignRun,
): Promise<JsignRunResult> {
  const result = await sandbox.run(run.request);
  return {
    code: result.code,
    stdout: redactValues(result.stdout, run.secretValues),
    stderr: redactValues(result.stderr, run.secretValues),
    timedOut: result.timedOut,
  };
}

// ---------- what a signature changes ----------

/** Where a PE image's offset sits, and the optional-header fields Authenticode touches. */
const PE = {
  OffsetAt: 0x3c,
  /** From the `PE\0\0` signature to the optional header: the signature and the COFF header. */
  OptionalFromSignature: 24,
  ChecksumInOptional: 64,
  Pe32Magic: 0x10b,
  Pe32PlusMagic: 0x20b,
  /** `NumberOfRvaAndSizes`, then the data directories, for each optional-header kind. */
  CountInOptional: { pe32: 92, pe32Plus: 108 },
  DirectoriesInOptional: { pe32: 96, pe32Plus: 112 },
  DirectoryBytes: 8,
  /** The certificate table's data directory. */
  SecurityDirectory: 4,
  /** Authenticode aligns the certificate table to eight bytes. */
  CertificateAlignment: 8,
} as const;
const PE_SIGNATURE = 0x0000_4550;

/** The file offsets of a PE image's checksum and security directory, and the certificate table it names. */
interface SignatureLayout {
  checksum: number;
  directory: number;
  table: { offset: number; size: number };
}

/** The layout of `bytes` as a PE image, or null when they are not one this check can read. */
function signatureLayout(bytes: Buffer): SignatureLayout | null {
  if (bytes.length < PE.OffsetAt + 4) return null;
  const signature = bytes.readUInt32LE(PE.OffsetAt);
  const optional = signature + PE.OptionalFromSignature;
  if (optional + PE.DirectoriesInOptional.pe32Plus > bytes.length) return null;
  if (bytes.readUInt32LE(signature) !== PE_SIGNATURE) return null;
  const magic = bytes.readUInt16LE(optional);
  const plus = magic === PE.Pe32PlusMagic;
  if (!plus && magic !== PE.Pe32Magic) return null;
  const count = bytes.readUInt32LE(optional + (plus ? PE.CountInOptional.pe32Plus : PE.CountInOptional.pe32));
  const directories = optional + (plus ? PE.DirectoriesInOptional.pe32Plus : PE.DirectoriesInOptional.pe32);
  const directory = directories + PE.SecurityDirectory * PE.DirectoryBytes;
  if (count <= PE.SecurityDirectory || directory + PE.DirectoryBytes > bytes.length) return null;
  const table = { offset: bytes.readUInt32LE(directory), size: bytes.readUInt32LE(directory + 4) };
  return { checksum: optional + PE.ChecksumInOptional, directory, table };
}

/** `bytes` with the fields a signature rewrites (the checksum and the security directory) zeroed. */
function withoutSignatureFields(bytes: Buffer, layout: SignatureLayout): Buffer {
  const copy = Buffer.from(bytes);
  copy.fill(0, layout.checksum, layout.checksum + 4);
  copy.fill(0, layout.directory, layout.directory + PE.DirectoryBytes);
  return copy;
}

/** The bytes a signature covers: the image up to its certificate table, or all of it when unsigned. */
function unsignedBody(bytes: Buffer, layout: SignatureLayout): Buffer | null {
  if (layout.table.size === 0) return bytes;
  const ends = layout.table.offset + layout.table.size === bytes.length;
  return ends && layout.table.offset > layout.directory ? bytes.subarray(0, layout.table.offset) : null;
}

/**
 * Whether `signed` is `original` with an Authenticode signature added and nothing else changed:
 * the same image up to the end of `original` (the checksum and security directory aside), then at
 * most seven zero bytes of alignment, then the certificate table the security directory names,
 * ending the file. The export checks every file jsign signed this way before it packs it.
 */
export function signatureOnlyChange(original: Uint8Array, signed: Uint8Array): boolean {
  const before = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
  const after = Buffer.from(signed.buffer, signed.byteOffset, signed.byteLength);
  const was = signatureLayout(before);
  const now = signatureLayout(after);
  if (was === null || now === null || now.table.size === 0) return false;
  if (was.checksum !== now.checksum || was.directory !== now.directory) return false;
  const body = unsignedBody(before, was);
  const signedBody = unsignedBody(after, now);
  if (body === null || signedBody === null) return false;
  const padding = signedBody.length - body.length;
  if (padding < 0 || padding >= PE.CertificateAlignment) return false;
  if (signedBody.subarray(body.length).some((byte) => byte !== 0)) return false;
  const head = signedBody.subarray(0, body.length);
  return withoutSignatureFields(body, was).equals(withoutSignatureFields(head, now));
}
