/**
 * Tool permission ledger: the wait between a game chat's Claude session asking to use a tool and
 * the person's answer in the chat. Modelled on the plugin consent ledger, with one difference:
 * the chat's own session has no timeout. Claude Code waits for the person, so this does too; the
 * delegation's own deadline and Stop still end the wait through the signal and `cancel()`. Only a
 * build's lead or the run's coordinator asks with a `timeoutMs`: nobody may be looking at its
 * card, and a run must not wait on it. Its card also outlives the chat's turns (`outlivesTurn`):
 * the lead is not the chat's turn, so another message's turn ending is not its end. Settles each
 * request exactly once and never touches disk or the event log: the permission service records
 * the question and its answer around it.
 */
import {
  PermissionDecision,
  type ToolPermissionAnswer,
  ToolPermissionBy,
  type ToolPermissionBy as ToolPermissionByType,
} from "../shared/permissions.ts";

/** Why an answer is refused. */
const MESSAGE = {
  alreadyPending: "Permission request already pending",
  doesNotFit: "That answer does not fit this request.",
} as const;

export interface ToolPermissionRequest {
  requestId: string;
  project: string;
  threadId: string;
  /** A plan waiting for approval (ExitPlanMode) takes a plan answer; anything else, Allow / Always / Deny. */
  plan?: boolean;
  /** The delegation's abort: an aborted session withdraws its request (`by: 'stop'`). */
  signal?: AbortSignal;
  /** Withdraw the request after this long (`by: 'timeout'`); none waits for the person. */
  timeoutMs?: number;
  /**
   * A build's lead's or the run's coordinator's card: no turn of the chat's ending withdraws it
   * (`cancel` with `by: 'turn'`); its own session's end, a Stop, the answer or `timeoutMs` do.
   */
  outlivesTurn?: boolean;
}

export interface ToolPermissionPending {
  requestId: string;
  project: string;
  threadId: string;
  plan: boolean;
}

/** The person's answer, or null when the work ended first (`by` says how). */
export interface ToolPermissionResult {
  answer: ToolPermissionAnswer | null;
  by: ToolPermissionByType;
}

/** What withdraws a waiting request: a Stop (or the app going), or the turn's end. */
export type WithdrawnBy = typeof ToolPermissionBy.Stop | typeof ToolPermissionBy.Turn;

type Waiting = {
  entry: ToolPermissionPending;
  outlivesTurn: boolean;
  settle: (result: ToolPermissionResult) => void;
};

/** Does this answer fit a request of this kind? A deny fits both; a plan takes only a plan answer. */
function fits(answer: ToolPermissionAnswer, plan: boolean): boolean {
  if (answer.decision === PermissionDecision.Deny) return true;
  return (answer.decision === PermissionDecision.ApprovePlan) === plan;
}

/** A request's own deadline, which never keeps the app alive; none without `timeoutMs`. */
function timeoutOf(timeoutMs: number | undefined, withdraw: () => void): NodeJS.Timeout | null {
  if (timeoutMs === undefined) return null;
  const timer = setTimeout(withdraw, timeoutMs);
  timer.unref();
  return timer;
}

export class ToolPermissions {
  #waiting = new Map<string, Waiting>();

  /**
   * Ask, and wait for whichever comes first: the person's answer, the session's abort, a Stop, or
   * the request's own `timeoutMs`.
   */
  request(request: ToolPermissionRequest): Promise<ToolPermissionResult> {
    if (this.#waiting.has(request.requestId)) return Promise.reject(new Error(MESSAGE.alreadyPending));
    if (request.signal?.aborted) return Promise.resolve({ answer: null, by: ToolPermissionBy.Stop });
    return new Promise<ToolPermissionResult>((resolve) => {
      const entry: ToolPermissionPending = {
        requestId: request.requestId,
        project: request.project,
        threadId: request.threadId,
        plan: request.plan === true,
      };
      const onAbort = (): void => settle({ answer: null, by: ToolPermissionBy.Stop });
      const timer = timeoutOf(request.timeoutMs, () => settle({ answer: null, by: ToolPermissionBy.Timeout }));
      const settle = (result: ToolPermissionResult): void => {
        if (this.#waiting.get(request.requestId)?.entry !== entry) return;
        this.#waiting.delete(request.requestId);
        request.signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.set(request.requestId, { entry, outlivesTurn: request.outlivesTurn === true, settle });
    });
  }

  /**
   * The person's answer. False when the id is unknown or already settled: a second click changes
   * nothing. An answer that does not fit the question (a plan approval for a command, Allow for a
   * plan) is refused rather than read as something else.
   */
  resolve(requestId: string, answer: ToolPermissionAnswer): boolean {
    const waiting = this.#waiting.get(requestId);
    if (!waiting) return false;
    if (!fits(answer, waiting.entry.plan)) throw new Error(MESSAGE.doesNotFit);
    waiting.settle({ answer, by: ToolPermissionBy.User });
    return true;
  }

  /**
   * Withdraw every pending request in scope. A scope key left undefined matches everything, so
   * `{}` is the shutdown path, `{threadId}` a turn's end and `{project}` a game's Stop. A turn's
   * end leaves a card that outlives turns (`outlivesTurn`). Returns how many were settled.
   */
  cancel(scope: { project?: string; threadId?: string }, by: WithdrawnBy): number {
    let settled = 0;
    for (const waiting of [...this.#waiting.values()]) {
      if (scope.project !== undefined && waiting.entry.project !== scope.project) continue;
      if (scope.threadId !== undefined && waiting.entry.threadId !== scope.threadId) continue;
      if (by === ToolPermissionBy.Turn && waiting.outlivesTurn) continue;
      waiting.settle({ answer: null, by });
      settled += 1;
    }
    return settled;
  }

  pending(): ReadonlyArray<ToolPermissionPending> {
    return [...this.#waiting.values()].map((waiting) => ({ ...waiting.entry }));
  }
}
