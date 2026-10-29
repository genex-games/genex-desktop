import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MINUTE_MS, SECOND_MS } from "../src/shared/duration.ts";

/** `owner/name`, as GITHUB_REPOSITORY spells it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A full commit id, as GITHUB_SHA spells it. */
const COMMIT = /^[0-9a-f]{40}$/;
/** The workflow whose `fast` job runs the complete macOS fast inventory. */
const CHECK_WORKFLOW = ".github/workflows/check.yml";
const FAST_JOB = "fast";
/** Events whose Check run tests the commit itself; a pull_request run tests a merge with its base. */
const OWN_COMMIT_EVENTS = ["push", "workflow_dispatch"];
/** How long a release waits for that Check run to finish before running the inventory itself. */
const WAIT_MAX_MS = 40 * MINUTE_MS;
/** How long a missing Check run may still be about to start (both start on one push to main). */
const START_GRACE_MS = 3 * MINUTE_MS;
const POLL_MS = 30 * SECOND_MS;

/** What a release does about the macOS fast inventory on its commit. */
export const FastEvidence = { Reuse: "reuse", Run: "run", Wait: "wait" };
export { START_GRACE_MS, WAIT_MAX_MS };

/**
 * Decides from the Check runs on the release commit. A push or dispatch run tests the commit itself;
 * the same commit carries the same check.yml, whose `fast` job runs every fast test on macOS
 * whatever changed, so its pass is the inventory the release would run. Anything else runs it here.
 * @param {{ runs: Array<{ id: number, path: string, event: string, status: string }>,
 *   jobs: Record<number, Array<{ name: string, status: string, conclusion: string | null }>>,
 *   elapsedMs: number }} input
 */
export function fastEvidence({ runs, jobs, elapsedMs }) {
  const pushes = runs.filter(testsOwnCommit);
  if (!pushes.length) return elapsedMs < START_GRACE_MS ? FastEvidence.Wait : FastEvidence.Run;
  const fast = pushes.map((run) => ({ run, job: (jobs[run.id] ?? []).find((job) => job.name === FAST_JOB) }));
  if (fast.some(({ job }) => job?.status === "completed" && job.conclusion === "success")) return FastEvidence.Reuse;
  const pending = fast.some(({ run, job }) => run.status !== "completed" && job?.status !== "completed");
  return pending && elapsedMs < WAIT_MAX_MS ? FastEvidence.Wait : FastEvidence.Run;
}

/** @param {{ path: string, event: string }} run */
const testsOwnCommit = (run) => run.path === CHECK_WORKFLOW && OWN_COMMIT_EVENTS.includes(run.event);

const runGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Polls the release commit's Check runs until {@link fastEvidence} decides; an API error throws.
 * @param {{ repo: string | undefined, sha: string | undefined, run?: (args: string[]) => string,
 *   wait?: (ms: number) => Promise<unknown>, now?: () => number }} input
 */
export async function awaitFastEvidence({ repo, sha, run = runGh, wait = sleep, now = Date.now }) {
  if (!REPOSITORY.test(repo ?? "") || repo.includes("..")) throw new Error("Invalid repository");
  if (!COMMIT.test(sha ?? "")) throw new Error("Invalid commit");
  const started = now();
  for (;;) {
    const listed = JSON.parse(run(["api", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`]));
    const runs = listed.workflow_runs ?? [];
    const jobs = {};
    for (const item of runs.filter(testsOwnCommit))
      jobs[item.id] = JSON.parse(run(["api", `repos/${repo}/actions/runs/${item.id}/jobs?per_page=100`])).jobs ?? [];
    const decision = fastEvidence({ runs, jobs, elapsedMs: now() - started });
    if (decision !== FastEvidence.Wait) return decision;
    await wait(POLL_MS);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // An unreadable Actions API costs the release its own fast shards, never its gate.
  const decision = await awaitFastEvidence({ repo: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA }).catch(
    (error) => {
      console.warn(`Could not read Check's runs on this commit: ${error.message}`);
      return FastEvidence.Run;
    },
  );
  console.log(
    decision === FastEvidence.Reuse
      ? "Check already passed the macOS fast inventory on this commit; the release reuses it."
      : "No passed Check fast job on this commit; the release runs the macOS fast inventory.",
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `reuse=${decision === FastEvidence.Reuse}\n`);
}
