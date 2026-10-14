/**
 * Bundles the pinned ANGLE builds into the app's resources: every Genex build ships the
 * Metal-only macOS arm64, D3D11-only Windows x64 and Vulkan + SwiftShader Linux x64 builds that
 * `native/angle/bundle-lock.json` pins, at `<resources>/angle/<target>/<commit12>/`, so the
 * toolchain store installs ANGLE from the app (src/substrate/toolchain-store/bundled.ts) and no
 * machine downloads it.
 *
 * Each build is read from `GENEX_ANGLE_DIR` (`--source`: angle.yml's artifacts as
 * `gh run download` lays them out, `angle-<target>-<commit12>/`), or else from the developer's
 * cache, `.studio-dev/toolchains/angle-<target>/<commit12>/` (the same artifacts, downloaded once).
 * Every file is held to its manifest and every manifest to
 * the lock (and the lock to `native/angle/recipe.json`); links, special files, unlisted files and
 * digests that differ are refused. A release build (`--release` or `GENEX_RELEASE=1`) fails closed
 * when any build is missing or refused, and then copies nothing; a developer build warns and
 * bundles the rest.
 *
 *   node scripts/bundle-angle.mjs [--release] [--resources <dir>] [--source <dir>]
 *   node scripts/bundle-angle.mjs --verify <resources>   a built or packaged app's copy, every file
 *   node scripts/bundle-angle.mjs --fetch <dir>          CI: download the lock's angle.yml run (gh, GH_TOKEN)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactError } from "../src/substrate/toolchain-store/artifact.ts";
import {
  ANGLE_RESOURCES_FOLDER,
  ANGLE_TARGETS,
  BUNDLE_LOCK,
  commit12,
  copyAngleTarget,
  verifyAngleBundle,
  verifyAngleFolder,
} from "../src/substrate/toolchain-store/bundled.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const MESSAGE = {
  recipeCommit: (locked, built) =>
    `native/angle/bundle-lock.json pins ANGLE ${locked}, but native/angle/recipe.json builds ${built}: re-pin the lock from an angle.yml run of the recipe's commit.`,
  recipeTargets: (locked, built) =>
    `native/angle/bundle-lock.json pins ${locked.join(", ")}, but native/angle/recipe.json builds ${built.join(", ")}.`,
  refused: (problems) =>
    `ANGLE is not bundled; a release build needs every pinned build:\n${problems.map((problem) => `  ${problem.target}: ${problem.fault}: ${problem.detail}`).join("\n")}`,
  skipped: (problem) =>
    `bundle-angle: ${problem.target} is not bundled (${problem.fault}): ${problem.detail} This build cannot play or export that destination.`,
  fetchFailed: (lock) =>
    `gh run download failed for angle.yml run ${lock.run.id} in ${lock.run.repository}; its artifacts expire on ${lock.run.expires}: re-pin native/angle/bundle-lock.json from a newer run if they are gone.`,
};

/** A release bundle that could not be made: each build that is missing or refused, typed. */
export class AngleBundleError extends Error {
  /** @param {BundleProblem[]} problems */
  constructor(problems) {
    super(MESSAGE.refused(problems));
    this.name = "AngleBundleError";
    this.problems = problems;
  }
}

/**
 * @typedef {import("../src/substrate/toolchain-store/bundled.ts").BundleLock} BundleLock
 * @typedef {import("../src/substrate/toolchain-store/bundled.ts").BundledCopy} BundledCopy
 * @typedef {{ target: string, fault: string, detail: string }} BundleProblem
 */

/**
 * Where each ANGLE build is read from: `source`'s `angle-<target>-<commit12>/` (angle.yml's
 * artifacts), or else the developer's cache under `toolchains`.
 * @param {{ root?: string, source?: string | null, lock?: BundleLock, toolchains?: string }} [options]
 * @returns {Record<string, string>}
 */
export function angleSources({
  root = ROOT,
  source = null,
  lock = BUNDLE_LOCK,
  toolchains = path.join(root, ".studio-dev", "toolchains"),
} = {}) {
  const short = commit12(lock);
  return Object.fromEntries(
    ANGLE_TARGETS.map((target) => [
      target,
      source ? path.join(source, `angle-${target}-${short}`) : path.join(toolchains, `angle-${target}`, short),
    ]),
  );
}

/** Refuses a lock that pins another ANGLE commit or other builds than native/angle/recipe.json makes. */
function assertRecipe(root, lock) {
  const recipe = JSON.parse(readFileSync(path.join(root, "native", "angle", "recipe.json"), "utf8"));
  if (recipe.angle?.commit !== lock.commit) throw new Error(MESSAGE.recipeCommit(lock.commit, recipe.angle?.commit));
  const built = Object.keys(recipe.targets ?? {}).sort();
  const locked = Object.keys(lock.targets).sort();
  if (built.join("\n") !== locked.join("\n")) throw new Error(MESSAGE.recipeTargets(locked, built));
}

/** A refused build as the result and the error name it. */
function problemOf(target, error) {
  if (!(error instanceof ArtifactError)) throw error;
  return { target, fault: error.fault, detail: error.message };
}

/**
 * Bundles every pinned ANGLE build into `<resources>/angle/`, which it owns: an earlier bundle is
 * removed first. Each source is verified before anything is copied, then copied and verified
 * again. A release build throws {@link AngleBundleError} when any build is missing or refused and
 * leaves no `angle/` folder at all; a developer build warns, skips those and bundles the rest.
 * Answers what was copied and what was skipped.
 * @param {{ resources: string, release?: boolean, root?: string, source?: string | null, lock?: BundleLock,
 *   toolchains?: string, warn?: (line: string) => void }} options
 * @returns {Promise<{ copied: BundledCopy[], skipped: BundleProblem[] }>}
 */
export async function bundleAngle({
  resources,
  release = false,
  root = ROOT,
  source = process.env.GENEX_ANGLE_DIR || null,
  lock = BUNDLE_LOCK,
  toolchains = undefined,
  warn = (line) => console.warn(line),
}) {
  const parent = path.join(resources, ANGLE_RESOURCES_FOLDER);
  await rm(parent, { recursive: true, force: true });
  assertRecipe(root, lock);
  const sources = angleSources({ root, source, lock, ...(toolchains ? { toolchains } : {}) });
  const skipped = [];
  for (const target of ANGLE_TARGETS)
    await verifyAngleFolder(sources[target], target, { bundled: false, lock }).catch((error) =>
      skipped.push(problemOf(target, error)),
    );
  if (release && skipped.length > 0) throw new AngleBundleError(skipped);
  const copied = [];
  for (const target of ANGLE_TARGETS.filter((name) => !skipped.some((problem) => problem.target === name))) {
    try {
      copied.push(await copyAngleTarget(sources[target], resources, target, lock));
    } catch (error) {
      const problem = problemOf(target, error);
      if (release) {
        await rm(parent, { recursive: true, force: true });
        throw new AngleBundleError([problem]);
      }
      skipped.push(problem);
    }
  }
  for (const problem of skipped) warn(MESSAGE.skipped(problem));
  return { copied, skipped };
}

/**
 * `gh` arguments that download exactly the lock's angle.yml run's ANGLE artifacts into `dir`.
 * @param {BundleLock} lock
 * @param {string} dir
 * @returns {string[]}
 */
export function fetchArgv(lock, dir) {
  return [
    "run",
    "download",
    String(lock.run.id),
    "--repo",
    lock.run.repository,
    "--dir",
    dir,
    "--pattern",
    `angle-*-${commit12(lock)}`,
  ];
}

/** The value after `name` in `args`, or undefined. */
function flagValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** Whether this module runs as the script (`node scripts/bundle-angle.mjs`) rather than being imported. */
function runsAsScript() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** `--fetch <dir>`: downloads the lock's angle.yml run; answers the exit code. */
function fetchCli(dir) {
  const result = spawnSync("gh", fetchArgv(BUNDLE_LOCK, dir), { stdio: "inherit" });
  if (result.status !== 0) console.error(MESSAGE.fetchFailed(BUNDLE_LOCK));
  return result.status ?? 1;
}

/** `--verify <resources>`: checks a built or packaged app's copy; answers the exit code. */
async function verifyCli(resources) {
  const checks = await verifyAngleBundle(path.resolve(resources));
  console.log(JSON.stringify(checks, null, 2));
  return checks.every((check) => check.ok) ? 0 : 1;
}

/** Bundles into `--resources` (default `dist/resources`); answers the exit code. */
async function bundleCli(args) {
  const release = args.includes("--release") || process.env.GENEX_RELEASE === "1";
  const resources = path.resolve(flagValue(args, "--resources") ?? path.join(ROOT, "dist", "resources"));
  const source = flagValue(args, "--source") ?? (process.env.GENEX_ANGLE_DIR || null);
  try {
    const { copied } = await bundleAngle({ resources, release, source });
    for (const copy of copied)
      console.log(
        `bundle-angle: ${copy.target} ${copy.files} files, ${(copy.bytes / 1024 ** 2).toFixed(1)} MB → ${copy.folder}`,
      );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** The CLI: bundle (the default), `--verify <resources>` or `--fetch <dir>`; answers the exit code. */
async function main(args) {
  const fetchInto = flagValue(args, "--fetch");
  if (fetchInto) return fetchCli(fetchInto);
  const verify = flagValue(args, "--verify");
  if (verify) return verifyCli(verify);
  return bundleCli(args);
}

if (runsAsScript()) process.exitCode = await main(process.argv.slice(2));
