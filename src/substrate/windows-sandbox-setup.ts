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

/** Install the Windows sandbox; `cancelled` when the administrator prompt was dismissed. */
export async function installWindowsSandbox(): Promise<{ cancelled: boolean }> {
  const { installWindowsSandboxAsync, resolveSrtWin } = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = resolveSrtWin({ path: await srtWinPath() });
  const result = await installWindowsSandboxAsync({ srtWin, timeoutMs: INSTALL_TIMEOUT_MS });
  return { cancelled: result.cancelled === true };
}
