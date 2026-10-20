/**
 * A release reuses the macOS fast inventory only when Check's push or dispatch run on the same commit
 * passed its `fast` job; a pull-request run, a failed or skipped job, or no run at all runs it again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awaitFastEvidence,
  FastEvidence,
  fastEvidence,
  START_GRACE_MS,
  WAIT_MAX_MS,
} from "../../scripts/release-fast-evidence.mjs";

const REPO = "fixture/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CHECK = ".github/workflows/check.yml";

const run = (id: number, event = "push", status = "completed", path = CHECK) => ({ id, event, status, path });
const fast = (status: string, conclusion: string | null) => [
  { name: "fast-tests (1)", status: "completed", conclusion: "success" },
  { name: "fast", status, conclusion },
];

test("a passed fast job of Check's push or dispatch run on the commit is reused", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const decision = fastEvidence({ runs: [run(1, event)], jobs: { 1: fast("completed", "success") }, elapsedMs: 0 });
    assert.equal(decision, FastEvidence.Reuse, event);
  }
});

test("only a check.yml run of the commit itself counts: a pull-request run or another workflow is not", () => {
  const rows = [
    { runs: [run(1, "pull_request")], why: "a pull-request run tests a merge with its base" },
    { runs: [run(1, "push", "completed", ".github/workflows/rig.yml")], why: "another workflow" },
    { runs: [run(1, "schedule")], why: "a scheduled run is not asked for this commit" },
  ];
  for (const { runs, why } of rows) {
    const decision = fastEvidence({ runs, jobs: { 1: fast("completed", "success") }, elapsedMs: START_GRACE_MS });
    assert.equal(decision, FastEvidence.Run, why);
  }
});

test("a failed, cancelled or skipped fast job runs the inventory again", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    const decision = fastEvidence({ runs: [run(1)], jobs: { 1: fast("completed", conclusion) }, elapsedMs: 0 });
    assert.equal(decision, FastEvidence.Run, String(conclusion));
  }
  const noFastJob = fastEvidence({ runs: [run(1)], jobs: { 1: [] }, elapsedMs: 0 });
  assert.equal(noFastJob, FastEvidence.Run, "a finished run without a fast job (a dev push)");
});

test("a running Check is waited for until its limit; a missing one only for the start grace", () => {
  const running = { runs: [run(1, "push", "in_progress")], jobs: { 1: fast("queued", null) } };
  assert.equal(fastEvidence({ ...running, elapsedMs: WAIT_MAX_MS - 1 }), FastEvidence.Wait);
  assert.equal(fastEvidence({ ...running, elapsedMs: WAIT_MAX_MS }), FastEvidence.Run);
  assert.equal(fastEvidence({ runs: [], jobs: {}, elapsedMs: START_GRACE_MS - 1 }), FastEvidence.Wait);
  assert.equal(fastEvidence({ runs: [], jobs: {}, elapsedMs: START_GRACE_MS }), FastEvidence.Run);
});

test("a re-run that passed counts even beside an earlier failed run on the same commit", () => {
  const runs = [run(1), run(2)];
  const jobs = { 1: fast("completed", "failure"), 2: fast("completed", "success") };
  assert.equal(fastEvidence({ runs, jobs, elapsedMs: 0 }), FastEvidence.Reuse);
});

test("polling asks GitHub for the commit's runs, waits on its own clock and refuses bad input", async () => {
  let clock = 0;
  const calls: string[][] = [];
  const answers = [
    { workflow_runs: [run(7, "push", "in_progress")] },
    { jobs: fast("in_progress", null) },
    { workflow_runs: [run(7)] },
    { jobs: fast("completed", "success") },
  ];
  const gh = (args: string[]) => {
    calls.push(args);
    return JSON.stringify(answers.shift());
  };
  const decision = await awaitFastEvidence({
    repo: REPO,
    sha: SHA,
    run: gh,
    wait: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(decision, FastEvidence.Reuse);
  assert.deepEqual(calls[0], ["api", `repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`]);
  assert.deepEqual(calls[1], ["api", `repos/${REPO}/actions/runs/7/jobs?per_page=100`]);
  assert.equal(calls.length, 4);
  for (const [repo, sha] of [
    ["../repo", SHA],
    ["a/b/c", SHA],
    [REPO, "HEAD"],
    [REPO, `${SHA}&x=1`],
  ])
    await assert.rejects(awaitFastEvidence({ repo, sha, run: gh }), /Invalid/);
});
