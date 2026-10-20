/**
 * Determinism. An answer never enters the game the moment it arrives: it waits in the inbox until
 * `drain()`, which the game calls once per `update()`, releases it on the drain it is due. A
 * replayed answer is due the drain its call was made on plus the frames it took live; a live one
 * on the next drain after it arrived. So a seed and the same steps replay the same frames, however
 * the studio paces them.
 */

/** One answer waiting, and the drain it is due on. Waiting answers stay in the order they were held. */
interface Waiting<T> {
  item: T;
  due: number;
}

/** The inbox: answers held by drain count, released in the order they were held. */
export interface Inbox<T> {
  /** Hold an answer until drain number `frame`; an answer is never due before the next drain. */
  holdUntil(item: T, frame: number): void;
  /** Count one drain and release every answer due by it, in the order they were held. */
  drain(): T[];
  /** Take an answer back before it is released (its call was canceled). */
  remove(item: T): void;
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
    holdUntil(item, frame) {
      const soonest = drains + 1;
      const due = Number.isFinite(frame) ? Math.max(soonest, Math.floor(frame)) : soonest;
      waiting.push({ item, due });
    },
    drain() {
      drains += 1;
      const ready = waiting.filter((entry) => entry.due <= drains);
      if (!ready.length) return [];
      waiting = waiting.filter((entry) => entry.due > drains);
      return ready.map((entry) => entry.item);
    },
    remove(item) {
      waiting = waiting.filter((entry) => entry.item !== item);
    },
    pending: () => waiting.length,
    frame: () => drains,
    clear() {
      waiting = [];
      drains = 0;
    },
  };
}
