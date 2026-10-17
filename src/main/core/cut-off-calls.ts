/**
 * Plugin and connector calls cut off before they answered, by the thread that made them, until a
 * later delegated session of the thread is told of them (`delegation-prompts.ts` `cutOffNotice`)
 * and answers. Memory
 * only: an app restart is not a harness crash, and the records in the log keep the facts.
 */
import type { CallCutOff } from "../../shared/plugins.ts";

/** At most this many cut-off calls wait per thread; the oldest goes first. */
const MAX_CUT_OFFS_PER_THREAD = 20;
/** How much of a call's arguments the notice repeats. */
const ARGS_NOTE_CHARS = 200;

/** One call cut off before it answered: what it was, and why it ended. */
export interface CutOffCall {
  /** The name the agent called it by (`<plugin>__<tool>`, `<connector>__<tool>`). */
  tool: string;
  /** Its arguments, clipped for the notice; empty when it had none. */
  args: string;
  reason: CallCutOff;
}

/** Note a cut-off call for its thread; a call with no thread has no session to tell. */
export function noteCutOff(calls: Map<string, CutOffCall[]>, threadId: string | undefined, call: CutOffCall): void {
  if (!threadId) return;
  const noted = [...(calls.get(threadId) ?? []), { ...call, args: call.args.slice(0, ARGS_NOTE_CHARS) }];
  calls.set(threadId, noted.slice(-MAX_CUT_OFFS_PER_THREAD));
}

/** The thread's cut-off calls, oldest first, left noted until a session has read them (`clearCutOffs`). */
export function peekCutOffs(calls: Map<string, CutOffCall[]>, threadId: string | undefined): CutOffCall[] {
  if (!threadId) return [];
  return [...(calls.get(threadId) ?? [])];
}

/**
 * Forget the calls a session was told of and answered after; a call noted since stays for the
 * thread's next session.
 */
export function clearCutOffs(
  calls: Map<string, CutOffCall[]>,
  threadId: string | undefined,
  told: readonly CutOffCall[],
): void {
  if (!threadId || told.length === 0) return;
  const left = (calls.get(threadId) ?? []).filter((call) => !told.includes(call));
  if (left.length) calls.set(threadId, left);
  else calls.delete(threadId);
}
