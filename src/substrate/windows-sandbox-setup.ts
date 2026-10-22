/**
 * The Windows sandbox's one-time install, which the setup screen's Set up runs (main/boot-gate.ts).
 *
 * sandbox-runtime's `installWindowsSandboxAsync` starts its vendored srt-win elevated: one
 * administrator (UAC) prompt, then the `srt-sandbox` user and its network filters. A dismissed
 * prompt is not an error (srt-win exits 10 and nothing changes); any other failure throws.
 * In a packaged app srt-win.exe is unpacked beside the archive, because Windows cannot run a file
 * from inside app.asar. sandbox-runtime is loaded on first use: imported eagerly, it cost every
 * launch on every platform about a third of a second before the first window.
 *
 * Where the Secondary Logon service is disabled, Set up first turns it back on, behind a prompt of
 * its own (`windows-logon-service.ts`): srt-win elevates itself, so the two cannot share one.
 */
import path from "node:path";
import { type SandboxProblem, WindowsSetupNeed } from "../shared/boot.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { enableLogonService, logonServiceStartType, ServiceStartType } from "./windows-logon-service.ts";

/** Past the ~2 minutes after which Windows dismisses an unanswered UAC prompt on its own. */
const INSTALL_TIMEOUT_MS = 3 * MINUTE_MS;

/** A path inside the app archive, as the unpacked copy a process can run; any other path unchanged. */
export function unpackedPath(file: string, sep: string = path.sep): string {
  const archive = `${sep}app.asar${sep}`;
  return file.includes(archive) ? file.replace(archive, `${sep}app.asar.unpacked${sep}`) : file;
}

/** The srt-win.exe this build ships, where it can run. */
export async function srtWinPath(): Promise<string> {
  const { VENDORED_SRT_WIN_EXE } = await import("@anthropic-ai/sandbox-runtime");
  return unpackedPath(VENDORED_SRT_WIN_EXE);
}

/** srt-win's install: the sandbox user and its network filters; `cancelled` when the prompt was dismissed. */
async function installSrtSandbox(): Promise<{ cancelled: boolean }> {
  const { installWindowsSandboxAsync, resolveSrtWin } = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = resolveSrtWin({ path: await srtWinPath() });
  const result = await installWindowsSandboxAsync({ srtWin, timeoutMs: INSTALL_TIMEOUT_MS });
  return { cancelled: result.cancelled === true };
}

/** What Set up runs; each default is the real step. */
export interface WindowsSetupSteps {
  logonServiceStartType: () => Promise<ServiceStartType | null>;
  enableLogonService: () => Promise<{ cancelled: boolean }>;
  installSandbox: () => Promise<{ cancelled: boolean }>;
}

const SETUP_STEPS: WindowsSetupSteps = {
  logonServiceStartType: () => logonServiceStartType(),
  enableLogonService: () => enableLogonService(),
  installSandbox: installSrtSandbox,
};

/**
 * Whether Set up still has to turn the service on: the held problem asked for it and `sc` does not
 * say it is on now (an earlier Set up's approval, or the person, may have turned it on since).
 */
async function logonServiceStillOff(needs: readonly WindowsSetupNeed[], steps: WindowsSetupSteps): Promise<boolean> {
  if (!needs.includes(WindowsSetupNeed.LogonService)) return false;
  const startType = await steps.logonServiceStartType();
  return startType === null || startType === ServiceStartType.Disabled;
}

/**
 * Set up what `problem` needs (the sandbox install when it does not say): the Secondary Logon
 * service first, then srt-win's install; `cancelled` when an approval prompt was dismissed, which
 * leaves the rest undone.
 */
export async function installWindowsSandbox(
  problem: SandboxProblem,
  steps: WindowsSetupSteps = SETUP_STEPS,
): Promise<{ cancelled: boolean }> {
  const needs = problem.windowsNeeds ?? [WindowsSetupNeed.Sandbox];
  if (await logonServiceStillOff(needs, steps)) {
    const { cancelled } = await steps.enableLogonService();
    if (cancelled) return { cancelled };
  }
  if (!needs.includes(WindowsSetupNeed.Sandbox)) return { cancelled: false };
  return steps.installSandbox();
}
