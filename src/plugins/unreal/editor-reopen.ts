/**
 * Reopening Unreal after it crashed, for the Unreal Loop (a C++ crash can leave the crash reporter
 * open, and a hot reload can point the project's `UnrealEditor.modules` at a library the restored
 * Source no longer matches). `reopen-editor` starts a background job, one per project: it ends what
 * is left of this project's editor and its crash reporter, builds the game's C++ module with
 * UnrealBuildTool when it has one, opens the project (the panel's Open, which waits for a free
 * port) and waits until it answers. `editor-state` says whether the game's Unreal answers, whether
 * this project's editor process runs (an editor busy on its game thread answers nothing for a
 * while, yet hasn't crashed), how reopening goes and where the project's Genex editor helper stands
 * against the plugin's. `end-editor` ends this project's editor and its crash reporter the same way
 * and nothing more, for the Loop's cold restores and planned restarts: the Loop never hot-reloads,
 * and `reopen-editor` does nothing while the editor answers. `end-editor` answers only once the
 * game's Unreal no longer answers, asked again until it says so: the setup remembers a good answer
 * for a few seconds, and a `reopen-editor` or `update-helper` right after must never take that for
 * an open editor.
 *
 * Only this project's own processes are ended: an UnrealEditor whose arguments name its
 * `.uproject`, and Unreal's crash reporter whose arguments name one of its crash folders: a folder
 * directly in the engine's or the project's crash folder, named for the project, not a link, whose
 * copy of the editor's log names this project. Unreal's normal quit goes first, and only while the
 * one editor running is this project's (it reaches whichever editor runs); then a terminate, then a
 * kill. Processes are listed on a Mac only; elsewhere none is ended.
 */
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { projectModule } from "./cpp-module.ts";
import { logOfProject } from "./editor-log.ts";
import { pollUntil } from "./editor-queue.ts";
import {
  answering,
  buildErrors,
  type JobRecord,
  OPEN_WAIT_MS,
  openAndWait,
  RESTART_POLL_MS,
  type RestartDeps,
  type RestartTarget,
  runJob,
} from "./editor-restart.ts";
import { HelperState, inspectProject, type SetupOptions, updateHelper } from "./setup.ts";
import { type CompileOptions, type CompileResult, canCompileCpp, compileEditor } from "./ubt.ts";
import type { XcodeStatus } from "./xcode.ts";

/** Where reopening a game's Unreal stands: wire values the Loop's runner reads (its `ReopenState`). */
export const ReopenState = { Idle: "idle", Reopening: "reopening", Done: "done", Failed: "failed" } as const;
export type ReopenState = (typeof ReopenState)[keyof typeof ReopenState];

/** How reopening goes: its state, why it failed, and how long it took once done. */
export type Reopening = JobRecord<ReopenState>;
/**
 * `editor-state`'s answer: whether the game's Unreal answers, whether its editor process runs (null
 * when that can't be told), how reopening it goes, and where the project's Genex editor helper
 * stands against the plugin's (null without a linked project).
 */
export type EditorStateAnswer = {
  answering: boolean;
  running: boolean | null;
  reopening: Reopening;
  helper: HelperState | null;
};
/** `end-editor`'s answer: how many of this project's editor and crash-reporter processes it ended. */
export type EndAnswer = { ended: number };
/** `reopen-editor`'s answer: started in the background, or Unreal already answers. */
export type ReopenAnswer = { started: true } | { answering: true };

/** One process: its id, its executable's path, and its arguments with the executable first. */
export type ProcessRow = { pid: number; exec: string; args: string };
/** This computer's processes as the job lists and ends them, and the user's home, where Unreal keeps crash reports. */
export type ProcessEnv = {
  home: string;
  list(): Promise<ProcessRow[]>;
  /** Sends `signal` to `pid`; throws when the process is gone. */
  signal(pid: number, signal: NodeJS.Signals): void;
};

/** What reopening needs from the computer, the editor and the clock. */
export type ReopenDeps = RestartDeps & {
  platform: NodeJS.Platform;
  engine(): Promise<{ version: string; directory: string } | undefined>;
  project(storage: string, game: string): Promise<string | undefined>;
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state"> & Partial<Pick<XcodeStatus, "app">>>;
  /** Builds the project's editor target; UnrealBuildTool's own unless a test stands in. */
  compile?(options: CompileOptions): Promise<CompileResult>;
  /** This computer's processes; without them, nothing is ended. */
  processes?: ProcessEnv;
  /** What setup reads for a project in the plugin's `storage`: the computer and the shipped helper. */
  setup(storage: string): SetupOptions;
  /** Updates a project's Genex editor helper; `updateHelper` unless a test stands in. */
  updateHelper?: typeof updateHelper;
};

/** How long the job waits for this project's processes to end after the quit, and after each signal. */
const QUIT_WAIT_MS = 20 * SECOND_MS;
const SIGNAL_WAIT_MS = 10 * SECOND_MS;
/**
 * How long `end-editor` waits for the game's Unreal to stop answering once its processes ended:
 * longer than the setup remembers a good answer (editor-port.ts `rememberAnswers`).
 */
const SILENT_WAIT_MS = 15 * SECOND_MS;
/** A terminate first, a kill for what outlives it. */
const END_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGKILL"];
const EDITOR_PROGRAM = "UnrealEditor";
const REPORTER_PROGRAM = /^CrashReportClient(?:Editor)?$/;
/** A crash folder is `CrashReport-UE-<Project>-pid-<editor's id>-<crash's GUID>`. */
const CRASH_FOLDER_PREFIX = "CrashReport-UE-";
const CRASH_FOLDER_REST = /^-pid-\d{1,10}-[0-9A-Fa-f]{8,64}$/;
/** A crash folder's name and its optional `/` as an argument ends: at the end, a space or a quote. */
const FOLDER_ARGUMENT = /^([^\s"/]*)\/?(?=$|[\s"])/;
const BEFORE_ARGUMENT = /[\s"]/;
const MAC = "darwin";
const PS = "/bin/ps";
const PS_TIMEOUT_MS = 10 * SECOND_MS;
const PS_MAX_BYTES = 16 * 1024 * 1024;
const PS_LINE = /^\s*(\d+) (.*)$/;
const IDLE: Reopening = { state: ReopenState.Idle };
const REOPEN_STATES = { running: ReopenState.Reopening, done: ReopenState.Done, failed: ReopenState.Failed } as const;

const MESSAGE = {
  NoProject: "This game isn't linked to an Unreal project, so there is no Unreal to reopen.",
  NoEngine: "No supported Unreal is installed, so Genex can't build the game's C++ module and didn't reopen Unreal.",
  CannotCompile: (xcode: string) =>
    `This Mac can't build the game's C++ module (Xcode: ${xcode}), so Genex didn't reopen Unreal on modules that may not match the game's code.`,
  NotEnded:
    "Unreal's crashed editor or its crash reporter for this game didn't end, so Genex didn't reopen it. Quit them, then open the game from the Unreal button.",
  EditorNotEnded: "This game's Unreal editor or its crash reporter didn't end. Quit them, then try again.",
  StillAnswers:
    "This game's Unreal still answers after Genex ended what it found of it, so it didn't end. Quit Unreal, then try again.",
  NoProjectToEnd: "This game isn't linked to an Unreal project, so there is no Unreal to end.",
  Reopening: "Genex is reopening this game's Unreal; read editor-state until it is done.",
  NotBuilt: (why: string) => `The game's C++ module didn't build, so Genex didn't reopen Unreal: ${why}`,
  NotAnswering: `Genex reopened the game's project, but Unreal didn't answer within ${OPEN_WAIT_MS / MINUTE_MS} minutes. Open the game from the Unreal button.`,
} as const;

/** The project's name, as Unreal names its log and its crash folders. */
const projectName = (project: string) => path.parse(project).name;

/** The folders Unreal writes this project's crash reports in: the installed engine's, and the project's own. */
function crashFolders(home: string, version: string | undefined, project: string): string[] {
  const own = path.join(path.dirname(project), "Saved", "Crashes");
  if (version === undefined) return [own];
  const engine = path.join(home, "Library", "Application Support", "Epic", "UnrealEngine", version, "Saved", "Crashes");
  return [engine, own];
}

/** A process's arguments after its executable, each after a space. */
const argumentsOf = (row: ProcessRow) =>
  row.args.startsWith(row.exec) ? row.args.slice(row.exec.length) : ` ${row.args}`;

/** Whether a process is an Unreal editor whose arguments name `project` as a whole argument. */
const isOwnEditor = (row: ProcessRow, project: string) =>
  path.basename(row.exec) === EDITOR_PROGRAM && ` ${argumentsOf(row)} `.includes(` ${project} `);

/** The crash folders of `name` inside `folder` that `args` names as whole arguments. */
function namedCrashFolders(args: string, folder: string, name: string): string[] {
  const stem = `${path.join(folder, CRASH_FOLDER_PREFIX)}${name}`;
  const found: string[] = [];
  for (let at = args.indexOf(stem); at >= 0; at = args.indexOf(stem, at + 1)) {
    const rest = FOLDER_ARGUMENT.exec(args.slice(at + stem.length))?.[1];
    const whole = at === 0 || BEFORE_ARGUMENT.test(args.charAt(at - 1));
    if (whole && rest !== undefined && CRASH_FOLDER_REST.test(rest)) found.push(`${stem}${rest}`);
  }
  return found;
}

/** Whether a crash folder is this project's: a real folder, not a link, whose copy of the editor's log names it. */
async function isOwnCrashFolder(folder: string, project: string): Promise<boolean> {
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory()) return false;
  return logOfProject(path.join(folder, `${projectName(project)}.log`), project);
}

/** Whether a process is Unreal's crash reporter for one of this project's crash folders. */
async function isOwnReporter(row: ProcessRow, project: string, folders: readonly string[]): Promise<boolean> {
  if (!REPORTER_PROGRAM.test(path.basename(row.exec))) return false;
  const named = folders.flatMap((folder) => namedCrashFolders(argumentsOf(row), folder, projectName(project)));
  for (const folder of named) if (await isOwnCrashFolder(folder, project)) return true;
  return false;
}

/** A process of this project's: an editor, or a crash reporter. */
type OwnProcess = ProcessRow & { editor: boolean };

/** This project's editors and crash reporters among the computer's processes. */
async function ownProcesses(env: ProcessEnv, project: string, folders: readonly string[]): Promise<OwnProcess[]> {
  const own: OwnProcess[] = [];
  for (const row of await env.list()) {
    if (isOwnEditor(row, project)) own.push({ ...row, editor: true });
    else if (await isOwnReporter(row, project, folders)) own.push({ ...row, editor: false });
  }
  return own;
}

/** Signals a process; one already gone, or an id that is no process's own, is left alone. */
function send(env: ProcessEnv, pid: number, signal: NodeJS.Signals) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    env.signal(pid, signal);
  } catch {
    // It ended on its own.
  }
}

/**
 * One reopen job's game, the engine whose crash folder may hold its reports, and whether it brings an
 * outdated Genex editor helper up to the plugin's while Unreal is closed.
 */
type ReopenTarget = RestartTarget & { engine: { version: string; directory: string } | undefined; helper?: boolean };

/**
 * Ends what is left of this project's editor and crash reporter: the normal quit while the one
 * editor running is this project's, then a terminate and a kill for what outlives each wait. Only
 * the processes found at the start are waited on and signalled; answers how many there were, and
 * throws `notEnded` when one outlives the kill.
 */
async function endOwn(deps: ReopenDeps, target: ReopenTarget, notEnded: string): Promise<number> {
  const env = deps.processes;
  if (!env) return 0;
  const folders = crashFolders(env.home, target.engine?.version, target.project);
  const own = await ownProcesses(env, target.project, folders);
  if (own.length === 0) return 0;
  const left = async () => {
    const rows = await env.list();
    return own.filter((o) => rows.some((row) => row.pid === o.pid && row.args === o.args));
  };
  const gone = (waitMs: number) => pollUntil(deps, async () => (await left()).length === 0, RESTART_POLL_MS, waitMs);
  const onlyEditor = own.some((o) => o.editor) && (await deps.restart.editors()) === 1;
  if (onlyEditor) {
    await deps.restart.quit(target.storage, target.project).catch(() => undefined);
    if (await gone(QUIT_WAIT_MS)) return own.length;
  }
  for (const signal of END_SIGNALS) {
    for (const o of await left()) send(env, o.pid, signal);
    if (await gone(SIGNAL_WAIT_MS)) return own.length;
  }
  throw new Error(notEnded);
}

/**
 * Builds the game's C++ module with Unreal closed, so the project's module list and library match
 * its Source again; a Blueprint project has nothing to build, and off a Mac Unreal builds it itself.
 */
async function buildModule(deps: ReopenDeps, target: ReopenTarget): Promise<void> {
  const module = await projectModule(target.project);
  if (!module || deps.platform !== MAC) return;
  const { engine } = target;
  if (!engine) throw new Error(MESSAGE.NoEngine);
  const xcode = await deps.xcode(engine.directory);
  if (!canCompileCpp(xcode, deps.platform)) throw new Error(MESSAGE.CannotCompile(xcode.state));
  const compile = deps.compile ?? compileEditor;
  const options = { engineDir: engine.directory, projectFile: target.project, module, xcodeApp: xcode.app ?? null };
  const result = await compile(options);
  if (!result.ok) throw new Error(MESSAGE.NotBuilt(`${result.summary}${buildErrors(result)}`));
}

/**
 * The reopen job: end what is left, build the module, open the project and wait until it answers.
 * The crashed editor never answered again, so Genex's record that it was opening it goes first.
 */
async function reopenNow(deps: ReopenDeps, target: ReopenTarget): Promise<void> {
  await endOwn(deps, target, MESSAGE.NotEnded);
  if (target.helper) await updateOutdated(deps, target);
  await buildModule(deps, target);
  await deps.restart.forget?.(target.storage, target.project);
  await openAndWait(deps, target, MESSAGE.NotAnswering);
}

/**
 * The project's Genex editor helper brought up to the plugin's while Unreal is closed, when it is
 * older; an update that fails leaves the helper as it was, and Unreal opens with it.
 */
async function updateOutdated(deps: ReopenDeps, target: ReopenTarget): Promise<void> {
  if ((await helperOf(deps, target.project, target.storage)) !== HelperState.Outdated) return;
  await (deps.updateHelper ?? updateHelper)(target.project, deps.setup(target.storage)).catch(() => undefined);
}

/** Where reopening stands for each project, by its .uproject. */
type Jobs = Map<string, Reopening>;

/**
 * Starts reopening the game's Unreal unless it already answers or a job already reopens it; with
 * `helper`, an outdated Genex editor helper is updated while Unreal is closed.
 */
async function startReopen(
  deps: ReopenDeps,
  jobs: Jobs,
  ask: { storage: string; game: string; helper: boolean },
): Promise<ReopenAnswer> {
  const { storage, game, helper } = ask;
  const project = await deps.project(storage, game);
  if (!project) throw new Error(MESSAGE.NoProject);
  if (jobs.get(project)?.state === ReopenState.Reopening) return { started: true };
  if (await answering(deps, { storage, game }).catch(() => false)) return { answering: true };
  // Another call may have started the job while this one asked.
  if (jobs.get(project)?.state === ReopenState.Reopening) return { started: true };
  const engine = await deps.engine();
  runJob(jobs, project, REOPEN_STATES, deps.now, () => reopenNow(deps, { storage, game, project, engine, helper }));
  return { started: true };
}

/** Where a project's Genex editor helper stands against the plugin's; null when the project can't be read. */
const helperOf = (deps: ReopenDeps, project: string, storage: string) =>
  inspectProject(project, deps.setup(storage)).then(
    (state) => state.helper,
    () => null,
  );

/**
 * Whether this project's editor process runs: on a Mac, by its processes (a listing with none at all
 * failed, and can't say); elsewhere, not when no Unreal editor runs at all, and can't say otherwise.
 */
async function ownEditorRuns(deps: ReopenDeps, project: string): Promise<boolean | null> {
  const env = deps.processes;
  if (env && deps.platform === MAC) {
    const rows = await env.list().catch(() => []);
    return rows.length === 0 ? null : rows.some((row) => isOwnEditor(row, project));
  }
  const editors = await deps.restart.editors().catch(() => null);
  return editors === 0 ? false : null;
}

/** `editor-state` for a game: whether its Unreal answers and its editor runs, its reopen job, and its project's helper. */
async function editorState(deps: ReopenDeps, jobs: Jobs, storage: string, game: string): Promise<EditorStateAnswer> {
  const project = await deps.project(storage, game).catch(() => undefined);
  const reopening = (project ? jobs.get(project) : undefined) ?? IDLE;
  const answers = project ? await answering(deps, { storage, game }).catch(() => false) : false;
  const running = project ? await ownEditorRuns(deps, project) : null;
  const helper = project ? await helperOf(deps, project, storage) : null;
  return { answering: answers, running, reopening: { ...reopening }, helper };
}

/** Waits until the game's Unreal no longer answers, asking it again each time; whether it stopped in time. */
async function silent(deps: ReopenDeps, storage: string, game: string): Promise<boolean> {
  const quiet = async () => !(await answering(deps, { storage, game }).catch(() => false));
  return pollUntil(deps, quiet, RESTART_POLL_MS, SILENT_WAIT_MS);
}

/**
 * Ends this game's editor and its crash reporter, never saving (the caller saves first) and never
 * while a reopen job runs for it; answers how many processes it ended once the game's Unreal no
 * longer answers, and throws when it still does (an editor it couldn't find or end).
 */
async function endEditor(deps: ReopenDeps, jobs: Jobs, storage: string, game: string): Promise<EndAnswer> {
  const project = await deps.project(storage, game);
  if (!project) throw new Error(MESSAGE.NoProjectToEnd);
  if (jobs.get(project)?.state === ReopenState.Reopening) throw new Error(MESSAGE.Reopening);
  const engine = await deps.engine();
  const ended = await endOwn(deps, { storage, game, project, engine }, MESSAGE.EditorNotEnded);
  if (!(await silent(deps, storage, game))) throw new Error(MESSAGE.StillAnswers);
  return { ended };
}

/**
 * The runner's `reopen-editor`, `editor-state` and `end-editor` over one set of reopen jobs, and
 * whether the game's editor process runs (null: can't tell, or no linked project).
 */
export function createReopenTools(deps: ReopenDeps) {
  const jobs: Jobs = new Map();
  return {
    reopen: (storage: string, game: string, helper = false) => startReopen(deps, jobs, { storage, game, helper }),
    state: (storage: string, game: string) => editorState(deps, jobs, storage, game),
    end: (storage: string, game: string) => endEditor(deps, jobs, storage, game),
    running: async (storage: string, game: string) => {
      const project = await deps.project(storage, game).catch(() => undefined);
      return project ? ownEditorRuns(deps, project) : null;
    },
  };
}

const run = promisify(execFile);

/** One `ps` column for every process, by process id. */
async function psColumn(column: string): Promise<Map<number, string>> {
  const options = { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES };
  const { stdout } = await run(PS, ["-axww", "-o", `pid=,${column}=`], options).catch(() => ({ stdout: "" }));
  const rows = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match?.[1] && match[2] !== undefined) rows.set(Number(match[1]), match[2]);
  }
  return rows;
}

/** This Mac's processes, by `ps`: each one's executable path (`comm`) and its arguments (`args`). */
async function macProcesses(): Promise<ProcessRow[]> {
  const [execs, args] = await Promise.all([psColumn("comm"), psColumn("args")]);
  return [...execs].flatMap(([pid, exec]) => {
    const line = args.get(pid);
    return line === undefined ? [] : [{ pid, exec, args: line }];
  });
}

/** This computer's processes for the reopen job: listed on a Mac, none elsewhere; signals by `process.kill`. */
export function systemProcesses(home: string, platform: NodeJS.Platform = process.platform): ProcessEnv {
  return {
    home,
    list: async () => (platform === MAC ? macProcesses() : []),
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
  };
}
