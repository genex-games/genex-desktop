/**
 * What the engines share instead of keeping a copy each. Mostly the two delegated engines
 * (`claude-code.ts`, `codex.ts`): the ceiling on one completion, the controller a deadline
 * aborts, how a long trace text is shortened, how a build cut short is reported, and how a
 * sign-in is detected without reading it. The local engine's sessions take the compaction
 * default and the interruption from here too.
 */
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { StopReason } from "../../shared/engine-requests.ts";
import { listDirs, listJsonFiles, pathExists } from "../fsx.ts";
import type { Usage } from "../types.ts";
import type { DelegateResult } from "./types.ts";

/**
 * Ceiling on one judge completion, mirroring the deadline every delegation carries. A verdict is
 * minutes of looking, never hours — but a hung judge CLI keeps the RPC in flight, which mutes
 * the harness wedge detector, so without a ceiling the stall is invisible and permanent.
 */
export const COMPLETE_TIMEOUT_MS = 15 * MINUTE_MS;

/**
 * The share of a local model's context window a session may fill before it compacts, when the
 * user has not chosen one. The harness seed keeps the same default (`loop/compact.ts`).
 */
export const DEFAULT_COMPACTION_PERCENT = 70;

/** A checkpoint note is one sentence; anything longer is cut before the chat shows it. */
export const CHECKPOINT_NOTE_CHARS = 300;

/**
 * How a completion ended (`CompleteResponse.stopReason`), in pi-ai's spelling, which every
 * engine's completion speaks. A model that ran out of room reports `StopReason.Length`.
 */
export const CompletionStop = {
  /** The model ended its reply itself. */
  Stop: "stop",
  Aborted: "aborted",
  Error: "error",
} as const;
export type CompletionStop = (typeof CompletionStop)[keyof typeof CompletionStop];

/** What an engine error says when the caller's own signal stopped the call. */
export const STOPPED_BY_USER = "stopped by the user";

/** A controller that follows `signal`. No signal still yields one: the deadline needs something to abort. */
export function abortControllerFor(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!signal) return controller;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/** `text` cut at `max` characters, saying how many more there were. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

/** Why a delegation ended early, and the words the chat shows for it. */
export interface DelegateEnding {
  stopReason: string;
  errorText: string;
}

/** The two ways a delegation is cut short from outside: the user's stop, and its spent time budget. */
const INTERRUPTION = {
  stopped: { stopReason: StopReason.Stopped, errorText: "stopped by you" },
  deadline: { stopReason: StopReason.Deadline, errorText: "time budget exhausted" },
} as const satisfies Record<string, DelegateEnding>;

/** The ending of a cut-short delegation: the user's stop when their signal fired, else the deadline. */
export function interruption(aborted: boolean | undefined): DelegateEnding {
  return aborted ? INTERRUPTION.stopped : INTERRUPTION.deadline;
}

/** What a delegated build had done when it ended early. */
export interface PartialDelegateState {
  summary: string;
  usage: Usage;
  turns: number;
  startedAt: number;
  sessionId?: string | undefined;
  model?: string | undefined;
  requestedModel?: string | undefined;
  cliVersion?: string | undefined;
  cliPath?: string | undefined;
  studioToolCalls?: DelegateResult["studioToolCalls"];
  contextTokens?: number | undefined;
}

/** A build that ended early but left real work behind: an outcome to report, not an error. */
export function partialDelegateResult(
  engine: string,
  ending: DelegateEnding,
  state: PartialDelegateState,
): DelegateResult {
  return {
    ok: false,
    summary: state.summary,
    usage: state.usage,
    turns: state.turns,
    engine,
    durationMs: Date.now() - state.startedAt,
    stopReason: ending.stopReason,
    errorText: ending.errorText,
    // Both delegated engines run on the user's subscription (D8), never a metered key.
    billing: "subscription",
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.requestedModel ? { requestedModel: state.requestedModel } : {}),
    ...(state.cliPath ? { cliPath: state.cliPath } : {}),
    ...(state.cliVersion ? { cliVersion: state.cliVersion } : {}),
    // An interview call the stream already recorded is executed by the harness whatever ended
    // the session — a deadline or stop must not lose a launch the contractor asked for.
    ...(state.studioToolCalls?.length ? { studioToolCalls: state.studioToolCalls } : {}),
    ...(state.contextTokens ? { contextTokens: state.contextTokens } : {}),
  };
}

/**
 * What a provider says when it has taken the account's access away: an organization that disabled
 * subscription access, an account suspended or on hold. Both delegated engines read their CLI's
 * error text with it (one table, so they stay in step) and call it a sign-in failure: no retry and
 * no wait fixes it, the user or their admin does. Each words the access, never a game's own words
 * ("the organization has disabled tyre spray" is not one).
 */
const ACCESS_LOST_PATTERNS = [
  /\bdisabled\b.{0,40}\bsubscription access\b/i,
  /\bsubscription access\b.{0,20}\b(?:disabled|revoked|suspended)\b/i,
  /\b(?:organi[sz]ation|admin(?:istrator)?|workspace) has (?:disabled|revoked|blocked)\b.{0,60}\baccess\b/i,
  /\byour (?:\w+ )?account (?:is|has been|was) (?:suspended|deactivated|disabled|on hold)\b/i,
];

/** Does a CLI's error text say the account's access was taken away (`ACCESS_LOST_PATTERNS`)? */
export function isAccessLost(text: string): boolean {
  return ACCESS_LOST_PATTERNS.some((re) => re.test(text));
}

/**
 * Whether a CLI home holds a sign-in: its credential file, or any JSON file or folder beside it.
 * Presence check only: the studio never opens a credential file. Ownership locks are runtime
 * state created before login, so that directory alone never selects this home for authentication.
 */
export async function hasCredentials(home: string, credentialFile: string): Promise<boolean> {
  if (await pathExists(path.join(home, credentialFile))) return true;
  if ((await listJsonFiles(home)).length > 0) return true;
  return (await listDirs(home)).some((dir) => path.basename(dir) !== "ownership-locks");
}
