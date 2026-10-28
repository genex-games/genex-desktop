/** Display-only state. OAuth URLs and credentials stay out of renderer/event history. */
export interface CodexLoginState {
  revision: number;
  visible: boolean;
  phase: "idle" | "starting" | "waiting" | "verifying" | "connected" | "failed" | "cancelled";
  method: "browser" | "device";
  lines: string[];
  hasBrowserUrl: boolean;
  deviceCode?: string;
  error?: string;
  /** Why it failed, beside the words in `error`. */
  problem?: CodexLoginProblem;
}

/** Why a Codex sign-in failed (`CodexLoginState.problem`). Never rename a value. */
export const CodexLoginProblem = {
  MissingCli: "missing_cli",
  /** Codex or its login folder could not be prepared. */
  CouldNotStart: "could_not_start",
  /** `codex login` could not be run. */
  SpawnFailed: "spawn_failed",
  TimedOut: "timed_out",
  /** `codex login` exited without finishing. */
  NotFinished: "not_finished",
  /** Codex is signed in with an API key, not a ChatGPT plan. */
  ApiKeyLogin: "api_key_login",
  /** The login finished, but Codex could not confirm a ChatGPT sign-in. */
  NotVerified: "not_verified",
} as const;
export type CodexLoginProblem = (typeof CodexLoginProblem)[keyof typeof CodexLoginProblem];

export function isCodexLoginActive(state: CodexLoginState): boolean {
  return ["starting", "waiting", "verifying"].includes(state.phase);
}
