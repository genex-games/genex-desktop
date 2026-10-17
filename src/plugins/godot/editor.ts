/**
 * The person's own Godot editor: opening a game's project in it, opening Godot's download page,
 * and whether an editor has the project open now. Each launch is a value (`Launch`), so tests
 * record what would start instead of starting it. Genex never quits or drives the person's editor;
 * it only asks the Genex addon's editor plugin to save or reload (`editor-bridge.ts`), on the
 * clock this env gives.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import type { BridgeClock } from "./editor-bridge.ts";
import type { GodotInstall } from "./find-godot.ts";
import { PROJECT_FILE } from "./game-project.ts";

/** Godot's own download page, the only address Get Godot opens. */
export const GODOT_DOWNLOAD_URL = "https://godotengine.org/download/macos/";
const MAC_OPEN = "/usr/bin/open";
const PS = "/bin/ps";
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
  open(launch: Launch): Promise<void>;
  /** Every running process's command line. */
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

/** Godot's download page in the person's browser. */
export const getGodotLaunch = (): Launch => ({ command: MAC_OPEN, args: [GODOT_DOWNLOAD_URL], detached: false });

/** This computer's: `open` and detached starts for real, and the process list from `ps`. */
export function systemEditorEnv(): EditorEnv {
  return {
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
    commandLines: async () => {
      const listed = await run(PS, ["-axo", "command="], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES });
      return listed.stdout.split("\n").filter(Boolean);
    },
  };
}

/**
 * Whether a command line is a Godot editor with `project` open: Godot's binary started with the
 * project's folder (`--path`) and an editor flag, as Godot's own project list starts it, or with
 * the project's `project.godot`. A headless job of Genex's never counts.
 */
export function isEditorOf(line: string, project: string): boolean {
  const words = line.split(/\s+/);
  if (!/godot/i.test(words[0] ?? "") || words.includes("--headless")) return false;
  const opensFolder = namesFolder(line, project) && words.some((word) => EDITOR_FLAGS.has(word));
  return opensFolder || line.includes(path.join(project, PROJECT_FILE));
}

/** Whether a command line's `--path` is the project's folder itself, not one whose name only starts the same. */
function namesFolder(line: string, project: string): boolean {
  const flag = `--path ${project}`;
  const at = line.indexOf(flag);
  if (at < 0) return false;
  const after = line.charAt(at + flag.length);
  return after === "" || after === " " || after === "/";
}

/** Whether a Godot editor has the project open now; false when the process list can't be read. */
export async function editorOpen(env: EditorEnv, project: string): Promise<boolean> {
  const lines = await env.commandLines().catch(() => []);
  return lines.some((line) => isEditorOf(line, project));
}
