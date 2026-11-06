/**
 * Apps Genex builds on its own computers: Unreal packages a game only for the system it runs on, so
 * a Windows app of an Unreal game made on a Mac is built by Genex from the game's project. The
 * Unreal project alone is staged (`stageBuildSource`), with no size limit of Studio's own, and goes privately with
 * `genex native build --platform <p> --source <folder>`; Genex builds it, checks it and puts it on
 * the game's page beside the apps the game already has. A big project takes far longer to go up than
 * any press may wait, so it is sent behind the press (`sendCloudBuild`) and how that goes is kept in
 * the publish workspace's `cloud-build.json` (apart from `native.json`, which each publish writes
 * anew). The build takes a while too: its jobs are kept there and followed with
 * `genex native build-status <job>` until each one ends.
 *
 * The CLI and Genex's side are a draft contract: nothing is asked while Studio's pinned CLI has no
 * `genex native build` (`pinnedCliBuildsApps`), and the dialog says where the app is packaged as before.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
// Read at build time, as `native-publish.ts` does: the packaged app ships the CLI only in the plugin's payload.
import cliPackage from "@genex-ai/cli-demo/package.json" with { type: "json" };
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  type GenexCloudBuild,
  type GenexCloudSend,
} from "../../shared/genex.ts";
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
/** How long a project may take to zip and go up: as long as the links Genex signs for its upload last. */
export const CLOUD_SEND_TIMEOUT_MS = 6 * HOUR_MS;
/** The longest reason a stopped send keeps, in the CLI's words. */
const SEND_ERROR_CHARS = 300;
/** The most lines of a failed build's log kept, and how long each may be: what Genex sends, no more. */
const BUILD_ERRORS_KEPT = 60;
const BUILD_ERROR_CHARS = 300;
/** A job id as Genex names one: a plain word the CLI takes as an argument, never an option. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The systems Genex builds apps for. */
export const CLOUD_PLATFORMS: ReadonlySet<string> = new Set([NativePlatform.Windows]);
/** The Unreal versions Genex's build computers have (`deploy/cloud-build/image`): a `.uproject`'s `EngineAssociation`. */
export const CLOUD_UNREAL_VERSIONS: ReadonlySet<string> = new Set(["5.8"]);

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

/** The error lines of `value` that are text, within what is kept; none when it is anything else. */
function errorsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines = value.filter((line): line is string => typeof line === "string" && line.trim() !== "");
  return lines.slice(0, BUILD_ERRORS_KEPT).map((line) => line.slice(0, BUILD_ERROR_CHARS));
}

/** One build as kept or answered, or null when anything in it is off. */
function buildOf(value: unknown): GenexCloudBuild | null {
  if (!isRecord(value)) return null;
  const { platform, jobId, state, startedAt, finishedAt, failure, errors } = value;
  const known = typeof platform === "string" && CLOUD_PLATFORMS.has(platform);
  const named = typeof jobId === "string" && JOB_ID.test(jobId);
  if (!known || !named || !STATES.has(state) || !isTime(startedAt)) return null;
  const failed = state === CloudBuildState.Failed;
  const lines = failed ? errorsOf(errors) : [];
  return {
    platform: String(platform),
    jobId: String(jobId),
    state: state as CloudBuildState,
    startedAt: String(startedAt),
    ...(isTime(finishedAt) ? { finishedAt } : {}),
    ...(failed ? { failure: failureOf(failure) } : {}),
    ...(lines.length > 0 ? { errors: lines } : {}),
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

const SEND_STATES: ReadonlySet<unknown> = new Set(Object.values(CloudSendState));

/** The send `cloud-build.json` keeps, or null when there is none or anything in it is off. */
export function readCloudSend(value: unknown): GenexCloudSend | null {
  const send = isRecord(value) ? value.send : undefined;
  if (!isRecord(send)) return null;
  const { platform, startedAt, state, error } = send;
  const known = typeof platform === "string" && CLOUD_PLATFORMS.has(platform);
  if (!known || !SEND_STATES.has(state) || !isTime(startedAt)) return null;
  return {
    platform: String(platform),
    startedAt: String(startedAt),
    state: state as CloudSendState,
    ...(typeof error === "string" ? { error } : {}),
  };
}

/** `builds` with `build` in place of the one with its job id, or added last; only the newest few kept. */
export function withBuild(builds: readonly GenexCloudBuild[], build: GenexCloudBuild): GenexCloudBuild[] {
  const others = builds.filter((kept) => kept.jobId !== build.jobId);
  return [...others, build].slice(-CLOUD_BUILDS_KEPT);
}

/** Refuse a system Genex builds no app for, before anything is kept or sent. */
export function assertCloudPlatform(platform: unknown): void {
  if (typeof platform !== "string" || !CLOUD_PLATFORMS.has(platform)) throw new Error(MESSAGE.UnknownPlatform);
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
  /** Copy what Genex builds the app from into `dest` (`stageBuildSource`). */
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

/** The workspace's send to Genex, if there is one. */
export async function loadCloudSend(
  dir: string,
  read: (file: string) => Promise<unknown>,
): Promise<GenexCloudSend | null> {
  return readCloudSend(await read(path.join(dir, CLOUD_BUILD_FILE)));
}

/** Keep `build` in the workspace's record; a send under way stays, unless this is the build it became. */
async function keepBuild(
  dir: string,
  build: GenexCloudBuild,
  read: (file: string) => Promise<unknown>,
  arrived = false,
) {
  const builds = withBuild(await loadCloudBuilds(dir, read), build);
  const send = arrived ? null : await loadCloudSend(dir, read);
  await atomicWriteJson(path.join(dir, CLOUD_BUILD_FILE), { builds, ...(send ? { send } : {}) });
}

/**
 * Forget every build of `platform` in the workspace's record: its app was taken off Genex, so none is
 * what players have. A send under way stays.
 */
export async function forgetCloudBuilds(dir: string, platform: string, read: (file: string) => Promise<unknown>) {
  const builds = (await loadCloudBuilds(dir, read)).filter((build) => build.platform !== platform);
  const send = await loadCloudSend(dir, read);
  await atomicWriteJson(path.join(dir, CLOUD_BUILD_FILE), { builds, ...(send ? { send } : {}) });
}

/** Keep `send` as the workspace's send, beside its builds. */
async function keepSend(dir: string, send: GenexCloudSend, read: (file: string) => Promise<unknown>) {
  const builds = await loadCloudBuilds(dir, read);
  await atomicWriteJson(path.join(dir, CLOUD_BUILD_FILE), { builds, send });
}

/** Say in the record that `platform`'s project is on its way, before the press answers. */
export async function beginCloudSend(
  dir: string,
  platform: string,
  read: (file: string) => Promise<unknown>,
  now = new Date(),
): Promise<GenexCloudSend> {
  const send = { platform, startedAt: now.toISOString(), state: CloudSendState.Sending };
  await keepSend(dir, send, read);
  return send;
}

/** The last line of a failed run: what the CLI said at the end, not its progress before that. */
function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  return (lines.filter(Boolean).at(-1) ?? "").slice(0, SEND_ERROR_CHARS);
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
  assertCloudPlatform(platform);
  const sourceDir = path.join(dir, CLOUD_SOURCE_FOLDER);
  try {
    await deps.stage(gameDir, sourceDir);
    const build = cloudBuildOf(await deps.cli(cloudBuildArgs(platform, sourceDir), signal));
    if (!build || build.platform !== platform) throw new Error(MESSAGE.NotABuild);
    await keepBuild(dir, build, deps.read, true);
    return build;
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/**
 * Run `send`'s `startCloudBuild` behind the press: answers the build Genex started, or null once the
 * record says why it stopped. Stopped here, it says no reason: only the CLI's refusals are one.
 */
export async function sendCloudBuild(
  dir: string,
  send: GenexCloudSend,
  gameDir: string,
  deps: CloudBuildDeps & { read: (file: string) => Promise<unknown> },
  signal: AbortSignal,
): Promise<GenexCloudBuild | null> {
  try {
    return await startCloudBuild(dir, send.platform, gameDir, deps, signal);
  } catch (error) {
    const reason = signal.aborted ? "" : lastLine(errorMessage(error));
    await keepSend(dir, { ...send, state: CloudSendState.Failed, ...(reason ? { error: reason } : {}) }, deps.read);
    return null;
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
