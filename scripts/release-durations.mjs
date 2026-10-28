import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDurations } from "./ci-durations.mjs";

/** `owner/name`, as GITHUB_REPOSITORY spells it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The artifact each regression leaves: its rig files' times, merged from every rig shard. */
export const DURATIONS_ARTIFACT = "regression-durations";
const DURATIONS_FILE = "durations.json";
/** How many recent release runs to look through for one that left its times. */
const RECENT_RUNS = 20;

/**
 * Merges the times each rig shard wrote into one table; the shards' files are disjoint, so a file
 * named twice keeps its longer time.
 * @param {Array<Record<string, number>>} tables
 */
export function mergeDurations(tables) {
  /** @type {Record<string, number>} */
  const merged = {};
  for (const table of tables)
    for (const [file, ms] of Object.entries(parseDurations(table))) merged[file] = Math.max(merged[file] ?? 0, ms);
  return merged;
}

const runGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * The times the newest earlier release run left, or none. Times only balance shards, so a run that
 * left none, an expired artifact or an unreadable one is a plan by source bytes, never a failure.
 * @param {{ repo: string | undefined, currentRun?: string, run?: (args: string[]) => string }} input
 * @returns {Record<string, number> | undefined}
 */
export function latestDurations({ repo, currentRun, run = runGh }) {
  if (!REPOSITORY.test(repo ?? "") || repo.includes("..")) throw new Error("Invalid repository");
  const listed = JSON.parse(
    run(["api", `repos/${repo}/actions/workflows/release.yml/runs?status=completed&per_page=${RECENT_RUNS}`]),
  );
  for (const { id } of listed.workflow_runs ?? []) {
    if (!Number.isInteger(id) || String(id) === currentRun) continue;
    const { artifacts = [] } = JSON.parse(
      run(["api", `repos/${repo}/actions/runs/${id}/artifacts?name=${DURATIONS_ARTIFACT}`]),
    );
    if (!artifacts.some((artifact) => artifact.name === DURATIONS_ARTIFACT && !artifact.expired)) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-durations-"));
    try {
      run(["run", "download", String(id), "--name", DURATIONS_ARTIFACT, "--dir", dir, "--repo", repo]);
      return parseDurations(JSON.parse(fs.readFileSync(path.join(dir, DURATIONS_FILE), "utf8")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return undefined;
}

function fetchCommand(output) {
  try {
    const durations = latestDurations({ repo: process.env.GITHUB_REPOSITORY, currentRun: process.env.GITHUB_RUN_ID });
    if (!durations) return console.log("No earlier release left its test times; the rig shards balance by size.");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(durations, null, 2)}\n`);
    console.log(`Read ${Object.keys(durations).length} rig file times from an earlier release.`);
  } catch (error) {
    console.warn(`Could not read an earlier release's test times: ${error.message}`);
  }
}

function mergeCommand(dir, output) {
  const tables = fs
    .readdirSync(dir, { recursive: true })
    .filter((file) => String(file).endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, String(file)), "utf8")));
  const merged = mergeDurations(tables);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Merged ${Object.keys(merged).length} rig file times from ${tables.length} shard(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === "fetch" && args.length === 1) fetchCommand(args[0]);
  else if (action === "merge" && args.length === 2) mergeCommand(args[0], args[1]);
  else {
    console.error("Usage: release-durations.mjs fetch <output> | merge <dir> <output>");
    process.exitCode = 1;
  }
}
