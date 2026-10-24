/**
 * Why the process sandbox cannot start, as a typed problem the window can show instead of a crash.
 *
 * `ProcessSandbox` raises {@link SandboxUnavailableError} when sandbox-runtime refuses the platform,
 * reports a missing dependency, or (Windows) has not been provisioned. Main catches it and opens
 * the "Set up the protected workspace" screen; any other startup failure keeps its error dialog.
 * The mapping reads typed inputs only: the platform, the runtime's verdicts, a PATH lookup, a
 * Windows error's `code` and (Linux) Ubuntu's user-namespace switch, this process's AppArmor
 * label, and the owners of the folders its executable is in, never the words of a message.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  APPARMOR_PATTERN_CHARACTERS,
  AppArmorBlockCode,
  LINUX_SANDBOX_TOOLS,
  SandboxProblemCode,
  StudioPlatform,
  linuxInstallCommands,
  type SandboxProblem,
  type SandboxTool,
  type WindowsSetupNeed,
} from "../shared/boot.ts";
import {
  type InspectPath,
  type PathOwner,
  type Person,
  type ReadSystemFile,
  USERNS_RESTRICTION_FILE,
  appArmorProfile,
  profileInstallCommand,
  profilePathRefusal,
  profileRemoveCommand,
  writableByOthers,
} from "./linux-apparmor.ts";

/** sandbox-runtime's Windows error codes that mean "not set up yet", not "broken". */
const WINDOWS_SETUP_CODES: ReadonlySet<string> = new Set(["not_provisioned", "wfp_fence_inactive"]);

/** Why a sandboxed command could not start, when the sandbox itself is set up. */
export const SandboxLaunchCode = {
  /** Windows: the command line would pass CreateProcess's 32,767-character limit. */
  ArgvTooLong: "argv-too-long",
  /** Windows: srt-win did not answer in time (its ACL calls block for up to a minute). */
  SrtWinTimeout: "srt-win-timeout",
  /** Windows: the working folder is on a mapped or network drive, which the sandbox user cannot see. */
  NetworkDrive: "network-drive",
  /** Windows: a run asked to write or read a folder outside the session's grants. */
  NotGranted: "not-granted",
  /** Windows: every port of srt-win's proxy range is reserved by Windows or held by another program. */
  ProxyPortsRefused: "proxy-ports-refused",
  /** Windows: Windows kept refusing to start srt-win as the sandbox user, after Genex tried again. */
  SandboxUserRefused: "sandbox-user-refused",
} as const;
export type SandboxLaunchCode = (typeof SandboxLaunchCode)[keyof typeof SandboxLaunchCode];

/** sandbox-runtime's Windows error codes that are a launch failure, and what they stand for. */
const WINDOWS_LAUNCH_CODES: ReadonlyMap<string, SandboxLaunchCode> = new Map([
  ["argv_too_long", SandboxLaunchCode.ArgvTooLong],
  ["srt_win_timeout", SandboxLaunchCode.SrtWinTimeout],
  ["mapped_drive_cwd", SandboxLaunchCode.NetworkDrive],
]);

/**
 * The loopback ports srt-win's egress filter lets the sandbox user reach, where its network proxies
 * must listen: sandbox-runtime's default, which Genex's install keeps.
 */
const SRT_PROXY_PORTS = "60080-60089";
/** What Windows answers a listen on a port it reserved (EACCES) or another program holds. */
const PORT_REFUSED: ReadonlySet<string> = new Set(["EACCES", "EADDRINUSE"]);
const LISTEN_SYSCALL = "listen";

const MESSAGE = {
  Unavailable: (problem: SandboxProblem) =>
    [`sandbox unavailable on ${problem.platform} (${problem.code})`, ...problem.details].join(": "),
  UsernsRestricted: `${USERNS_RESTRICTION_FILE} is 1 and no AppArmor profile names this process, so bubblewrap gets no capabilities in its user namespace`,
  Unnamable: (executable: string, refusal: string | null) =>
    `an AppArmor profile cannot name ${JSON.stringify(executable)} (${refusal}); move Genex to a folder whose path has none of ${APPARMOR_PATTERN_CHARACTERS.join(" ")}`,
  SharedFolder: (shared: string) =>
    `someone other than root and you can change ${JSON.stringify(shared)}, so a profile must not name a program under it; move Genex to a folder only you can write to, such as ~/Genex`,
  NotAttached: (file: string, executable: string) =>
    `${file} names ${JSON.stringify(executable)}, yet this process started without it: quit and reopen Genex; if this comes back, AppArmor does not attach the profile to this path`,
  Repoint: (file: string) => `${file} names another copy of Genex; Set up points it at this one instead`,
  Launch: {
    [SandboxLaunchCode.ArgvTooLong]:
      "The command is too long for Windows to start (over 32,767 characters). Put it in a script file and run that.",
    [SandboxLaunchCode.SrtWinTimeout]: "The Windows sandbox did not answer in time. Try again in a moment.",
    [SandboxLaunchCode.NetworkDrive]:
      "Commands cannot run in a folder on a mapped or network drive. Move the game to a local drive.",
    [SandboxLaunchCode.NotGranted]:
      "This folder is not open to sandboxed commands yet. It opens once the running commands finish; try again then.",
    [SandboxLaunchCode.ProxyPortsRefused]: `Windows did not let Genex's sandbox use its network ports (${SRT_PROXY_PORTS}). Hyper-V, WSL or Docker often reserve them. Restart the PC, or run "net stop winnat" and then "net start winnat" in a terminal opened as administrator, and try again.`,
    [SandboxLaunchCode.SandboxUserRefused]:
      "Windows would not start Genex's sandbox user. Restart the PC, then try again.",
  } satisfies Record<SandboxLaunchCode, string>,
} as const;

/** A sandboxed command could not start; `code` says why, the message says what to do. */
export class SandboxLaunchError extends Error {
  readonly code: SandboxLaunchCode;

  constructor(code: SandboxLaunchCode, detail?: string, options?: ErrorOptions) {
    super(detail ? `${MESSAGE.Launch[code]} (${detail})` : MESSAGE.Launch[code], options);
    this.code = code;
  }
}

/** The launch failure a sandbox-runtime Windows error stands for, by its `code`; null for any other error. */
export function windowsLaunchError(error: unknown): SandboxLaunchError | null {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const launch = typeof code === "string" ? WINDOWS_LAUNCH_CODES.get(code) : undefined;
  return launch ? new SandboxLaunchError(launch, undefined, { cause: error }) : null;
}

/**
 * The launch failure for a Windows start whose network proxies found no port they could listen
 * on, by the error's code and call; null for any other error. SRT tries each port of its range
 * and throws the last refusal.
 */
export function windowsProxyPortsError(error: unknown): SandboxLaunchError | null {
  if (!(error instanceof Error) || !("syscall" in error) || error.syscall !== LISTEN_SYSCALL) return null;
  const code = "code" in error ? error.code : undefined;
  if (typeof code !== "string" || !PORT_REFUSED.has(code)) return null;
  return new SandboxLaunchError(SandboxLaunchCode.ProxyPortsRefused, error.message, { cause: error });
}

/** The sandbox cannot start on this computer; `problem` says why and how to fix it. */
export class SandboxUnavailableError extends Error {
  readonly problem: SandboxProblem;

  constructor(problem: SandboxProblem) {
    super(MESSAGE.Unavailable(problem));
    this.problem = problem;
  }
}

/** What the sandbox checks found, before `initialize`. */
export interface SandboxCheck {
  platform: string;
  /** sandbox-runtime's `isSupportedPlatform()`. */
  supported: boolean;
  /** sandbox-runtime's `checkDependencies().errors`, shown as details only. */
  dependencyErrors: string[];
  /** Linux tools not found on PATH ({@link missingLinuxTools}). */
  missingTools: SandboxTool[];
  /** Linux: present while Ubuntu's user-namespace restriction holds for this process ({@link usernsCheck}). */
  userns?: UsernsCheck;
  /** Windows: what Set up does about the dependency errors, when the check says. */
  windowsNeeds?: WindowsSetupNeed[];
}

/** Linux under Ubuntu's restriction: what stands between this copy of Genex and its profile. */
export interface UsernsCheck {
  /** The resolved executable the profile would name ({@link runningExecutable}). */
  executable: string;
  /** The first of its folders (or itself) someone other than root and the person could replace. */
  sharedPath: string | null;
  /** The text of the profile file for this copy as it is installed now, or null when there is none. */
  installed: string | null;
}

/** What a test may hand the Linux user-namespace checks instead of the real system. */
export interface UsernsSeams {
  /** Reads the restriction switch, this process's label and the installed profile (default: the files). */
  read?: ReadSystemFile;
  /** The executable before it is resolved (default: `process.execPath`). */
  execPath?: string;
  /** Reads a folder's owner and mode (default: {@link inspectPath}). */
  inspect?: InspectPath;
  /** Who runs Genex (default: {@link currentPerson}). */
  person?: Person;
}

/** Linux under Ubuntu's restriction: the executable a profile would name, and what stands in its way. */
export function usernsCheck(seams: UsernsSeams = {}): UsernsCheck {
  const executable = runningExecutable(seams.execPath);
  const profile = appArmorProfile(executable);
  const sharedPath = writableByOthers(executable, seams.inspect ?? inspectPath, seams.person ?? currentPerson());
  const installed = profile ? (seams.read ?? readSystemFile)(profile.file) : null;
  return { executable, sharedPath, installed };
}

/**
 * Linux under Ubuntu's restriction: the problem, with the profile Set up would install for this
 * copy, or with the reason there is none and Details that name the path.
 */
function usernsProblem({ executable, sharedPath, installed }: UsernsCheck): SandboxProblem {
  const problem: SandboxProblem = {
    code: SandboxProblemCode.UsernsRestricted,
    platform: StudioPlatform.Linux,
    missingTools: [],
    installCommands: [],
    details: [MESSAGE.UsernsRestricted],
  };
  const blocked = (apparmorBlock: AppArmorBlockCode, detail: string): SandboxProblem => ({
    ...problem,
    apparmorBlock,
    details: [...problem.details, detail],
  });
  const profile = appArmorProfile(executable);
  if (!profile)
    return blocked(AppArmorBlockCode.Unnamable, MESSAGE.Unnamable(executable, profilePathRefusal(executable)));
  if (sharedPath) return blocked(AppArmorBlockCode.SharedFolder, MESSAGE.SharedFolder(sharedPath));
  // The same text is on disk, so an install has run and did not take: another Set up would not either.
  if (installed?.trim() === profile.text.trim())
    return blocked(AppArmorBlockCode.NotAttached, MESSAGE.NotAttached(profile.file, executable));
  const apparmor = {
    profile: profile.file,
    command: profileInstallCommand(profile),
    remove: profileRemoveCommand(profile),
  };
  const details = installed === null ? problem.details : [...problem.details, MESSAGE.Repoint(profile.file)];
  return { ...problem, details, apparmor };
}

/** The setup problem the checks describe, or null when the sandbox may initialize. */
export function sandboxProblem(check: SandboxCheck): SandboxProblem | null {
  const base = { platform: check.platform, missingTools: [], installCommands: [], details: check.dependencyErrors };
  if (!check.supported) return { ...base, code: SandboxProblemCode.UnsupportedPlatform };
  if (check.dependencyErrors.length === 0) {
    const onLinux = check.platform === StudioPlatform.Linux;
    return onLinux && check.userns ? usernsProblem(check.userns) : null;
  }
  if (check.platform === StudioPlatform.Windows) {
    const needs = check.windowsNeeds ? { windowsNeeds: check.windowsNeeds } : {};
    return { ...base, code: SandboxProblemCode.NotProvisioned, ...needs };
  }
  if (check.platform !== StudioPlatform.Linux) return { ...base, code: SandboxProblemCode.MissingTools };
  return {
    ...base,
    code: SandboxProblemCode.MissingTools,
    missingTools: check.missingTools,
    installCommands: linuxInstallCommands(check.missingTools),
  };
}

/** The setup problem a Windows `initialize` error stands for, by its `code`; null for any other error. */
export function windowsSetupProblem(error: unknown, details: string[] = []): SandboxProblem | null {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (typeof code !== "string" || !WINDOWS_SETUP_CODES.has(code)) return null;
  return {
    code: SandboxProblemCode.NotProvisioned,
    platform: StudioPlatform.Windows,
    missingTools: [],
    installCommands: [],
    details,
  };
}

/** Windows: no Git for Windows, so no Git Bash for sandboxed commands; Retry finds a new install. */
export function gitMissingProblem(): SandboxProblem {
  return {
    code: SandboxProblemCode.GitMissing,
    platform: StudioPlatform.Windows,
    missingTools: [],
    installCommands: [],
    details: [],
  };
}

/** Is `command` an executable file in one of PATH's directories? */
export function onPath(command: string, searchPath = process.env.PATH ?? ""): boolean {
  return searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      const file = path.join(dir, command);
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/** The Linux sandbox tools `found` cannot find, in install order. */
export function missingLinuxTools(found: (command: string) => boolean = (command) => onPath(command)): SandboxTool[] {
  return LINUX_SANDBOX_TOOLS.filter((tool) => !found(tool));
}

/** A system file's text, or null when it cannot be read (absent on this kernel, or not Linux). */
export function readSystemFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The running executable as the kernel attaches a profile to it: its resolved path. */
export function runningExecutable(execPath: string = process.execPath): string {
  try {
    return realpathSync(execPath);
  } catch {
    return execPath;
  }
}

/** A path's owner and mode, following links, or null when it cannot be read. */
export function inspectPath(file: string): PathOwner | null {
  try {
    const { uid, gid, mode } = statSync(file);
    return { uid, gid, mode };
  } catch {
    return null;
  }
}

/** The person this process runs as: its user and primary group (-1 where there are none, Windows). */
export function currentPerson(): Person {
  return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
}
