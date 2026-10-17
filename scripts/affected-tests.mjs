// Read-only test selection for a change. It writes nothing; `--run` only executes `node --test`.
//   node scripts/affected-tests.mjs [--base REF | --staged | --files a b ...] [--tier L1|L3|all] [--json] [--run]
//   node scripts/affected-tests.mjs --area ID [--run]   (every file a knowledge-map area owns; L2)
//   node scripts/affected-tests.mjs --check-syntax   (node --check on changed .mjs/.js/.cjs; part of check:static)
//   node scripts/affected-tests.mjs --lint | --format   (Biome lint errors / Biome format --write on changed files)
// Changed files: `git diff --name-only <base>` (default: merge-base with origin/dev) plus untracked files;
// `--staged` uses the index instead. `--files` replaces Git detection unless `--base`/`--staged` is also given.
// L1 = non-rig tests whose runtime import closure reaches a changed file. L3 = rig tests (closure reaches
// tests/helpers/studio-rig.ts; they run serially) and the harness gate, which rigs reach by copying
// src/harness-seed and src/game-template rather than importing them. tests/test-map.json adds explicit edges.
import ts from "@typescript/typescript6";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { packageBin } from "./package-bin.ts";
import { FAST_TEST_CONCURRENCY, runTestBatch } from "./test-runtime.mjs";
export { TEST_PRELOAD, testEnv } from "./test-runtime.mjs";

export const RIG_HELPER = "tests/helpers/studio-rig.ts";
export const HARNESS_GATE = ["tests/conformance/harness-incidents.test.ts", "tests/conformance/scoreboard.test.ts"];
const COPIED_TREES = /^src\/(harness-seed|game-template)\//;
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const posix = (file) => file.split(path.sep).join("/");

export function testFiles(root) {
  return fs
    .globSync("tests/**/*.test.ts", { cwd: root })
    .map(posix)
    .filter((f) => !f.split("/").includes("node_modules"))
    .sort();
}

/** A repo-relative path names a script or a fixture when it looks like `dir/file` (or `./dir/`). */
const REPO_PATH = /^\.{0,2}\/?[\w@.-]+(\/[\w@.-]+)+\/?$/;

const typeOnlyImport = (c) =>
  c?.isTypeOnly ||
  (c &&
    !c.name &&
    c.namedBindings &&
    ts.isNamedImports(c.namedBindings) &&
    c.namedBindings.elements.length > 0 &&
    c.namedBindings.elements.every((e) => e.isTypeOnly));
const typeOnlyExport = (n) =>
  n.isTypeOnly ||
  (n.exportClause &&
    ts.isNamedExports(n.exportClause) &&
    n.exportClause.elements.length > 0 &&
    n.exportClause.elements.every((e) => e.isTypeOnly));

/** A dynamic `import(x)` or a `require(x)` with an argument: a runtime load. */
function isRuntimeLoad(node) {
  if (!ts.isCallExpression(node) || !node.arguments[0]) return false;
  const callee = node.expression;
  return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
}

/** The graph being built, and how to resolve a module specifier inside `root`. */
function graphScan(root) {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  return {
    root,
    options,
    cache: ts.createModuleResolutionCache(root, (x) => x, options),
    edges: new Map(),
    refs: new Map(),
    dirs: new Map(),
    queue: [],
    rel: (abs) => posix(path.relative(root, abs)),
    inside: (abs) => insideRepo(root, abs),
  };
}

/** A repo file outside node_modules. TypeScript resolves to `/`-separated paths on Windows too. */
function insideRepo(root, file) {
  const abs = path.resolve(file);
  return abs.startsWith(root + path.sep) && !abs.includes(`${path.sep}node_modules${path.sep}`);
}

/** Follows a loaded file: an edge, and the file itself is scanned in turn. */
function follow(scan, file, target) {
  const r = scan.rel(target);
  file.deps.add(r);
  if (!scan.edges.has(r)) scan.queue.push(r);
}

/** An import, export or runtime load of `spec`, resolved to a repo file. */
function edge(scan, file, spec) {
  if (!ts.isStringLiteralLike(spec)) return;
  const resolved = ts.resolveModuleName(spec.text, file.abs, scan.options, ts.sys, scan.cache).resolvedModule;
  if (resolved) {
    if (!resolved.isExternalLibraryImport && scan.inside(resolved.resolvedFileName))
      follow(scan, file, resolved.resolvedFileName);
    return;
  }
  // A relative import of a file that no longer exists still names it, so deleting it selects its importers.
  if (!spec.text.startsWith(".")) return;
  const target = path.resolve(path.dirname(file.abs), spec.text);
  if (scan.inside(target)) file.deps.add(scan.rel(target));
}

/** A repo path named in a string literal: a script is followed, a folder or other file only noted. */
function reference(scan, file, text) {
  if (!REPO_PATH.test(text)) return;
  const target = text.startsWith(".") ? path.resolve(path.dirname(file.abs), text) : path.join(scan.root, text);
  if (!scan.inside(target) || !fs.existsSync(target)) return;
  const named = scan.rel(target);
  if (fs.statSync(target).isDirectory()) {
    if (named.split("/").length >= 2) file.dirRefs.add(named);
    return;
  }
  if (CODE.test(target) && named.startsWith("scripts/")) follow(scan, file, target);
  else file.fileRefs.add(named);
}

function walk(scan, file, node) {
  if (ts.isImportDeclaration(node)) {
    if (!typeOnlyImport(node.importClause)) edge(scan, file, node.moduleSpecifier);
    return;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.moduleSpecifier && !typeOnlyExport(node)) edge(scan, file, node.moduleSpecifier);
    return;
  }
  if (ts.isTypeNode(node)) return;
  if (isRuntimeLoad(node)) edge(scan, file, node.arguments[0]);
  else if (file.literalRefs && ts.isStringLiteralLike(node)) reference(scan, file, node.text);
  ts.forEachChild(node, (child) => walk(scan, file, child));
}

/** Scans one queued file: its runtime loads become edges; paths it names become references. */
function scanFile(scan, name) {
  const file = { abs: path.join(scan.root, name), deps: new Set(), fileRefs: new Set(), dirRefs: new Set() };
  scan.edges.set(name, file.deps);
  if (!CODE.test(name) || name.endsWith(".d.ts") || !fs.existsSync(file.abs)) return;
  const source = ts.createSourceFile(file.abs, fs.readFileSync(file.abs, "utf8"), ts.ScriptTarget.Latest, true);
  file.literalRefs = /^(tests|scripts)\//.test(name);
  walk(scan, file, source);
  if (file.fileRefs.size) scan.refs.set(name, file.fileRefs);
  if (file.dirRefs.size) scan.dirs.set(name, file.dirRefs);
}

/**
 * Runtime edges from every test to the repo files it loads: static/dynamic imports and require (type-only
 * imports are erased, so they do not count), resolved with the same TypeScript resolver as
 * check-boundaries.ts. Files under tests/ and scripts/ also name repo paths in string literals: a named
 * script is followed like an import (tests spawn it); any other named file or folder is a direct-only
 * reference (read as text, copied as a fixture), so its own imports do not widen the selection.
 */
export function importGraph(root, entries = testFiles(root)) {
  const scan = graphScan(path.resolve(root));
  scan.queue.push(...entries);
  while (scan.queue.length) {
    const name = scan.queue.pop();
    if (!scan.edges.has(name)) scanFile(scan, name);
  }
  return { edges: scan.edges, refs: scan.refs, dirs: scan.dirs };
}
/** Tests whose runtime closure reaches the rig helper; they share a real StudioCore rig and run serially. */
export function rigTests(root, graph = importGraph(root), tests = testFiles(root)) {
  const reverse = reverseEdges(graph.edges);
  const reached = upward(reverse, [RIG_HELPER]);
  return tests.filter((t) => reached.has(t));
}

function reverseEdges(edges) {
  const reverse = new Map();
  for (const [from, deps] of edges)
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(from);
    }
  return reverse;
}
function upward(reverse, starts) {
  const seen = new Set(starts),
    queue = [...starts];
  while (queue.length)
    for (const from of reverse.get(queue.pop()) ?? [])
      if (!seen.has(from)) {
        seen.add(from);
        queue.push(from);
      }
  return seen;
}

/** Same glob semantics as the knowledge map: `dir/**` also owns hidden files under dir. */
export function globMatch(file, glob) {
  return path.matchesGlob(file, glob) || (glob.endsWith("/**") && file.startsWith(glob.slice(0, -2)));
}
/** @param {string} root @returns {Record<string, string[]>} */
export function readTestMap(root) {
  const file = path.join(root, "tests/test-map.json");
  if (!fs.existsSync(file)) return {};
  const map = JSON.parse(fs.readFileSync(file, "utf8")).map ?? {};
  for (const [glob, tests] of Object.entries(map))
    if (!Array.isArray(tests) || !tests.every((t) => typeof t === "string"))
      throw new Error(`tests/test-map.json: ${glob} must list test files`);
  return map;
}

/** Where a changed file is reached from: itself, and every file that names it or a folder holding it. */
function startsFor(graph, file) {
  return [
    file,
    ...[...graph.refs].filter(([, named]) => named.has(file)).map(([from]) => from),
    ...[...graph.dirs]
      .filter(([, named]) => [...named].some((dir) => file.startsWith(`${dir}/`)))
      .map(([from]) => from),
  ];
}

/** The tests tests/test-map.json maps to a changed file. */
function mappedTests(map, file) {
  return Object.entries(map)
    .filter(([glob]) => globMatch(file, glob))
    .flatMap(([, mapped]) => mapped);
}

/**
 * Picks every test a changed file reaches: through the import graph, through tests/test-map.json,
 * and the harness gate for the copied trees. False when no test reaches it.
 */
function pickFor(file, { graph, reverse, map, pick, gate }) {
  let hit = false;
  for (const node of upward(reverse, startsFor(graph, file))) hit = pick(node, file) || hit;
  for (const test of mappedTests(map, file)) hit = pick(test, file) || hit;
  for (const test of COPIED_TREES.test(file) ? HARNESS_GATE : []) {
    if (!pick(test, file)) continue;
    gate.add(test);
    hit = true;
  }
  return hit;
}

/**
 * Select tests for changed repo-relative files. Returns { L1, L3, rigs, reasons: {test: [changed files]}, unmatched }.
 * `unmatched` lists changed files no test reaches; the caller decides whether that needs a broader check.
 */
export function selectTests(
  root,
  changed,
  { graph = importGraph(root), tests = testFiles(root), map = readTestMap(root) } = {},
) {
  const testSet = new Set(tests);
  const reverse = reverseEdges(graph.edges);
  const rigs = new Set(rigTests(root, graph, tests));
  const reasons = new Map();
  const gate = new Set();
  const pick = (test, why) => {
    if (!testSet.has(test)) return false;
    if (!reasons.has(test)) reasons.set(test, new Set());
    reasons.get(test).add(why);
    return true;
  };
  const unmatched = [];
  for (const file of [...new Set(changed.map(posix))].sort())
    if (!pickFor(file, { graph, reverse, map, pick, gate })) unmatched.push(file);
  const selected = [...reasons.keys()].sort();
  const heavy = (t) => rigs.has(t) || gate.has(t);
  return {
    L1: selected.filter((t) => !heavy(t)),
    L3: selected.filter(heavy),
    rigs: [...rigs],
    reasons: Object.fromEntries(selected.map((t) => [t, [...reasons.get(t)]])),
    unmatched,
  };
}

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
export function defaultBase(root) {
  for (const ref of ["origin/dev", "origin/main"]) {
    try {
      return git(root, ["merge-base", "HEAD", ref]).trim();
    } catch {
      /* try the next base */
    }
  }
  return "HEAD";
}
/**
 * Working tree against the base (committed + staged + unstaged) plus untracked files, or only the index.
 * @param {string} root @param {{ base?: string, staged?: boolean }} [opts] @returns {string[]}
 */
export function changedFiles(root, { base, staged = false } = {}) {
  const lines = (text) =>
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  // A rename changes both names: old-path importers and global runner policies must still be selected.
  if (staged) return lines(git(root, ["diff", "--cached", "--no-renames", "--name-only", "--diff-filter=ACMRD"]));
  // A symlinked node_modules (a worktree sharing its checkout's install) is not ignored by `node_modules/`.
  return [
    ...new Set([
      ...lines(git(root, ["diff", "--no-renames", "--name-only", base ?? defaultBase(root)])),
      ...lines(git(root, ["ls-files", "-o", "--exclude-standard"])),
    ]),
  ]
    .filter((f) => f.split("/")[0] !== "node_modules")
    .sort();
}

/** Every tracked or untracked file a knowledge-map area owns (L2: `npm run test:area -- <id>`). */
export function areaFiles(root, id) {
  const map = JSON.parse(fs.readFileSync(path.join(root, "docs/agent/knowledge-map.json"), "utf8"));
  const area = map.areas?.find((a) => a.id === id);
  if (!area) throw new Error(`Unknown area: ${id}. Areas: ${(map.areas ?? []).map((a) => a.id).join(", ")}`);
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return files.filter((f) => area.sources.some((glob) => globMatch(f, glob))).sort();
}

const USAGE =
  "Usage: affected-tests.mjs [--base REF | --staged | --files a b] [--tier L1|L3|all] [--json] [--run] [--check-syntax] [--lint | --format]";
const TIERS = ["L1", "L3", "all"];
/** The flags that switch an option on, and the option each one sets. */
const SWITCHES = new Map([
  ["--staged", "staged"],
  ["--json", "json"],
  ["--run", "run"],
  ["--check-syntax", "checkSyntax"],
]);

/** Applies one flag to the options; `rest` holds the arguments after it, which a flag may consume. */
function readArg(opts, arg, rest) {
  const option = SWITCHES.get(arg);
  if (option) {
    opts[option] = true;
    return;
  }
  if (arg === "--lint" || arg === "--format") {
    opts.biome = arg.slice(2);
    return;
  }
  if (arg === "--base") {
    opts.base = rest.shift();
    return;
  }
  if (arg === "--tier") {
    opts.tier = rest.shift();
    return;
  }
  if (arg === "--files") {
    opts.files = [];
    while (rest[0] && !rest[0].startsWith("--")) opts.files.push(rest.shift());
    return;
  }
  if (arg !== "--area") throw new Error(`Unknown argument ${arg}. ${USAGE}`);
  if (!rest[0]) throw new Error("--area needs a knowledge-map area id");
  (opts.files ??= []).push(...areaFiles(process.cwd(), rest.shift()));
}

function parseArgs(argv) {
  const opts = {
    tier: "all",
    json: false,
    run: false,
    files: null,
    base: undefined,
    staged: false,
    checkSyntax: false,
    biome: null,
  };
  const rest = [...argv];
  while (rest.length) readArg(opts, rest.shift(), rest);
  if (!TIERS.includes(opts.tier)) throw new Error("--tier must be L1, L3 or all");
  if (opts.base === "") throw new Error("--base needs a ref");
  return opts;
}
export function changedFromArgs(root, opts) {
  const fromGit = opts.files === null || opts.base !== undefined || opts.staged;
  return [
    ...new Set([
      ...(fromGit ? changedFiles(root, opts) : []),
      ...(opts.files ?? []).map((f) => posix(path.isAbsolute(f) ? path.relative(root, f) : path.normalize(f))),
    ]),
  ].sort();
}

/** Pure tests use bounded file parallelism; rig files run one at a time. */
export function runSelection(root, { L1, L3 }, tier, parentEnv = process.env, stdio = "inherit") {
  const batches = [];
  if (tier !== "L3" && L1.length) batches.push({ files: L1, concurrency: FAST_TEST_CONCURRENCY });
  if (tier !== "L1" && L3.length) batches.push({ files: L3, concurrency: 1 });
  if (!batches.length) {
    console.log("affected-tests: nothing to run for this change");
    return 0;
  }
  for (const { files, concurrency } of batches) {
    const status = runTestBatch(root, files, { concurrency, env: parentEnv, stdio });
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd(),
    opts = parseArgs(process.argv.slice(2)),
    started = performance.now();
  const changed = changedFromArgs(root, opts);
  if (opts.checkSyntax) {
    const scripts = changed.filter(
      (f) => /\.[cm]?js$/.test(f) && !f.startsWith("tests/fixtures/") && fs.existsSync(path.join(root, f)),
    );
    const failed = scripts.filter(
      (f) => spawnSync(process.execPath, ["--check", f], { cwd: root, stdio: "inherit" }).status !== 0,
    );
    console.log(`node --check: ${scripts.length - failed.length}/${scripts.length} changed scripts parse`);
    process.exit(failed.length ? 1 : 0);
  }
  if (opts.biome) {
    // Biome's own `--changed` sees only committed work (`<since>...HEAD`), not the edit in progress or
    // untracked files, so it gets this list. Lint fails on errors only; the warnings are the backlog.
    // `--lint` runs `biome check`: lint errors plus formatting, which the whole repo now follows.
    const files = changed.filter((f) => fs.existsSync(path.join(root, f)));
    if (!files.length) {
      console.log(`biome ${opts.biome}: no changed files`);
      process.exit(0);
    }
    const mode = opts.biome === "lint" ? ["check", "--diagnostic-level=error"] : ["format", "--write"];
    const run = spawnSync(
      process.execPath,
      [
        packageBin("@biomejs/biome", "biome"),
        ...mode,
        "--no-errors-on-unmatched",
        "--files-ignore-unknown=true",
        ...files,
      ],
      { cwd: root, stdio: "inherit" },
    );
    process.exit(run.status ?? 1);
  }
  const selection = selectTests(root, changed);
  const ms = Math.round(performance.now() - started);
  const shown = { L1: opts.tier === "L3" ? [] : selection.L1, L3: opts.tier === "L1" ? [] : selection.L3 };
  if (opts.json)
    console.log(
      JSON.stringify({ changed, ...shown, reasons: selection.reasons, unmatched: selection.unmatched, ms }, null, 2),
    );
  else {
    console.log(`affected-tests: ${changed.length} changed file(s), selected in ${ms} ms`);
    for (const tier of ["L1", "L3"])
      if (opts.tier === "all" || opts.tier === tier) {
        console.log(
          `${tier} (${shown[tier].length})${tier === "L3" ? " — rig suites and the harness gate, run serially" : ""}`,
        );
        for (const test of shown[tier])
          console.log(
            `  ${test}  ← ${selection.reasons[test].slice(0, 2).join(", ")}${selection.reasons[test].length > 2 ? ", …" : ""}`,
          );
      }
    const { unmatched } = selection;
    if (unmatched.length)
      console.log(
        `No test reaches (${unmatched.length}): ${unmatched.slice(0, 12).join(" ")}${unmatched.length > 12 ? " … (--json lists all)" : ""}`,
      );
  }
  if (opts.run) process.exitCode = runSelection(root, shown, opts.tier);
}
