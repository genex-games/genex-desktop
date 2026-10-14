import "./check-node.mjs";
import { spawnSync } from "node:child_process";

// Explicit files replace the default suite instead of being appended to it by npm.
// `--group fast` runs every test outside the rig with Node's default parallelism, then the files
// that start real games on the GPU one at a time; `--group rig` runs the tests that reach
// tests/helpers/studio-rig.ts one at a time. `--list` prints the group.
const args = process.argv.slice(2);
const at = args.indexOf("--group"),
  list = args.includes("--list");
const batches = [];
if (at >= 0) {
  const group = args[at + 1];
  if (group !== "fast" && group !== "rig") throw new Error("--group must be fast or rig");
  const { rigTests, testFiles, importGraph, parallelAndGpu } = await import("./affected-tests.mjs");
  const root = process.cwd(),
    tests = testFiles(root),
    rigs = new Set(rigTests(root, importGraph(root, tests), tests));
  const files = tests.filter((t) => rigs.has(t) === (group === "rig"));
  const rest = args.filter((a, i) => i !== at && i !== at + 1 && a !== "--list");
  if (list) {
    console.log(files.join("\n"));
    console.error(`${group}: ${files.length} of ${tests.length} test files`);
    process.exit(0);
  }
  const reporter = "--test-reporter=spec";
  if (group === "rig") batches.push(["--test", "--test-concurrency=1", reporter, ...rest, ...files]);
  else {
    const { parallel, gpu } = parallelAndGpu(root, files);
    if (parallel.length) batches.push(["--test", reporter, ...rest, ...parallel]);
    if (gpu.length) batches.push(["--test", "--test-concurrency=1", reporter, ...rest, ...gpu]);
  }
} else {
  batches.push([
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    ...(args.length ? args : ["tests/**/*.test.ts"]),
  ]);
}
const { TEST_PRELOAD, testEnv } = await import("./affected-tests.mjs");
let status = 0;
for (const command of batches) {
  const result = spawnSync(process.execPath, [...TEST_PRELOAD, ...command], { stdio: "inherit", env: testEnv() });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Node tests terminated by ${result.signal}`);
  status ||= result.status ?? 1;
}
process.exitCode = status;
