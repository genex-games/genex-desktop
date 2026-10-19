/**
 * Determinism. An answer never enters the game the moment it arrives: it waits in the inbox until
 * `drain()`, which the game calls once per `update()`, releases it on the drain it is due. A
 * replayed answer is due the number of frames it took live; a live one on the next drain after it
 * arrived. So a seed and the same steps replay the same frames, however the studio paces them.
 */

/** One answer waiting, and the drain it is due on. */
interface Waiting<T> {
  item: T;
  releaseAt: number;
}

/** The inbox: answers held by drain count, released in the order they were held. */
export interface Inbox<T> {
  /** Hold an answer for `frames` drains from now (at least one). */
  hold(item: T, frames: number): void;
  /** Count one drain and release every answer due by it, oldest first. */
  drain(): T[];
  /** Answers held and not yet released. */
  pending(): number;
  /** Drains so far: the game's AI frame. */
  frame(): number;
  /** Forget every answer and start counting again (the world was reset). */
  clear(): void;
}

/** Releases each answer on a drain count, so a seed and the same steps replay the same frames. */
export function inbox<T>(): Inbox<T> {
  let waiting: Waiting<T>[] = [];
  let drains = 0;
  return {
    hold(item, frames) {
      const wait = Number.isFinite(frames) ? Math.max(1, Math.floor(frames)) : 1;
      waiting.push({ item, releaseAt: drains + wait });
    },
    drain() {
      drains += 1;
      const ready = waiting.filter((entry) => entry.releaseAt <= drains);
      if (ready.length) waiting = waiting.filter((entry) => entry.releaseAt > drains);
      return ready.map((entry) => entry.item);
    },
    pending: () => waiting.length,
    frame: () => drains,
    clear() {
      waiting = [];
      drains = 0;
    },
  };
}
