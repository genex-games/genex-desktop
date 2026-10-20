import "./check-node.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createHarnessPlan,
  harnessCommands,
  validateHarnessPlan,
  createSeedPlan,
  seedCommands,
  validateSeedPlan,
} from "./ci-harness-shards.mjs";
import {
  changedFiles,
  HARNESS_GATE,
  importGraph,
  rigTests,
  selectTests,
  testEnv,
  testFiles,
} from "./affected-tests.mjs";

/** @typedef {{ id: number, files: string[] }} CiFileShard */
/** @typedef {{ files: string[], shards: CiFileShard[] }} CiFileGroup */
/**
 * @typedef {object} CiPlan
 * @property {number} version
 * @property {string} revision
 * @property {string[]} changed
 * @property {string[]} globalChanges
 * @property {string[]} unmatched
 * @property {CiFileGroup} unit
 * @property {import('./ci-harness-shards.mjs').HarnessPlan} harness
 * @property {import('./ci-harness-shards.mjs').SeedPlan} seed
 * @property {CiFileGroup} fast
 * @property {CiFileGroup} rig
 * @property {boolean} full
 */

/** Contracts every Linux code-event run retains, even when no source change selects them. */
export const CI_BASELINE = [
  "tests/conformance/seed-upgrade.test.ts",
  "tests/conformance/child-env.test.ts",
  "tests/conformance/words.test.ts",
  "tests/conformance/check-grammar.test.ts",
];
// These inputs can change which tests execute or their runtime on every file, including deletions.
const GLOBAL_INPUTS = new Set([
  ".github/workflows/check.yml",
  "scripts/test.mjs",
  "scripts/test-runtime.mjs",
  "scripts/affected-tests.mjs",
  "scripts/ci-test-plan.mjs",
  "scripts/ci-check-result.mjs",
  "scripts/ci-harness-shards.mjs",
  "scripts/check-node.mjs",
  "package.json",
  "package-lock.json",
  ".nvmrc",
  ".npmrc",
  "tsconfig.json",
  "tsconfig.harness.json",
  "tests/helpers/leftover-children.ts",
  "tests/helpers/processes.ts",
  "tests/test-map.json",
]);
const PLAN_VERSION = 3;
const DEFAULT_SHARDS = 6;
const MAX_SHARDS = 16;
const GROUPS = ["unit", "harness", "seed", "fast", "rig"];
const SEED_UPGRADE = CI_BASELINE[0];
const unique = (files) => [...new Set(files)].sort();
const revision = (root) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: testEnv() }).trim();

function existingTest(root, file) {
  const validName = typeof file === "string" && /^tests\/.+\.test\.ts$/.test(file);
  if (!validName || file.includes("\\") || path.posix.normalize(file) !== file)
    throw new Error(`Invalid test path: ${file}`);
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) throw new Error(`Missing test file: ${file}`);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(absolute).isFile())
    throw new Error(`Test escapes the checkout: ${file}`);
}

function partition(root, files, limit) {
  if (!files.length) return [];
  const count = Math.min(limit, files.length);
  const buckets = Array.from({ length: count }, (_, index) => ({ id: index + 1, files: [], weight: 0 }));
  const reserved = count > 1 && files.includes(SEED_UPGRADE);
  if (reserved) buckets[0].files.push(SEED_UPGRADE);
  const available = reserved ? buckets.slice(1) : buckets;
  // Source bytes are a deterministic balancing heuristic, not a timing prediction or result cache.
  const weighted = files
    .filter((file) => !reserved || file !== SEED_UPGRADE)
    .map((file) => ({ file, weight: fs.statSync(path.join(root, file)).size }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  for (const { file, weight } of weighted) {
    const bucket = [...available].sort((a, b) => a.weight - b.weight || a.id - b.id)[0];
    bucket.files.push(file);
    bucket.weight += Math.max(weight, 1);
  }
  return buckets
    .filter((bucket) => bucket.files.length)
    .map(({ id, files: assigned }) => ({ id, files: assigned.sort() }));
}

function group(root, files, count) {
  const sorted = unique(files);
  for (const file of sorted) existingTest(root, file);
  return { files: sorted, shards: partition(root, sorted, count) };
}

/**
 * Plans each existing gate once; disjoint file shards retain the complete selected test inventory.
 * A full plan (the release regression) selects every fast test and the whole harness gate whatever
 * changed; its rig group holds every other rig test, so fast, rig and harness together are `npm test`.
 * @param {string} root
 * @param {{ changed?: string[], base?: string, shards?: number, full?: boolean }} [options]
 * @returns {CiPlan}
 */
export function createCiPlan(root, { changed, base, shards = DEFAULT_SHARDS, full = false } = {}) {
  if (!Number.isInteger(shards) || shards < 1 || shards > MAX_SHARDS) throw new Error("Invalid shard count");
  const changes = changed ?? (full ? [] : changedFiles(root, { base }));
  const tests = testFiles(root);
  const graph = importGraph(root, tests);
  const selected = selectTests(root, changes, { graph, tests });
  const globalChanges = unique(changes.filter((file) => GLOBAL_INPUTS.has(file)));
  const complete = full || globalChanges.length > 0;
  const harnessSelected = complete || HARNESS_GATE.some((file) => selected.L3.includes(file));
  const harness = harnessSelected ? HARNESS_GATE : [];
  const rigs = new Set(rigTests(root, graph, tests));
  const fast = tests.filter((file) => !rigs.has(file));
  const rig = [...rigs].filter((file) => !HARNESS_GATE.includes(file));
  const selectedUnits = complete ? fast : selected.L1;
  const units = unique([...CI_BASELINE, ...selectedUnits]).filter(
    (file) => file !== SEED_UPGRADE && !harness.includes(file),
  );
  existingTest(root, SEED_UPGRADE);
  const plan = {
    version: PLAN_VERSION,
    revision: revision(root),
    changed: unique(changes),
    globalChanges,
    unmatched: selected.unmatched,
    unit: group(root, units, shards),
    harness: createHarnessPlan(root, harnessSelected),
    seed: createSeedPlan(root),
    fast: group(root, fast, shards),
    rig: group(root, rig, shards),
    full,
  };
  validateCiPlan(root, plan);
  return plan;
}

function validateGroup(root, name, value) {
  if (!value || !Array.isArray(value.files) || !Array.isArray(value.shards)) throw new Error(`Invalid ${name} group`);
  for (const file of value.files) existingTest(root, file);
  if (JSON.stringify(unique(value.files)) !== JSON.stringify(value.files))
    throw new Error(`Repeated or unsorted ${name} files`);
  const assigned = [];
  const ids = new Set();
  for (const shard of value.shards) {
    const validId = Number.isInteger(shard.id) && shard.id > 0 && shard.id <= MAX_SHARDS;
    if (!validId || ids.has(shard.id) || !Array.isArray(shard.files) || !shard.files.length)
      throw new Error(`Invalid ${name} shard`);
    ids.add(shard.id);
    for (const file of shard.files) existingTest(root, file);
    assigned.push(...shard.files);
  }
  if (JSON.stringify(assigned.sort()) !== JSON.stringify(value.files))
    throw new Error(`Incomplete or overlapping ${name} shards`);
}

function validateGlobalCoverage(plan) {
  if (!Array.isArray(plan.changed) || !plan.changed.every((file) => typeof file === "string"))
    throw new Error("Invalid changed-file inventory");
  if (typeof plan.full !== "boolean") throw new Error("Invalid full-plan flag");
  const global = unique(plan.changed.filter((file) => GLOBAL_INPUTS.has(file)));
  if (JSON.stringify(global) !== JSON.stringify(plan.globalChanges)) throw new Error("Invalid global-input inventory");
  if (!global.length && !plan.full) return;
  const actual = unique([...plan.unit.files, ...plan.seed.files, ...plan.harness.files]);
  const expected = unique([...CI_BASELINE, ...plan.fast.files, ...HARNESS_GATE]);
  if (!plan.harness.files.length || JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Global CI inputs and full plans require every fast test and the complete harness gate");
}

/**
 * Rejects malformed artifacts, missing tests and a plan built for a different checkout.
 * @param {string} root
 * @param {unknown} plan
 */
export function validateCiPlan(root, plan) {
  if (!plan || plan.version !== PLAN_VERSION) throw new Error("Unsupported CI plan version");
  if (plan.revision !== revision(root)) throw new Error("CI plan revision does not match this checkout");
  for (const name of ["unit", "fast", "rig"]) validateGroup(root, name, plan[name]);
  const fast = new Set(plan.fast.files);
  if (plan.rig.files.some((file) => fast.has(file) || HARNESS_GATE.includes(file)))
    throw new Error("Rig tests overlap the fast group or the harness gate");
  validateHarnessPlan(root, plan.harness);
  validateSeedPlan(root, plan.seed);
  for (const file of plan.seed.files) existingTest(root, file);
  for (const file of plan.harness.files) existingTest(root, file);
  validateGlobalCoverage(plan);
  if (!plan.unit.files.length) throw new Error("CI plan has no mandatory tests");
  const linuxFiles = [...plan.unit.files, ...plan.seed.files, ...plan.harness.files];
  const linux = new Set(linuxFiles);
  if (linux.size !== linuxFiles.length) throw new Error("Overlapping Linux groups");
  if (CI_BASELINE.some((file) => !linux.has(file))) throw new Error("CI plan lost a mandatory baseline test");
  const completeHarness = JSON.stringify([...HARNESS_GATE].sort());
  if (plan.harness.files.length && JSON.stringify(plan.harness.files) !== completeHarness)
    throw new Error("CI plan has an incomplete harness gate");
}

function commandsForShard(root, name, shard) {
  if (name === "seed") return seedCommands(root, shard);
  if (name === "harness") return harnessCommands(shard);
  // Rig suites drive a real core and its harness children, so each runner takes them one at a time.
  if (name === "rig") return [["--test-concurrency=1", ...shard.files]];
  return [["--test-concurrency=2", ...shard.files]];
}

/**
 * Executes an exact assignment through the normal runner, retaining its preloads and failure status.
 * @param {string} root
 * @param {CiPlan} plan
 * @param {string} name
 * @param {number} id
 * @returns {number}
 */
export function runCiShard(root, plan, name, id) {
  validateCiPlan(root, plan);
  if (!GROUPS.includes(name)) throw new Error(`Unknown CI group: ${name}`);
  const shard = plan[name].shards.find((item) => item.id === id);
  if (!shard) throw new Error(`Unknown or empty ${name} shard: ${id}`);
  const commands = commandsForShard(root, name, shard);
  console.log(`${name} shard ${id}: ${commands.length} test batch(es)`);
  for (const args of commands) {
    const run = spawnSync(process.execPath, ["scripts/test.mjs", ...args], {
      cwd: root,
      env: testEnv(),
      stdio: "inherit",
    });
    if (run.error) console.error(run.error.message);
    if (run.signal) console.error(`CI shard terminated by ${run.signal}`);
    if (run.status !== 0) return run.status ?? 1;
  }
  return 0;
}

/** Valued flags each action accepts; `plan --full` is the one flag without a value. */
const VALUE_FLAGS = { plan: ["base", "output", "github-output"], run: ["plan", "group", "shard"] };

function readFlag(action, options, rest) {
  const flag = rest.shift();
  if (!flag.startsWith("--")) throw new Error("Invalid CI planner flag");
  const key = flag.slice(2);
  if (Object.hasOwn(options, key)) throw new Error("Invalid CI planner arguments");
  if (action === "plan" && key === "full") {
    options.full = true;
    return;
  }
  const value = rest.shift();
  if (!VALUE_FLAGS[action].includes(key) || !value || value.startsWith("--"))
    throw new Error("Invalid CI planner arguments");
  options[key] = value;
}

function requiredArgs(options) {
  if (options.action === "run") return ["plan", "group", "shard"];
  // A full plan selects everything, so it has no base to compare against.
  if (!options.full) return ["base", "output"];
  if (options.base) throw new Error("A full CI plan takes no base");
  return ["output"];
}

function readArgs(argv) {
  const [action, ...rest] = argv;
  if (action !== "plan" && action !== "run") throw new Error("Expected plan or run");
  const options = { action };
  while (rest.length) readFlag(action, options, rest);
  if (requiredArgs(options).some((key) => !options[key])) throw new Error("Missing CI planner argument");
  return options;
}

function writePlan(root, options) {
  const plan = createCiPlan(root, { base: options.base, full: options.full === true });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(plan, null, 2)}\n`);
  if (options["github-output"]) {
    const lines = GROUPS.map((name) => {
      const include = plan[name].shards.map(({ id }) => ({ shard: id }));
      // Job-level if excludes an unselected harness before this placeholder matrix expands.
      return `${name}_matrix=${JSON.stringify({ include: include.length ? include : [{ shard: 1 }] })}`;
    });
    lines.push(`harness_selected=${plan.harness.files.length > 0}`);
    fs.appendFileSync(options["github-output"], `${lines.join("\n")}\n`);
  }
  if (plan.globalChanges.length) console.log(`Full fast + harness coverage: ${plan.globalChanges.join(", ")}`);
  console.log(
    `CI plan: ${plan.unit.files.length} Linux files in ${plan.unit.shards.length} shards; ${plan.seed.shards.length} seed shards; ${plan.harness.files.length} harness files; ${plan.fast.files.length} macOS fast files; ${plan.rig.files.length} rig files`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = readArgs(process.argv.slice(2));
    if (options.action === "plan") writePlan(process.cwd(), options);
    else {
      const plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
      process.exitCode = runCiShard(process.cwd(), plan, options.group, Number(options.shard));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
