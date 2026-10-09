/**
 * The Windows sandbox's one-time install, which the setup screen's Set up runs (main/boot-gate.ts).
 *
 * sandbox-runtime's `installWindowsSandboxAsync` starts its vendored srt-win elevated: one
 * administrator (UAC) prompt, then the `srt-sandbox` user and its network filters. A dismissed
 * prompt is not an error (srt-win exits 10 and nothing changes); any other failure throws.
 * In a packaged app srt-win.exe is unpacked beside the archive, because Windows cannot run a file
 * from inside app.asar. sandbox-runtime is loaded on first use: imported eagerly, it cost every
 * launch on every platform about a third of a second before the first window.
 */
import path from "node:path";
import { MINUTE_MS } from "../shared/duration.ts";
import { activateWindowsGit, ensureWindowsGit } from "./windows-git.ts";

/** Past the ~2 minutes after which Windows dismisses an unanswered UAC prompt on its own. */
const INSTALL_TIMEOUT_MS = 3 * MINUTE_MS;
const MESSAGE = {
  Incomplete: "Windows sandbox setup did not finish. Choose Set up to try again and approve the Windows prompt.",
} as const;
type SetupRuntime = Pick<
  typeof import("@anthropic-ai/sandbox-runtime"),
  | "installWindowsSandboxAsync"
  | "resolveSrtWin"
  | "checkWindowsSandboxStatusAsync"
  | "grantWindowsAcl"
  | "revokeWindowsAcl"
  | "verifyWindowsWfpEgress"
>;

function ready(status: import("@anthropic-ai/sandbox-runtime").WindowsInstallResult): boolean {
  const userReady = status.user.provisioned && status.user.credPresent && !!status.user.sid;
  return userReady && status.wfp.state !== "absent";
}

/** BFE enumeration alone cannot prove containment, especially for a non-administrator. */
async function sandboxReady(
  status: import("@anthropic-ai/sandbox-runtime").WindowsInstallResult,
  srtWin: import("@anthropic-ai/sandbox-runtime").SrtWinSpawn,
  runtime: SetupRuntime,
): Promise<boolean> {
  const sandboxUserSid = status.user.sid;
  if (!ready(status) || !sandboxUserSid) return false;
  // Setup runs before a core exists. Only the exact helper receives a temporary bootstrap grant.
  try {
    runtime.grantWindowsAcl({ read: [srtWin.exe], write: [], sandboxUserSid, srtWin });
    await runtime.verifyWindowsWfpEgress({ srtWin });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "wfp_fence_inactive") return false;
    throw error;
  } finally {
    runtime.revokeWindowsAcl({ sandboxUserSid, srtWin });
  }
}

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

/** Install the Windows sandbox; `cancelled` when the administrator prompt was dismissed. */
export async function installWindowsSandbox(runtime?: SetupRuntime): Promise<{ cancelled: boolean }> {
  const srt = runtime ?? (await import("@anthropic-ai/sandbox-runtime"));
  const { installWindowsSandboxAsync, resolveSrtWin, checkWindowsSandboxStatusAsync } = srt;
  const srtWin = resolveSrtWin({ path: await srtWinPath() });
  // SDK installation rotates the shared account's password. Preserve already working installs.
  if (await sandboxReady(await checkWindowsSandboxStatusAsync({ srtWin }), srtWin, srt)) return { cancelled: false };
  const result = await installWindowsSandboxAsync({ srtWin, timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.cancelled) return { cancelled: true };
  if (!(await sandboxReady(result, srtWin, srt))) throw new Error(MESSAGE.Incomplete);
  return { cancelled: false };
}

/** All Windows first-run prerequisites from the app: private Git when missing, then shipped Sandbox. */
export async function installWindowsPrerequisites(data: string): Promise<{ cancelled: boolean }> {
  activateWindowsGit(await ensureWindowsGit(data));
  return installWindowsSandbox();
}
