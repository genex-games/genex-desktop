import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parseDurations } from "../../scripts/ci-durations.mjs";
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
  write("tests/conformance/rig-behavior.test.ts", "import { rig } from '../helpers/studio-rig.ts'; void rig;\n");
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

test("a full plan holds all of npm test once: fast and seed on Linux, fast, rig and harness on macOS", (t) => {
  const { root } = fixture(t);
  const plan = createCiPlan(root, { full: true });
  const rig = "tests/conformance/rig-behavior.test.ts";
  assert.equal(plan.full, true);
  assert.deepEqual(plan.changed, [], "a full plan compares against nothing");
  assert.deepEqual(plan.harness.files, [...HARNESS_GATE].sort());
  assert.deepEqual(plan.rig.files, [rig], "the harness gate's rig file runs in its own shards, not twice");
  assert.ok(!plan.fast.files.includes(rig));
  assert.deepEqual(
    new Set([...plan.unit.files, ...plan.seed.files, ...plan.harness.files]),
    new Set([...plan.fast.files, ...HARNESS_GATE]),
  );
  const tests = fs.globSync("tests/**/*.test.ts", { cwd: root }).sort();
  assert.deepEqual([...new Set([...plan.fast.files, ...plan.rig.files, ...plan.harness.files])].sort(), tests);
  assert.doesNotThrow(() => validateCiPlan(root, plan));
  const focused = createCiPlan(root, { changed: ["src/behavior.ts"] });
  assert.equal(focused.full, false);
  assert.deepEqual(focused.rig.files, [rig], "every plan carries the rig inventory");
  assert.deepEqual(focused.harness.files, []);
});

test("a full plan cannot drop a fast test or the harness, and no rig file may run as a fast or harness test", (t) => {
  const { root } = fixture(t);
  const plan = createCiPlan(root, { full: true });
  const missing = "tests/conformance/behavior.test.ts";
  const narrowed = structuredClone(plan);
  narrowed.unit.files = narrowed.unit.files.filter((file) => file !== missing);
  narrowed.unit.shards = narrowed.unit.shards
    .map((shard) => ({ ...shard, files: shard.files.filter((file) => file !== missing) }))
    .filter((shard) => shard.files.length);
  assert.throws(() => validateCiPlan(root, narrowed), /full plans/);
  assert.throws(() => validateCiPlan(root, { ...plan, harness: { files: [], roots: [], shards: [] } }), /full plans/);
  const overlapping = structuredClone(plan);
  overlapping.rig.files = [...overlapping.rig.files, missing].sort();
  overlapping.rig.shards[0].files = [...overlapping.rig.shards[0].files, missing].sort();
  assert.throws(() => validateCiPlan(root, overlapping), /overlap/);
  assert.throws(() => validateCiPlan(root, { ...plan, full: "yes" }), /full/);
});

test("a rig worker runs its files one at a time", (t) => {
  const { root, write } = fixture(t);
  const plan = createCiPlan(root, { full: true });
  write(
    "scripts/test.mjs",
    `import fs from 'node:fs'; fs.writeFileSync('worker-args.json', JSON.stringify(process.argv.slice(2)));`,
  );
  assert.equal(runCiShard(root, plan, "rig", 1), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "worker-args.json"), "utf8")), [
    "--test-concurrency=1",
    "tests/conformance/rig-behavior.test.ts",
  ]);
});

test("a rig worker asked for its times adds the durations reporter beside the spec one", (t) => {
  const { root, write } = fixture(t);
  const plan = createCiPlan(root, { full: true });
  write(
    "scripts/test.mjs",
    `import fs from 'node:fs'; fs.writeFileSync('worker-args.json', JSON.stringify(process.argv.slice(2)));`,
  );
  assert.ok(!fs.existsSync(path.join(root, ".studio-dev/ci")));
  assert.equal(runCiShard(root, plan, "rig", 1, { durations: ".studio-dev/ci/rig-1.json" }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "worker-args.json"), "utf8")), [
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=./scripts/ci-durations-reporter.mjs",
    "--test-reporter-destination=.studio-dev/ci/rig-1.json",
    "tests/conformance/rig-behavior.test.ts",
  ]);
  // node --test opens a reporter destination without creating its folder.
  assert.ok(fs.statSync(path.join(root, ".studio-dev/ci")).isDirectory());
});

test("recorded times balance the rig shards; a file without one weighs its bytes at their rate", (t) => {
  const { root, write } = fixture(t);
  const rigFile = (name: string, bytes: number) =>
    write(
      `tests/conformance/${name}.test.ts`,
      `import { rig } from '../helpers/studio-rig.ts'; void rig;\n// ${"x".repeat(bytes)}\n`,
    );
  rigFile("rig-large-a", 4000);
  rigFile("rig-large-b", 4000);
  rigFile("rig-slow", 10);
  const shardOf = (plan: ReturnType<typeof createCiPlan>, file: string) =>
    plan.rig.shards.find((shard) => shard.files.includes(file))?.files;
  const slow = "tests/conformance/rig-slow.test.ts";
  const bySize = createCiPlan(root, { full: true, shards: 2 });
  assert.notDeepEqual(shardOf(bySize, slow), [slow], "source bytes pair the small, slow file with others");
  const durations = {
    [slow]: 600_000,
    "tests/conformance/rig-large-a.test.ts": 1_000,
    "tests/conformance/rig-large-b.test.ts": 1_000,
  };
  const byTime = createCiPlan(root, { full: true, shards: 2, durations });
  assert.deepEqual(shardOf(byTime, slow), [slow]);
  assert.deepEqual(byTime.rig.files, bySize.rig.files, "times move files between shards, never drop one");
  assert.doesNotThrow(() => validateCiPlan(root, byTime));
  assert.deepEqual(byTime.fast, bySize.fast, "only the rig shards follow recorded times");
});

test("recorded times are refused unless every entry is a test path with a plausible time", () => {
  const ok = { "tests/conformance/a.test.ts": 1200 };
  assert.deepEqual(parseDurations(ok), ok);
  for (const value of [
    null,
    [],
    "tests/conformance/a.test.ts",
    { "../tests/a.test.ts": 1 },
    { "tests/../src/a.test.ts": 1 },
    { "/tmp/tests/a.test.ts": 1 },
    { "tests/conformance/a.ts": 1 },
    { "tests/conformance/a.test.ts": -1 },
    { "tests/conformance/a.test.ts": Number.NaN },
    { "tests/conformance/a.test.ts": Number.POSITIVE_INFINITY },
    { "tests/conformance/a.test.ts": "12" },
    { "tests/conformance/a.test.ts": 7 * 60 * 60 * 1000 },
  ])
    assert.throws(() => parseDurations(value), /Invalid test duration/, JSON.stringify(value));
});

test("the durations reporter writes each file's top-level time, relative to the working directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ci-durations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(
    path.join(root, "tests/timed.test.ts"),
    "import { describe, it } from 'node:test';\nimport { setTimeout } from 'node:timers/promises';\n" +
      "describe('suite', () => { it('waits', () => setTimeout(30)); it('again', () => setTimeout(30)); });\n" +
      "it('alone', () => setTimeout(30));\n",
  );
  const out = path.join(root, "times.json");
  const run = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-reporter=${path.join(repo, "scripts/ci-durations-reporter.mjs")}`,
      `--test-reporter-destination=${out}`,
      "tests/timed.test.ts",
    ],
    // Without this the child would report to this test's runner instead of its own reporters.
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(run.status, 0, run.stderr);
  const times = parseDurations(JSON.parse(fs.readFileSync(out, "utf8")));
  assert.deepEqual(Object.keys(times), ["tests/timed.test.ts"]);
  assert.ok(times["tests/timed.test.ts"] >= 90, `suite and test both counted once: ${times["tests/timed.test.ts"]}`);
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
  const full = cli("plan", "--full", "--output", output, "--github-output", githubOutput);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).full, true);
  assert.match(fs.readFileSync(githubOutput, "utf8"), /rig_matrix=\{"include":\[\{"shard":1\}\]\}/);
  assert.notEqual(cli("plan", "--full", "--base", "HEAD", "--output", output).status, 0, "a full plan has no base");
  assert.notEqual(cli("plan", "--full", "--full", "--output", output).status, 0);
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
  const regression = {
    validate: { result: "success" },
    plan: { result: "success" },
    "fast-evidence": { result: "success", outputs: { reuse: "false" } },
    "regression-rig": { result: "success" },
    "regression-harness": { result: "success" },
    "regression-fast": { result: "success" },
    "regression-e2e": { result: "success" },
  };
  assert.doesNotThrow(() => assertCiResults(regression, "regression"));
  for (const name of Object.keys(regression))
    for (const result of ["failure", "cancelled", "skipped", undefined])
      assert.throws(() => assertCiResults({ ...regression, [name]: { result } }, "regression"), Error, name);
  // Check's passed macOS fast job on the same commit stands in for the skipped fast shards, and
  // only then: a skipped fast lane without that evidence, or a missing decision, fails closed.
  const reused = {
    ...regression,
    "fast-evidence": { result: "success", outputs: { reuse: "true" } },
    "regression-fast": { result: "skipped" },
  };
  assert.doesNotThrow(() => assertCiResults(reused, "regression"));
  assert.throws(() => assertCiResults({ ...reused, "regression-fast": { result: "success" } }, "regression"));
  assert.throws(() => assertCiResults({ ...regression, "fast-evidence": { result: "success" } }, "regression"));
  assert.throws(() => assertCiResults(complete, "unknown"), /lane/);
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
