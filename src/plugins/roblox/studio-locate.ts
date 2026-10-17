/**
 * Where Roblox Studio is on this computer and whether it runs, on a Mac and on Windows.
 *
 * - Mac: `/Applications/RobloxStudio.app` (a link only while it stays inside /Applications), its
 *   `Contents/MacOS/RobloxStudio` and `StudioMCP`, and the version from its Info.plist.
 * - Windows: the newest `%LOCALAPPDATA%\Roblox\Versions\version-*\RobloxStudioBeta.exe` (by the
 *   file's time), `%LOCALAPPDATA%\Roblox\mcp.bat`, and the Plugins folder beside them.
 * - Running: `pgrep -x RobloxStudio` on a Mac, `tasklist` by its full path on Windows.
 *
 * Nothing here reads the person's Documents folder: the Mac Plugins folder is only spelled out
 * (macOS asks the person before an app reads Documents, so that waits for their own press), and
 * nothing guesses whether anyone is signed in. Every read goes through the injected `fs`, every
 * program through the injected `run`, so a test stands in for either system on any computer.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { envValue } from "../../substrate/toolchain.ts";

/** Where Roblox's installer puts Studio on a Mac. */
export const STUDIO_MAC_APP = "/Applications/RobloxStudio.app";
/** Studio's program on Windows, in each version folder. */
export const STUDIO_WINDOWS_EXE = "RobloxStudioBeta.exe";
/** Studio's process name on a Mac, as pgrep matches it exactly. */
const STUDIO_MAC_PROCESS = "RobloxStudio";
const MAC_APPLICATIONS = "/Applications";
const MAC_BINARIES = ["Contents", "MacOS"] as const;
const MAC_STUDIO_BINARY = "RobloxStudio";
const MAC_MCP_BINARY = "StudioMCP";
const MAC_INFO_PLIST = ["Contents", "Info.plist"] as const;
const PLUTIL = "/usr/bin/plutil";
const PGREP = "/usr/bin/pgrep";
const WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_MCP_LAUNCHER = "mcp.bat";
/** A version folder Roblox's installer writes: `version-` and a hex build hash. */
const WINDOWS_VERSION_FOLDER = /^version-[0-9a-f]{1,40}$/i;
/** A version as Info.plist states it: two to four dotted numbers. */
const VERSION_TEXT = /^\d{1,6}(\.\d{1,12}){1,3}$/;
/** A full Windows path on a drive (`C:\…`); shares and relative paths are not one. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;
const LINE_BREAK = /\r?\n/;
const PID = /^\d+$/;
/** The longest a process check or a version read may take. */
const COMMAND_TIMEOUT_MS = 5 * SECOND_MS;

/** What the locator reads of one path, without following a link. */
export interface LocateStat {
  file: boolean;
  directory: boolean;
  link: boolean;
  mtimeMs: number;
}

/** The file reads the locator makes; tests hand in a fake disk. */
export interface LocateFs {
  /** Undefined when nothing is there. */
  lstat(file: string): Promise<LocateStat | undefined>;
  realpath(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
}

/** A program's exit code and what it printed. */
export interface RunResult {
  code: number;
  stdout: string;
}

/** Runs a program by its full path with an argument list, never a shell; rejects when it can't start. */
export type Run = (file: string, args: readonly string[]) => Promise<RunResult>;

/** The computer the locator looks at. */
export interface LocateDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  fs: LocateFs;
  run: Run;
}

/** Why Studio was not found. Wire values: never rename. */
export const StudioMiss = {
  NotInstalled: "not-installed",
  /** Windows without LOCALAPPDATA: there is nowhere to look. */
  NoLocalAppData: "no-local-app-data",
  /** A link that leads out of where Studio belongs. */
  Refused: "refused",
  /** A home or LOCALAPPDATA that isn't a full path of this system. */
  OtherSystem: "other-system",
  /** A system Roblox Studio doesn't run on. */
  Unsupported: "unsupported",
} as const;
export type StudioMiss = (typeof StudioMiss)[keyof typeof StudioMiss];

/** An installed Studio: the app, its program, its MCP launcher when it has one, and where plugins go. */
export interface StudioInstall {
  /** The Mac app bundle, or the Windows program. */
  app: string;
  studio: string;
  /** StudioMCP on a Mac, mcp.bat on Windows; missing on a Studio without one. */
  mcp?: string;
  /** Studio's Plugins folder, spelled out only: nothing here reads it. */
  plugins: string;
  version?: string;
}

/** Where Studio is, or why it isn't found. */
export type StudioLocation = { installed: true; install: StudioInstall } | { installed: false; miss: StudioMiss };

const missing = (miss: StudioMiss): StudioLocation => ({ installed: false, miss });

/** Whether `segments` holds a step up, which a path from the environment never needs. */
const climbs = (segments: readonly string[]) => segments.includes("..");

/** A full Mac path with no backslash and no step up. */
export function isMacPath(value: string): boolean {
  return path.posix.isAbsolute(value) && !value.includes("\\") && !climbs(value.split("/"));
}

/** A full Windows path on a drive with no step up. */
export function isWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE_PATH.test(value) && !climbs(value.split(/[\\/]/));
}

/** Whether `target` is `root` or inside it, in `flavour`'s spelling (Windows' ignores case). */
function within(flavour: path.PlatformPath, root: string, target: string): boolean {
  const relative = flavour.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !flavour.isAbsolute(relative));
}

/** A regular file that is not a link. */
async function plainFile(fs: LocateFs, file: string): Promise<boolean> {
  const stat = await fs.lstat(file);
  return Boolean(stat?.file && !stat.link);
}

/** A folder that is not a link. */
async function plainFolder(fs: LocateFs, dir: string): Promise<boolean> {
  const stat = await fs.lstat(dir);
  return Boolean(stat?.directory && !stat.link);
}

/** The version Info.plist states, through plutil; undefined when it can't be read. */
async function macVersion(deps: LocateDeps, app: string): Promise<string | undefined> {
  const plist = path.posix.join(app, ...MAC_INFO_PLIST);
  const args = ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist];
  const answer = await deps.run(PLUTIL, args).catch(() => undefined);
  const version = answer?.code === 0 ? answer.stdout.trim() : "";
  return VERSION_TEXT.test(version) ? version : undefined;
}

async function locateOnMac(deps: LocateDeps): Promise<StudioLocation> {
  const { fs } = deps;
  if (!isMacPath(deps.home)) return missing(StudioMiss.OtherSystem);
  if (!(await fs.lstat(STUDIO_MAC_APP))) return missing(StudioMiss.NotInstalled);
  const [app, applications] = await Promise.all([fs.realpath(STUDIO_MAC_APP), fs.realpath(MAC_APPLICATIONS)]);
  if (!within(path.posix, applications, app)) return missing(StudioMiss.Refused);
  if (!(await plainFolder(fs, app))) return missing(StudioMiss.NotInstalled);
  const studio = path.posix.join(app, ...MAC_BINARIES, MAC_STUDIO_BINARY);
  const program = await fs.lstat(studio);
  if (program?.link) return missing(StudioMiss.Refused);
  if (!program?.file) return missing(StudioMiss.NotInstalled);
  const mcp = path.posix.join(app, ...MAC_BINARIES, MAC_MCP_BINARY);
  const install: StudioInstall = {
    app: STUDIO_MAC_APP,
    studio,
    plugins: path.posix.join(deps.home, "Documents", "Roblox", "Plugins"),
  };
  if (await plainFile(fs, mcp)) install.mcp = mcp;
  const version = await macVersion(deps, app);
  if (version) install.version = version;
  return { installed: true, install };
}

/** The newest version folder's Studio program, by the program file's time; links are passed over. */
async function newestWindowsStudio(fs: LocateFs, versions: string): Promise<string | undefined> {
  let newest: { file: string; at: number } | undefined;
  for (const name of await fs.readdir(versions)) {
    if (!WINDOWS_VERSION_FOLDER.test(name)) continue;
    const folder = path.win32.join(versions, name);
    if (!(await plainFolder(fs, folder))) continue;
    const file = path.win32.join(folder, STUDIO_WINDOWS_EXE);
    const stat = await fs.lstat(file);
    if (!stat?.file || stat.link) continue;
    if (!newest || stat.mtimeMs > newest.at) newest = { file, at: stat.mtimeMs };
  }
  return newest?.file;
}

async function locateOnWindows(deps: LocateDeps): Promise<StudioLocation> {
  const { fs } = deps;
  const local = envValue(deps.env, "LOCALAPPDATA");
  if (!local) return missing(StudioMiss.NoLocalAppData);
  if (!isWindowsPath(local)) return missing(StudioMiss.OtherSystem);
  const roblox = path.win32.join(local, "Roblox");
  const folder = await fs.lstat(roblox);
  if (folder?.link) return missing(StudioMiss.Refused);
  if (!folder?.directory) return missing(StudioMiss.NotInstalled);
  const versions = path.win32.join(roblox, "Versions");
  if (!(await plainFolder(fs, versions))) return missing(StudioMiss.NotInstalled);
  const studio = await newestWindowsStudio(fs, versions);
  if (!studio) return missing(StudioMiss.NotInstalled);
  const [realRoblox, realStudio] = await Promise.all([fs.realpath(roblox), fs.realpath(studio)]);
  if (!within(path.win32, realRoblox, realStudio)) return missing(StudioMiss.Refused);
  const install: StudioInstall = { app: studio, studio, plugins: path.win32.join(roblox, "Plugins") };
  const mcp = path.win32.join(roblox, WINDOWS_MCP_LAUNCHER);
  if (await plainFile(fs, mcp)) install.mcp = mcp;
  return { installed: true, install };
}

/** Where Roblox Studio is on this computer, or why it isn't found. */
export async function locateStudio(deps: LocateDeps): Promise<StudioLocation> {
  if (deps.platform === "darwin") return locateOnMac(deps);
  if (deps.platform === "win32") return locateOnWindows(deps);
  return missing(StudioMiss.Unsupported);
}

/** Whether pgrep's answer lists a process: it exits 0 with one pid a line, and 1 with none. */
export function pgrepRunning(answer: RunResult): boolean {
  return answer.code === 0 && answer.stdout.split(LINE_BREAK).some((line) => PID.test(line.trim()));
}

/** Whether tasklist's CSV answer has a row for Studio; its "no tasks" note has none. */
export function tasklistRunning(stdout: string): boolean {
  const program = STUDIO_WINDOWS_EXE.toLowerCase();
  return stdout
    .split(LINE_BREAK)
    .some((line) => (line.split(",")[0] ?? "").trim().replace(/^"|"$/g, "").toLowerCase() === program);
}

/** Windows' own tasklist by its full path under SystemRoot, so neither PATH nor the current folder stands in. */
function tasklistPath(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, "SystemRoot");
  return path.win32.join(root && isWindowsPath(root) ? root : WINDOWS_ROOT, "System32", "tasklist.exe");
}

/** The process ids of every Studio running on a Mac (none elsewhere, or when pgrep can't run). */
export async function studioPids(deps: LocateDeps): Promise<number[]> {
  if (deps.platform !== "darwin") return [];
  const answer = await deps.run(PGREP, ["-x", STUDIO_MAC_PROCESS]).catch(() => undefined);
  if (!answer || answer.code !== 0) return [];
  return answer.stdout
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => PID.test(line))
    .map(Number);
}

/** Whether Roblox Studio runs; a check that can't run reads as not running. */
export async function studioRunning(deps: LocateDeps): Promise<boolean> {
  if (deps.platform === "win32") {
    const args = ["/FI", `IMAGENAME eq ${STUDIO_WINDOWS_EXE}`, "/FO", "CSV", "/NH"];
    const answer = await deps.run(tasklistPath(deps.env), args).catch(() => undefined);
    return answer ? tasklistRunning(answer.stdout) : false;
  }
  if (deps.platform !== "darwin") return false;
  const answer = await deps.run(PGREP, ["-x", STUDIO_MAC_PROCESS]).catch(() => undefined);
  return answer ? pgrepRunning(answer) : false;
}

/** The computer's own disk: lstat that answers undefined for a missing path. */
export const systemLocateFs: LocateFs = {
  async lstat(file) {
    const stat = await lstat(file).catch(() => undefined);
    if (!stat) return undefined;
    return { file: stat.isFile(), directory: stat.isDirectory(), link: stat.isSymbolicLink(), mtimeMs: stat.mtimeMs };
  },
  realpath: (file) => realpath(file),
  readdir: (dir) => readdir(dir),
};

/**
 * Runs a program with execFile (no shell, no window on Windows) to its end: a non-zero exit is an
 * answer, with whatever it printed; a program that can't start rejects.
 */
export const systemRun: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, stdout: String(stdout ?? "") });
      reject(error);
    });
  });
