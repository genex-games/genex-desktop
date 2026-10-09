import ts from "@typescript/typescript6";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// A test that reads studio source as text and matches it proves spelling, not behaviour. New tests
// must load the module (or drive the app) instead. tests/test-style-allowlist.json freezes the
// files that already do it; entries are only ever removed, and an entry fails once its file stops
// reading source, so the list can only shrink.
export const ALLOWLIST = "tests/test-style-allowlist.json";
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const READERS = new Set(["readFile", "readFileSync"]);
// Source handed straight to a VM is executed, which is behaviour.
const EXECUTES = new Set([
  "runInContext",
  "runInNewContext",
  "runInThisContext",
  "Script",
  "compileFunction",
  "Function",
]);
const UNKNOWN = "\0";
// A named helper's parameter: its reads are judged at each call site, with the arguments given there.
const PARAM = "\u0001";

export interface SourceRead {
  file: string;
  line: number;
  target: string;
}
type Env = Map<string, string>;

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** The test file being read: where it is, and its parsed source. */
interface TestSource {
  root: string;
  file: string;
  abs: string;
  dir: string;
  source: ts.SourceFile;
}

const declares = (d: ts.VariableDeclaration | ts.ParameterDeclaration, name: string) =>
  ts.isIdentifier(d.name) && d.name.text === name;

/** A `for` loop's own `const`/`let` declaration of the name. */
function loopDeclaration(scope: ts.Node, name: string): ts.Node | undefined {
  const loop = ts.isForOfStatement(scope) || ts.isForStatement(scope) || ts.isForInStatement(scope);
  if (!loop || !scope.initializer || !ts.isVariableDeclarationList(scope.initializer)) return undefined;
  return scope.initializer.declarations.find((d) => declares(d, name));
}

/** A declaration of the name among a block's own statements: a variable or a function. */
function statementDeclaration(scope: ts.Node, name: string): ts.Node | undefined {
  const blockLike = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope);
  for (const statement of blockLike ? scope.statements : []) {
    if (ts.isVariableStatement(statement)) {
      const found = statement.declarationList.declarations.find((d) => declares(d, name));
      if (found) return found;
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  }
  return undefined;
}

// Lexical lookup: the nearest enclosing declaration of a name (a parameter hides outer names).
function lookup(id: ts.Identifier): ts.Node | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    const inLoop = loopDeclaration(scope, id.text);
    if (inLoop) return inLoop;
    const param = ts.isFunctionLike(scope) ? scope.parameters.find((p) => declares(p, id.text)) : undefined;
    if (param) return param;
    const declared = statementDeclaration(scope, id.text);
    if (declared) return declared;
  }
  return undefined;
}

function wrapperOf(reading: TestSource, id: ts.Identifier): { params: string[]; body: ts.Node } | undefined {
  const decl = lookup(id);
  const fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
  if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.body)
    return { params: fn.parameters.map((p) => p.name.getText(reading.source)), body: fn.body };
  return undefined;
}

function initializerOf(id: ts.Identifier): ts.Expression | undefined {
  const decl = lookup(id);
  if (!decl || !ts.isVariableDeclaration(decl)) return undefined;
  const loop = decl.parent.parent;
  // `for (const file of ["src/a.ts", ...])`: the first element stands for the loop variable.
  if (ts.isForOfStatement(loop))
    return ts.isArrayLiteralExpression(loop.expression) ? loop.expression.elements[0] : undefined;
  const init = decl.initializer;
  const constant = Boolean(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const);
  if (!init || !constant || ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return undefined;
  return init;
}

type Evaluate = (node: ts.Expression) => string;

function identifierValue(reading: TestSource, node: ts.Identifier, env: Env, next: Evaluate): string {
  if (node.text === "__dirname") return reading.dir;
  const bound = env.get(node.text);
  if (bound !== undefined) return bound;
  const decl = lookup(node);
  const fn = decl && ts.isParameter(decl) ? decl.parent : undefined;
  if (fn && (ts.isFunctionDeclaration(fn) || ts.isVariableDeclaration(fn.parent))) return PARAM;
  const init = initializerOf(node);
  return init ? next(init) : UNKNOWN;
}

/** `import.meta.dirname`, `.url` and `.filename`, or undefined for anything else. */
function metaValue(reading: TestSource, node: ts.PropertyAccessExpression): string | undefined {
  if (node.name.text === "dirname") return reading.dir;
  if (node.name.text === "url") return pathToFileURL(reading.abs).href;
  if (node.name.text === "filename") return reading.abs;
  return undefined;
}

/** `new URL(spec, base)` against a known file URL. */
function urlValue(node: ts.NewExpression, next: Evaluate): string {
  const [specArg, baseArg] = node.arguments ?? [];
  const spec = specArg ? next(specArg) : "";
  const base = baseArg ? next(baseArg) : "";
  if (!base.startsWith("file:") || base.includes(UNKNOWN)) return UNKNOWN;
  return spec.includes(UNKNOWN)
    ? path.resolve(path.dirname(fileURLToPath(base)), spec)
    : fileURLToPath(new URL(spec, base));
}

/** The path helpers a test builds paths with: cwd, fileURLToPath, dirname, join and resolve. */
function callValue(reading: TestSource, node: ts.CallExpression, next: Evaluate): string {
  const name = calleeName(node.expression);
  const args = node.arguments.map((a) => next(a));
  const [first] = args;
  if (name === "cwd") return reading.root;
  if (name === "fileURLToPath" && first)
    return first.startsWith("file:") && !first.includes(UNKNOWN) ? fileURLToPath(first) : first;
  if (name === "dirname" && first) return path.dirname(first);
  if (name === "join" && args.length) return path.join(...args);
  if (name !== "resolve" || !args.length) return UNKNOWN;
  const last = args.map((a, i) => (path.isAbsolute(a) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  return path.join(last < 0 ? reading.root : "", ...args.slice(Math.max(last, 0)));
}

const isNewUrl = (node: ts.Node): node is ts.NewExpression =>
  ts.isNewExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "URL" &&
  Boolean(node.arguments?.[0]);

/** An expression that only wraps the path it holds. */
const isWrapper = (node: ts.Node): node is ts.Expression & { expression: ts.Expression } =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isAwaitExpression(node);

// Evaluate a path expression to a string; parts that cannot be known statically become UNKNOWN.
function value(reading: TestSource, node: ts.Expression, env: Env, depth = 0): string {
  if (depth > 12) return UNKNOWN;
  const next: Evaluate = (n) => value(reading, n, env, depth + 1);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (isWrapper(node)) return next(node.expression);
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => next(s.expression) + s.literal.text).join("");
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return next(node.left) + next(node.right);
  if (ts.isIdentifier(node)) return identifierValue(reading, node, env, next);
  if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression))
    return metaValue(reading, node) ?? UNKNOWN;
  if (isNewUrl(node)) return urlValue(node, next);
  if (ts.isCallExpression(node)) return callValue(reading, node, next);
  return UNKNOWN;
}

const repoPath = (root: string, p: string) => path.relative(root, path.resolve(root, p)).split(path.sep).join("/");

/** A partly unknown path under a known src/ folder: a source file by its known tail, or a walk over the folder. */
function folderTarget(root: string, folder: string, tail: string): string | undefined {
  if (/\.\w+$/.test(tail)) return SOURCE.test(tail) ? `${folder}/…${tail}` : undefined;
  const dir = path.join(root, folder);
  const holdsSource =
    fs.existsSync(dir) &&
    fs.statSync(dir).isDirectory() &&
    fs.readdirSync(dir, { recursive: true }).some((f) => SOURCE.test(String(f)));
  return holdsSource ? `${folder}/…` : undefined;
}

// A read counts when the path is a studio source file. A partly unknown path counts when its known
// folder under src/ holds source files at any depth (a walk over src/renderer), or when its known tail names a
// real source file; `join(gameDir, 'src/main.js')` names a game's file, not the studio's.
function sourceTarget(root: string, p: string): string | undefined {
  if (p.includes(PARAM)) return undefined;
  const cut = p.indexOf(UNKNOWN);
  if (cut < 0) {
    const target = repoPath(root, p);
    return target.startsWith("src/") && SOURCE.test(target) ? target : undefined;
  }
  const tail = p.slice(p.lastIndexOf(UNKNOWN) + 1);
  const prefix = p.slice(0, cut);
  const endsAtFolder = prefix.endsWith("/") || prefix.endsWith(path.sep);
  const folder = repoPath(root, endsAtFolder ? prefix : path.dirname(prefix));
  if (path.isAbsolute(prefix) && folder.startsWith("src/")) return folderTarget(root, folder, tail);
  const named = tail.replace(/^\/+/, "");
  return named.startsWith("src/") && SOURCE.test(named) && fs.existsSync(path.join(root, named)) ? named : undefined;
}

const outer = (call: ts.Node) => {
  let node: ts.Node = call;
  while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return node;
};
// Text means an encoding argument or `.toString()`; bytes read without one are fixture data (a plugin package).
const asText = (call: ts.CallExpression) => {
  const node = outer(call);
  return (
    call.arguments.length > 1 || (ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "toString")
  );
};
const executed = (call: ts.Node) => {
  const node = outer(call);
  const parent = node.parent;
  return (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression !== node &&
    EXECUTES.has(calleeName(parent.expression) ?? "")
  );
};

/** A `readFile(Sync)` whose result is text that nothing executes. */
function isTextRead(node: ts.CallExpression): boolean {
  const name = calleeName(node.expression);
  return Boolean(name && READERS.has(name) && node.arguments[0]) && asText(node) && !executed(node);
}

/** What `scan` carries down the tree: the names bound so far, how deep in helpers, and the outer call site. */
type ScanAt = { env: Env; depth: number; site: ts.Node | undefined };

function recordRead(reading: TestSource, found: SourceRead[], node: ts.CallExpression, at: ScanAt): void {
  const target = sourceTarget(reading.root, value(reading, node.arguments[0] as ts.Expression, at.env));
  const line = reading.source.getLineAndCharacterOfPosition((at.site ?? node).getStart(reading.source)).line + 1;
  if (target && !found.some((f) => f.line === line && f.target === target))
    found.push({ file: reading.file, line, target });
}

// A local helper such as `read = (rel) => readFileSync(join(root, rel))`: evaluate its reads with this call's arguments.
function scanHelperCall(reading: TestSource, found: SourceRead[], node: ts.CallExpression, at: ScanAt): void {
  if (!ts.isIdentifier(node.expression) || at.depth >= 3) return;
  const wrapper = wrapperOf(reading, node.expression);
  if (!wrapper) return;
  const inner: Env = new Map(at.env);
  wrapper.params.forEach((param, i) => {
    const arg = node.arguments[i];
    inner.set(param, arg ? value(reading, arg, at.env) : UNKNOWN);
  });
  scan(reading, found, wrapper.body, { env: inner, depth: at.depth + 1, site: at.site ?? node });
}

function scan(reading: TestSource, found: SourceRead[], node: ts.Node, at: ScanAt): void {
  if (ts.isCallExpression(node)) {
    if (isTextRead(node)) recordRead(reading, found, node, at);
    else scanHelperCall(reading, found, node, at);
  }
  ts.forEachChild(node, (child) => scan(reading, found, child, at));
}

/** Source files a test reads as text, found by statically evaluating the path given to readFile(Sync). */
export function sourceReads(
  repoRoot: string,
  file: string,
  text = fs.readFileSync(path.join(repoRoot, file), "utf8"),
): SourceRead[] {
  const root = path.resolve(repoRoot);
  const abs = path.join(root, file);
  const reading: TestSource = {
    root,
    file,
    abs,
    dir: path.dirname(abs),
    source: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true),
  };
  const found: SourceRead[] = [];
  scan(reading, found, reading.source, { env: new Map(), depth: 0, site: undefined });
  return found;
}
export function testFiles(root: string): string[] {
  return fs
    .globSync("tests/**/*.test.ts", { cwd: root })
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => !f.split("/").includes("node_modules"))
    .sort();
}
export function readAllowlist(root: string): string[] {
  const file = path.join(root, ALLOWLIST);
  if (!fs.existsSync(file)) return [];
  const files = JSON.parse(fs.readFileSync(file, "utf8")).files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string"))
    throw new Error(`${ALLOWLIST}: "files" must list test files`);
  return files;
}
/**
 * The allowlist on the merge base, when Git can show it; additions against it are refused. A base
 * from before the list existed freezes exactly the tests that read source there, so the change that
 * introduces the list cannot slip a new source-text test into it.
 */
export function baseAllowlist(root: string, base?: string): string[] | undefined {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  let ref: string;
  try {
    ref = base ?? git("merge-base", "HEAD", "origin/dev");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(git("show", `${ref}:${ALLOWLIST}`)).files;
  } catch {
    /* no list on the base yet */
  }
  try {
    const tests = git("ls-tree", "-r", "--name-only", ref, "--", "tests")
      .split("\n")
      .filter((f) => f.endsWith(".test.ts") && !f.split("/").includes("node_modules"));
    return tests.filter((file) => sourceReads(root, file, git("show", `${ref}:${file}`)).length > 0);
  } catch {
    return undefined;
  }
}

/** Each source-text read in a test the allowlist does not freeze. */
function newSourceReads(offenders: Map<string, SourceRead[]>, allowed: Set<string>): string[] {
  return [...offenders]
    .filter(([file]) => !allowed.has(file))
    .flatMap(([file, reads]) =>
      reads.map(
        (read) =>
          `${file}:${read.line}: reads ${read.target} as text. Test the behaviour by importing the module or driving the app; source-text tests are frozen in ${ALLOWLIST}.`,
      ),
    );
}

/** Allowlist entries whose test is gone or no longer reads source. */
function staleEntries(allowed: Set<string>, files: string[], offenders: Map<string, SourceRead[]>): string[] {
  const errors: string[] = [];
  for (const file of allowed) {
    if (!files.includes(file)) errors.push(`${ALLOWLIST}: ${file} no longer exists; remove it from the list`);
    else if (!offenders.has(file))
      errors.push(`${ALLOWLIST}: ${file} no longer reads source as text; remove it from the list`);
  }
  return errors;
}

export function checkTestStyle(
  root: string,
  {
    allowlist = readAllowlist(root),
    baseline,
    files = testFiles(root),
  }: { allowlist?: string[]; baseline?: string[]; files?: string[] } = {},
): string[] {
  const allowed = new Set(allowlist);
  const offenders = new Map(files.map((f) => [f, sourceReads(root, f)] as const).filter(([, reads]) => reads.length));
  const added = baseline ? [...allowed].filter((file) => !baseline.includes(file)) : [];
  return [
    ...newSourceReads(offenders, allowed),
    ...staleEntries(allowed, files, offenders),
    ...added.map(
      (file) => `${ALLOWLIST}: ${file} was added; the list only shrinks. Rewrite the test to check behaviour instead.`,
    ),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd(),
    started = performance.now();
  const baseline = baseAllowlist(root);
  const errors = checkTestStyle(root, { baseline });
  const ms = Math.round(performance.now() - started);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Test style: no new source-text tests (${readAllowlist(root).length} frozen in ${ALLOWLIST}${baseline ? "" : "; no merge-base copy to compare"}; ${ms} ms)`,
    );
}
