/**
 * The Windows CI test entry (`npm run test:windows`, .github/workflows/windows.yml).
 *
 * 1. Required: node --test over tests/windows-suite.json, the files known to be meaningful on
 *    Windows. Its result is the exit code. The files in RUN_ALONE run after the others, one at a
 *    time.
 * 2. Informational: the rest of the fast group (files the suite does not list), with a per-test
 *    cap. It prints pass/fail counts, every failing file and test with its error, so the Windows
 *    backlog can be burned down, and never changes the exit code.
 *
 * `--suite-only` runs step 1 and `--report-only` step 2. Summaries go to stdout, to
 * $GITHUB_STEP_SUMMARY when set, and as JSON to .studio-dev/evidence/windows-tests/.
 */
import "./check-node.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importGraph, rigTests, TEST_PRELOAD, testEnv, testFiles } from "./affected-tests.mjs";
import { TestOutcome } from "./test-windows-reporter.mjs";

const SUITE_FILE = "tests/windows-suite.json";
const EVIDENCE_DIR = ".studio-dev/evidence/windows-tests";
const REPORTER = pathToFileURL(path.join(import.meta.dirname, "test-windows-reporter.mjs")).href;
/** One hung test must not eat the job: the informational pass caps each test and the whole run. */
const FAST_TEST_TIMEOUT_MS = 120_000;
const FAST_RUN_TIMEOUT_MS = 20 * 60_000;

/**
 * Suite files that change the whole machine: they reserve the sandbox's proxy ports (60080-60089)
 * as winnat does, so a sandbox another file starts meanwhile finds every port refused. They run
 * after the rest of the suite, one at a time.
 */
export const RUN_ALONE = Object.freeze(["tests/conformance/sandbox-windows-ports.test.ts"]);

/** Why a curated suite entry is refused, in its wire spelling. */
export const SuiteProblem = Object.freeze({
  NotATest: "not-a-test",
  Duplicate: "duplicate",
  Unsorted: "unsorted",
  Rig: "rig",
});

/**
 * Entries of the curated suite that break its rules: each must be a test file of this checkout,
 * listed once, in sorted order, and outside the serial rig group.
 * @param {unknown[]} entries
 * @param {{ tests: string[], rigs: string[] }} known
 */
export function suiteProblems(entries, { tests, rigs }) {
  const testSet = new Set(tests);
  const rigSet = new Set(rigs);
  return entries.flatMap((file, index) => {
    const repeated = entries.indexOf(file) !== index;
    const problem = entryProblem(file, entries[index - 1], { testSet, rigSet, repeated });
    return problem ? [{ file, problem }] : [];
  });
}

function entryProblem(file, previous, { testSet, rigSet, repeated }) {
  if (typeof file !== "string" || !testSet.has(file)) return SuiteProblem.NotATest;
  if (repeated) return SuiteProblem.Duplicate;
  if (rigSet.has(file)) return SuiteProblem.Rig;
  if (typeof previous === "string" && previous > file) return SuiteProblem.Unsorted;
  return null;
}

/** The curated Windows suite of the checkout at `root`; throws when any entry breaks the rules. */
export function readWindowsSuite(root) {
  const entries = JSON.parse(fs.readFileSync(path.join(root, SUITE_FILE), "utf8"));
  if (!Array.isArray(entries)) throw new Error(`${SUITE_FILE} must be a JSON array of test files`);
  const tests = testFiles(root);
  const listed = entries.filter((file) => tests.includes(file));
  const rigs = rigTests(root, importGraph(root, listed), listed);
  const problems = suiteProblems(entries, { tests, rigs });
  if (problems.length) {
    const lines = problems.map((p) => `  ${p.problem}: ${JSON.stringify(p.file)}`);
    throw new Error(`${SUITE_FILE} has entries to fix:\n${lines.join("\n")}`);
  }
  return entries;
}

/**
 * Counts per outcome over tests (suites excluded), the files with any failure, the clean ones
 * (every test passed or skipped) and each failed test with its error, repo-relative.
 * @param {{ file: string, suite: boolean, outcome: string, name?: string, error?: string }[]} outcomes
 */
export function summarizeOutcomes(outcomes, root) {
  const relative = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  const count = (outcome) => outcomes.filter((o) => !o.suite && o.outcome === outcome).length;
  const files = new Set(outcomes.map((o) => relative(o.file)));
  const failing = new Set(outcomes.filter((o) => o.outcome === TestOutcome.Fail).map((o) => relative(o.file)));
  return {
    passed: count(TestOutcome.Pass),
    failed: count(TestOutcome.Fail),
    skipped: count(TestOutcome.Skip),
    files: files.size,
    failingFiles: [...failing].sort(),
    cleanFiles: [...files].filter((file) => !failing.has(file)).sort(),
    failures: outcomes
      .filter((o) => !o.suite && o.outcome === TestOutcome.Fail)
      .map((o) => ({ file: relative(o.file), name: o.name, error: o.error })),
  };
}

/** The files of `files` that the curated suite does not list. */
export function unlisted(files, suite) {
  const listed = new Set(suite);
  return files.filter((file) => !listed.has(file));
}

/** Clean files of a run that the curated suite does not list yet. */
export const suiteCandidates = ({ cleanFiles }, suite) => unlisted(cleanFiles, suite);

/**
 * Run `files` under node --test: the spec reporter on stdout, the outcome reporter to a file. Each
 * file's process carries the leftover-children check, so a file that leaves a child running fails
 * by name and exits instead of holding the run open. `quiet` keeps the spec reporter's lines out of
 * this process's output (a test of this runner).
 */
export function runTests(root, files, { name, testArgs = [], timeoutMs, quiet = false }) {
  const outcomesPath = path.join(root, EVIDENCE_DIR, `${name}.jsonl`);
  fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
  fs.rmSync(outcomesPath, { force: true });
  const args = [
    ...TEST_PRELOAD,
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${REPORTER}`,
    `--test-reporter-destination=${outcomesPath}`,
    ...testArgs,
    ...files,
  ];
  const stdio = quiet ? "ignore" : "inherit";
  const run = spawnSync(process.execPath, args, { cwd: root, stdio, env: testEnv(), timeout: timeoutMs });
  const lines = fs.existsSync(outcomesPath) ? fs.readFileSync(outcomesPath, "utf8").split("\n") : [];
  const outcomes = lines.filter(Boolean).map((line) => JSON.parse(line));
  const report = {
    name,
    fileCount: files.length,
    ended: endedBy(run),
    status: run.status,
    ...summarizeOutcomes(outcomes, root),
  };
  fs.writeFileSync(path.join(root, EVIDENCE_DIR, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function endedBy(run) {
  if (run.error) return run.error.message;
  if (run.signal) return `terminated by ${run.signal}`;
  return `exit ${run.status}`;
}

/**
 * Print a report to the log and, on GitHub Actions, to the job summary.
 * @param {Array<[string, string[]]>} lists titled file lists; empty ones are left out
 */
function publish(title, report, lists) {
  const counts = `${report.fileCount} files; ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped (${report.ended})`;
  const sections = lists.filter(([, files]) => files.length).map(([name, files]) => listing(name, files));
  const text = [`## ${title}`, "", counts, "", ...sections].join("\n");
  console.log(`\n${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
}

const listing = (name, files) => [`${name} (${files.length}):`, "", ...files.map((f) => `- ${f}`), ""].join("\n");

/** One failed test for the summary: where, which, and the first line of why. */
const failureLine = ({ file, name, error }) => `${file} › ${name}: ${String(error ?? "").split("\n")[0]}`;

/** The required suite's runs, in order: every file but RUN_ALONE's together, then those alone. */
export function requiredBatches(suite) {
  const alone = suite.filter((file) => RUN_ALONE.includes(file));
  const batches = [{ name: "required", title: "Windows required suite", files: unlisted(suite, alone), testArgs: [] }];
  if (alone.length === 0) return batches;
  const title = "Windows required suite, files that run alone";
  return [...batches, { name: "required-alone", title, files: alone, testArgs: ["--test-concurrency=1"] }];
}

function runRequired(root, suite) {
  let status = 0;
  for (const { name, title, files, testArgs } of requiredBatches(suite)) {
    const report = runTests(root, files, { name, testArgs });
    publish(title, report, [["Failing files", report.failingFiles]]);
    if (report.status !== 0) status = 1;
  }
  return status;
}

function runInformational(root, suite) {
  try {
    const tests = testFiles(root);
    const rigs = new Set(rigTests(root, importGraph(root, tests), tests));
    // The required pass already ran the suite's files; the backlog is the rest of the fast group.
    const backlog = unlisted(
      tests.filter((file) => !rigs.has(file)),
      suite,
    );
    const report = runTests(root, backlog, {
      name: "fast-informational",
      testArgs: [`--test-timeout=${FAST_TEST_TIMEOUT_MS}`],
      timeoutMs: FAST_RUN_TIMEOUT_MS,
    });
    publish("Rest of the fast group on Windows (informational, never fails the job)", report, [
      ["Failing files", report.failingFiles],
      [`Clean, not yet in ${SUITE_FILE}`, suiteCandidates(report, suite)],
      ["Failing tests", report.failures.map(failureLine)],
    ]);
  } catch (error) {
    console.log(`Informational fast group did not complete: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  const root = process.cwd();
  const suite = readWindowsSuite(root);
  const status = args.has("--report-only") ? 0 : runRequired(root, suite);
  if (!args.has("--suite-only")) runInformational(root, suite);
  process.exitCode = status;
}
