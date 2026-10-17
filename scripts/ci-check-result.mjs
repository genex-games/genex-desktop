import { pathToFileURL } from "node:url";

/** Requires every selected job to succeed, including all children of each matrix job. */
export function assertCiResults(needs, lane) {
  if (lane !== "gate" && lane !== "fast") throw new Error(`Unknown CI result lane: ${lane}`);
  const required = lane === "gate" ? ["plan", "static", "unit", "seed"] : ["plan", "fast-tests"];
  for (const name of required) if (needs?.[name]?.result !== "success") throw new Error(`${name} did not succeed`);
  if (lane === "fast") return;
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
