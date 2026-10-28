/**
 * A native game's window on Linux, as far as Genex can tell from outside: Linux has no window list
 * every session shares (Wayland gives one to no other program), so a game counts as on screen once
 * it has kept running for a few seconds, and quitting before then is a failed start. The window
 * manager brings a new window forward by itself, so showing one does nothing.
 */
import { SECOND_MS } from "../../shared/duration.ts";

/** How long a Linux game must keep running to count as on screen. */
export const LINUX_GAME_SETTLE_MS = 3 * SECOND_MS;

/** What the check reads: whether a process is alive, and the time. */
export interface LinuxWindowDeps {
  alive(pid: number): boolean;
  now(): number;
}

/** Whether `pid` is alive (`kill(pid, 0)`), never a throw. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SYSTEM: LinuxWindowDeps = { alive: processAlive, now: Date.now };

/** The launcher's `hasWindow` and `show` on Linux: on screen once up for {@link LINUX_GAME_SETTLE_MS}. */
export function linuxGameWindows(deps: LinuxWindowDeps = SYSTEM) {
  const firstSeen = new Map<number, number>();
  return {
    async hasWindow(pid: number): Promise<boolean> {
      if (!deps.alive(pid)) {
        firstSeen.delete(pid);
        return false;
      }
      const since = firstSeen.get(pid) ?? deps.now();
      firstSeen.set(pid, since);
      const settled = deps.now() - since >= LINUX_GAME_SETTLE_MS;
      if (settled) firstSeen.delete(pid);
      return settled;
    },
    async show(_pid: number): Promise<void> {},
  };
}
