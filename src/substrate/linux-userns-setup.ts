/**
 * Set up on Linux: install Genex's AppArmor profile for the running copy behind one polkit prompt
 * (`main/boot-gate.ts` runs it; `linux-apparmor.ts` writes the profile and the script).
 *
 * pkexec, found by its absolute path, runs a fixed `sh -c` script as root with the profile's file
 * and text as its arguments; the text comes from the resolved executable path. A path a profile
 * cannot name, or one someone other than root and the person could replace, is refused before any
 * prompt. pkexec answers 126 when the person dismisses the prompt, and nothing has changed then:
 * the script's own failures exit with codes pkexec never uses (`InstallExit`). The running process
 * keeps the label it started with, since AppArmor attaches a profile at exec, so a successful
 * install asks for a restart. Like the Windows sandbox install, this runs outside `ProcessSandbox`:
 * it is the step that lets the sandbox start, and it runs only on the click.
 */
import { execFile } from "node:child_process";
import { APPARMOR_PATTERN_CHARACTERS } from "../shared/boot.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { InstallExit, appArmorProfile, pkexecArgv, writableByOthers } from "./linux-apparmor.ts";
import { type UsernsSeams, currentPerson, inspectPath, onPath, runningExecutable } from "./sandbox-unavailable.ts";

/** pkexec's exit status when the person dismissed the authentication dialog (pkexec(1)). */
const PKEXEC_DISMISSED = 126;
/** How long the password prompt may wait for an answer before the install gives up. */
const INSTALL_TIMEOUT_MS = 5 * MINUTE_MS;
/** How much of a failed install's error output the message keeps, in characters. */
const STDERR_TAIL_CHARS = 2000;
/**
 * Where polkit installs pkexec. It runs by absolute path so that nothing earlier on the desktop
 * session's PATH (`~/.local/bin`) can stand in for it and show a password prompt of its own.
 */
const PKEXEC_DIRS = ["/usr/bin", "/bin"] as const;
const PKEXEC = "pkexec";
/** The error code of a program that could not be found to start. */
const NOT_FOUND = "ENOENT";

const MESSAGE = {
  unnamable: (executable: string) =>
    `Genex's folder cannot be named in an AppArmor profile: ${JSON.stringify(executable)}. Move Genex to a folder whose path has none of ${APPARMOR_PATTERN_CHARACTERS.join(" ")}.`,
  sharedFolder: (shared: string) =>
    `Someone other than root and you can change ${JSON.stringify(shared)}, so Genex's AppArmor profile must not name a program under it. Move Genex to a folder only you can write to, such as ~/Genex.`,
  noPkexec:
    "pkexec, which asks for the administrator password, isn't installed. Add the profile with the command under “Add it in a terminal instead”.",
  notWritten: (stderr: string) => `Genex's AppArmor profile could not be written. ${stderr}`.trim(),
  notLoaded: (stderr: string) => `AppArmor refused Genex's profile, so it was removed again. ${stderr}`.trim(),
  failed: (code: number, stderr: string) =>
    `Installing Genex's AppArmor profile failed (exit ${code}). ${stderr}`.trim(),
  unfinished: (stderr: string) => `Installing Genex's AppArmor profile did not finish. ${stderr}`.trim(),
} as const;

/**
 * How a privileged run ended: its exit status (null when it did not start or was stopped), its
 * error output, and `missing` when the program itself was not there to start.
 */
export interface PrivilegedRun {
  code: number | null;
  stderr: string;
  missing?: boolean;
}

/** Run `argv` (pkexec first) and settle with how it ended; never rejects. */
export type RunPrivileged = (argv: string[], timeoutMs: number) => Promise<PrivilegedRun>;

/** Test seams: the system the checks read, pkexec's path (null for none) and the privileged run. */
export interface LinuxUsernsSetupOptions extends UsernsSeams {
  pkexec?: string | null;
  run?: RunPrivileged;
}

/** pkexec for real: its exit status and error output, or null when it could not start or timed out. */
const runPkexec: RunPrivileged = (argv, timeoutMs) => {
  const [file = "", ...args] = argv;
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stderr });
        return;
      }
      const code = typeof error.code === "number" ? error.code : null;
      resolve({ code, stderr: stderr || error.message, missing: error.code === NOT_FOUND });
    });
  });
};

/** pkexec's absolute path, or null where polkit is not installed. */
function findPkexec(): string | null {
  const dir = PKEXEC_DIRS.find((candidate) => onPath(PKEXEC, candidate));
  return dir ? `${dir}/${PKEXEC}` : null;
}

/** Why a finished privileged run failed, or null when it installed the profile. */
function installFailure({ code, stderr }: PrivilegedRun): Error | null {
  const tail = stderr.trim().slice(-STDERR_TAIL_CHARS);
  if (code === 0) return null;
  if (code === null) return new Error(MESSAGE.unfinished(tail));
  if (code === InstallExit.NotWritten) return new Error(MESSAGE.notWritten(tail));
  if (code === InstallExit.NotLoaded) return new Error(MESSAGE.notLoaded(tail));
  return new Error(MESSAGE.failed(code, tail));
}

/**
 * Install the profile for the running copy of Genex. `cancelled` when the prompt was dismissed;
 * otherwise installed, and `restart` asks main to start the app again. Throws when the folder cannot
 * be named in a profile or others could change it, when there is no pkexec, or when the install fails.
 */
export async function installLinuxUsernsProfile(
  options: LinuxUsernsSetupOptions = {},
): Promise<{ cancelled: boolean; restart: boolean }> {
  const executable = runningExecutable(options.execPath);
  const profile = appArmorProfile(executable);
  if (!profile) throw new Error(MESSAGE.unnamable(executable));
  const shared = writableByOthers(executable, options.inspect ?? inspectPath, options.person ?? currentPerson());
  if (shared) throw new Error(MESSAGE.sharedFolder(shared));
  const pkexec = options.pkexec === undefined ? findPkexec() : options.pkexec;
  if (!pkexec) throw new Error(MESSAGE.noPkexec);
  const ran = await (options.run ?? runPkexec)(pkexecArgv(profile, pkexec), INSTALL_TIMEOUT_MS);
  if (ran.missing) throw new Error(MESSAGE.noPkexec);
  if (ran.code === PKEXEC_DISMISSED) return { cancelled: true, restart: false };
  const failure = installFailure(ran);
  if (failure) throw failure;
  return { cancelled: false, restart: true };
}
