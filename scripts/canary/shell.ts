// Running the system's own tools from a canary step: never throws, always answers with the exit
// code and both outputs, so a step can say what went wrong.
import { execFile } from "node:child_process";
import { MINUTE_MS } from "../../src/shared/duration.ts";

/** A finished command. */
export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** How long a system tool may take unless the step says otherwise. */
const COMMAND_TIMEOUT_MS = 10 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** A failed run's exit code: the process's own, or 1 when it never ran or was killed. */
function exitCode(error: { code?: unknown } | null): number {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : 1;
}

/** Run `file` with `args` (no shell) and wait for it. */
export function sh(
  file: string,
  args: readonly string[],
  {
    env = process.env,
    cwd,
    timeoutMs = COMMAND_TIMEOUT_MS,
  }: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env, cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const code = exitCode(error);
        const failure = error && typeof error.code !== "number" ? `\n${error.message}` : "";
        resolve({ code, stdout: String(stdout), stderr: `${String(stderr)}${failure}` });
      },
    );
  });
}

/** `args` run as root: directly when this process is root, else through passwordless sudo. */
export function asRoot(args: readonly string[]): [string, string[]] {
  const [file = "", ...rest] = args;
  if (process.getuid?.() === 0) return [file, rest];
  return ["sudo", ["-n", ...args]];
}

/**
 * A PowerShell command run with the given values as environment variables (CANARY_<NAME>), so a
 * path or name never has to be quoted into the script text. The script goes as -EncodedCommand
 * (UTF-16LE base64): Windows' command-line quoting cannot then reach the quotes inside it.
 */
export function powershell(script: string, values: Record<string, string> = {}): Promise<Ran> {
  const env = { ...process.env };
  // Windows PowerShell builds its own module path when none is set; one inherited from
  // PowerShell 7 (a GitHub step's shell) points at modules it cannot load, and its cmdlets vanish.
  delete env.PSModulePath;
  for (const [name, value] of Object.entries(values)) env[`CANARY_${name.toUpperCase()}`] = value;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return sh(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      env,
    },
  );
}

/** The last `lines` lines of a text, for a step's detail. */
export function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}
