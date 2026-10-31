import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `owner/name`, as GITHUB_REPOSITORY spells it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A full commit id, as the pull request event spells its head. */
const COMMIT = /^[0-9a-f]{40}$/;
/** A workflow run id, as GITHUB_RUN_ID spells it. */
const RUN_ID = /^[1-9][0-9]{0,18}$/;
/** The event of the runs a pull request starts on its own commits. */
const PULL_REQUEST_EVENT = "pull_request";
const COMPLETED = "completed";

/**
 * The runs a closed pull request leaves behind: its own pull-request runs on its head commit that
 * have not finished, except the run doing the cancelling. A pull request into main runs the billed
 * macOS and Windows checks; merged before they finish, they keep going beside main's own Check,
 * Package and the release, which need the same few macOS runners. Push and dispatch runs test a
 * commit itself and are never touched.
 *
 * @param {{ runs: Array<{ id: number, event: string, status: string, head_sha: string,
 *   head_branch: string | null }>, sha: string, branch: string, self: number }} input
 * @returns {number[]}
 */
export function leftoverRuns({ runs, sha, branch, self }) {
  return runs
    .filter((run) => run.event === PULL_REQUEST_EVENT && run.head_sha === sha && run.head_branch === branch)
    .filter((run) => run.status !== COMPLETED && run.id !== self)
    .map((run) => run.id);
}

/** @param {string[]} args */
const runGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Cancels the {@link leftoverRuns} of a closed pull request. A run that finished in the meantime
 * refuses the cancel; the others are still cancelled.
 *
 * @param {{ repo: string | undefined, sha: string | undefined, branch: string | undefined,
 *   self: string | undefined, run?: (args: string[]) => string }} input
 * @returns {{ cancelled: number[], failed: number[] }}
 */
export function cancelLeftoverRuns({ repo, sha, branch, self, run = runGh }) {
  if (!repo || !REPOSITORY.test(repo) || repo.includes("..")) throw new Error("Invalid repository");
  if (!sha || !COMMIT.test(sha)) throw new Error("Invalid commit");
  if (!branch) throw new Error("Invalid branch");
  if (!self || !RUN_ID.test(self)) throw new Error("Invalid run id");
  const listed = JSON.parse(
    run(["api", `repos/${repo}/actions/runs?event=${PULL_REQUEST_EVENT}&head_sha=${sha}&per_page=100`]),
  );
  /** @type {{ cancelled: number[], failed: number[] }} */
  const result = { cancelled: [], failed: [] };
  for (const id of leftoverRuns({ runs: listed.workflow_runs ?? [], sha, branch, self: Number(self) })) {
    try {
      run(["api", "--method", "POST", `repos/${repo}/actions/runs/${id}/cancel`]);
      result.cancelled.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Cancelling only frees runners, so nothing fails over it: a fork's read-only token, a run that
  // just finished or an unreadable API leaves the runs going.
  try {
    const { cancelled, failed } = cancelLeftoverRuns({
      repo: process.env.GITHUB_REPOSITORY,
      sha: process.env.PR_HEAD_SHA,
      branch: process.env.PR_HEAD_REF,
      self: process.env.GITHUB_RUN_ID,
    });
    console.log(cancelled.length ? `Cancelled runs ${cancelled.join(", ")}.` : "No unfinished runs to cancel.");
    if (failed.length) console.warn(`Could not cancel runs ${failed.join(", ")}.`);
  } catch (error) {
    console.warn(`Could not cancel this pull request's runs: ${error instanceof Error ? error.message : error}`);
  }
}
