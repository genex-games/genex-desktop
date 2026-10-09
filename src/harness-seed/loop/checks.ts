/**
 * Checks and the scoreboard — HARNESS-REWORK.md §4.1–4.2.
 *
 * A facet's contract is no longer a paragraph a vision model eyeballs: it is a list of typed
 * checks, most of which the harness evaluates itself. This module is the deterministic half:
 *
 *  - a tiny expression language (`meanLuma in [0.32,0.45] && fractionAbove(0.9) <= 0.02`)
 *    for `pixel`, `probe` and `demo` checks — parsed, never eval'd, so a planner typo is a
 *    validation error and a hostile string is just a string;
 *  - `scene` checks, run inside the page over the game's own three.js graph through the
 *    `__studio.inspect()` helpers (a game predating the contract fails them, which is the
 *    right incentive);
 *  - the scoreboard: check → pass/fail per iteration, compared mechanically so credit
 *    assignment is arithmetic ("flipped", "regressed"), not a judge's memory.
 *
 * `vision` and `play` checks need a model; they live in judge.ts and playtester.ts and land
 * in the same scoreboard shape.
 */
import { nearestReference, styleDistance, type StyleStats } from "./style.ts";
import type { Check, CheckKind, CheckLike, CheckOrigin, CheckWeight } from "./spec.ts";
import { ProbeAfter } from "./throttle-bot.ts";
import { HostMethod } from "./host-methods.ts";
import { clip, CLIP_DETAIL, CLIP_REASON, clipMarked } from "./text.ts";
import { isRecord } from "./json.ts";
import { appliesToBuild } from "./applies-to-build.ts";
import type { ElidedKind, StateShape } from "./state-shape.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import type { PreviewPixelStats } from "../types/host-api.d.ts";

/** The state paths a check may name as its needs. */
const MAX_CHECK_NEEDS = 4;
/** How much of a state's JSON an older studio read whole before it cut the text instead. */
const LEGACY_STATE_CAP_CHARS = 64_000;
/** How much of a failing check's reason one scoreboard line quotes. */
const BOARD_REASON_CHARS = 240;
/** Threshold under which a challenger frame counts as identical to the incumbent's. */
export const INVISIBLE_DIFF_FRACTION = 0.002;
/** Default tolerance for a metric ratchet: a move smaller than this is noise, not a flip. */
export const METRIC_DEFAULT_TOL = 0.02;
/** A failing vision check needs a "yes" at least this confident before it counts as passing. */
export const VISION_FLIP_CONFIDENCE = 0.7;
/** Below this the judge is guessing: a repeated answer at this confidence settles nothing. */
export const VISION_STUCK_CONFIDENCE = 0.5;

/** A token of the expression language. */
export interface Token {
  type: "number" | "string" | "boolean" | "null" | "op" | "ident";
  value: any;
}

/** A node of a parsed expression. */
export type ExprNode =
  | { type: "literal"; value: unknown }
  | { type: "ref"; path: string }
  | { type: "call"; name: string; args: ExprNode[] }
  | { type: "neg" | "not"; operand: ExprNode }
  | { type: "and" | "or"; left: ExprNode; right: ExprNode }
  | { type: "arith" | "cmp"; op: string; left: ExprNode; right: ExprNode }
  | { type: "in"; left: ExprNode; items: ExprNode[] };

/** A reference still with its pixel stats, as the style distance compares against it. */
export interface ReferenceStats {
  label?: string;
  stats?: StyleStats | null;
}

/** One camera's challenger-against-incumbent diff. */
export interface CameraDiff {
  diffFraction?: number;
  meanAbsDiff?: number;
  compared?: number;
  [field: string]: unknown;
}

/** What an evidence pass gathered, as far as the checks read it (`evidence.ts` `gatherEvidence`). */
export interface CheckEvidence {
  ok?: boolean;
  shots?: Array<{ camera: string; stats?: Partial<PreviewPixelStats> | null; [field: string]: unknown }>;
  missingCameras?: string[];
  eyes?: string[] | null;
  registeredDemos?: string[] | null;
  skippedDemos?: string[];
  state?: AnyRecord | null;
  stateEarly?: AnyRecord | null;
  demos?: Record<string, { ok?: boolean; error?: string; result?: unknown; [field: string]: unknown } | undefined>;
  demoStates?: Record<string, AnyRecord | undefined>;
  [field: string]: unknown;
}

/** One check's outcome on a board: `pass` true, false, or null for a check nobody could measure. */
export interface CheckResult {
  id: string;
  kind: string;
  weight: string;
  origin?: string;
  pass: boolean | null;
  reason: string;
  state?: string;
  observed?: unknown;
  value?: number;
  goal?: string;
  tol?: number;
  nearest?: string;
  unavailable?: boolean;
  missing?: string[];
  /**
   * The studio could not read the state whole: an older studio cut its text, or the check reads
   * inside a value the studio cut (`cut` names what it read there). Unmeasured, and — unlike
   * `unavailable` — it still blocks "satisfied": the build reports it, it just reports too much.
   */
  stateTooLarge?: boolean;
  cut?: string[];
  confidence?: number;
  answer?: unknown;
  note?: string;
  wobble?: boolean;
  carried?: boolean;
  stuck?: boolean;
  lastAnswer?: AnyRecord;
  [field: string]: unknown;
}

/** A board: every check's latest result, by id, in spec order. */
export type Scoreboard = Record<string, CheckResult>;

/** What moved between two boards. */
export interface ScoreboardComparison {
  flips: string[];
  regressions: string[];
  passing: string[];
  failing: string[];
  unmeasured: string[];
}

/**
 * The members of spec.ts's check vocabularies this module reads. spec.ts imports this module
 * (it validates expressions with `parseExpr` and dry-runs probes), so the objects cannot be
 * imported back without a cycle; `satisfies` holds each value to the vocabulary's own type.
 */
const Kind = {
  Scene: "scene",
  Pixel: "pixel",
  Metric: "metric",
  Probe: "probe",
  Demo: "demo",
  Vision: "vision",
  Play: "play",
} as const satisfies Record<string, CheckKind>;
const Weight = { Identity: "identity", Normal: "normal" } as const satisfies Record<string, CheckWeight>;
const Origin = { Judge: "judge" } as const satisfies Record<string, CheckOrigin>;
/** The markers of a state the studio could not read whole; state-shape.ts imports this module too. */
const Shape = {
  Truncated: "__truncated",
  Elided: "__elided",
  Cut: "__cut",
} as const satisfies Record<string, StateShape>;
/** What a stub stands in for: only an object's stub does not keep the value's own `.length`. */
const Elided = { Object: "object" } as const satisfies Record<string, ElidedKind>;

// ── expression language ────────────────────────────────────────────────────────────────────

const TOKEN =
  /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)|(&&|\|\||<=|>=|===|!==|==|!=|[-+*/<>!()[\],]))/y;

export function tokenize(source: unknown): Token[] {
  const text = String(source ?? "");
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < text.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match || match.index !== index) {
      if (/^\s*$/.test(text.slice(index))) break;
      throw new Error(`unexpected character at ${index}: ${JSON.stringify(text.slice(index, index + 8))}`);
    }
    index = TOKEN.lastIndex;
    if (match[0].trim() === "") break;
    tokens.push(tokenOf(match));
  }
  return tokens;
}

/** The token one match of `TOKEN` stands for: a number, a quoted string, a word or an operator. */
function tokenOf(match: RegExpExecArray): Token {
  if (match[1] !== undefined) return { type: "number", value: Number(match[1]) };
  if (match[2] !== undefined) return { type: "string", value: match[2].slice(1, -1).replace(/\\(.)/g, "$1") };
  if (match[3] !== undefined) return wordToken(match[3]);
  return { type: "op", value: STRICT_SPELLING[match[4] as string] ?? match[4] };
}

/**
 * JavaScript's strict equality, which a check's author writes from habit: the same operator as
 * `==` and `!=`, which already compare strictly.
 */
const STRICT_SPELLING: Readonly<Record<string, string>> = { "===": "==", "!==": "!=" };

/** A bare word: a boolean, `null`, the `in` operator, or a name the scope resolves. */
function wordToken(word: string): Token {
  if (word === "true" || word === "false") return { type: "boolean", value: word === "true" };
  if (word === "null") return { type: "null", value: null };
  if (word === "in") return { type: "op", value: "in" };
  return { type: "ident", value: word };
}

/** Where a parse stands: the tokens and the index of the next one. */
interface Cursor {
  tokens: Token[];
  pos: number;
}

const peek = (cursor: Cursor): Token | undefined => cursor.tokens[cursor.pos];

function take(cursor: Cursor, value?: unknown): Token {
  const token = cursor.tokens[cursor.pos];
  const notTheOneAsked = value !== undefined && token?.value !== value;
  if (!token || notTheOneAsked) {
    throw new Error(
      `expected ${value ?? "an expression"} but found ${token ? JSON.stringify(token.value) : "end of expression"}`,
    );
  }
  cursor.pos++;
  return token;
}

function isOp(cursor: Cursor, value: string): boolean {
  const token = peek(cursor);
  return token?.type === "op" && token.value === value;
}

/** The operators a `cmp` node carries. */
const COMPARISONS = ["<=", ">=", "==", "!=", "<", ">"];

/** Parse an expression into a small AST. Throws on syntax errors — validation catches it. */
export function parseExpr(source: unknown): ExprNode {
  const cursor: Cursor = { tokens: tokenize(source), pos: 0 };
  if (cursor.tokens.length === 0) throw new Error("empty expression");
  const ast = orExpr(cursor);
  const trailing = peek(cursor);
  if (trailing) throw new Error(`unexpected trailing token ${JSON.stringify(trailing.value)}`);
  return ast;
}

function orExpr(cursor: Cursor): ExprNode {
  let left: ExprNode = andExpr(cursor);
  while (isOp(cursor, "||")) {
    take(cursor, "||");
    left = { type: "or", left, right: andExpr(cursor) };
  }
  return left;
}

function andExpr(cursor: Cursor): ExprNode {
  let left: ExprNode = unary(cursor);
  while (isOp(cursor, "&&")) {
    take(cursor, "&&");
    left = { type: "and", left, right: unary(cursor) };
  }
  return left;
}

function unary(cursor: Cursor): ExprNode {
  if (isOp(cursor, "!")) {
    take(cursor, "!");
    return { type: "not", operand: unary(cursor) };
  }
  return comparison(cursor);
}

function comparison(cursor: Cursor): ExprNode {
  const left = sum(cursor);
  if (isOp(cursor, "in")) {
    take(cursor, "in");
    take(cursor, "[");
    const items = expressionList(cursor, "]");
    return { type: "in", left, items };
  }
  const op = COMPARISONS.find((candidate) => isOp(cursor, candidate));
  if (!op) return left;
  take(cursor, op);
  return { type: "cmp", op, left, right: sum(cursor) };
}

/** Comma-separated expressions up to and including the closing bracket. */
function expressionList(cursor: Cursor, close: string): ExprNode[] {
  const items: ExprNode[] = [];
  if (!isOp(cursor, close)) {
    items.push(orExpr(cursor));
    while (isOp(cursor, ",")) {
      take(cursor, ",");
      items.push(orExpr(cursor));
    }
  }
  take(cursor, close);
  return items;
}

function sum(cursor: Cursor): ExprNode {
  let left: ExprNode = term(cursor);
  while (isOp(cursor, "+") || isOp(cursor, "-")) {
    const op = take(cursor).value;
    left = { type: "arith", op, left, right: term(cursor) };
  }
  return left;
}

function term(cursor: Cursor): ExprNode {
  let left: ExprNode = factor(cursor);
  while (isOp(cursor, "*") || isOp(cursor, "/")) {
    const op = take(cursor).value;
    left = { type: "arith", op, left, right: factor(cursor) };
  }
  return left;
}

const LITERAL_TOKENS: ReadonlySet<Token["type"]> = new Set(["number", "string", "boolean", "null"]);

function factor(cursor: Cursor): ExprNode {
  const token = peek(cursor);
  if (!token) throw new Error("unexpected end of expression");
  if (LITERAL_TOKENS.has(token.type)) {
    cursor.pos++;
    return { type: "literal", value: token.value };
  }
  if (isOp(cursor, "-")) {
    take(cursor, "-");
    return { type: "neg", operand: factor(cursor) };
  }
  if (isOp(cursor, "(")) {
    take(cursor, "(");
    const inner: ExprNode = orExpr(cursor);
    take(cursor, ")");
    return inner;
  }
  if (token.type === "ident") {
    cursor.pos++;
    if (!isOp(cursor, "(")) return { type: "ref", path: token.value };
    take(cursor, "(");
    return { type: "call", name: token.value, args: expressionList(cursor, ")") };
  }
  throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
}

function lookup(scope: unknown, path: string): unknown {
  let current: any = scope;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object" && typeof current !== "function") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Evaluate a parsed expression against a scope of values and functions. Missing references
 * are recorded (a check over a probe the build never reported should say so), and any
 * comparison touching a missing or non-numeric side is false — a silent NaN cannot pass.
 */
export function evaluateExpr(ast: ExprNode, scope: unknown): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const readRef = (path: string): unknown => {
    const found = lookup(scope, path);
    if (found === undefined) missing.push(path);
    return typeof found === "function" ? found() : found;
  };
  const callFn = (name: string, args: ExprNode[]): unknown => {
    const fn = lookup(scope, name);
    if (typeof fn === "function") return fn(...args.map(value));
    missing.push(`${name}()`);
    return undefined;
  };
  // `&&` and `||` short-circuit: the right side is read (and its misses recorded) only when needed.
  const both = (left: ExprNode, right: ExprNode): boolean => truthy(value(left)) && truthy(value(right));
  const either = (left: ExprNode, right: ExprNode): boolean => truthy(value(left)) || truthy(value(right));
  function value(node: ExprNode): unknown {
    switch (node.type) {
      case "literal":
        return node.value;
      case "ref":
        return readRef(node.path);
      case "call":
        return callFn(node.name, node.args);
      case "neg":
        return negate(value(node.operand));
      case "not":
        return !truthy(value(node.operand));
      case "and":
        return both(node.left, node.right);
      case "or":
        return either(node.left, node.right);
      case "arith":
        return arithmetic(node.op, value(node.left), value(node.right));
      case "cmp":
        return compare(node.op, value(node.left), value(node.right));
      case "in":
        return isIn(value(node.left), node.items.map(value));
      default:
        return undefined;
    }
  }
  const result = value(ast);
  return { value: result, missing: [...new Set(missing)] };
}

const negate = (v: unknown): number | undefined => (typeof v === "number" ? -v : undefined);

/** `+ - * /` over two numbers; anything else (or a division by zero) has no value. */
function arithmetic(op: string, l: unknown, r: unknown): number | undefined {
  if (typeof l !== "number" || typeof r !== "number") return undefined;
  if (op === "+") return l + r;
  if (op === "-") return l - r;
  if (op === "*") return l * r;
  return r === 0 ? undefined : l / r;
}

/** A comparison: `==`/`!=` over anything, the orderings only over two real numbers. */
function compare(op: string, l: unknown, r: unknown): boolean {
  if (op === "==") return l === r;
  if (op === "!=") return l !== r;
  const bothNumbers = typeof l === "number" && typeof r === "number" && !Number.isNaN(l) && !Number.isNaN(r);
  if (!bothNumbers) return false;
  if (op === "<") return l < r;
  if (op === "<=") return l <= r;
  if (op === ">") return l > r;
  return l >= r;
}

/** `x in [a, b]` over numbers is a closed range; otherwise it is membership. */
function isIn(l: unknown, items: unknown[]): boolean {
  const [low, high] = items;
  const isRange = items.length === 2 && typeof low === "number" && typeof high === "number" && typeof l === "number";
  if (isRange) return l >= Math.min(low, high) && l <= Math.max(low, high);
  return items.some((item) => item === l);
}

function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "";
}

/**
 * Parse + evaluate to a pass/fail with a reason a builder can act on, and the paths the
 * expression read that the scope does not hold (`missing`).
 */
export function evaluateBoolean(source: unknown, scope: unknown): { pass: boolean; reason: string; missing: string[] } {
  let ast: ExprNode;
  try {
    ast = parseExpr(source);
  } catch (err: any) {
    return { pass: false, reason: `expression does not parse: ${err.message}`, missing: [] };
  }
  let outcome: { value: unknown; missing: string[] };
  try {
    outcome = evaluateExpr(ast, scope);
  } catch (err: any) {
    return { pass: false, reason: `expression threw: ${err?.message ?? err}`, missing: [] };
  }
  const { missing } = outcome;
  if (outcome.value === undefined) {
    return {
      pass: false,
      reason: missing.length ? `missing: ${missing.join(", ")}` : "expression produced no value",
      missing,
    };
  }
  if (truthy(outcome.value)) return { pass: true, reason: "", missing };
  return { pass: false, reason: missing.length ? `false (missing: ${missing.join(", ")})` : "false", missing };
}

// ── scopes ─────────────────────────────────────────────────────────────────────────────────

/**
 * Numbers a `pixel` (or `metric`) check may name, all normalised to 0–1 so briefs and checks
 * agree. With reference stats (`refs`: `{ label, stats }`), `styleDistance` is the distance to
 * the nearest still and `styleDistanceTo(label)` to a named one (HARNESS-FIX-PLAN.md WP4).
 */
export function pixelScope(
  stats: Partial<PreviewPixelStats> | null | undefined,
  diff: CameraDiff | null = null,
  refs: readonly (ReferenceStats | null | undefined)[] | null = null,
) {
  if (!stats) return null;
  const norm = (v: unknown): number | undefined => (typeof v === "number" ? v / 255 : undefined);
  const histogram = Array.isArray(stats.histogram) ? stats.histogram : null;
  const bins = histogram?.length ?? 0;
  const bands: Partial<Record<string, number>> = stats.bands ?? {};
  return {
    meanLuma: norm(stats.meanLuma),
    litFraction: stats.litFraction,
    saturation: stats.saturation,
    contrast: norm(stats.contrast),
    edgeDensity: norm(stats.edgeDensity),
    top: norm(bands.top),
    middle: norm(bands.middle),
    bottom: norm(bands.bottom),
    left: norm(bands.left),
    center: norm(bands.center),
    right: norm(bands.right),
    width: stats.width,
    height: stats.height,
    canvas: stats.canvas,
    diffFraction: diff ? diff.diffFraction : undefined,
    meanAbsDiff: diff ? Number(diff.meanAbsDiff) / 255 : undefined,
    band: (name: unknown) => norm(bands[String(name)]),
    fractionAbove: (t: unknown) => {
      if (!histogram) return undefined;
      const first = Math.min(bins, Math.max(0, Math.ceil(Number(t) * bins)));
      return histogram.slice(first).reduce((a, b) => a + b, 0);
    },
    fractionBelow: (t: unknown) => {
      if (!histogram) return undefined;
      const last = Math.min(bins, Math.max(0, Math.floor(Number(t) * bins)));
      return histogram.slice(0, last).reduce((a, b) => a + b, 0);
    },
    styleDistance: () => nearestReference(stats, refs)?.distance,
    styleDistanceTo: (label: unknown) => {
      const ref = (refs ?? []).find((r) => r?.label === String(label)) ?? (refs ?? [])[Number(label) - 1];
      return ref ? (styleDistance(stats, ref.stats) ?? undefined) : undefined;
    },
    nearestReference: () => nearestReference(stats, refs)?.label,
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
  };
}

/** What a `probe` check sees: the late state, the early state under `early`, and helpers. */
export function probeScope(state: unknown, early: unknown = null) {
  const base: AnyRecord = state && typeof state === "object" ? state : {};
  const aliased = !("state" in base);
  // The same alias, inside `has("…")` and `delta("…")`: their argument is a string the parser
  // never turns into a reference, so `state.props.moved` there resolved nowhere and scored a
  // silent `false` — not `unmeasured` — for a whole run.
  const at = (from: unknown, path: unknown): unknown =>
    lookup(from, aliased ? String(path).replace(/^state\./, "") : String(path));
  return {
    ...base,
    // `state.contact.speedKept` is the natural way to write a check over `__studio.state()`,
    // and every probe the first director wrote used it — all 13 read `missing: state.…` on
    // builds that reported the field. The alias is added only when the game has no top-level
    // `state` field of its own, so a real one is never shadowed by the scope's convenience.
    ...(aliased ? { state: base } : {}),
    early: early && typeof early === "object" ? early : {},
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
    round: Math.round,
    len: lengthOf,
    has: (path: unknown) => at(base, path) != null,
    delta: (path: unknown) => {
      const now = at(base, path);
      const then = at(early ?? {}, path);
      return typeof now === "number" && typeof then === "number" ? now - then : undefined;
    },
    distance: (ax: unknown, ay: unknown, bx: unknown, by: unknown) =>
      Math.hypot(Number(ax) - Number(bx), Number(ay) - Number(by)),
  };
}

/**
 * A probe's `len()`: an array's or a string's length, an object's key count, else no value. A
 * value the studio cut out of an over-budget state keeps its length on the stub left in its place.
 */
function lengthOf(v: unknown): number | undefined {
  if (Array.isArray(v) || typeof v === "string") return v.length;
  if (isElided(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return undefined;
}

/** The stub the studio left where it cut a value out of an over-budget state. */
function isElided(v: unknown): v is { [Shape.Elided]: string; length: number; chars?: number } {
  return isRecord(v) && !Array.isArray(v) && typeof v[Shape.Elided] === "string" && typeof v.length === "number";
}

/** How long an older studio's text-cut state was, or null for a state it read whole. */
function truncatedLength(state: unknown): number | null {
  if (!isRecord(state) || state[Shape.Truncated] !== true) return null;
  return typeof state.length === "number" ? state.length : 0;
}

/**
 * Where a path reads INTO a value the studio cut: the stub's path, or null. A path that ends at
 * the stub reads it as the value it stands for only when `whole` says every reading agrees
 * (`len()`, `has()`, truthiness, `!= null`); so does an array's or a string's `.length`, which
 * the stub keeps. Anything else — `title == "x"`, an object's `.length` — is a cut read.
 */
function cutAlong(scope: unknown, path: string, whole = true): string | null {
  const parts = path.split(".");
  let current: unknown = scope;
  for (let i = 0; i < parts.length; i++) {
    if (!isRecord(current)) return null;
    if (isElided(current)) {
      const keptLength = i === parts.length - 1 && parts[i] === "length" && current[Shape.Elided] !== Elided.Object;
      return keptLength ? null : parts.slice(0, i).join(".");
    }
    current = current[parts[i] as string];
  }
  return isElided(current) && !whole ? path : null;
}

/** A path a probe reads, and whether reading the value whole means the same on its stub. */
interface PathRead {
  path: string;
  whole: boolean;
}

/**
 * Every path a probe reads: its references, the paths `has`/`delta` name, its `needs`, and —
 * because `delta()` reads both sides — each delta path in the early state too.
 */
function probePathsOf(check: CheckLike, state: unknown): { reads: PathRead[]; early: boolean } {
  const needs = (Array.isArray(check?.needs) ? check.needs.map(String) : []).map((path) => ({ path, whole: true }));
  let ast: ExprNode;
  try {
    ast = parseExpr(check.expr ?? "");
  } catch {
    return { reads: needs, early: false };
  }
  const refs = refReads(ast);
  const deltas = deltaPathsNamed(ast);
  const early = deltas.length > 0 || refs.some((read) => read.path.startsWith("early."));
  // probeScope's `delta()` alias: `state.` names the state itself unless it has a field of that name.
  const aliased = !(isRecord(state) && "state" in state);
  const before = deltas.map((path) => ({
    path: `early.${aliased ? path.replace(/^state\./, "") : path}`,
    whole: true,
  }));
  const named = pathsNamedAsStrings(ast).map((path) => ({ path, whole: true }));
  return { reads: [...refs, ...named, ...needs, ...before], early };
}

/**
 * Every reference in an expression tree, and whether it is read in a way a stub answers like
 * the value it stands for: alone as a truth value, under `!`/`&&`/`||`, compared to `null`, or
 * as `len()`'s one argument.
 */
function refReads(ast: ExprNode): PathRead[] {
  const reads: PathRead[] = [];
  const walk = (node: ExprNode, whole: boolean): void => {
    if (node.type === "ref") reads.push({ path: node.path, whole });
    for (const [child, childWhole] of readsBelow(node)) walk(child, childWhole);
  };
  walk(ast, true);
  return reads;
}

/** A node's sub-expressions, each with whether it is read only as a truth value or a length. */
function readsBelow(node: ExprNode): Array<[ExprNode, boolean]> {
  const isNull = (side: ExprNode): boolean => side.type === "literal" && side.value === null;
  switch (node.type) {
    case "not":
      return [[node.operand, true]];
    case "neg":
      return [[node.operand, false]];
    case "and":
    case "or":
      return [
        [node.left, true],
        [node.right, true],
      ];
    case "cmp": {
      const equality = node.op === "==" || node.op === "!=";
      return [
        [node.left, equality && isNull(node.right)],
        [node.right, equality && isNull(node.left)],
      ];
    }
    case "arith":
      return [
        [node.left, false],
        [node.right, false],
      ];
    case "in":
      return [node.left, ...node.items].map((child) => [child, false]);
    case "call": {
      const lengthOnly = node.name === "len" && node.args.length === 1;
      return node.args.map((arg) => [arg, lengthOnly]);
    }
    default:
      return [];
  }
}

/**
 * A probe over a state the studio could not read whole is unmeasured with the reason, and never
 * "the build does not report …": that told builders to add to a state that was already too big.
 * An older studio cut the whole text; this one cuts the largest values, so only a probe that reads
 * inside one of them — in the late state, or in the early one a `delta()` reads — is unmeasured.
 */
function unreadableState(check: CheckLike, state: unknown, early: unknown): CheckResult | null {
  const read = probePathsOf(check, state);
  const truncated = truncatedLength(state) ?? (read.early ? truncatedLength(early) : null);
  if (truncated !== null) {
    return unmeasured(
      check,
      `state() is ${truncated.toLocaleString("en-US")} chars, over the ${LEGACY_STATE_CAP_CHARS.toLocaleString("en-US")} the studio reads whole, so it came back cut and nothing in it could be read — report less in state() (keep long lists out of it)`,
      { stateTooLarge: true },
    );
  }
  const scope = probeScope(state, early);
  const cuts = read.reads.map((r) => ({ path: r.path, at: cutAlong(scope, r.path, r.whole) }));
  const inside = [...new Set(cuts.filter((c) => c.at !== null).map((c) => c.path))];
  if (!inside.length) return null;
  const stubs = [...new Set(cuts.flatMap((c) => (c.at === null ? [] : [c.at])))];
  const fromEarly = (at: string): boolean => at === "early" || at.startsWith("early.");
  const sizes: string[] = [];
  if (stubs.some((at) => !fromEarly(at))) sizes.push(cutStateSize(state, "state()"));
  if (stubs.some(fromEarly)) sizes.push(cutStateSize(early, "early state()"));
  return unmeasured(
    check,
    `the studio cut ${stubs.join(", ")} from ${sizes.join(" and ")}, so ${inside.join(", ")} cannot be read — measure it with len(), or report less in state()`,
    { stateTooLarge: true, cut: inside },
  );
}

/** "a 82,303-char state()", or "an over-budget state()" when the state does not say its size. */
function cutStateSize(state: unknown, name: string): string {
  const whole = stateCutChars(state);
  return whole === null ? `an over-budget ${name}` : `a ${whole.toLocaleString("en-US")}-char ${name}`;
}

/** The full size a bounded state says it had, or null for a state the studio read whole. */
function stateCutChars(state: unknown): number | null {
  const cut = isRecord(state) ? state[Shape.Cut] : null;
  return isRecord(cut) && typeof cut.chars === "number" ? cut.chars : null;
}

/**
 * The dry run: read every probe expression against the state a build actually reports, before
 * anyone builds on it. A probe is the only check that names paths the game must expose, and
 * the first director run wrote thirteen of them against paths that never resolved — every
 * board read `missing: state.…` on builds that worked, and nobody found out until morning.
 *
 * A ref that cannot be found is *unsatisfiable as written*: either the path is wrong or the
 * build has to start reporting it. Which one it is, is the builder's job — so the answer comes
 * with the top-level keys `state()` does have. Nothing here fails a check: a dry run with no
 * state (nobody looked yet) reports nothing at all.
 */
export function dryRunChecks(
  checks: readonly Check[] | null | undefined,
  { state = null, demoStates = null }: { state?: unknown; demoStates?: unknown } = {},
): {
  unsatisfiable: Array<{ id: string; missing: string[] }>;
  stateKeys: string[] | null;
  /** The state was cut as text by an older studio: nothing in it can be read, so nothing is judged. */
  unreadable?: { chars: number };
} {
  if (!isRecord(state) || state.__missing) return { unsatisfiable: [], stateKeys: null };
  const truncated = truncatedLength(state);
  if (truncated !== null) return { unsatisfiable: [], stateKeys: null, unreadable: { chars: truncated } };
  const unsatisfiable: Array<{ id: string; missing: string[] }> = [];
  for (const check of checks ?? []) {
    if (check?.kind !== Kind.Probe || !check.expr) continue;
    // A demo-scoped probe is read from what that demo left behind, as it will be in the loop.
    const sample = check.demo ? ((demoStates as AnyRecord | null)?.[check.demo] ?? state) : state;
    let ast: ExprNode;
    let scope: ReturnType<typeof probeScope>;
    let outcome: { value: unknown; missing: string[] };
    try {
      ast = parseExpr(check.expr);
      scope = probeScope(sample, state);
      outcome = evaluateExpr(ast, scope);
    } catch {
      continue; // an expression that does not parse is validateFacetSpec's problem, not this one
    }
    // A path named as a string — `has("x")`, `delta("x")` — never becomes a reference, so
    // `missing` cannot see it and the check quietly reads false forever. Read it here.
    // A path inside a value the studio cut is reported — the state was just too big to read it.
    const reported = (path: string): boolean => cutAlong(scope, path) !== null;
    const named = pathsNamedAsStrings(ast).filter((path) => scope.has(path) !== true && !reported(path));
    const missing = [...new Set([...outcome.missing.filter((path) => !reported(path)), ...named])];
    if (missing.length) unsatisfiable.push({ id: check.id, missing });
  }
  return { unsatisfiable, stateKeys: Object.keys(state).filter((key) => key !== Shape.Cut) };
}

/** Every string literal a `delta()` call names: the paths a probe reads on BOTH sides of a pass. */
function deltaPathsNamed(ast: ExprNode): string[] {
  return pathsNamedBy(ast, ["delta"]);
}

/** Every string literal a `has`/`delta` call names: the paths a probe reads without a reference. */
function pathsNamedAsStrings(ast: ExprNode): string[] {
  return pathsNamedBy(ast, ["has", "delta"]);
}

/** The path a call to one of `fns` names as its first, string-literal argument. */
function literalPathArgument(node: AnyRecord, fns: readonly string[]): string | null {
  if (node.type !== "call" || !fns.includes(node.name)) return null;
  const first = node.args?.[0];
  return first?.type === "literal" && typeof first.value === "string" ? first.value : null;
}

/** Every string-literal path the calls to `fns` name, anywhere in the tree. */
function pathsNamedBy(ast: ExprNode, fns: readonly string[]): string[] {
  const paths: string[] = [];
  const walk = (node: AnyRecord | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    const named = literalPathArgument(node, fns);
    if (named !== null) paths.push(named);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
    }
  };
  walk(ast);
  return paths;
}

// ── deterministic evaluation ───────────────────────────────────────────────────────────────

/** Who wrote the check, carried onto its result so the board can be read without the spec. */
const originOf = (check: Partial<Check> | null | undefined): { origin?: string } =>
  typeof check?.origin === "string" && check.origin ? { origin: check.origin } : {};

function result(check: CheckLike, pass: unknown, reason: string, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    id: check.id,
    kind: check.kind,
    weight: check.weight ?? Weight.Normal,
    ...originOf(check),
    pass: Boolean(pass),
    reason: pass ? "" : reason,
    ...extra,
  };
}

/**
 * The third state. A check whose evidence was never gathered — a demo the cap skipped, a
 * camera the capture lost, a playtester that never ran — is *unmeasured*: `pass: null`. It is
 * not a flip, not a regression, not a defect for the judge, not a spike trigger and not a
 * recipe loss; it only blocks "satisfied" with its own reason. One run turned three uncaptured
 * demos into "ADS never engages" and sent five subsystems after a phantom. Never again: the
 * harness must not turn "I did not look" into "it failed".
 */
export function unmeasured(check: CheckLike, reason: string, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    id: check.id,
    kind: check.kind,
    weight: check.weight ?? Weight.Normal,
    ...originOf(check),
    pass: null,
    state: "unmeasured",
    reason,
    ...extra,
  };
}

/** True for a result the harness actually measured (pass or fail). */
export function isMeasured(entry: { pass?: boolean | null } | null | undefined): boolean {
  return entry?.pass === true || entry?.pass === false;
}

/** Why a check's camera has no shot: not registered (the build's defect), or simply not captured. */
function cameraNotCaptured(check: CheckLike, evidence: CheckEvidence | null | undefined): CheckResult {
  if ((evidence?.missingCameras ?? []).includes(check.camera as string))
    return result(
      check,
      false,
      `camera "${check.camera}" is not registered in config.cameras — register it in main.js`,
    );
  return unmeasured(check, `camera ${check.camera} was not captured in this evidence pass`);
}

/** An `eye:` camera the game never installed: the builder has to pass camera and player(). */
function isMissingEye(check: CheckLike, evidence: CheckEvidence | null | undefined): boolean {
  const eyes = evidence?.eyes;
  return String(check.camera).startsWith("eye:") && Array.isArray(eyes) && !eyes.includes(check.camera as string);
}

export function evaluatePixelCheck(
  check: CheckLike,
  evidence: CheckEvidence | null | undefined,
  diffs: Record<string, CameraDiff | null | undefined> = {},
  { references = null }: { references?: ReferenceStats[] | null } = {},
): CheckResult {
  const shot = (evidence?.shots ?? []).find((s) => s.camera === check.camera);
  if (!shot) {
    const registered = !(evidence?.missingCameras ?? []).includes(check.camera as string);
    if (registered && isMissingEye(check, evidence)) {
      return result(
        check,
        false,
        `eye camera ${check.camera} does not exist — pass camera and player() to installStudio`,
      );
    }
    return cameraNotCaptured(check, evidence);
  }
  const scope = shot.stats ? pixelScope(shot.stats, diffs[String(check.camera)] ?? null, references) : null;
  if (!scope) return unmeasured(check, `no pixel stats for camera ${check.camera}`);
  const outcome = evaluateBoolean(check.expr, scope);
  const observed = describePixels(scope);
  return result(check, outcome.pass, `${outcome.reason} — observed ${observed}`, { observed });
}

/** The expression reads a style distance, which needs reference stills to mean anything. */
const readsStyle = (expr: unknown): boolean => /styleDistance|nearestReference/.test(String(expr));

/**
 * A `metric` check is a number, not a boolean: its expression (over the pixel scope, so
 * `styleDistance`, `styleDistanceTo("dock")`, `meanLuma` …) is recorded as `value`, and the
 * scoreboard ratchets it — improved by more than `tol` is a flip, worsened by more than `tol`
 * a regression (see compareScoreboards). It passes whenever it was measured, unless the check
 * names a `target` the value must reach (goal min: value <= target; max: value >= target).
 */
export function evaluateMetricCheck(
  check: CheckLike,
  evidence: CheckEvidence | null | undefined,
  diffs: Record<string, CameraDiff | null | undefined> = {},
  { references = null }: { references?: ReferenceStats[] | null } = {},
): CheckResult {
  const shot = (evidence?.shots ?? []).find((s) => s.camera === check.camera);
  if (!shot) return cameraNotCaptured(check, evidence);
  if (!shot.stats) return unmeasured(check, `no pixel stats for camera ${check.camera}`);
  const scope = pixelScope(shot.stats, diffs[String(check.camera)] ?? null, references);
  const evaluated = evaluateMetric(check, scope);
  if ("failed" in evaluated) return evaluated.failed;
  const { value, missing } = evaluated;
  if (typeof value !== "number" || !Number.isFinite(value))
    return metricWithoutValue(check, value, missing, references);
  const goal = check.goal === "max" ? "max" : "min";
  const tol = typeof check.tol === "number" ? check.tol : METRIC_DEFAULT_TOL;
  const nearest = /styleDistance/.test(check.expr as string)
    ? (nearestReference(shot.stats, references)?.label ?? null)
    : null;
  const { pass, reason } = metricTarget(value, goal, check.target);
  return {
    ...result(check, pass, reason, { value, goal, tol, ...(nearest ? { nearest } : {}) }),
    observed: `${check.expr} = ${value.toFixed(3)}${nearest ? ` (nearest still: ${nearest})` : ""}`,
  };
}

/** Parse and evaluate a metric's expression, or the failed result that says why it could not be. */
function evaluateMetric(
  check: CheckLike,
  scope: unknown,
): { value: unknown; missing: string[] } | { failed: CheckResult } {
  let ast: ExprNode;
  try {
    ast = parseExpr(check.expr);
  } catch (err: any) {
    return { failed: result(check, false, `expression does not parse: ${err.message}`) };
  }
  try {
    return evaluateExpr(ast, scope);
  } catch (err: any) {
    return { failed: result(check, false, `expression threw: ${err?.message ?? err}`) };
  }
}

/** A metric that produced no number: unmeasured when it needed references nobody gave, else failed. */
function metricWithoutValue(
  check: CheckLike,
  value: unknown,
  missing: string[],
  references: ReferenceStats[] | null,
): CheckResult {
  const why = missing.length
    ? `missing: ${missing.join(", ")}`
    : `expression produced ${JSON.stringify(value)}, not a number`;
  // No references → no distance: that is "nobody could look", not a failed build.
  const noReferences = !((references?.length as number) > 0);
  const styleUnmeasurable = missing.length === 0 && readsStyle(check.expr) && noReferences;
  if (styleUnmeasurable)
    return unmeasured(check, "no reference stills with stats — style distance cannot be measured", {
      goal: check.goal,
      tol: check.tol,
    });
  return result(check, false, why, { goal: check.goal, tol: check.tol });
}

/** Whether a metric's value reaches the `target` it names (none named: it passes). */
function metricTarget(value: number, goal: "min" | "max", target: unknown): { pass: boolean; reason: string } {
  if (typeof target !== "number") return { pass: true, reason: "" };
  const pass = goal === "min" ? value <= target : value >= target;
  if (pass) return { pass, reason: "" };
  return { pass, reason: `${value.toFixed(3)} is ${goal === "min" ? "above" : "below"} the target ${target}` };
}

function describePixels(scope: NonNullable<ReturnType<typeof pixelScope>>): string {
  const f = (v: unknown): string => (typeof v === "number" ? v.toFixed(3) : "n/a");
  return `meanLuma ${f(scope.meanLuma)}, litFraction ${f(scope.litFraction)}, contrast ${f(scope.contrast)}, saturation ${f(scope.saturation)}, top ${f(scope.top)}, bottom ${f(scope.bottom)}, above0.9 ${f(scope.fractionAbove(0.9))}`;
}

/**
 * Why a demo a check names produced nothing. Three different facts hid behind one string:
 * not registered (the builder's defect), skipped by the cap, or never asked. Only the first
 * is a failure; the other two are "nobody looked".
 */
function demoNotRun(check: CheckLike, evidence: CheckEvidence | null | undefined, name: string): CheckResult {
  const registered = Array.isArray(evidence?.registeredDemos) ? evidence.registeredDemos : null;
  if (registered && !registered.includes(name)) {
    // A check the library marks `optional` names a demo the game may not have — the walk demo
    // on a game that is not walked (M4.7). Nobody looked; nobody failed.
    if (check.optional === true) {
      return unmeasured(
        check,
        `demo "${name}" is not registered — this check is optional, so it is unmeasured rather than failed`,
        { unavailable: true },
      );
    }
    return result(
      check,
      false,
      `demo "${name}" is not registered — config.demos has: ${registered.join(", ") || "none"}`,
    );
  }
  if (registered && (evidence?.skippedDemos ?? []).includes(name))
    return unmeasured(check, `demo "${name}" was not run (demo cap)`);
  return unmeasured(check, `demo "${name}" was not run in this evidence pass`);
}

/**
 * A probe reads `__studio.state()`. `check.demo` scopes it to one demo's end state: the demos
 * run *after* the main sample, so a number a demo drives (a crash test's kept speed) is still
 * zero in `evidence.state` and only real in the snapshot taken when that demo finished. Under
 * a demo scope `early` is the state as it stood before any demo ran, so `delta()` measures
 * what the demos did rather than what the scripted walk did.
 */
/**
 * `needs`: the state paths a probe cannot be read without. A counter a game creates lazily —
 * the draw counters, a score that only exists once the first round starts — is absent from
 * `state()` until it exists, and an expression over an absent path scores a silent `false`:
 * "I did not look" told as "it failed". A check that names what it needs is UNMEASURED instead,
 * and says which path was missing.
 *
 * The gate covers both scopes: a path the expression names inside `delta()` is read before the
 * controls ran as well as after, so a counter that appeared only in the late state is
 * unmeasured too rather than compared against nothing.
 */
function needsNotReported(check: CheckLike, state: unknown, early: unknown): string[] | null {
  const needs = Array.isArray(check?.needs)
    ? check.needs
        .map((path) => String(path))
        .filter(Boolean)
        .slice(0, MAX_CHECK_NEEDS)
    : [];
  if (!needs.length) return null;
  const late = probeScope(state, early);
  const before = probeScope(early && typeof early === "object" ? early : {}, null);
  let deltas: string[] = [];
  try {
    deltas = deltaPathsNamed(parseExpr(check.expr ?? ""));
  } catch {
    deltas = [];
  }
  const missing: string[] = [];
  for (const path of needs) {
    if (late.has(path) !== true) missing.push(path);
    else if (deltas.includes(path) && before.has(path) !== true) missing.push(`early.${path}`);
  }
  return missing.length ? missing : null;
}

export function evaluateProbeCheck(check: CheckLike, evidence: CheckEvidence | null | undefined): CheckResult {
  const scoped = probeStates(check, evidence);
  if ("result" in scoped) return scoped.result;
  const { state, early } = scoped;
  if (!state) return unmeasured(check, "no state() probe was captured");
  if (state.__missing) return result(check, false, "window.__studio is missing — the build exposes no state()");
  const unreadable = unreadableState(check, state, early);
  if (unreadable) return unreadable;
  const notReported = needsNotReported(check, state, early);
  if (notReported)
    return unmeasured(
      check,
      `the build does not report ${notReported.join(", ")} — this check names them under needs`,
      { missing: notReported, unavailable: true },
    );
  const outcome = evaluateBoolean(check.expr, probeScope(state, early));
  // `!=`, `!`, `==` and `||` over a path the build never reported still yield a value, so
  // an absent field could pass a check. Whatever the expression read that the state lacks makes
  // the check unmeasured — "I did not see it", never a pass or a fail.
  if (outcome.missing.length)
    return unmeasured(check, `the build does not report ${outcome.missing.join(", ")}`, {
      missing: outcome.missing,
      unavailable: true,
    });
  return result(
    check,
    outcome.pass,
    `${outcome.reason} — state${whereRead(check)} ${clipMarked(JSON.stringify(state), CLIP_REASON)}`,
  );
}

/** The states a probe is scoped to, as `AnyRecord`s the expression reads; or why there is none. */
type ProbeStates =
  | { state: AnyRecord | null | undefined; early: AnyRecord | null | undefined }
  | { result: CheckResult };

/** What a probe reads: the drive's states, a demo's end state, or the throttle-bot race's — or why it cannot. */
function probeStates(check: CheckLike, evidence: CheckEvidence | null | undefined): ProbeStates {
  if (check.after === ProbeAfter.ThrottleBot) return raceStates(check, evidence);
  if (!check.demo) return { state: evidence?.state, early: evidence?.stateEarly };
  const demo = evidence?.demos?.[check.demo];
  if (!demo) return { result: demoNotRun(check, evidence, check.demo) };
  if (demo.ok !== true) {
    const why = demo.error ?? JSON.stringify(demo).slice(0, CLIP_DETAIL);
    return { result: result(check, false, `demo "${check.demo}" failed: ${why}`) };
  }
  const state = evidence?.demoStates?.[check.demo];
  if (!state) return { result: unmeasured(check, `no state() was captured after demo "${check.demo}"`) };
  return { state, early: evidence?.state };
}

/**
 * The state the throttle-only bot's race left (evidence.ts `raceThrottleBot`), against the state it
 * started from. With no race to read, a game whose own state reports no race result is not asked —
 * the drive's state says which of the check's `needs` it lacks, and a harness check over a path the
 * build never reports is not its question (harness-needs.ts). Any other race nobody ran is unmeasured.
 */
function raceStates(check: CheckLike, evidence: CheckEvidence | null | undefined): ProbeStates {
  const race = isRecord(evidence?.challenge) ? evidence.challenge : null;
  if (race?.ran === true) {
    if (!isRecord(race.state))
      return { result: unmeasured(check, "no state() was captured after the throttle-bot race") };
    return { state: race.state, early: isRecord(race.early) ? race.early : evidence?.state };
  }
  const drive = evidence?.state;
  const notReported = isRecord(drive) ? needsNotReported(check, drive, evidence?.stateEarly) : null;
  if (notReported) {
    const why = `the build does not report ${notReported.join(", ")} — there is no race for a throttle-only bot to win`;
    return { result: unmeasured(check, why, { missing: notReported, unavailable: true }) };
  }
  const why =
    typeof race?.reason === "string"
      ? `the throttle-bot race did not run: ${race.reason}`
      : "the throttle-bot race was not run in this evidence pass";
  return { result: unmeasured(check, why) };
}

/** Where a probe's state was read, for its reason: after a demo, after the bot's race, or the drive. */
function whereRead(check: CheckLike): string {
  if (check.demo) return ` after demo "${check.demo}"`;
  if (check.after) return ` after the ${check.after} race`;
  return "";
}

export function evaluateDemoCheck(check: CheckLike, evidence: CheckEvidence | null | undefined): CheckResult {
  const demo = evidence?.demos?.[check.name as string];
  if (!demo) return demoNotRun(check, evidence, check.name as string);
  if (demo.ok !== true)
    return result(
      check,
      false,
      `demo "${check.name}" failed: ${demo.error ?? JSON.stringify(demo).slice(0, CLIP_DETAIL)}`,
    );
  if (check.expr && check.expr !== "ok") {
    const outcome = evaluateBoolean(check.expr, {
      ...probeScope(demo.result ?? {}),
      result: demo.result ?? null,
      ok: true,
    });
    return result(
      check,
      outcome.pass,
      `${outcome.reason} — demo result ${clipMarked(JSON.stringify(demo.result), CLIP_REASON)}`,
    );
  }
  return result(check, true, "");
}

/**
 * Scene checks run in the page. `__studio.inspect()` returns the helper set (scene, renderer,
 * camera, meshes(tag), objects(tag), renderTargets(), lights(), materials(), count(tag),
 * bbox(tag), audio()); the check's JS is evaluated with those names in scope and must yield a
 * truthy value. Anything else — no contract, a throw, a non-boolean — fails with the reason.
 */
export const INSPECT_UNAVAILABLE = "inspect() is unavailable";

export function sceneCheckExpression(js: unknown): string {
  const body = JSON.stringify(String(js));
  return `(() => {
    const s = window.__studio;
    if (!s || typeof s.inspect !== "function") return { __error: "the build exposes no __studio.inspect() — install the v2 contract (scene/renderer helpers)" };
    let I;
    try { I = s.inspect(); } catch (e) { return { __error: "inspect() threw: " + String(e && e.message || e) }; }
    // The page knows when it cannot answer yet: no renderer has drawn a frame, so there is no
    // scene to ask about. That is "nobody looked", not "the build failed the check".
    if (I && I.available === false) return { __unavailable: ${JSON.stringify(INSPECT_UNAVAILABLE)} + ": " + String((I && I.reason) || "no renderer has drawn a frame yet") };
    try {
      const fn = new Function("I", "with (I) { return (" + ${body} + "); }");
      const v = fn(I);
      if (v && typeof v.then === "function") return v.then((r) => ({ value: describe(r) }), (e) => ({ __error: String(e && e.message || e) }));
      return { value: describe(v) };
    } catch (e) { return { __error: String(e && e.message || e) }; }
    function describe(v) {
      if (v === undefined) return null;
      if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
      if (Array.isArray(v)) return { __array: v.length };
      if (v && typeof v === "object") return { __object: (v.constructor && v.constructor.name) || "object" };
      return Boolean(v);
    }
  })()`;
}

export async function evaluateSceneCheck(
  ctx: HarnessCtx,
  check: Check,
  { handle }: { handle?: string | null } = {},
): Promise<CheckResult> {
  let outcome: AnyRecord | null;
  try {
    outcome = await evaluateInPage(ctx, check.js, handle);
  } catch (err: any) {
    return unmeasured(check, `scene check could not run: ${err?.message ?? err}`);
  }
  if (!outcome || typeof outcome !== "object")
    return unmeasured(check, `scene check returned ${JSON.stringify(outcome)}`);
  // Unavailable before error, and before the detail pass: a page that cannot be inspected yet
  // has nothing to describe either, and asking it again only costs a round trip.
  const unavailable = inspectUnavailable(outcome);
  if (unavailable) return unmeasured(check, `scene check could not be measured: ${unavailable}`, { unavailable: true });
  if (outcome.__error) return result(check, false, `scene check error: ${outcome.__error}`);
  // The page-side wrapper always answers {value} or {__error}; anything else means the
  // expression never ran there (an undefined is never a pass — nothing may pass unlooked-at).
  if (!("value" in outcome))
    return unmeasured(check, "scene check produced no value — the page did not run the inspect() wrapper");
  const verdict = sceneVerdict(check, outcome.value);
  // `detail`: JS over the same helpers that names what failed ("hud-tagged objects: Mesh,
  // Sprite"), so a false from a harness-owned check is actionable, not a bare boolean.
  if (!verdict.pass && check.detail) await addSceneDetail(ctx, check.detail, verdict, handle);
  return verdict;
}

/** Run scene JS in the page through the `inspect()` wrapper. */
async function evaluateInPage(
  ctx: HarnessCtx,
  js: unknown,
  handle: string | null | undefined,
): Promise<AnyRecord | null> {
  return (await ctx.call(HostMethod.PreviewEvaluate, {
    expression: sceneCheckExpression(js),
    ...(handle ? { handle } : {}),
  })) as AnyRecord | null;
}

/** Why the page could not be inspected yet, when that is what it answered. */
function inspectUnavailable(outcome: AnyRecord): string | null {
  if (typeof outcome.__unavailable === "string") return outcome.__unavailable;
  const error = outcome.__error;
  if (typeof error === "string" && error.includes(INSPECT_UNAVAILABLE)) return error;
  return null;
}

/** A scene check's value, read as a verdict: a non-empty array or an object passes, otherwise truthiness. */
function sceneVerdict(check: Check, value: unknown): CheckResult {
  if (isRecord(value)) {
    if (value.__array !== undefined)
      return result(check, value.__array > 0, `expression returned an empty array`, {
        observed: `array(${value.__array})`,
      });
    return result(check, true, "", { observed: value.__object });
  }
  const pass = value !== null && value !== false && value !== 0 && value !== "";
  return result(check, pass, `expression returned ${JSON.stringify(value)}`, { observed: value });
}

/** Append what the check's `detail` JS names to a failed verdict's reason. */
async function addSceneDetail(
  ctx: HarnessCtx,
  detail: unknown,
  verdict: CheckResult,
  handle: string | null | undefined,
): Promise<void> {
  try {
    const described = await evaluateInPage(ctx, detail, handle);
    const text = isRecord(described) && !described.__error ? described.value : null;
    if (typeof text === "string" && text.trim())
      verdict.reason = `${verdict.reason} — ${clip(text.trim(), CLIP_REASON)}`;
  } catch {
    /* the detail is a courtesy; the verdict stands without it */
  }
}

/** How each deterministic kind is evaluated; vision and play are left pending for the model-backed evaluators. */
type DeterministicInput = {
  evidence: CheckEvidence | null | undefined;
  diffs: Record<string, CameraDiff | null | undefined>;
  handle?: string | null;
  references: ReferenceStats[] | null;
};

type Evaluator = (ctx: HarnessCtx, check: Check, input: DeterministicInput) => CheckResult | Promise<CheckResult>;

/** How a deterministic kind is evaluated, or null for a kind the harness does not evaluate itself. */
function deterministicEvaluator(kind: string): Evaluator | null {
  switch (kind) {
    case Kind.Pixel:
      return (_ctx, check, { evidence, diffs, references }) =>
        evaluatePixelCheck(check, evidence, diffs, { references });
    case Kind.Metric:
      return (_ctx, check, { evidence, diffs, references }) =>
        evaluateMetricCheck(check, evidence, diffs, { references });
    case Kind.Probe:
      return (_ctx, check, { evidence }) => evaluateProbeCheck(check, evidence);
    case Kind.Demo:
      return (_ctx, check, { evidence }) => evaluateDemoCheck(check, evidence);
    case Kind.Scene:
      return (ctx, check, { handle }) => evaluateSceneCheck(ctx, check, { handle });
    default:
      return null;
  }
}

/** Vision and play checks need a model: judge.ts and playtester.ts evaluate them. */
const needsModel = (kind: string): boolean => kind === Kind.Vision || kind === Kind.Play;

/**
 * Evaluate every deterministic check in a spec. Vision and play checks are returned as
 * `pending` for the model-backed evaluators; diffs are per-camera diff results when the
 * caller computed them (see facet-loop's invisible-diff detection).
 */
export async function runDeterministicChecks(
  ctx: HarnessCtx,
  {
    spec,
    evidence,
    diffs = {},
    handle,
    references = null,
  }: {
    spec: { checks?: readonly Check[] } | null | undefined;
    evidence: CheckEvidence | null | undefined;
    diffs?: Record<string, CameraDiff | null | undefined>;
    handle?: string | null;
    references?: ReferenceStats[] | null;
  },
): Promise<{ results: CheckResult[]; pending: Check[] }> {
  const results: CheckResult[] = [];
  const pending: Check[] = [];
  const input: DeterministicInput = { evidence, diffs, handle, references };
  for (const check of spec?.checks ?? []) {
    const evaluate = deterministicEvaluator(check.kind);
    if (evaluate) results.push(await evaluate(ctx, check, input));
    else if (needsModel(check.kind)) pending.push(check);
    else results.push(result(check, false, `unknown check kind ${check.kind}`));
  }
  return { results, pending };
}

// ── scoreboard ─────────────────────────────────────────────────────────────────────────────

/** Results keyed by id, in spec order. */
export function toScoreboard(results: readonly (CheckResult | null | undefined)[] | null | undefined): Scoreboard {
  const board: Scoreboard = {};
  for (const entry of results ?? []) if (entry?.id) board[entry.id] = entry;
  return board;
}

/**
 * A check the accepted build never measured has no "before" to have improved on. A mechanical
 * check measures itself, so its first pass is a real win over nothing. A vision check's first
 * pass is one judge's first look, and a first look barely above a guess is not evidence: the
 * same answer against a measured "no" would not have flipped it either (settleVision). One
 * run kept a round on exactly this — a question grown the iteration before, never measured on
 * the build it was grown from, answered "yes" at 0.5.
 */
function firstMeasurementFlips(previous: CheckResult | undefined, entry: CheckResult | undefined): boolean {
  if (isMeasured(previous)) return true;
  if (entry?.kind !== Kind.Vision) return true;
  return (typeof entry.confidence === "number" ? entry.confidence : 0) >= VISION_FLIP_CONFIDENCE;
}

/**
 * Credit assignment, mechanically: a check the incumbent failed (or never had) that the
 * challenger passes has flipped; a check the incumbent passed that the challenger measurably
 * fails is a regression. Unknown incumbent status counts as failing — the first iteration's
 * wins are real wins over nothing, except for the confidence floor above. An unmeasured
 * challenger result is neither: it is listed under `unmeasured` and moves nothing.
 */
export function compareScoreboards(
  previous: Scoreboard | null | undefined,
  next: Scoreboard | null | undefined,
): ScoreboardComparison {
  const prev: Scoreboard = previous ?? {};
  const comparison: ScoreboardComparison = { flips: [], regressions: [], passing: [], failing: [], unmeasured: [] };
  for (const [id, entry] of Object.entries(next ?? {})) {
    tally(id, entry, comparison);
    compareEntry(id, prev[id], entry, comparison);
  }
  return comparison;
}

/** Whether one check flipped or regressed between the two boards. */
function compareEntry(
  id: string,
  earlier: CheckResult | undefined,
  entry: CheckResult | undefined,
  comparison: ScoreboardComparison,
): void {
  const before = earlier?.pass === true;
  // A metric both sides measured is a ratchet: better by more than tol flips, worse by more
  // than tol regresses, and pass/fail says nothing in between (WP4).
  if (earlier && isRatchet(earlier, entry)) {
    compareMetric(id, earlier, entry, comparison);
    const newRegression = before && entry.pass === false && !comparison.regressions.includes(id);
    if (newRegression) comparison.regressions.push(id);
    return;
  }
  const firstFlip = !before && entry?.pass === true && firstMeasurementFlips(earlier, entry);
  if (firstFlip) comparison.flips.push(id);
  if (before && entry?.pass === false) comparison.regressions.push(id);
}

/** File a result under passing, failing or unmeasured. */
function tally(id: string, entry: CheckResult | undefined, comparison: ScoreboardComparison): void {
  if (entry?.pass === true) comparison.passing.push(id);
  else if (entry?.pass === false) comparison.failing.push(id);
  else comparison.unmeasured.push(id);
}

/** A metric both boards measured, with a number on each side: a ratchet, not a pass/fail. */
function isRatchet(previous: CheckResult, entry: CheckResult | undefined): entry is CheckResult {
  return (
    entry?.kind === Kind.Metric &&
    typeof entry.value === "number" &&
    typeof previous.value === "number" &&
    isMeasured(entry) &&
    isMeasured(previous)
  );
}

/** A ratchet's move: better by more than its tolerance flips, worse by more regresses. */
function compareMetric(id: string, previous: CheckResult, entry: CheckResult, comparison: ScoreboardComparison): void {
  const delta = metricImprovement(previous, entry);
  const tol = typeof entry.tol === "number" ? entry.tol : METRIC_DEFAULT_TOL;
  if (delta > tol) comparison.flips.push(id);
  else if (delta < -tol) comparison.regressions.push(id);
}

/** Positive when `next` is better than `prev` in the metric's own direction. */
export function metricImprovement(prev: { value?: number }, next: { value?: number; goal?: string }): number {
  const goal = next?.goal === "max" ? "max" : "min";
  const before = Number(prev.value);
  const after = Number(next.value);
  return goal === "min" ? before - after : after - before;
}

/**
 * Hysteresis for vision checks (WP2b). A judge answering the same crop at ~0.75 confidence
 * flipped 22 checks in one run; every "regression" was noise. A passing check needs a
 * confident "no" (≥ regressConfidence) — or a second low-confidence "no" in a row (a
 * `wobble`) — to fail; a failing check needs a "yes" at ≥ flipConfidence to pass. What the
 * judge actually said this pass is kept in `lastAnswer`, so nothing is hidden.
 *
 * `stuck` is the other half of the same story: a *failing* check the judge answers under
 * `stuckConfidence` settles nothing either way — a repeated hedged "no", or a "yes" too weak to
 * flip. One run asked "is the live probe's speedKept reading gone?" of a JPEG twelve times and
 * got 0.20 every time. The caller counts the flag; a question that cannot be answered from a
 * picture belongs in the ledger, not on the board.
 */
/** A fresh answer always settles into one; only no answer at all can leave nothing. */
export function settleVision(
  previous: CheckResult | undefined,
  fresh: CheckResult,
  options?: { regressConfidence?: number; flipConfidence?: number; stuckConfidence?: number },
): CheckResult;
export function settleVision(
  previous: CheckResult | undefined,
  fresh: CheckResult | undefined,
  options?: { regressConfidence?: number; flipConfidence?: number; stuckConfidence?: number },
): CheckResult | undefined;
export function settleVision(
  previous: CheckResult | undefined,
  fresh: CheckResult | undefined,
  {
    regressConfidence = 0.85,
    flipConfidence = VISION_FLIP_CONFIDENCE,
    stuckConfidence = VISION_STUCK_CONFIDENCE,
  }: { regressConfidence?: number; flipConfidence?: number; stuckConfidence?: number } = {},
): CheckResult | undefined {
  if (!fresh) return previous;
  if (!previous) return fresh;
  if (!isMeasured(previous) || !isMeasured(fresh)) return fresh;
  return settleMeasured(previous, fresh, { regressConfidence, flipConfidence, stuckConfidence });
}

/** `settleVision` once both answers were measured: neither is missing from here on. */
function settleMeasured(
  previous: CheckResult,
  fresh: CheckResult,
  thresholds: { regressConfidence: number; flipConfidence: number; stuckConfidence: number },
): CheckResult {
  const confidence = typeof fresh.confidence === "number" ? fresh.confidence : 0.5;
  const hedged = previous.pass === false && confidence < thresholds.stuckConfidence;
  if (fresh.pass === previous.pass) return { ...fresh, wobble: false, stuck: hedged };
  const lastAnswer = { answer: fresh.answer ?? null, confidence, note: fresh.note ?? "" };
  if (previous.pass === true && fresh.pass === false) {
    if (confidence >= thresholds.regressConfidence || previous.wobble) return { ...fresh, wobble: false, stuck: false };
    return { ...previous, wobble: true, carried: true, stuck: false, lastAnswer, reason: "" };
  }
  if (confidence >= thresholds.flipConfidence) return { ...fresh, wobble: false, stuck: false };
  return { ...previous, wobble: false, carried: true, stuck: hedged, lastAnswer };
}

/**
 * The board as a card can read it. `total`/`passing`/`unmeasured` count everything, as they
 * always have; `planned*` counts only the checks the plan and the harness wrote and `grown*`
 * only the questions a judge grew from its own defect list. They are two different things: mixed,
 * a part whose nine planned checks all pass reads "1 of 10" because the judge grew a question
 * about a number no camera can see. The screen says "Passed 3 ·
 * Failed 2 · Couldn't measure 4 · 3 judge notes" off these fields. A harness-owned check that
 * does not apply to this build (loop/applies-to-build.ts) is in none of those counts; identity
 * still reads the whole board, so it never turns an unanswerable board into a satisfied one.
 */
export function summarizeScoreboard(
  board: Scoreboard | null | undefined,
  spec: { checks?: readonly Check[] } | null | undefined,
) {
  const all = Object.values(board ?? {});
  const entries = all.filter((e) => appliesToBuild(e, spec));
  const identity = all.filter((e) => e.weight === Weight.Identity);
  const measuredPass = (e: CheckResult): boolean => e.pass === true;
  // The board entry carries `origin` only where the loop seeded it; the spec is the authority.
  const grownIds = new Set((spec?.checks ?? []).filter((c) => c?.origin === Origin.Judge).map((c) => c.id));
  const isGrown = (e: CheckResult): boolean => e.origin === Origin.Judge || grownIds.has(e.id);
  // "Nobody could look" is not "nobody looked": a check the BUILD cannot answer — inspect()
  // unavailable, a state field the game does not report, an optional demo it never registered —
  // carries `unavailable`. It never counts as passing, and at identity weight it never blocks
  // `satisfied` either; a board whose identity checks are ALL unanswerable still does.
  const unanswerable = (e: CheckResult): boolean => e.unavailable === true && !isMeasured(e);
  // A judge's guess failed nothing it could see: it reads as couldn't measure, never as failing.
  const couldNotTell = (e: CheckResult): boolean => !isMeasured(e) || guessed(e);
  const identityCounted = identity.filter((e) => !unanswerable(e));
  // The card's identity ratio, from this build's questions; identityAllPass reads them all.
  const identityApplying = entries.filter((e) => e.weight === Weight.Identity);
  const planned = entries.filter((e) => !isGrown(e));
  const grown = entries.filter(isGrown);
  return {
    total: entries.length,
    passing: entries.filter(measuredPass).length,
    unmeasured: entries.filter(couldNotTell).length,
    plannedTotal: planned.length,
    plannedPassing: planned.filter(measuredPass).length,
    plannedUnmeasured: planned.filter((e) => !isMeasured(e)).length,
    grownTotal: grown.length,
    grownPassing: grown.filter(measuredPass).length,
    identityTotal: identityApplying.length,
    identityPassing: identityApplying.filter(measuredPass).length,
    identityAllPass: identityAllPass(identity, identityCounted, entries, spec),
    failing: entries
      .filter((e) => e.pass === false && !guessed(e))
      .map((e) => ({ id: e.id, kind: e.kind, weight: e.weight, reason: e.reason })),
    unmeasuredChecks: entries
      .filter(couldNotTell)
      .map((e) => ({ id: e.id, kind: e.kind, weight: e.weight, reason: e.reason })),
  };
}

/**
 * A vision check failed only on an answer below the guessing line (`VISION_STUCK_CONFIDENCE`):
 * golden-boot-glory ended with six such checks listed as failing at confidence 0.20–0.40.
 */
function guessed(entry: CheckResult): boolean {
  const unsure = typeof entry.confidence === "number" && entry.confidence < VISION_STUCK_CONFIDENCE;
  return entry.kind === Kind.Vision && entry.pass === false && unsure;
}

/**
 * Unmeasured never counts as passing: an identity check nobody looked at blocks "satisfied",
 * unless the build itself cannot answer it — and then only while at least one other identity
 * check was measured. A board with no identity checks needs every check to pass, and a spec
 * with no checks at all is never done this way.
 */
function identityAllPass(
  identity: CheckResult[],
  identityCounted: CheckResult[],
  entries: CheckResult[],
  spec: { checks?: readonly Check[] } | null | undefined,
): boolean {
  const passed = (e: CheckResult): boolean => e.pass === true;
  if (identity.length > 0) return identityCounted.length > 0 && identityCounted.every(passed);
  if ((spec?.checks?.length ?? 0) > 0) return entries.every(passed);
  return false;
}

/** What a board adds up to, as cards and briefs read it. */
export type BoardSummary = ReturnType<typeof summarizeScoreboard>;

/** A result's mark on a rendered board. */
function boardMark(entry: CheckResult): string {
  if (entry.pass === true) return "PASS";
  if (entry.pass === false) return "FAIL";
  return "UNMEASURED";
}

/** What moved, as a suffix on a rendered board line. */
function boardTag(id: string, comparison: { flips?: string[]; regressions?: string[] } | null): string {
  if (comparison?.flips?.includes(id)) return " (flipped to pass)";
  if (comparison?.regressions?.includes(id)) return " (REGRESSED)";
  return "";
}

/**
 * One line per check, for briefs, reports and the chat feed. Given the spec, only this build's
 * questions (loop/applies-to-build.ts): a harness check the build cannot answer is no line.
 */
export function renderScoreboard(
  board: Scoreboard | null | undefined,
  comparison: { flips?: string[]; regressions?: string[] } | null = null,
  spec?: { checks?: readonly Check[] } | null,
): string {
  const lines: string[] = [];
  const entries = Object.values(board ?? {}).filter((e) => !spec || appliesToBuild(e, spec));
  for (const entry of entries) {
    const value =
      entry.kind === Kind.Metric && typeof entry.value === "number"
        ? ` = ${entry.value.toFixed(3)}${entry.nearest ? ` (nearest still: ${entry.nearest})` : ""}`
        : "";
    const weight = entry.weight === Weight.Identity ? ", identity" : "";
    const reason = entry.pass === true ? "" : `: ${clipMarked(entry.reason, BOARD_REASON_CHARS)}`;
    lines.push(
      `- [${boardMark(entry)}] ${entry.id} (${entry.kind}${weight})${value}${boardTag(entry.id, comparison)}${reason}`,
    );
  }
  return lines.join("\n");
}

/** Every camera the incumbent and challenger both captured reads as unchanged. */
export function isInvisibleDiff(diffs: Record<string, CameraDiff | null | undefined> | null | undefined): boolean {
  const values = Object.values(diffs ?? {}).filter(
    (d): d is CameraDiff & { diffFraction: number } =>
      Boolean(d) && typeof d?.diffFraction === "number" && (d.compared as number) > 0,
  );
  if (values.length === 0) return false;
  return values.every((d) => d.diffFraction < INVISIBLE_DIFF_FRACTION);
}
