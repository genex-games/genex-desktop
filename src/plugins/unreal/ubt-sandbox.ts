/**
 * The macOS sandbox UnrealBuildTool runs in when check-part compiles a builder's copy of a game
 * (Seatbelt, through `sandbox-exec`). A builder writes the copy's C++, and UBT compiles it and runs
 * the copy's C# rules, so the build reads nothing in the user's home folder but the copy, the
 * engine, Xcode and UBT's own per-user folders; writes only the copy's build output, UBT's log
 * folder and a private scratch folder; never touches a coding CLI's sign-in home, wherever it
 * lives; has no network; sends no Apple Events (no scripting another app or typing into it with
 * Genex's grants); and starts with none of Genex's environment. A host project's build also
 * writes its plugins' build output (`Plugins/<Name>/Intermediate`, `Binaries`), nothing else of theirs,
 * and a plugin's package writes its own folder (`extraWrites`). UBT finds its per-user
 * folders from the account, not from HOME, so they are named here; its configuration there is
 * read only, so a build can't plant settings for the user's own builds. A sandboxed full build
 * takes as long as an unconfined one.
 */
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { credentialHomes } from "../../substrate/credential-homes.ts";

/** macOS's sandbox runner. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** What a confined build is started with: its profile, its whole environment and its folder. */
export type BuildSandbox = { profile: string; env: Record<string, string>; cwd: string };

/** One build's sandbox, removed with everything in its scratch folder by `dispose`. */
export type PreparedBuildSandbox = BuildSandbox & { dispose(): Promise<void> };

/** What a build of one project may reach. */
export type BuildSandboxRequest = {
  /** The project's folder (the copy's `unreal/`): read; only its build output is written. */
  projectDir: string;
  engineDir: string;
  /** The Xcode app the build uses: read. */
  xcodeApp: string | null;
  /** The user's home folder; nothing in it is read but what is named here. */
  home?: string;
  /** Folders never read or written: the coding CLIs' sign-in homes unless a test names others. */
  denied?: string[];
  /**
   * The project's own plugins the build compiles (`Plugins/<Name>`): each a real folder inside the
   * project, of which only its build output (`Intermediate`, `Binaries`) is written.
   */
  pluginDirs?: string[];
  /** Further folders the build writes (BuildPlugin's package folder): each a real folder inside the project. */
  extraWrites?: string[];
};

/** The folders of a project UBT writes: its build output. */
const PROJECT_OUTPUT = ["Intermediate", "Binaries", "Saved"];
/** The folders of a project plugin UBT writes: its build output. */
const PLUGIN_OUTPUT = ["Intermediate", "Binaries"];
const APP_SUPPORT = ["Library", "Application Support"];
const EPIC = [...APP_SUPPORT, "Epic"];
/** UBT's own folder in the home folder: its log and trace, written on every build. */
const UBT_LOG = [...EPIC, "UnrealBuildTool"];
/** UBT's per-user configuration and the engine's per-user build settings: read, never written. */
const UBT_SETTINGS = [
  [...APP_SUPPORT, "Unreal Engine", "UnrealBuildTool"],
  [...EPIC, "UnrealEngine", "Intermediate"],
];
/** .NET keeps its named mutexes (UBT's configuration lock) here, whatever TMPDIR says. */
const DOTNET_SHARED = "/private/tmp/.dotnet";
const DEVICES = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"];
/**
 * Services a build never needs that act outside it: opening apps, Apple Events (another app's
 * scripting, System Events' keystrokes), the pasteboard, the screen and the Dock.
 */
const OUTSIDE_SERVICES = [
  "com.apple.lsd.open",
  "com.apple.coreservices.appleevents",
  "com.apple.pasteboard.1",
  "com.apple.pbs.fetch_services",
  "com.apple.dock.server",
  "com.apple.ScreenCapture",
];
/** The reads denied by folder. A path's metadata stays readable: looking a path up needs it. */
const READ = "file-read-data file-read-xattr";
const WRITE = "file-write*";
const SCRATCH_PREFIX = "genex-ubt-";
const PROFILE_FILE = "ubt.sb";
const SCRATCH_HOME = "home";
const SCRATCH_TMP = "tmp";
/** The environment's fixed part: the system's programs and a language. */
const BUILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const BUILD_LANG = "en_US.UTF-8";
/** Characters a sandbox profile's string can't hold as they are. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const UNQUOTABLE = /[\x00-\x1f"\\]/;

const MESSAGE = {
  NotAbsolute: (what: string) => `The ${what} folder isn't a full path.`,
  HoldsHome: (what: string) => `The ${what} folder holds the home folder, so it can't be confined.`,
  Unquotable: (what: string) => `The ${what} folder's path has a character the sandbox can't name.`,
  NotInProject: "A plugin folder the build writes to isn't a real folder inside the project.",
  WriteNotInProject: "A folder the build writes to isn't a real folder inside the project.",
} as const;

/** The paths of one build's profile, each spelled as the kernel resolves it. */
type ProfilePaths = {
  home: string;
  reads: string[];
  writes: string[];
  createOnly: string[];
  denied: string[];
};

const quote = (value: string) => `"${value}"`;
const subpaths = (values: readonly string[]) => values.map((v) => `(subpath ${quote(v)})`).join(" ");
const literals = (values: readonly string[]) => values.map((v) => `(literal ${quote(v)})`).join(" ");

/**
 * The Seatbelt profile: everything a process may do by default, then the home folder's contents
 * closed, the named folders opened, every write refused but the named ones, the sign-in homes
 * closed again whatever was opened, signals only within the build, no network, and no Apple Events:
 * a build's rules can't script another app, or type into one through System Events, with the grants
 * Genex holds.
 */
export function buildSandboxProfile(p: ProfilePaths): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny appleevent-send)",
    `(deny mach-lookup ${OUTSIDE_SERVICES.map((n) => `(global-name ${quote(n)})`).join(" ")})`,
    "(deny signal)",
    "(allow signal (target self) (target children) (target pgrp))",
    `(deny ${READ} (subpath ${quote(p.home)}))`,
    `(allow ${READ} ${subpaths(p.reads)} ${literals([path.join(p.home, ...APP_SUPPORT)])})`,
    `(deny ${WRITE})`,
    `(allow ${WRITE} ${subpaths(p.writes)} ${literals([...p.createOnly, ...DEVICES])})`,
    ...(p.denied.length ? [`(deny ${READ} ${subpaths(p.denied)})`, `(deny ${WRITE} ${subpaths(p.denied)})`] : []),
  ].join("\n");
}

/** A folder by both spellings the kernel may see (macOS's /tmp and /var lead to /private). */
async function spellings(folder: string): Promise<string[]> {
  const real = await realpath(folder).catch(() => folder);
  return [...new Set([path.resolve(folder), real])];
}

/** Whether `inner` is `outer` or inside it. */
const within = (outer: string, inner: string) =>
  inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

/** Refuses a folder that isn't a full path, holds the home folder or can't be named in a profile. */
async function confinable(what: string, folder: string, home: string): Promise<string[]> {
  if (!path.isAbsolute(folder)) throw new Error(MESSAGE.NotAbsolute(what));
  if (UNQUOTABLE.test(folder)) throw new Error(MESSAGE.Unquotable(what));
  const names = await spellings(folder);
  if (names.some((name) => within(name, home))) throw new Error(MESSAGE.HoldsHome(what));
  return names;
}

/** A folder by its real path: absolute, nameable in a profile, a folder and not a link; else null. */
async function realFolder(dir: string): Promise<string | null> {
  if (!path.isAbsolute(dir) || UNQUOTABLE.test(dir)) return null;
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) return null;
  return realpath(dir).catch(() => null);
}

/**
 * The build output folders of the project's plugins (`PLUGIN_OUTPUT`): each plugin folder must be a
 * real folder, not a link, strictly inside the project's real folder; else the sandbox is refused.
 */
async function pluginOutputs(projectDir: string, pluginDirs: readonly string[]): Promise<string[]> {
  if (pluginDirs.length === 0) return [];
  const project = await realpath(projectDir);
  const outputs: string[] = [];
  for (const dir of pluginDirs) {
    const real = await realFolder(dir);
    if (real === null || real === project || !within(project, real)) throw new Error(MESSAGE.NotInProject);
    outputs.push(...PLUGIN_OUTPUT.map((name) => path.join(real, name)));
  }
  return outputs;
}

/** The further folders a build writes, by their real paths: each a real folder strictly inside the project, else refused. */
async function extraOutputs(projectDir: string, dirs: readonly string[]): Promise<string[]> {
  if (dirs.length === 0) return [];
  const project = await realpath(projectDir);
  const outputs: string[] = [];
  for (const dir of dirs) {
    const real = await realFolder(dir);
    if (real === null || real === project || !within(project, real)) throw new Error(MESSAGE.WriteNotInProject);
    outputs.push(real);
  }
  return outputs;
}

/** The profile's paths for `request`, with the build's scratch folder. */
async function profilePaths(request: BuildSandboxRequest, scratch: string): Promise<ProfilePaths> {
  const home = await realpath(request.home ?? os.homedir());
  const project = await confinable("project", request.projectDir, home);
  const engine = await confinable("engine", request.engineDir, home);
  const xcode = request.xcodeApp ? await confinable("Xcode", request.xcodeApp, home) : [];
  const inHome = (parts: readonly string[]) => path.join(home, ...parts);
  const plugins = await pluginOutputs(request.projectDir, request.pluginDirs ?? []);
  const extra = await extraOutputs(request.projectDir, request.extraWrites ?? []);
  const output = [
    ...project.flatMap((folder) => PROJECT_OUTPUT.map((name) => path.join(folder, name))),
    ...plugins,
    ...extra,
  ];
  const denied = (request.denied ?? credentialHomes([], process.env, home)).filter((d) => !UNQUOTABLE.test(d));
  return {
    home,
    reads: [...project, ...engine, ...xcode, scratch, inHome(UBT_LOG), ...UBT_SETTINGS.map(inHome)],
    writes: [...output, scratch, inHome(UBT_LOG), ...(await spellings(DOTNET_SHARED))],
    // A first build makes Epic/ for UBT's log folder: the folder itself, nothing in it.
    createOnly: [inHome(EPIC)],
    denied: (await Promise.all(denied.map(spellings))).flat(),
  };
}

/**
 * A sandbox for one build of `request.projectDir`: its profile and a private HOME and TMPDIR in a
 * fresh scratch folder. Throws, leaving nothing behind, for a folder it can't confine.
 */
export async function prepareBuildSandbox(request: BuildSandboxRequest): Promise<PreparedBuildSandbox> {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX)));
  const dispose = () => rm(scratch, { recursive: true, force: true });
  try {
    const paths = await profilePaths(request, scratch);
    const home = path.join(scratch, SCRATCH_HOME);
    const tmp = path.join(scratch, SCRATCH_TMP);
    await mkdir(path.join(home, ...APP_SUPPORT), { recursive: true });
    await mkdir(tmp);
    const profile = path.join(scratch, PROFILE_FILE);
    await writeFile(profile, buildSandboxProfile(paths));
    const env = { HOME: home, TMPDIR: `${tmp}/`, PATH: BUILD_PATH, LANG: BUILD_LANG };
    return { profile, env, cwd: scratch, dispose };
  } catch (failure) {
    await dispose();
    throw failure;
  }
}
