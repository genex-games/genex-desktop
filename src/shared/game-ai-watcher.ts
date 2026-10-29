/**
 * The plan watcher as Settings → Play-time AI shows it ("While you play": answer games with my
 * plan). genex.games queues a game's plan-funded request; this Mac's watcher, signed in with a
 * Genex player credential that can move no money, answers it with the person's own Claude Code
 * (or Codex, only behind its read-deny sandbox check), serially and with no tools. Main computes
 * the view; the words for it live in `renderer/words.ts`. Browser-safe; pure.
 */
import { isPlainRecord } from "./game-ai.ts";

/** Where the plan watcher stands. Wire values: never rename one. */
export const AiWatcherState = {
  Off: "off",
  Online: "online",
  /** A build is running: the plan is the builder's first. */
  Yielding: "yielding",
  /** The plan reached its keep-for-building line; it resumes at `resetsAt`. */
  Resting: "resting",
  SignedOut: "signed-out",
} as const;
export type AiWatcherState = (typeof AiWatcherState)[keyof typeof AiWatcherState];

/** The official CLIs a watcher reports to genex.games, by genex.games' own names. Wire values: never rename one. */
export const AiWatcherRunner = {
  /** Claude Code, answering games funded by the person's Claude plan. */
  Claude: "claude",
  /** Codex, answering games funded by the person's ChatGPT plan. */
  Codex: "codex",
} as const;
export type AiWatcherRunner = (typeof AiWatcherRunner)[keyof typeof AiWatcherRunner];

/** Why an enabled watcher cannot answer now. Wire values: never rename one. */
export const AiWatcherProblem = {
  /** genex.games no longer serves this version of Genex (it answered 426): update the app. */
  UpdateRequired: "update-required",
  /** No CLI can answer from this Mac's sandbox (none signed in, or none passed its check). */
  NoRunner: "no-runner",
  /** genex.games did not answer; the watcher keeps trying. */
  Unreachable: "unreachable",
} as const;
export type AiWatcherProblem = (typeof AiWatcherProblem)[keyof typeof AiWatcherProblem];

/** Where the Genex player sign-in stands. Wire values: never rename one. */
export const AiWatcherSignIn = {
  SignedOut: "signed-out",
  /** The browser shows `code`; the person approves it there. */
  SigningIn: "signing-in",
  SignedIn: "signed-in",
  /** genex.games refused the credential (revoked or expired): sign in again. */
  Ended: "ended",
} as const;
export type AiWatcherSignIn = (typeof AiWatcherSignIn)[keyof typeof AiWatcherSignIn];

/** Settings → Play-time AI's plan watcher rows. */
export interface AiWatcherView {
  /** The person's switch, off by default. */
  enabled: boolean;
  state: AiWatcherState;
  /** What this Mac answers with now: Claude, and Codex only behind its read-deny check. */
  runners: AiWatcherRunner[];
  /** Codex is signed in here but its sandbox check did not pass: ChatGPT-plan games are not answered here. */
  codexHeld: boolean;
  /** A resting plan's reset (ISO), when its CLI names one. */
  resetsAt: string | null;
  problem: AiWatcherProblem | null;
  signIn: AiWatcherSignIn;
  /** The code the browser asks for while signing in. */
  code: string | null;
  /** `genex player` also answers on this Mac; the lease keeps the two from answering one request twice. */
  cliAlso: boolean;
  /** When this Mac last answered a game (ISO). */
  lastAnsweredAt: string | null;
}

/** The switch's payload from the renderer (`{ enabled }`), or null. */
export function readAiWatcherSwitch(raw: unknown): boolean | null {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== 1) return null;
  return typeof raw.enabled === "boolean" ? raw.enabled : null;
}
