/**
 * The Godot installs on this computer, each asked its version (`--version`, which runs nothing of a
 * project). On a Mac: the app in Applications (the user's own too), in Downloads (where Godot's zip
 * lands), Steam's, Homebrew's and any `godot` on the PATH. On Windows: the Godot Genex installed in
 * its own folder (the host's pinned runtime, which Genex's sandbox reads), a Godot in Program Files,
 * Steam's (in every Steam library) and any `godot.exe` on the PATH; one elsewhere in the person's profile is left out,
 * since the sandbox user that runs Genex's Godot jobs can't read it. Genex builds with Godot 4.3 or
 * newer in the 4 line; a .NET build counts as Godot too, though Genex's tools speak GDScript. The
 * newest supported install is the one Genex uses.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { engineTestMac } from "../../substrate/app-install.ts";
import { isInside } from "../../substrate/paths.ts";

const exec = promisify(execFile);

/** The oldest Godot Genex builds with: 4.3 brought the scripting and export behavior its tools rely on. */
export const MIN_GODOT = { major: 4, minor: 3 } as const;
/** How long a binary may take to say its version. */
const VERSION_TIMEOUT_MS = 10 * SECOND_MS;
/** The macOS program and key that name this user's own temporary folder. */
const GETCONF = "/usr/bin/getconf";
const USER_TEMP_KEY = "DARWIN_USER_TEMP_DIR";
/** The executable inside a Godot app bundle. */
const APP_BINARY = ["Contents", "MacOS", "Godot"];
const GODOT_APP = /^godot.*\.app$/i;
/** The names Godot goes by on the PATH. */
const PATH_NAMES = ["godot", "godot4"];
/** Homebrew's `godot`, on Apple silicon and on Intel. */
const FIXED_BINARIES = ["/opt/homebrew/bin/godot", "/usr/local/bin/godot"];
const SYSTEM_APPLICATIONS = "/Applications";
/** Godot's Windows executables (`Godot_v4.7.2-stable_win64.exe`, Steam's `godot.windows.opt.tools.64.exe`), not the console wrapper beside each. */
const WINDOWS_EXE = /^godot[^\\/]*\.exe$/i;
const CONSOLE_EXE = /_console\.exe$/i;
/** A folder in Program Files that may hold Godot: `Godot`, `Godot Engine`, `Godot 4.7`. */
const WINDOWS_FOLDER = /^godot/i;
/** Steam under Program Files (x86), its list of library folders, and Godot's folder in a library. */
const STEAM = "Steam";
const STEAM_LIBRARIES = ["steamapps", "libraryfolders.vdf"];
const STEAM_GODOT = ["steamapps", "common", "Godot Engine"];
/** A library's folder in `libraryfolders.vdf`: `"path"  "D:\\SteamLibrary"`, its backslashes doubled. */
const STEAM_LIBRARY_PATH = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
/** The most Steam libraries looked in. */
const MAX_STEAM_LIBRARIES = 16;
/** The names Godot goes by on Windows's PATH. */
const WINDOWS_PATH_NAMES = ["godot.exe", "godot4.exe"];
/** Where Godot keeps the person's data under their home: a Mac's, and Windows's when `APPDATA` names none. */
const MAC_DATA_HOME = ["Library", "Application Support"];
const WINDOWS_DATA_HOME = ["AppData", "Roaming"];
/** Windows's Program Files when its environment names none. */
const PROGRAM_FILES = "C:\\Program Files";
/** Godot's version line: `4.6.1.stable.official.14d19694e`, `4.3.stable.mono.official.77dcf97d8`. */
const VERSION_LINE = /^(\d+)\.(\d+)(?:\.(\d+))?\.([a-z]+\d*)\b(.*)$/;

/** Godot's version as it says it: the numbers, its status (`stable`, `rc2`…) and whether it is the .NET build. */
export type GodotVersion = { major: number; minor: number; patch: number; status: string; mono: boolean; text: string };

/** One Godot found: the binary Genex runs (its real path), its app bundle if any, and its version. */
export type GodotInstall = { binary: string; app: string | null; version: GodotVersion; supported: boolean };

/** Where this computer's Godot stands for making a game. Never rename a value. */
export const GodotReadiness = {
  Ready: "ready",
  OlderOnly: "older-only",
  NewerOnly: "newer-only",
  None: "none",
} as const;
export type GodotReadiness = (typeof GodotReadiness)[keyof typeof GodotReadiness];

/** What finding Godot needs from the computer; tests stand in for every part. */
export type GodotEnv = {
  platform: NodeJS.Platform;
  home: string;
  /** The PATH's folders, in order. */
  pathDirs: string[];
  /** The system's Applications folder. */
  applications: string;
  /** Where package managers put a `godot` of their own. */
  binaries: string[];
  /** Windows's Program Files folders (64-bit, then 32-bit); none on a Mac. */
  programFiles: string[];
  /** Where Godot keeps the person's own data, its export templates among them: `~/Library/Application Support` on a Mac, `%APPDATA%` on Windows. */
  dataHome: string;
  /** The first line a binary prints for `--version`, or null when it doesn't answer. */
  version(binary: string): Promise<string | null>;
  /** macOS's own temporary folder for this user (`DARWIN_USER_TEMP_DIR`), where Godot writes some files whatever TMPDIR says; null when unknown. */
  userTemp(): Promise<string | null>;
};

/** Where Godot keeps the person's data: Windows's roaming application data, a Mac's Application Support. */
export function dataHomeOf(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform !== "win32") return path.join(home, ...MAC_DATA_HOME);
  const named = env.APPDATA;
  return named && path.win32.isAbsolute(named) ? named : path.join(home, ...WINDOWS_DATA_HOME);
}

/** Windows's Program Files folders as its environment names them, each a whole path, once. */
export function programFilesOf(env: NodeJS.ProcessEnv): string[] {
  const named = [env.ProgramFiles ?? PROGRAM_FILES, env["ProgramFiles(x86)"]];
  const whole = named.filter((folder): folder is string => Boolean(folder && path.win32.isAbsolute(folder)));
  return [...new Set(whole)];
}

/**
 * The computer's own: its platform, home, PATH, and each binary asked for real; or, for a
 * development test, a made-up Mac's Applications and home with no PATH or package managers
 * (`substrate/app-install.ts`).
 */
export function systemGodotEnv(): GodotEnv {
  const testMac = engineTestMac(process.env, process.platform);
  const windows = process.platform === "win32";
  const home = testMac?.home ?? os.homedir();
  return {
    platform: process.platform,
    home,
    dataHome: dataHomeOf(process.platform, home, process.env),
    pathDirs: testMac ? [] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    applications: testMac?.applications ?? SYSTEM_APPLICATIONS,
    binaries: testMac || windows ? [] : [...FIXED_BINARIES],
    programFiles: windows ? programFilesOf(process.env) : [],
    version: async (binary) => {
      const asked = { timeout: VERSION_TIMEOUT_MS, windowsHide: true };
      const { stdout } = await exec(binary, ["--version"], asked).catch(() => ({ stdout: "" }));
      return stdout.trim().split(/\r?\n/).pop()?.trim() || null;
    },
    userTemp: async () => {
      const { stdout } = await exec(GETCONF, [USER_TEMP_KEY], { timeout: VERSION_TIMEOUT_MS }).catch(() => ({
        stdout: "",
      }));
      // Its real path (`/private/var/…`): the sandbox matches real paths, and the files Godot writes there don't exist yet to resolve.
      return stdout.trim() ? realpath(stdout.trim()).catch(() => null) : null;
    },
  };
}

/** A version line read, or null when it isn't Godot's. */
export function parseVersion(line: string): GodotVersion | null {
  const found = VERSION_LINE.exec(line.trim());
  if (!found?.[1] || !found[2] || !found[4]) return null;
  return {
    major: Number(found[1]),
    minor: Number(found[2]),
    patch: Number(found[3] ?? 0),
    status: found[4],
    mono: /\.mono\b/.test(found[5] ?? ""),
    text: line.trim(),
  };
}

/** A version as people say it: `4.6.1`, `4.3`. */
export function versionName(version: Pick<GodotVersion, "major" | "minor" | "patch">): string {
  const base = `${version.major}.${version.minor}`;
  return version.patch ? `${base}.${version.patch}` : base;
}

/** Whether Genex builds with this version: 4.3 or newer in the 4 line. */
export const isSupported = (v: GodotVersion): boolean => v.major === MIN_GODOT.major && v.minor >= MIN_GODOT.minor;

/** Newest first; a stable build before a preview of the same numbers. */
function newestFirst(a: GodotInstall, b: GodotInstall): number {
  const [x, y] = [a.version, b.version];
  const byNumbers = y.major - x.major || y.minor - x.minor || y.patch - x.patch;
  if (byNumbers) return byNumbers;
  return Number(y.status === "stable") - Number(x.status === "stable");
}

const entries = (folder: string) => readdir(folder).catch(() => [] as string[]);

/** The app bundles in a folder whose names start with Godot. */
async function appsIn(folder: string): Promise<string[]> {
  return (await entries(folder)).filter((name) => GODOT_APP.test(name)).map((name) => path.join(folder, name));
}

/** Every place a Godot binary may be on a Mac, as each would be run, with its app bundle. */
async function macCandidates(env: GodotEnv): Promise<Array<{ binary: string; app: string | null }>> {
  const steam = path.join(env.home, "Library", "Application Support", "Steam", "steamapps", "common", "Godot Engine");
  const folders = [env.applications, ...["Applications", "Downloads"].map((f) => path.join(env.home, f)), steam];
  const apps = (await Promise.all(folders.map(appsIn))).flat();
  const onPath = env.pathDirs.flatMap((dir) => PATH_NAMES.map((name) => path.join(dir, name)));
  return [
    ...apps.map((app) => ({ binary: path.join(app, ...APP_BINARY), app })),
    ...[...env.binaries, ...onPath].map((binary) => ({ binary, app: null })),
  ];
}

/** The Godot executables in a Windows folder, the console wrapper beside each left out. */
async function windowsExesIn(folder: string): Promise<string[]> {
  const names = (await entries(folder)).filter((name) => WINDOWS_EXE.test(name) && !CONSOLE_EXE.test(name));
  return names.map((name) => path.join(folder, name));
}

/** Steam's library folders: its own, under Program Files, and each other its `libraryfolders.vdf` names (`D:\\SteamLibrary`). */
async function steamLibraries(programFiles: string): Promise<string[]> {
  const steam = path.join(programFiles, STEAM);
  const listed = await readFile(path.join(steam, ...STEAM_LIBRARIES), "utf8").catch(() => "");
  const named = [...listed.matchAll(STEAM_LIBRARY_PATH)].map((found) => (found[1] ?? "").replace(/\\(.)/g, "$1"));
  return [...new Set([steam, ...named.filter((folder) => path.isAbsolute(folder))])].slice(0, MAX_STEAM_LIBRARIES);
}

/** Every Godot in Program Files: in each folder whose name starts with Godot, and in each Steam library. */
async function programFilesGodots(programFiles: string): Promise<string[]> {
  const folders = (await entries(programFiles)).filter((name) => WINDOWS_FOLDER.test(name));
  const steam = (await steamLibraries(programFiles)).map((library) => path.join(library, ...STEAM_GODOT));
  const found = await Promise.all(
    [...folders.map((name) => path.join(programFiles, name)), ...steam].map(windowsExesIn),
  );
  return found.flat();
}

/** Every place a Godot may be on Windows, as each would be run: Genex's own first, then Program Files and the PATH. */
async function windowsCandidates(env: GodotEnv, own: readonly string[]) {
  const programs = (await Promise.all(env.programFiles.map(programFilesGodots))).flat();
  const onPath = env.pathDirs.flatMap((dir) => WINDOWS_PATH_NAMES.map((name) => path.join(dir, name)));
  return [...own, ...programs, ...onPath].map((binary) => ({ binary, app: null }));
}

/**
 * Whether Genex's sandbox can run an install: on Windows, Genex's own or one outside the person's
 * profile (the sandbox user reads Program Files, never the profile unless granted at its start).
 */
function sandboxReads(env: GodotEnv, install: GodotInstall, own: ReadonlySet<string>): boolean {
  if (env.platform !== "win32" || own.has(install.binary)) return true;
  return !isInside(env.home, install.binary);
}

/** A candidate that is a file Godot answers for, by its real path; null otherwise. */
async function asInstall(
  env: GodotEnv,
  candidate: { binary: string; app: string | null },
): Promise<GodotInstall | null> {
  const real = await realpath(candidate.binary).catch(() => null);
  if (!real || !(await stat(real).catch(() => null))?.isFile()) return null;
  const line = await env.version(real);
  const version = line ? parseVersion(line) : null;
  if (!version) return null;
  return { binary: real, app: candidate.app ?? appOf(real), version, supported: isSupported(version) };
}

/** The app bundle a binary sits in (Homebrew's `godot` links into one), else null. */
function appOf(binary: string): string | null {
  const end = binary.indexOf(".app/");
  return end < 0 ? null : binary.slice(0, end + 4);
}

/** Where to look on this computer: a Mac's places, Windows's (with Genex's own install), else nowhere. */
async function candidatesOf(env: GodotEnv, own: readonly string[]) {
  if (env.platform === "darwin") return macCandidates(env);
  if (env.platform === "win32") return windowsCandidates(env, own);
  return [];
}

/**
 * Every Godot on this computer Genex can build with, newest first, each once. `own` names Genex's
 * own install on Windows (the host's pinned runtime), which counts though it is in the profile.
 */
export async function findGodots(env: GodotEnv, own: readonly string[] = []): Promise<GodotInstall[]> {
  const found = await Promise.all((await candidatesOf(env, own)).map((c) => asInstall(env, c)));
  const ownReal = new Set(await Promise.all(own.map((binary) => realpath(binary).catch(() => binary))));
  const unique = new Map<string, GodotInstall>();
  for (const install of found) {
    const fresh = install && !unique.has(install.binary) && sandboxReads(env, install, ownReal);
    if (fresh) unique.set(install.binary, install);
  }
  return [...unique.values()].sort(newestFirst);
}

/** The Godot Genex uses: the newest supported one, or undefined. */
export const usableGodot = (installs: readonly GodotInstall[]): GodotInstall | undefined =>
  installs.find((install) => install.supported);

/** Where this computer's Godot stands, and the version that decided it. */
export function godotReadiness(installs: readonly GodotInstall[]): {
  readiness: GodotReadiness;
  version: string | null;
} {
  const usable = usableGodot(installs);
  if (usable) return { readiness: GodotReadiness.Ready, version: versionName(usable.version) };
  const newest = installs[0];
  if (!newest) return { readiness: GodotReadiness.None, version: null };
  const newer = newest.version.major > MIN_GODOT.major;
  return {
    readiness: newer ? GodotReadiness.NewerOnly : GodotReadiness.OlderOnly,
    version: versionName(newest.version),
  };
}
