/**
 * The Windows CI entry (`npm run test:windows`): the curated required suite stays a sorted list of
 * real, non-rig test files, and the informational fast-group pass turns node:test events into
 * per-file outcomes and a summary that names every failing file.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";
import reportOutcomes, { ERROR_CHARS } from "../../scripts/test-windows-reporter.mjs";
import {
  RUN_ALONE,
  readWindowsSuite,
  requiredBatches,
  runTests,
  SuiteProblem,
  suiteCandidates,
  suiteProblems,
  summarizeOutcomes,
} from "../../scripts/test-windows.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const known = {
  tests: ["tests/a.test.ts", "tests/b.test.ts", "tests/rig.test.ts"],
  rigs: ["tests/rig.test.ts"],
};

test("the checked-in Windows suite names only real, sorted, non-rig test files", () => {
  const suite = readWindowsSuite(repo);
  assert.ok(suite.length > 0);
  assert.ok(suite.includes("tests/conformance/sandbox-prepare.test.ts"));
});

test("a suite file that changes the whole machine runs alone, after every other file", () => {
  const alone = RUN_ALONE[0];
  const suite = ["tests/a.test.ts", alone, "tests/b.test.ts"];
  const batches = requiredBatches(suite);
  assert.deepEqual(
    batches.map((batch: { files: string[] }) => batch.files),
    [["tests/a.test.ts", "tests/b.test.ts"], [alone]],
  );
  assert.ok(batches[1].testArgs.includes("--test-concurrency=1"));
  assert.deepEqual(
    requiredBatches(["tests/a.test.ts"]).map((batch: { files: string[] }) => batch.files),
    [["tests/a.test.ts"]],
  );
  for (const file of RUN_ALONE) assert.ok(readWindowsSuite(repo).includes(file), `${file} is in the suite`);
});

test("a curated suite entry that is not a runnable fast test is refused with its reason", () => {
  const rows = [
    { entries: ["tests/missing.test.ts"], problem: SuiteProblem.NotATest },
    { entries: ["src/main/main.ts"], problem: SuiteProblem.NotATest },
    { entries: [42], problem: SuiteProblem.NotATest },
    { entries: ["tests/a.test.ts", "tests/a.test.ts"], problem: SuiteProblem.Duplicate },
    { entries: ["tests/b.test.ts", "tests/a.test.ts"], problem: SuiteProblem.Unsorted },
    { entries: ["tests/rig.test.ts"], problem: SuiteProblem.Rig },
  ];
  for (const { entries, problem } of rows)
    assert.deepEqual(
      suiteProblems(entries, known).map((p: { problem: string }) => p.problem),
      [problem],
      JSON.stringify(entries),
    );
  assert.deepEqual(suiteProblems(["tests/a.test.ts", "tests/b.test.ts"], known), []);
});

test("the reporter emits one outcome per finished test, and a failure's name and clipped cause", async () => {
  const file = path.join(repo, "tests", "a.test.ts");
  async function* events() {
    yield { type: "test:start", data: { name: "x", file } };
    yield { type: "test:pass", data: { name: "ok", file, details: { type: "test" } } };
    yield { type: "test:pass", data: { name: "skipped", file, skip: true, details: { type: "test" } } };
    yield { type: "test:pass", data: { name: "later", file, todo: "not yet", details: { type: "test" } } };
    const cause = new Error(`expected 1\n${"x".repeat(2_000)}`);
    const error = Object.assign(new Error("test failed"), { cause });
    yield { type: "test:fail", data: { name: "bad", file, details: { type: "test", error } } };
    yield { type: "test:fail", data: { name: "group", file, details: { type: "suite" } } };
    yield { type: "test:diagnostic", data: { message: "tests 3" } };
  }
  const lines: string[] = [];
  for await (const line of reportOutcomes(events())) lines.push(line);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { file, suite: false, outcome: "pass" },
      { file, suite: false, outcome: "skip" },
      { file, suite: false, outcome: "skip" },
      { file, suite: false, outcome: "fail", name: "bad", error: `expected 1\n${"x".repeat(ERROR_CHARS - 11)}` },
      { file, suite: true, outcome: "fail", name: "group", error: "" },
    ],
  );
});

test("the summary counts tests and lists failing and clean files once, repo-relative and sorted", () => {
  const at = (name: string) => path.join(repo, "tests", name);
  const outcomes = [
    { file: at("b.test.ts"), suite: false, outcome: "fail", name: "one", error: "boom" },
    { file: at("b.test.ts"), suite: false, outcome: "fail", name: "two", error: "bang" },
    { file: at("a.test.ts"), suite: false, outcome: "pass" },
    { file: at("a.test.ts"), suite: false, outcome: "skip" },
    // A file that crashes before any test reports one failure named after the file.
    { file: at("crash.test.ts"), suite: false, outcome: "fail", name: at("crash.test.ts"), error: "no module" },
    // A failed suite marks its file without counting as a test.
    { file: at("c.test.ts"), suite: true, outcome: "fail", name: "group", error: "" },
    { file: at("c.test.ts"), suite: false, outcome: "pass" },
    // A file whose every test skips on this platform is clean too.
    { file: at("posix-only.test.ts"), suite: false, outcome: "skip" },
  ];
  assert.deepEqual(summarizeOutcomes(outcomes, repo), {
    passed: 2,
    failed: 3,
    skipped: 2,
    files: 5,
    failingFiles: ["tests/b.test.ts", "tests/c.test.ts", "tests/crash.test.ts"],
    cleanFiles: ["tests/a.test.ts", "tests/posix-only.test.ts"],
    failures: [
      { file: "tests/b.test.ts", name: "one", error: "boom" },
      { file: "tests/b.test.ts", name: "two", error: "bang" },
      { file: "tests/crash.test.ts", name: at("crash.test.ts"), error: "no module" },
    ],
  });
});

test("clean fast files outside the curated suite are the candidates to add", () => {
  const summary = { cleanFiles: ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"] };
  assert.deepEqual(suiteCandidates(summary, ["tests/b.test.ts"]), ["tests/a.test.ts", "tests/c.test.ts"]);
});

test("a suite file that leaves a child running fails by name, and the run still ends", async () => {
  // A failed test that never stopped what it started held its file's process open, and with it
  // the whole required suite, until the job's own timeout.
  const RUN_CAP_MS = 60 * SECOND_MS;
  const root = await tmpDir("windows-suite-");
  const file = path.join(root, "leaks.test.mjs");
  await writeFile(
    file,
    [
      'import { spawn } from "node:child_process";',
      'import { test } from "node:test";',
      'test("starts a child", () => {',
      '  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "});",
      "",
    ].join("\n"),
  );
  const report = runTests(root, [file], { name: "leak", timeoutMs: RUN_CAP_MS, quiet: true });
  assert.equal(report.ended, "exit 1", "the run ended on its own, failing");
  // node:test reports the check's failure at its hook in the helper; its words name the file.
  const named = report.failures.some(({ error }) => /leaks\.test\.mjs left 1 child process/.test(String(error)));
  assert.ok(named, JSON.stringify(report.failures));
});
