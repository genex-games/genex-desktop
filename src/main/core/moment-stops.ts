/**
 * Stop reaches Genex's moments the harness asked for (`hooks.fire`, `checkpoint.take`, a game
 * folder's `snapshot.restore`, its own plugin calls through `plugins.invoke`): each runs on a signal of its own, kept here by the game and chat it
 * answers to, which the run's or the chat's Stop (`engine.abort`) ends, and the harness's end (it
 * died or restarts) ends every one. A moment stopped while it
 * waits its turn at a lock, or while its steps run, ends at once; the files a restore already put
 * back stay put back, and once its files may have changed its after steps still run, a Stop cutting
 * none of them (`STOP_OUTLIVING_HOOK_EVENTS`). A Stop during its before steps runs no after step:
 * what they closed stays closed.
 */
import type { CoreInternals } from "./internals.ts";

/** Who a moment answers to, as Stop names it. */
export interface MomentScope {
  project: string;
  threadId?: string;
}

/** Why a moment ended early. */
const MESSAGE = { stopped: "Stopped." } as const;

/**
 * Run one moment on a signal Stop of its game or chat ends. `boot` is the harness boot that asked
 * (`CoreInternals.harnessBoot`, read before its handler's first await): a moment of a harness that
 * has ended since runs stopped.
 */
export async function stoppableMoment<T>(
  x: Pick<CoreInternals, "activeMoments" | "harnessBoot">,
  scope: MomentScope,
  moment: (signal: AbortSignal) => Promise<T>,
  boot?: number,
): Promise<T> {
  const controller = new AbortController();
  if (boot !== undefined && boot !== x.harnessBoot) controller.abort(new Error(MESSAGE.stopped));
  x.activeMoments.set(controller, scope);
  try {
    return await moment(controller.signal);
  } finally {
    x.activeMoments.delete(controller);
  }
}

/** Stop the moments of a game, of a chat, or (neither named) every one. */
export function stopMoments(
  x: Pick<CoreInternals, "activeMoments">,
  scope: { project?: string | null; threadId?: string | null },
): void {
  for (const [controller, moment] of x.activeMoments) {
    const otherGame = Boolean(scope.project) && scope.project !== moment.project;
    const otherChat = Boolean(scope.threadId) && scope.threadId !== moment.threadId;
    if (!(otherGame || otherChat)) controller.abort(new Error(MESSAGE.stopped));
  }
}
