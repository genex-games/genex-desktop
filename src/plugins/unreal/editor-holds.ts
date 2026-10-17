/**
 * Which project logs a running Unreal Editor holds open, asked of the Mac's own lsof. An editor
 * keeps its project's log open from its start until it writes `Log file closed`, so a log that
 * never closed and that no editor holds was left by an editor that is gone: a crash days ago,
 * while another editor runs now. lsof is asked only about the editor's own process and only
 * about named files, never about nothing (which would list every file the editor has open). Off
 * a Mac, or when lsof doesn't answer, nothing is known: undefined (or no names), never "not held".
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { macLogsFolder } from "./editor-log.ts";
import type { Runner } from "./setup.ts";

const MAC: NodeJS.Platform = "darwin";
const LSOF = "/usr/sbin/lsof";
/** The editor's own process, by its whole name: lsof reads a pattern between slashes. */
const EDITOR_PROCESS = "/^UnrealEditor$/";
const LSOF_TIMEOUT_MS = 5 * SECOND_MS;
/** lsof's exit code when a file it was asked about isn't open; its answer still lists those that are. */
const LSOF_NOT_ALL_OPEN = 1;
/** A project's own folder in Unreal's Mac logs, `<Project>Editor`, holding `<Project>.log`. */
const PROJECT_LOG_FOLDER = /^([A-Za-z]\w*)Editor$/;
const LINE_BREAK = /\r?\n/;
/** lsof's `-F` field for a file's name, and the separator of a name's folders. */
const NAME_FIELD = "n";
const SLASH = "/";

/** Unreal's crash reporter, by the start of its process name (CrashReportClient, CrashReportClientEditor). */
const CRASH_REPORTER = "CrashRep";
/** The ports Unreal can listen on. */
const HIGHEST_PORT = 65_535;

/** What lsof printed, and whether it complained (so a quiet "not open" can be told from a failure to look). */
type LsofAnswer = { stdout: string; complained: boolean };

/** Whether a log is held open by an editor: true, false, or undefined when this computer can't tell. */
export type LogHeld = (file: string) => Promise<boolean | undefined>;

/** What lsof prints (`-t` pids, `-Fn` names) for the editor's process AND these files, none read as an option. */
function lsofArgs(fields: "-t" | "-Fn", files: readonly string[]): string[] {
  return ["-w", fields, "-a", "-c", EDITOR_PROCESS, "--", ...files];
}

/** A failed run's own field (its exit code, or what it printed), as execFile attaches it to the error. */
function fieldOf(error: unknown, key: "code" | "stdout" | "stderr"): unknown {
  return error instanceof Error && key in error ? Reflect.get(error, key) : undefined;
}

/** lsof's answer, including its "not open" exit; undefined when it didn't run or failed otherwise. */
async function askLsof(runner: Runner, args: string[]): Promise<LsofAnswer | undefined> {
  try {
    const { stdout } = await runner(LSOF, args, { timeout: LSOF_TIMEOUT_MS, windowsHide: true });
    return { stdout, complained: false };
  } catch (error) {
    if (fieldOf(error, "code") !== LSOF_NOT_ALL_OPEN) return undefined;
    const stdout = fieldOf(error, "stdout");
    const stderr = fieldOf(error, "stderr");
    return {
      stdout: typeof stdout === "string" ? stdout : "",
      complained: typeof stderr === "string" && stderr !== "",
    };
  }
}

/**
 * Whether an Unreal Editor holds a log open, on a Mac; undefined elsewhere. A pid in lsof's answer
 * says one does; a quiet empty answer says none does; a complaint or a failure says it can't tell.
 */
export function editorHoldsLog(platform: NodeJS.Platform, runner: Runner): LogHeld | undefined {
  if (platform !== MAC) return undefined;
  return async (file) => {
    const answer = await askLsof(runner, lsofArgs("-t", [file]));
    if (!answer) return undefined;
    if (answer.stdout.trim() !== "") return true;
    return answer.complained ? undefined : false;
  };
}

/**
 * The projects lsof's `-Fn` answer names a held log of, by each name's last two parts
 * (`<Project>Editor/<Project>.log`), so however lsof spells the folders above them they still read.
 */
export function namesInLsof(stdout: string): string[] {
  const names = stdout.split(LINE_BREAK).flatMap((line) => {
    if (!line.startsWith(NAME_FIELD)) return [];
    const [folder = "", file = ""] = line.slice(NAME_FIELD.length).split(SLASH).slice(-2);
    const project = PROJECT_LOG_FOLDER.exec(folder)?.[1];
    return project && file === `${project}.log` ? [project] : [];
  });
  return [...new Set(names)];
}

/**
 * The projects an Unreal Editor has open on a Mac, by the project logs it holds in Unreal's logs
 * folder under `home`: every project folder's log is asked about in one lsof call. None off a Mac,
 * when there is no such folder, or when lsof can't answer.
 */
export async function heldProjectNames(platform: NodeJS.Platform, runner: Runner, home: string): Promise<string[]> {
  if (platform !== MAC) return [];
  const folder = macLogsFolder(home);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files = entries.flatMap((entry) => {
    const project = entry.isDirectory() ? PROJECT_LOG_FOLDER.exec(entry.name)?.[1] : undefined;
    return project ? [path.join(folder, entry.name, `${project}.log`)] : [];
  });
  if (files.length === 0) return [];
  const answer = await askLsof(runner, lsofArgs("-Fn", files.sort()));
  return answer ? namesInLsof(answer.stdout) : [];
}

/**
 * Whether Unreal's crash reporter listens on `port`: a crashed editor's reporter inherits its
 * sockets, the MCP server's with them, and keeps the project's port until it is closed. True, false,
 * or undefined when this computer can't tell (off a Mac, a port Unreal can't use, lsof failed).
 */
export async function crashReporterHolds(
  port: number,
  platform: NodeJS.Platform,
  runner: Runner,
): Promise<boolean | undefined> {
  const usable = Number.isInteger(port) && port > 0 && port <= HIGHEST_PORT;
  if (platform !== MAC || !usable) return undefined;
  const args = ["-w", "-n", "-P", "-t", "-a", "-c", CRASH_REPORTER, `-iTCP:${port}`, "-sTCP:LISTEN"];
  const answer = await askLsof(runner, args);
  return answer ? answer.stdout.trim() !== "" : undefined;
}
