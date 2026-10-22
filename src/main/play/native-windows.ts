/**
 * A native game's window as Genex sees it from outside the game: whether the process has a window
 * on screen (Core Graphics' window list, which names a window's owner without Screen Recording) and
 * bringing it forward (`NSRunningApplication.activateWithOptions`). macOS does not bring a program
 * started this way forward by itself while another app is in front, so Genex does. Both run as
 * JavaScript for Automation through `osascript`; the scripts are constants and the process id is
 * their only argument, never spliced into their text. Neither sends an Apple event or input.
 */
import { execFile } from "node:child_process";
import { SECOND_MS } from "../../shared/duration.ts";

/** The program that runs the scripts. */
const OSASCRIPT = "/usr/bin/osascript";
/** How long one script may take. */
const SCRIPT_TIMEOUT_MS = 5 * SECOND_MS;

/** "1" when the process named by the argument owns a normal window on screen, else "0". */
const HAS_WINDOW_SCRIPT = `ObjC.import("CoreGraphics");
function run(argv) {
  const pid = Number(argv[0]);
  const onScreenOnly = 1;
  const withoutDesktop = 16;
  const info = $.CGWindowListCopyWindowInfo(onScreenOnly | withoutDesktop, 0);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
  return list.some((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0) ? "1" : "0";
}`;

/** Brings every window of the process named by the argument forward; "asked", "refused" or "none". */
const ACTIVATE_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (app.isNil()) return "none";
  return app.activateWithOptions($.NSApplicationActivateAllWindows) ? "asked" : "refused";
}`;

/** Run one script with `pid` as its argument; its output, or "" when it failed. */
function script(source: string, pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      OSASCRIPT,
      ["-l", "JavaScript", "-e", source, String(pid)],
      { timeout: SCRIPT_TIMEOUT_MS },
      (error, stdout) => resolve(error ? "" : String(stdout).trim()),
    );
  });
}

/** Whether process `pid` has a window on screen. */
export const hasGameWindow = async (pid: number): Promise<boolean> => (await script(HAS_WINDOW_SCRIPT, pid)) === "1";

/** Bring process `pid`'s windows forward. */
export async function showGameWindow(pid: number): Promise<void> {
  await script(ACTIVATE_SCRIPT, pid);
}
