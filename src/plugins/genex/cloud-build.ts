/**
 * Apps Genex builds on its own computers: Unreal packages a game only for the system it runs on, so
 * a Windows app of an Unreal game made on a Mac is built by Genex from the game's project. The
 * project is staged as it is for remixers (`stageRemixSource`) but goes privately with
 * `genex native build --platform <p> --source <folder>`; Genex builds it, checks it and puts it on
 * the game's page beside the apps the game already has. The build takes a while, so its jobs are
 * kept in the publish workspace's `cloud-build.json` (apart from `native.json`, which each publish
 * writes anew) and followed with `genex native build-status <job>` until each one ends.
 *
 * The CLI and Genex's side are a draft contract: nothing is asked while Studio's pinned CLI has no
 * `genex native build` (`pinnedCliBuildsApps`), and the dialog says where the app is packaged as before.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
// Read at build time, as `native-publish.ts` does: the packaged app ships the CLI only in the plugin's payload.
import cliPackage from "@genex-ai/cli-demo/package.json" with { type: "json" };
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { CloudBuildFailure, CloudBuildState, type GenexCloudBuild } from "../../shared/genex.ts";
import { NativePlatform } from "../../shared/play-native.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import type { StagedSource } from "./remix-source.ts";

/** The first Genex CLI with `genex native build` and `build-status`, as agreed for its release. */
const CLOUD_BUILD_CLI = [1, 38, 0] as const;
/** Where a game's builds on Genex are kept in its publish workspace. */
export const CLOUD_BUILD_FILE = "cloud-build.json";
/** Where the project is staged for a build, apart from the remix copy a publish may stage at the same time. */
export const CLOUD_SOURCE_FOLDER = "cloud-source";
/** The most builds kept for a game: the newest of each platform speaks, a few older ones stay for their history. */
const CLOUD_BUILDS_KEPT = 8;
/** How long to wait between status reads: soon at first, then less often, never longer than the last. */
const CLOUD_POLL_MS = [15 * SECOND_MS, 30 * SECOND_MS, MINUTE_MS, 2 * MINUTE_MS] as const;
/** A job id as Genex names one: a plain word the CLI takes as an argument, never an option. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The systems Genex builds apps for. */
export const CLOUD_PLATFORMS: ReadonlySet<string> = new Set([NativePlatform.Windows]);

const MESSAGE = {
  NotABuild: "Genex answered without the build it started",
  UnknownPlatform: "Genex builds no app for that system",
} as const;

/**
 * Whether CLI `version` has `genex native build`. A prerelease comes before its release, so only a
 * later release's prerelease counts.
 */
export function hasCloudBuildCommand(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (const [at, wanted] of CLOUD_BUILD_CLI.entries()) {
    const part = parts[at] ?? 0;
    if (part !== wanted) return part > wanted;
  }
  return match[4] === undefined;
}

/** Whether the CLI Studio ships, the version this build pins, can ask Genex to build an app. */
export const pinnedCliBuildsApps = (): boolean => hasCloudBuildCommand(cliPackage.version);

/** The CLI's words for starting a build of the project staged in `sourceDir`. */
export const cloudBuildArgs = (platform: string, sourceDir: string): string[] => [
  "native",
  "build",
  "--platform",
  platform,
  "--source",
  sourceDir,
];

/** The CLI's words for reading how build `jobId` stands. */
export const buildStatusArgs = (jobId: string): string[] => ["native", "build-status", jobId];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const STATES: ReadonlySet<unknown> = new Set(Object.values(CloudBuildState));
const FAILURES: ReadonlySet<unknown> = new Set(Object.values(CloudBuildFailure));

/** A failure as Studio knows it: a code it doesn't know reads as a failure with no reason. */
const failureOf = (value: unknown): CloudBuildFailure =>
  FAILURES.has(value) ? (value as CloudBuildFailure) : CloudBuildFailure.Failed;

/** One build as kept or answered, or null when anything in it is off. */
function buildOf(value: unknown): GenexCloudBuild | null {
  if (!isRecord(value)) return null;
  const { platform, jobId, state, startedAt, finishedAt, failure } = value;
  const known = typeof platform === "string" && CLOUD_PLATFORMS.has(platform);
  const named = typeof jobId === "string" && JOB_ID.test(jobId);
  if (!known || !named || !STATES.has(state) || !isTime(startedAt)) return null;
  const failed = state === CloudBuildState.Failed;
  return {
    platform: String(platform),
    jobId: String(jobId),
    state: state as CloudBuildState,
    startedAt: String(startedAt),
    ...(isTime(finishedAt) ? { finishedAt } : {}),
    ...(failed ? { failure: failureOf(failure) } : {}),
  };
}

/** The build `genex native build --json` or `build-status --json` answers, or null when it names none. */
export const cloudBuildOf = (answer: unknown): GenexCloudBuild | null =>
  buildOf(isRecord(answer) ? answer.build : undefined);

/** `cloud-build.json` as read: the builds in it that are whole, oldest first. */
export function readCloudBuilds(value: unknown): GenexCloudBuild[] {
  const builds = isRecord(value) && Array.isArray(value.builds) ? value.builds : [];
  return builds.map(buildOf).filter((build): build is GenexCloudBuild => build !== null);
}

/** `builds` with `build` in place of the one with its job id, or added last; only the newest few kept. */
export function withBuild(builds: readonly GenexCloudBuild[], build: GenexCloudBuild): GenexCloudBuild[] {
  const others = builds.filter((kept) => kept.jobId !== build.jobId);
  return [...others, build].slice(-CLOUD_BUILDS_KEPT);
}

/** Whether a build is still going on Genex's computers. */
export const isRunning = (build: GenexCloudBuild): boolean =>
  build.state !== CloudBuildState.Done && build.state !== CloudBuildState.Failed;

/** How long to wait before the `attempt`th status read (from 0). */
export const pollDelayMs = (attempt: number): number =>
  CLOUD_POLL_MS[Math.min(Math.max(0, attempt), CLOUD_POLL_MS.length - 1)];

/** What a build on Genex needs from the plugin around it. */
export interface CloudBuildDeps {
  /** The Genex CLI in the publish workspace with `--json`: its parsed answer; throws with its words on a refusal. */
  cli(args: string[], signal: AbortSignal): Promise<unknown>;
  /** Copy the game's own files into `dest` (`stageRemixSource`). */
  stage(gameDir: string, dest: string): Promise<StagedSource>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The workspace's builds on Genex. */
export async function loadCloudBuilds(
  dir: string,
  read: (file: string) => Promise<unknown>,
): Promise<GenexCloudBuild[]> {
  return readCloudBuilds(await read(path.join(dir, CLOUD_BUILD_FILE)));
}

/** Keep `build` in the workspace's record of builds on Genex. */
async function keepBuild(dir: string, build: GenexCloudBuild, read: (file: string) => Promise<unknown>) {
  const builds = withBuild(await loadCloudBuilds(dir, read), build);
  await atomicWriteJson(path.join(dir, CLOUD_BUILD_FILE), { builds });
}

/**
 * Ask Genex to build the `platform` app of the game in `gameDir`: its project is staged in the
 * workspace `dir`, sent by the CLI, and removed once sent, whatever the answer. Answers the build
 * Genex started, kept in the record; throws with the CLI's words when Genex refused it.
 */
export async function startCloudBuild(
  dir: string,
  platform: string,
  gameDir: string,
  deps: CloudBuildDeps & { read: (file: string) => Promise<unknown> },
  signal: AbortSignal,
): Promise<GenexCloudBuild> {
  if (!CLOUD_PLATFORMS.has(platform)) throw new Error(MESSAGE.UnknownPlatform);
  const sourceDir = path.join(dir, CLOUD_SOURCE_FOLDER);
  try {
    await deps.stage(gameDir, sourceDir);
    const build = cloudBuildOf(await deps.cli(cloudBuildArgs(platform, sourceDir), signal));
    if (!build || build.platform !== platform) throw new Error(MESSAGE.NotABuild);
    await keepBuild(dir, build, deps.read);
    return build;
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/**
 * Follow build `jobId` until it ends or `signal` stops it, keeping each change in the record. A read
 * that fails is tried again at the next wait: Genex's side ends the build when it runs too long.
 */
export async function watchCloudBuild(
  dir: string,
  jobId: string,
  deps: CloudBuildDeps & { read: (file: string) => Promise<unknown> },
  signal: AbortSignal,
): Promise<void> {
  if (!JOB_ID.test(jobId)) return;
  for (let attempt = 0; !signal.aborted; attempt += 1) {
    await deps.sleep(pollDelayMs(attempt), signal);
    if (signal.aborted) return;
    const build = cloudBuildOf(await deps.cli(buildStatusArgs(jobId), signal).catch(() => null));
    if (!build || build.jobId !== jobId) continue;
    await keepBuild(dir, build, deps.read);
    if (!isRunning(build)) return;
  }
}
