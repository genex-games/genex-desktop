/**
 * The shape of a `__studio.state()` answer as the studio hands it on, and the paths a board reads.
 *
 * A state over the studio's budget is bounded by structure: its largest lists become
 * `{__elided, length, chars}` stubs and the root names them under `__cut`. An older studio cut
 * the JSON text instead and answered `{__truncated, length, head}` — journals and verdicts from
 * those runs still hold it. The vocabulary is the seed's copy of `src/shared/studio-state-shape.ts`,
 * held to it by `seed-contracts.test.ts`.
 *
 * `statePathsNamedByChecks` names what a board reads, for `preview.state`'s `keep`: the studio
 * cuts those paths last.
 */
import { parseExpr, type ExprNode } from "./checks.ts";
import { isRecord } from "./json.ts";
import { CheckKind, type Check } from "./spec.ts";

/** The marker keys a state answer may carry. */
export const StateShape = {
  /** The page has no `window.__studio`: the build exposes no state(). */
  Missing: "__missing",
  /** An older studio's answer: the state's JSON was over its cap and only a string head came back. */
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
/** The probe scope's own names for the late and the early state: never paths of the state. */
const SCOPE_NAMES = ["state", "early"] as const;

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
 * its first {@link MAX_KEEP_PATHS} entries, each once. Anything else is ignored, never an error.
 */
export function keepPathsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const kept: string[] = [];
  for (const entry of raw.slice(0, MAX_KEEP_PATHS)) {
    if (isKeepPath(entry) && !kept.includes(entry)) kept.push(entry);
  }
  return kept;
}

/** A stub the studio left where it cut a value out of an over-budget state. */
export function isElidedStub(value: unknown): value is ElidedStub {
  if (!isRecord(value) || Array.isArray(value)) return false;
  return typeof value[StateShape.Elided] === "string" && typeof value.length === "number";
}

/** An older studio's string-cut answer: no state at all, only how long it was. */
export function isTruncatedState(state: unknown): state is { [StateShape.Truncated]: true; length?: number } {
  return isRecord(state) && state[StateShape.Truncated] === true;
}

/** What a bounded state says was cut, or null for a state the studio read whole. */
export function stateCutOf(state: unknown): StateCut | null {
  const cut = isRecord(state) ? state[StateShape.Cut] : null;
  if (!isRecord(cut) || typeof cut.chars !== "number") return null;
  return { chars: cut.chars, paths: Array.isArray(cut.paths) ? cut.paths.map(String) : [] };
}

/**
 * The state paths a board's probes read — references, `delta` paths and `needs` — as paths of the
 * state, valid as `preview.state`'s `keep`. A value read only through `len()`, `.length` or
 * `has()` is left out: its stub answers those reads, so it can be cut like any other (and so can
 * the object that holds it). `early.` is always the scope's name; `state.` is the scope's alias
 * unless the game has a top-level `state` field, so such a path is named both ways.
 */
export function statePathsNamedByChecks(checks: readonly Check[] | null | undefined): string[] {
  const named: string[] = [];
  for (const check of checks ?? []) {
    if (check?.kind !== CheckKind.Probe) continue;
    for (const need of Array.isArray(check.needs) ? check.needs : []) named.push(String(need));
    if (!check.expr) continue;
    try {
      named.push(...pathsReadBy(parseExpr(check.expr)));
    } catch {
      // an expression that does not parse reads nothing; validateFacetSpec reports it
    }
  }
  return keepPathsOf([...new Set(named.flatMap(statePathsOf))]);
}

/** A probe path as the paths of the state it may stand for. */
function statePathsOf(path: string): string[] {
  const scopeName = SCOPE_NAMES.find((name) => path === name || path.startsWith(`${name}.`));
  const own = scopeName ? path.slice(scopeName.length + 1) : path;
  if (!isKeepPath(own)) return [];
  return scopeName === "state" ? [own, path] : [own];
}

/** Every path an expression reads by reference or names to `delta`, except what a stub answers. */
function pathsReadBy(ast: ExprNode): string[] {
  const paths: string[] = [];
  const walk = (node: ExprNode): void => {
    if (node.type === "ref" && !node.path.endsWith(".length")) paths.push(node.path);
    if (node.type !== "call") {
      for (const child of childrenOf(node)) walk(child);
      return;
    }
    const [first] = node.args;
    const literal = first?.type === "literal" && typeof first.value === "string";
    if (literal && node.name === "delta") paths.push(String(first.value));
    const lengthOnly = node.name === "len" && node.args.length === 1 && first?.type === "ref";
    if (!lengthOnly) node.args.forEach(walk);
  };
  walk(ast);
  return paths;
}

/** The sub-expressions of a node. */
function childrenOf(node: ExprNode): ExprNode[] {
  switch (node.type) {
    case "neg":
    case "not":
      return [node.operand];
    case "and":
    case "or":
    case "arith":
    case "cmp":
      return [node.left, node.right];
    case "in":
      return [node.left, ...node.items];
    case "call":
      return node.args;
    default:
      return [];
  }
}
