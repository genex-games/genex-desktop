/**
 * Shipping an Unreal plugin from its host project: four agent tools for a game with an
 * `unreal-plugin` fact. `plugin-build` runs under the editor lock (the person-first check comes
 * before it): it saves the person's work in Unreal, quits it and waits, then builds the host's
 * editor target, which compiles the project's plugins too, as a background job that opens Unreal
 * again after a good build and leaves it closed after a failed one. `plugin-test` runs the plugin's
 * automation tests headless (`automation-tests.ts`) and keeps a summary; `plugin-package` runs
 * BuildPlugin in UnrealBuildTool's sandbox (`uat.ts`) and keeps a note of the package; both are jobs
 * that `stop` ends. `plugin-status` says how each stands and lists the proof a finish can name.
 * On Windows the package is a job Genex runs in its own process sandbox (`sandbox.run`) and owns: the
 * record stays running until a later call of these tools sees the host's job ended, and that call
 * writes the note.
 *
 * One job runs at a time per project, each kept as its plugin's own; the backend stopping ends every
 * running job's process group. Every path an agent reads is relative to the game's folder (a test
 * run's output is scrubbed of the computer's paths), and the folders the jobs write
 * (`Saved/Genex/Tests/<Plugin>`, `Saved/Genex/Packages/<Plugin>`) are made, emptied and written in
 * without following a link.
 */
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { PluginContext, PluginHostCall } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type PluginSandboxJob, PluginService, SandboxJobState } from "../../shared/plugins.ts";
import {
  createFileInDir,
  ensureDirBelow,
  isJsonObject,
  readRegularFile,
  replaceFile,
  writeFileInDir,
} from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import {
  AUTOMATION_REPORT,
  type AutomationResult,
  automationArgs,
  editorCmdPath,
  isTestFilter,
  type RunProgram,
  readAutomationReport,
  systemRunProgram,
  TEST_TIMEOUT_MS,
} from "./automation-tests.ts";
import { projectModule } from "./cpp-module.ts";
import { CppEditorTool } from "./cpp-tools.ts";
import {
  buildErrors,
  type CloseWords,
  closeForBuild,
  OPEN_WAIT_MS,
  openAndWait,
  QUIT_WAIT_MS,
  type RestartDeps,
  type RestartTarget,
} from "./editor-restart.ts";
import { HELPER_FOLDER } from "./setup.ts";
import {
  type PackageResult,
  packagePlugin,
  packageResultOf,
  type WindowsPackage,
  windowsPackageJob,
  windowsPackageProblem,
} from "./uat.ts";
import {
  type CompileOptions,
  type CompileResult,
  canCompileCpp,
  compileEditor,
  type PrepareSandbox,
  pathScrubber,
  projectPluginDirs,
  type RunCommand,
} from "./ubt.ts";
import type { XcodeStatus } from "./xcode.ts";

/** The four tools, by their names after `unreal__`. */
export const ShipToolName = {
  PluginBuild: "plugin-build",
  PluginTest: "plugin-test",
  PluginPackage: "plugin-package",
  PluginStatus: "plugin-status",
} as const;
export type ShipToolName = (typeof ShipToolName)[keyof typeof ShipToolName];

/** Where one of a plugin's jobs stands: wire values `plugin-status` answers. */
export const ShipState = {
  Idle: "idle",
  Running: "running",
  Done: "done",
  Failed: "failed",
  Stopped: "stopped",
} as const;
export type ShipState = (typeof ShipState)[keyof typeof ShipState];

/** A plugin's three jobs, as `plugin-status` names them. */
const ShipJob = { Build: "build", Test: "test", Package: "package" } as const;
type ShipJob = (typeof ShipJob)[keyof typeof ShipJob];

/** What a job left: its one-line summary, the test counts and failures, and the paths of its report, package and note. */
export type ShipOutcome = Partial<AutomationResult> & {
  line?: string;
  report?: string;
  package?: string;
  note?: string;
};
/** One job as `plugin-status` reads it: its state, why it failed, how long it took, and what it left. */
export type ShipRecord = ShipOutcome & { state: ShipState; error?: string; seconds?: number };
/** `plugin-status`'s answer: the plugin, its three jobs, and the proof a finish can name, by paths inside the game. */
export type ShipStatus = { plugin: string; build: ShipRecord; test: ShipRecord; package: ShipRecord; proof: string[] };

/** What the plugin's tools need from the computer, the editor and the clock; tests stand in for every program. */
export type ShipToolsDeps = RestartDeps & {
  platform: NodeJS.Platform;
  engine(): Promise<Engine | undefined>;
  project(storage: string, game: string): Promise<string | undefined>;
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state"> & Partial<Pick<XcodeStatus, "app">>>;
  editorCall(storage: string, game: string, tool: CppEditorTool, args: Record<string, unknown>): Promise<unknown>;
  /** Builds the host's editor target; UnrealBuildTool's own unless a test stands in. */
  compile?(options: CompileOptions): Promise<CompileResult>;
  /** Runs the headless editor for the tests; `systemRunProgram` unless a test stands in. */
  runProgram?: RunProgram;
  /** Runs RunUAT in its sandbox, and makes the sandbox; the product's own unless a test stands in. */
  runCommand?: RunCommand;
  prepareSandbox?: PrepareSandbox;
  /** Aborts once the backend stops: every running job ends with it. */
  stopped?: AbortSignal;
};

type Engine = { version: string; directory: string };
type Args = Record<string, unknown>;
/** One call of a tool: the plugin's storage, the call's context and its arguments. */
type ShipCall = { storage: string; context: PluginContext; args: Args };

/** A plugin's name, as an agent names it: an identifier, as Unreal's plugin and module names are. */
const PLUGIN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DESCRIPTOR_EXTENSION = ".uplugin";
const GENEX_FOLDER = ["Saved", "Genex"];
const TESTS_FOLDER = [...GENEX_FOLDER, "Tests"];
const PACKAGES_FOLDER = [...GENEX_FOLDER, "Packages"];
const SHOTS_FOLDER = [...GENEX_FOLDER, "Shots"];
const SUMMARY_FILE = "summary.md";
const NOTE_EXTENSION = ".md";
const SHOT_SUFFIX = "-window.jpg";
/** A plugin descriptor is a few kilobytes. */
const DESCRIPTOR_MAX_BYTES = 256 * 1024;
/** What a package is built for, by the platform Genex runs on. */
const PACKAGED_FOR: Partial<Record<NodeJS.Platform, string>> = { darwin: "Mac", win32: "Win64" };
/** The platform whose package is a job Genex runs in its own sandbox. */
const WINDOWS = "win32";
const IDLE: ShipRecord = { state: ShipState.Idle };
const STARTED = { started: true } as const;
/** How many of a crashed test run's last output lines its summary keeps, and how long each may be. */
const LAST_LINES = 5;
const LAST_LINE_CHARS = 300;

/** What each job is doing, as a refusal names it. */
const BUSY_WORDS = {
  [ShipJob.Build]: "the plugin is building",
  [ShipJob.Test]: "its tests are running",
  [ShipJob.Package]: "it is being packaged",
} as const satisfies Record<ShipJob, string>;

const MESSAGE = {
  NoGame: "This call needs a game: run it from a game's chat or build.",
  NoProject: "This game isn't linked to an Unreal project, so there is no plugin to build.",
  OutsideGame: "This game's Unreal project isn't inside its folder; the plugin tools work on a project in unreal/.",
  NoEngine: "No supported Unreal is installed, so Genex can't build, test or package the plugin.",
  CannotCompile: (xcode: string) =>
    `This computer can't build Unreal C++ (Xcode: ${xcode}); an Unreal plugin is built on a Mac whose Xcode is ready.`,
  NoHostModule: "The host project has no C++ module of its own, so Genex can't build its plugin.",
  BadPlugin: "A plugin is named by its folder under Plugins/: a letter first, then letters, digits or _.",
  NoPlugin: "This project holds no Unreal plugin: new-plugin makes one.",
  NoSuchPlugin: (asked: string, names: string) =>
    `This project has no plugin called ${asked}. Its plugins: ${names || "none"}.`,
  Several: (names: string) => `This project holds several plugins (${names}); name the one you mean with plugin.`,
  BadFilter: "A test filter is the start of the tests' names: letters, digits, _ and dots, at most 80.",
  Busy: (doing: string) =>
    `Genex runs one job at a time for a project, and ${doing}. Read plugin-status, or stop it with stop: true.`,
  NotAFolder: (where: string) => `${where} isn't a plain folder in the project, so Genex wrote nothing there.`,
  OtherEditor:
    "Unreal is open, but this game's project isn't answering, so Genex can't save its work and didn't quit it to build the plugin. When it is this game's Unreal, call unreal__open-editor with restart: true (work not saved in it is lost), then try again; when it is another project's, ask the user to quit it.",
  NotSaved: (why: string) =>
    `Genex couldn't save your work in Unreal (${why}), so it left Unreal open and built nothing.`,
  NoSaveAnswer: "the Genex editor helper didn't answer",
  Unsaved: (names: string) => `Unreal didn't save ${names}, so Genex left it open and built nothing.`,
  NotClosed: `Unreal didn't close within ${QUIT_WAIT_MS / SECOND_MS} s, so Genex built nothing. Call unreal__quit-editor, then try again.`,
  NotBuilt: (why: string) => `${why}\nUnreal stays closed; fix the errors and call plugin-build again.`,
  NotAnswering: `Genex built the plugin, but Unreal didn't answer within ${OPEN_WAIT_MS / MINUTE_MS} minutes of opening it. Call unreal__open-editor to open it again.`,
  Stopped: "Stopped.",
  Lost: "Genex no longer knows this package job (it restarted, or the plugin was turned off); package again.",
  Restarting:
    "Genex is restarting Unreal for this project (reopening it, or adding its C++ module), so it built nothing. Build the plugin once Unreal answers again.",
  TimedOut: `The tests were stopped after ${TEST_TIMEOUT_MS / MINUTE_MS} minutes.`,
  Incomplete: (code: number | null, r: AutomationResult, last: string) =>
    `The headless editor exited ${code === null ? "without an exit code" : `with code ${code}`} before the tests finished (incomplete: ${r.passed} passed, ${r.failed} failed, ${r.notRun} not run so far).${last ? ` Its last lines:\n${last}` : ""}`,
  Tested: (r: AutomationResult) => `${r.passed} passed, ${r.failed} failed, ${r.notRun} not run.`,
  NoTests: (filter: string, plugin: string) =>
    `no tests matched ${filter}: write them under Source/${plugin}/Private/Tests/ with names starting ${plugin}.`,
} as const;

const CLOSE_WORDS: CloseWords = {
  otherEditor: MESSAGE.OtherEditor,
  notSaved: MESSAGE.NotSaved,
  noSaveAnswer: MESSAGE.NoSaveAnswer,
  unsaved: MESSAGE.Unsaved,
  notClosed: MESSAGE.NotClosed,
  stopped: MESSAGE.Stopped,
};

/** A project's plugin: its name (its folder's), its folder and its descriptor. */
type PluginFound = { name: string; folder: string; descriptor: string };
/**
 * The game and its linked project (`project`, as the restarts and the jobs know it), the game's real
 * folder, the project's real .uproject and folder, and the plugin the call is about.
 */
type ShipTarget = RestartTarget & { gameDir: string; projectFile: string; projectDir: string; plugin: PluginFound };
/** A target with the engine and the Xcode app UBT may read, for a job that runs the engine. */
type EngineTarget = ShipTarget & { engine: Engine; xcodeApp: string | null };

/** A path inside the game as an agent reads it: relative, with `/`. */
const shownIn = (gameDir: string, file: string) => path.relative(gameDir, file).split(path.sep).join("/");

/** The plugin's descriptor in its folder: `<Name>.uplugin` when there is one, else the first plain .uplugin. */
async function descriptorIn(folder: string, name: string): Promise<string | undefined> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(DESCRIPTOR_EXTENSION))
    .map((entry) => entry.name)
    .sort();
  const own = `${name}${DESCRIPTOR_EXTENSION}`;
  const file = files.includes(own) ? own : files[0];
  return file === undefined ? undefined : path.join(folder, file);
}

/**
 * The plugin a call is about: the one it names (a plain folder under Plugins/ with a .uplugin), else
 * the only one besides the Genex editor helper; several, none, or a name that isn't one, refused.
 */
export async function pluginOf(projectFile: string, asked: unknown): Promise<PluginFound> {
  if (asked !== undefined && (typeof asked !== "string" || !PLUGIN_NAME.test(asked)))
    throw new Error(MESSAGE.BadPlugin);
  const found: PluginFound[] = [];
  for (const folder of await projectPluginDirs(projectFile)) {
    const name = path.basename(folder);
    const descriptor = name === HELPER_FOLDER ? undefined : await descriptorIn(folder, name);
    if (descriptor) found.push({ name, folder, descriptor });
  }
  const names = found.map((plugin) => plugin.name).join(", ");
  if (asked !== undefined) {
    const named = found.find((plugin) => plugin.name === asked);
    if (!named) throw new Error(MESSAGE.NoSuchPlugin(asked, names));
    return named;
  }
  const [only, ...more] = found;
  if (!only) throw new Error(MESSAGE.NoPlugin);
  if (more.length > 0) throw new Error(MESSAGE.Several(names));
  return only;
}

/** The call's game, its linked project inside the game's folder by real path, and the plugin it names. */
async function shipTarget(
  deps: ShipToolsDeps,
  storage: string,
  context: PluginContext,
  args: Args,
): Promise<ShipTarget> {
  const game = context.project;
  if (!game || !context.directory) throw new Error(MESSAGE.NoGame);
  const linked = await deps.project(storage, game);
  if (!linked) throw new Error(MESSAGE.NoProject);
  const [gameDir, projectFile] = await Promise.all([realpath(context.directory), realpath(linked)]);
  if (!isInside(gameDir, projectFile)) throw new Error(MESSAGE.OutsideGame);
  const plugin = await pluginOf(projectFile, args.plugin);
  return { storage, game, project: linked, gameDir, projectFile, projectDir: path.dirname(projectFile), plugin };
}

/** The target's plugin's `job`, as the jobs know it. */
const jobOf = (target: ShipTarget, job: ShipJob): JobOf => ({
  project: target.project,
  plugin: target.plugin.name,
  job,
});

/** A target with the supported engine; with `compiles`, refused where Unreal C++ can't be built. */
async function engineTarget(deps: ShipToolsDeps, target: ShipTarget, compiles: boolean): Promise<EngineTarget> {
  const engine = await deps.engine();
  if (!engine) throw new Error(MESSAGE.NoEngine);
  const xcode = await deps.xcode(engine.directory);
  if (compiles && !canCompileCpp(xcode, deps.platform)) throw new Error(MESSAGE.CannotCompile(xcode.state));
  return { ...target, engine, xcodeApp: xcode.app ?? null };
}

/**
 * `name` made empty in the folder `steps` names under the project, every folder on the way a real
 * folder of its own (never a link), with the files `beside` it removed too (a package's note);
 * answers both by real path. Refused, naming the folder, otherwise.
 */
async function freshFolder(target: ShipTarget, steps: readonly string[], name: string, beside: string[] = []) {
  const shown = shownIn(target.gameDir, path.join(target.projectDir, ...steps, name));
  const refused = () => {
    throw new Error(MESSAGE.NotAFolder(shown));
  };
  const parent = await ensureDirBelow(target.projectDir, steps).catch(refused);
  for (const gone of [name, ...beside]) {
    // Checked again right before each removal: a folder swapped for a link since is never emptied.
    if ((await ensureDirBelow(target.projectDir, steps).catch(refused)) !== parent) refused();
    await rm(path.join(parent, gone), { recursive: true, force: true });
  }
  const dir = await ensureDirBelow(parent, [name]).catch(refused);
  return { parent, dir };
}

/** Throws Stopped when the call's own signal (the person's Stop, the host's ceiling) has aborted. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error(MESSAGE.Stopped);
}

/** One job of one plugin in one project. */
type JobOf = { project: string; plugin: string; job: ShipJob };
const jobKey = ({ project, plugin, job }: JobOf) => [project, plugin, job].join("\n");
const pluginKey = (project: string, plugin: string) => `${project}\n${plugin}`;

/** Every project's jobs, each its plugin's own: their records, and each running job's stop. */
function createJobs(deps: ShipToolsDeps) {
  const records = new Map<string, { of: JobOf; record: ShipRecord }>();
  const stops = new Map<string, AbortController>();
  /** Jobs Genex runs for the plugin (`sandbox.run`), by job key: the host's id and what ends the record once it ended. */
  const hosted = new Map<string, { of: JobOf; id: string; end: (job: PluginSandboxJob) => Promise<void> }>();
  const filters = new Map<string, string>();
  const running = (of: JobOf) => records.get(jobKey(of))?.record.state === ShipState.Running;
  /** The job running for any plugin of the project, if one does. */
  const runningIn = (project: string, job?: ShipJob) =>
    [...records.values()].find(
      ({ of, record }) => of.project === project && record.state === ShipState.Running && (!job || of.job === job),
    )?.of;
  deps.stopped?.addEventListener("abort", () => {
    for (const stop of stops.values()) stop.abort();
  });
  const put = (of: JobOf, record: ShipRecord) => records.set(jobKey(of), { of, record });
  /**
   * Reserves the plugin's `job` now, with no wait between the caller's busy check and this: it is
   * recorded running at once, so no other call starts beside it while the caller prepares. `run`
   * then does the work in the background (done, failed or stopped); `release` lets go of a
   * reservation whose preparation failed, the job's last record back as it was.
   */
  const reserve = (of: JobOf) => {
    const at = jobKey(of);
    const before = records.get(at);
    const stop = new AbortController();
    if (deps.stopped?.aborted) stop.abort();
    put(of, { state: ShipState.Running });
    stops.set(at, stop);
    const letGo = () => {
      if (stops.get(at) === stop) stops.delete(at);
    };
    const settle = (record: ShipRecord) => {
      if (stops.get(at) === stop) put(of, record);
    };
    /** Records how `work` ended, `seconds` long, and lets the job go. */
    const conclude = (work: Promise<ShipOutcome>, seconds: () => number) =>
      endRecord(work, stop.signal, seconds).then(settle).finally(letGo);
    return {
      signal: stop.signal,
      release() {
        if (stops.get(at) !== stop) return;
        if (before) records.set(at, before);
        else records.delete(at);
        letGo();
      },
      run(work: (signal: AbortSignal) => Promise<ShipOutcome>) {
        const started = deps.now();
        void conclude(work(stop.signal), () => Math.round((deps.now() - started) / SECOND_MS));
      },
      /**
       * Hands the job to the host's sandbox job `id`: it stays running until `sight` sees the host's
       * job ended, and `finish` then makes its outcome (a package's note) from how it ended.
       */
      hand(id: string, finish: (job: PluginSandboxJob) => Promise<ShipOutcome>) {
        const end = (job: PluginSandboxJob) => {
          if (job.state === SandboxJobState.Stopped) stop.abort();
          return conclude(finish(job), () => job.seconds ?? 0);
        };
        hosted.set(at, { of, id, end });
      },
    };
  };
  return {
    running,
    reserve,
    /** Whether any plugin of the project builds now. */
    building: (project: string) => runningIn(project, ShipJob.Build) !== undefined,
    record: (of: JobOf) => records.get(jobKey(of))?.record,
    filter: (project: string, plugin: string) => filters.get(pluginKey(project, plugin)),
    setFilter: (project: string, plugin: string, filter: string) => filters.set(pluginKey(project, plugin), filter),
    /** Refuses while any job of the project runs, whichever plugin's it is. */
    refuseBusy(project: string) {
      const busy = runningIn(project);
      if (busy) throw new Error(MESSAGE.Busy(BUSY_WORDS[busy.job]));
    },
    /** Stops the plugin's running `job`, through the host for a job Genex runs; answers whether one ran. */
    async stop(of: JobOf, host: PluginHostCall) {
      const at = jobKey(of);
      const stop = stops.get(at);
      stop?.abort();
      const held = hosted.get(at);
      if (held) {
        hosted.delete(at);
        await host(PluginService.SandboxStop, { id: held.id }).catch(() => {});
        put(of, { state: ShipState.Stopped });
        stops.delete(at);
      }
      return { stopped: stop !== undefined };
    },
    /**
     * Asks the host how each job it runs for the plugin stands, and ends the record of each that
     * ended: the first call to see it writes its outcome. A host that can't answer now leaves it running.
     */
    async sight(host: PluginHostCall) {
      for (const [at, held] of [...hosted]) {
        const job = await host(PluginService.SandboxResult, { id: held.id }).catch(() => undefined);
        if (job === undefined || job?.state === SandboxJobState.Running || hosted.get(at) !== held) continue;
        hosted.delete(at);
        if (job !== null) await held.end(job);
        else {
          put(held.of, { state: ShipState.Failed, error: MESSAGE.Lost });
          stops.delete(at);
        }
      }
    },
  };
}
type Jobs = ReturnType<typeof createJobs>;

/** How a job's work ended, as its record: done (`seconds` long), failed (with what it left) or stopped. */
async function endRecord(work: Promise<ShipOutcome>, stopped: AbortSignal, seconds: () => number): Promise<ShipRecord> {
  try {
    const outcome = await work;
    return stopped.aborted ? { state: ShipState.Stopped } : { state: ShipState.Done, seconds: seconds(), ...outcome };
  } catch (failure) {
    const failed = failure instanceof ShipFailure ? failure.outcome : {};
    const state = stopped.aborted ? ShipState.Stopped : ShipState.Failed;
    return { state, error: errorMessage(failure), ...failed };
  }
}

/** A job that failed but left something to read (a package's note). */
class ShipFailure extends Error {
  readonly outcome: ShipOutcome;
  constructor(message: string, outcome: ShipOutcome) {
    super(message);
    this.name = "ShipFailure";
    this.outcome = outcome;
  }
}

/** The build job: the host's editor target (its plugins with it), then Unreal opened and answering; a failed build leaves it closed. */
async function buildAndOpen(deps: ShipToolsDeps, target: EngineTarget, module: string, signal: AbortSignal) {
  const result = await (deps.compile ?? compileEditor)({
    engineDir: target.engine.directory,
    projectFile: target.projectFile,
    module,
    xcodeApp: target.xcodeApp,
    signal,
  });
  if (signal.aborted) throw new Error(MESSAGE.Stopped);
  if (!result.ok) throw new Error(MESSAGE.NotBuilt(`${result.summary}${buildErrors(result)}`));
  await openAndWait(deps, target, MESSAGE.NotAnswering);
  return { line: result.summary };
}

/** What `plugin-build` checks before it touches Unreal: another job of the project, or Genex restarting Unreal for it. */
type RestartBusy = (project: string) => boolean;

/**
 * `plugin-build`: refused while a test or package runs or Genex restarts the project's Unreal
 * otherwise; reserves the build, then saves the person's work in Unreal, quits it and waits (the call
 * holds the editor lock meanwhile, and the project reads as Genex's own restart throughout), then
 * starts the build job. A call stopped once Unreal was quit builds nothing and opens Unreal again.
 * Answers {started}.
 */
async function startBuild(deps: ShipToolsDeps, jobs: Jobs, call: ShipCall, otherRestart: RestartBusy) {
  const { storage, context, args } = call;
  stopIfAborted(context.signal);
  const target = await engineTarget(deps, await shipTarget(deps, storage, context, args), true);
  const module = await projectModule(target.projectFile);
  if (!module) throw new Error(MESSAGE.NoHostModule);
  const build = jobOf(target, ShipJob.Build);
  if (jobs.running(build)) return STARTED;
  jobs.refuseBusy(target.project);
  if (otherRestart(target.project)) throw new Error(MESSAGE.Restarting);
  const job = jobs.reserve(build);
  const save = () => deps.editorCall(target.storage, target.game, CppEditorTool.SaveAll, {});
  const closed = await closeForBuild(deps, target, save, CLOSE_WORDS, context.signal).catch((failure: unknown) => {
    job.release();
    throw failure;
  });
  if (context.signal?.aborted || job.signal.aborted) {
    job.release();
    // Stopped once Unreal was quit: the person gets it back, unless Genex itself is stopping.
    if (closed && !deps.stopped?.aborted) void openAndWait(deps, target, MESSAGE.NotAnswering).catch(() => {});
    throw new Error(MESSAGE.Stopped);
  }
  job.run((signal) => buildAndOpen(deps, target, module, signal));
  return STARTED;
}

/** A test run's summary, as `summary.md` keeps it. */
function testSummary(plugin: string, filter: string, line: string, result: AutomationResult): string {
  const failures = result.failures.map((f) => `- ${f.name}${f.messages.length ? `: ${f.messages.join("; ")}` : ""}`);
  const listed = failures.length ? ["", "## Failures", "", ...failures] : [];
  return [`# ${plugin} tests`, "", `Filter: ${filter}`, "", line, ...listed, ""].join("\n");
}

/** The test job: the headless editor runs the tests, the report is read and its summary kept beside it. */
async function runTests(deps: ShipToolsDeps, target: EngineTarget, filter: string, dir: string, signal: AbortSignal) {
  const run = deps.runProgram ?? systemRunProgram;
  const args = automationArgs(target.projectFile, filter, dir);
  const outcome = await run(editorCmdPath(target.engine.directory, deps.platform), args, {
    signal,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  if (signal.aborted) throw new Error(MESSAGE.Stopped);
  if (outcome.timedOut) throw new Error(MESSAGE.TimedOut);
  const scrub = await pathScrubber(target.projectDir, target.engine.directory);
  const result = scrubbedResult(await readAutomationReport(dir, outcome.output), scrub);
  const report = shownIn(target.gameDir, path.join(dir, SUMMARY_FILE));
  // An editor that exited badly before Automation wrote its report never finished the run.
  if (outcome.code !== 0 && !(await isPlainFile(path.join(dir, AUTOMATION_REPORT)))) {
    const line = MESSAGE.Incomplete(outcome.code, result, lastLines(outcome.output, scrub));
    await writeFileInDir(dir, SUMMARY_FILE, testSummary(target.plugin.name, filter, line, result));
    throw new ShipFailure(line, { line, ...result, report });
  }
  const ran = result.passed + result.failed + result.notRun > 0;
  const line = ran ? MESSAGE.Tested(result) : MESSAGE.NoTests(filter, target.plugin.name);
  await writeFileInDir(dir, SUMMARY_FILE, testSummary(target.plugin.name, filter, line, result));
  return { line, ...result, report };
}

/** A test result whose failure messages carry none of the computer's paths (Unreal's lines name them). */
const scrubbedResult = (result: AutomationResult, scrub: (text: string) => string): AutomationResult => ({
  ...result,
  failures: result.failures.map((failure) => ({ ...failure, messages: failure.messages.map(scrub) })),
});

/** A program's last few lines of output, each scrubbed of the computer's paths and clipped, for a run that ended badly. */
function lastLines(output: string, scrub: (text: string) => string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .slice(-LAST_LINES)
    .map((line) => scrub(line).slice(0, LAST_LINE_CHARS))
    .join("\n");
}

/**
 * A job's folder made fresh once the job is reserved (`freshFolder`), never for a call already
 * stopped; a stopped call or a folder that won't make releases the reservation.
 */
async function preparedFolder(
  job: ReturnType<Jobs["reserve"]>,
  signal: AbortSignal | undefined,
  make: () => Promise<{ parent: string; dir: string }>,
) {
  try {
    stopIfAborted(signal);
    return await make();
  } catch (failure) {
    job.release();
    throw failure;
  }
}

/** `plugin-test`: stops the running tests with `stop`; else starts them (filter: the plugin's name) unless another job runs. */
async function startTests(deps: ShipToolsDeps, jobs: Jobs, call: ShipCall) {
  const { storage, context, args } = call;
  const target = await shipTarget(deps, storage, context, args);
  const tests = jobOf(target, ShipJob.Test);
  if (args.stop === true) return jobs.stop(tests, context.host);
  stopIfAborted(context.signal);
  const filter = args.filter === undefined ? target.plugin.name : args.filter;
  if (!isTestFilter(filter)) throw new Error(MESSAGE.BadFilter);
  const engine = await engineTarget(deps, target, false);
  const plugin = target.plugin.name;
  if (jobs.running(tests)) return { ...STARTED, filter: jobs.filter(target.project, plugin) ?? filter };
  jobs.refuseBusy(target.project);
  const job = jobs.reserve(tests);
  const { dir } = await preparedFolder(job, context.signal, () => freshFolder(target, TESTS_FOLDER, plugin));
  jobs.setFilter(target.project, plugin, filter);
  job.run((signal) => runTests(deps, engine, filter, dir, signal));
  return { ...STARTED, filter };
}

/** Every file under `dir`, not following links: how many and their bytes. */
async function filesIn(dir: string): Promise<{ count: number; bytes: number }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  let count = 0;
  let bytes = 0;
  for (const entry of entries.filter((e) => e.isFile())) {
    count++;
    bytes += (await lstat(path.join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0;
  }
  return { count, bytes };
}

/** A descriptor's VersionName, or "" when it doesn't read as a plain file within its cap (never a FIFO or a link). */
async function versionName(file: string): Promise<string> {
  const bytes = await readRegularFile(file, DESCRIPTOR_MAX_BYTES).catch(() => null);
  if (!bytes) return "";
  const text = bytes.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
    return isJsonObject(parsed) && typeof parsed.VersionName === "string" ? parsed.VersionName : "";
  } catch {
    return "";
  }
}

/** The package note: where the package is, its version, its files and platforms, or why it failed. */
async function packageNote(
  target: EngineTarget,
  dir: string,
  result: { summary: string; errors: string; platform: NodeJS.Platform },
): Promise<string> {
  const { summary, errors } = result;
  const shown = shownIn(target.gameDir, dir);
  const head = [`# ${target.plugin.name} package`, "", summary, ""];
  if (errors) return [...head, "## Errors", errors.trim(), ""].join("\n");
  const packaged = path.join(dir, path.basename(target.plugin.descriptor));
  const version = (await versionName(packaged)) || (await versionName(target.plugin.descriptor));
  const { count, bytes } = await filesIn(dir);
  const kib = Math.max(1, Math.round(bytes / 1024));
  const facts = [
    `Package: ${shown}`,
    `Version: ${version || "unknown"}`,
    `${count} files, ${kib} KiB`,
    `Platforms: ${PACKAGED_FOR[result.platform] ?? ""}`,
  ];
  return [...head, ...facts.map((fact) => `- ${fact}`), ""].join("\n");
}

/**
 * The package note, written whole or not at all (a backend stopped mid-write leaves no half a note)
 * in the packages folder as it is now: one swapped for a link during the job is refused, never
 * written through; the note's temp file is created exclusively and renamed within the folder.
 */
async function writeNote(target: ShipTarget, parent: string, name: string, text: string): Promise<void> {
  const refused = () => {
    throw new Error(MESSAGE.NotAFolder(shownIn(target.gameDir, path.join(target.projectDir, ...PACKAGES_FOLDER))));
  };
  if ((await ensureDirBelow(target.projectDir, PACKAGES_FOLDER).catch(refused)) !== parent) refused();
  const temp = `.${name}.${randomUUID()}.tmp`;
  await createFileInDir(parent, temp, text).catch(refused);
  await replaceFile(path.join(parent, temp), path.join(parent, name)).catch(async (failure: unknown) => {
    await rm(path.join(parent, temp), { force: true }).catch(() => {});
    throw failure;
  });
}

/** A package's folders: the packages folder and the plugin's package folder in it, by real path. */
type PackageFolders = { parent: string; dir: string };

/** The package job: BuildPlugin in the build sandbox, then the note beside the package folder, kept even when it failed. */
async function runPackage(deps: ShipToolsDeps, target: EngineTarget, folders: PackageFolders, signal: AbortSignal) {
  const result = await packagePlugin({
    engineDir: target.engine.directory,
    projectDir: target.projectDir,
    pluginFile: target.plugin.descriptor,
    packageDir: folders.dir,
    xcodeApp: target.xcodeApp,
    platform: deps.platform,
    signal,
    ...(deps.runCommand ? { run: deps.runCommand } : {}),
    ...(deps.prepareSandbox ? { prepareSandbox: deps.prepareSandbox } : {}),
  });
  if (signal.aborted) throw new Error(MESSAGE.Stopped);
  return packaged(target, folders, result, deps.platform);
}

/** The package's folders as `windowsPackageJob` and `packageResultOf` name them. */
const windowsPackage = (target: EngineTarget, packageDir: string): WindowsPackage => ({
  engineDir: target.engine.directory,
  projectDir: target.projectDir,
  pluginFile: target.plugin.descriptor,
  packageDir,
});

/** The note beside the package folder, kept even when the package failed, and the package's outcome. */
async function packaged(
  target: EngineTarget,
  folders: PackageFolders,
  result: PackageResult,
  platform: NodeJS.Platform,
) {
  const errors = result.ok ? "" : buildErrors(result);
  const name = `${target.plugin.name}${NOTE_EXTENSION}`;
  const note = await packageNote(target, folders.dir, { summary: result.summary, errors, platform });
  await writeNote(target, folders.parent, name, note);
  const outcome = {
    line: result.summary,
    package: shownIn(target.gameDir, folders.dir),
    note: shownIn(target.gameDir, path.join(folders.parent, name)),
  };
  if (!result.ok) throw new ShipFailure(`${result.summary}${errors}`, outcome);
  return outcome;
}

/**
 * `plugin-package`: stops the running package with `stop`; else starts BuildPlugin unless another job
 * runs. On Windows it needs no Xcode: Genex runs RunUAT.bat in its own sandbox as a host job, and a
 * folder cmd.exe can't carry is refused before the package folder is made or emptied.
 */
async function startPackage(deps: ShipToolsDeps, jobs: Jobs, call: ShipCall) {
  const { storage, context, args } = call;
  const target = await shipTarget(deps, storage, context, args);
  const packaging = jobOf(target, ShipJob.Package);
  if (args.stop === true) return jobs.stop(packaging, context.host);
  stopIfAborted(context.signal);
  const windows = deps.platform === WINDOWS;
  const engine = await engineTarget(deps, target, !windows);
  if (jobs.running(packaging)) return STARTED;
  jobs.refuseBusy(target.project);
  const packageDir = path.join(target.projectDir, ...PACKAGES_FOLDER, target.plugin.name);
  const problem = windows ? windowsPackageProblem(windowsPackage(engine, packageDir)) : undefined;
  if (problem) throw new Error(problem);
  const job = jobs.reserve(packaging);
  const note = `${target.plugin.name}${NOTE_EXTENSION}`;
  const folders = await preparedFolder(job, context.signal, () =>
    freshFolder(target, PACKAGES_FOLDER, target.plugin.name, [note]),
  );
  if (!windows) {
    job.run((signal) => runPackage(deps, engine, folders, signal));
    return STARTED;
  }
  const folder = windowsPackage(engine, folders.dir);
  const started = await context.host(PluginService.SandboxRun, windowsPackageJob(folder)).catch((failure: unknown) => {
    job.release();
    throw failure;
  });
  job.hand(started.id, async (ended) => packaged(engine, folders, await packageResultOf(ended, folder), deps.platform));
  return STARTED;
}

/** Whether a plain file is at `file` (never a link). */
const isPlainFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;

/** Whether what a job left on disk stands as proof: its run finished, or no run is known since a restart. */
const proofOf = (record: ShipRecord | undefined) => record === undefined || record.state === ShipState.Done;

/**
 * `plugin-status`: each job's record; after a backend restart, the test summary and the package note
 * found on disk. `proof` lists the summary, the note and the window's picture that exist.
 */
async function shipStatus(deps: ShipToolsDeps, jobs: Jobs, storage: string, context: PluginContext, args: Args) {
  const target = await shipTarget(deps, storage, context, args);
  const { name } = target.plugin;
  const at = (steps: readonly string[], file: string) => path.join(target.projectDir, ...steps, file);
  const files = [
    at([...TESTS_FOLDER, name], SUMMARY_FILE),
    at(PACKAGES_FOLDER, `${name}${NOTE_EXTENSION}`),
    at(SHOTS_FOLDER, `${name}${SHOT_SUFFIX}`),
  ];
  const kept = await Promise.all(files.map(isPlainFile));
  const shown = files.map((file) => shownIn(target.gameDir, file));
  const [report, note] = shown;
  const test = jobs.record(jobOf(target, ShipJob.Test));
  const packaged = jobs.record(jobOf(target, ShipJob.Package));
  // A summary or note is proof only of a run that finished: none running, failed or stopped.
  const standing = [proofOf(test), proofOf(packaged), true];
  const status: ShipStatus = {
    plugin: name,
    build: jobs.record(jobOf(target, ShipJob.Build)) ?? IDLE,
    test: test ?? (kept[0] ? { ...IDLE, report } : IDLE),
    package: packaged ?? (kept[1] ? { ...IDLE, note } : IDLE),
    proof: shown.filter((_, n) => kept[n] && standing[n]),
  };
  return status;
}

type Handler = (args: Args, context: PluginContext, storage: string) => Promise<unknown>;

/**
 * The four tools over one set of jobs, and whether a project's build runs now (`restarting`, by its
 * .uproject, from before Unreal is quit): Genex itself closes and reopens Unreal meanwhile.
 * `otherRestart` says when Genex restarts a project's Unreal for another job (adding its C++
 * module, reopening it): no plugin build starts then.
 */
export function createShipTools(deps: ShipToolsDeps, otherRestart: RestartBusy = () => false) {
  const jobs = createJobs(deps);
  // Every tool first sees how the jobs Genex runs for the plugin stand: one that ended is recorded then.
  const sighted =
    (handler: Handler): Handler =>
    async (args, context, storage) => {
      await jobs.sight(context.host);
      return handler(args, context, storage);
    };
  const handlers: Record<ShipToolName, Handler> = {
    [ShipToolName.PluginBuild]: sighted((args, context, storage) =>
      startBuild(deps, jobs, { storage, context, args }, otherRestart),
    ),
    [ShipToolName.PluginTest]: sighted((args, context, storage) => startTests(deps, jobs, { storage, context, args })),
    [ShipToolName.PluginPackage]: sighted((args, context, storage) =>
      startPackage(deps, jobs, { storage, context, args }),
    ),
    [ShipToolName.PluginStatus]: sighted((args, context, storage) => shipStatus(deps, jobs, storage, context, args)),
  };
  return { handlers, restarting: jobs.building };
}
