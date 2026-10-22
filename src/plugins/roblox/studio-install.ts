/**
 * Get Roblox Studio from nothing, in the order Roblox's own installer sets: download Roblox's
 * installer, check Roblox signed it, run it, wait for Studio, let the person sign in in the Studio
 * the installer opens (it closes by itself once they have), set Studio up for Genex while it is
 * closed, and open it again once. Signing in stays the person's own step; Genex never sees it.
 *
 * - The installer comes only from Roblox's per-system link on `setup.rbxcdn.com`, over HTTPS, with
 *   every redirect checked before it is followed, and only up to `MAX_INSTALLER_BYTES`. Roblox
 *   changes its installers with every release, so nothing here pins a hash: the signature is the
 *   check. Node's downloads carry no quarantine mark, so that check is Genex's to make.
 * - Mac: `codesign` must accept the DMG and the installer app inside it against Genex's own
 *   requirement (a Developer ID certificate Apple vouches for, issued to Roblox's team; a
 *   signature's own requirement is the signer's word), and name that team; Gatekeeper must accept
 *   the app. The DMG is attached read-only and unbrowsed in a private folder and always detached.
 * - Windows: Authenticode must call the installer Valid and signed by Roblox Corporation.
 *   PowerShell reads the path from its own environment, so no path is ever part of a command.
 * - Nothing runs when a check fails, and the private temporary folder is always removed.
 * - The installer and Studio are the person's vendor apps, run outside Genex's process sandbox:
 *   installing for the person is the whole purpose, and Studio's sign-in must work. Every program
 *   is an argument list, never a shell string. Genex never closes Studio.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { envValue } from "../../substrate/toolchain.ts";
import { type LaunchDeps, openLaunch } from "./studio-launch.ts";
import { isWindowsPath, locateStudio, type StudioInstall, studioRunning } from "./studio-locate.ts";
import { MESSAGE } from "./words.ts";

/** Roblox's own installer for each system Studio runs on. */
export const INSTALLER = {
  darwin: { url: "https://setup.rbxcdn.com/mac/RobloxStudio.dmg", file: "RobloxStudio.dmg", megabytes: 11 },
  win32: {
    url: "https://setup.rbxcdn.com/RobloxStudioInstaller.exe",
    file: "RobloxStudioInstaller.exe",
    megabytes: 14,
  },
} as const;
type InstallerSystem = keyof typeof INSTALLER;

/** The one host an installer may come from, matched exactly. */
export const ALLOWED_HOST = "setup.rbxcdn.com";
/** The largest installer Genex downloads; Roblox's are about 11 MB (Mac) and 14 MB (Windows). */
export const MAX_INSTALLER_BYTES = 64 * 1024 * 1024;
/** Roblox's Apple developer team, as codesign names it. */
export const ROBLOX_TEAM_ID = "2CFABCH843";
/** Roblox's name on its Windows code-signing certificate. */
export const ROBLOX_SIGNER = "Roblox Corporation";
/** The installer app inside Roblox's DMG. */
export const MAC_INSTALLER_APP = "RobloxStudioInstaller.app";
/** How long the download may take. */
export const DOWNLOAD_TIMEOUT_MS = 10 * MINUTE_MS;
/** How long Roblox's installer may run: it downloads Studio itself. */
export const INSTALLER_RUN_MS = 30 * MINUTE_MS;
/** How long Genex waits for Studio to be on this computer once the installer has run. */
export const INSTALL_WAIT_MS = 10 * MINUTE_MS;
/** How long Genex waits for the installer's Studio to open. */
export const STUDIO_START_WAIT_MS = 2 * MINUTE_MS;
/** How long the person has to sign in before Genex stops waiting for that Studio to close. */
export const SIGN_IN_WAIT_MS = 30 * MINUTE_MS;
/** How often the waits look again. */
const INSTALL_POLL_MS = 2 * SECOND_MS;
/** How long a signature check or a mount may take. */
const CHECK_TIMEOUT_MS = MINUTE_MS;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CODESIGN = "/usr/bin/codesign";
const SPCTL = "/usr/sbin/spctl";
/**
 * What Genex requires of Roblox's signature: Apple's root, Apple's Developer ID authority, and
 * Roblox's team in the leaf certificate. Without it `--verify` checks the signature only against
 * the requirement its signer wrote.
 */
const ROBLOX_REQUIREMENT = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = "${ROBLOX_TEAM_ID}"`;
const HDIUTIL = "/usr/bin/hdiutil";
const MAC_OPEN = "/usr/bin/open";
const WINDOWS_ROOT = "C:\\Windows";
const TEMP_PREFIX = "genex-roblox-install-";
const MOUNT_FOLDER = "volume";
/** The variable PowerShell reads the installer's path from. */
const INSTALLER_VARIABLE = "GENEX_INSTALLER";
const TEAM_LINE = /^TeamIdentifier=(.+)$/m;
/** A subject's CN or O, quoted or not. */
const SUBJECT_NAME = /(?:^|,)\s*(CN|O)=(?:"([^"]*)"|([^,]*))/g;

/** Authenticode's verdict and the signer's subject, as one line of JSON. */
const POWERSHELL_SIGNATURE = [
  "$ErrorActionPreference = 'Stop'",
  `$signature = Get-AuthenticodeSignature -LiteralPath $env:${INSTALLER_VARIABLE}`,
  "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
  "[pscustomobject]@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress",
].join("; ");

/** Where Get Roblox Studio is. Wire values: never rename. */
export const InstallPhase = {
  Downloading: "downloading",
  Checking: "checking",
  Installing: "installing",
  /** The installer has run; Studio isn't on this computer yet. */
  WaitingForStudio: "waiting-for-studio",
  /** The installer's Studio is open for the person to sign in; it closes by itself after. */
  SigningIn: "signing-in",
  SettingUp: "setting-up",
  Opening: "opening",
  Done: "done",
  Failed: "failed",
} as const;
export type InstallPhase = (typeof InstallPhase)[keyof typeof InstallPhase];

/** Why Get Roblox Studio stopped. Wire values: never rename. */
export const InstallRefusal = {
  Unsupported: "unsupported",
  NotHttps: "not-https",
  OtherHost: "other-host",
  TooLarge: "too-large",
  DownloadFailed: "download-failed",
  Unsigned: "unsigned",
  WrongSigner: "wrong-signer",
  NoInstaller: "no-installer",
  InstallerFailed: "installer-failed",
  Cancelled: "cancelled",
  /** The installer ran but Studio didn't appear in time. */
  NotInstalled: "not-installed",
  /** The installer's Studio stayed open: the person hasn't signed in yet. */
  StillOpen: "still-open",
} as const;
export type InstallRefusal = (typeof InstallRefusal)[keyof typeof InstallRefusal];

/** A stop on the way to Studio, in plain words. */
export class InstallError extends Error {
  readonly code: InstallRefusal;
  constructor(code: InstallRefusal) {
    super(MESSAGE.Install.Refused[code]());
    this.name = "InstallError";
    this.code = code;
  }
}

/** A program's exit code and both of what it printed (codesign answers on stderr). */
export interface InstallCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How a program runs: its limit, extra environment, and whether its window is the person's. */
export interface InstallRunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Roblox's installer: its window shows. */
  visible?: boolean;
}

/** Runs a program by its full path with an argument list, never a shell; rejects when it can't start. */
export type InstallRun = (
  file: string,
  args: readonly string[],
  options: InstallRunOptions,
) => Promise<InstallCommandResult>;

/** The computer and the network the install works with; tests hand in fakes. */
export interface InstallDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  run: InstallRun;
  /** Where the private temporary folder is made. */
  tempRoot: string;
  /** A signal that ends after `ms`; the system's timer by default. */
  timeout?(ms: number): AbortSignal;
}

/** What one Get Roblox Studio is given: the person's Stop, where to report its phase, and (tests) a link. */
export interface InstallOptions {
  signal: AbortSignal;
  onPhase?(phase: InstallPhase): void;
  /** Roblox's link for this system unless given. */
  url?: string;
}

const isInstallerSystem = (platform: NodeJS.Platform): platform is InstallerSystem => platform in INSTALLER;

/** A link Genex may fetch an installer from: HTTPS and exactly Roblox's setup host. */
function checkedUrl(raw: string, base?: string): URL {
  const url = new URL(raw, base);
  if (url.protocol !== "https:") throw new InstallError(InstallRefusal.NotHttps);
  if (url.hostname !== ALLOWED_HOST || url.port !== "" || url.username || url.password)
    throw new InstallError(InstallRefusal.OtherHost);
  return url;
}

/** A stop the person asked for, as the install's own refusal. */
function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new InstallError(InstallRefusal.Cancelled);
}

/** The installer's response, after following only redirects that stay on Roblox's host over HTTPS. */
async function fetchChecked(fetchFn: typeof fetch, url: URL, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchFn(current.href, { redirect: "manual", signal });
    if (!REDIRECT_STATUS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) throw new InstallError(InstallRefusal.DownloadFailed);
    current = checkedUrl(location, current.href);
  }
  throw new InstallError(InstallRefusal.DownloadFailed);
}

/** Reads `body` into `file`, never past `maxBytes`; a Stop cancels the read at once. */
async function writeCapped(body: ReadableStream<Uint8Array>, file: string, maxBytes: number, signal: AbortSignal) {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  const handle = await open(file, "wx", 0o600);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      throwIfStopped(signal);
      if (done) return size;
      size += value.byteLength;
      if (size > maxBytes) throw new InstallError(InstallRefusal.TooLarge);
      await handle.write(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await handle.close();
    if (size > maxBytes || signal.aborted) await reader.cancel().catch(() => undefined);
  }
}

/**
 * Downloads Roblox's installer into `dir` as `file`: HTTPS only, redirects only within Roblox's
 * setup host, the size capped before and while reading. Rejects with an `InstallError`.
 */
export async function downloadInstaller(
  fetchFn: typeof fetch,
  options: { url: string; dir: string; file: string; signal: AbortSignal; maxBytes?: number },
): Promise<string> {
  const { signal } = options;
  const maxBytes = options.maxBytes ?? MAX_INSTALLER_BYTES;
  const url = checkedUrl(options.url);
  throwIfStopped(signal);
  const response = await fetchChecked(fetchFn, url, signal).catch((error: unknown) => {
    if (error instanceof InstallError) throw error;
    throwIfStopped(signal);
    throw new InstallError(InstallRefusal.DownloadFailed);
  });
  if (!response.ok || !response.body) throw new InstallError(InstallRefusal.DownloadFailed);
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (declared > maxBytes) throw new InstallError(InstallRefusal.TooLarge);
  const target = path.join(options.dir, options.file);
  const size = await writeCapped(response.body, target, maxBytes, signal).catch((error: unknown) => {
    if (error instanceof InstallError) throw error;
    throwIfStopped(signal);
    throw new InstallError(InstallRefusal.DownloadFailed);
  });
  if (Number.isFinite(declared) && size !== declared) throw new InstallError(InstallRefusal.DownloadFailed);
  return target;
}

/** Runs a program; one that can't start or runs past its limit is `refusal`. */
async function runOr(
  deps: InstallDeps,
  refusal: InstallRefusal,
  command: { file: string; args: readonly string[]; options: InstallRunOptions },
): Promise<InstallCommandResult> {
  return deps.run(command.file, command.args, command.options).catch(() => {
    throw new InstallError(refusal);
  });
}

/** codesign's exit when the code is signed but fails a requirement it was given (`-R`). */
const CODESIGN_FAILED_REQUIREMENT = 3;

/**
 * That codesign accepts `target` against Roblox's requirement and names Roblox's team as its
 * signer; an app must also pass Gatekeeper (Developer ID, notarized).
 */
async function checkSignedMac(deps: InstallDeps, target: string): Promise<void> {
  const options = { timeoutMs: CHECK_TIMEOUT_MS };
  const app = target.endsWith(".app");
  const strict = app ? ["--verify", "--strict", "--deep"] : ["--verify", "--strict"];
  const args = [...strict, `-R=${ROBLOX_REQUIREMENT}`, target];
  const verified = await runOr(deps, InstallRefusal.Unsigned, { file: CODESIGN, args, options });
  if (verified.code === CODESIGN_FAILED_REQUIREMENT) throw new InstallError(InstallRefusal.WrongSigner);
  if (verified.code !== 0) throw new InstallError(InstallRefusal.Unsigned);
  const details = await runOr(deps, InstallRefusal.WrongSigner, { file: CODESIGN, args: ["-dv", target], options });
  const team = TEAM_LINE.exec(`${details.stderr}\n${details.stdout}`)?.[1]?.trim();
  if (details.code !== 0 || team !== ROBLOX_TEAM_ID) throw new InstallError(InstallRefusal.WrongSigner);
  if (!app) return;
  const assess = { file: SPCTL, args: ["--assess", "--type", "execute", target], options };
  const assessed = await runOr(deps, InstallRefusal.WrongSigner, assess);
  if (assessed.code !== 0) throw new InstallError(InstallRefusal.WrongSigner);
}

/** Roblox's installer app on the mounted DMG: a real folder, not a link out of it. */
async function installerApp(mount: string): Promise<string> {
  const app = path.join(mount, MAC_INSTALLER_APP);
  const stat = await lstat(app).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new InstallError(InstallRefusal.NoInstaller);
  return app;
}

/** Detaches Genex's own mount of the installer DMG; forced only when a plain detach fails. */
async function detach(deps: InstallDeps, mount: string): Promise<void> {
  const limit = { timeoutMs: CHECK_TIMEOUT_MS };
  const plain = await deps.run(HDIUTIL, ["detach", mount], limit).catch(() => undefined);
  if (plain?.code === 0) return;
  await deps.run(HDIUTIL, ["detach", mount, "-force"], limit).catch(() => undefined);
}

/**
 * On a Mac: checks the DMG is Roblox's, attaches it read-only in `dir`, checks the installer app
 * on it is Roblox's, runs it and waits for it to finish, and always detaches.
 */
async function installOnMac(deps: InstallDeps, dmg: string, dir: string, options: InstallOptions): Promise<void> {
  await checkSignedMac(deps, dmg);
  throwIfStopped(options.signal);
  const mount = path.join(dir, MOUNT_FOLDER);
  await mkdir(mount, { mode: 0o700 });
  const args = ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg];
  try {
    const attach = { file: HDIUTIL, args, options: { timeoutMs: CHECK_TIMEOUT_MS } };
    const attached = await runOr(deps, InstallRefusal.NoInstaller, attach);
    if (attached.code !== 0) throw new InstallError(InstallRefusal.NoInstaller);
    const app = await installerApp(mount);
    await checkSignedMac(deps, app);
    throwIfStopped(options.signal);
    options.onPhase?.(InstallPhase.Installing);
    const run = { file: MAC_OPEN, args: ["-W", "-n", app], options: { timeoutMs: INSTALLER_RUN_MS, visible: true } };
    const ran = await runOr(deps, InstallRefusal.InstallerFailed, run);
    if (ran.code !== 0) throw new InstallError(InstallRefusal.InstallerFailed);
  } finally {
    await detach(deps, mount);
  }
}

/** Windows PowerShell by its full path under SystemRoot, so neither PATH nor the current folder stands in. */
function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, "SystemRoot");
  const system = root && isWindowsPath(root) ? root : WINDOWS_ROOT;
  return path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Whether a certificate subject's CN or O is exactly Roblox's name. A subject with an escape (a
 * backslash) is refused whole: read without its escapes, `CN=Evil\, O=Roblox Corporation` would
 * pass as an O of Roblox's name, and Roblox's own subject has none.
 */
export function signedByRoblox(subject: string): boolean {
  if (subject.includes("\\")) return false;
  for (const match of subject.matchAll(SUBJECT_NAME))
    if ((match[2] ?? match[3] ?? "").trim() === ROBLOX_SIGNER) return true;
  return false;
}

/** Authenticode's answer, or nothing it can be read as. */
function parseSignature(stdout: string): { status: string; subject: string } | undefined {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== "object") return undefined;
    const { status, subject } = value as Record<string, unknown>;
    if (typeof status !== "string") return undefined;
    return { status, subject: typeof subject === "string" ? subject : "" };
  } catch {
    return undefined;
  }
}

/** On Windows: checks Authenticode calls the installer Valid and Roblox's, then runs it to its end. */
async function installOnWindows(deps: InstallDeps, exe: string, options: InstallOptions): Promise<void> {
  const args = ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SIGNATURE];
  const check = { timeoutMs: CHECK_TIMEOUT_MS, env: { [INSTALLER_VARIABLE]: exe } };
  const checked = await runOr(deps, InstallRefusal.Unsigned, { file: powershellPath(deps.env), args, options: check });
  const signature = checked.code === 0 ? parseSignature(checked.stdout) : undefined;
  if (signature?.status !== "Valid") throw new InstallError(InstallRefusal.Unsigned);
  if (!signedByRoblox(signature.subject)) throw new InstallError(InstallRefusal.WrongSigner);
  throwIfStopped(options.signal);
  options.onPhase?.(InstallPhase.Installing);
  const run = { file: exe, args: [], options: { timeoutMs: INSTALLER_RUN_MS, visible: true } };
  const ran = await runOr(deps, InstallRefusal.InstallerFailed, run);
  if (ran.code !== 0) throw new InstallError(InstallRefusal.InstallerFailed);
}

/**
 * Downloads Roblox's installer into a private temporary folder, checks Roblox signed it, and runs
 * it to its end. The folder is always removed; nothing runs when a check fails.
 */
export async function installStudio(deps: InstallDeps, options: InstallOptions): Promise<void> {
  if (!isInstallerSystem(deps.platform)) throw new InstallError(InstallRefusal.Unsupported);
  const installer = INSTALLER[deps.platform];
  const limit = (deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms)))(DOWNLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, limit]);
  const dir = await mkdtemp(path.join(deps.tempRoot, TEMP_PREFIX));
  try {
    options.onPhase?.(InstallPhase.Downloading);
    const url = options.url ?? installer.url;
    const file = await downloadInstaller(deps.fetch, { url, dir, file: installer.file, signal }).catch(
      (error: unknown) => {
        // The download's own time limit ran out: a failed download, not the person's Stop.
        const late =
          error instanceof InstallError && error.code === InstallRefusal.Cancelled && !options.signal.aborted;
        throw late ? new InstallError(InstallRefusal.DownloadFailed) : error;
      },
    );
    options.onPhase?.(InstallPhase.Checking);
    if (deps.platform === "darwin") await installOnMac(deps, file, dir, options);
    else await installOnWindows(deps, file, options);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What happens after the installer: Studio's computer, its opener and clock, and Set up. */
export interface AfterInstallDeps extends LaunchDeps {
  /** Genex's Set up, run while Studio is closed; answers its plain words. */
  setUp(): Promise<string>;
}

/** Studio set up and opened again after the installer. */
export interface AfterInstallDone {
  message: string;
  reopened: true;
  version?: string;
}

/** Looks every poll until `ready` holds or `waitMs` passes; true when it held. */
async function waitFor(deps: LaunchDeps, signal: AbortSignal, waitMs: number, ready: () => Promise<boolean>) {
  const until = deps.now() + waitMs;
  for (;;) {
    throwIfStopped(signal);
    if (await ready()) return true;
    if (deps.now() >= until) return false;
    await deps.sleep(INSTALL_POLL_MS);
  }
}

/** Waits for Studio to be on this computer; the deadline is a plain stop. */
async function installedStudio(deps: LaunchDeps, signal: AbortSignal): Promise<StudioInstall> {
  let install: StudioInstall | undefined;
  const found = await waitFor(deps, signal, INSTALL_WAIT_MS, async () => {
    const location = await locateStudio(deps);
    if (location.installed) install = location.install;
    return location.installed;
  });
  if (!found || !install) throw new InstallError(InstallRefusal.NotInstalled);
  return install;
}

/**
 * After the installer: waits for Studio; when the installer's Studio opens, waits for the person to
 * sign in there and for that Studio to close by itself (never closing it); sets Studio up while it
 * is closed; then opens Studio once. A Studio that closes again after that is the person's: it is
 * never opened again from here.
 */
export async function afterInstall(
  deps: AfterInstallDeps,
  options: { signal: AbortSignal; onPhase?(phase: InstallPhase): void },
): Promise<AfterInstallDone> {
  const { signal } = options;
  options.onPhase?.(InstallPhase.WaitingForStudio);
  const install = await installedStudio(deps, signal);
  const opened = await waitFor(deps, signal, STUDIO_START_WAIT_MS, () => studioRunning(deps));
  if (opened) {
    options.onPhase?.(InstallPhase.SigningIn);
    const closed = await waitFor(deps, signal, SIGN_IN_WAIT_MS, async () => !(await studioRunning(deps)));
    if (!closed) throw new InstallError(InstallRefusal.StillOpen);
  }
  options.onPhase?.(InstallPhase.SettingUp);
  const setUp = await deps.setUp();
  throwIfStopped(signal);
  options.onPhase?.(InstallPhase.Opening);
  await deps.open(openLaunch(deps.platform, install));
  const done: AfterInstallDone = { message: `${setUp} ${MESSAGE.Install.Reopened()}`, reopened: true };
  if (install.version) done.version = install.version;
  return done;
}

/**
 * Runs a program with execFile (no shell) to its end within its limit: a non-zero exit is an
 * answer, with whatever it printed; a program that can't start rejects. Only Roblox's installer
 * shows a window on Windows.
 */
export const systemInstallRun: InstallRun = (file, args, options) =>
  new Promise((resolve, reject) => {
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    const exec = { timeout: options.timeoutMs, windowsHide: !options.visible, env, maxBuffer: 1024 * 1024 };
    execFile(file, [...args], exec, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number")
        return resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      reject(error);
    });
  });
