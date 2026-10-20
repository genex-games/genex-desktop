/**
 * Packaging an Unreal plugin with the engine's AutomationTool: `RunUAT.sh BuildPlugin` copies the
 * plugin into a host project of its own inside the package folder, builds it for the Mac and leaves
 * the plugin there ready to install. It runs in UnrealBuildTool's sandbox (`ubt-sandbox.ts`), which
 * may also write the package folder, with UAT's logs in the sandbox's scratch folder
 * (`uebp_LogFolder`) instead of the engine's. Success is exit code 0 and UAT's `BUILD SUCCESSFUL`;
 * errors are read as a build's (`ubt.ts`), so no absolute path of the user's machine reaches an agent.
 *
 * On Windows, `RunUAT.bat BuildPlugin … -TargetPlatforms=Win64` runs in Genex's own process sandbox
 * as a host job (`sandbox.run`): the backend can't hold that sandbox, and the job outlives the call
 * that starts it, so Genex owns it and the plugin reads how it ended later (`packageResultOf`). The
 * job asks to write only the package folder (and its scratch, where UAT logs), and to read the engine
 * and the project. A path cmd.exe's quoting can't carry (a quote, `%`, `!`) or a network share is
 * refused before anything is made.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type PluginSandboxJob, type PluginSandboxRunArgs, SandboxJobState } from "../../shared/plugins.ts";
import { prepareBuildSandbox } from "./ubt-sandbox.ts";
import {
  type CompileError,
  type PrepareSandbox,
  parseBuildErrors,
  type RunCommand,
  type RunOutcome,
  systemRunCommand,
} from "./ubt.ts";

/** How long a package may take before its process tree is ended: BuildPlugin builds the plugin from scratch. */
export const PACKAGE_TIMEOUT_MS = 45 * MINUTE_MS;
/** The platforms Genex packages Unreal plugins on (Xcode on a Mac, Genex's sandbox job on Windows). */
const MAC = "darwin";
const WINDOWS = "win32";
/** The platform each packages for, by the platform Genex runs on. */
const TARGET_PLATFORM: Partial<Record<NodeJS.Platform, string>> = { [MAC]: "Mac", [WINDOWS]: "Win64" };
/** UAT's log folder inside the sandbox's scratch folder. */
const LOG_FOLDER = "uat-logs";
/** The variable naming UAT's log folder: on Windows a scratch folder of the host job's own. */
const LOG_FOLDER_ENV = "uebp_LogFolder";
const BATCH_FILES = ["Engine", "Build", "BatchFiles"];
/** What cmd.exe's quoting can't carry in a path: a quote, `%`, `!` or a control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const UNCARRIED = /["%!\x00-\x1f]/;
/** A network share or a device path: never handed to the sandbox. */
const NETWORK_PATH = /^(?:\\\\|\/\/)/;
const SUCCEEDED = /\bBUILD SUCCESSFUL\b/;
const ERROR_CODE = /^[A-Z0-9_]+$/;

/** Why a package didn't pass. */
export const PackageFailure = {
  /** Not a Mac. */
  Unsupported: "unsupported",
  /** A folder Genex won't hand UAT; nothing ran. */
  Invalid: "invalid",
  /** UAT ran and the build failed: the errors say why. */
  Failed: "failed",
  TimedOut: "timed-out",
  /** The caller stopped it. */
  Aborted: "aborted",
  /** RunUAT.sh or its sandbox couldn't be started. */
  NotStarted: "not-started",
} as const;
export type PackageFailure = (typeof PackageFailure)[keyof typeof PackageFailure];

/** A package's outcome: whether UAT succeeded, how long it ran, its first errors and one line for people. */
export type PackageResult = {
  ok: boolean;
  seconds: number;
  errors: CompileError[];
  summary: string;
  failure?: PackageFailure;
};

/** One package: the engine, the host project's folder, the plugin's descriptor and the package folder inside the project. */
export type PackageOptions = {
  engineDir: string;
  projectDir: string;
  pluginFile: string;
  packageDir: string;
  xcodeApp: string | null;
  signal?: AbortSignal;
  run?: RunCommand;
  prepareSandbox?: PrepareSandbox;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  timeoutMs?: number;
};

const MESSAGE = {
  Packaged: (seconds: number) => `The plugin was packaged in ${seconds} s.`,
  Failed: (errors: number) =>
    errors === 0 ? "BuildPlugin failed." : `BuildPlugin failed: ${errors} error${errors === 1 ? "" : "s"}.`,
  Unsupported: "Genex packages Unreal plugins on a Mac with Xcode, or on Windows.",
  Uncarried:
    "Genex won't package here: the game's path holds a quote, % or !, which cmd.exe can't carry, or is on a network share. Move the game to a plain local folder.",
  Invalid: "Genex won't package: a folder isn't a full path.",
  TimedOut: (seconds: number) => `The package was stopped after ${seconds} s.`,
  Aborted: "The package was stopped.",
  NotStarted: (code: string) => `AutomationTool couldn't start (${code}).`,
} as const;

const failed = (failure: PackageFailure, summary: string, seconds = 0): PackageResult => ({
  ok: false,
  seconds,
  errors: [],
  summary,
  failure,
});

/** Only an error's code (ENOENT, EACCES): its message names an absolute path. */
function errorCode(failure: unknown): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

/** Whether every folder of the package is a full path. */
const fullPaths = (o: PackageOptions) =>
  [o.engineDir, o.projectDir, o.pluginFile, o.packageDir].every((folder) => path.isAbsolute(folder));

/** BuildPlugin's arguments for the platform Genex runs on: the plugin, the package folder, the target. */
const buildPluginArgs = (o: Pick<PackageOptions, "pluginFile" | "packageDir">, platform: NodeJS.Platform) => [
  "BuildPlugin",
  `-Plugin=${o.pluginFile}`,
  `-Package=${o.packageDir}`,
  `-TargetPlatforms=${TARGET_PLATFORM[platform]}`,
  "-NoP4",
];

/** RunUAT once in UBT's sandbox, which may also write the package folder; the sandbox is gone afterwards. */
async function runConfined(options: PackageOptions, signal: AbortSignal): Promise<RunOutcome> {
  const script = path.join(options.engineDir, ...BATCH_FILES, "RunUAT.sh");
  const args = buildPluginArgs(options, MAC);
  const sandbox = await (options.prepareSandbox ?? prepareBuildSandbox)({
    projectDir: options.projectDir,
    engineDir: options.engineDir,
    xcodeApp: options.xcodeApp,
    ...(options.home ? { home: options.home } : {}),
    extraWrites: [options.packageDir],
  });
  try {
    const logs = path.join(sandbox.cwd, LOG_FOLDER);
    await mkdir(logs, { recursive: true });
    const confined = { ...sandbox, env: { ...sandbox.env, uebp_LogFolder: logs } };
    return await (options.run ?? systemRunCommand)(script, args, { signal, sandbox: confined });
  } finally {
    await sandbox.dispose();
  }
}

/**
 * Packages the plugin with `RunUAT.sh BuildPlugin -Plugin=… -Package=… -TargetPlatforms=Mac -NoP4`
 * in UBT's sandbox. Never throws: off a Mac, for a folder that isn't a full path, when stopped,
 * past the deadline or when UAT can't start, the result says so.
 */
export async function packagePlugin(options: PackageOptions): Promise<PackageResult> {
  if ((options.platform ?? process.platform) !== MAC) return failed(PackageFailure.Unsupported, MESSAGE.Unsupported);
  if (!fullPaths(options)) return failed(PackageFailure.Invalid, MESSAGE.Invalid);
  const now = options.now ?? Date.now;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? PACKAGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const started = now();
  let outcome: RunOutcome;
  try {
    outcome = await runConfined(options, signal);
  } catch (failure) {
    return failed(PackageFailure.NotStarted, MESSAGE.NotStarted(errorCode(failure)));
  } finally {
    clearTimeout(timer);
  }
  const seconds = Math.round((now() - started) / SECOND_MS);
  if (outcome.code === 0 && SUCCEEDED.test(outcome.output))
    return { ok: true, seconds, errors: [], summary: MESSAGE.Packaged(seconds) };
  if (options.signal?.aborted) return failed(PackageFailure.Aborted, MESSAGE.Aborted, seconds);
  if (deadline.signal.aborted) return failed(PackageFailure.TimedOut, MESSAGE.TimedOut(seconds), seconds);
  const errors = await parseBuildErrors(outcome.output, options);
  return { ...failed(PackageFailure.Failed, MESSAGE.Failed(errors.length), seconds), errors };
}

/** A package on Windows: the engine, the host project's folder, the plugin's descriptor and the package folder. */
export type WindowsPackage = Pick<PackageOptions, "engineDir" | "projectDir" | "pluginFile" | "packageDir">;

/** Why Genex won't hand these folders to its sandbox on Windows, or undefined when it will. */
export function windowsPackageProblem(o: WindowsPackage): string | undefined {
  const folders = [o.engineDir, o.projectDir, o.pluginFile, o.packageDir];
  if (!folders.every((folder) => path.isAbsolute(folder))) return MESSAGE.Invalid;
  if (folders.some((folder) => UNCARRIED.test(folder) || NETWORK_PATH.test(folder))) return MESSAGE.Uncarried;
  return undefined;
}

/**
 * The host job that packages the plugin on Windows: `RunUAT.bat BuildPlugin -Plugin=… -Package=…
 * -TargetPlatforms=Win64 -NoP4` reading the engine and the project, writing the package folder, UAT's
 * logs in the job's scratch, within {@link PACKAGE_TIMEOUT_MS}.
 */
export function windowsPackageJob(o: WindowsPackage): PluginSandboxRunArgs {
  return {
    program: path.join(o.engineDir, ...BATCH_FILES, "RunUAT.bat"),
    args: buildPluginArgs(o, WINDOWS),
    reads: [o.engineDir, o.projectDir],
    writes: [o.packageDir],
    scratchEnv: [LOG_FOLDER_ENV],
    timeoutMs: PACKAGE_TIMEOUT_MS,
  };
}

/** A host job's end as a package's result: UAT's success, its errors read as a build's, or why it ended. */
export async function packageResultOf(job: PluginSandboxJob, o: WindowsPackage): Promise<PackageResult> {
  const seconds = job.seconds ?? 0;
  if (job.state === SandboxJobState.Stopped) return failed(PackageFailure.Aborted, MESSAGE.Aborted, seconds);
  if (job.state === SandboxJobState.TimedOut)
    return failed(PackageFailure.TimedOut, MESSAGE.TimedOut(seconds), seconds);
  if (job.state === SandboxJobState.Failed)
    return failed(PackageFailure.NotStarted, MESSAGE.NotStarted(errorCode({ code: job.reason })));
  const output = `${job.stdout ?? ""}\n${job.stderr ?? ""}`;
  if (job.exitCode === 0 && SUCCEEDED.test(output))
    return { ok: true, seconds, errors: [], summary: MESSAGE.Packaged(seconds) };
  const errors = await parseBuildErrors(output, o);
  return { ...failed(PackageFailure.Failed, MESSAGE.Failed(errors.length), seconds), errors };
}
