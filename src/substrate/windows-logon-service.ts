/**
 * The Secondary Logon service (`seclogon`), which the Windows sandbox cannot run without: srt-win
 * starts every sandboxed command as the `srt-sandbox` user through CreateProcessWithLogonW, which
 * that service carries out. Where hardening disabled it, Windows refuses each start ("Access is
 * denied"). Manual is enough: Windows starts the service when the call needs it.
 *
 * Its start type is read from `sc qc seclogon`, which needs no administrator; Set up turns it back
 * on (`sc config seclogon start= demand`) behind Windows' approval prompt (`windows-elevated.ts`):
 * srt-win's own install elevates itself, so the service cannot join its prompt.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import { ELEVATION_CANCELLED_EXIT, type ElevatedAnswer, runElevated } from "./windows-elevated.ts";

const run = promisify(execFile);

/** How long `sc qc` may take. */
const QUERY_TIMEOUT_MS = 15 * SECOND_MS;

/** The service's name, as `sc` takes it. */
const LOGON_SERVICE = "seclogon";

/** The elevated step's exit status for a dismissed approval prompt. */
export const LOGON_SERVICE_CANCELLED_EXIT = ELEVATION_CANCELLED_EXIT;

/** How Windows starts a service, from `sc qc`'s START_TYPE. */
export const ServiceStartType = {
  Boot: "boot",
  System: "system",
  Auto: "auto",
  /** Manual: started when something asks for it. */
  Demand: "demand",
  Disabled: "disabled",
} as const;
export type ServiceStartType = (typeof ServiceStartType)[keyof typeof ServiceStartType];

/** Each start type at the number Windows gives it (SERVICE_BOOT_START is 0 … SERVICE_DISABLED is 4). */
const START_TYPE_BY_NUMBER: readonly ServiceStartType[] = [
  ServiceStartType.Boot,
  ServiceStartType.System,
  ServiceStartType.Auto,
  ServiceStartType.Demand,
  ServiceStartType.Disabled,
];

/** `sc qc`'s START_TYPE line, by its number: the word after it is localized. */
const START_TYPE_LINE = /^\s*START_TYPE\s*:\s*(\d+)\b/m;

const MESSAGE = {
  NotEnabled: (status: number, stderr: string) =>
    [`could not turn on the Secondary Logon service (${LOGON_SERVICE}): exit ${status}`, stderr]
      .filter(Boolean)
      .join(": "),
} as const;

/** The start type in `sc qc`'s answer; null when it holds none Genex knows. */
export function serviceStartType(output: string): ServiceStartType | null {
  const match = START_TYPE_LINE.exec(output);
  return match ? (START_TYPE_BY_NUMBER[Number(match[1])] ?? null) : null;
}

/** `sc.exe` by its full path: a folder on PATH must not stand in for it. */
function scPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "sc.exe");
}

async function queryLogonService(): Promise<string> {
  const { stdout } = await run(scPath(), ["qc", LOGON_SERVICE], { timeout: QUERY_TIMEOUT_MS, windowsHide: true });
  return stdout;
}

/** The Secondary Logon service's start type, without elevation; null when `sc` could not say. */
export async function logonServiceStartType(
  query: () => Promise<string> = queryLogonService,
): Promise<ServiceStartType | null> {
  return query().then(serviceStartType, () => null);
}

/** Turns the service back on as an administrator: one approval prompt, then `sc config`. */
const runElevatedEnable = (): Promise<ElevatedAnswer> => runElevated("sc.exe", `config ${LOGON_SERVICE} start= demand`);

/**
 * Set the Secondary Logon service to Manual, behind one approval prompt: `cancelled` when the
 * prompt was dismissed; throws, with the step's own exit status and words, when Windows would not.
 */
export async function enableLogonService(
  elevate: () => Promise<ElevatedAnswer> = runElevatedEnable,
): Promise<{ cancelled: boolean }> {
  const { status, stderr } = await elevate();
  if (status === LOGON_SERVICE_CANCELLED_EXIT) return { cancelled: true };
  if (status !== 0) throw new Error(MESSAGE.NotEnabled(status, stderr));
  return { cancelled: false };
}
