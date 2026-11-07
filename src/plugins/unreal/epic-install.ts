/**
 * What Do it for me on the Unreal setup card installs itself on Windows: Epic's launcher,
 * Microsoft's Visual C++ runtime, which Unreal's editor needs and Epic's launcher normally installs
 * with the engine, and Microsoft's Visual Studio Build Tools, with which Unreal builds C++. Unreal
 * itself is installed in the launcher by the game's chat with the person's computer control
 * (`backend.ts`); only the person signs in to Epic.
 *
 * - Epic's installer comes only from Epic's launcher link, and the Build Tools' installer only from
 *   Microsoft's (`visual-studio.ts`): over HTTPS, following redirects only to that maker's own
 *   download hosts, and only up to `MAX_INSTALLER_BYTES`. Both makers change their installers with
 *   every release, so nothing pins a hash: Authenticode must call the file Valid and signed by its
 *   maker. The runtime is the engine's own `vc_redist.x64.exe`, which must be Valid and signed by
 *   Microsoft Corporation.
 * - Windows Installer runs Epic's MSI (`/passive`), the runtime runs with `/install /passive`, and
 *   the Build Tools' installer with `--passive --wait`: Windows asks the person for permission and
 *   shows its progress. Every program is an argument list by its full path, never a shell string;
 *   the file PowerShell checks comes from its environment, never from the command.
 * - Nothing runs when a check fails, and the private temporary folder is always removed.
 */
import { execFile } from "node:child_process";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";
import { windowsSystemTool } from "./setup.ts";
import {
  BUILD_TOOLS_CHANNEL,
  BUILD_TOOLS_COMPONENTS,
  BUILD_TOOLS_HOSTS,
  BUILD_TOOLS_URL,
  BuildToolsPlan,
  type VisualStudioStatus,
} from "./visual-studio.ts";

/** Epic's link to its Windows launcher installer, which redirects to the current release. */
export const EPIC_INSTALLER_URL =
  "https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi";
/** The hosts an installer may come from, matched exactly: Epic's launcher service and its download CDN. */
export const EPIC_HOSTS: ReadonlySet<string> = new Set([
  "launcher-public-service-prod06.ol.epicgames.com",
  "epicgames-download1.akamaized.net",
]);
/** The largest installer Genex downloads; Epic's is about 260 MB. */
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
/** Epic's name on its code-signing certificate. */
export const EPIC_SIGNER = "Epic Games Inc.";
/** Microsoft's name on the Visual C++ runtime's certificate. */
export const MICROSOFT_SIGNER = "Microsoft Corporation";
/** How long the download may take: a few hundred MB on a slow line. */
export const DOWNLOAD_TIMEOUT_MS = 30 * MINUTE_MS;
/** How long an installer may run, the person's permission prompt included. */
export const INSTALLER_RUN_MS = 20 * MINUTE_MS;
/** How long the Build Tools' installer may run: it downloads and installs several GB itself. */
export const BUILD_TOOLS_RUN_MS = 120 * MINUTE_MS;
/** How long a signature check may take: PowerShell's first start on a fresh PC is slow. */
const CHECK_TIMEOUT_MS = 2 * MINUTE_MS;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const INSTALLER_FILE = "EpicInstaller.msi";
const BUILD_TOOLS_FILE = "vs_BuildTools.exe";
const TEMP_PREFIX = "genex-epic-install-";
/** The variable PowerShell reads the checked file's path from. */
const CHECKED_VARIABLE = "GENEX_INSTALLER";
/** The runtime's installer inside an installed engine, relative to its folder. */
const RUNTIME_INSTALLER = ["Engine", "Extras", "Redist", "en-us", "vc_redist.x64.exe"] as const;
/** The runtime's files Unreal's editor loads, in Windows' own System32. */
const RUNTIME_FILES = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] as const;
/** What an installer's exit codes mean; a code in none of the sets is a failure. */
type InstallerCodes = {
  installed: ReadonlySet<number>;
  /** The person's No at Windows' permission prompt, or their Cancel. */
  cancelled: ReadonlySet<number>;
  /** Another install, or Visual Studio itself, was running. */
  busy?: ReadonlySet<number>;
  /** The installer couldn't download what it installs. */
  offline?: ReadonlySet<number>;
};
/**
 * Windows Installer's and Microsoft's redistributable's codes: done, done but a restart finishes it,
 * and (the runtime) a newer one already there; 1602 is the person's No or Cancel.
 */
const WINDOWS_INSTALLER_CODES: InstallerCodes = { installed: new Set([0, 3010, 1638]), cancelled: new Set([1602]) };
/**
 * Visual Studio's installer's codes, as Microsoft documents them: done, and done with a restart
 * started or needed; cancelled, or refused for want of elevation; another installer, Visual Studio
 * or its processes running; its download or connection failing.
 */
const BUILD_TOOLS_CODES: InstallerCodes = {
  installed: new Set([0, 1641, 3010]),
  cancelled: new Set([740, 1602, 5004]),
  busy: new Set([1001, 1003, 1618, 8006]),
  offline: new Set([5003, -1073720687]),
};
/** A subject's CN or O, quoted or not. */
const SUBJECT_NAME = /(?:^|,)\s*(CN|O)=(?:"([^"]*)"|([^,]*))/g;

/** Authenticode's verdict and the signer's subject, as one line of JSON. */
const POWERSHELL_SIGNATURE = [
  "$ErrorActionPreference = 'Stop'",
  `$signature = Get-AuthenticodeSignature -LiteralPath $env:${CHECKED_VARIABLE}`,
  "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
  "[pscustomobject]@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress",
].join("; ");

/** What Do it for me installs itself. Wire values: the card keys its rows by them. */
export const EpicInstallKind = { Launcher: "launcher", Runtime: "runtime", BuildTools: "build-tools" } as const;
export type EpicInstallKind = (typeof EpicInstallKind)[keyof typeof EpicInstallKind];

/** Where an install stands. Wire values: never rename. */
export const EpicInstallPhase = {
  Downloading: "downloading",
  Checking: "checking",
  Installing: "installing",
  Done: "done",
  Failed: "failed",
} as const;
export type EpicInstallPhase = (typeof EpicInstallPhase)[keyof typeof EpicInstallPhase];

/** Why an install stopped. Wire values: never rename. */
export const EpicInstallRefusal = {
  Unsupported: "unsupported",
  NotHttps: "not-https",
  OtherHost: "other-host",
  TooLarge: "too-large",
  DownloadFailed: "download-failed",
  NoInstaller: "no-installer",
  Unsigned: "unsigned",
  WrongSigner: "wrong-signer",
  NoPermission: "no-permission",
  InstallerFailed: "installer-failed",
  /** Another installer, or Visual Studio itself, was running. */
  InstallerBusy: "installer-busy",
  /** The installer couldn't download what it installs. */
  Offline: "offline",
  /** The installer finished, but what Unreal needs still isn't there. */
  StillMissing: "still-missing",
  Cancelled: "cancelled",
} as const;
export type EpicInstallRefusal = (typeof EpicInstallRefusal)[keyof typeof EpicInstallRefusal];

/** Each stop in the person's words, said where it is shown. */
const REFUSED: Record<EpicInstallRefusal, () => string> = {
  [EpicInstallRefusal.Unsupported]: () => t("Genex installs Epic's launcher itself on Windows only."),
  [EpicInstallRefusal.NotHttps]: () => t("Epic's download link wasn't secure, so Genex didn't download it."),
  [EpicInstallRefusal.OtherHost]: () => t("Epic's download led somewhere other than Epic, so Genex stopped."),
  [EpicInstallRefusal.TooLarge]: () => t("Epic's download was far bigger than its installer, so Genex stopped."),
  [EpicInstallRefusal.DownloadFailed]: () =>
    t("Epic's installer didn't download. Check your internet connection and try again."),
  [EpicInstallRefusal.NoInstaller]: () =>
    t("Unreal's copy of Microsoft's runtime installer is missing. In the Epic Games Launcher, verify Unreal."),
  [EpicInstallRefusal.Unsigned]: () => t("The installer isn't signed, so Genex didn't run it."),
  [EpicInstallRefusal.WrongSigner]: () => t("The installer isn't signed by its maker, so Genex didn't run it."),
  [EpicInstallRefusal.NoPermission]: () =>
    t("Windows didn't get permission to install. Press Do it for me again and choose Yes when Windows asks."),
  [EpicInstallRefusal.InstallerFailed]: () => t("The installer stopped before it finished. Try again."),
  [EpicInstallRefusal.InstallerBusy]: () =>
    t("Another installer or Visual Studio is running. Close it, then press Do it for me again."),
  [EpicInstallRefusal.Offline]: () =>
    t("Microsoft's installer couldn't download the Build Tools. Check your internet connection and try again."),
  [EpicInstallRefusal.StillMissing]: () =>
    t(
      "Microsoft's installer finished, but Unreal still can't build C++ with what it installed. Install Visual Studio Build Tools 2022 with Desktop development with C++ and the .NET Framework 4.8 SDK yourself.",
    ),
  [EpicInstallRefusal.Cancelled]: () => t("Stopped."),
};

/** The download's stops for Microsoft's Build Tools installer, said of Microsoft. */
const MICROSOFT_REFUSED: Partial<Record<EpicInstallRefusal, () => string>> = {
  [EpicInstallRefusal.NotHttps]: () => t("Microsoft's download link wasn't secure, so Genex didn't download it."),
  [EpicInstallRefusal.OtherHost]: () => t("Microsoft's download led somewhere other than Microsoft, so Genex stopped."),
  [EpicInstallRefusal.TooLarge]: () => t("Microsoft's download was far bigger than its installer, so Genex stopped."),
  [EpicInstallRefusal.DownloadFailed]: () =>
    t("Microsoft's installer didn't download. Check your internet connection and try again."),
};

/** A stop on the way, in plain words, with its code. */
export class EpicInstallError extends Error {
  readonly code: EpicInstallRefusal;
  /** `words` says it of another maker than Epic: Microsoft's download, for the Build Tools. */
  constructor(code: EpicInstallRefusal, words: Partial<Record<EpicInstallRefusal, () => string>> = {}) {
    super((words[code] ?? REFUSED[code])());
    this.name = "EpicInstallError";
    this.code = code;
  }
}

/** Where an installer is downloaded from: its link, the hosts it may lead to, and its stops said of its maker. */
export type InstallerSource = {
  url: string;
  hosts: ReadonlySet<string>;
  words?: Partial<Record<EpicInstallRefusal, () => string>>;
};

/** Epic's launcher installer, from Epic's own link. */
const EPIC_SOURCE: InstallerSource = { url: EPIC_INSTALLER_URL, hosts: EPIC_HOSTS };
/** Microsoft's Build Tools installer, from Microsoft's own link. */
export const BUILD_TOOLS_SOURCE: InstallerSource = {
  url: BUILD_TOOLS_URL,
  hosts: BUILD_TOOLS_HOSTS,
  words: MICROSOFT_REFUSED,
};

/** A program's exit code and what it printed. */
export interface EpicCommandResult {
  code: number;
  stdout: string;
}

/** How a program runs: its limit, extra environment, and whether its window is the person's. */
export interface EpicRunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  visible?: boolean;
}

/** Runs a program by its full path with an argument list, never a shell; rejects when it can't start. */
export type EpicRun = (file: string, args: readonly string[], options: EpicRunOptions) => Promise<EpicCommandResult>;

/** The computer and the network an install works with; tests hand in fakes. */
export interface EpicInstallDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  run: EpicRun;
  /** Where the private temporary folder is made. */
  tempRoot: string;
  /** A signal that ends after `ms`; the system's timer by default. */
  timeout?(ms: number): AbortSignal;
}

/** One install: the person's Stop, where to report its phase, and (tests) another link. */
export interface EpicInstallOptions {
  signal: AbortSignal;
  onPhase?(phase: EpicInstallPhase): void;
  url?: string;
}

/** A link Genex may fetch the installer from: HTTPS and exactly one of its maker's hosts. */
function checkedUrl(source: InstallerSource, raw: string, base?: string): URL {
  const url = new URL(raw, base);
  if (url.protocol !== "https:") throw new EpicInstallError(EpicInstallRefusal.NotHttps, source.words);
  if (!source.hosts.has(url.hostname) || url.port !== "" || url.username || url.password)
    throw new EpicInstallError(EpicInstallRefusal.OtherHost, source.words);
  return url;
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new EpicInstallError(EpicInstallRefusal.Cancelled);
}

/** The installer's response, after following only redirects that stay on its maker's hosts over HTTPS. */
async function fetchChecked(
  fetchFn: typeof fetch,
  source: InstallerSource,
  url: URL,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchFn(current.href, { redirect: "manual", signal });
    if (!REDIRECT_STATUS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) throw new EpicInstallError(EpicInstallRefusal.DownloadFailed, source.words);
    current = checkedUrl(source, location, current.href);
  }
  throw new EpicInstallError(EpicInstallRefusal.DownloadFailed, source.words);
}

/** Reads `body` into `file`, never past `maxBytes`; a Stop cancels the read at once. */
async function writeCapped(
  body: ReadableStream<Uint8Array>,
  file: string,
  limit: { maxBytes: number; source: InstallerSource },
  signal: AbortSignal,
) {
  const { maxBytes } = limit;
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
      if (size > maxBytes) throw new EpicInstallError(EpicInstallRefusal.TooLarge, limit.source.words);
      await handle.write(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await handle.close();
    if (size > maxBytes || signal.aborted) await reader.cancel().catch(() => undefined);
  }
}

/** Any failure of a download as its own refusal: the person's Stop, else a failed download. */
function asDownloadError(error: unknown, signal: AbortSignal, source: InstallerSource): never {
  if (error instanceof EpicInstallError) throw error;
  throwIfStopped(signal);
  throw new EpicInstallError(EpicInstallRefusal.DownloadFailed, source.words);
}

/**
 * Downloads an installer into `dir` as `file`: HTTPS only, redirects only within its maker's hosts
 * (`source`, Epic's unless named), the size capped before and while reading. Rejects with an
 * `EpicInstallError`.
 */
export async function downloadEpicInstaller(
  fetchFn: typeof fetch,
  options: {
    url: string;
    dir: string;
    file: string;
    signal: AbortSignal;
    maxBytes?: number;
    source?: InstallerSource;
  },
): Promise<string> {
  const { signal } = options;
  const source = options.source ?? EPIC_SOURCE;
  const failed = () => new EpicInstallError(EpicInstallRefusal.DownloadFailed, source.words);
  const maxBytes = options.maxBytes ?? MAX_INSTALLER_BYTES;
  const url = checkedUrl(source, options.url);
  throwIfStopped(signal);
  const response = await fetchChecked(fetchFn, source, url, signal).catch((error: unknown) =>
    asDownloadError(error, signal, source),
  );
  if (!response.ok || !response.body) throw failed();
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (declared > maxBytes) throw new EpicInstallError(EpicInstallRefusal.TooLarge, source.words);
  const target = path.join(options.dir, options.file);
  const size = await writeCapped(response.body, target, { maxBytes, source }, signal).catch((error: unknown) =>
    asDownloadError(error, signal, source),
  );
  if (Number.isFinite(declared) && size !== declared) throw failed();
  return target;
}

/**
 * Whether a certificate subject's CN or O is exactly `signer`. A subject with an escape (a
 * backslash) is refused whole: read without its escapes, `CN=Evil\, O=Epic Games Inc.` would pass as
 * an O of Epic's name, and neither Epic's subject nor Microsoft's has one.
 */
export function signedBy(subject: string, signer: string): boolean {
  if (subject.includes("\\")) return false;
  for (const match of subject.matchAll(SUBJECT_NAME)) if ((match[2] ?? match[3] ?? "").trim() === signer) return true;
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

/** Runs a program; one that can't start or runs past its limit is `refusal`. */
async function runOr(
  deps: EpicInstallDeps,
  refusal: EpicInstallRefusal,
  command: { file: string; args: readonly string[]; options: EpicRunOptions },
): Promise<EpicCommandResult> {
  return deps.run(command.file, command.args, command.options).catch(() => {
    throw new EpicInstallError(refusal);
  });
}

/** That Authenticode calls `file` Valid and signed by `signer`. */
async function checkSigned(deps: EpicInstallDeps, file: string, signer: string): Promise<void> {
  const powershell = windowsSystemTool(deps.env, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SIGNATURE];
  const options = { timeoutMs: CHECK_TIMEOUT_MS, env: { [CHECKED_VARIABLE]: file } };
  const checked = await runOr(deps, EpicInstallRefusal.Unsigned, { file: powershell, args, options });
  const signature = checked.code === 0 ? parseSignature(checked.stdout) : undefined;
  if (signature?.status !== "Valid") throw new EpicInstallError(EpicInstallRefusal.Unsigned);
  if (!signedBy(signature.subject, signer)) throw new EpicInstallError(EpicInstallRefusal.WrongSigner);
}

/**
 * The refusal an installer's exit code means, or undefined when it installed. Windows reports an
 * exit code as unsigned (Microsoft's -1073720687 arrives as 3221246609), so it is read as the
 * signed 32-bit number installers document.
 */
function installerRefusal(exitCode: number, codes: InstallerCodes): EpicInstallRefusal | undefined {
  const code = exitCode | 0;
  if (codes.installed.has(code)) return undefined;
  if (codes.cancelled.has(code)) return EpicInstallRefusal.NoPermission;
  if (codes.busy?.has(code)) return EpicInstallRefusal.InstallerBusy;
  if (codes.offline?.has(code)) return EpicInstallRefusal.Offline;
  return EpicInstallRefusal.InstallerFailed;
}

/** Runs an installer the person sees to its end, within `timeoutMs`: installed, or the refusal its code means. */
async function runInstaller(
  deps: EpicInstallDeps,
  installer: { file: string; args: readonly string[]; codes: InstallerCodes; timeoutMs: number },
): Promise<void> {
  const { file, args, codes } = installer;
  const options = { timeoutMs: installer.timeoutMs, visible: true };
  const ran = await runOr(deps, EpicInstallRefusal.InstallerFailed, { file, args, options });
  const refusal = installerRefusal(ran.code, codes);
  if (refusal) throw new EpicInstallError(refusal);
}

/** The time limit of a download, joined with the person's Stop. */
function downloadSignal(deps: EpicInstallDeps, signal: AbortSignal): AbortSignal {
  const limit = (deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms)))(DOWNLOAD_TIMEOUT_MS);
  return AbortSignal.any([signal, limit]);
}

/**
 * Epic's launcher on Windows: Epic's installer downloaded into a private temporary folder, checked
 * that Epic signed it, and run with Windows Installer to its end. The folder is always removed.
 */
export async function installEpicLauncher(deps: EpicInstallDeps, options: EpicInstallOptions): Promise<void> {
  if (deps.platform !== "win32") throw new EpicInstallError(EpicInstallRefusal.Unsupported);
  const dir = await mkdtemp(path.join(deps.tempRoot, TEMP_PREFIX));
  try {
    options.onPhase?.(EpicInstallPhase.Downloading);
    const download = { url: options.url ?? EPIC_INSTALLER_URL, dir, file: INSTALLER_FILE };
    const signal = downloadSignal(deps, options.signal);
    const msi = await downloadEpicInstaller(deps.fetch, { ...download, signal }).catch((error: unknown) => {
      // The download's own time limit ran out: a failed download, not the person's Stop.
      const late = error instanceof EpicInstallError && error.code === EpicInstallRefusal.Cancelled;
      throw late && !options.signal.aborted ? new EpicInstallError(EpicInstallRefusal.DownloadFailed) : error;
    });
    options.onPhase?.(EpicInstallPhase.Checking);
    await checkSigned(deps, msi, EPIC_SIGNER);
    throwIfStopped(options.signal);
    options.onPhase?.(EpicInstallPhase.Installing);
    await runInstaller(deps, {
      file: windowsSystemTool(deps.env, "System32", "msiexec.exe"),
      args: ["/i", msi, "/passive", "/norestart"],
      codes: WINDOWS_INSTALLER_CODES,
      timeoutMs: INSTALLER_RUN_MS,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The engine's own copy of Microsoft's Visual C++ runtime installer, in the folder Epic's record names. */
export const runtimeInstaller = (engineDirectory: string) => path.join(engineDirectory, ...RUNTIME_INSTALLER);

/** Whether a path is a plain file, never a link. */
const isPlainFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;

/** Windows' System32, where the Visual C++ runtime's files are, from the env a plugin backend gets. */
export const systemFolder = (env: NodeJS.ProcessEnv) => windowsSystemTool(env, "System32");

/** Whether Windows has the Visual C++ runtime Unreal's editor loads: each of its files, plain, in `system32`. */
export async function hasUnrealRuntime(system32: string): Promise<boolean> {
  for (const name of RUNTIME_FILES) if (!(await isPlainFile(path.join(system32, name)))) return false;
  return true;
}

/**
 * Microsoft's Visual C++ runtime, from the installed engine's own copy: checked that Microsoft signed
 * it, then run to its end. Windows asks the person for permission.
 */
export async function installUnrealRuntime(
  deps: EpicInstallDeps,
  engineDirectory: string,
  options: EpicInstallOptions,
): Promise<void> {
  if (deps.platform !== "win32") throw new EpicInstallError(EpicInstallRefusal.Unsupported);
  const installer = runtimeInstaller(engineDirectory);
  if (!(await isPlainFile(installer))) throw new EpicInstallError(EpicInstallRefusal.NoInstaller);
  options.onPhase?.(EpicInstallPhase.Checking);
  await checkSigned(deps, installer, MICROSOFT_SIGNER);
  throwIfStopped(options.signal);
  options.onPhase?.(EpicInstallPhase.Installing);
  await runInstaller(deps, {
    file: installer,
    args: ["/install", "/passive", "/norestart"],
    codes: WINDOWS_INSTALLER_CODES,
    timeoutMs: INSTALLER_RUN_MS,
  });
}

/** What Do it for me hands the Build Tools' installer: the plan, and the install (and its channel) a change acts on. */
export type BuildToolsJob = Pick<VisualStudioStatus, "plan" | "installPath" | "channelId">;

/** Each component the installer adds, as its own `--add`. */
const addComponents = () => BUILD_TOOLS_COMPONENTS.flatMap((component) => ["--add", component]);
/** Shown with its progress, without a restart, and returning only once the whole install is done. */
const PASSIVE = ["--passive", "--norestart", "--wait"] as const;

/**
 * The installer's arguments for a plan: a new install (its cache removed after); the C++ tools and
 * SDK added to the Build Tools install at `installPath`, on its own channel; or that install
 * updated. No plan, or a change without a plain absolute path to act on, is refused.
 */
export function buildToolsArgs(job: BuildToolsJob): string[] {
  const { plan } = job;
  if (!plan) throw new EpicInstallError(EpicInstallRefusal.InstallerFailed);
  if (plan === BuildToolsPlan.Install) return [...PASSIVE, "--nocache", ...addComponents()];
  const installPath = job.installPath ?? "";
  if (!path.win32.isAbsolute(installPath) || installPath.includes('"'))
    throw new EpicInstallError(EpicInstallRefusal.InstallerFailed);
  if (plan === BuildToolsPlan.Update) return ["update", "--installPath", installPath, ...PASSIVE];
  const channel = job.channelId ?? BUILD_TOOLS_CHANNEL;
  return ["modify", "--installPath", installPath, "--channelId", channel, ...addComponents(), ...PASSIVE];
}

/**
 * Microsoft's Visual Studio Build Tools, with which Unreal builds C++ on Windows: Microsoft's
 * installer downloaded into a private temporary folder, checked that Microsoft signed it, and run
 * to its end for `job`'s plan. Windows asks the person for permission; the folder is always removed.
 */
export async function installBuildTools(
  deps: EpicInstallDeps,
  job: BuildToolsJob,
  options: EpicInstallOptions,
): Promise<void> {
  if (deps.platform !== "win32") throw new EpicInstallError(EpicInstallRefusal.Unsupported);
  const args = buildToolsArgs(job);
  const dir = await mkdtemp(path.join(deps.tempRoot, TEMP_PREFIX));
  try {
    options.onPhase?.(EpicInstallPhase.Downloading);
    const download = { url: options.url ?? BUILD_TOOLS_URL, dir, file: BUILD_TOOLS_FILE, source: BUILD_TOOLS_SOURCE };
    const signal = downloadSignal(deps, options.signal);
    const installer = await downloadEpicInstaller(deps.fetch, { ...download, signal }).catch((error: unknown) => {
      const late = error instanceof EpicInstallError && error.code === EpicInstallRefusal.Cancelled;
      if (late && !options.signal.aborted)
        throw new EpicInstallError(EpicInstallRefusal.DownloadFailed, BUILD_TOOLS_SOURCE.words);
      throw error;
    });
    options.onPhase?.(EpicInstallPhase.Checking);
    await checkSigned(deps, installer, MICROSOFT_SIGNER);
    throwIfStopped(options.signal);
    options.onPhase?.(EpicInstallPhase.Installing);
    await runInstaller(deps, { file: installer, args, codes: BUILD_TOOLS_CODES, timeoutMs: BUILD_TOOLS_RUN_MS });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs a program with execFile (no shell) to its end within its limit: a non-zero exit is an answer,
 * with what it printed; a program that can't start rejects. Only the installers show a window.
 */
export const systemEpicRun: EpicRun = (file, args, options) =>
  new Promise((resolve, reject) => {
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    const exec = { timeout: options.timeoutMs, windowsHide: !options.visible, env, maxBuffer: 1024 * 1024 };
    execFile(file, [...args], exec, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, stdout: String(stdout ?? "") });
      reject(error);
    });
  });
