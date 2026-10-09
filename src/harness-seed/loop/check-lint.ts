/**
 * What a check is allowed to measure — decided from its parsed expression, never from its words.
 *
 * A check rewards whatever makes it pass. `hud-rich: len(hud.items) >= 60` rewards drawing the HUD
 * out of thousands of rectangles: the count goes up, the game a player sees does not get better,
 * and the oversized state() it leaves behind blinds every other probe. How much the build draws
 * is an implementation detail: it may
 * be bounded from above (a draw-call or triangle budget) or asked to exist (`> 0`, `>= 1`), never
 * asked to be large. The lint runs where checks are validated — never where they are evaluated —
 * so a board stored before a seed upgrade still scores the way it did.
 */
import { parseExpr, type ExprNode } from "./checks.ts";
import type { CheckKind } from "./spec.ts";

/** Why the lint refused a check. Plans and problem lists keep these values: never rename one. */
export const CheckLintCode = {
  DrawCountFloor: "draw-count-floor",
} as const;
export type CheckLintCode = (typeof CheckLintCode)[keyof typeof CheckLintCode];

/**
 * The state paths that count what the build draws: the template HUD's item list and count, and
 * the page's renderer counters (under `__render`, and the top-level copies the shim fills in).
 */
export const STUDIO_DRAW_QUANTITIES = [
  "hud.items",
  "hud.count",
  "__render.drawCalls",
  "__render.triangles",
  "__render.vertices",
  "drawCalls",
  "triangles",
  "vertices",
] as const;

/**
 * The template HUD summary's counts per item kind (`hud.kinds.bar`): how much of one kind the
 * build draws, so `hud.kinds.bar >= 40` is the three-thousand-rectangle HUD again. The object
 * itself is not one: `len(hud.kinds)` counts which kinds are used, bounded by the kind vocabulary.
 */
const HUD_KINDS = "hud.kinds";

/** The most a bound may ask of a draw quantity and still only ask that the thing exists. */
const EXISTENCE_FLOOR = 1;

/**
 * The members of spec.ts's CheckKind this module reads. spec.ts imports this module (it lints at
 * validation), so the object cannot be imported back without a cycle; `satisfies` holds each
 * value to the vocabulary's own type, as checks.ts does.
 */
const Kind = {
  Pixel: "pixel",
  Metric: "metric",
  Probe: "probe",
  Demo: "demo",
} as const satisfies Record<string, CheckKind>;

/** The kinds whose check is a parsed expression the lint can read. */
const LINTED_KINDS: ReadonlySet<string> = new Set(Object.values(Kind));

/** A demo check's expression when it only says "the demo ran to its end". */
const DEMO_RAN = "ok";

/** The metric goal under which a larger number is a better build. */
const GOAL_MORE = "max";

/** The probe scope's alias for the state itself, and the early state's prefix. */
const SCOPE_PREFIXES = /^(?:state\.|early\.)/;

/** A list's length as the probe scope resolves it: `hud.items.length` is `len(hud.items)`. */
const LENGTH_SUFFIX = /\.length$/;

/** A path that names one element of a list by its index: `hud.items.59`. */
const INDEXED = /^(.+)\.(\d+)$/;

/** What the lint refused, and the sentence the author is told. */
export interface CheckLintFinding {
  code: CheckLintCode;
  quantity: string;
  message: string;
}

/** The sentence an author reads beside the refusal; the problem list names the check before it. */
const MESSAGE = {
  drawCountFloor: (quantity: string) =>
    `a floor on how much the build draws measures the implementation, not what a player sees (${quantity}) — bound it from above, check that it exists (> 0), or ask about the outcome`,
} as const;

/**
 * Whether `quantity <op> n` asks for more than that the thing exists: `> 0` and `>= 1` (and
 * `== 1`) only ask that it is there; `> 1`, `>= 2` and `== 60` ask for an amount. Upper bounds
 * and `!=` ask for no amount at all.
 */
const ASKS_AN_AMOUNT: Readonly<Record<string, (n: number) => boolean>> = {
  ">": (n) => n >= EXISTENCE_FLOOR,
  ">=": (n) => n > EXISTENCE_FLOOR,
  "==": (n) => n > EXISTENCE_FLOOR,
};

/** The comparison read from the other side: `60 <= x` is `x >= 60`. */
const MIRRORED: Readonly<Record<string, string>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

/** The comparison a `!` in front of it means: `!(x < 60)` is `x >= 60`. */
const NEGATED: Readonly<Record<string, string>> = {
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
  "==": "!=",
  "!=": "==",
};

/**
 * A path as the scope resolves it: `state.hud.items`, `hud.items` and (for the count it asks
 * about) `hud.items.length` are one quantity.
 */
const bare = (path: string): string => path.replace(SCOPE_PREFIXES, "").replace(LENGTH_SUFFIX, "");

const isDrawQuantity = (path: string): boolean => {
  const quantity = bare(path);
  return (STUDIO_DRAW_QUANTITIES as readonly string[]).includes(quantity) || isHudKindCount(quantity);
};

/** Whether a bare path is one of the HUD's per-kind counts (`hud.kinds.bar`). */
const isHudKindCount = (quantity: string): boolean =>
  quantity.startsWith(`${HUD_KINDS}.`) && !quantity.slice(HUD_KINDS.length + 1).includes(".");

/** The draw quantity a `min`/`max` of it and numbers reads — `max(len(hud.items), 0)` — or null. */
function clampedQuantity(args: readonly ExprNode[]): string | null {
  const quantities = args.map(quantityOf).filter((q): q is string => q !== null);
  const numbers = args.filter((arg) => numberOf(arg) !== null);
  const onlyOne = quantities.length === 1 && quantities.length + numbers.length === args.length;
  return onlyOne ? (quantities[0] ?? null) : null;
}

/**
 * The draw quantity a node reads directly — `x`, `x.length`, `len(x)`, `delta('x')`, or `abs`,
 * `min` or `max` of one — or null.
 */
function quantityOf(node: ExprNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "ref") return isDrawQuantity(node.path) ? bare(node.path) : null;
  if (node.type !== "call") return null;
  if (node.name === "min" || node.name === "max") return clampedQuantity(node.args);
  if (node.args.length !== 1) return null;
  const [arg] = node.args;
  if (node.name === "len" || node.name === "abs") return quantityOf(arg);
  const literalPath = node.name === "delta" && arg?.type === "literal" && typeof arg.value === "string";
  return literalPath && isDrawQuantity(String(arg.value)) ? bare(String(arg.value)) : null;
}

/**
 * The draw quantity a `has('x.<n>')` asks to hold more than n elements of, or null: index 0
 * only asks that the list is not empty; index 59 asks for sixty.
 */
function indexFloor(node: Extract<ExprNode, { type: "call" }>): string | null {
  const [arg] = node.args;
  const literal = node.name === "has" && node.args.length === 1 && arg?.type === "literal";
  if (!literal || typeof arg.value !== "string") return null;
  const [, list, index] = INDEXED.exec(arg.value.replace(SCOPE_PREFIXES, "")) ?? [];
  if (!list || !index || !isDrawQuantity(list)) return null;
  return Number(index) + 1 > EXISTENCE_FLOOR ? bare(list) : null;
}

/** A number written as a literal (or a negated one), else null. */
function numberOf(node: ExprNode | undefined): number | null {
  if (node?.type === "literal" && typeof node.value === "number") return node.value;
  if (node?.type !== "neg") return null;
  const inner = numberOf(node.operand);
  return inner === null ? null : -inner;
}

/** The quantity a comparison asks for an amount of, read whichever side the number is on, or null. */
function floorIn(op: string, left: ExprNode, right: ExprNode): string | null {
  const leftQuantity = quantityOf(left);
  const quantity = leftQuantity ?? quantityOf(right);
  if (!quantity) return null;
  const bound = numberOf(leftQuantity ? right : left);
  const asWritten = leftQuantity ? op : MIRRORED[op];
  if (bound === null || !asWritten) return null;
  return ASKS_AN_AMOUNT[asWritten]?.(bound) === true ? quantity : null;
}

/**
 * The quantity an `x in [a, b]` asks for an amount of, or null. Under `!` a two-number range is
 * ruled out: `!(x in [0, 59])` leaves only x > 59, a floor, while a range that starts above zero
 * still lets x fall below it and so asks for no amount.
 */
function floorInRange(left: ExprNode, items: readonly ExprNode[], negated: boolean): string | null {
  const quantity = quantityOf(left);
  if (!quantity) return null;
  const bounds = items.map(numberOf).filter((b): b is number => b !== null);
  if (bounds.length === 0 || bounds.length !== items.length) return null;
  if (!negated) return Math.min(...bounds) > EXISTENCE_FLOOR ? quantity : null;
  const onlyAbove = bounds.length === 2 && Math.min(...bounds) <= 0;
  return onlyAbove && ASKS_AN_AMOUNT[">"]?.(Math.max(...bounds)) === true ? quantity : null;
}

/** The first draw quantity anywhere in the expression that is asked for an amount, or null. */
function floorAnywhere(node: ExprNode, negated: boolean): string | null {
  switch (node.type) {
    case "cmp": {
      const op = negated ? NEGATED[node.op] : node.op;
      return op ? floorIn(op, node.left, node.right) : null;
    }
    case "in":
      return floorInRange(node.left, node.items, negated);
    case "call":
      return negated ? null : indexFloor(node);
    case "not":
      return floorAnywhere(node.operand, !negated);
    case "and":
    case "or":
      return floorAnywhere(node.left, negated) ?? floorAnywhere(node.right, negated);
    default:
      return null;
  }
}

/** The check's expression as the lint reads it, or null for a kind or an expression it cannot read. */
function expressionOf(check: { kind?: unknown; expr?: unknown }): ExprNode | null {
  const kind = String(check.kind ?? "");
  if (!LINTED_KINDS.has(kind) || typeof check.expr !== "string") return null;
  if (kind === Kind.Demo && check.expr.trim() === DEMO_RAN) return null;
  try {
    return parseExpr(check.expr);
  } catch {
    // A check that does not parse is refused for that by validation, with its own reason.
    return null;
  }
}

/**
 * Why a check measures how much the build draws rather than what a player gets, or null for a
 * check the lint has nothing against. Pixel, probe, metric and demo expressions are read as
 * their parsed AST: a comparison or an `in` range that asks a draw quantity for more than its
 * existence is a floor, read the same whichever side the number is written on. A metric that
 * ratchets a draw quantity upward (`goal: "max"`) is the same floor without a number, and so is
 * `has('hud.items.59')`. Scene checks are JavaScript and are not read here, and neither is
 * arithmetic over a quantity (`len(hud.items) - 60 >= 0`): a deliberate detour, not a draft.
 */
export function lintCheck(
  check: { kind?: unknown; expr?: unknown; goal?: unknown } | null | undefined,
): CheckLintFinding | null {
  if (!check) return null;
  const ast = expressionOf(check);
  if (!ast) return null;
  const ratchetUp = check.kind === Kind.Metric && check.goal === GOAL_MORE ? quantityOf(ast) : null;
  const quantity = ratchetUp ?? floorAnywhere(ast, false);
  if (!quantity) return null;
  return { code: CheckLintCode.DrawCountFloor, quantity, message: MESSAGE.drawCountFloor(quantity) };
}
