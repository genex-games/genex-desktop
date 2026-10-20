/**
 * What a Windows install asks of main before anything else runs.
 *
 * Squirrel, the per-user installer forge.config.cjs builds, starts the app with one
 * `--squirrel-*` argument after it installs or updates it and before it removes it. That launch
 * must do the step's work (the Start menu and desktop shortcuts, through Squirrel's own
 * Update.exe beside the versioned app folder) and exit at once: no window, no profile, no core.
 *
 * The app user model id ties notifications and the taskbar to the Start menu shortcut. Inside a
 * Squirrel install Electron sets Squirrel's own (`com.squirrel.genex.genex`, the id its shortcut
 * carries), so main sets Genex's only for a copy Squirrel did not install.
 */
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { SECOND_MS } from "../shared/duration.ts";

/** The launches Squirrel makes that are not the person opening the app, in their argv spelling. */
export const SquirrelEvent = {
  Install: "--squirrel-install",
  Updated: "--squirrel-updated",
  Uninstall: "--squirrel-uninstall",
  /** An older version, after an update replaced it. */
  Obsolete: "--squirrel-obsolete",
} as const;
export type SquirrelEvent = (typeof SquirrelEvent)[keyof typeof SquirrelEvent];

/** Genex's app user model id outside a Squirrel install: the id its packages are signed under. */
export const APP_USER_MODEL_ID = "games.genex.desktop";

/** Squirrel's updater, one folder above the versioned `app-<version>` folder the app runs from. */
const UPDATE_EXE = "Update.exe";
/** How long a shortcut step may take before the launch exits anyway; Squirrel waits on it. */
const SQUIRREL_STEP_TIMEOUT_MS = 15 * SECOND_MS;

const SQUIRREL_EVENTS: ReadonlySet<string> = new Set(Object.values(SquirrelEvent));

/** The Update.exe arguments for each event; none for an obsolete copy, which only exits. */
const SHORTCUT_ARGS = {
  [SquirrelEvent.Install]: (exe: string) => ["--createShortcut", exe],
  [SquirrelEvent.Updated]: (exe: string) => ["--createShortcut", exe],
  [SquirrelEvent.Uninstall]: (exe: string) => ["--removeShortcut", exe],
  [SquirrelEvent.Obsolete]: () => [],
} as const satisfies Record<SquirrelEvent, (exe: string) => string[]>;

/** One Squirrel launch's work: Update.exe with `args`, or nothing when `args` is empty; then exit. */
export interface SquirrelStep {
  updateExe: string;
  args: string[];
  /** An uninstall: the sandbox's entries Genex keeps between launches go too (`takeBackSandboxEntries`). */
  takeBackSandbox: boolean;
}

/** Squirrel's Update.exe for the app at `execPath`. */
function squirrelUpdateExe(execPath: string): string {
  return path.win32.resolve(path.win32.dirname(execPath), "..", UPDATE_EXE);
}

/** The step a Squirrel launch asks for, or null for every other launch and on other platforms. */
export function squirrelStartup(platform: string, argv: readonly string[], execPath: string): SquirrelStep | null {
  if (platform !== StudioPlatform.Windows) return null;
  const event = argv.find((arg): arg is SquirrelEvent => SQUIRREL_EVENTS.has(arg));
  if (!event) return null;
  return {
    updateExe: squirrelUpdateExe(execPath),
    args: SHORTCUT_ARGS[event](path.win32.basename(execPath)),
    takeBackSandbox: event === SquirrelEvent.Uninstall,
  };
}

/** The app user model id main sets, or null where there is none to set (another OS, a Squirrel install). */
export function appUserModelId(platform: string, execPath: string, exists: (file: string) => boolean): string | null {
  if (platform !== StudioPlatform.Windows) return null;
  return exists(squirrelUpdateExe(execPath)) ? null : APP_USER_MODEL_ID;
}

/**
 * The folder a packaged Windows app works from: its own install folder, or null to keep the launch's.
 * The sandbox starts srt-win as its own user from the app's working folder, which Windows opens as
 * that user; a shortcut or Explorer can start Genex anywhere in the profile, where that user may
 * open nothing, while the install folder is one the session lets it read.
 */
export function installedWorkingDir(platform: string, execPath: string, packaged: boolean): string | null {
  if (platform !== StudioPlatform.Windows || !packaged) return null;
  return path.win32.dirname(execPath);
}

/** The part of a spawned child a Squirrel step waits on. */
interface StepChild {
  once(event: "exit" | "error", listener: () => void): unknown;
  unref(): void;
}

type SpawnStep = (file: string, args: readonly string[]) => StepChild;

/**
 * Run a Squirrel step's Update.exe and settle when it exits, fails to start or runs past
 * `timeoutMs`: the launch exits after it either way, and an install must never hang on a shortcut.
 */
export function runSquirrelStep(
  step: Pick<SquirrelStep, "updateExe" | "args">,
  spawn: SpawnStep,
  timeoutMs = SQUIRREL_STEP_TIMEOUT_MS,
) {
  if (step.args.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const child = spawn(step.updateExe, step.args);
    const timer = setTimeout(done, timeoutMs);
    function done(): void {
      clearTimeout(timer);
      child.unref();
      resolve();
    }
    child.once("exit", done);
    child.once("error", done);
  });
}
