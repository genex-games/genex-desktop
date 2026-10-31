/**
 * A pull request into main that closes cancels what it left running: its own pull-request runs on
 * its head commit that have not finished. Never another commit's, another branch's, a push or
 * dispatch run, or the run doing the cancelling.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelLeftoverRuns, leftoverRuns } from "../../scripts/cancel-closed-pr-runs.mjs";

const REPO = "fixture/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const SELF = 900;

const run = (id: number, { event = "pull_request", status = "in_progress", sha = SHA, branch = "dev" } = {}) => ({
  id,
  event,
  status,
  head_sha: sha,
  head_branch: branch,
});

test("a closed pull request's unfinished runs on its head commit are left over", () => {
  const runs = [run(1), run(2, { status: "queued" }), run(3, { status: "waiting" }), run(4, { status: "completed" })];
  assert.deepEqual(leftoverRuns({ runs, sha: SHA, branch: "dev", self: SELF }), [1, 2, 3]);
});

test("another commit, branch or event, and the cancelling run itself, are never left over", () => {
  const rows = [
    { item: run(1, { event: "push" }), why: "a push run tests the commit itself" },
    { item: run(2, { event: "workflow_dispatch" }), why: "an owner's dispatch" },
    { item: run(3, { sha: OTHER_SHA }), why: "another commit" },
    { item: run(4, { branch: "feature" }), why: "another pull request at the same commit" },
    { item: run(SELF), why: "the run doing the cancelling" },
  ];
  for (const { item, why } of rows)
    assert.deepEqual(leftoverRuns({ runs: [item], sha: SHA, branch: "dev", self: SELF }), [], why);
});

/** A `gh` stand-in that lists `runs`, refuses to cancel the ids in `refuse`, and records every call. */
function fakeGh(runs: object[], refuse: number[] = []) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const cancel = args.at(-1)?.match(/\/runs\/(\d+)\/cancel$/);
    if (!cancel) return JSON.stringify({ workflow_runs: runs });
    if (refuse.includes(Number(cancel[1])))
      throw new Error("HTTP 409: Cannot cancel a workflow run that is completed.");
    return "";
  };
  return { gh, calls };
}

test("each left-over run is cancelled, and one that finished meanwhile does not stop the rest", () => {
  const { gh, calls } = fakeGh([run(1), run(2), run(3, { event: "push" })], [1]);
  const result = cancelLeftoverRuns({ repo: REPO, sha: SHA, branch: "dev", self: String(SELF), run: gh });
  assert.deepEqual(result, { cancelled: [2], failed: [1] });
  assert.deepEqual(calls, [
    ["api", `repos/${REPO}/actions/runs?event=pull_request&head_sha=${SHA}&per_page=100`],
    ["api", "--method", "POST", `repos/${REPO}/actions/runs/1/cancel`],
    ["api", "--method", "POST", `repos/${REPO}/actions/runs/2/cancel`],
  ]);
});

test("a malformed repository, commit, branch or run id reaches no API", () => {
  const valid = { repo: REPO, sha: SHA, branch: "dev", self: String(SELF) };
  const rows = [
    { repo: undefined },
    { repo: "" },
    { repo: "fixture" },
    { repo: "fixture/repo/actions" },
    { repo: "../repo" },
    { repo: "fixture/.." },
    { repo: "fixture/repo?per_page=1" },
    { sha: undefined },
    { sha: "HEAD" },
    { sha: SHA.slice(0, 7) },
    { sha: SHA.toUpperCase() },
    { sha: `${SHA}&event=push` },
    { branch: undefined },
    { branch: "" },
    { self: undefined },
    { self: "0" },
    { self: "-1" },
    { self: "1e3" },
    { self: "12 34" },
  ];
  for (const row of rows) {
    const { gh, calls } = fakeGh([run(1)]);
    assert.throws(() => cancelLeftoverRuns({ ...valid, ...row, run: gh }), /Invalid/, JSON.stringify(row));
    assert.deepEqual(calls, [], JSON.stringify(row));
  }
});
