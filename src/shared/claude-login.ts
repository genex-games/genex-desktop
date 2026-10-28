/**
 * Display-only state for the Claude sign-in. The authorize URL carries the PKCE challenge and the
 * session state, so it stays in main: the card can ask for it to be opened, never read it.
 */
export interface ClaudeLoginState {
  revision: number;
  /**
   * `browser` — the sign-in page is open and we are waiting; `code` — Claude Code is waiting for
   * the code the browser shows; `terminal` — the sign-in is using Studio's embedded PTY.
   */
  phase: "idle" | "starting" | "browser" | "code" | "verifying" | "connected" | "failed" | "cancelled" | "terminal";
  /** Main is holding a sign-in link the card can ask it to open again. */
  hasBrowserUrl: boolean;
  error?: string;
  /** Why it failed, beside the words in `error`. */
  problem?: ClaudeLoginProblem;
}

/** Why a Claude sign-in failed (`ClaudeLoginState.problem`). Never rename a value. */
export const ClaudeLoginProblem = {
  /** The Claude Code to sign in with could not be resolved. */
  CliUnresolved: "cli_unresolved",
  MissingCli: "missing_cli",
  /** Its login folder or its process could not be started. */
  CouldNotStart: "could_not_start",
  TimedOut: "timed_out",
  /** The CLI needed a terminal, and the embedded one could not open. */
  TerminalFailed: "terminal_failed",
  /** The CLI could not start its sign-in in the embedded terminal. */
  CliFailed: "cli_failed",
  /** The CLI exited without finishing. */
  NotFinished: "not_finished",
  /** The CLI finished, but nobody turned out to be signed in. */
  NotConfirmed: "not_confirmed",
} as const;
export type ClaudeLoginProblem = (typeof ClaudeLoginProblem)[keyof typeof ClaudeLoginProblem];

/** Why the Claude sign-in refused a request from its card: the IPC failure's code. Never rename a value. */
export const ClaudeLoginRefusal = {
  NoCodeWaiting: "no_code_waiting",
  NotACode: "not_a_code",
  NoLink: "no_link",
} as const;
export type ClaudeLoginRefusal = (typeof ClaudeLoginRefusal)[keyof typeof ClaudeLoginRefusal];

export function isClaudeLoginActive(state: ClaudeLoginState): boolean {
  return ["starting", "browser", "code", "verifying", "terminal"].includes(state.phase);
}
