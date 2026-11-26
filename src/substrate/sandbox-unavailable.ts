/**
 * Why the process sandbox cannot start, as a typed problem the window can show instead of a crash.
 *
 * `ProcessSandbox` raises {@link SandboxUnavailableError} when sandbox-runtime refuses the platform,
 * reports a missing dependency, or (Windows) has not been provisioned. Main catches it and opens
 * the "Set up the protected workspace" screen; any other startup failure keeps its error dialog.
 * The mapping reads typed inputs only: the platform, the runtime's verdicts, a PATH lookup and a
 * Windows error's `code`, never the words of a message.
 */
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import {
  type BootFailureCode,
  LINUX_SANDBOX_TOOLS,
  SandboxLaunchCode,
  SandboxProblemCode,
  SandboxSetupFailure,
  StudioPlatform,
  linuxInstallCommands,
  type SandboxProblem,
  type SandboxTool,
  WindowsSetupNeed,
} from "../shared/boot.ts";

/**
 * sandbox-runtime's Windows error codes that mean "not set up yet", not "broken", and what Set up
 * does about each; null is the sandbox install, which the problem then leaves unsaid.
 */
const WINDOWS_SETUP_CODES: ReadonlyMap<string, WindowsSetupNeed | null> = new Map([
  ["not_provisioned", null],
  ["wfp_fence_inactive", null],
  ["reinstall_required", WindowsSetupNeed.Reinstall],
  ["seclogon_disabled", WindowsSetupNeed.LogonService],
]);

/** Why a sandboxed command could not start; its home is `shared/boot.ts`, beside the boot's own codes. */
export { SandboxLaunchCode };

/** sandbox-runtime's Windows error codes that are a launch failure, and what they stand for. */
const WINDOWS_LAUNCH_CODES: ReadonlyMap<string, SandboxLaunchCode> = new Map([
  ["argv_too_long", SandboxLaunchCode.ArgvTooLong],
  ["srt_win_timeout", SandboxLaunchCode.SrtWinTimeout],
  ["mapped_drive_cwd", SandboxLaunchCode.NetworkDrive],
]);

/**
 * The loopback ports srt-win's egress filter lets the sandbox user reach, where its network proxies
 * must listen: sandbox-runtime's default, which Genex's install keeps (lowest and highest, inclusive).
 */
export const SRT_PROXY_PORT_RANGE: readonly [number, number] = [60080, 60089];
const SRT_PROXY_PORTS = SRT_PROXY_PORT_RANGE.join("-");
/** sandbox-runtime's code for an srt-win install that could not make the sandbox user. */
const INSTALL_USER_FAILED = "install_user_failed";
/** srt-win's line for the Windows call that refused the account, and that call's Win32 error. */
const NET_USER_ADD_REFUSAL = /NetUserAdd\(srt-sandbox\): (\d+)/;

/** What Windows answers a listen on a port it reserved (EACCES) or another program holds. */
const PORT_REFUSED: ReadonlySet<string> = new Set(["EACCES", "EADDRINUSE"]);
const LISTEN_SYSCALL = "listen";

const MESSAGE = {
  Unavailable: (problem: SandboxProblem) =>
    [`sandbox unavailable on ${problem.platform} (${problem.code})`, ...problem.details].join(": "),
  Launch: {
    [SandboxLaunchCode.ArgvTooLong]:
      "The command is too long for Windows to start (over 32,767 characters). Put it in a script file and run that.",
    [SandboxLaunchCode.SrtWinTimeout]:
      "The Windows sandbox did not answer in time. An antivirus that scans every file can slow it this much: add Genex's folders to its exclusions, then try again.",
    [SandboxLaunchCode.NetworkDrive]:
      "Commands cannot run in a folder on a mapped or network drive. Move the game to a local drive.",
    [SandboxLaunchCode.NotGranted]:
      "This folder is not open to sandboxed commands yet. It opens once the running commands finish; try again then.",
    [SandboxLaunchCode.WriteRefused]:
      "Windows did not let Genex open this folder to its agents: your account may not change the folder's permissions (another account owns it, or it is protected). Move the game into a folder of your own, or make your account the folder's owner, then restart Genex.",
    [SandboxLaunchCode.ProxyPortsRefused]: `Windows did not let Genex's sandbox use its network ports (${SRT_PROXY_PORTS}). Hyper-V, WSL or Docker often reserve them. Restart the PC, or run "net stop winnat" and then "net start winnat" in a terminal opened as administrator, and try again.`,
    [SandboxLaunchCode.SandboxUserRefused]:
      "Windows would not start Genex's sandbox user. Restart the PC, then try again.",
    [SandboxLaunchCode.LogonRightRefused]:
      'A policy on this PC does not let Genex\'s sandbox user sign in, and Set up could not change that. Ask the PC\'s administrator, or check your security program: the account "srt-sandbox" needs "Allow log on locally" and must not be under "Deny log on locally" (Local Security Policy, User Rights Assignment). Then restart Genex.',
  } satisfies Record<SandboxLaunchCode, string>,
  Setup: {
    [SandboxSetupFailure.UserNotCreated]: (windowsError: number | null) =>
      `Windows did not let Genex create the local account its agents run as ("srt-sandbox"${windowsError === null ? "" : `, Windows error ${windowsError}`}). A security program, a work or school device policy, or a local password policy can block new accounts. Check your security program, or ask the PC's administrator to allow it, then press Set up again.`,
  } satisfies Record<SandboxSetupFailure, (windowsError: number | null) => string>,
} as const;

/**
 * Set up of the protected workspace failed for a reason Genex knows: `code` says which, the
 * message says what to do, then srt-win's own words; `windowsError` is the Win32 error Windows
 * answered, when srt-win named it.
 */
export class SandboxSetupError extends Error {
  readonly code: SandboxSetupFailure;
  readonly windowsError: number | null;

  constructor(code: SandboxSetupFailure, windowsError: number | null, detail: string, options?: ErrorOptions) {
    super(`${MESSAGE.Setup[code](windowsError)} (${detail})`, options);
    this.code = code;
    this.windowsError = windowsError;
  }
}

/**
 * The Set up failure a sandbox-runtime install error stands for, by its `code`; null for any other
 * error. A sandbox user Windows would not create (`NetUserAdd`, with Windows' error, which a field PC
 * answered with 1783 at every try) is one the person, not Genex, can lift.
 */
export function windowsSetupError(error: unknown): SandboxSetupError | null {
  if (!(error instanceof Error) || !("code" in error) || error.code !== INSTALL_USER_FAILED) return null;
  const windowsError = NET_USER_ADD_REFUSAL.exec(error.message)?.[1];
  const code = windowsError === undefined ? null : Number(windowsError);
  return new SandboxSetupError(SandboxSetupFailure.UserNotCreated, code, error.message, { cause: error });
}

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

/** How deep {@link sandboxStartFailureCode} follows an error's `cause`. */
const CAUSE_DEPTH_MAX = 4;

/**
 * The sandbox's code for a start that failed because of it: the setup problem, a Set up that failed,
 * or why its commands could not start (Windows' reserved proxy ports), read from the error or the
 * causes it wraps; null for any other failure.
 */
export function sandboxStartFailureCode(error: unknown): BootFailureCode | null {
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH_MAX && current instanceof Error; depth++) {
    if (current instanceof SandboxUnavailableError) return current.problem.code;
    if (current instanceof SandboxLaunchError) return current.code;
    if (current instanceof SandboxSetupError) return current.code;
    current = current.cause;
  }
  return null;
}

/** The setup problem a failed start is, read from the error or the causes it wraps; null for any other failure. */
export function sandboxSetupProblem(error: unknown): SandboxProblem | null {
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH_MAX && current instanceof Error; depth++) {
    if (current instanceof SandboxUnavailableError) return current.problem;
    current = current.cause;
  }
  return null;
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
  /** Windows: what Set up does about the dependency errors, when the check says. */
  windowsNeeds?: WindowsSetupNeed[];
}

/** The setup problem the checks describe, or null when the sandbox may initialize. */
export function sandboxProblem(check: SandboxCheck): SandboxProblem | null {
  const base = { platform: check.platform, missingTools: [], installCommands: [], details: check.dependencyErrors };
  if (!check.supported) return { ...base, code: SandboxProblemCode.UnsupportedPlatform };
  if (check.dependencyErrors.length === 0) return null;
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
  const need = WINDOWS_SETUP_CODES.get(code);
  return {
    code: SandboxProblemCode.NotProvisioned,
    platform: StudioPlatform.Windows,
    missingTools: [],
    installCommands: [],
    details,
    ...(need ? { windowsNeeds: [need] } : {}),
  };
}

/** Windows: the sandbox is installed and Set up still has `need` to do, with the words for Details. */
export function windowsNeedProblem(need: WindowsSetupNeed, details: string[] = []): SandboxProblem {
  return {
    code: SandboxProblemCode.NotProvisioned,
    platform: StudioPlatform.Windows,
    missingTools: [],
    installCommands: [],
    details,
    windowsNeeds: [need],
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
