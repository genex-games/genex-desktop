/**
 * How the window starts: which operating system it runs on (the renderer lays out its window
 * chrome by it) and whether startup is complete or waiting on the protected workspace, the
 * process sandbox every agent runs in. Browser-safe: main answers `StudioApi.bootState` with it.
 */
import type { DataMoveProgress } from "./data-folder.ts";

/** The operating systems Studio builds for, in Node's `process.platform` spelling. */
export const StudioPlatform = {
  Mac: "darwin",
  Windows: "win32",
  Linux: "linux",
} as const;
export type StudioPlatform = (typeof StudioPlatform)[keyof typeof StudioPlatform];

/** Where startup stands, as the window shows it. */
export const BootPhase = {
  /** The core started: the studio itself is on screen. */
  Ready: "ready",
  /** The sandbox cannot start: the window shows how to set it up, and Retry. */
  SandboxSetup: "sandbox-setup",
  /** Windows: the core is starting, and the window says which step it is on. */
  Starting: "starting",
  /** The studio's harness would not start: the window says so, with Try again, a report and Quit. */
  Failed: "failed",
  /** Genex is moving its data to the folder chosen in Settings → Storage, then starts again. */
  Moving: "moving",
  /** The folder Genex keeps its data in is not there (its drive is unplugged): Try again or Quit. */
  DataMissing: "data-missing",
} as const;
export type BootPhase = (typeof BootPhase)[keyof typeof BootPhase];

/** What a starting core is doing, as the window's status line says it. */
export const StartStep = {
  /** Reading the settings and preparing the agents' own workspace (a first start commits it). */
  Agents: "agents",
  /** Reading the event log and the games. */
  Games: "games",
  /** Starting the protected workspace: on Windows the slow step, with its network check. */
  Workspace: "workspace",
  /** Plugins, jobs and the engines, then the window opens on the studio. */
  Studio: "studio",
} as const;
export type StartStep = (typeof StartStep)[keyof typeof StartStep];

/** Why the sandbox cannot start. */
export const SandboxProblemCode = {
  /** Linux: bubblewrap, socat or ripgrep is not installed. */
  MissingTools: "missing-tools",
  /** An operating system (or WSL 1) sandbox-runtime cannot contain processes on. */
  UnsupportedPlatform: "unsupported-platform",
  /** Windows: the sandbox user and its network filter have not been installed yet. */
  NotProvisioned: "not-provisioned",
  /** Windows: Git for Windows is not installed, so there is no Git Bash to run commands in. */
  GitMissing: "git-missing",
  /**
   * Linux: the tools are installed but the sandbox cannot start a process, most often because the
   * system lets only programs an AppArmor profile allows create user namespaces (Ubuntu 24.04 and
   * the distributions built on it).
   */
  IsolationBlocked: "isolation-blocked",
} as const;
export type SandboxProblemCode = (typeof SandboxProblemCode)[keyof typeof SandboxProblemCode];

/** Windows, not provisioned: what Set up does about it. */
export const WindowsSetupNeed = {
  /** Install the `srt-sandbox` user, its credential and its network filters (srt-win's install). */
  Sandbox: "sandbox",
  /**
   * Turn the Secondary Logon service (`seclogon`) back on: every sandboxed command starts as the
   * sandbox user through it, so with it disabled Windows refuses each one.
   */
  LogonService: "logon-service",
} as const;
export type WindowsSetupNeed = (typeof WindowsSetupNeed)[keyof typeof WindowsSetupNeed];

/** The programs the Linux sandbox needs, by the command it runs. */
export const SandboxTool = {
  Bubblewrap: "bwrap",
  Socat: "socat",
  Ripgrep: "rg",
} as const;
export type SandboxTool = (typeof SandboxTool)[keyof typeof SandboxTool];

/** The Linux package managers the setup screen gives an install command for. */
export const PackageManager = {
  /** Debian and Ubuntu. */
  Apt: "apt",
  /** Fedora and RHEL. */
  Dnf: "dnf",
} as const;
export type PackageManager = (typeof PackageManager)[keyof typeof PackageManager];

/** One command that installs what is missing, and the package manager it is for. */
export interface InstallCommand {
  manager: PackageManager;
  command: string;
}

/** Every tool the Linux sandbox needs, in install order. */
export const LINUX_SANDBOX_TOOLS: readonly SandboxTool[] = Object.values(SandboxTool);

/** The package that installs each tool; apt, dnf and pacman share the names. */
const TOOL_PACKAGE = {
  [SandboxTool.Bubblewrap]: "bubblewrap",
  [SandboxTool.Socat]: "socat",
  [SandboxTool.Ripgrep]: "ripgrep",
} as const satisfies Record<SandboxTool, string>;

/** What stops the sandbox, and what the person can do about it. */
export interface SandboxProblem {
  code: SandboxProblemCode;
  /** The platform the problem was found on, in `process.platform` spelling. */
  platform: string;
  /** Linux tools that are not on the PATH; empty for other problems. */
  missingTools: SandboxTool[];
  /** Commands that install what is missing, one per package manager; empty when there is none. */
  installCommands: InstallCommand[];
  /** sandbox-runtime's own findings, for Details. */
  details: string[];
  /** Isolation blocked by AppArmor: the command that installs a profile allowing it for this app. */
  allowCommand?: string;
  /** Windows, not provisioned: what Set up does; absent means the sandbox install alone. */
  windowsNeeds?: WindowsSetupNeed[];
}

/** Main's answer to `bootState`: the platform, and the setup problem while the phase is SandboxSetup. */
export interface BootState {
  platform: string;
  phase: BootPhase;
  sandbox: SandboxProblem | null;
  /**
   * A Set up has already run this launch, so a window that loads again (after a renderer crash)
   * does not raise Windows' approval prompt again unasked. Absent until then.
   */
  setupTried?: true;
  /** What the core is doing while the phase is Starting. */
  step?: StartStep;
  /**
   * Why the studio would not start, while the phase is Failed; why its agents would not, while it
   * is Ready; why a move of Genex's data stopped, while the phase is Moving.
   */
  failure?: string;
  /** How far the move is, while the phase is Moving. */
  move?: DataMoveProgress;
  /** The folder that is not there, while the phase is DataMissing. */
  dataFolder?: string;
}

/** How Set up (Windows) ended when it did not fail. */
export const SandboxSetupOutcome = {
  /** Installed; startup ran again, and `state` says where it stands now. */
  Installed: "installed",
  /** The person dismissed the administrator prompt: nothing changed. */
  Cancelled: "cancelled",
} as const;
export type SandboxSetupOutcome = (typeof SandboxSetupOutcome)[keyof typeof SandboxSetupOutcome];

/** Main's answer to `setUpSandbox`. */
export interface SandboxSetupResult {
  outcome: SandboxSetupOutcome;
  state: BootState;
}

/** The package that installs `tool`. */
export function toolPackage(tool: SandboxTool): string {
  return TOOL_PACKAGE[tool];
}

/** The apt and dnf commands that install `tools` (all of them when none is named). */
export function linuxInstallCommands(tools: readonly SandboxTool[]): InstallCommand[] {
  const packages = (tools.length ? tools : LINUX_SANDBOX_TOOLS).map(toolPackage).join(" ");
  return Object.values(PackageManager).map((manager) => ({ manager, command: `sudo ${manager} install ${packages}` }));
}
