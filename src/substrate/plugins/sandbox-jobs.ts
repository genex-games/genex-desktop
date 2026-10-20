/**
 * A plugin's sandbox jobs (`sandbox.run`, `sandbox.result`, `sandbox.stop`): a long job of an engine
 * plugin (the Unreal plugin's BuildPlugin on Windows) run in the studio's ProcessSandbox, the way
 * every agent and engine process is contained. A plugin's backend is a separate process that cannot
 * hold the sandbox's grant session itself, and a host call lives only as long as the tool call that
 * made it, so the host owns the job: `sandbox.run` checks the request, starts the job and answers its
 * id at once, as `runtime.install` answers an agent once its download starts; `sandbox.result` says
 * how it stands in a later call. A job ends at its deadline (at most
 * {@link PLUGIN_SANDBOX_MAX_TIMEOUT_MS}), by its plugin's `sandbox.stop`, or when the plugin stops,
 * is turned off or removed, or the studio stops (`stopAll`), each time with its process tree.
 *
 * What a job may reach is named by the request and checked by real path: the program inside a read
 * folder (the engine), the read folders (the engine, the project), and the folders it writes, each a
 * real folder strictly inside the bound game (the package folder), with a scratch folder of its own.
 * ProcessSandbox is handed those writes as the run's confinement. On Windows srt-win grants writes for
 * its whole session and refuses a per-command grant, so there the confinement is the request, not a
 * fence, and the engine is read with the sandbox user's own rights (docs/windows-sandbox.md, Residual
 * risks). A `.bat` or `.cmd` program runs through `cmd.exe`: Git Bash would quote a prepared line
 * again, so the line, built and quoted here, reaches cmd.exe in a variable it expands itself.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  PLUGIN_SANDBOX_MAX_TIMEOUT_MS,
  PLUGIN_SANDBOX_MIN_TIMEOUT_MS,
  PLUGIN_SANDBOX_OUTPUT_CHARS,
  type PluginBinding,
  type PluginSandboxJob,
  PluginService,
  SandboxJobState,
} from "../../shared/plugins.ts";
import { commandInterpreter, isCommandScript, quotedScriptLine } from "../command-launch.ts";
import { isBelow, isInside } from "../paths.ts";
import { OutputKept, type RunRequest, type RunResult, shellQuote } from "../spawn.ts";
import { mixedPath } from "../windows-sandbox.ts";

/** The variable a command script's line reaches cmd.exe in. */
export const COMMAND_LINE_ENV = "GENEX_COMMAND_LINE";
/** How many of one plugin's jobs may run at once. */
const MAX_RUNNING_PER_PLUGIN = 2;
/** How many of one plugin's ended jobs are kept for `sandbox.result`. */
const MAX_ENDED_PER_PLUGIN = 8;
/** The most folders a job may name to read, and to write. */
const MAX_FOLDERS = 4;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 4096;
const MAX_ENV = 16;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables the sandbox and cmd.exe own, compared without case. */
const RESERVED_ENV = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);
const RESERVED_ENV_PREFIXES = ["GENEX_", "MSYS", "SRT_"];
/** A network share or a device path (`\\server\share`, `\\?\C:\`, `//server`): never a job's folder. */
const NETWORK_PATH = /^(?:\\\\|\/\/)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\x00-\x1f]/;
const RUN_KEYS = new Set(["program", "args", "reads", "writes", "scratchEnv", "env", "timeoutMs"]);
const ERROR_CODE = /^[A-Z0-9_]+$/;
/** The job's own temp folder inside its scratch folder. */
const SCRATCH_TMP = "tmp";
const UNKNOWN_ERROR = "unknown";

const MESSAGE = {
  NotObject: "A sandbox job is an object: { program, args, reads, writes, timeoutMs }",
  UnknownKey: (key: string) => `A sandbox job has no ${JSON.stringify(key)}`,
  NoGame: "A sandbox job runs for a game: call it from a game",
  Deadline: `A sandbox job's deadline is a whole number of ms from ${PLUGIN_SANDBOX_MIN_TIMEOUT_MS} to ${PLUGIN_SANDBOX_MAX_TIMEOUT_MS}`,
  Folders: (what: string) => `A sandbox job names 1 to ${MAX_FOLDERS} folders it ${what}`,
  NotAFolder: (what: string) => `A folder the job ${what} isn't a real local folder, named by its full path`,
  ReadTooWide: "A folder the job reads is a drive's root or holds the home folder",
  WriteNotInGame: "A folder the job writes isn't a real folder inside the game, outside its hidden folders",
  Program: "The job's program isn't a real file inside a folder it reads",
  Args: `A sandbox job's arguments are at most ${MAX_ARGS} strings of at most ${MAX_ARG_CHARS} characters, on one line`,
  Env: `A sandbox job's variables are at most ${MAX_ENV} names of its own, each with one line of text`,
  Busy: `This plugin already runs ${MAX_RUNNING_PER_PLUGIN} sandbox jobs; wait for one or stop it`,
  NoId: "Name the job by its id",
  Unknown: "Unknown sandbox service",
} as const;

/** A `sandbox.run` request as checked: every folder by its real path. */
type CheckedRun = {
  program: string;
  args: string[];
  reads: string[];
  writes: string[];
  scratchEnv: string[];
  env: Record<string, string>;
  timeoutMs: number;
};

/** One job: its plugin, its record as `sandbox.result` answers it, its stop, and its end. */
type Job = { plugin: string; record: PluginSandboxJob; controller: AbortController; ended: Promise<void> };

/** What the jobs need: ProcessSandbox's `run`, the folder for the jobs' scratch, and the computer. */
export type SandboxJobsDeps = {
  run: (request: RunRequest) => Promise<RunResult>;
  scratch: string;
  platform?: NodeJS.Platform;
  /** Where `cmd.exe` is found (`SystemRoot`). */
  env?: NodeJS.ProcessEnv;
  /** The home folder a read folder may never hold. */
  home?: string;
  now?: () => number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
const isReservedEnv = (name: string) =>
  RESERVED_ENV.has(name.toUpperCase()) || RESERVED_ENV_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix));
const isEnvName = (name: unknown): name is string =>
  typeof name === "string" && ENV_NAME.test(name) && !isReservedEnv(name);

/** Only an error's code (ENOENT, EACCES): its message names a path. */
function errorCode(failure: unknown): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : UNKNOWN_ERROR;
}

/** A folder by its real path: absolute, local, a folder and not a link; else refused naming `what`. */
async function realFolder(dir: unknown, what: string): Promise<string> {
  const refused = () => new Error(MESSAGE.NotAFolder(what));
  if (typeof dir !== "string" || !path.isAbsolute(dir) || NETWORK_PATH.test(dir) || CONTROL.test(dir)) throw refused();
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) throw refused();
  return realpath(dir).catch(() => {
    throw refused();
  });
}

/** The 1 to {@link MAX_FOLDERS} folders `value` names, each by its real path. */
async function folders(value: unknown, what: string): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FOLDERS) throw new Error(MESSAGE.Folders(what));
  return Promise.all(value.map((dir) => realFolder(dir, what)));
}

/** The folders a job reads: never a drive's root, never one holding the home folder. */
async function readFolders(value: unknown, home: string): Promise<string[]> {
  const reads = await folders(value, "reads");
  if (reads.some((dir) => path.parse(dir).root === dir || isInside(dir, home))) throw new Error(MESSAGE.ReadTooWide);
  return reads;
}

/** The folders a job writes: each strictly inside the game's real folder and in none of its hidden folders. */
async function writeFolders(value: unknown, binding: PluginBinding | undefined): Promise<string[]> {
  if (!binding?.directory) throw new Error(MESSAGE.NoGame);
  const writes = await folders(value, "writes");
  const game = await realpath(binding.directory);
  const hidden = (dir: string) =>
    path
      .relative(game, dir)
      .split(path.sep)
      .some((part) => part.startsWith("."));
  if (writes.some((dir) => !isBelow(game, dir) || hidden(dir))) throw new Error(MESSAGE.WriteNotInGame);
  return writes;
}

/** The program: a real file, not a link, inside one of the read folders. */
async function programIn(value: unknown, reads: readonly string[]): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || NETWORK_PATH.test(value) || CONTROL.test(value))
    throw new Error(MESSAGE.Program);
  const info = await lstat(value).catch(() => null);
  const real = info?.isFile() ? await realpath(value).catch(() => null) : null;
  if (real === null || !reads.some((dir) => isBelow(dir, real))) throw new Error(MESSAGE.Program);
  return real;
}

function argumentsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGS || !value.every((arg) => isLine(arg, MAX_ARG_CHARS)))
    throw new Error(MESSAGE.Args);
  return value;
}

function envOf(value: unknown, scratchEnv: unknown): { env: Record<string, string>; scratchEnv: string[] } {
  const names = scratchEnv ?? [];
  const env = value ?? {};
  if (!Array.isArray(names) || !names.every(isEnvName) || !isObject(env)) throw new Error(MESSAGE.Env);
  const entries = Object.entries(env);
  const valid = entries.every(([name, text]) => isEnvName(name) && isLine(text, MAX_ARG_CHARS));
  if (!valid || entries.length + names.length > MAX_ENV) throw new Error(MESSAGE.Env);
  return { env: env as Record<string, string>, scratchEnv: names };
}

function deadline(value: unknown): number {
  const valid =
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PLUGIN_SANDBOX_MIN_TIMEOUT_MS &&
    value <= PLUGIN_SANDBOX_MAX_TIMEOUT_MS;
  if (!valid) throw new Error(MESSAGE.Deadline);
  return value;
}

/** A `sandbox.run` request checked whole, every folder by its real path; refused before anything is made. */
async function checkedRun(args: unknown, binding: PluginBinding | undefined, home: string): Promise<CheckedRun> {
  if (!isObject(args)) throw new Error(MESSAGE.NotObject);
  const unknown = Object.keys(args).find((key) => !RUN_KEYS.has(key));
  if (unknown !== undefined) throw new Error(MESSAGE.UnknownKey(unknown));
  const timeoutMs = deadline(args.timeoutMs);
  const programArgs = argumentsOf(args.args);
  const { env, scratchEnv } = envOf(args.env, args.scratchEnv);
  const writes = await writeFolders(args.writes, binding);
  const reads = await readFolders(args.reads, home);
  const program = await programIn(args.program, reads);
  return { program, args: programArgs, reads, writes, scratchEnv, env, timeoutMs };
}

/** How ProcessSandbox's run ended, as a job's record says it. */
function endedBy(result: RunResult, stopped: boolean): Omit<PluginSandboxJob, "id" | "seconds"> {
  const output = { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
  if (result.timedOut) return { state: SandboxJobState.TimedOut, ...output };
  return { state: stopped ? SandboxJobState.Stopped : SandboxJobState.Exited, ...output };
}

/** The plugins' sandbox jobs on one ProcessSandbox, owned by the host from their start to their end. */
export class PluginSandboxJobs {
  readonly #deps: SandboxJobsDeps;
  readonly #jobs = new Map<string, Job>();
  constructor(deps: SandboxJobsDeps) {
    this.#deps = deps;
  }

  /** One of the three services for `plugin`, on behalf of a call bound to `binding`. */
  call(plugin: string, method: string, args: unknown, binding: PluginBinding | undefined): Promise<unknown> {
    if (method === PluginService.SandboxRun) return this.#run(plugin, args, binding);
    if (method === PluginService.SandboxResult) return Promise.resolve(this.#result(plugin, args));
    if (method === PluginService.SandboxStop) return this.#stop(plugin, args);
    return Promise.reject(new Error(MESSAGE.Unknown));
  }

  /** Ends every running job of `plugin` (it stopped, was turned off or removed), or of every plugin; resolves once they ended. */
  async stopAll(plugin?: string): Promise<void> {
    const ending = [...this.#jobs.values()].filter(
      (job) => (plugin === undefined || job.plugin === plugin) && job.record.state === SandboxJobState.Running,
    );
    for (const job of ending) job.controller.abort();
    await Promise.all(ending.map((job) => job.ended));
  }

  get #platform(): NodeJS.Platform {
    return this.#deps.platform ?? process.platform;
  }

  /** The shell command ProcessSandbox runs, and the variables it needs: a command script through cmd.exe. */
  #command(program: string, args: readonly string[]): { command: string; env: Record<string, string> } {
    const windows = this.#platform === StudioPlatform.Windows;
    if (isCommandScript(program, this.#platform)) {
      const line = quotedScriptLine(program, args);
      const cmd = shellQuote(mixedPath(commandInterpreter(this.#deps.env ?? process.env)));
      return { command: `${cmd} /d /v:off /s /c %${COMMAND_LINE_ENV}%`, env: { [COMMAND_LINE_ENV]: line } };
    }
    const file = windows ? mixedPath(program) : program;
    return { command: [file, ...args].map(shellQuote).join(" "), env: {} };
  }

  async #run(plugin: string, args: unknown, binding: PluginBinding | undefined): Promise<{ id: string }> {
    const checked = await checkedRun(args, binding, this.#deps.home ?? os.homedir());
    const { command, env } = this.#command(checked.program, checked.args);
    if (this.#running(plugin) >= MAX_RUNNING_PER_PLUGIN) throw new Error(MESSAGE.Busy);
    const id = randomUUID();
    const dir = path.join(this.#deps.scratch, id);
    const tmp = path.join(dir, SCRATCH_TMP);
    const scratchVars = Object.fromEntries(checked.scratchEnv.map((name) => [name, path.join(dir, name)]));
    await Promise.all([tmp, ...Object.values(scratchVars)].map((folder) => mkdir(folder, { recursive: true })));
    const controller = new AbortController();
    const request: RunRequest = {
      command,
      cwd: dir,
      env: { ...checked.env, ...scratchVars, ...env },
      timeoutMs: checked.timeoutMs,
      maxOutputBytes: PLUGIN_SANDBOX_OUTPUT_CHARS,
      keepOutput: OutputKept.Tail,
      signal: controller.signal,
      label: `plugin-sandbox:${plugin}`,
      confine: { write: checked.writes, tmp },
      // srt-win refuses a per-command grant: there the engine is read with the sandbox user's own rights.
      ...(this.#platform === StudioPlatform.Windows ? {} : { policy: { allowRead: checked.reads } }),
    };
    const job: Job = { plugin, record: { id, state: SandboxJobState.Running }, controller, ended: Promise.resolve() };
    this.#jobs.set(id, job);
    job.ended = this.#supervise(job, request, dir);
    this.#prune(plugin);
    return { id };
  }

  /** Runs the job to its end, removes its scratch, then records how it ended. */
  async #supervise(job: Job, request: RunRequest, dir: string): Promise<void> {
    const now = this.#deps.now ?? Date.now;
    const started = now();
    let ended: Omit<PluginSandboxJob, "id" | "seconds">;
    try {
      ended = endedBy(await this.#deps.run(request), job.controller.signal.aborted);
    } catch (failure) {
      ended = { state: SandboxJobState.Failed, reason: errorCode(failure) };
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    job.record = { id: job.record.id, ...ended, seconds: Math.round((now() - started) / SECOND_MS) };
  }

  #running(plugin: string): number {
    return [...this.#jobs.values()].filter((j) => j.plugin === plugin && j.record.state === SandboxJobState.Running)
      .length;
  }

  /** Forgets the plugin's oldest ended jobs past {@link MAX_ENDED_PER_PLUGIN}. */
  #prune(plugin: string): void {
    const ended = [...this.#jobs.entries()].filter(
      ([, job]) => job.plugin === plugin && job.record.state !== SandboxJobState.Running,
    );
    for (const [id] of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_PER_PLUGIN))) this.#jobs.delete(id);
  }

  /** The plugin's own job named by `args.id`; another plugin's is as unknown as a missing one. */
  #own(plugin: string, args: unknown): Job | undefined {
    const id = isObject(args) ? args.id : undefined;
    if (typeof id !== "string") throw new Error(MESSAGE.NoId);
    const job = this.#jobs.get(id);
    return job?.plugin === plugin ? job : undefined;
  }

  #result(plugin: string, args: unknown): PluginSandboxJob | null {
    const job = this.#own(plugin, args);
    return job ? { ...job.record } : null;
  }

  async #stop(plugin: string, args: unknown): Promise<{ stopped: boolean }> {
    const job = this.#own(plugin, args);
    if (job?.record.state !== SandboxJobState.Running) return { stopped: false };
    job.controller.abort();
    await job.ended;
    return { stopped: true };
  }
}
