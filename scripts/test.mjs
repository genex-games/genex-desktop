import "./check-node.mjs";
import fs from "node:fs";
import path from "node:path";
import { FAST_TEST_CONCURRENCY, runTestBatch } from "./test-runtime.mjs";

// Node accepts both --option=value and --option value. Recognizing value-taking test and
// runtime options prevents a name pattern or reporter path from being mistaken for a test file.
const VALUE_OPTIONS = new Set([
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--experimental-test-isolation",
  "--test-name-pattern",
  "--test-random-seed",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-rerun-failures",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
  "--env-file",
  "--env-file-if-exists",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--stack-trace-limit",
  "--unhandled-rejections",
  "--disable-warning",
  "--redirect-warnings",
  "--title",
  "--inspect-port",
]);

function nodeFlag(args, index) {
  const arg = args[index];
  const name = arg.split("=", 1)[0].replaceAll("_", "-");
  if (!VALUE_OPTIONS.has(name) || arg.includes("=")) return { flag: arg, index };
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${arg} needs a value`);
  const aliases = { "-r": "--require", "-C": "--conditions" };
  return { flag: `${aliases[name] ?? name}=${value}`, index: index + 1 };
}

function readGroup(options, group) {
  if (options.group) throw new Error("--group may only be supplied once");
  if (!["fast", "rig"].includes(group)) throw new Error("--group must be fast or rig");
  return group;
}

function parseArgs(args) {
  const options = { flags: [], files: [], group: undefined, list: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      options.files.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--group") {
      options.group = readGroup(options, args[++i]);
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      options.files.push(arg);
      continue;
    }
    const parsed = nodeFlag(args, i);
    options.flags.push(parsed.flag);
    i = parsed.index;
  }
  return options;
}

function explicitFiles(root, inputs) {
  const files = new Set();
  for (const input of inputs) {
    const direct = path.resolve(root, input);
    const matches = fs.existsSync(direct)
      ? [direct]
      : fs.globSync(input, { cwd: root }).map((file) => path.resolve(root, file));
    if (!matches.length) throw new Error(`No test files match: ${input}`);
    for (const file of matches) {
      if (!fs.statSync(file).isFile()) throw new Error(`Name a test file or glob, not a directory: ${input}`);
      files.add(file);
    }
  }
  return [...files].sort();
}

function flagsFor(options) {
  if (options.group === "rig")
    for (const flag of options.flags)
      if (flag.replaceAll("_", "-").startsWith("--test-concurrency=") && flag.split("=")[1] !== "1")
        throw new Error("--group rig always runs serially; --test-concurrency must be 1");
  const hasReporter = options.flags.some((flag) => flag.replaceAll("_", "-").startsWith("--test-reporter="));
  return hasReporter ? options.flags : ["--test-reporter=spec", ...options.flags];
}

async function batchesFor(root, options, bare) {
  if (options.group && options.files.length) throw new Error("Use --group or explicit test files, not both");
  if (options.list && !options.group) throw new Error("--list requires --group fast or --group rig");
  if (options.files.length) return [{ files: explicitFiles(root, options.files), concurrency: 1 }];
  if (!bare && !options.group)
    throw new Error("Name test files with Node flags, or choose --group fast or --group rig");
  const { rigTests, testFiles, importGraph } = await import("./affected-tests.mjs");
  const tests = testFiles(root);
  if (!tests.length) throw new Error("No test files discovered under tests/**/*.test.ts");
  const rigs = new Set(rigTests(root, importGraph(root, tests), tests));
  const groups = [
    { group: "fast", files: tests.filter((file) => !rigs.has(file)), concurrency: FAST_TEST_CONCURRENCY },
    { group: "rig", files: tests.filter((file) => rigs.has(file)), concurrency: 1 },
  ];
  return options.group ? groups.filter(({ group }) => group === options.group) : groups;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  const flags = flagsFor(options);
  const root = process.cwd();
  const batches = await batchesFor(root, options, args.length === 0);
  if (options.list) {
    console.log(batches[0].files.join("\n"));
    console.error(`${options.group}: ${batches[0].files.length} test files`);
    return 0;
  }
  let status = 0;
  for (const { files, concurrency } of batches) {
    const result = runTestBatch(root, files, { flags, concurrency });
    if (result !== 0) status = result;
  }
  return status;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
