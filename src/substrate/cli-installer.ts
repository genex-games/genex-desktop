/**
 * The coding CLIs' own installers, run for the person from inside the app: the Install buttons in
 * first launch, Settings and the chat's sign-in card.
 *
 * Each vendor publishes one installer per platform family, a shell script for macOS and Linux and
 * a PowerShell one for Windows. Studio fetches the fixed script over HTTPS itself (so a Linux
 * without curl still gets as far as the script, which then uses curl or wget), saves it to a
 * private temporary folder, runs it as the person with nothing to answer, and deletes it. Both put
 * the CLI where discovery already looks (`~/.local/bin`; Codex's `Programs\OpenAI\Codex\bin` on
 * Windows). Like the person's own terminal, and unlike agent work, the installer runs outside
 * ProcessSandbox: installing into the home folder is its whole purpose. Nothing the renderer sends
 * reaches the command line; it only names which of the two CLIs.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliInstallProblem } from "../shared/cli-install.ts";
import type { CodingProvider } from "../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { EngineId } from "../shared/providers.ts";
import { childEnv } from "./child-env.ts";
import { killProcessTree } from "./process-tree.ts";
import { envValue, isWindows } from "./toolchain.ts";

/** How long an installer may take: it downloads a CLI of a few hundred megabytes. */
const INSTALL_TIMEOUT_MS = 10 * MINUTE_MS;
/** The largest installer script accepted; the vendors' are tens of kilobytes. */
const SCRIPT_MAX_BYTES = 1024 * 1024;
/** How much of the installer's output is kept for the log when it fails. */
const OUTPUT_TAIL_CHARS = 4000;
/** How long an exited installer's output may take to close before it is read as it stands. */
const EXIT_GRACE_MS = 2 * SECOND_MS;

/** One CLI's installers, the shell its macOS/Linux script is written for, and what keeps it from asking. */
interface Installer {
  unix: string;
  /** The vendor's PowerShell installer, or null when it publishes none (OpenCode). */
  windows: string | null;
  shell: string;
  set: Record<string, string>;
  vendor: "claude" | "codex" | "opencode";
}

/** Each coding CLI's official installers, from its vendor's install instructions. */
const INSTALLERS = {
  [EngineId.ClaudeCode]: {
    unix: "https://claude.ai/install.sh",
    windows: "https://claude.ai/install.ps1",
    shell: "/bin/bash",
    set: {},
    vendor: "claude",
  },
  [EngineId.Codex]: {
    unix: "https://chatgpt.com/codex/install.sh",
    windows: "https://chatgpt.com/codex/install.ps1",
    shell: "/bin/sh",
    // Without it the script offers to start Codex, or to remove an npm or Homebrew copy, and waits.
    set: { CODEX_NON_INTERACTIVE: "1" },
    vendor: "codex",
  },
  [EngineId.OpenCode]: {
    unix: "https://opencode.ai/install",
    windows: null,
    shell: "/bin/bash",
    set: {},
    vendor: "opencode",
  },
} as const satisfies Record<CodingProvider, Installer>;

/** Why an installer cannot be looked up; the renderer never sees this, main refuses first. */
const MESSAGE = {
  unknownProvider: (provider: string) => `unknown coding CLI: ${provider}`,
  notHttps: (url: string) => `the installer was not served over HTTPS (${url})`,
  status: (status: number) => `the installer download answered ${status}`,
  size: (bytes: number) => `the installer download was ${bytes} bytes`,
  exited: (code: number | null, output: string) => `the installer exited with ${code}: ${output}`,
  timedOut: (output: string) => `the installer did not finish in time: ${output}`,
  noInstaller: (provider: string, platform: string) => `${provider} publishes no installer for ${platform}`,
} as const;

/** Where `provider`'s installer comes from on `platform`, and the extension its saved copy needs. */
export function installerSource(
  provider: CodingProvider,
  platform: NodeJS.Platform,
): { url: string; extension: ".sh" | ".ps1" } | null {
  const installer = installerOf(provider);
  if (!isWindows(platform)) return { url: installer.unix, extension: ".sh" };
  return installer.windows ? { url: installer.windows, extension: ".ps1" } : null;
}

/** How the installer saved at `script` is started: its own shell, or PowerShell by its full path. */
export function installerCommand(
  provider: CodingProvider,
  platform: NodeJS.Platform,
  script: string,
  env: Record<string, string | undefined>,
): { file: string; args: string[] } {
  if (!isWindows(platform)) return { file: installerOf(provider).shell, args: [script] };
  const systemRoot = envValue(env, "SystemRoot") || "C:\\Windows";
  return {
    file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
  };
}

/** Fetches an installer script: the global `fetch`, or Electron's `net.fetch`. */
export type FetchInstaller = (url: string, init?: RequestInit) => Promise<Response>;

/** How an installer run ended: its exit code, its last output, and whether it was stopped for time. */
export interface InstallerExit {
  code: number | null;
  output: string;
  timedOut: boolean;
}
/** Runs one installer to its end; injectable for tests. */
export type InstallerRun = (
  command: { file: string; args: string[] },
  options: { env: Record<string, string>; timeoutMs: number; platform: NodeJS.Platform },
) => Promise<InstallerExit>;

export interface InstallOptions {
  platform?: NodeJS.Platform;
  /** The app's environment the installer's is built from. */
  env?: Record<string, string | undefined>;
  /** Electron's `net.fetch` in the app, so the system proxy applies. */
  fetch?: FetchInstaller;
  /** Where the installer is saved while it runs. */
  tmpRoot?: string;
  timeoutMs?: number;
  run?: InstallerRun;
}

/** An install's end: done, or the problem and what the log should keep of it. */
export type InstallOutcome = { ok: true } | { ok: false; problem: CliInstallProblem; detail: string };

/** Fetch `provider`'s official installer and run it; whether the CLI then works is the caller's check. */
export async function installCodingCli(
  provider: CodingProvider,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const platform = options.platform ?? process.platform;
  const parent = options.env ?? process.env;
  const source = installerSource(provider, platform);
  if (!source)
    return { ok: false, problem: CliInstallProblem.Download, detail: MESSAGE.noInstaller(provider, platform) };
  const script = await download(source.url, options.fetch ?? fetch);
  if (!script.ok) return { ok: false, problem: CliInstallProblem.Download, detail: script.detail };
  const folder = await mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), "genex-cli-install-"));
  try {
    const file = path.join(folder, `install${source.extension}`);
    await writeFile(file, script.text, { mode: 0o700 });
    const installer = installerOf(provider);
    const env = childEnv(parent, { base: "contractor", vendor: installer.vendor, set: installer.set });
    const exit = await (options.run ?? runInstaller)(installerCommand(provider, platform, file, parent), {
      env,
      timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
      platform,
    });
    if (exit.timedOut) return { ok: false, problem: CliInstallProblem.TimedOut, detail: MESSAGE.timedOut(exit.output) };
    if (exit.code !== 0)
      return { ok: false, problem: CliInstallProblem.Installer, detail: MESSAGE.exited(exit.code, exit.output) };
    return { ok: true };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function installerOf(provider: CodingProvider): Installer {
  if (!Object.hasOwn(INSTALLERS, provider)) throw new Error(MESSAGE.unknownProvider(String(provider)));
  return INSTALLERS[provider];
}

/** The installer's text, whole, from an HTTPS answer; anything else is a failed download. */
async function download(
  url: string,
  fetchFn: FetchInstaller,
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "follow" });
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
  const servedFrom = response.url || url;
  if (new URL(servedFrom).protocol !== "https:") return { ok: false, detail: MESSAGE.notHttps(servedFrom) };
  if (!response.ok) return { ok: false, detail: MESSAGE.status(response.status) };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > SCRIPT_MAX_BYTES)
    return { ok: false, detail: MESSAGE.size(bytes.byteLength) };
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

/**
 * Run the installer with no input and keep the tail of what it says. It leads its own process
 * group (POSIX), so a stop for time ends the downloads it started too.
 */
const runInstaller: InstallerRun = (command, { env, timeoutMs, platform }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows(platform),
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid, { platform });
    }, timeoutMs);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code: exitCode, output: output.trim(), timedOut });
    };
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
      });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      exitCode = code;
      // Something the installer left running may hold its output open; do not wait on it.
      grace = setTimeout(finish, EXIT_GRACE_MS);
    });
    child.on("close", finish);
  });
