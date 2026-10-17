/**
 * Checks Blueprint text against the node reference without Unreal, the way Epic's transpiler
 * (`blueprint_dsl.py`, UE 5.8) would build it: top-level forms, event and function entries, every
 * node type id, keyword and positional pins, execution continuations, bindings and scope, and the
 * transpiler's own shape rules. A node whose pins are not known yet is checked by name only and
 * reported as unverified, never as an error. Problems carry "did you mean" suggestions from the
 * same reference.
 */
import {
  type BlueprintDecl,
  dataInputs,
  dataOutputs,
  execOutputs,
  type FoundNode,
  GraphKind,
  type NodeLookup,
  type NodePins,
} from "./blueprint-reference.ts";
import {
  AtomKind,
  type BlueprintForm,
  type BlueprintList,
  BlueprintTextError,
  formSource,
  formText,
  isSymbol,
  lineOf,
  parseBlueprintText,
} from "./blueprint-text.ts";

/** What went wrong, by the rule Epic's transpiler would break. */
export const ProblemCode = {
  Syntax: "syntax",
  TopForm: "top-form",
  UnknownNode: "unknown-node",
  UnknownEvent: "unknown-event",
  KeyEvent: "key-event",
  FunctionGraph: "function-graph",
  FunctionParam: "function-param",
  UnknownPin: "unknown-pin",
  UnknownExecPin: "unknown-exec-pin",
  TooManyArgs: "too-many-args",
  Undefined: "undefined-variable",
  UnquotedPath: "unquoted-path",
  LiteralBind: "literal-bind",
  Rebind: "rebind",
  Shape: "shape",
  Unreachable: "unreachable",
  Unsupported: "unsupported",
} as const;
export type ProblemCode = (typeof ProblemCode)[keyof typeof ProblemCode];

/** An error stops the part; unverified means the pins were not known yet to check. */
export const Severity = { Error: "error", Unverified: "unverified" } as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export type BlueprintProblem = {
  code: ProblemCode;
  severity: Severity;
  message: string;
  blueprint: string;
  graph: string;
  line: number;
  form: string;
  suggestions: string[];
};

/** Text written to one graph of one Blueprint. */
export type GraphWrite = { blueprint: string; graph: string; text: string };

/** The graph Unreal keeps a Blueprint's construction script in; its entry node is ConstructionScript. */
export const CONSTRUCTION_GRAPH = "UserConstructionScript";
const CONSTRUCTION_ENTRY = "ConstructionScript";
const EVENT_PREFIX = "AddEvent|";
const CUSTOM_EVENT = "Custom|";
const KEY_EVENT_CATEGORY = "input|";
const MAX_SUGGESTIONS = 3;
const MIN_PREFIX = 4;

/** The DSL's own words: statements, operators and the switch aliases, as Epic lists them. */
const BINARY_OPS = new Set(["+", "-", "*", "/", "%", "xor", "==", "!=", "<", "<=", ">", ">=", "and", "or"]);
const RESERVED = new Set([
  "event",
  "fn",
  "bind",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "range",
  "while",
  "break",
  "switch",
  "select",
  "not",
  "neg",
  ...BINARY_OPS,
]);
const COMPONENT_ACCESS = new Set(["x", "y", "z", "pitch", "yaw", "roll", "location", "rotation", "scale"]);
const SWITCH_ALIASES: Record<string, string> = {
  int: "Utilities|FlowControl|Switch|SwitchonInt",
  string: "Utilities|FlowControl|Switch|SwitchonString",
  name: "Utilities|FlowControl|Switch|SwitchonName",
};

/** Whether an expression leaves a value: none (a literal), some, or unknown (pins not known). */
type Output = "none" | "some" | "unknown";

type Scope = { names: Set<string>; loose: boolean; loopDepth: number };

type Walk = {
  write: GraphWrite;
  lookup: NodeLookup;
  decl: BlueprintDecl | undefined;
  kind: GraphKind;
  problems: BlueprintProblem[];
};

const lower = (text: string) => text.toLowerCase();
const isList = (form: BlueprintForm | undefined): form is BlueprintList => form?.kind === "list";
const isLiteral = (form: BlueprintForm) => form.kind !== "list" && form.kind !== AtomKind.Symbol;
const isContinuation = (form: BlueprintForm | undefined): form is BlueprintList =>
  isList(form) && isSymbol(form.items[0]) && form.items[0].text.startsWith(":");
const wordOf = (form: BlueprintForm | undefined): string => {
  if (!form) return "";
  if (form.kind === "list") return formText(form);
  if (form.kind === AtomKind.Symbol || form.kind === AtomKind.String) return form.text;
  return String(form.value);
};
/** Epic's name for a continuation output: the pin name in snake case after an underscore. */
const continuationName = (pin: string) =>
  `_${
    pin
      .replace(/[^A-Za-z0-9]/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "out"
  }`;
const child = (scope: Scope, loop = false): Scope => ({
  names: new Set(scope.names),
  loose: scope.loose,
  loopDepth: scope.loopDepth + (loop ? 1 : 0),
});

function report(
  walk: Walk,
  code: ProblemCode,
  message: string,
  form: BlueprintForm,
  options: { severity?: Severity; suggestions?: string[] } = {},
) {
  walk.problems.push({
    code,
    severity: options.severity ?? Severity.Error,
    message,
    blueprint: walk.write.blueprint,
    graph: walk.write.graph,
    line: lineOf(walk.write.text, form.at),
    form: formText(form),
    suggestions: options.suggestions ?? [],
  });
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

const titleOf = (typeId: string) => typeId.slice(typeId.lastIndexOf("|") + 1);
const categoryOf = (typeId: string) => typeId.slice(0, Math.max(0, typeId.lastIndexOf("|")));
const bareTitle = (title: string) => lower(title.replace(/\(.*\)$/, ""));
const EVENT_WORDS = /^(event|receive|k2_|on)/;
const eventCore = (title: string) => bareTitle(title).replace(EVENT_WORDS, "");

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** The lower-case words of a camel-case or `|`-separated name. */
const wordsOf = (text: string) =>
  new Set(
    text
      .replace(/\(.*\)$/, "")
      .split(/[|\s_]+|(?<=[a-z0-9])(?=[A-Z])/)
      .filter(Boolean)
      .map(lower),
  );

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared;
}

/** How close a title is on its own; 0 is not at all. */
function titleCloseness(title: string, other: string, sameCategory: boolean): number {
  if (lower(title) === lower(other)) return 100;
  const [bare, otherBare] = [bareTitle(title), bareTitle(other)];
  if (bare === otherBare) return 95;
  if (eventCore(title).length >= MIN_PREFIX && eventCore(title) === eventCore(other)) return 90;
  const prefix = commonPrefix(bare, otherBare);
  if (sameCategory && prefix >= Math.min(MIN_PREFIX, bare.length)) return Math.min(89, 60 + prefix);
  const [words, otherWords] = [wordsOf(title), wordsOf(other)];
  const jaccard = overlap(words, otherWords) / new Set([...words, ...otherWords]).size;
  if (jaccard >= 0.5) return 40 + Math.round(40 * jaccard);
  if (bare.length > MIN_PREFIX && otherBare.includes(bare)) return 50;
  return 0;
}

/** How close a known type id is to the one asked for: its title first, then how alike the categories are. */
function closeness(wanted: string, candidate: string): number {
  const [category, otherCategory] = [categoryOf(wanted), categoryOf(candidate)];
  const sameCategory = lower(category) === lower(otherCategory);
  const score = titleCloseness(titleOf(wanted), titleOf(candidate), sameCategory);
  if (!score) return 0;
  return score + (sameCategory ? 5 : 2 * overlap(wordsOf(category), wordsOf(otherCategory)));
}

/** Up to three known type ids closest to `typeId`. */
export function suggestNodes(typeId: string, names: readonly string[]): string[] {
  const scored: [number, string][] = [];
  for (const name of names) {
    const score = closeness(typeId, name);
    if (score > 0) scored.push([score, name]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
  return scored.slice(0, MAX_SUGGESTIONS).map(([, name]) => name);
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** A bare word used as a value: it must be bound, and a path must be quoted. */
function checkSymbolValue(walk: Walk, form: BlueprintForm & { kind: "symbol" }, scope: Scope): Output {
  if (scope.names.has(form.text)) return "some";
  if (form.text.startsWith("/")) {
    report(
      walk,
      ProblemCode.UnquotedPath,
      `"${form.text}" looks like a class path or asset reference and must be a quoted string`,
      form,
    );
    return "unknown";
  }
  const severity = scope.loose ? Severity.Unverified : Severity.Error;
  const available = [...scope.names].filter((name) => !name.startsWith("_"));
  report(
    walk,
    ProblemCode.Undefined,
    `Undefined variable "${form.text}". Available: ${available.join(", ") || "none"}`,
    form,
    { severity },
  );
  return "unknown";
}

function checkExpr(walk: Walk, form: BlueprintForm, scope: Scope): Output {
  if (isLiteral(form)) return "none";
  if (isSymbol(form)) return checkSymbolValue(walk, form, scope);
  if (!isList(form)) return "unknown";
  const head = form.items[0];
  if (!head) {
    report(walk, ProblemCode.Shape, "Empty expression ()", form);
    return "unknown";
  }
  if (!isSymbol(head)) return checkCall(walk, form, scope).output;
  if (head.text.startsWith(".")) return checkComponentAccess(walk, form, scope);
  const arity = OPERATOR_ARITY[head.text];
  if (arity !== undefined || BINARY_OPS.has(head.text)) return checkOperator(walk, form, scope);
  return checkCall(walk, form, scope).output;
}

/** Arguments each built-in operator form takes; binary operators take two (`-` also one). */
const OPERATOR_ARITY: Record<string, number> = { select: 3, not: 1, neg: 1 };

function checkOperator(walk: Walk, form: BlueprintList, scope: Scope): Output {
  const op = wordOf(form.items[0]);
  const args = form.items.slice(1);
  const arity = OPERATOR_ARITY[op] ?? 2;
  const unaryMinus = op === "-" && args.length === 1;
  if (args.length !== arity && !unaryMinus) {
    report(
      walk,
      ProblemCode.Shape,
      `(${op} ...) requires exactly ${arity} argument${arity === 1 ? "" : "s"}, got ${args.length}`,
      form,
    );
  }
  for (const arg of args) checkExpr(walk, arg, scope);
  return "some";
}

function checkComponentAccess(walk: Walk, form: BlueprintList, scope: Scope): Output {
  const attr = wordOf(form.items[0]).slice(1);
  if (!COMPONENT_ACCESS.has(attr)) {
    report(
      walk,
      ProblemCode.Unsupported,
      `Unsupported component ".${attr}". Supported: ${[...COMPONENT_ACCESS].join(", ")}`,
      form,
    );
  }
  const source = form.items[1];
  if (source) checkExpr(walk, source, scope);
  return "some";
}

type CallArgs = {
  positional: BlueprintForm[];
  keywords: [string, BlueprintForm, BlueprintForm][];
  continuations: BlueprintList[];
};

/** Reads the `:Pin value` keyword at `i` into `args`; returns the index of its value. */
function readKeyword(walk: Walk, form: BlueprintList, i: number, typeId: string, args: CallArgs): number {
  const arg = form.items[i] as BlueprintForm & { kind: "symbol" };
  const pin = arg.text.slice(1);
  const value = form.items[i + 1];
  if (!value) report(walk, ProblemCode.Shape, `Keyword :${pin} has no value in (${typeId} ...)`, arg);
  else if (args.keywords.some(([seen]) => seen === pin))
    report(walk, ProblemCode.Shape, `Duplicate keyword argument :${pin} in (${typeId} ...)`, arg);
  else args.keywords.push([pin, value, arg]);
  return i + 1;
}

/** Splits a call's arguments the way `_create_call_node` does, reporting what it refuses. */
function splitCallArgs(walk: Walk, form: BlueprintList, typeId: string): CallArgs {
  const args: CallArgs = { positional: [], keywords: [], continuations: [] };
  for (let i = 1; i < form.items.length; i++) {
    const arg = form.items[i] as BlueprintForm;
    if (isContinuation(arg)) {
      args.continuations.push(arg);
      continue;
    }
    if (isSymbol(arg) && arg.text.startsWith(":")) {
      i = readKeyword(walk, form, i, typeId, args);
      continue;
    }
    if (args.keywords.length || args.continuations.length) {
      const message = `Positional arg after keyword arg or exec continuation in (${typeId} ...)`;
      report(walk, ProblemCode.Shape, message, arg);
    }
    args.positional.push(arg);
  }
  return args;
}

/** Whether a node the reference doesn't have may come from the game's C++: then it is unverified. */
const mayBeNative = (walk: Walk, typeId: string) => walk.lookup.unverifiable?.(typeId) === true;

/** The node a call names, reporting an unknown one with the closest known names. */
function findNode(walk: Walk, typeId: string, at: BlueprintForm): FoundNode | undefined {
  const found = walk.lookup.find(typeId);
  if (found) return found;
  const suggestions = suggestNodes(typeId, walk.lookup.names());
  const hint = suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : "";
  if (mayBeNative(walk, typeId)) {
    const message = `${typeId} isn't in the node reference; it may come from the game's C++, so the editor checks it.${hint}`;
    report(walk, ProblemCode.UnknownNode, message, at, { suggestions, severity: Severity.Unverified });
    return undefined;
  }
  report(walk, ProblemCode.UnknownNode, `${typeId} does not exist in this graph.${hint}`, at, { suggestions });
  return undefined;
}

function checkPinNames(walk: Walk, typeId: string, pins: NodePins, args: CallArgs) {
  const inputs = dataInputs(pins).map(([name]) => name);
  if (args.positional.length > inputs.length) {
    const at = args.positional[inputs.length] as BlueprintForm;
    report(
      walk,
      ProblemCode.TooManyArgs,
      `${typeId} received ${args.positional.length} positional arg(s) but has ${inputs.length} data input pin(s). Available: ${inputs.join(", ")}`,
      at,
    );
  }
  for (const [pin, , at] of args.keywords) {
    if (inputs.includes(pin)) continue;
    const near = inputs.filter(
      (name) => lower(name) === lower(pin) || lower(name).endsWith(lower(pin)) || lower(pin).endsWith(lower(name)),
    );
    const outputs = dataOutputs(pins).map(([name]) => name);
    const hint = near.length ? ` Did you mean ${near.join(", ")}?` : "";
    report(
      walk,
      ProblemCode.UnknownPin,
      `Unknown input pin "${pin}" on ${typeId}. Input pins: ${inputs.join(", ") || "none"}. Output pins: ${outputs.join(", ") || "none"}.${hint}`,
      at,
      { suggestions: near },
    );
  }
  const execs = execOutputs(pins).map(([name]) => name);
  for (const continuation of args.continuations) {
    const name = wordOf(continuation.items[0]).slice(1);
    if (execs.includes(name)) continue;
    report(
      walk,
      ProblemCode.UnknownExecPin,
      `Unknown exec output "${name}" on ${typeId}. Available: ${execs.join(", ") || "none"}`,
      continuation,
    );
  }
}

/** A node call: its arguments, its node, its pins, then its continuations in their own scope. */
function checkCall(
  walk: Walk,
  form: BlueprintList,
  scope: Scope,
  bindName?: string,
): { output: Output; terminates: boolean; outputs?: number } {
  const head = form.items[0] as BlueprintForm;
  const typeId = wordOf(head);
  const args = splitCallArgs(walk, form, typeId);
  for (const arg of args.positional) checkExpr(walk, arg, scope);
  for (const [, value] of args.keywords) checkExpr(walk, value, scope);
  const node = findNode(walk, typeId, head);
  if (node?.pins) checkPinNames(walk, node.typeId, node.pins, args);
  const outputs = node?.pins ? dataOutputs(node.pins) : undefined;
  if (args.continuations.length) checkContinuations(walk, args.continuations, scope, outputs, bindName);
  let output: Output = "unknown";
  if (outputs) output = outputs.length ? "some" : "none";
  return { output, terminates: args.continuations.length > 0, outputs: outputs?.length };
}

function checkContinuations(
  walk: Walk,
  continuations: BlueprintList[],
  scope: Scope,
  outputs: NodePins["outputs"] | undefined,
  bindName: string | undefined,
) {
  const inner = child(scope);
  if (!outputs) inner.loose = true;
  for (const [pin] of outputs ?? []) inner.names.add(continuationName(pin));
  if (bindName) inner.names.add(bindName);
  for (const continuation of continuations) checkStatements(walk, continuation.items.slice(1), child(inner));
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** Checks statements in order; returns whether the flow ended (return, switch, multi-exec call). */
function checkStatements(walk: Walk, statements: BlueprintForm[], scope: Scope): boolean {
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i] as BlueprintForm;
    const ended = checkStatement(walk, statement, scope);
    const next = statements[i + 1];
    if (ended && next) {
      report(walk, ProblemCode.Unreachable, `Unreachable code after branch/return: ${formText(next)}`, next);
      return true;
    }
    if (ended) return true;
  }
  return false;
}

const STATEMENTS: Record<string, (walk: Walk, form: BlueprintList, scope: Scope) => boolean> = {
  bind: checkBind,
  return: checkReturn,
  if: checkIf,
  for: checkFor,
  while: checkWhile,
  switch: checkSwitch,
  break: (walk, form, scope) => {
    if (!scope.loopDepth) report(walk, ProblemCode.Shape, "(break) used outside a breakable loop", form);
    return true;
  },
};

function checkStatement(walk: Walk, statement: BlueprintForm, scope: Scope): boolean {
  if (!isList(statement) || !statement.items.length) {
    report(walk, ProblemCode.Shape, `Statement must be a list, got: ${formText(statement)}`, statement);
    return false;
  }
  const head = statement.items[0] as BlueprintForm;
  const word = isSymbol(head) ? head.text : "";
  if (word === "elif" || word === "else") {
    report(
      walk,
      ProblemCode.Shape,
      `(${word}) must be the last form inside an (if) or (elif) body; it is the else branch, not a statement after it`,
      statement,
    );
    return false;
  }
  const handler = STATEMENTS[word];
  if (handler) return handler(walk, statement, scope);
  return checkCall(walk, statement, scope).terminates;
}

function checkBind(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  const [, target, value, ...extra] = form.items;
  if (!target || !value) {
    report(walk, ProblemCode.Shape, "(bind) requires a target and an expression", form);
    return false;
  }
  if (extra.length) return checkBindWithContinuations(walk, form, scope);
  if (isList(target)) return checkMultiBind(walk, form, target, value, scope);
  const name = wordOf(target);
  if (scope.names.has(name)) {
    report(
      walk,
      ProblemCode.Rebind,
      `(bind) cannot rebind '${name}': it is already bound. Use a different name.`,
      form,
    );
  }
  if (checkExpr(walk, value, scope) === "none") {
    report(
      walk,
      ProblemCode.LiteralBind,
      `(bind ${name} ...) expression produced no output pin. Use a node call expression, not a literal; pass literals straight to the pin.`,
      form,
    );
  }
  scope.names.add(name);
  return false;
}

function checkBindWithContinuations(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  const [, target, value, ...extra] = form.items as BlueprintForm[];
  if (extra.some((item) => !isContinuation(item))) {
    report(walk, ProblemCode.Shape, "(bind) expects only exec continuations after the expression", form);
  }
  if (isList(target))
    report(
      walk,
      ProblemCode.Shape,
      "(bind (a b) ...) with exec continuations is not supported. Use a single name.",
      form,
    );
  if (!isList(value)) {
    report(walk, ProblemCode.Shape, `(bind ${wordOf(target)} ...) with exec continuations requires a node call`, form);
    return false;
  }
  const combined: BlueprintList = { kind: "list", at: value.at, items: [...value.items, ...extra] };
  return checkCall(walk, combined, scope, wordOf(target)).terminates;
}

function checkMultiBind(
  walk: Walk,
  form: BlueprintList,
  target: BlueprintList,
  value: BlueprintForm,
  scope: Scope,
): boolean {
  if (!isList(value)) {
    report(walk, ProblemCode.Shape, "Multi-output bind requires a node call", form);
    return false;
  }
  const names = target.items.map(wordOf);
  const already = names.filter((name) => scope.names.has(name));
  if (already.length)
    report(walk, ProblemCode.Rebind, `(bind) cannot rebind already-bound name(s): ${already.join(", ")}`, form);
  const call = checkCall(walk, value, scope);
  if (call.outputs !== undefined && names.length > call.outputs) {
    report(
      walk,
      ProblemCode.Shape,
      `Multi-output bind has ${names.length} target(s) but the node has ${call.outputs} data output pin(s)`,
      form,
    );
  }
  for (const name of names) scope.names.add(name);
  return call.terminates;
}

function checkReturn(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  for (const value of form.items.slice(1)) checkExpr(walk, value, scope);
  const outputs = walk.decl?.functions.find((fn) => lower(fn.name) === lower(walk.write.graph))?.outputs;
  const count = form.items.length - 1;
  if (walk.kind === GraphKind.Function && outputs && count > outputs.length) {
    report(
      walk,
      ProblemCode.Shape,
      `(return) has ${count} value(s) but the function has ${outputs.length} return pin(s)`,
      form,
    );
  }
  return true;
}

/** The branches of an (if): its then statements and its else part, as `_process_if` splits them. */
function ifParts(form: BlueprintList): { body: BlueprintForm[]; elseForm?: BlueprintList } {
  const body = form.items.slice(2);
  const last = body.at(-1);
  if (isList(last) && (isSymbol(last.items[0], "else") || isSymbol(last.items[0], "elif"))) {
    return { body: body.slice(0, -1), elseForm: last };
  }
  return { body };
}

function checkIf(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  const condition = form.items[1];
  if (!condition) {
    report(walk, ProblemCode.Shape, `(${wordOf(form.items[0])}) requires a condition`, form);
    return false;
  }
  checkExpr(walk, condition, scope);
  const { body, elseForm } = ifParts(form);
  const thenEnds = checkStatements(walk, body, child(scope));
  if (!elseForm) return false;
  const elseEnds = isSymbol(elseForm.items[0], "else")
    ? checkStatements(walk, elseForm.items.slice(1), child(scope))
    : checkIf(walk, elseForm, child(scope));
  return thenEnds && elseEnds;
}

function checkFor(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  const [, variable, iterable, ...body] = form.items;
  if (!variable || !iterable) {
    report(walk, ProblemCode.Shape, "(for) requires a variable and an iterable", form);
    return false;
  }
  const isRange = isList(iterable) && isSymbol(iterable.items[0], "range");
  if (isRange) {
    const bounds = iterable.items.slice(1);
    if (bounds.length < 1 || bounds.length > 2)
      report(walk, ProblemCode.Shape, `(range) takes 1 or 2 args, got ${bounds.length}`, iterable);
    for (const bound of bounds) checkExpr(walk, bound, scope);
  } else {
    checkExpr(walk, iterable, scope);
  }
  const inner = child(scope, true);
  if (wordOf(variable) !== "_") inner.names.add(wordOf(variable));
  checkStatements(walk, body, inner);
  return false;
}

function checkWhile(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  const condition = form.items[1];
  if (!condition) {
    report(walk, ProblemCode.Shape, "(while) requires a condition", form);
    return false;
  }
  checkExpr(walk, condition, scope);
  checkStatements(walk, form.items.slice(2), child(scope, true));
  return false;
}

function checkSwitch(walk: Walk, form: BlueprintList, scope: Scope): boolean {
  const [, kind, value, ...cases] = form.items;
  if (!kind || !value) {
    report(walk, ProblemCode.Shape, "(switch) requires a node type id and a value", form);
    return true;
  }
  const typeId = SWITCH_ALIASES[wordOf(kind)] ?? wordOf(kind);
  if (/SwitchOn(String|Name)/i.test(typeId)) {
    report(
      walk,
      ProblemCode.Unsupported,
      "String and Name switch nodes are not supported by (switch); use (if) or an int switch",
      form,
    );
  } else {
    findNode(walk, typeId, kind);
  }
  checkExpr(walk, value, scope);
  for (const item of cases) {
    if (!isContinuation(item)) {
      report(
        walk,
        ProblemCode.Shape,
        `(switch) continuation must be (:CaseName stmts...), got: ${formText(item)}`,
        item,
      );
      continue;
    }
    checkStatements(walk, item.items.slice(1), child(scope));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Top-level forms
// ---------------------------------------------------------------------------

/** Whether an (event Name (...)) list is its parameter list: plain names, no type ids, no keywords. */
const isParamList = (form: BlueprintForm | undefined): form is BlueprintList =>
  isList(form) && form.items.every((item) => isSymbol(item) && !item.text.includes("|") && !RESERVED.has(item.text));

function entryScope(names: Iterable<string>, loose: boolean): Scope {
  return { names: new Set(["self", ...names]), loose, loopDepth: 0 };
}

/** An event's node must exist; a key's node is not an event the DSL can start from. */
function checkEventEntry(walk: Walk, name: string, at: BlueprintForm): FoundNode | undefined {
  if (name.startsWith(CUSTOM_EVENT)) return { typeId: `${EVENT_PREFIX}${name}` };
  const found = walk.lookup.find(`${EVENT_PREFIX}${name}`);
  if (found) return found;
  const key = walk.lookup.find(name);
  if (key && lower(key.typeId).startsWith(KEY_EVENT_CATEGORY)) {
    report(
      walk,
      ProblemCode.KeyEvent,
      `${key.typeId} is a key event node, which (event ...) cannot start from. Bind an Enhanced Input action, or poll the key in Tick.`,
      at,
    );
    return undefined;
  }
  const events = walk.lookup.names().filter((typeId) => typeId.startsWith(EVENT_PREFIX));
  const suggestions = suggestNodes(`${EVENT_PREFIX}${name}`, events).map((typeId) => typeId.slice(EVENT_PREFIX.length));
  const graphHint = walk.kind === GraphKind.Function ? " Events belong in the EventGraph." : "";
  const hint = suggestions.length ? ` Did you mean (event ${suggestions.join("), (event ")})?` : "";
  if (walk.kind === GraphKind.Event && mayBeNative(walk, `${EVENT_PREFIX}${name}`)) {
    const message = `AddEvent|${name} isn't in the node reference; it may come from the game's C++, so the editor checks it.${hint}`;
    report(walk, ProblemCode.UnknownEvent, message, at, { suggestions, severity: Severity.Unverified });
    return undefined;
  }
  report(walk, ProblemCode.UnknownEvent, `AddEvent|${name} does not exist.${graphHint}${hint}`, at, { suggestions });
  return undefined;
}

function checkEvent(walk: Walk, form: BlueprintList, name: string) {
  const params = isParamList(form.items[2]) ? form.items[2] : undefined;
  const body = form.items.slice(params ? 3 : 2);
  const entry = checkEventEntry(walk, name, form.items[1] as BlueprintForm);
  const pins = entry?.pins ? dataOutputs(entry.pins).map(([pin]) => pin) : undefined;
  const names = pins ?? params?.items.map(wordOf) ?? [];
  checkStatements(walk, body, entryScope(names, pins === undefined));
}

/** The entry a function form needs: the graph it is written to must be that function's own graph. */
function functionEntryProblem(walk: Walk, name: string): string | undefined {
  const graph = walk.write.graph;
  if (walk.kind === GraphKind.Event) {
    return `(fn ${name}) goes in its own function graph ${name}, not the EventGraph. Genex creates the graph when it applies the part.`;
  }
  if (graph === CONSTRUCTION_GRAPH) {
    return lower(name) === lower(CONSTRUCTION_ENTRY)
      ? undefined
      : `The construction script's entry is ${CONSTRUCTION_ENTRY}: write (fn ${CONSTRUCTION_ENTRY} () ...).`;
  }
  return lower(name) === lower(graph)
    ? undefined
    : `(fn ${name}) is written to graph ${graph}, whose entry is ${graph}.`;
}

function checkFunction(walk: Walk, form: BlueprintList, name: string) {
  const params = form.items[2];
  if (!isList(params)) {
    report(walk, ProblemCode.Shape, `(fn ${name} ...) requires a parameter list`, form);
    return;
  }
  const entryProblem = functionEntryProblem(walk, name);
  if (entryProblem) report(walk, ProblemCode.FunctionGraph, entryProblem, form.items[1] as BlueprintForm);
  const declared = walk.decl?.functions.find((fn) => lower(fn.name) === lower(name))?.inputs;
  const listed = params.items.map(wordOf);
  const missing = declared ? listed.filter((param) => !declared.includes(param)) : [];
  if (missing.length) {
    report(
      walk,
      ProblemCode.FunctionParam,
      `Function parameter(s) not found in graph: ${missing.join(", ")}. Declare them on ${name} first.`,
      params,
    );
  }
  checkStatements(walk, form.items.slice(3), entryScope(declared ?? listed, false));
}

function checkTopForm(walk: Walk, form: BlueprintForm) {
  if (!isList(form) || form.items.length < 2) {
    report(walk, ProblemCode.TopForm, `Top-level form must be (event ...) or (fn ...): ${formText(form)}`, form);
    return;
  }
  const head = form.items[0];
  const isEvent = isSymbol(head, "event");
  if (!isEvent && !isSymbol(head, "fn")) {
    report(
      walk,
      ProblemCode.TopForm,
      `Top-level form must start with "event" or "fn", got: ${formText(head as BlueprintForm)}`,
      form,
    );
    return;
  }
  const raw = wordOf(form.items[1]);
  const name = raw.startsWith(EVENT_PREFIX) ? raw.slice(EVENT_PREFIX.length) : raw;
  if (isEvent) checkEvent(walk, form, name);
  else checkFunction(walk, form, name);
}

/** The kind of graph a write goes to, by its name. */
export const graphKindOf = (graph: string): GraphKind =>
  graph === GraphKind.Event ? GraphKind.Event : GraphKind.Function;

/** Every problem Epic's transpiler would hit writing `write`, checked against `lookup`. */
export function checkGraphWrite(write: GraphWrite, lookup: NodeLookup, decl?: BlueprintDecl): BlueprintProblem[] {
  const walk: Walk = { write, lookup, decl, kind: graphKindOf(write.graph), problems: [] };
  let forms: BlueprintForm[];
  try {
    forms = parseBlueprintText(write.text);
  } catch (error) {
    if (!(error instanceof BlueprintTextError)) throw error;
    const at = { kind: AtomKind.Symbol, text: "", at: 0 } as const;
    walk.problems.push({
      code: ProblemCode.Syntax,
      severity: Severity.Error,
      message: error.message,
      blueprint: write.blueprint,
      graph: write.graph,
      line: error.line,
      form: formText(at),
      suggestions: [],
    });
    return walk.problems;
  }
  for (const form of forms) checkTopForm(walk, form);
  return walk.problems;
}

/**
 * One Blueprint's text split the way Genex applies it: each (fn Name ...) into its own function
 * graph Name, every other form into the EventGraph, in their order.
 */
export function splitByGraph(blueprint: string, text: string): GraphWrite[] {
  const forms = parseBlueprintText(text);
  const events: string[] = [];
  const writes: GraphWrite[] = [];
  for (const form of forms) {
    const source = isList(form) ? formSource(text, form.at) : wordOf(form);
    const isFunction = isList(form) && isSymbol(form.items[0], "fn") && form.items[1];
    if (isFunction) writes.push({ blueprint, graph: wordOf(form.items[1]), text: source });
    else events.push(source);
  }
  if (events.length) writes.unshift({ blueprint, graph: GraphKind.Event, text: events.join("\n\n") });
  return writes;
}
