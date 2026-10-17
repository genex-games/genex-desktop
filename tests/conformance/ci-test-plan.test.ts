import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CI_BASELINE, createCiPlan, runCiShard, validateCiPlan } from "../../scripts/ci-test-plan.mjs";
import { HARNESS_GATE, testEnv } from "../../scripts/affected-tests.mjs";
import { assertCiResults } from "../../scripts/ci-check-result.mjs";
import {
  createHarnessPlan,
  harnessCommands,
  harnessRoots,
  validateHarnessPlan,
  createSeedPlan,
  seedCommands,
  validateSeedPlan,
} from "../../scripts/ci-harness-shards.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const script = path.join(repo, "scripts/ci-test-plan.mjs");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ci-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "nodenext", allowJs: true } }));
  write("src/behavior.ts", "export const behavior = 1;\n");
  write("src/harness-seed/loop/main.ts", "export const harness = 1;\n");
  write("tests/helpers/studio-rig.ts", "export const rig = 1;\n");
  for (const file of [...CI_BASELINE, ...HARNESS_GATE]) write(file, "export {};\n");
  write(CI_BASELINE[0], "import { it } from 'node:test'; it('seed fixture', () => {});\n");
  write(
    HARNESS_GATE[0],
    "import { rig } from '../helpers/studio-rig.ts'; import { it } from 'node:test'; it('incident', () => { void rig; });\n",
  );
  write("tests/conformance/behavior.test.ts", "import { behavior } from '../../src/behavior.ts'; void behavior;\n");
  write("tests/test-map.json", JSON.stringify({ map: { "src/behavior.ts": [CI_BASELINE[0]] } }));
  write("scripts/test.mjs", "process.exit(Number(process.env.FIXTURE_EXIT ?? 0));\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: testEnv(), stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return { root, write };
}

test("CI combines mandatory and affected tests once, then partitions every file exactly once", (t) => {
  const { root } = fixture(t);
  const plan = createCiPlan(root, { changed: ["src/behavior.ts"], shards: 6 });
  assert.deepEqual(plan.unit.files, [...CI_BASELINE.slice(1), "tests/conformance/behavior.test.ts"].sort());
  assert.deepEqual(plan.unit.shards.flatMap((shard) => shard.files).sort(), plan.unit.files);
  assert.equal(plan.unit.shards.filter((shard) => shard.files.includes(CI_BASELINE[0])).length, 0);
  assert.deepEqual(plan.seed.files, [CI_BASELINE[0]], "seed contracts have their own mandatory workers");
  assert.deepEqual(plan.harness.files, []);
  assert.ok(plan.fast.files.includes("tests/conformance/behavior.test.ts"));
  assert.ok(!plan.fast.files.includes(HARNESS_GATE[0]), "macOS fast still excludes rigs");
  assert.deepEqual(createCiPlan(root, { changed: ["src/behavior.ts"], shards: 6 }), plan);
  assert.doesNotThrow(() => validateCiPlan(root, plan));
});

test("a harness change retains both mandatory gate files with no duplicate Linux execution", (t) => {
  const { root } = fixture(t);
  const plan = createCiPlan(root, { changed: ["src/harness-seed/loop/main.ts", HARNESS_GATE[1]] });
  assert.deepEqual(plan.harness.files, [...HARNESS_GATE].sort());
  assert.ok(HARNESS_GATE.every((file) => !plan.unit.files.includes(file)));
  assert.deepEqual(
    new Set([...plan.unit.files, ...plan.seed.files, ...plan.harness.files]),
    new Set([...CI_BASELINE, ...HARNESS_GATE]),
  );
});

test("a scoreboard-only L1 change does not activate the full L3 harness gate", (t) => {
  const { root } = fixture(t);
  const plan = createCiPlan(root, { changed: [HARNESS_GATE[1]] });
  assert.deepEqual(plan.harness.files, []);
  assert.deepEqual(plan.unit.files, [...CI_BASELINE.slice(1), HARNESS_GATE[1]].sort());
});

test("global runner, dependency and check inputs retain every fast test and the full harness gate", (t) => {
  const { root } = fixture(t);
  const globalInputs = [
    ".github/workflows/check.yml",
    "scripts/test.mjs",
    "scripts/test-runtime.mjs",
    "scripts/affected-tests.mjs",
    "scripts/ci-test-plan.mjs",
    "scripts/ci-check-result.mjs",
    "scripts/ci-harness-shards.mjs",
    "scripts/check-node.mjs",
    "package.json",
    "package-lock.json",
    ".nvmrc",
    ".npmrc",
    "tsconfig.json",
    "tsconfig.harness.json",
    "tests/helpers/leftover-children.ts",
    "tests/helpers/processes.ts",
    "tests/test-map.json",
  ];
  for (const file of globalInputs) {
    const plan = createCiPlan(root, { changed: [file] });
    assert.deepEqual(plan.globalChanges, [file]);
    assert.deepEqual(plan.harness.files, [...HARNESS_GATE].sort());
    assert.deepEqual(
      new Set([...plan.unit.files, ...plan.seed.files, ...plan.harness.files]),
      new Set([...plan.fast.files, ...HARNESS_GATE]),
    );
    assert.ok(
      plan.unit.files.includes("tests/conformance/behavior.test.ts"),
      `${file} selects unrelated fast behavior too`,
    );
  }
});

test("deleting a global input still selects full coverage while ordinary product edits remain focused", (t) => {
  const { root, write } = fixture(t);
  const deleted = "tests/helpers/leftover-children.ts";
  write(deleted, "export {};\n");
  fs.rmSync(path.join(root, deleted));
  const global = createCiPlan(root, { changed: [deleted] });
  assert.deepEqual(global.globalChanges, [deleted]);
  assert.ok(global.harness.files.length > 0);
  const focused = createCiPlan(root, { changed: ["src/behavior.ts"] });
  assert.deepEqual(focused.globalChanges, []);
  assert.deepEqual(focused.harness.files, []);
  assert.deepEqual(focused.unit.files, [...CI_BASELINE.slice(1), "tests/conformance/behavior.test.ts"].sort());
});

test("renaming a global runner still selects full coverage from the deleted old path", (t) => {
  const { root } = fixture(t);
  execFileSync("git", ["mv", "scripts/test.mjs", "scripts/renamed-test.mjs"], { cwd: root, env: testEnv() });
  const plan = createCiPlan(root, { base: "HEAD" });
  assert.deepEqual(plan.globalChanges, ["scripts/test.mjs"]);
  assert.ok(plan.changed.includes("scripts/renamed-test.mjs"));
  assert.ok(plan.harness.files.length > 0);
  assert.ok(plan.unit.files.includes("tests/conformance/behavior.test.ts"));
});

test("a global plan cannot drop a fast test or the harness while keeping its internal shards consistent", (t) => {
  const { root } = fixture(t);
  const plan = createCiPlan(root, { changed: ["package-lock.json"] });
  const narrowed = structuredClone(plan);
  const missing = "tests/conformance/behavior.test.ts";
  narrowed.unit.files = narrowed.unit.files.filter((file) => file !== missing);
  narrowed.unit.shards = narrowed.unit.shards
    .map((shard) => ({ ...shard, files: shard.files.filter((file) => file !== missing) }))
    .filter((shard) => shard.files.length);
  assert.throws(() => validateCiPlan(root, narrowed), /Global CI inputs/);
  const withoutHarness = { ...plan, harness: { files: [], roots: [], shards: [] } };
  assert.throws(() => validateCiPlan(root, withoutHarness), /Global CI inputs/);
});

test("malformed, incomplete, repeated, escaped and missing-file plans fail before a worker starts", (t) => {
  const { root } = fixture(t);
  const original = createCiPlan(root, { changed: [] });
  for (const mutate of [
    (plan: typeof original) => {
      plan.version = 99;
    },
    (plan: typeof original) => {
      plan.unit.shards.pop();
    },
    (plan: typeof original) => {
      plan.unit.shards[0].files.push(plan.unit.files[0]);
    },
    (plan: typeof original) => {
      plan.unit.files.push("../outside.test.ts");
    },
    (plan: typeof original) => {
      plan.fast.files.push("tests/conformance/missing.test.ts");
    },
    (plan: typeof original) => {
      plan.revision = "wrong-checkout";
    },
  ]) {
    const plan = structuredClone(original);
    mutate(plan);
    assert.throws(() => validateCiPlan(root, plan));
  }
  fs.rmSync(path.join(root, CI_BASELINE[0]));
  assert.throws(() => createCiPlan(root, { changed: [] }), /missing|exist/i);
});

test("shard execution preserves nonzero results and refuses unknown or empty assignments", (t) => {
  const { root, write } = fixture(t);
  const plan = createCiPlan(root, { changed: [] });
  write("scripts/test.mjs", "process.exit(7);\n");
  assert.equal(runCiShard(root, plan, "unit", 1), 7);
  assert.throws(() => runCiShard(root, plan, "unit", 999), /shard/i);
  assert.throws(() => runCiShard(root, plan, "harness", 1), /shard/i);
  assert.throws(() => runCiShard(root, plan, "unknown", 1), /group/i);
});

test("the CLI refuses a bad base and emits one reusable plan with matrix outputs", (t) => {
  const { root } = fixture(t);
  const output = path.join(root, "plan.json");
  const githubOutput = path.join(root, "github-output");
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, env: testEnv(), encoding: "utf8" });
  const failed = cli("plan", "--base", "missing-ref", "--output", output);
  assert.notEqual(failed.status, 0);
  assert.equal(fs.existsSync(output), false);
  const passed = cli("plan", "--base", "HEAD", "--output", output, "--github-output", githubOutput);
  assert.equal(passed.status, 0, passed.stderr);
  const plan = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.doesNotThrow(() => validateCiPlan(root, plan));
  const outputs = fs.readFileSync(githubOutput, "utf8");
  assert.match(outputs, /harness_selected=false/);
  const matrix = JSON.parse(
    outputs
      .split("\n")
      .find((line) => line.startsWith("unit_matrix="))
      ?.slice("unit_matrix=".length) ?? "{}",
  );
  assert.deepEqual(
    matrix.include.map((row: { shard: number }) => row.shard),
    plan.unit.shards.map((shard: { id: number }) => shard.id),
  );
  assert.notEqual(cli("run", "--plan", output, "--group", "unit", "--shard", "0").status, 0);
});

test("stable gate names fail closed on failed, cancelled, skipped or absent required jobs", () => {
  const complete = {
    plan: { result: "success", outputs: { harness_selected: "true" } },
    static: { result: "success" },
    unit: { result: "success" },
    seed: { result: "success" },
    harness: { result: "success" },
    "fast-tests": { result: "success" },
  };
  assert.doesNotThrow(() => assertCiResults(complete, "gate"));
  assert.doesNotThrow(() => assertCiResults(complete, "fast"));
  for (const name of ["plan", "static", "unit", "seed", "harness"] as const) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      assert.throws(() => assertCiResults({ ...complete, [name]: { result } }, "gate"));
    }
  }
  const unselected = {
    ...complete,
    plan: { result: "success", outputs: { harness_selected: "false" } },
    harness: { result: "skipped" },
  };
  assert.doesNotThrow(() => assertCiResults(unselected, "gate"));
  assert.throws(() => assertCiResults({ ...unselected, harness: { result: "success" } }, "gate"));
  assert.throws(() => assertCiResults({ ...complete, plan: { result: "success" } }, "gate"));
  assert.throws(() => assertCiResults({ ...complete, "fast-tests": { result: "cancelled" } }, "fast"));
});

test("a worker receives only its planned files and an explicit concurrency, and signal exits fail", (t) => {
  const { root, write } = fixture(t);
  const plan = createCiPlan(root, { changed: [] });
  write(
    "scripts/test.mjs",
    `import fs from 'node:fs'; fs.writeFileSync('worker-args.json', JSON.stringify(process.argv.slice(2)));`,
  );
  assert.equal(runCiShard(root, plan, "unit", 1), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "worker-args.json"), "utf8")), [
    "--test-concurrency=2",
    ...plan.unit.shards[0].files,
  ]);
  write("scripts/test.mjs", "process.kill(process.pid, 'SIGTERM');");
  assert.notEqual(runCiShard(root, plan, "unit", 1), 0);
});

test("bounded harness workers execute every nested and parameterized case and its hooks exactly once", (t) => {
  const { root, write } = fixture(t);
  write(
    HARNESS_GATE[0],
    String.raw`import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
const record = (value) => fs.appendFileSync('ledger.jsonl', value + '\n');
describe('first [x]', () => {
  beforeEach(() => record('before-first'));
  afterEach(() => record('after-first'));
  for (const name of ['a', 'b']) it(name, () => { record('first-' + name); if (process.env.FAIL_CASE) throw new Error('fixture failure'); });
});
describe('second (root)', () => { describe('nested', () => { it('c', () => record('second-c')); }); });
it('third .*', () => { const value = { it: 'third' }; record(value.it); });
describe('fourth $', () => { it('d', () => record('fourth-d')); });
describe('fifth |', () => { it('e', () => record('fifth-e')); });
`,
  );
  write(
    HARNESS_GATE[1],
    String.raw`import { it } from 'node:test'; import fs from 'node:fs'; it('scoreboard', () => fs.appendFileSync('ledger.jsonl', 'scoreboard\n'));`,
  );
  const ledger = path.join(root, "ledger.jsonl");
  const run = (args: string[], fail = false) =>
    spawnSync(process.execPath, ["--test", ...args], {
      cwd: root,
      env: testEnv({ ...process.env, ...(fail ? { FAIL_CASE: "1" } : {}) }),
      encoding: "utf8",
    });
  const full = run(["--test-concurrency=1", ...HARNESS_GATE]);
  assert.equal(full.status, 0, full.stderr + full.stdout);
  const expected = fs.readFileSync(ledger, "utf8").trim().split("\n").sort();
  assert.equal(expected.length, 11, "seven cases and four per-case hooks actually ran");
  fs.rmSync(ledger);
  const plan = createHarnessPlan(root, true);
  assert.equal(plan.shards.length, 5);
  assert.doesNotThrow(() => validateHarnessPlan(root, plan));
  for (const shard of plan.shards)
    for (const args of harnessCommands(shard)) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr + result.stdout);
    }
  assert.deepEqual(fs.readFileSync(ledger, "utf8").trim().split("\n").sort(), expected);
  const failing = plan.shards.find((shard) => shard.names.includes("first [x]"));
  assert.ok(failing);
  assert.notEqual(run(harnessCommands(failing)[0], true).status, 0, "a selected incident failure fails its shard");
  for (const mutate of [
    (value: typeof plan) => {
      value.roots.pop();
    },
    (value: typeof plan) => {
      value.shards[0].names.push(value.roots[0]);
    },
    (value: typeof plan) => {
      value.shards[0].names = [];
    },
    (value: typeof plan) => {
      value.shards[0].scoreboard = false;
    },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => validateHarnessPlan(root, changed));
  }
});

test("unsupported or ambiguous incident registration fails planning instead of omitting tests", (t) => {
  const { root, write } = fixture(t);
  const unsupported = [
    "const name = 'dynamic'; it(name, () => {});",
    "it.only('exclusive', () => {});",
    "describe('outer', () => { it.only('inner', () => {}); });",
    "for (const name of ['loop']) it(name, () => {});",
    "function register() { it('hidden', () => {}); } register();",
    "const register = it; register('alias', () => {});",
    "it('same', () => {}); it('same', () => {});",
    "describe('prefix', () => {}); it('prefix child', () => {});",
    "",
  ];
  for (const body of unsupported) {
    write(HARNESS_GATE[0], `import { describe, it } from 'node:test';\n${body}`);
    assert.throws(() => harnessRoots(root), Error, body);
  }
});

test("the known large harness group splits complete direct cases with per-case hooks and runtime subtests", (t) => {
  const { root, write } = fixture(t);
  write(
    HARNESS_GATE[0],
    String.raw`import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
const record = (text) => fs.appendFileSync('ledger.jsonl', text + '\n');
describe('harness incidents', () => {
  beforeEach(() => record('before incident'));
  afterEach(() => record('after incident'));
  it('first [x]', async (t) => { record('first'); await t.test('runtime child', () => record('runtime')); });
  it('second |', () => record('second'));
  it('third $', () => record('third'));
});
describe('other root', () => { for (const name of ['a', 'b']) it(name, () => record(name)); });
it('fifth', () => record('fifth'));
it('sixth', () => record('sixth'));
`,
  );
  write(HARNESS_GATE[1], "import { it } from 'node:test'; it('scoreboard', () => {});");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--test", ...args], { cwd: root, env: testEnv(), encoding: "utf8" });
  assert.equal(run(["--test-concurrency=1", HARNESS_GATE[0]]).status, 0);
  const ledger = path.join(root, "ledger.jsonl");
  const expected = fs.readFileSync(ledger, "utf8").trim().split("\n").sort();
  fs.rmSync(ledger);
  const plan = createHarnessPlan(root, true);
  assert.equal(plan.shards.length, 6);
  assert.ok(!plan.roots.includes("harness incidents"));
  assert.ok(plan.roots.includes("harness incidents first [x]"));
  for (const shard of plan.shards)
    for (const args of harnessCommands(shard)) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr + result.stdout);
    }
  assert.deepEqual(fs.readFileSync(ledger, "utf8").trim().split("\n").sort(), expected);
  for (const unsafe of [
    "before(() => {}); it('one', () => {});",
    "after(() => {}); it('one', () => {});",
    "const shared = []; it('one', () => shared.push(1));",
    "for (const n of ['one']) it(n, () => {});",
  ]) {
    write(
      HARNESS_GATE[0],
      `import { describe, it, before, after } from 'node:test'; describe('harness incidents', () => { ${unsafe} });`,
    );
    assert.throws(() => createHarnessPlan(root, true), Error, unsafe);
  }
});

test("seed roots stay whole across three source-order shards including a prefix root's once hooks", (t) => {
  const { root, write } = fixture(t);
  write(
    CI_BASELINE[0],
    String.raw`import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
const record = (text) => fs.appendFileSync('seed-ledger.jsonl', text + '\n');
describe('seed upgrade', () => {
  before(() => record('before root'));
  after(() => record('after root'));
  beforeEach(() => record('before case'));
  afterEach(() => record('after case'));
  it('first [x]', async (t) => { record('first'); await t.test('runtime', () => record('runtime')); });
  it('second $', () => record('second'));
});
describe('seed upgrade across a vintage', () => { it('links', () => record('vintage')); });
describe('a third root', () => { for (const n of ['a', 'b']) it(n, () => record(n)); });
it('a fourth root', () => record('fourth'));
`,
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--test", ...args], { cwd: root, env: testEnv(), encoding: "utf8" });
  const full = run(["--test-concurrency=1", CI_BASELINE[0]]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const ledger = path.join(root, "seed-ledger.jsonl");
  const expected = fs.readFileSync(ledger, "utf8").trim().split("\n").sort();
  fs.rmSync(ledger);
  const plan = createSeedPlan(root);
  assert.equal(plan.shards.length, 3);
  assert.deepEqual(plan.shards[0].names, ["seed upgrade", "a fourth root"]);
  assert.doesNotThrow(() => validateSeedPlan(root, plan));
  for (const shard of plan.shards) {
    const result = run(seedCommands(root, shard)[0]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(fs.readFileSync(ledger, "utf8").trim().split("\n").sort(), expected);
  const omitted = structuredClone(plan);
  omitted.shards[0].names.pop();
  assert.throws(() => validateSeedPlan(root, omitted));
  write(
    CI_BASELINE[0],
    "import { describe, it } from 'node:test'; describe('seed upgrade', () => { it('across vintage', () => {}); }); describe('seed upgrade across vintage', () => { it('child', () => {}); });",
  );
  assert.throws(() => createSeedPlan(root), /Ambiguous/);
});
