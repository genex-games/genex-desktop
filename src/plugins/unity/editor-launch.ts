/**
 * Opening a game's Unity project in the person's own installed editor, as double-clicking it in
 * Unity Hub does: the editor whose version the project names, never another one (Unity would offer
 * to upgrade the project, which is the person's call). A launch is a command and an argument array
 * handed to the backend's opener, never a shell string, so tests read the exact command and
 * nothing runs. Whether to open at all is `editor-open.ts`'s: Unity allows one editor per project
 * and shows a dialog to the second.
 *
 * After opening, Genex waits for the editor's Pipeline server to say it is ready: a first start
 * imports the project and downloads packages before it answers.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import type { UnityEditor } from "./editors.ts";
import { type PipelineDeps, ServerStatus, serverStatus } from "./pipeline.ts";

/** A Mac's own program that opens apps. */
const MAC_OPEN = "/usr/bin/open";
/** The editor's flag naming the project to open. */
const PROJECT_FLAG = "-projectPath";
/** How long the Mac's opener may take to hand the app over. */
const OPEN_MS = 30 * SECOND_MS;
/** How long a tool waits for an editor it opened: under the host's limit for one plugin call. */
export const WAIT_FOR_EDITOR_MS = 150 * SECOND_MS;
/** How often a wait asks the editor again. */
const WAIT_POLL_MS = 2 * SECOND_MS;

/** One program to start: its arguments, and whether it keeps running after the backend. */
export type Launch = { command: string; args: string[]; detached: boolean };
/** Starts a launch: the product's opener runs it; tests record it. */
export type Opener = (launch: Launch) => Promise<void>;

/**
 * Opens a project in an editor. A Mac opens a new editor through its own opener (`open -n`: without
 * it a running Unity would only come forward and ignore the project), so the editor is the person's
 * app, not a child of Genex. Windows starts the executable detached.
 */
export function openProjectLaunch(editor: UnityEditor, root: string, platform: NodeJS.Platform): Launch {
  if (platform === "win32") return { command: editor.app, args: [PROJECT_FLAG, root], detached: true };
  return { command: MAC_OPEN, args: ["-n", "-a", editor.app, "--args", PROJECT_FLAG, root], detached: false };
}

/** Unity's own page for getting Unity Hub, which installs editors. */
export const UNITY_DOWNLOAD_URL = "https://unity.com/download";
/** Windows's own folder when the environment names none, and its program that opens a page in the browser. */
const WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_EXPLORER = "explorer.exe";

/** Where the person is sent for Unity. Wire values: never rename one. */
export const UnitySource = { Hub: "hub", Download: "download" } as const;
export type UnitySource = (typeof UnitySource)[keyof typeof UnitySource];

/** Windows's own folder: the one its environment names when that is a whole path, so neither PATH nor the current folder stands in. */
function windowsRoot(env: NodeJS.ProcessEnv): string {
  const named = env.SystemRoot;
  return named && path.win32.isAbsolute(named) ? named : WINDOWS_ROOT;
}

/**
 * Opens Unity Hub when it was found, else Unity's download page in the person's browser. The page
 * and the programs are this module's own: nothing a panel sends chooses either.
 */
export function getUnityLaunch(
  platform: NodeJS.Platform,
  hub: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Launch {
  if (platform !== "win32")
    return { command: MAC_OPEN, args: hub ? ["-a", hub] : [UNITY_DOWNLOAD_URL], detached: false };
  if (hub) return { command: hub, args: [], detached: true };
  return { command: path.win32.join(windowsRoot(env), WINDOWS_EXPLORER), args: [UNITY_DOWNLOAD_URL], detached: true };
}

const run = promisify(execFile);

/** The product's opener: a command that returns is awaited; a detached one is started and left to run. */
export const systemOpener: Opener = async (launch) => {
  if (!launch.detached) {
    await run(launch.command, launch.args, { timeout: OPEN_MS, windowsHide: true });
    return;
  }
  const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
};

/** Where an editor stands at the end of a wait. Wire values: never rename one. */
export const EditorWait = {
  /** Its server answers that it is ready. */
  Ready: "ready",
  /** It is not ready yet: still starting, importing, or showing a dialog. */
  NotYet: "not-yet",
} as const;
export type EditorWait = (typeof EditorWait)[keyof typeof EditorWait];

/** Whether the editor that has `root` open answers that it is ready, asked once. */
export async function editorReady(root: string, deps: PipelineDeps, signal?: AbortSignal): Promise<boolean> {
  const status = await serverStatus(root, deps, signal);
  return status.ok && status.result === ServerStatus.Ready;
}

/**
 * Waits up to `waitMs` for the editor that has `root` open to say it is ready; a stop of the call
 * ends the wait as not yet.
 */
export async function waitForEditor(
  root: string,
  deps: PipelineDeps,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<EditorWait> {
  const ends = deps.now() + (options.waitMs ?? WAIT_FOR_EDITOR_MS);
  for (;;) {
    if (options.signal?.aborted) return EditorWait.NotYet;
    if (await editorReady(root, deps, options.signal).catch(() => false)) return EditorWait.Ready;
    if (deps.now() + WAIT_POLL_MS > ends) return EditorWait.NotYet;
    await deps.sleep(WAIT_POLL_MS, options.signal).catch(() => undefined);
  }
}
