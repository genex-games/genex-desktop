/**
 * Run one Genex app lane (A/D, §5.3): an eval-owned production build of the SHA under test
 * (`git archive` + `npm ci` + `node scripts/build.mjs`, never a `--dev-build`), the product default
 * read from that build's own pure modules (D3), an `EvalLaneSpec` beside the run, and a smoke
 * sub-runner launch of Electron with the eval homes. The app writes an `EvalLaneReport`; this
 * module reads it back into a `LaneRunResult`.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { MINUTE_MS } from "../../../src/shared/duration.ts";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import {
  EVAL_LANE_EXIT,
  EVAL_LANE_REPORT_SCHEMA,
  type EvalCommission,
  EvalLaneErrorCode,
  type EvalExecutables,
  type EvalLaneReport,
  type EvalLaneSpec,
} from "../../../src/shared/eval-lane.ts";
import { PermissionMode } from "../../../src/shared/permissions.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import { isBelow } from "../../../src/substrate/paths.ts";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../electron-runtime.mjs";
import type { QuotaReader } from "../budget.ts";
import { EndedHow, EvalAgent, HarnessFailure, LaneMode } from "../vocabulary.ts";
import { assertNoBannedArgv, type CliResolver, genexAppArgv, resolveLaneCli } from "./argv.ts";
import {
  createRunWorkspace,
  evalHomesEnv,
  LANE_PID_FILE,
  strippedEnv,
  type SupervisorDeps,
  SYSTEM_SUPERVISOR,
  superviseProcess,
} from "./common.ts";
import { sameModel } from "./raw.ts";
import type { AppBuild, LaneRunArtifacts, LaneRunRequest, LaneRunResult } from "./types.ts";

/** A full Git commit SHA: the build id. */
export const APP_SHA_PATTERN = /^[0-9a-f]{40}$/;
/** The marker a finished eval build leaves, so the next run reuses it. */
const BUILD_MARKER = ".eval-build.json";
/** The switch that makes a development bundle; an eval build never carries it. */
const DEV_BUILD_SWITCH = "--dev-build";
/** The backstop past deadline + grace: the app's own stop path should have ended the run by then. */
export const APP_STOP_MARGIN_MS = 5 * MINUTE_MS;

/** The pure modules the product default is read from, inside the evaluated checkout. */
const DEFAULT_MODULES = { loop: "src/renderer/loop-setting.ts", permissions: "src/shared/permissions.ts" } as const;

/** A command's result. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How a command runs (no shell); injectable. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

/** Run a command to completion with piped output. */
export const systemRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** The step of an eval build that failed. */
export const AppBuildStep = {
  Archive: "archive",
  Extract: "extract",
  Install: "install",
  Build: "build",
} as const;
export type AppBuildStep = (typeof AppBuildStep)[keyof typeof AppBuildStep];

/** An eval build failed at a step. */
export class AppBuildError extends Error {
  readonly step: AppBuildStep;
  constructor(step: AppBuildStep, detail: string) {
    super(`eval app build failed at ${step}: ${detail.slice(-2000)}`);
    this.name = "AppBuildError";
    this.step = step;
  }
}

/** Run one build step; a non-zero exit is an `AppBuildError` for that step. */
async function step(
  run: CommandRunner,
  name: AppBuildStep,
  file: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  if (args.includes(DEV_BUILD_SWITCH)) throw new AppBuildError(name, "a development build is never evaluated");
  const result = await run(file, assertNoBannedArgv(args), options);
  if (result.code !== 0) throw new AppBuildError(name, result.stderr || result.stdout);
}

/**
 * The eval-owned production build of `sha`, at `<buildsDir>/<sha>`: reused when a finished one is
 * there, else rebuilt from `git archive` (never a worktree; the developer's `dist/` is untouched).
 */
export async function prepareAppBuild(input: {
  repo: string;
  sha: string;
  buildsDir: string;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<AppBuild> {
  if (!APP_SHA_PATTERN.test(input.sha)) throw new Error("not a full commit SHA");
  const run = input.run ?? systemRunner;
  const dir = path.join(input.buildsDir, input.sha);
  const marker = path.join(dir, BUILD_MARKER);
  if (await stat(marker).catch(() => null)) return { sha: input.sha, dir, dirty: false };
  if (!isBelow(input.buildsDir, dir)) throw new Error("build folder escapes the builds folder");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const env = strippedEnv(input.env ?? process.env);
  const tar = `${dir}.tar`;
  await step(run, AppBuildStep.Archive, "git", ["-C", input.repo, "archive", "--format=tar", "-o", tar, input.sha], {
    cwd: input.repo,
    env,
  });
  await step(run, AppBuildStep.Extract, "tar", ["-xf", tar, "-C", dir], { cwd: input.buildsDir, env });
  await rm(tar, { force: true });
  await step(run, AppBuildStep.Install, "npm", ["ci"], { cwd: dir, env });
  await step(run, AppBuildStep.Build, process.execPath, ["scripts/build.mjs"], { cwd: dir, env });
  await writeFile(marker, `${JSON.stringify({ sha: input.sha })}\n`, "utf8");
  return { sha: input.sha, dir, dirty: false };
}

/** The product default an eval lane sends, read from the evaluated build (D3). */
export interface ProductDefaults {
  commission: EvalCommission;
  permissionMode: PermissionMode;
}

/**
 * Run inside the evaluated checkout: import its Loop and permission modules with no storage and no
 * window, and report the commission a fresh game chat's composer sends, the default permission mode,
 * and any global the imports added (a module that adds one is not pure).
 */
const DEFAULTS_SCRIPT = `
import path from "node:path";
import { pathToFileURL } from "node:url";
const at = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
const before = new Set(Object.getOwnPropertyNames(globalThis));
const loop = await import(at(${JSON.stringify(DEFAULT_MODULES.loop)}));
const permissions = await import(at(${JSON.stringify(DEFAULT_MODULES.permissions)}));
const addedGlobals = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
const view = loop.composerLoopView({ own: loop.lastLoop(null), build: null });
const extras = loop.composerExtras({ gameMode: true, view, reviewPlan: false, frames: [] });
const send = extras.autopilot && typeof loop.autopilotSendOptions === "function"
  ? loop.autopilotSendOptions(extras.autopilot, null)
  : null;
process.stdout.write(JSON.stringify({ extras, send, permissionMode: permissions.DEFAULT_PERMISSION_MODE, addedGlobals }));
`;

/**
 * The Loop commission of a build older than `autopilotSendOptions` (loop-setting.ts), which it
 * predates: the composer's rule as it stood (∞ has no hours; no pictures, no frames; no roles).
 * A build that exports the function answers with its own result (`send`) instead.
 */
function legacyAutopilot(value: unknown): NonNullable<EvalCommission["autopilot"]> {
  const extras = (value && typeof value === "object" ? value : {}) as { hours?: unknown; reviewPlan?: unknown };
  return {
    ...(typeof extras.hours === "number" ? { hours: extras.hours } : {}),
    ...(extras.reviewPlan === true ? { reviewPlan: true } : {}),
  };
}

/** The keys a build's `autopilotSendOptions` answer may carry for a send with no pictures and no roles. */
const SEND_KEYS: ReadonlySet<string> = new Set(["hours", "reviewPlan"]);

/** The build's own answer, checked field by field; null when it had none (an older build). */
function sendFrom(value: unknown): NonNullable<EvalCommission["autopilot"]> | null {
  if (value === null || value === undefined) return null;
  const unreadable = new Error("product default commission unreadable");
  if (typeof value !== "object" || Array.isArray(value)) throw unreadable;
  const fields: Record<string, unknown> = { ...value };
  const { hours, reviewPlan } = fields;
  const shaped = Object.keys(fields).every((key) => SEND_KEYS.has(key));
  const hoursOk = hours === undefined || (typeof hours === "number" && Number.isFinite(hours));
  if (!shaped || !hoursOk || (reviewPlan !== undefined && reviewPlan !== true)) throw unreadable;
  return { ...(typeof hours === "number" ? { hours } : {}), ...(reviewPlan === true ? { reviewPlan: true } : {}) };
}

/** The commission a fresh chat's send carries: the build's own `autopilotSendOptions` answer, or the legacy rule. */
function commissionFrom(extras: Record<string, unknown>, send: unknown): EvalCommission {
  const autopilot = sendFrom(send) ?? legacyAutopilot(extras.autopilot);
  return {
    ...(extras.autopilot !== undefined ? { autopilot } : {}),
    ...(extras.reviewPlan === true ? { reviewPlan: true } : {}),
  };
}

/**
 * The evaluated build's product default: `lastLoop(null)` through `composerExtras`, and
 * `DEFAULT_PERMISSION_MODE`, computed in a separate Node inside that checkout. Refuses a module that
 * adds a global when imported, a bypass mode, or an answer that is not the expected shape.
 */
export async function productDefaults(checkout: string, run: CommandRunner = systemRunner): Promise<ProductDefaults> {
  const result = await run(process.execPath, ["--input-type=module", "--eval", DEFAULTS_SCRIPT], {
    cwd: checkout,
    env: strippedEnv(process.env),
  });
  if (result.code !== 0) throw new Error(`product defaults unreadable: ${result.stderr.slice(-500)}`);
  const answer = JSON.parse(result.stdout) as {
    extras?: unknown;
    send?: unknown;
    permissionMode?: unknown;
    addedGlobals?: unknown;
  };
  const modes: readonly unknown[] = Object.values(PermissionMode);
  const mode = answer.permissionMode;
  if (!modes.includes(mode) || mode === PermissionMode.Bypass)
    throw new Error("product default permission mode refused");
  if (!Array.isArray(answer.addedGlobals) || answer.addedGlobals.length)
    throw new Error("product default modules are not pure");
  if (!answer.extras || typeof answer.extras !== "object") throw new Error("product default commission unreadable");
  return {
    commission: commissionFrom(answer.extras as Record<string, unknown>, answer.send),
    permissionMode: mode as PermissionMode,
  };
}

/**
 * Where a Genex run keeps its profile, games, spec and report under a root: its lane root while it
 * runs (the app's `workRoot`), its work root once the scheduler moved them. Its logs stay in the work root.
 */
export function genexPaths(workRoot: string): {
  userDataRoot: string;
  gamesRoot: string;
  specPath: string;
  reportPath: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const at = (name: string) => path.join(workRoot, name);
  return {
    userDataRoot: at("userdata"),
    gamesRoot: at("games"),
    specPath: at("lane-spec.json"),
    reportPath: at("lane-report.json"),
    stdoutPath: at("stdout.log"),
    stderrPath: at("stderr.log"),
  };
}

/**
 * The spec the app launch reads. Auto lanes (Loop off) send no commission. `executables` pins the
 * CLIs to the raw lanes' own paths (§5.2); absent, the app's own discovery picks them.
 */
export function laneSpec(
  request: LaneRunRequest,
  defaults: ProductDefaults,
  executables?: EvalExecutables,
): EvalLaneSpec {
  const paths = genexPaths(request.laneRoot);
  return {
    runId: request.runId,
    laneId: request.lane.id,
    caseId: request.evalCase.id,
    engine: request.lane.engine,
    model: request.lane.model,
    effort: request.lane.effort,
    brief: request.evalCase.brief,
    suffix: request.suffix,
    commission: request.lane.mode === LaneMode.Auto ? {} : defaults.commission,
    permissionMode: defaults.permissionMode,
    deadlineMs: request.deadlineMs,
    graceMs: request.graceMs,
    answerPolicy: request.answerPolicy,
    maxAnswers: request.maxAnswers,
    codexHostSkillSuppression: request.lane.engine === EngineId.Codex,
    gamesRoot: paths.gamesRoot,
    userDataRoot: paths.userDataRoot,
    workRoot: request.laneRoot,
    homes: request.homes,
    reportPath: paths.reportPath,
    fixture: request.lane.fixture,
    ...(executables ? { executables } : {}),
    ...(request.lane.disabledPlugins ? { disabledPlugins: [...request.lane.disabledPlugins] } : {}),
  };
}

/** The spec key each coding CLI is pinned under. */
const EXECUTABLE_KEY = { [EngineId.ClaudeCode]: "claude", [EngineId.Codex]: "codex" } as const satisfies Record<
  Exclude<CodingProvider, typeof EngineId.OpenCode>,
  keyof EvalExecutables
>;

/**
 * Both coding CLIs as the raw lanes resolve them (the same `CliResolver`), so a Genex lane runs the
 * binaries a raw lane would (§5.2). A CLI that cannot be resolved is left to the app's discovery.
 */
export async function laneExecutables(resolve: CliResolver): Promise<EvalExecutables> {
  const executables: EvalExecutables = {};
  for (const engine of [EngineId.ClaudeCode, EngineId.Codex] as const) {
    const cli = await resolve(engine).catch(() => null);
    if (cli) executables[EXECUTABLE_KEY[engine]] = cli.path;
  }
  return executables;
}

/**
 * The app launch's environment: the fixture launch environment (mock keychain for the app's own
 * store), live credential checks on for a live lane, the eval homes and the auto-updater off.
 */
export function genexAppEnv(parent: NodeJS.ProcessEnv, spec: EvalLaneSpec): NodeJS.ProcessEnv {
  return {
    ...fixtureElectronEnv(strippedEnv(parent)),
    STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS: spec.fixture ? "0" : "1",
    ...evalHomesEnv(spec.homes),
  };
}

/** A lane report read back, or null when it is missing or not this schema. */
export async function readLaneReport(file: string): Promise<EvalLaneReport | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<EvalLaneReport>;
    return value.schema === EVAL_LANE_REPORT_SCHEMA ? (value as EvalLaneReport) : null;
  } catch {
    return null;
  }
}

/**
 * The harness failure each lane-runner error is (§5.5): the app's own failures are typed like a raw
 * lane's, excluded from n and replaced. A stop that failed after the run, or the rail's SIGKILL,
 * leaves the agent's ending as it was.
 */
const LANE_ERROR_FAILURE = {
  [EvalLaneErrorCode.EngineNotReady]: HarnessFailure.EngineNotReady,
  [EvalLaneErrorCode.UnknownModel]: HarnessFailure.AppFailed,
  [EvalLaneErrorCode.ThreadFailed]: HarnessFailure.AppFailed,
  [EvalLaneErrorCode.ReportWriteFailed]: HarnessFailure.AppFailed,
  [EvalLaneErrorCode.PluginNotDisabled]: HarnessFailure.AppFailed,
  [EvalLaneErrorCode.StopFailed]: null,
  [EvalLaneErrorCode.RailSigkill]: null,
} as const satisfies Record<EvalLaneErrorCode, HarnessFailure | null>;

/** The first lane-runner error that is a harness failure, or `app-failed` for a harness-failure ending with none. */
function laneErrorFailure(report: EvalLaneReport): HarnessFailure | null {
  for (const error of report.errors) {
    const failure = LANE_ERROR_FAILURE[error.code];
    if (failure) return failure;
  }
  return report.endedHow === EndedHow.HarnessFailure ? HarnessFailure.AppFailed : null;
}

/**
 * Whether the report shows every plugin the lane turns off as off. A build from before plugin pins
 * reports no plugins, so it cannot show one off: its run is not the lane it claims to be.
 */
function pluginsOff(report: EvalLaneReport, disabledPlugins: readonly string[]): boolean {
  return disabledPlugins.every((id) => report.plugins?.some((plugin) => plugin.id === id && !plugin.enabled));
}

/**
 * The guard a lane report trips: the app's lane runner failed, the harness differs from the shipped
 * seed, a plugin the lane turns off was not off, or another model was served.
 */
export function reportHarnessFailure(
  report: EvalLaneReport,
  disabledPlugins: readonly string[] = [],
): HarnessFailure | null {
  const failed = laneErrorFailure(report);
  if (failed) return failed;
  if (!report.harnessDigest.matches || !pluginsOff(report, disabledPlugins)) return HarnessFailure.Contamination;
  const served = report.modelServed;
  if (!report.fixture && served !== null && !sameModel(served, report.modelRequested))
    return HarnessFailure.ServedModelMismatch;
  return null;
}

/** Exits that mean the app's lane runner refused or failed before it could report (not the game crashing). */
const APP_FAILED_EXITS: ReadonlySet<number | null> = new Set([EVAL_LANE_EXIT.Refused, EVAL_LANE_EXIT.Failed]);

/** The failure of a launch that left no report: a refusal or a failed lane runner is the app's; anything else is not typed. */
function missingReportFailure(exitCode: number | null, railFired: boolean): HarnessFailure | null {
  return !railFired && APP_FAILED_EXITS.has(exitCode) ? HarnessFailure.AppFailed : null;
}

/** What a Genex lane needs from the machine; every part is injectable. */
export interface GenexLaneDeps {
  supervisor: SupervisorDeps;
  run: CommandRunner;
  resolveElectron: (checkout: string) => string;
  /** The raw lanes' CLI discovery, which a live Genex lane pins its executables to. */
  resolveCli: CliResolver;
  readQuota: QuotaReader | null;
  parentEnv: NodeJS.ProcessEnv;
  home: string;
}

/** The machine's own dependencies for a Genex lane. */
export function systemGenexLaneDeps(home: string, readQuota: QuotaReader | null = null): GenexLaneDeps {
  return {
    supervisor: SYSTEM_SUPERVISOR,
    run: systemRunner,
    resolveElectron,
    resolveCli: resolveLaneCli,
    readQuota,
    parentEnv: process.env,
    home,
  };
}

/** Where a Genex run's artifacts are. */
function genexArtifacts(request: LaneRunRequest, projectDir: string): LaneRunArtifacts {
  const paths = genexPaths(request.laneRoot);
  const logs = genexPaths(request.workRoot);
  return {
    workRoot: request.workRoot,
    laneRoot: request.laneRoot,
    projectDir,
    streamPath: null,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
    transcriptHomes: request.homes,
    snapshotDir: path.join(request.workRoot, "snapshots"),
    finalSnapshotDir: null,
    eventLogDir: paths.userDataRoot,
    reportPath: paths.reportPath,
    specPath: paths.specPath,
  };
}

/** How the run ended: the report's word, or the backstop rail, or a crash when there is no report. */
function genexEndedHow(report: EvalLaneReport | null, railFired: boolean, failure: HarnessFailure | null): EndedHow {
  if (failure) return EndedHow.HarnessFailure;
  if (report) return report.endedHow;
  return railFired ? EndedHow.Deadline : EndedHow.Crash;
}

/** Launch the evaluated build on one lane and read its report into a `LaneRunResult`. */
export async function runGenexAppLane(request: LaneRunRequest, deps: GenexLaneDeps): Promise<LaneRunResult> {
  if (request.lane.agent !== EvalAgent.GenexApp) throw new Error(`lane ${request.lane.id} is not a Genex lane`);
  const build = request.appBuild;
  if (!build) throw new Error("a Genex lane needs an eval app build");
  const paths = genexPaths(request.laneRoot);
  const logs = genexPaths(request.workRoot);
  const artifacts = genexArtifacts(request, paths.gamesRoot);
  if (!request.live)
    return genexResult(request, artifacts, { at: deps.supervisor.clock.now(), railFired: false }, null);
  await createRunWorkspace(request.workRoot, deps.home, request.laneRoot);
  await mkdir(paths.gamesRoot, { recursive: true });
  const executables = request.lane.fixture ? undefined : await laneExecutables(deps.resolveCli);
  const spec = laneSpec(request, await productDefaults(build.dir, deps.run), executables);
  await writeFile(paths.specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  const engine = request.lane.engine === EngineId.Codex ? EngineId.Codex : EngineId.ClaudeCode;
  const quotaBefore = (await deps.readQuota?.(engine)) ?? null;
  const args = genexAppArgv({
    buildDir: build.dir,
    userDataRoot: paths.userDataRoot,
    specPath: paths.specPath,
    fixture: spec.fixture,
  });
  const outcome = await superviseProcess(
    {
      file: deps.resolveElectron(build.dir),
      args: fixtureElectronArgs([...args]),
      cwd: request.laneRoot,
      env: genexAppEnv(deps.parentEnv, spec),
      stdin: null,
      streamPath: null,
      stdoutPath: logs.stdoutPath,
      stderrPath: logs.stderrPath,
      railMs: request.deadlineMs + request.graceMs + APP_STOP_MARGIN_MS,
      pidPath: path.join(request.workRoot, LANE_PID_FILE),
    },
    deps.supervisor,
  );
  const quotaAfter = (await deps.readQuota?.(engine)) ?? null;
  const report = await readLaneReport(paths.reportPath);
  const timing = {
    at: outcome.endedAtMs,
    startedAt: outcome.startedAtMs,
    railFired: outcome.railFired,
    exitCode: outcome.exitCode,
  };
  return {
    ...genexResult(request, artifacts, timing, report),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    quotaBefore,
    quotaAfter,
  };
}

/** The version of the CLI the reported engine ran on. */
function reportCliVersion(report: EvalLaneReport): string | null {
  return report.engine === EngineId.Codex ? report.cliVersions.codex : report.cliVersions.claude;
}

/** A `LaneRunResult` from the report (null: the app wrote none, or the run was a dry run). */
function genexResult(
  request: LaneRunRequest,
  artifacts: LaneRunArtifacts,
  timing: { at: number; startedAt?: number; railFired: boolean; exitCode?: number | null },
  report: EvalLaneReport | null,
): LaneRunResult {
  const disabledPlugins = request.lane.disabledPlugins ?? [];
  const failure = report
    ? reportHarnessFailure(report, disabledPlugins)
    : missingReportFailure(timing.exitCode ?? null, timing.railFired);
  const cliVersion = report ? reportCliVersion(report) : null;
  const endedHow = request.live ? genexEndedHow(report, timing.railFired, failure) : EndedHow.Cancelled;
  return {
    runId: request.runId,
    artifacts: { ...artifacts, projectDir: report?.projectDir ?? artifacts.projectDir },
    startedAt: report?.startedAt ?? new Date(timing.startedAt ?? timing.at).toISOString(),
    endedAt: report?.endedAt ?? new Date(timing.at).toISOString(),
    endedHow,
    harnessFailure: failure,
    noBuild: null,
    exitCode: null,
    signal: null,
    cliVersion,
    questionsAsked: report?.questionsAsked ?? 0,
    answersGiven: report?.answers.length ?? 0,
    quotaBefore: null,
    quotaAfter: null,
    contaminationClean: report ? report.harnessDigest.matches && pluginsOff(report, disabledPlugins) : false,
  };
}
