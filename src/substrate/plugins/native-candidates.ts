/**
 * Where a native runtime's declared candidates point on this computer (`nativeRuntimes[].candidates`,
 * checked by `native-manifest.ts`). A candidate is an absolute POSIX path, a path under a folder
 * Genex knows (`home:`, `studio:`, `storage:`, and on Windows `programfiles:`, `programfilesx86:`,
 * `localappdata:`), a path beside the program Windows opens a file type with (`opens:.blend/…`),
 * a path inside a Microsoft Store package whose name starts so (`package:<name>/…`), or the file
 * the person chose in a string setting (`setting:<key>`). One segment may be a `*` pattern
 * (the segment `Blender *` matches `Blender 5.2`), every match tried newest name first.
 *
 * Nothing here runs a candidate: `native.ts` probes each path it answers. The lookups (folders,
 * the registry) are dependencies, so the rules are tested on any platform.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { StudioPlatform } from "../../shared/boot.ts";

const run = promisify(execFile);

/** How long one `reg query` may take. */
const REGISTRY_TIMEOUT_MS = 5 * SECOND_MS;
/** A registry listing of every installed Store package is long on a busy PC. */
const REGISTRY_MAX_BUFFER = 4 * 1024 ** 2;
/** Where Windows records each Store package installed for this user, with its `PackageRootFolder`. */
const STORE_PACKAGES =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
const PACKAGE_ROOT_VALUE = "PackageRootFolder";
/** A string value in `reg query` output: its name, type and data. */
const REGISTRY_VALUE = /^\s+(.*?)\s{4}(REG_SZ|REG_EXPAND_SZ)\s{4}(.*)$/;
/** `%NAME%` in a REG_EXPAND_SZ value. */
const ENV_REFERENCE = /%([^%]+)%/g;
/**
 * A path on one of this computer's drives (`C:\…`). A network share (`\\server\share`) or a device
 * path (`\\?\`, `\\.\`) is never a candidate: probing one would reach the network, or past the checks.
 */
const LOCAL_WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
/** The wildcard one candidate segment may hold. */
const WILDCARD = "*";

/** Every alias a candidate may start with, in its manifest spelling. */
export const CandidateRoot = {
  Home: "home",
  Studio: "studio",
  Storage: "storage",
  ProgramFiles: "programfiles",
  ProgramFilesX86: "programfilesx86",
  LocalAppData: "localappdata",
  Opens: "opens",
  Package: "package",
  Setting: "setting",
} as const;
export type CandidateRoot = (typeof CandidateRoot)[keyof typeof CandidateRoot];

/** The Windows folder each folder alias stands for, by its environment variable. */
const WINDOWS_FOLDERS: Partial<Record<CandidateRoot, string>> = {
  [CandidateRoot.ProgramFiles]: "ProgramFiles",
  [CandidateRoot.ProgramFilesX86]: "ProgramFiles(x86)",
  [CandidateRoot.LocalAppData]: "LOCALAPPDATA",
};

/** What resolving a candidate reads: this computer's folders, the registry and the plugin's settings. */
export interface CandidateDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** Genex's data folder (`studio:`). */
  studio: string;
  /** The plugin's storage (`storage:`). */
  storage: string;
  /** The plugin's settings, for `setting:` candidates. */
  settings: Record<string, unknown>;
  /** The names in a folder; empty when it cannot be read. */
  list(dir: string): Promise<string[]>;
  /** `reg query` of a key (its default value, or the value named), or of its subkeys; null or empty when absent. */
  registryValue(key: string, value?: string): Promise<string | null>;
  registryKeys(key: string): Promise<string[]>;
}

/** The string data of a value in `reg query` output; `%VAR%` references expanded from `env`. */
export function registryData(stdout: string, env: Record<string, string | undefined> = process.env): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = REGISTRY_VALUE.exec(line);
    if (!match) continue;
    const data = (match[3] ?? "").trim();
    if (match[2] !== "REG_EXPAND_SZ") return data;
    return data.replace(ENV_REFERENCE, (whole, name: string) => envValue(env, name) ?? whole);
  }
  return null;
}

/** An environment variable by its name in any case, as Windows looks them up. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * The program a shell `open` command starts: the quoted first token, or everything up to the first
 * `.exe` (`C:\Program Files\Blender Foundation\Blender 5.2\blender-launcher.exe "%1"`).
 */
export function commandProgram(command: string): string | null {
  const text = command.trim();
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end > 1 ? text.slice(1, end) : null;
  }
  const exe = text.toLowerCase().indexOf(".exe");
  return exe > 0 ? text.slice(0, exe + 4) : null;
}

/** Names compared as people number versions: `Blender 10.0` after `Blender 9.1`. */
const newestFirst = (a: string, b: string) => b.localeCompare(a, "en", { numeric: true, sensitivity: "base" });

/** `*` in one segment as a whole-name pattern: anything in its place, case-blind on Windows. */
function segmentPattern(segment: string, platform: NodeJS.Platform): RegExp {
  const [before = "", after = ""] = segment.split(WILDCARD).map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${before}.*${after}$`, platform === StudioPlatform.Windows ? "i" : "");
}

/** `base` joined with `relative`; a `*` segment becomes each matching name in that folder, newest first. */
async function expand(base: string, relative: string, deps: CandidateDeps): Promise<string[]> {
  const join = deps.platform === StudioPlatform.Windows ? path.win32.join : path.posix.join;
  const segments = relative.split("/");
  const at = segments.findIndex((segment) => segment.includes(WILDCARD));
  if (at < 0) return [join(base, ...segments)];
  const parent = join(base, ...segments.slice(0, at));
  const pattern = segmentPattern(segments[at] ?? "", deps.platform);
  const names = (await deps.list(parent)).filter((name) => pattern.test(name)).sort(newestFirst);
  return names.map((name) => join(parent, name, ...segments.slice(at + 1)));
}

/** The folder the program Windows opens `fileType` with lives in, from the registry. */
async function opensFolder(fileType: string, deps: CandidateDeps): Promise<string | null> {
  const progId = await deps.registryValue(`HKCR\\${fileType}`);
  if (!progId) return null;
  const command = await deps.registryValue(`HKCR\\${progId}\\shell\\open\\command`);
  const program = command ? commandProgram(command) : null;
  return program && LOCAL_WINDOWS_PATH.test(program) ? path.win32.dirname(program) : null;
}

/** The folders of this user's Store packages whose full name starts with `name`, newest first. */
async function packageFolders(name: string, deps: CandidateDeps): Promise<string[]> {
  const keys = (await deps.registryKeys(STORE_PACKAGES))
    .filter((key) => path.win32.basename(key).toLowerCase().startsWith(name.toLowerCase()))
    .sort((a, b) => newestFirst(path.win32.basename(a), path.win32.basename(b)));
  const folders: string[] = [];
  for (const key of keys) {
    const folder = await deps.registryValue(key, PACKAGE_ROOT_VALUE);
    if (folder && LOCAL_WINDOWS_PATH.test(folder)) folders.push(folder);
  }
  return folders;
}

/** The folder a plain alias stands for here, or null when it means nothing on this computer. */
function aliasFolder(root: string, deps: CandidateDeps): string | null {
  if (root === CandidateRoot.Home) return deps.home;
  if (root === CandidateRoot.Studio) return deps.studio;
  if (root === CandidateRoot.Storage) return deps.storage;
  const variable = WINDOWS_FOLDERS[root as CandidateRoot];
  if (!variable || deps.platform !== StudioPlatform.Windows) return null;
  return envValue(deps.env, variable) ?? null;
}

/** The person's chosen file in the `setting:` candidate's setting, when it is an absolute path on this computer's own disk. */
function settingPath(key: string, deps: CandidateDeps): string[] {
  const value = deps.settings[key];
  if (typeof value !== "string" || !value.trim()) return [];
  const chosen = value.trim();
  const absolute = deps.platform === StudioPlatform.Windows ? LOCAL_WINDOWS_PATH.test(chosen) : chosen.startsWith("/");
  return absolute ? [chosen] : [];
}

/** Every path `candidate` stands for on this computer, in the order to try them; none when it means nothing here. */
export async function candidatePaths(candidate: string, deps: CandidateDeps): Promise<string[]> {
  const windows = deps.platform === StudioPlatform.Windows;
  if (candidate.startsWith("/")) return windows ? [] : expand("/", candidate.slice(1), deps);
  const colon = candidate.indexOf(":");
  const root = candidate.slice(0, colon),
    rest = candidate.slice(colon + 1);
  if (root === CandidateRoot.Setting) return settingPath(rest, deps);
  if (root === CandidateRoot.Opens || root === CandidateRoot.Package) {
    if (!windows) return [];
    const [anchor = "", ...segments] = rest.split("/");
    const folders =
      root === CandidateRoot.Opens
        ? [await opensFolder(anchor, deps)].filter((f): f is string => f !== null)
        : await packageFolders(anchor, deps);
    return (await Promise.all(folders.map((folder) => expand(folder, segments.join("/"), deps)))).flat();
  }
  const folder = aliasFolder(root, deps);
  return folder ? expand(folder, rest, deps) : [];
}

/** `reg query` on this computer; null or empty when the key or value is absent (or this is not Windows). */
async function regQuery(args: string[]): Promise<string | null> {
  const result = await run("reg", ["query", ...args], {
    timeout: REGISTRY_TIMEOUT_MS,
    maxBuffer: REGISTRY_MAX_BUFFER,
    windowsHide: true,
  }).catch(() => null);
  return result?.stdout ?? null;
}

/** This computer's folders and registry, and the plugin's own folders and settings. */
export function hostCandidateDeps(owner: Pick<CandidateDeps, "studio" | "storage" | "settings">): CandidateDeps {
  return {
    ...owner,
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    list: (dir) => readdir(dir).catch(() => []),
    registryValue: async (key, value) => {
      const stdout = await regQuery(value ? [key, "/v", value] : [key, "/ve"]);
      return stdout ? registryData(stdout) : null;
    },
    registryKeys: async (key) => {
      const stdout = await regQuery([key]);
      const self = expandHive(key).toLowerCase();
      return (stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("HKEY_") && line.toLowerCase() !== self);
    },
  };
}

/** A key's hive spelled out as `reg query` prints it (`HKCU` → `HKEY_CURRENT_USER`). */
function expandHive(key: string): string {
  return key.replace(/^HKCU\b/, "HKEY_CURRENT_USER").replace(/^HKCR\b/, "HKEY_CLASSES_ROOT");
}
