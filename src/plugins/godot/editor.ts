/**
 * The person's own Godot editor: opening a game's project in it, opening Godot's download page on
 * a Mac, and whether an editor has the project open now (a Mac's `ps`, Windows's process list with
 * command lines). Each launch is a value (`Launch`), so tests record what would start instead of
 * starting it. Genex never quits or drives the person's editor; it only asks the Genex addon's
 * editor plugin to save or reload (`editor-bridge.ts`), on the clock this env gives.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { windowsProcesses } from "../../substrate/windows-processes.ts";
import type { BridgeClock } from "./editor-bridge.ts";
import type { GodotInstall } from "./find-godot.ts";
import { PROJECT_FILE } from "./game-project.ts";

/** Godot's own download page for a Mac: the only address Get Godot opens. Windows gets Genex's own install. */
export const GODOT_DOWNLOAD_URL = "https://godotengine.org/download/macos/";
const MAC_OPEN = "/usr/bin/open";
const PS = "/bin/ps";
/** Godot's processes on Windows, by program name (a WQL pattern): `Godot_v4.7.2-stable_win64.exe`, `godot.exe`. */
const WINDOWS_GODOT = "Godot%";
/** How long `open` and `ps` may take. */
const COMMAND_TIMEOUT_MS = 10 * SECOND_MS;
/** The process table can be long on a busy Mac. */
const PS_MAX_BYTES = 16 * 1024 ** 2;
/** The flags that make Godot start its editor rather than the game. */
const EDITOR_FLAGS = new Set(["-e", "--editor"]);

/** One thing to start: a command, its arguments, and whether it outlives the call (an app that stays). */
export type Launch = { command: string; args: string[]; detached: boolean };

/** What the editor's moves need from the computer; tests record launches and hand in a process list. */
export type EditorEnv = BridgeClock & {
  /** The computer the editor runs on: Windows's paths are compared without case or slash direction. */
  platform: NodeJS.Platform;
  open(launch: Launch): Promise<void>;
  /** Every running process's command line (on Windows, Godot's, each program by its file name). */
  commandLines(): Promise<string[]>;
};

const run = promisify(execFile);

/**
 * Opens a project in the Godot editor: a new instance of the app (`open -n`, or a running Godot
 * would only come forward), or a bare binary started on its own.
 */
export function openEditorLaunch(install: GodotInstall, project: string): Launch {
  const args = ["--path", project, "--editor"];
  if (install.app) return { command: MAC_OPEN, args: ["-n", "-a", install.app, "--args", ...args], detached: false };
  return { command: install.binary, args, detached: true };
}

/** Godot's download page on a Mac, in the person's browser through `open`. */
export function getGodotLaunch(): Launch {
  return { command: MAC_OPEN, args: [GODOT_DOWNLOAD_URL], detached: false };
}

/** A Mac's every process by its command line, from `ps`. */
async function macCommandLines(): Promise<string[]> {
  const listed = await run(PS, ["-axo", "command="], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES });
  return listed.stdout.split("\n").filter(Boolean);
}

/**
 * Windows's Godot processes by their command lines, each program by its file name (`Godot_v4.7.2-
 * stable_win64.exe --path C:\Games\Valley\godot --editor`): its full path may hold a space.
 */
async function windowsCommandLines(): Promise<string[]> {
  const rows = (await windowsProcesses([WINDOWS_GODOT])) ?? [];
  return rows.map((row) => `${path.win32.basename(row.exec)}${row.args.slice(row.exec.length)}`);
}

/**
 * This computer's: `open` and detached starts for real, and the process list. A detached start on
 * Windows is a window of its own (the editor), so it is not started hidden.
 */
export function systemEditorEnv(platform: NodeJS.Platform = process.platform): EditorEnv {
  return {
    platform,
    open: async (launch) => {
      if (!launch.detached) {
        await run(launch.command, launch.args, { timeout: COMMAND_TIMEOUT_MS });
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
    now: () => Date.now(),
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
    commandLines: platform === "win32" ? windowsCommandLines : macCommandLines,
  };
}

/** Text as Windows compares paths in it: one case, `\\` for every slash. */
const windowsKey = (text: string) => text.replaceAll("/", "\\").toLowerCase();

/**
 * Whether a command line is a Godot editor with `project` open: Godot's binary started with the
 * project's folder (`--path`) and an editor flag, as Godot's own project list starts it, or with
 * the project's `project.godot`. A headless job of Genex's never counts. On Windows the line and
 * the project are compared without case or slash direction (Godot's project list writes `C:/…`).
 */
export function isEditorOf(line: string, project: string, platform: NodeJS.Platform = process.platform): boolean {
  const windows = platform === "win32";
  const [text, folder] = windows ? [windowsKey(line), windowsKey(project)] : [line, project];
  const words = text.split(/\s+/);
  if (!/godot/i.test(words[0] ?? "") || words.includes("--headless")) return false;
  const opensFolder = namesFolder(text, folder) && words.some((word) => EDITOR_FLAGS.has(word));
  const file = (windows ? path.win32 : path.posix).join(folder, PROJECT_FILE);
  return opensFolder || text.includes(file);
}

/** Whether a command line's `--path` is the project's folder itself, not one whose name only starts the same. */
function namesFolder(line: string, project: string): boolean {
  const flag = `--path ${project}`;
  const at = line.indexOf(flag);
  if (at < 0) return false;
  const after = line.charAt(at + flag.length);
  return after === "" || after === " " || after === "/" || after === "\\";
}

/** Whether a Godot editor has the project open now; false when the process list can't be read. */
export async function editorOpen(env: EditorEnv, project: string): Promise<boolean> {
  const lines = await env.commandLines().catch(() => []);
  return lines.some((line) => isEditorOf(line, project, env.platform));
}
