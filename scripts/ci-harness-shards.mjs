import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

/** @typedef {{ id: number, names: string[], scoreboard: boolean }} HarnessShard */
/** @typedef {{ files: string[], roots: string[], shards: HarnessShard[] }} HarnessPlan */
/** @typedef {{ id: number, names: string[] }} SeedShard */
/** @typedef {{ files: string[], roots: string[], shards: SeedShard[] }} SeedPlan */

const HARNESS_SHARDS = 6;
const SEED_SHARDS = 3;
const SEED_UPGRADE = "tests/conformance/seed-upgrade.test.ts";
const SPLIT_INCIDENT_GROUP = "harness incidents";
const PREFIX_SEED_GROUP = "seed upgrade";
const INCIDENTS = "tests/conformance/harness-incidents.test.ts";
const SCOREBOARD = "tests/conformance/scoreboard.test.ts";
const REGISTRATIONS = new Set(["test", "it", "describe"]);
const HOOKS = new Set(["before", "after", "beforeEach", "afterEach"]);
const sorted = (values) => [...values].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function testBindings(source) {
  const bindings = new Map();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "node:test") continue;
    const clause = node.importClause;
    if (clause?.name) bindings.set(clause.name.text, "test");
    const names = clause?.namedBindings;
    if (names && !ts.isNamedImports(names)) throw new Error("Unsupported node:test namespace registration");
    for (const item of names?.elements ?? []) bindings.set(item.name.text, item.propertyName?.text ?? item.name.text);
  }
  return bindings;
}

function callBinding(call, bindings) {
  let expression = call.expression;
  while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
  if (!ts.isIdentifier(expression)) return undefined;
  return bindings.get(expression.text);
}

function rootRegistration(node, bindings) {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return undefined;
  const call = node.expression;
  const binding = callBinding(call, bindings);
  if (HOOKS.has(binding)) return undefined;
  if (!REGISTRATIONS.has(binding)) throw new Error("Unsupported top-level harness registration call");
  const name = call.arguments[0];
  const callback = call.arguments.at(-1);
  const directCallback = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback));
  if (!ts.isIdentifier(call.expression) || !name || !ts.isStringLiteralLike(name) || !name.text || !directCallback)
    throw new Error("Harness roots require literal names and direct callbacks without .only/.skip");
  return { name: name.text, weight: node.end - node.pos, node: call };
}

function validateBindingUse(node, bindings) {
  if (!ts.isIdentifier(node) || !REGISTRATIONS.has(bindings.get(node.text))) return;
  const propertyName =
    (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) && node.parent.name === node;
  if (propertyName) return;
  const imported = ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent);
  const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
  const method = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
  if (!imported && !called && !method) throw new Error("Aliased harness registration is unsupported");
}

function validateRegistrationUses(source, bindings, roots) {
  const insideRoot = (node) => roots.some((root) => node.pos >= root.node.pos && node.end <= root.node.end);
  const visit = (node) => {
    if (ts.isCallExpression(node) && REGISTRATIONS.has(callBinding(node, bindings))) {
      const only = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "only";
      if (only || !insideRoot(node)) throw new Error("Unsupported dynamic or exclusive harness registration");
    }
    validateBindingUse(node, bindings);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function readRoots(root, relative) {
  const file = path.join(root, relative);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error("Test registration file does not parse");
  const bindings = testBindings(source);
  const roots = source.statements.map((node) => rootRegistration(node, bindings)).filter(Boolean);
  if (!roots.length) throw new Error("Empty test root inventory");
  validateRegistrationUses(source, bindings, roots);
  return { roots, bindings };
}

function assertUnambiguous(values) {
  const names = sorted(values);
  for (let index = 1; index < names.length; index++) {
    const ambiguous = names
      .slice(0, index)
      .some((prior) => names[index] === prior || names[index].startsWith(`${prior} `));
    if (ambiguous) throw new Error(`Ambiguous test selector: ${names[index]}`);
  }
}

function directCase(statement, bindings, allowOnceHooks) {
  const call =
    ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined;
  const binding = call && callBinding(call, bindings);
  if (HOOKS.has(binding)) {
    const unsafe = !allowOnceHooks && binding !== "beforeEach" && binding !== "afterEach";
    if (unsafe) throw new Error("Partitioned suite cannot repeat once-only hooks");
    return undefined;
  }
  const child = rootRegistration(statement, bindings);
  if (!child || (binding !== "it" && binding !== "test"))
    throw new Error("Partitioned suite requires direct literal cases without shared setup");
  return child;
}

function directCases(parent, bindings, allowOnceHooks) {
  const callback = parent.node.arguments.at(-1);
  if (!callback.body || !ts.isBlock(callback.body)) throw new Error("Partitioned suite needs a block callback");
  const children = callback.body.statements
    .map((statement) => directCase(statement, bindings, allowOnceHooks))
    .filter(Boolean);
  if (!children.length) throw new Error("Empty partitioned suite inventory");
  return children.map((child) => ({ ...child, name: `${parent.name} ${child.name}` }));
}

/**
 * Finds complete incident subtrees, splitting only the known large group's independent cases.
 * @param {string} root
 * @returns {{ name: string, weight: number }[]}
 */
export function harnessRoots(root) {
  const { roots, bindings } = readRoots(root, INCIDENTS);
  const units = roots.flatMap((item) =>
    item.name === SPLIT_INCIDENT_GROUP ? directCases(item, bindings, false) : [item],
  );
  assertUnambiguous(units.map(({ name }) => name));
  return units.map(({ name, weight }) => ({ name, weight }));
}

function seedRoots(root) {
  const { roots, bindings } = readRoots(root, SEED_UPGRADE);
  const units = roots.map((item) => ({
    name: item.name,
    selectors:
      item.name === PREFIX_SEED_GROUP ? directCases(item, bindings, true).map(({ name }) => name) : [item.name],
  }));
  if (new Set(units.map(({ name }) => name)).size !== units.length) throw new Error("Ambiguous seed root names");
  assertUnambiguous(units.flatMap(({ selectors }) => selectors));
  return units;
}

/**
 * Escapes root names and matches their descendants through Node's full-name space separator.
 * @param {string[]} names
 * @returns {string}
 */
export function harnessPattern(names) {
  if (!Array.isArray(names) || !names.length) throw new Error("Empty harness name pattern");
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})(?: |$)`;
}

/**
 * Divides whole incident groups between isolated processes; scoreboard runs exactly once.
 * @param {string} root
 * @param {boolean} selected
 * @returns {HarnessPlan}
 */
export function createHarnessPlan(root, selected) {
  if (!selected) return { files: [], roots: [], shards: [] };
  const roots = harnessRoots(root);
  const count = Math.min(HARNESS_SHARDS, roots.length);
  const buckets = Array.from({ length: count }, (_, index) => ({ id: index + 1, names: [], weight: 0 }));
  for (const item of [...roots].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))) {
    const bucket = [...buckets].sort((a, b) => a.weight - b.weight || a.id - b.id)[0];
    bucket.names.push(item.name);
    bucket.weight += item.weight;
  }
  return {
    files: sorted([INCIDENTS, SCOREBOARD]),
    roots: sorted(roots.map(({ name }) => name)),
    shards: buckets.map(({ id, names }) => ({ id, names: sorted(names), scoreboard: id === 1 })),
  };
}

/**
 * Re-extracts the current inventory and rejects omissions, overlaps, ambiguous roots and empty workers.
 * @param {string} root
 * @param {unknown} plan
 */
export function validateHarnessPlan(root, plan) {
  if (!plan || !Array.isArray(plan.files) || !Array.isArray(plan.roots) || !Array.isArray(plan.shards))
    throw new Error("Invalid harness inventory");
  if (!plan.files.length) {
    if (plan.roots.length || plan.shards.length) throw new Error("Unselected harness contains assignments");
    return;
  }
  if (!same(plan.files, sorted([INCIDENTS, SCOREBOARD]))) throw new Error("Incomplete harness file inventory");
  const names = sorted(harnessRoots(root).map(({ name }) => name));
  if (!same(names, plan.roots)) throw new Error("Harness root inventory differs from current code");
  const count = Math.min(HARNESS_SHARDS, names.length);
  if (plan.shards.length !== count) throw new Error("Incomplete harness shards");
  const assigned = [];
  const ids = new Set();
  for (const shard of plan.shards) {
    const validId = Number.isInteger(shard.id) && shard.id > 0 && shard.id <= count && !ids.has(shard.id);
    if (!validId || !Array.isArray(shard.names) || !shard.names.length || shard.scoreboard !== (shard.id === 1))
      throw new Error("Invalid harness shard");
    ids.add(shard.id);
    assigned.push(...shard.names);
  }
  if (!same(sorted(assigned), names)) throw new Error("Incomplete or overlapping harness root assignments");
}

/**
 * Produces exact runner arguments, keeping incident descendants serial and scoreboard unfiltered.
 * @param {HarnessShard} shard
 * @returns {string[][]}
 */
export function harnessCommands(shard) {
  const commands = [["--test-concurrency=1", `--test-name-pattern=${harnessPattern(shard.names)}`, INCIDENTS]];
  if (shard.scoreboard) commands.push(["--test-concurrency=1", SCOREBOARD]);
  return commands;
}

/**
 * Keeps seed roots whole and spreads adjacent vintage loops across three source-order workers.
 * @param {string} root
 * @returns {SeedPlan}
 */
export function createSeedPlan(root) {
  const roots = seedRoots(root);
  const count = Math.min(SEED_SHARDS, roots.length);
  const shards = Array.from({ length: count }, (_, index) => ({ id: index + 1, names: [] }));
  roots.forEach(({ name }, index) => shards[index % count].names.push(name));
  return { files: [SEED_UPGRADE], roots: roots.map(({ name }) => name), shards };
}

/**
 * Re-extracts every seed root and refuses missing, duplicate or empty assignments.
 * @param {string} root
 * @param {unknown} plan
 */
export function validateSeedPlan(root, plan) {
  if (!plan || !same(plan.files, [SEED_UPGRADE]) || !Array.isArray(plan.roots) || !Array.isArray(plan.shards))
    throw new Error("Invalid seed inventory");
  const roots = seedRoots(root).map(({ name }) => name);
  if (!same(plan.roots, roots)) throw new Error("Seed root inventory differs from current code");
  const count = Math.min(SEED_SHARDS, roots.length);
  if (plan.shards.length !== count) throw new Error("Incomplete seed shards");
  const assigned = [];
  const ids = new Set();
  for (const shard of plan.shards) {
    const validId = Number.isInteger(shard.id) && shard.id > 0 && shard.id <= count && !ids.has(shard.id);
    if (!validId || !Array.isArray(shard.names) || !shard.names.length) throw new Error("Invalid seed shard");
    ids.add(shard.id);
    assigned.push(...shard.names);
  }
  if (!same(sorted(assigned), sorted(roots))) throw new Error("Incomplete or overlapping seed root assignments");
}

/**
 * Filters only the short prefix root through its complete child list, all on the same worker.
 * @param {string} root
 * @param {SeedShard} shard
 * @returns {string[][]}
 */
export function seedCommands(root, shard) {
  const selected = new Set(shard.names);
  const selectors = seedRoots(root)
    .filter(({ name }) => selected.has(name))
    .flatMap((item) => item.selectors);
  return [["--test-concurrency=1", `--test-name-pattern=${harnessPattern(selectors)}`, SEED_UPGRADE]];
}
