/** Whether a process is still running, for tests that prove a stop left nothing behind. */
import { spawnSync } from "node:child_process";
import path from "node:path";

/** How `ps` marks a process that has exited but is not reaped yet. */
const ZOMBIE_STATE = "Z";

/**
 * Whether `pid` is still running: in the process table and not a zombie. `kill(pid, 0)` cannot
 * tell, as it also succeeds for a process that has exited but is not reaped yet. A stopped job's
 * descendant is reaped by launchd, because the job, its parent, stopped with it, and on a busy
 * machine a check can come first. On Windows the task list, which never lists a process that
 * exited, answers instead.
 */
export function running(pid: number): boolean {
  if (process.platform === "win32") return runningOnWindows(pid);
  const ps = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.error) throw ps.error;
  const state = ps.stdout.trim();
  return state !== "" && !state.startsWith(ZOMBIE_STATE);
}

/** Whether Windows' task list has `pid`: its row names the pid as its second field. */
function runningOnWindows(pid: number): boolean {
  const tasklist = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
  const list = spawnSync(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (list.error) throw list.error;
  return list.stdout.split(/\r?\n/).some((row) => row.split('","')[1] === String(pid));
}
