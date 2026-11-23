/**
 * One of Windows' own programs run as an administrator, behind Windows' approval prompt, which
 * Windows PowerShell raises (`Start-Process -Verb RunAs`). The elevated program writes nowhere
 * Genex can read, so its exit status is all there is.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MINUTE_MS } from "../shared/duration.ts";
import { windowsPowerShell } from "./windows-folder-ace.ts";

const run = promisify(execFile);

/** Past the ~2 minutes after which Windows dismisses an unanswered approval prompt on its own. */
const ELEVATED_TIMEOUT_MS = 3 * MINUTE_MS;

/** The elevated step's exit status for a dismissed approval prompt (srt-win's install uses the same). */
export const ELEVATION_CANCELLED_EXIT = 10;

/** ERROR_CANCELLED: the person dismissed the approval prompt. */
const ERROR_CANCELLED = 1223;

/** What the elevated step answered: its exit status and what it wrote to stderr. */
export interface ElevatedAnswer {
  status: number;
  stderr: string;
}

/** `text` inside a PowerShell single-quoted string. */
const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * Starts `program` (a path below System32) as an administrator with `argumentLine`: one approval
 * prompt, then the program, whose exit status the script answers with
 * ({@link ELEVATION_CANCELLED_EXIT} when the prompt was dismissed).
 */
function elevationScript(program: string, argumentLine: string): string {
  return `
$ErrorActionPreference = 'Stop'
$program = Join-Path $env:SystemRoot ${quoted(`System32\\${program}`)}
try {
  $process = Start-Process -FilePath $program -ArgumentList ${quoted(argumentLine)} -Verb RunAs -WindowStyle Hidden -PassThru
} catch {
  for ($e = $_.Exception; $e; $e = $e.InnerException) {
    if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${ERROR_CANCELLED}) { exit ${ELEVATION_CANCELLED_EXIT} }
  }
  throw
}
# The handle, taken before the process ends, keeps its exit code readable.
$null = $process.Handle
$process.WaitForExit()
exit $process.ExitCode
`;
}

/** A PowerShell script as `-EncodedCommand` takes it. */
export function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** A process's exit status from execFile's error; null when it never exited by itself (not started, timed out). */
function exitStatus(error: unknown): number | null {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "number" ? code : null;
}

/**
 * Run `program` (a path below System32) as an administrator with `argumentLine` and answer its
 * exit status; throws when the step never ran to an exit (PowerShell missing, out of time).
 */
export async function runElevated(program: string, argumentLine: string): Promise<ElevatedAnswer> {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedPowerShell(elevationScript(program, argumentLine)),
  ];
  const running = run(windowsPowerShell(), args, { timeout: ELEVATED_TIMEOUT_MS, windowsHide: true, encoding: "utf8" });
  // PowerShell may wait for its input to end before it exits; it reads none.
  running.child.stdin?.end();
  try {
    await running;
    return { status: 0, stderr: "" };
  } catch (error) {
    const status = exitStatus(error);
    if (status === null) throw error;
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    return { status, stderr: stderr.trim() };
  }
}
