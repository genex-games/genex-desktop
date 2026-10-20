/**
 * Windows' running processes with their command lines, for the engine plugins that find an
 * editor by the project its arguments name. The task list names no command line, so Windows
 * PowerShell (on every Windows 10 and 11) asks WMI's `Win32_Process` for the programs a caller
 * names, by a fixed script handed over as `-EncodedCommand` (no file, so no execution policy
 * applies). A process WMI cannot read for this user answers an empty command line.
 *
 * Each row's `args` is its command line split as Windows splits it (`CommandLineToArgvW`) and joined
 * by single spaces after its executable's full path: `C:\…\Unity.exe -projectPath C:\Games\My Game`,
 * the shape `ps -o args=` gives on a Mac, so one match reads both.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";

/** How long the listing may take: PowerShell's own start is most of it. */
const LIST_TIMEOUT_MS = 20 * SECOND_MS;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const WINDOWS_ROOT = "C:\\Windows";
/** A program name WMI is asked for: a plain file name, never a WQL fragment. */
const PROGRAM_NAME = /^[\w.-]+$/;

/** One running process: its id, its program and its whole command line. */
export interface WindowsProcessRow {
  pid: number;
  exec: string;
  args: string;
}

/** How the listing runs PowerShell; tests stand in for it. */
export type PowerShellRun = (file: string, args: readonly string[]) => Promise<string>;

const runFile = promisify(execFile);

const powerShellRun: PowerShellRun = async (file, args) =>
  (await runFile(file, [...args], { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BYTES, windowsHide: true })).stdout;

/** Windows PowerShell by its full path under SystemRoot, so neither PATH nor the current folder stands in. */
function powerShellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot;
  const base = root && path.win32.isAbsolute(root) ? root : WINDOWS_ROOT;
  return path.win32.join(base, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The script that lists `names` (each `Unity.exe`, or a `CrashReportClient%` pattern) as JSON. */
function listScript(names: readonly string[]): string {
  const filter = names.map((name) => `Name LIKE '${name}'`).join(" OR ");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = @(Get-CimInstance -ClassName Win32_Process -Filter "${filter}" | ForEach-Object {`,
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; exec = [string]$_.ExecutablePath; name = [string]$_.Name; line = [string]$_.CommandLine } })",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("\n");
}

/** One piece of a command line: backslashes before a quote (and the quote), blanks, backslashes, or plain text. */
const ARGV_PIECE = /(\\*)"|[ \t]+|\\+|[^\\" \t]+/g;
const BLANK = /^[ \t]/;

/** Backslashes before a quote: half of them kept, and an odd one out makes the quote a character. */
function beforeQuote(slashes: string): { text: string; toggles: boolean } {
  const escaped = slashes.length % 2 === 1;
  return { text: `${"\\".repeat(Math.floor(slashes.length / 2))}${escaped ? '"' : ""}`, toggles: !escaped };
}

/** A command line split as `CommandLineToArgvW` splits it: quotes group, backslashes escape only a quote. */
export function windowsArgv(line: string): string[] {
  const argv: string[] = [];
  let current: string | null = null;
  let quoted = false;
  for (const [piece, slashes] of line.matchAll(ARGV_PIECE)) {
    if (BLANK.test(piece) && !quoted) {
      if (current !== null) argv.push(current);
      current = null;
      continue;
    }
    const quote = slashes === undefined ? null : beforeQuote(slashes);
    if (quote?.toggles) quoted = !quoted;
    current = `${current ?? ""}${quote ? quote.text : piece}`;
  }
  if (current !== null) argv.push(current);
  return argv;
}

/** One answered row, or null for anything that is not one. */
function rowOf(value: unknown): WindowsProcessRow | null {
  if (!value || typeof value !== "object") return null;
  const { pid, exec, name, line } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const named = typeof name === "string" ? name : "";
  const program = typeof exec === "string" && exec ? exec : named;
  if (!program) return null;
  const rest = windowsArgv(typeof line === "string" ? line : "").slice(1);
  return { pid, exec: program, args: [program, ...rest].join(" ") };
}

/** The rows of PowerShell's JSON answer: an array of objects (one object or nothing when it found one or none). */
export function windowsProcessRows(json: string): WindowsProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim() || "[]");
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap((value) => rowOf(value) ?? []);
}

/**
 * This Windows computer's processes whose program is one of `names` (WQL `LIKE` patterns: `%`
 * for any run of characters), with their command lines; null when the listing failed, so a caller
 * can fall back to the task list.
 */
export async function windowsProcesses(
  names: readonly string[],
  options: { env?: NodeJS.ProcessEnv; run?: PowerShellRun } = {},
): Promise<WindowsProcessRow[] | null> {
  const safe = names.filter((name) => PROGRAM_NAME.test(name.replaceAll("%", "")));
  if (safe.length === 0) return [];
  const script = Buffer.from(listScript(safe), "utf16le").toString("base64");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script];
  const run = options.run ?? powerShellRun;
  const stdout = await run(powerShellPath(options.env ?? process.env), args).catch(() => null);
  return stdout === null ? null : windowsProcessRows(stdout);
}
