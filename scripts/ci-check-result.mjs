import { pathToFileURL } from "node:url";

/** The jobs each aggregate result requires; a matrix job succeeds only when every child did. */
const REQUIRED = {
  gate: ["plan", "static", "unit", "seed"],
  fast: ["plan", "fast-tests"],
  regression: ["validate", "fast-evidence", "regression-rig", "regression-harness", "regression-e2e"],
};

/**
 * A lane whose job runs only when a decision job selected it: the job must succeed when selected
 * and be skipped when not. The release skips its macOS fast shards only when Check passed them on
 * the same commit (`scripts/release-fast-evidence.mjs`).
 */
const SELECTED = {
  gate: { decider: "plan", output: "harness_selected", job: "harness", runsWhen: "true" },
  regression: { decider: "fast-evidence", output: "reuse", job: "regression-fast", runsWhen: "false" },
};

/** Requires every selected job to succeed, including all children of each matrix job. */
export function assertCiResults(needs, lane) {
  if (!Object.hasOwn(REQUIRED, lane)) throw new Error(`Unknown CI result lane: ${lane}`);
  for (const name of REQUIRED[lane])
    if (needs?.[name]?.result !== "success") throw new Error(`${name} did not succeed`);
  if (!Object.hasOwn(SELECTED, lane)) return;
  const { decider, output, job, runsWhen } = SELECTED[lane];
  const decision = needs[decider].outputs?.[output];
  if (decision !== "true" && decision !== "false") throw new Error(`Missing ${decider} ${output} result`);
  const expected = decision === runsWhen ? "success" : "skipped";
  if (needs[job]?.result !== expected) throw new Error(`${job} must be ${expected}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertCiResults(JSON.parse(process.env.STUDIO_CI_NEEDS ?? "null"), process.argv[2]);
    console.log("Every required CI job succeeded.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
