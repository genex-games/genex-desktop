/**
 * The shape of a `__studio.state()` answer as the studio hands it on: the markers it writes into
 * a state it could not read whole, and the `keep` paths a reader may ask it to spare.
 *
 * A state over the studio's budget is bounded by structure, never cut as a string: the largest
 * lists are replaced by an {@link ElidedStub} and the root says what was cut under
 * `StateShape.Cut`. The harness seed keeps a typed copy of these names in
 * `harness-seed/loop/state-shape.ts`, held to this one by `seed-contracts.test.ts`.
 */

/** The marker keys a state answer may carry. */
export const StateShape = {
  /** The page has no `window.__studio`: the build exposes no state(). */
  Missing: "__missing",
  /** An older host's answer: the state's JSON was over its cap and only a string head came back. */
  Truncated: "__truncated",
  /** On a stub that stands where a list, an object or a long string was cut out. */
  Elided: "__elided",
  /** On the root of a bounded state: how big the full state was and which paths were cut. */
  Cut: "__cut",
} as const;
export type StateShape = (typeof StateShape)[keyof typeof StateShape];

/** What a stub stands in for: the value of its `StateShape.Elided` field. */
export const ElidedKind = {
  Array: "array",
  Object: "object",
  String: "string",
} as const;
export type ElidedKind = (typeof ElidedKind)[keyof typeof ElidedKind];

/** At most this many `keep` paths are honoured on one read. */
export const MAX_KEEP_PATHS = 64;
/** A `keep` path longer than this is not a path a check would name. */
export const MAX_KEEP_PATH_CHARS = 120;
/** Segments that would reach an object's prototype rather than the state's own data. */
const PROTOTYPE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** What stands where the studio cut a value out of a state: its kind, length and JSON size. */
export interface ElidedStub {
  [StateShape.Elided]: ElidedKind;
  /** Entries of a list, keys of an object, characters of a string. */
  length: number;
  /** How many characters of JSON the cut value took. */
  chars: number;
}

/** What the root of a bounded state says about the cut. */
export interface StateCut {
  /** The full state's JSON size. */
  chars: number;
  /** The dotted paths that were replaced by stubs, largest first (clipped and capped). */
  paths: string[];
}

/** A `keep` path the studio will honour: dotted, non-empty segments, none reaching a prototype. */
export function isKeepPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEEP_PATH_CHARS) return false;
  return value.split(".").every((segment) => segment.length > 0 && !PROTOTYPE_SEGMENTS.has(segment));
}

/**
 * The `keep` paths of a `preview.state` call, from whatever arrived: the well-formed strings among
 * its first {@link MAX_KEEP_PATHS} entries, each once. Anything else is ignored, never an error —
 * an older or hostile caller still gets its state.
 */
export function keepPathsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const kept: string[] = [];
  for (const entry of raw.slice(0, MAX_KEEP_PATHS)) {
    if (isKeepPath(entry) && !kept.includes(entry)) kept.push(entry);
  }
  return kept;
}
