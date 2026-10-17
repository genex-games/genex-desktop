import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  areaFiles,
  changedFiles,
  importGraph,
  readTestMap,
  rigTests,
  runSelection,
  selectTests,
  testEnv,
  testFiles,
} from "../../scripts/affected-tests.mjs";
import { reviewFiles } from "../../scripts/review-agent-context.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const script = path.join(repo, "scripts/affected-tests.mjs");
// Fixture repositories never inherit a hook's GIT_DIR or GIT_INDEX_FILE.
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: testEnv() },
  );

/** A miniature repo: a pure module with its unit test, a rig that reaches core code, and the harness gate. */
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "affected-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        allowImportingTsExtensions: true,
        allowJs: true,
        noEmit: true,
      },
    }),
    "src/pure.ts": "import { helper } from './helper.ts';\nexport const pure = () => helper() + 1;\n",
    "src/helper.ts": "export const helper = () => 1;\n",
    "src/types.ts": "export interface Shape { size: number }\n",
    "src/core.ts": "export const core = 'core';\n",
    "src/copy-me.ts": "export const copied = 'text';\n",
    "src/harness-seed/loop/turn.mjs": "export const turn = 1;\n",
    "tests/helpers/studio-rig.ts": "import { core } from '../../src/core.ts';\nexport const rig = () => core;\n",
    "tests/conformance/pure.test.ts":
      "import { test } from 'node:test';\nimport { pure } from '../../src/pure.ts';\nimport type { Shape } from '../../src/types.ts';\ntest('pure', () => { const s: Shape = { size: pure() }; if (s.size !== 2) throw new Error('bad'); });\n",
    "tests/conformance/rig.test.ts":
      "import { test } from 'node:test';\nimport { rig } from '../helpers/studio-rig.ts';\ntest('rig', () => { rig(); });\n",
    "tests/conformance/text.test.ts":
      "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('text', () => { fs.readFileSync('src/copy-me.ts', 'utf8'); });\n",
    "tests/conformance/lazy.test.ts":
      "import { test } from 'node:test';\ntest('lazy', async () => { await import('../../src/helper.ts'); });\n",
    "tests/conformance/harness-incidents.test.ts":
      "import { test } from 'node:test';\nimport { rig } from '../helpers/studio-rig.ts';\ntest('incidents', () => { rig(); });\n",
    "tests/conformance/scoreboard.test.ts": "import { test } from 'node:test';\ntest('scoreboard', () => {});\n",
    "tests/conformance/docs.test.ts": "import { test } from 'node:test';\ntest('docs', () => {});\n",
    "tests/test-map.json": JSON.stringify({ map: { "docs/**": ["tests/conformance/docs.test.ts"] } }),
    "docs/guide.md": "# Guide\n",
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("a changed pure module selects its unit test in L1, through transitive and dynamic imports", (t) => {
  const root = fixture(t);
  const deep = selectTests(root, ["src/helper.ts"]);
  assert.deepEqual(deep.L1, ["tests/conformance/lazy.test.ts", "tests/conformance/pure.test.ts"]);
  assert.deepEqual(deep.L3, []);
  assert.deepEqual(deep.reasons["tests/conformance/pure.test.ts"], ["src/helper.ts"]);
  // A type-only import is erased at runtime, so it selects nothing.
  assert.deepEqual(selectTests(root, ["src/types.ts"]), {
    L1: [],
    L3: [],
    rigs: ["tests/conformance/harness-incidents.test.ts", "tests/conformance/rig.test.ts"],
    reasons: {},
    unmatched: ["src/types.ts"],
  });
  // A source named as a literal path is a direct-only edge: the reading test, nothing that imports it.
  assert.deepEqual(selectTests(root, ["src/copy-me.ts"]).L1, ["tests/conformance/text.test.ts"]);
  // Editing a test selects that test.
  assert.deepEqual(selectTests(root, ["tests/conformance/pure.test.ts"]).L1, ["tests/conformance/pure.test.ts"]);
});

test("a change reachable only from a rig goes to L3, never L1", (t) => {
  const root = fixture(t);
  assert.deepEqual(rigTests(root), ["tests/conformance/harness-incidents.test.ts", "tests/conformance/rig.test.ts"]);
  const selection = selectTests(root, ["src/core.ts"]);
  assert.deepEqual(selection.L1, []);
  assert.deepEqual(selection.L3, ["tests/conformance/harness-incidents.test.ts", "tests/conformance/rig.test.ts"]);
});

test("a harness-seed change selects the harness gate into L3; test-map adds explicit edges; deleted files still select importers", (t) => {
  const root = fixture(t);
  const seed = selectTests(root, ["src/harness-seed/loop/turn.mjs"]);
  assert.deepEqual(seed.L1, []);
  assert.deepEqual(seed.L3, ["tests/conformance/harness-incidents.test.ts", "tests/conformance/scoreboard.test.ts"]);
  const docs = selectTests(root, ["docs/guide.md", "README.md"]);
  assert.deepEqual(docs.L1, ["tests/conformance/docs.test.ts"]);
  assert.deepEqual(docs.unmatched, ["README.md"]);
  fs.rmSync(path.join(root, "src/helper.ts"));
  assert.ok(importGraph(root).edges.get("src/pure.ts")?.has("src/helper.ts"));
  assert.deepEqual(selectTests(root, ["src/helper.ts"]).L1, [
    "tests/conformance/lazy.test.ts",
    "tests/conformance/pure.test.ts",
  ]);
});

test("changed files come from the diff against a base plus untracked files, the index alone, or an area", (t) => {
  const root = fixture(t);
  const git = (...args: string[]) => gitIn(root, ...args);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  fs.appendFileSync(path.join(root, "src/helper.ts"), "// edit\n");
  fs.writeFileSync(path.join(root, "src/new.ts"), "export {};\n");
  fs.appendFileSync(path.join(root, "docs/guide.md"), "staged\n");
  git("add", "docs/guide.md");
  assert.deepEqual(changedFiles(root, { base }), ["docs/guide.md", "src/helper.ts", "src/new.ts"]);
  assert.deepEqual(changedFiles(root, { staged: true }), ["docs/guide.md"]);
  fs.mkdirSync(path.join(root, "docs/agent"));
  fs.writeFileSync(
    path.join(root, "docs/agent/knowledge-map.json"),
    JSON.stringify({ areas: [{ id: "seed", sources: ["src/harness-seed/**", "src/new.ts"] }] }),
  );
  assert.deepEqual(areaFiles(root, "seed"), ["src/harness-seed/loop/turn.mjs", "src/new.ts"]);
  assert.throws(() => areaFiles(root, "missing"), /Unknown area: missing/);
});

test("renames retain old and new paths for base and staged selection, including deleted-path importers", (t) => {
  const root = fixture(t);
  const git = (...args: string[]) => gitIn(root, ...args);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "misc"));
  fs.writeFileSync(path.join(root, "scripts/test-runtime.mjs"), "export const runtime = true;\n");
  git("init", "-q");
  git("config", "diff.renames", "true");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("mv", "scripts/test-runtime.mjs", "misc/renamed-runtime.mjs");
  git("mv", "src/helper.ts", "src/renamed-helper.ts");
  const expected = ["misc/renamed-runtime.mjs", "scripts/test-runtime.mjs", "src/helper.ts", "src/renamed-helper.ts"];
  for (const options of [{ base }, { staged: true }]) {
    const changed = changedFiles(root, options);
    assert.deepEqual(changed, expected);
    assert.deepEqual(selectTests(root, changed).L1, [
      "tests/conformance/lazy.test.ts",
      "tests/conformance/pure.test.ts",
    ]);
  }
});

test("the CLI reports JSON and --run exits with the selected tests' status", (t) => {
  const root = fixture(t);
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  const listed = cli("--files", "src/helper.ts", "src/core.ts", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  const report = JSON.parse(listed.stdout);
  assert.deepEqual(
    [report.changed, report.L1, report.L3],
    [
      ["src/core.ts", "src/helper.ts"],
      ["tests/conformance/lazy.test.ts", "tests/conformance/pure.test.ts"],
      ["tests/conformance/harness-incidents.test.ts", "tests/conformance/rig.test.ts"],
    ],
  );
  assert.deepEqual(JSON.parse(cli("--files", "src/core.ts", "--tier", "L1", "--json").stdout).L3, []);
  assert.equal(cli("--files", "src/helper.ts", "--tier", "L1", "--run").status, 0);
  fs.writeFileSync(path.join(root, "src/helper.ts"), "export const helper = () => 5;\n");
  const failed = cli("--files", "src/helper.ts", "--tier", "L1", "--run");
  assert.notEqual(failed.status, 0, "a failing selected test fails the run");
  assert.equal(cli("--files", "README.md", "--run").status, 0, "an empty selection passes");
  assert.match(cli("--tier", "L2").stderr, /--tier must be L1, L3 or all/);
});

test("--lint fails only on a Biome error in a changed file; --format rewrites only the changed files", (t) => {
  const root = fixture(t);
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, "src/bad.ts"), "export function f() {\n  debugger;\n}\n");
  const ugly = "export const   ugly =  1\n";
  fs.writeFileSync(path.join(root, "src/ugly.ts"), ugly);
  assert.equal(
    cli("--lint", "--files", "src/helper.ts", "src/gone.ts").status,
    0,
    "a clean file and a deleted one pass",
  );
  assert.notEqual(cli("--lint", "--files", "src/helper.ts", "src/bad.ts").status, 0, "an error-level rule fails");
  assert.equal(cli("--format", "--files", "src/helper.ts").status, 0);
  assert.equal(fs.readFileSync(path.join(root, "src/ugly.ts"), "utf8"), ugly, "an unchanged file is never formatted");
  assert.equal(cli("--format", "--files", "src/ugly.ts").status, 0);
  assert.equal(fs.readFileSync(path.join(root, "src/ugly.ts"), "utf8"), "export const ugly = 1;\n");
});

test("review:context --files routes areas and lists affected tests", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "docs/agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs/agent/knowledge-map.json"),
    JSON.stringify({
      version: 2,
      localOnly: [],
      areas: [
        { id: "core", sources: ["src/**"], documents: ["docs/guide.md"], commands: ["test"] },
        { id: "other", sources: ["scripts/**"], documents: [], commands: [] },
      ],
    }),
  );
  const text = reviewFiles(root, ["src/helper.ts", "notes.txt"]);
  assert.match(text, /^2 changed file\(s\) → 1 area\(s\)/);
  assert.match(text, /\ncore\n/);
  assert.doesNotMatch(text, /\nother\n/);
  assert.match(text, /Not owned by any area: notes\.txt/);
  assert.match(text, /Affected tests L1 \(2[\s\S]*tests\/conformance\/pure\.test\.ts/);
});

test("in this repository: every mapped test exists, unit tests land in L1 and seed changes reach the gate", () => {
  const tests = new Set(testFiles(repo));
  for (const [glob, mapped] of Object.entries(readTestMap(repo)))
    for (const file of mapped) assert.ok(tests.has(file), `tests/test-map.json ${glob}: ${file} does not exist`);
  const graph = importGraph(repo);
  const selection = selectTests(repo, ["scripts/affected-tests.mjs", "src/harness-seed/loop/facet-loop.ts"], { graph });
  assert.ok(selection.L1.includes("tests/conformance/affected-tests.test.ts"));
  assert.ok(
    selection.L3.includes("tests/conformance/harness-incidents.test.ts") &&
      selection.L3.includes("tests/conformance/scoreboard.test.ts"),
  );
  for (const rig of selection.rigs)
    assert.ok(!selection.L1.includes(rig), `${rig} is a rig test and must not run in L1`);
});

test("--run hands tests no repository pinning: a fixture repo built inside a test never lands in the committing checkout", (t) => {
  const root = fixture(t);
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "affected-sentinel-"));
  t.after(() => fs.rmSync(sentinel, { recursive: true, force: true }));
  fs.writeFileSync(path.join(sentinel, "keep.txt"), "keep\n");
  gitIn(sentinel, "init", "-q");
  gitIn(sentinel, "add", "-A");
  gitIn(sentinel, "commit", "-qm", "sentinel");
  const state = () => [gitIn(sentinel, "rev-list", "--all"), gitIn(sentinel, "ls-files", "--stage")];
  const before = state();
  // Like many suites here: init, add and commit in a fresh temp folder with the inherited environment.
  fs.writeFileSync(
    path.join(root, "tests/conformance/pure.test.ts"),
    `import { test } from 'node:test';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
test('builds a repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'inner.txt'), 'inner');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'inner');
  fs.rmSync(dir, { recursive: true, force: true });
});
`,
  );
  // What git exports to a pre-commit hook (absolute paths in a linked worktree).
  const hookEnv = {
    ...process.env,
    GIT_DIR: path.join(sentinel, ".git"),
    GIT_INDEX_FILE: path.join(sentinel, ".git/index"),
    GIT_WORK_TREE: sentinel,
  };
  assert.equal(runSelection(root, { L1: ["tests/conformance/pure.test.ts"], L3: [] }, "L1", hookEnv, "ignore"), 0);
  assert.deepEqual(state(), before);
  assert.deepEqual(
    Object.keys(
      testEnv({
        GIT_DIR: "x",
        GIT_INDEX_FILE: "y",
        GIT_CONFIG_KEY_0: "k",
        NODE_TEST_CONTEXT: "child",
        GIT_AUTHOR_NAME: "kept",
        PATH: "/bin",
      }),
    ),
    ["GIT_AUTHOR_NAME", "PATH"],
  );
});

test("affected execution bounds pure workers and keeps the rig batch serial", (t) => {
  const root = fixture(t);
  const files = ["pure", "lazy", "rig"].map((name) => `tests/conformance/${name}.test.ts`);
  for (const file of files)
    fs.writeFileSync(
      path.join(root, file),
      `import { test } from 'node:test'; import fs from 'node:fs';
test('records execution', () => fs.appendFileSync('execution.jsonl', JSON.stringify({file:${JSON.stringify(file)},argv:process.execArgv})+'\\n'));
`,
    );
  assert.equal(runSelection(root, { L1: files.slice(0, 2), L3: files.slice(2) }, "all", process.env, "ignore"), 0);
  const seen = fs
    .readFileSync(path.join(root, "execution.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(seen.map(({ file }) => file).sort(), [...files].sort());
  assert.equal(seen.at(-1).file, files[2]);
  for (const { file, argv } of seen)
    assert.ok(argv.includes(`--test-concurrency=${file === files[2] ? 1 : 2}`), `${file}: ${argv}`);
});

// The hook runs under /bin/sh here, with shell-script stand-ins for npm and node.
const POSIX_HOOKS = { skip: process.platform === "win32" && "the developer's git hooks are POSIX shell scripts" };
test(
  "the pre-commit hook passes the staged list it read and runs its checks without the hook's repository pinning",
  POSIX_HOOKS,
  (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hook-repo-"));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const main = path.join(scratch, "main"),
      linked = path.join(scratch, "linked"),
      bin = path.join(scratch, "bin"),
      log = path.join(scratch, "calls.log");
    fs.mkdirSync(path.join(main, "src"), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(main, "src/tracked.ts"), "export {};\n");
    gitIn(main, "init", "-q");
    gitIn(main, "add", "-A");
    gitIn(main, "commit", "-qm", "base");
    gitIn(main, "worktree", "add", "-q", "-b", "work", linked);
    gitIn(main, "config", "core.hooksPath", path.join(repo, "scripts/hooks"));
    // npm and node stand-ins record what the hook runs and which GIT_ variables they inherit.
    for (const tool of ["npm", "node"])
      fs.writeFileSync(
        path.join(bin, tool),
        `#!/bin/sh\n{ echo "${tool} $*"; env | grep '^GIT_' | sed 's/=.*//' | sort | tr '\\n' ' '; echo; } >> "${log}"\n`,
        { mode: 0o755 },
      );
    const gitBin = path.dirname(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());
    const env = { PATH: `${bin}:${gitBin}:/usr/bin:/bin`, HOME: scratch };
    const commit = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=F",
          "-c",
          "user.email=f@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          ...args,
        ],
        { cwd: linked, env, encoding: "utf8" },
      );
    fs.writeFileSync(path.join(linked, "src/new file.ts"), "export const a = 1;\n");
    gitIn(linked, "add", "src/new file.ts");
    commit("-m", "staged");
    // `commit -a` stages into index.lock; the hook must still see the tracked edit.
    fs.appendFileSync(path.join(linked, "src/tracked.ts"), "// edit\n");
    commit("-am", "all");
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(
      calls.filter((_, i) => i % 2 === 0),
      [
        "npm run --silent check:static",
        "node scripts/affected-tests.mjs --files src/new file.ts --tier L1 --run",
        "npm run --silent check:static",
        "node scripts/affected-tests.mjs --files src/tracked.ts --tier L1 --run",
      ],
    );
    for (const seen of calls.filter((_, i) => i % 2 === 1))
      assert.doesNotMatch(seen, /GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX)\b/, seen);
    assert.equal(gitIn(linked, "rev-list", "--count", "HEAD").trim(), "3");
  },
);
