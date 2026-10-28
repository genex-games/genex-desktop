/**
 * What main knows about this launch's session and the one before it, as typed facts only: how the
 * previous session ended (`main/session-marker.ts` keeps a small marker in the data folder), and
 * main's own diagnostics (an error nothing caught, a window that stopped answering). The renderer
 * reports them through usage analytics (`renderer/analytics/events/launch.ts`) after the person's
 * yes; nothing here holds words, paths or ids. Browser-safe.
 */
import type { StartFacts } from "./boot.ts";

/** Why a window's page went away, in Electron's own spelling (`render-process-gone`'s `reason`). */
export const RendererGone = {
  CleanExit: "clean-exit",
  AbnormalExit: "abnormal-exit",
  Killed: "killed",
  Crashed: "crashed",
  Oom: "oom",
  LaunchFailed: "launch-failed",
  IntegrityFailure: "integrity-failure",
  MemoryEviction: "memory-eviction",
} as const;
export type RendererGone = (typeof RendererGone)[keyof typeof RendererGone];

/** How the previous session ended, read from the marker it left. */
export const SessionExit = {
  /** It quit through Genex's own quit. */
  Clean: "clean",
  /** It was still running when it stopped: a crash, a force quit, a power cut. */
  Unclean: "unclean",
  /** It quit or relaunched into an update, and this launch runs the new version. */
  UpdateInstalled: "update_installed",
  /** It relaunched into an update, and this launch still runs the old version. */
  UpdateInterrupted: "update_interrupted",
} as const;
export type SessionExit = (typeof SessionExit)[keyof typeof SessionExit];

/** The previous session, as counts and enums: never its version, its folder or its words. */
export interface PreviousSession {
  exit: SessionExit;
  /** Pages that went away for any reason but a clean exit. */
  rendererCrashes: number;
  /** Why the last of them went away; null when none did. */
  lastCrash: RendererGone | null;
  /** Times a window stopped answering. */
  hangs: number;
  /** Errors main's own process caught nowhere. */
  mainErrors: number;
  /** Background update checks, downloads or installs that failed. */
  updateFailures: number;
  /** From its start to the last moment it was seen alive; null when the marker could not say. */
  uptimeMs: number | null;
}

/** What main hands the first bootstrap of a launch (`Bootstrap.launch`), and no later one. */
export interface LaunchFacts {
  /** How the session before this one ended; null on a first launch or when its marker could not be read. */
  previous: PreviousSession | null;
  /** How this launch started, before the studio opened. */
  start: StartFacts;
}

/** What main's own process tells the window about itself (`UiEvent.AppDiagnostic`). */
export const MainDiagnostic = {
  /** An exception nothing caught; main logged it and stayed up. */
  Uncaught: "uncaught",
  /** A promise rejected with nothing to catch it. */
  Rejection: "rejection",
  /** The window stopped answering and answers again: `durationMs` says for how long. */
  Unresponsive: "unresponsive",
} as const;
export type MainDiagnostic = (typeof MainDiagnostic)[keyof typeof MainDiagnostic];
