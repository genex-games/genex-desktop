/**
 * The one writer in place: a worker that writes in the game folder itself holds the host's in-place
 * lock for its whole life, shared by every pool of the game (a chat's and a run's), and with it the
 * locks of the plugins whose tools need the app they guard (an editor). The host answers where it
 * works by those locks' labels ("Unreal"); its end, or its pool's close, lets them go. A host that
 * keeps no such lock leaves one writer in place per pool, as the pool kept before; any other
 * refusal starts no writer in place.
 */
import { olderHost } from "../hooks.ts";
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import { CLIP_DETAIL, clip, hasText } from "../text.ts";
import { WorkerIsolation } from "./contract.ts";
import { POOL_WORDS } from "./prompts.ts";
import { type PoolState, runningRecords, type WorkerRecord } from "./records.ts";
import { WORKER_WHERE_CHARS } from "./where.ts";

/** What the lead reads when the host refused the game folder for a reason of its own. */
const MESSAGE = {
  Refused: (why: string) => `Not started: Genex couldn't give it the game folder: ${clip(why, CLIP_DETAIL)}`,
} as const;

/** Characters a title the host names a worker by may not hold. */
const CONTROL_CHARS = /\p{Cc}/gu;

/** The game, and the run (else the chat) the host knows a pool's workers by, with their ids. */
function poolOf(state: PoolState) {
  const { project, threadId, runId } = state.scope;
  return { project, threadId, ...(runId ? { runId } : {}) };
}

/**
 * Take the game folder for a worker that writes in place: where it works (the first plugin lock's
 * label, or null when no plugin's lock is taken), or the words the lead reads when another worker
 * writes there now.
 */
export async function holdInPlace(
  state: PoolState,
  record: WorkerRecord,
): Promise<{ where: string | null } | { refused: string }> {
  const title = record.title.replace(CONTROL_CHARS, " ").trim() || record.id;
  let answer: unknown;
  try {
    answer = await state.scope.ctx.call(HostMethod.LocksHold, {
      ...poolOf(state),
      holder: { id: record.id, title },
    });
  } catch (err) {
    // Any refusal but an older host's (one that keeps no writer in place) starts no writer: never in place unguarded.
    if (!olderHost(err)) return { refused: MESSAGE.Refused(err instanceof Error ? err.message : String(err)) };
    // A host that keeps no writer in place: one per pool.
    const writer = runningRecords(state).find((other) => other !== record && other.isolation === WorkerIsolation.Lock);
    return writer ? { refused: POOL_WORDS.lockBusy(writer.id) } : { where: null };
  }
  if (isPlainRecord(answer) && hasText(answer.busy))
    return { refused: POOL_WORDS.inPlaceBusy(clip(answer.busy, CLIP_DETAIL)) };
  const labels = isPlainRecord(answer) && Array.isArray(answer.labels) ? answer.labels.filter(hasText) : [];
  const first = labels[0];
  return { where: first ? clip(first.trim(), WORKER_WHERE_CHARS) : null };
}

/** Let the game folder go when a worker that wrote in place ends; a release that fails changes nothing else. */
export async function releaseInPlace(state: PoolState, record: WorkerRecord): Promise<void> {
  if (record.isolation !== WorkerIsolation.Lock) return;
  await state.scope.ctx.call(HostMethod.LocksRelease, { ...poolOf(state), holder: { id: record.id } }).catch(() => {});
}
