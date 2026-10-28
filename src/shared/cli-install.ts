/**
 * Installing Claude Code or Codex from inside the app: the vendor's own installer, run for the
 * person with nothing to type. First launch, Settings and the chat's sign-in card show the job.
 */
import type { CodingProvider } from "./coding-cli.ts";

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
} as const;
export type CliInstallProblem = (typeof CliInstallProblem)[keyof typeof CliInstallProblem];

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
  startedAt: string;
  finishedAt?: string;
}
