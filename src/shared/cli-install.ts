/**
 * Installing Claude Code or Codex from inside the app: the vendor's own installer, run for the
 * person with nothing to type. First launch, Settings and the chat's sign-in card show the job.
 */
import { StudioPlatform } from "./boot.ts";
import type { CodingProvider } from "./coding-cli.ts";
import { EngineId } from "./providers.ts";

/** Where an in-app CLI install stands. Sent to the renderer: never rename a value. */
export const CliInstallPhase = {
  Installing: "installing",
  Installed: "installed",
  Failed: "failed",
} as const;
export type CliInstallPhase = (typeof CliInstallPhase)[keyof typeof CliInstallPhase];

/** Why an in-app CLI install failed; the renderer words each one. Never rename a value. */
export const CliInstallProblem = {
  /** The installer could not be fetched: offline, blocked, or not served over HTTPS. */
  Download: "download",
  /** The installer ran and reported an error. */
  Installer: "installer",
  /** The installer did not finish in time and was stopped. */
  TimedOut: "timed-out",
  /** The installer finished, but the CLI is still not found or not usable. */
  NotFound: "not-found",
  /** The vendor publishes no installer Genex can run on this system: the person installs it by its guide. */
  Unsupported: "unsupported",
} as const;
export type CliInstallProblem = (typeof CliInstallProblem)[keyof typeof CliInstallProblem];

/**
 * The systems a CLI's vendor publishes no installer for that Genex can run: OpenCode installs on
 * Windows only through a package manager (Chocolatey, Scoop or npm), never a PowerShell script.
 */
const NO_IN_APP_INSTALL: Readonly<Record<string, readonly StudioPlatform[]>> = {
  [EngineId.OpenCode]: [StudioPlatform.Windows],
} satisfies Partial<Record<CodingProvider, readonly StudioPlatform[]>>;

/** Whether Genex can install `provider` itself on `platform` (`process.platform` spelling); else its guide does. */
export function installsInApp(provider: string, platform: string): boolean {
  const without: readonly string[] = Object.hasOwn(NO_IN_APP_INSTALL, provider) ? NO_IN_APP_INSTALL[provider] : [];
  return !without.includes(platform);
}

/** Why an install or update was refused before it started: its IPC failure's code. Never rename a value. */
export const CliInstallRefusal = {
  /** Not a CLI the app installs. */
  UnknownProvider: "unknown_provider",
  /** An update waits for active work to finish. */
  Busy: "busy",
} as const;
export type CliInstallRefusal = (typeof CliInstallRefusal)[keyof typeof CliInstallRefusal];

/** One provider's in-app install: the latest one, running or finished. */
export const CliInstallOperation = { Install: "install", Update: "update" } as const;
export type CliInstallOperation = (typeof CliInstallOperation)[keyof typeof CliInstallOperation];

export interface CliInstallJob {
  operation?: CliInstallOperation;
  provider: CodingProvider;
  phase: CliInstallPhase;
  problem?: CliInstallProblem;
  /** A failed download: the HTTP status it was refused with (a vendor blocking the region answers 403). */
  httpStatus?: number;
  /** A failed download that got no answer: Chromium's network error ("ERR_NAME_NOT_RESOLVED"). */
  netError?: string;
  startedAt: string;
  finishedAt?: string;
}
