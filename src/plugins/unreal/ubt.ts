/**
 * Compiling a game's C++ with UnrealBuildTool. A builder's part is compiled in the builder's own
 * copy of the game, so the editor queue only ever gets code that compiles: the engine's `Build.sh`
 * builds `<Module>Editor` for the copy's .uproject with `-NoMutex`, since UBT otherwise holds one
 * lock per engine and a second build fails (ConflictingInstance), and `-NoUBA`: the build
 * accelerator opens a network port and resolves paths by listing the folders above the project,
 * which the build's sandbox closes when the copy is in the home folder (the plain executor builds
 * the same project there; `ubt-sandbox.ts`).
 *
 * A full build peaks near 6 GB, so at most {@link MAX_PARALLEL_COMPILES} run at once in this
 * process and the rest wait in order; a compile past its deadline, or stopped by its caller, ends
 * with its whole process tree. Success is UBT's own "Result: Succeeded" (Build.sh exits 0 on some
 * failures). Errors are clang's first line with the file relative to the project, or its base name
 * outside it: no absolute path of the user's machine reaches an agent.
 */
import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { killProcessTree } from "../../substrate/process-tree.ts";
import { isModuleName } from "./cpp-module.ts";
import { isProjectPath } from "./project-file.ts";
import {
  type BuildSandbox,
  type BuildSandboxRequest,
  type PreparedBuildSandbox,
  prepareBuildSandbox,
  SANDBOX_EXEC,
} from "./ubt-sandbox.ts";
import { XcodeState, type XcodeStatus } from "./xcode.ts";

/** How many UBT builds may run at once in this process: a full one peaks near 6 GB. */
export const MAX_PARALLEL_COMPILES = 2;
/** How long one build may take before its process tree is ended; a full first build takes under a minute. */
export const COMPILE_TIMEOUT_MS = 10 * MINUTE_MS;
/** The most errors a result names; the first ones are the ones to fix. */
const MAX_ERRORS = 20;
/** The longest message an error keeps. */
const MAX_MESSAGE_CHARS = 300;
/** How much of a build's output is kept from its start; past it, only the last {@link OUTPUT_TAIL_BYTES}. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OUTPUT_TAIL_BYTES = 256 * 1024;
const ELLIPSIS = "…";
/** The only platform Genex compiles Unreal C++ on (Xcode). */
const MAC = "darwin";
const TARGET_PLATFORM = "Mac";
const CONFIGURATION = "Development";
const EDITOR_SUFFIX = "Editor";
const NO_MUTEX = "-NoMutex";
const NO_ACCELERATOR = "-NoUBA";
/** Where a project keeps its own plugins, each in a folder with its descriptor. */
const PLUGINS_FOLDER = "Plugins";
const DESCRIPTOR_EXTENSION = ".uplugin";

/** Why a compile didn't pass. Only Conflicting is retryable as it is. */
export const CompileFailure = {
  /** Not a Mac: Unreal C++ is compiled with Xcode there only. */
  Unsupported: "unsupported",
  /** A module, project or engine path Genex won't hand UBT; nothing ran. */
  Invalid: "invalid",
  /** UBT ran and the build failed: the errors say why. */
  Failed: "failed",
  /** Another build held UBT's global lock; running again may pass unchanged. */
  Conflicting: "conflicting",
  TimedOut: "timed-out",
  /** The caller stopped it, while it waited or ran. */
  Aborted: "aborted",
  /** Build.sh couldn't be started. */
  NotStarted: "not-started",
} as const;
export type CompileFailure = (typeof CompileFailure)[keyof typeof CompileFailure];

/** One error: the file relative to the project ("" when UBT names none), its line and column (0 when unknown). */
export type CompileError = { file: string; line: number; column: number; message: string };

/** A compile's outcome: whether UBT succeeded, how long it ran, the first errors and one line for people. */
export type CompileResult = {
  ok: boolean;
  seconds: number;
  errors: CompileError[];
  summary: string;
  /** Why it didn't pass; absent when ok. */
  failure?: CompileFailure;
  /** Whether running it again unchanged may pass: another build held UBT's lock. */
  retryable: boolean;
};

/** A program's exit code (null when a signal ended it) and its stdout and stderr together, capped. */
export type RunOutcome = { code: number | null; output: string };
/**
 * Runs a program without a shell to its end, confined by `sandbox` (its profile, its whole
 * environment and its folder); when `signal` aborts it ends the program's whole process tree and
 * resolves. Rejects only when the program can't start. Tests stand in for it.
 */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; sandbox: BuildSandbox },
) => Promise<RunOutcome>;
/** Makes one build's sandbox; `prepareBuildSandbox` unless a test stands in. */
export type PrepareSandbox = (request: BuildSandboxRequest) => Promise<PreparedBuildSandbox>;

/**
 * One compile: the engine's folder, the game copy's .uproject and its module, and the Xcode app
 * the build may read (when it is known); the rest is for tests.
 */
export type CompileOptions = {
  engineDir: string;
  projectFile: string;
  module: string;
  xcodeApp?: string | null;
  signal?: AbortSignal;
  run?: RunCommand;
  prepareSandbox?: PrepareSandbox;
  /** The user's home folder, whose contents the build doesn't read. */
  home?: string;
  platform?: NodeJS.Platform;
  /** The clock, in ms. */
  now?: () => number;
  timeoutMs?: number;
};

const MESSAGE = {
  Built: (target: string, seconds: number) => `${target} built in ${seconds} s.`,
  Failed: (target: string, reason: string, errors: number) =>
    errors === 0
      ? `${target} didn't build (${reason}).`
      : `${target} didn't build (${reason}): ${errors} error${errors === 1 ? "" : "s"}.`,
  NoResult: (code: number | null) => `UnrealBuildTool ended without a result (exit code ${code ?? "none"}).`,
  Conflicting: "Another Unreal build held UnrealBuildTool's lock; compile again.",
  Unsupported: "Unreal C++ is compiled on a Mac with Xcode only; this computer builds Blueprints.",
  BadModule: "Genex won't compile: the module name isn't a C++ identifier.",
  BadProject: "Genex won't compile: the project isn't a full path to a .uproject.",
  BadEngine: "Genex won't compile: the engine folder isn't a full path.",
  TimedOut: (seconds: number) => `The build was stopped after ${seconds} s.`,
  Aborted: "The build was stopped.",
  NotStarted: (code: string) => `UnrealBuildTool couldn't start (${code}).`,
  Foreign:
    "an error in a file outside the game and the engine; a part's C++ includes only the engine's and the game's own headers.",
  UndefinedSymbol: (symbol: string, user: string | undefined) =>
    user === undefined ? `Undefined symbol: ${symbol}` : `Undefined symbol: ${symbol}, referenced from ${user}`,
} as const;

/** clang: `file:line:column: error: message` (also `fatal error`). */
const CLANG_ERROR = /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s+(?:fatal\s+)?error:\s*(?<message>.+)$/;
/** UnrealHeaderTool and C# rules: `file(line): Error: message`, `file(line,column): error CS1002: message`. */
const PAREN_ERROR =
  /^(?<file>.+?)\((?<line>\d+)(?:,\s*(?<column>\d+))?\)\s*:\s*(?:fatal\s+)?error\b\s*:?\s*(?<message>.+)$/i;
/** UBT's own error lines: missing modules, bad rules files. */
const UBT_ERROR = /^(?:FATAL )?ERROR:\s*(?<message>.+)$/;
/** Apple's linker and clang's driver: `ld: …`, `clang++: error: linker command failed …`. */
const TOOL_ERROR = /^(?:clang\+\+|clang|ld|ld64\.lld|ld\.lld):\s+(?:error:\s*)?(?<message>.+)$/;
const WARNING = /^warning:/i;
/** One symbol of Apple ld's "Undefined symbols for architecture …" block. */
const UNDEFINED_SYMBOL = /^"(?<symbol>.+)", referenced from:$/;
/** The line after it: what uses the symbol, in which object file. */
const REFERENCED_BY = /^(?<user>.+ in \S+\.o)$/;
/** UBT's result line, where a failure's explanation ends. */
const RESULT_LINE = /^Result: /;
/** Lines UBT prints just before its result that never say why it failed. */
const RESULT_NOISE =
  /^(?:Total time in |Total execution time|Trace written|Output binary:|Deploying|\[\d+\/\d+\] |\d+ errors? generated\.)/;
/** UBT's progress lines from the start of a build: reaching them, nothing before the result explained it. */
const PREAMBLE =
  /^(?:Setting up bundled|Running dotnet|Log file:|Determining max actions|Executing up to|UbaServer|Invalidating makefile|Creating makefile|Compiling with|Using |Building |CppDependencyCache|UHT |\/.+\/DotNet\/)/;
const SUCCEEDED = /^\s*Result: Succeeded\b/m;
const FAILED = /^\s*Result: Failed \((?<reason>\w+)\)/m;
const CONFLICTING_REASON = "ConflictingInstance";
const CONFLICTING = /A conflicting instance of \S*UnrealBuildTool_Mutex/;
/** An absolute path left in a message once the project and engine folders are taken out: kept as its base name. */
const ABSOLUTE_PATH = /(?<![\w./:])\/(?:[^\s/'"`():,;]+\/)+([^\s/'"`():,;]*)/g;
const ERROR_CODE = /^[A-Z0-9_]+$/;

/** Folders whose paths are taken out of messages: the project's (relative files) and the engine's. */
type Roots = { project: string[]; engine: string[] };

/** Slots shared by every compile in this process; the rest wait in order, and leave when stopped. */
function createSlots(max: number) {
  let busy = 0;
  const waiting: Array<() => void> = [];
  const acquire = (signal: AbortSignal | undefined): Promise<boolean> => {
    if (signal?.aborted) return Promise.resolve(false);
    if (busy < max) {
      busy++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const leave = () => {
        const at = waiting.indexOf(take);
        if (at !== -1) waiting.splice(at, 1);
        resolve(false);
      };
      const take = () => {
        signal?.removeEventListener("abort", leave);
        resolve(true);
      };
      waiting.push(take);
      signal?.addEventListener("abort", leave, { once: true });
    });
  };
  /** Hands the slot to the next in line, or frees it. */
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else busy--;
  };
  return { acquire, release };
}

const slots = createSlots(MAX_PARALLEL_COMPILES);

/** Whether C++ can be compiled here: a Mac whose Xcode is Ready (else the lead plans Blueprint-only). */
export function canCompileCpp(
  xcode: Pick<XcodeStatus, "state">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === MAC && xcode.state === XcodeState.Ready;
}

/** Keeps a program's output from its start, and past the cap only its end, where a build's result is. */
export function outputCollector() {
  const head: Buffer[] = [];
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  const add = (chunk: Buffer) => {
    const room = Math.min(Math.max(0, MAX_OUTPUT_BYTES - headBytes), chunk.length);
    if (room > 0) {
      head.push(chunk.subarray(0, room));
      headBytes += room;
    }
    if (room < chunk.length) tail = Buffer.concat([tail, chunk.subarray(room)]).subarray(-OUTPUT_TAIL_BYTES);
  };
  const text = () => {
    const end = tail.length > 0 ? [Buffer.from("\n"), tail] : [];
    return Buffer.concat([...head, ...end]).toString("utf8");
  };
  return { add, text };
}

/**
 * The product's runner: the program under `sandbox-exec` with the sandbox's profile, environment
 * and folder, in a process group of its own (so ending it reaches dotnet and every compiler it
 * started), stdout and stderr collected together within the cap.
 */
export const systemRunCommand: RunCommand = (file, args, { signal, sandbox }) =>
  new Promise((resolve, reject) => {
    const child = spawn(SANDBOX_EXEC, ["-f", sandbox.profile, file, ...args], {
      cwd: sandbox.cwd,
      env: sandbox.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = outputCollector();
    child.stdout?.on("data", output.add);
    child.stderr?.on("data", output.add);
    const stop = () => void killProcessTree(child.pid);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      resolve({ code, output: output.text() });
    });
  });

const failed = (failure: CompileFailure, summary: string, seconds = 0): CompileResult => ({
  ok: false,
  seconds,
  errors: [],
  summary,
  failure,
  retryable: failure === CompileFailure.Conflicting,
});

function invalidInput(options: CompileOptions): string | undefined {
  if (!isModuleName(options.module)) return MESSAGE.BadModule;
  if (!isProjectPath(options.projectFile)) return MESSAGE.BadProject;
  if (!path.isAbsolute(options.engineDir)) return MESSAGE.BadEngine;
  return undefined;
}

/** The folder and its real path, when they differ (macOS temp folders live behind /var → /private/var). */
async function spellings(folder: string): Promise<string[]> {
  const real = await realpath(folder).catch(() => folder);
  return [...new Set([folder, real])].map((f) => f.replace(/\/+$/, ""));
}

async function rootsOf(options: CompileOptions): Promise<Roots> {
  const [project, engine] = await Promise.all([
    spellings(path.dirname(options.projectFile)),
    spellings(options.engineDir),
  ]);
  return { project, engine };
}

/**
 * A file as an agent may read it: relative to the project inside it, else its base name; and
 * whether it is foreign (in neither the project nor the engine).
 */
function fileFor(file: string, roots: Roots): { file: string; foreign: boolean } {
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(roots.engine[0] ?? "/", file);
  const root = roots.project.find((r) => absolute.startsWith(`${r}/`));
  if (root) return { file: absolute.slice(root.length + 1), foreign: false };
  const engine = roots.engine.some((r) => absolute.startsWith(`${r}/`));
  return { file: path.basename(absolute), foreign: !engine };
}

/** A message with the project's and engine's folders taken out and any other absolute path cut to its base name. */
function scrubbed(message: string, roots: Roots): string {
  let text = message.trim();
  for (const root of [...roots.project, ...roots.engine].sort((a, b) => b.length - a.length))
    text = text.split(`${root}/`).join("");
  text = text.replace(ABSOLUTE_PATH, (_match, base: string) => base);
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - ELLIPSIS.length)}${ELLIPSIS}` : text;
}

/**
 * Scrubs text an agent will read of the computer's paths: the project's folder taken out (its files
 * read relative to it), the engine's too, and any other absolute path cut to its base name.
 */
export async function pathScrubber(projectDir: string, engineDir: string): Promise<(text: string) => string> {
  const [project, engine] = await Promise.all([spellings(projectDir), spellings(engineDir)]);
  return (text) => scrubbed(text, { project, engine });
}

/**
 * An error that names its file: clang's, UnrealHeaderTool's or a C# rules file's. One in a foreign
 * file says only where it is: its text could be that file's, which the agent may not read.
 */
function fileError(text: string, roots: Roots): CompileError | undefined {
  const match = CLANG_ERROR.exec(text) ?? PAREN_ERROR.exec(text);
  const groups = match?.groups;
  if (!groups) return undefined;
  const { file, foreign } = fileFor(groups.file ?? "", roots);
  return {
    file,
    line: Number(groups.line ?? 0),
    column: Number(groups.column ?? 0),
    message: foreign ? MESSAGE.Foreign : scrubbed(groups.message ?? "", roots),
  };
}

const unplaced = (message: string, roots: Roots): CompileError => ({
  file: "",
  line: 0,
  column: 0,
  message: scrubbed(message, roots),
});

/** The error one line of UBT's output reports, if any; `next` is the line after it. */
function lineError(line: string, next: string, roots: Roots): CompileError | undefined {
  const text = line.trim();
  const ubt = UBT_ERROR.exec(text)?.groups?.message;
  if (ubt !== undefined) return fileError(ubt, roots) ?? unplaced(ubt, roots);
  const placed = fileError(text, roots);
  if (placed) return placed;
  const symbol = UNDEFINED_SYMBOL.exec(text)?.groups?.symbol;
  if (symbol !== undefined) {
    const user = REFERENCED_BY.exec(next.trim())?.groups?.user;
    return unplaced(MESSAGE.UndefinedSymbol(symbol, user), roots);
  }
  const tool = TOOL_ERROR.exec(text)?.groups?.message;
  return tool !== undefined && !WARNING.test(tool) ? unplaced(tool, roots) : undefined;
}

/**
 * The first errors of an Unreal build's output (UBT's, clang's, the linker's, UAT's `ERROR:` lines),
 * each file relative to the project and every other absolute path cut to its base name.
 */
export async function parseBuildErrors(
  output: string,
  folders: { projectDir: string; engineDir: string },
): Promise<CompileError[]> {
  const [project, engine] = await Promise.all([spellings(folders.projectDir), spellings(folders.engineDir)]);
  return ubtErrors(output, { project, engine });
}

/** The first {@link MAX_ERRORS} distinct errors in UBT's output, in order. */
function ubtErrors(output: string, roots: Roots): CompileError[] {
  const errors: CompileError[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);
  for (const [at, line] of lines.entries()) {
    const error = lineError(line, lines[at + 1] ?? "", roots);
    const key = error && `${error.file}:${error.line}:${error.column}:${error.message}`;
    if (!error || key === undefined || seen.has(key)) continue;
    seen.add(key);
    errors.push(error);
    if (errors.length === MAX_ERRORS) break;
  }
  return errors;
}

/**
 * The line that explains a failure UBT printed without a marker ("Could not find definition for
 * module …"): the last one before its result that isn't UBT's own bookkeeping, if any.
 */
function lastWords(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const result = lines.findLastIndex((line) => RESULT_LINE.test(line));
  for (let at = result - 1; at >= 0; at--) {
    const line = lines[at] ?? "";
    if (line === "" || RESULT_NOISE.test(line)) continue;
    return PREAMBLE.test(line) ? undefined : line;
  }
  return undefined;
}

/** What UBT's output says: succeeded, another build's lock, or failed with its errors. */
function resultOf(outcome: RunOutcome, roots: Roots, target: string, seconds: number): CompileResult {
  const { output } = outcome;
  const reason = FAILED.exec(output)?.groups?.reason;
  if (reason === CONFLICTING_REASON || CONFLICTING.test(output))
    return failed(CompileFailure.Conflicting, MESSAGE.Conflicting, seconds);
  if (SUCCEEDED.test(output))
    return { ok: true, seconds, errors: [], summary: MESSAGE.Built(target, seconds), retryable: false };
  const parsed = ubtErrors(output, roots);
  const words = parsed.length === 0 && reason ? lastWords(output) : undefined;
  const errors = words === undefined ? parsed : [unplaced(words, roots)];
  const summary = reason ? MESSAGE.Failed(target, reason, errors.length) : MESSAGE.NoResult(outcome.code);
  return { ...failed(CompileFailure.Failed, summary, seconds), errors };
}

const secondsOf = (ms: number) => Math.round(ms / (SECOND_MS / 10)) / 10;

/** Only an error's code (ENOENT, EACCES): its message names Build.sh's absolute path. */
function errorCode(failure: unknown): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

/**
 * The project's own plugins a build of it compiles: the plain folders under its `Plugins/` that hold
 * a .uplugin, sorted; a link there, or anything else, is none. Empty for a project with no plugins.
 */
export async function projectPluginDirs(projectFile: string): Promise<string[]> {
  const plugins = path.join(path.dirname(projectFile), PLUGINS_FOLDER);
  const dirs: string[] = [];
  for (const entry of await readdir(plugins, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(plugins, entry.name);
    const inside = await readdir(folder, { withFileTypes: true }).catch(() => []);
    if (inside.some((file) => file.isFile() && file.name.endsWith(DESCRIPTOR_EXTENSION))) dirs.push(folder);
  }
  return dirs.sort();
}

/** Runs Build.sh once in its sandbox, which is gone afterwards; rejects when either can't start. */
async function runConfined(options: CompileOptions, args: string[], signal: AbortSignal): Promise<RunOutcome> {
  const script = path.join(options.engineDir, "Engine", "Build", "BatchFiles", "Mac", "Build.sh");
  // A host project's build compiles its plugins too, and writes their build output.
  const pluginDirs = await projectPluginDirs(options.projectFile);
  const sandbox = await (options.prepareSandbox ?? prepareBuildSandbox)({
    projectDir: path.dirname(options.projectFile),
    engineDir: options.engineDir,
    xcodeApp: options.xcodeApp ?? null,
    ...(options.home ? { home: options.home } : {}),
    ...(pluginDirs.length > 0 ? { pluginDirs } : {}),
  });
  try {
    return await (options.run ?? systemRunCommand)(script, args, { signal, sandbox });
  } finally {
    await sandbox.dispose();
  }
}

/** Runs Build.sh once, within the deadline, and reads its output. */
async function build(options: CompileOptions): Promise<CompileResult> {
  const now = options.now ?? Date.now;
  const target = `${options.module}${EDITOR_SUFFIX}`;
  const args = [target, TARGET_PLATFORM, CONFIGURATION, `-Project=${options.projectFile}`, NO_MUTEX, NO_ACCELERATOR];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? COMPILE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const started = now();
  let outcome: RunOutcome;
  try {
    outcome = await runConfined(options, args, signal);
  } catch (failure) {
    return failed(CompileFailure.NotStarted, MESSAGE.NotStarted(errorCode(failure)));
  } finally {
    clearTimeout(timer);
  }
  const seconds = secondsOf(now() - started);
  // A stop that came after UBT already succeeded doesn't undo the build.
  if (SUCCEEDED.test(outcome.output)) return resultOf(outcome, await rootsOf(options), target, seconds);
  if (options.signal?.aborted) return failed(CompileFailure.Aborted, MESSAGE.Aborted, seconds);
  if (deadline.signal.aborted) return failed(CompileFailure.TimedOut, MESSAGE.TimedOut(seconds), seconds);
  return resultOf(outcome, await rootsOf(options), target, seconds);
}

/**
 * Compiles the game's editor target (`<Module>Editor Mac Development -Project=… -NoMutex -NoUBA`) with
 * the engine's Build.sh, waiting for a free slot first. Never throws: off a Mac, for input it
 * won't hand UBT, when stopped, past the deadline or when Build.sh can't start, the result says so.
 */
export async function compileEditor(options: CompileOptions): Promise<CompileResult> {
  if ((options.platform ?? process.platform) !== MAC) return failed(CompileFailure.Unsupported, MESSAGE.Unsupported);
  const invalid = invalidInput(options);
  if (invalid) return failed(CompileFailure.Invalid, invalid);
  if (!(await slots.acquire(options.signal))) return failed(CompileFailure.Aborted, MESSAGE.Aborted);
  try {
    // Stopped as the slot was handed over: nothing is started, and the slot passes on.
    if (options.signal?.aborted) return failed(CompileFailure.Aborted, MESSAGE.Aborted);
    return await build(options);
  } finally {
    slots.release();
  }
}
