/** Where a model or runtime install is. Persisted in install records: never rename a value. */
export const InstallPhase = {
  Preflight: "preflight",
  Downloading: "downloading",
  Verifying: "verifying",
  Extracting: "extracting",
  Installed: "installed",
  Starting: "starting",
  Ready: "ready",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
export type InstallPhase = (typeof InstallPhase)[keyof typeof InstallPhase];
/** A plugin runtime install's phase: a runtime is not started, so it skips `installed` and `starting`. */
export type RuntimeInstallPhase = Exclude<InstallPhase, typeof InstallPhase.Installed | typeof InstallPhase.Starting>;
/** Why a model install failed (`ModelInstallJob.problem`), and its IPC failure's code. Never rename a value. */
export const ModelInstallProblem = {
  NeedsAppleSilicon: "needs_apple_silicon",
  NeedsMemory: "needs_memory",
  NotEnoughSpace: "not_enough_space",
  /** Another model is installing. */
  AnotherDownload: "another_download",
  UnsafeArchive: "unsafe_archive",
  /** A file could not be fetched or did not match its digest. */
  Download: "download",
  /** The runtime could not be unpacked. */
  Extract: "extract",
  /** The installed model did not start. */
  Startup: "startup",
  Other: "install_failed",
} as const;
export type ModelInstallProblem = (typeof ModelInstallProblem)[keyof typeof ModelInstallProblem];

/** The download steps the app itself reports in `ModelPullProgress.status`; Ollama's own steps pass through. */
export const ModelPullStatus = { Success: "success", Error: "error" } as const;
export type ModelPullStatus = (typeof ModelPullStatus)[keyof typeof ModelPullStatus];

/**
 * Why an Ollama model's download failed (`ModelPullProgress.problem`), and its IPC failure's code; a
 * managed install's failure names its `ModelInstallProblem` instead. Never rename a value.
 */
export const ModelPullProblem = {
  /** The model server did not answer, or said it cannot serve. */
  Unavailable: "unavailable",
  /** The model server refused the download. */
  Refused: "refused",
  /** The download stopped part way. */
  Interrupted: "interrupted",
} as const;
export type ModelPullProblem = (typeof ModelPullProblem)[keyof typeof ModelPullProblem];

export interface ModelInstallJob {
  id: string;
  model: string;
  phase: InstallPhase;
  completed: number;
  total: number;
  requiredBytes?: number;
  availableBytes?: number;
  location: string;
  updatedAt: string;
  error?: string;
  /** Why it failed, beside the words in `error`. */
  problem?: ModelInstallProblem;
  /** The phase it was in when it failed. */
  failedPhase?: InstallPhase;
  active: boolean;
}
