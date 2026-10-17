/**
 * An Unreal plugin's automation tests, run headless: the engine's `UnrealEditor-Cmd` opens the host
 * project with no window, no sound and no GPU, runs the tests whose names start with a filter
 * (`Automation RunTests <filter>`) and quits once the queue is empty, writing Epic's report
 * (`index.json`) to a folder Genex names. The report is read within its cap; without one, the lines
 * Automation printed (`Test Completed. Result={…} Name={…} Path={…}`) are. The program runs without a
 * shell in a process group of its own with a small environment, its output capped, and its whole
 * tree ends when it is stopped or runs past its deadline. Like `open-editor`, it runs outside
 * ProcessSandbox: it loads the project and plugin binaries the person's own editor loads after every
 * plugin build, and the editor needs what UnrealBuildTool's profile denies (docs/plugins.md).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { killProcessTree } from "../../substrate/process-tree.ts";
import { outputCollector } from "./ubt.ts";

/** How long a test run may take before its process tree is ended. */
export const TEST_TIMEOUT_MS = 30 * MINUTE_MS;
/** A test filter: the start of the tests' dotted names, nothing a command line could read as more. */
export const TEST_FILTER = /^[A-Za-z0-9_.]{1,80}$/;
/** Epic's report file in the report folder. */
/** The report Automation writes in the report folder once its queue ends: a run that crashed has none. */
export const AUTOMATION_REPORT = "index.json";
const REPORT_FILE = AUTOMATION_REPORT;
const REPORT_MAX_BYTES = 8 * 1024 * 1024;
/** The most failing tests a result names, and the most messages each keeps. */
const MAX_FAILURES = 20;
const MAX_MESSAGES = 3;
const MESSAGE_CHARS = 300;
const NAME_CHARS = 200;
const ELLIPSIS = "…";
const BOM = "﻿";
/** The variables of Genex's environment a test run keeps; nothing else of it reaches the editor. */
const KEPT_ENV = ["HOME", "PATH", "LANG", "TMPDIR", "USER"] as const;
/** Automation's line for each finished test. */
const COMPLETED =
  /Test Completed\. Result=\{(?<result>[^}]*)\}\s+Name=\{(?<name>[^}]*)\}(?:\s+Path=\{(?<path>[^}]*)\})?/g;
/** Report states and printed results that count as a pass or a failure; any other is not run. */
const PASSED = new Set(["Success", "Succeeded", "SucceededWithWarnings", "Passed"]);
const FAILED = new Set(["Fail", "Failed"]);
const ERROR_EVENT = "Error";

const MESSAGE = {
  BadFilter: "A test filter is the start of the tests' names: letters, digits, _ and dots, at most 80.",
} as const;

/** One failing test: its full name and its first error messages. */
export type AutomationFailure = { name: string; messages: string[] };
/** A test run's counts and its failing tests. */
export type AutomationResult = { passed: number; failed: number; notRun: number; failures: AutomationFailure[] };

/** A program's exit code (null when a signal ended it), its output, capped, and whether its deadline ended it. */
export type ProgramOutcome = { code: number | null; output: string; timedOut: boolean };
/**
 * Runs a program without a shell to its end; when `signal` aborts or `timeoutMs` passes it ends the
 * program's whole process tree and resolves. Rejects only when the program can't start. Tests stand in.
 */
export type RunProgram = (
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<ProgramOutcome>;

/** Whether `value` is a test filter Genex hands Automation. */
export const isTestFilter = (value: unknown): value is string => typeof value === "string" && TEST_FILTER.test(value);

/** The engine's command-line editor, which runs tests with no window. */
export const editorCmdPath = (engineDir: string) =>
  path.join(engineDir, "Engine", "Binaries", "Mac", "UnrealEditor-Cmd");

/** The headless editor's arguments: the project, the tests to run, where the report goes and how to quit. */
export function automationArgs(projectFile: string, filter: string, reportDir: string): string[] {
  if (!isTestFilter(filter)) throw new Error(MESSAGE.BadFilter);
  return [
    projectFile,
    `-ExecCmds=Automation RunTests ${filter}`,
    "-TestExit=Automation Test Queue Empty",
    `-ReportExportPath=${reportDir}`,
    "-unattended",
    "-nullrhi",
    "-nosplash",
    "-nosound",
    "-nopause",
    "-stdout",
    "-FullStdOutLogOutput",
  ];
}

/** Text as one clipped line. */
function clip(text: string, chars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= chars ? line : `${line.slice(0, chars - ELLIPSIS.length)}${ELLIPSIS}`;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const countOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** A report test's first error messages. */
function errorsOf(test: Record<string, unknown>): string[] {
  const entries = Array.isArray(test.entries) ? test.entries : [];
  return entries
    .map((entry) => record(record(entry).event))
    .filter((event) => event.type === ERROR_EVENT && textOf(event.message))
    .slice(0, MAX_MESSAGES)
    .map((event) => clip(textOf(event.message), MESSAGE_CHARS));
}

/** One test into the counts, by its state. */
function tally(result: AutomationResult, state: string, failure: () => AutomationFailure): void {
  if (PASSED.has(state)) result.passed++;
  else if (FAILED.has(state)) {
    result.failed++;
    if (result.failures.length < MAX_FAILURES) result.failures.push(failure());
  } else result.notRun++;
}

/** Epic's report, read: each test's state, or the report's own counts when it lists none. */
function fromReport(report: Record<string, unknown>): AutomationResult {
  const result: AutomationResult = { passed: 0, failed: 0, notRun: 0, failures: [] };
  const tests = Array.isArray(report.tests) ? report.tests.map(record) : [];
  for (const test of tests) {
    const name = clip(textOf(test.fullTestPath) || textOf(test.testDisplayName), NAME_CHARS);
    tally(result, textOf(test.state), () => ({ name, messages: errorsOf(test) }));
  }
  if (tests.length > 0) return result;
  return {
    passed: countOf(report.succeeded) + countOf(report.succeededWithWarnings),
    failed: countOf(report.failed),
    notRun: countOf(report.notRun),
    failures: [],
  };
}

/** The tests Automation printed as completed, when it wrote no report. */
export function resultsFromOutput(output: string): AutomationResult {
  const result: AutomationResult = { passed: 0, failed: 0, notRun: 0, failures: [] };
  for (const match of output.matchAll(COMPLETED)) {
    const groups = match.groups ?? {};
    const name = clip(groups.path || groups.name || "", NAME_CHARS);
    tally(result, (groups.result ?? "").trim(), () => ({ name, messages: [] }));
  }
  return result;
}

/** A test run's result: Epic's report in `reportDir` (a byte-order mark tolerated, within its cap), else the printed lines. */
export async function readAutomationReport(reportDir: string, output: string): Promise<AutomationResult> {
  const bytes = await readRegularFile(path.join(reportDir, REPORT_FILE), REPORT_MAX_BYTES).catch(() => null);
  if (!bytes) return resultsFromOutput(output);
  try {
    const text = bytes.toString("utf8");
    return fromReport(record(JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text)));
  } catch {
    return resultsFromOutput(output);
  }
}

/** The small environment a test run starts with: the kept variables Genex has, nothing else. */
export function programEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_ENV) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * The product's runner: the program with no shell and the small environment, in a process group of
 * its own (so ending it reaches everything it started), its output collected within the cap, its
 * tree ended when the signal aborts or the deadline passes.
 */
export const systemRunProgram: RunProgram = (file, args, { signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: programEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = outputCollector();
    child.stdout?.on("data", output.add);
    child.stderr?.on("data", output.add);
    let timedOut = false;
    const stop = () => void killProcessTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      resolve({ code, output: output.text(), timedOut });
    });
  });
