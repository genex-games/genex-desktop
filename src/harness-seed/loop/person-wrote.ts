/**
 * The person wrote in a chat, and their words were handed to what works there (the chat's own turn,
 * or a run's lead). A tool that only waits — for workers, for a busy provider — ends its wait then,
 * so the session reaches its next step and reads them; it can wait again after.
 *
 * A module of its own: the queue (message-queue.ts) says it, and the waits that listen live in
 * modules a seed upgrade may keep from before, which never imported it.
 */

/** Who waits on each chat, by thread. */
const waiting = new Map<string, Set<() => void>>();

/** The person's words in this chat were handed over: every wait on it ends. */
export function personWrote(threadId: string): void {
  const waiters = waiting.get(threadId);
  if (!waiters) return;
  waiting.delete(threadId);
  for (const wake of waiters) wake();
}

/** A wait on the person's next words in a chat: `ended` settles once they write; `cancel` stops waiting. */
export interface WordsWait {
  ended: Promise<void>;
  cancel(): void;
}

/** Wait for the person's next words in this chat. Cancel it when the wait ends another way. */
export function nextWords(threadId: string): WordsWait {
  let wake = () => {};
  const ended = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const waiters = waiting.get(threadId) ?? new Set<() => void>();
  waiters.add(wake);
  waiting.set(threadId, waiters);
  const cancel = () => {
    const current = waiting.get(threadId);
    current?.delete(wake);
    if (current?.size === 0) waiting.delete(threadId);
  };
  return { ended, cancel };
}
