/**
 * A fact each transcript row reads about itself (may this bubble rewind?) whose answers change
 * as the chat goes on. Handing rows a new function would draw every row again; a row instead
 * reads its own answer from a source that stays the same, and draws again only when that answer
 * changes.
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** A fact about rows, by entry id: its current answer and word when the answers change. */
export interface RowFact<T> {
  read: (id: string) => T;
  subscribe: (onChange: () => void) => () => void;
}

/** A source for `answer` that stays the same object while `answer` changes; rows hear each change. */
export function useRowFactSource<T>(answer: (id: string) => T): RowFact<T> {
  const latest = useRef(answer);
  // Read while rendering, so a row drawn in the same pass reads the newest answers.
  latest.current = answer;
  const [fact] = useState(() => {
    const listeners = new Set<() => void>();
    return {
      listeners,
      read: (id: string) => latest.current(id),
      subscribe: (onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
    };
  });
  useLayoutEffect(() => {
    for (const listener of fact.listeners) listener();
  }, [answer, fact]);
  return fact;
}

/** This row's answer, or `fallback` without a source; the row draws again only when its own answer changes. */
export function useRowFact<T>(fact: RowFact<T> | undefined, id: string, fallback: T): T {
  return useSyncExternalStore(fact?.subscribe ?? noSubscription, () => (fact ? fact.read(id) : fallback));
}

const noSubscription = (): (() => void) => () => {};

/** A fact whose answer never changes: a row drawn on its own, as a test or a gallery draws one. */
export function fixedRowFact<T>(answer: T): RowFact<T> {
  return { read: () => answer, subscribe: noSubscription };
}
