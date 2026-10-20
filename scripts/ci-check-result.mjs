import { pathToFileURL } from "node:url";

/** The jobs each aggregate result requires; a matrix job succeeds only when every child did. */
const REQUIRED = {
  gate: ["plan", "static", "unit", "seed"],
  fast: ["plan", "fast-tests"],
  regression: ["validate", "regression-rig", "regression-harness", "regression-fast", "regression-e2e"],
};

/** Requires every selected job to succeed, including all children of each matrix job. */
export function assertCiResults(needs, lane) {
  if (!Object.hasOwn(REQUIRED, lane)) throw new Error(`Unknown CI result lane: ${lane}`);
  for (const name of REQUIRED[lane])
    if (needs?.[name]?.result !== "success") throw new Error(`${name} did not succeed`);
  if (lane !== "gate") return;
  const selected = needs.plan.outputs?.harness_selected;
  if (selected !== "true" && selected !== "false") throw new Error("Missing harness selection result");
  const expected = selected === "true" ? "success" : "skipped";
  if (needs.harness?.result !== expected) throw new Error(`harness must be ${expected}`);
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
