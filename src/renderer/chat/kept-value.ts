/**
 * The transcript and what its rows read are worked out anew from the log after every event; this
 * keeps what did not change the very same object it was, so a row whose entry is unchanged is not
 * drawn again (`VirtualTranscript` draws a row again only for a new entry object or a new
 * context). An entry that did change keeps its unchanged parts (a work group's earlier tool rows),
 * so what is drawn from them stays still too.
 */
import { useRef } from "react";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** An element's id, when it has one: list items are matched by it, so an insertion keeps those after it. */
const idOf = (value: unknown): string | null =>
  isPlainObject(value) && typeof value.id === "string" ? value.id : null;

/** The earlier list's items by id, for items that carry one. */
function byId(previous: readonly unknown[]): Map<string, unknown> {
  const items = new Map<string, unknown>();
  for (const item of previous) {
    const id = idOf(item);
    if (id !== null) items.set(id, item);
  }
  return items;
}

function keptList(previous: readonly unknown[], next: readonly unknown[]): readonly unknown[] {
  const earlier = byId(previous);
  let same = previous.length === next.length;
  const kept = next.map((item, index) => {
    const id = idOf(item);
    const match = id === null ? previous[index] : earlier.get(id);
    const value = keptValue(match, item);
    if (value !== previous[index]) same = false;
    return value;
  });
  return same ? previous : kept;
}

function keptRecord(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(previous).length;
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    const value = keptValue(previous[key], next[key]);
    if (value !== previous[key] || !(key in previous)) same = false;
    kept[key] = value;
  }
  return same ? previous : kept;
}

function keptMap(
  previous: ReadonlyMap<unknown, unknown>,
  next: ReadonlyMap<unknown, unknown>,
): ReadonlyMap<unknown, unknown> {
  let same = previous.size === next.size;
  const kept = new Map<unknown, unknown>();
  for (const [key, value] of next) {
    const was = previous.get(key);
    const now = keptValue(was, value);
    if (now !== was || !previous.has(key)) same = false;
    kept.set(key, now);
  }
  return same ? previous : kept;
}

const sameMembers = (previous: ReadonlySet<unknown>, next: ReadonlySet<unknown>): boolean =>
  previous.size === next.size && [...next].every((member) => previous.has(member));

/**
 * `next`, with every part equal to the same part of `previous` replaced by that part of `previous`:
 * `previous` itself when the two are equal throughout. Only data (lists, plain objects, maps, sets
 * of primitives and primitives) is compared; anything else is kept as `next` has it.
 */
export function keptValue<T>(previous: T | undefined, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) return keptList(previous, next) as T;
  if (isPlainObject(previous) && isPlainObject(next)) return keptRecord(previous, next) as T;
  if (previous instanceof Map && next instanceof Map) return keptMap(previous, next) as T;
  if (previous instanceof Set && next instanceof Set) return sameMembers(previous, next) ? previous : next;
  return next;
}

/** `value`, kept the object it was on the render before while it is equal throughout ({@link keptValue}). */
export function useKept<T>(value: T): T {
  const kept = useRef<T>(value);
  kept.current = keptValue(kept.current, value);
  return kept.current;
}
