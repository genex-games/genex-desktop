/**
 * The Windows side of `ProcessSandbox` (plan phase 3, W2): sandbox-runtime's Windows backend
 * (srt-win) with Git Bash as the sandbox's shell.
 *
 * How it differs from macOS, and what this module does about it:
 *  - File grants are NTFS ACL entries for the `srt-sandbox` user, applied at `initialize()` for
 *    the whole process; a per-command grant throws. One {@link WindowsSandboxSession} holds the
 *    union of every `ProcessSandbox`'s grants and re-applies it (`reset()` + `initialize()`)
 *    only while no sandboxed command runs, batching every change that queued meanwhile.
 *  - The sandbox user reads nothing in the real user's profile unless granted. Node's realpath
 *    walk and Git stat every directory above a granted folder, so each directory between the
 *    profile and a grant root gets FILE_READ_ATTRIBUTES (no inheritance, no listing) as well;
 *    the directories are recorded so the grant can be taken back ({@link ancestorGrants}). Each
 *    grant is set on its folder alone (`windows-folder-ace.ts`): `icacls` walked everything under it.
 *    They are granted after srt-win initializes, every time: its deny stamp puts a deny on each
 *    denied path's parent that replaces the sandbox user's entry there (userData, the parent of
 *    the secrets folder, lost its grant that way), and its reset removes that entry.
 *  - A deny on a path that exists is Genex's own ({@link ownDenyStamps}): srt-win's stamp
 *    re-propagates permissions through everything under each denied path's parent, which for
 *    `~\.ssh` is the whole profile and for a game's `.claude` the whole game.
 *  - The environment given to `spawn()` never reaches the child: it starts with the sandbox
 *    user's own. A run's variables travel in an env file in its scratch folder that the command
 *    sources first and deletes ({@link renderEnvFile}).
 *
 * The pure helpers work on Windows paths (`path.win32`) on any platform, so they are tested
 * everywhere; only the session's defaults touch srt-win and the folders' entries.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SECOND_MS } from "../shared/duration.ts";
import { StudioPlatform, WindowsSetupNeed } from "../shared/boot.ts";
import { ROBLOX_WINDOWS_SIGN_IN_STORES } from "./credential-homes.ts";
import { errorMessage } from "../shared/errors.ts";
import {
  DenyAccess,
  editFolderAces,
  editFolderAcesSync,
  editFolderDenies,
  editFolderDeniesSync,
  type FolderAceEdit,
  type FolderAceEditor,
  type FolderAceEditorSync,
  FolderAceOp,
  type FolderDenyEdit,
  type FolderDenyEditor,
  type FolderDenyEditorSync,
} from "./windows-folder-ace.ts";
import { logonServiceStartType, ServiceStartType } from "./windows-logon-service.ts";

const win = path.win32;
const run = promisify(execFile);

/** How long one `reg` or `git` call may take. */
const TOOL_TIMEOUT_MS = 15 * SECOND_MS;
/** How a `reg` or `git` lookup runs: under its deadline, with no console window of its own. */
const TOOL_RUN = { timeout: TOOL_TIMEOUT_MS, windowsHide: true } as const;
/**
 * How often `initialize` is tried when srt-win's egress check times out. That check runs 17-23 s
 * against a 30 s limit on a hosted runner, so a busy machine can miss it once.
 */
const INITIALIZE_ATTEMPTS = 3;
/** sandbox-runtime's code for an srt-win call that ran out of time. */
const SRT_WIN_TIMEOUT = "srt_win_timeout";
/** The srt-win subcommands sandbox-runtime names on its errors (the first CLI argument). */
const SrtWinSubcommand = { Wfp: "wfp" } as const;
/** The registry key Git for Windows records its install folder under. */
const GIT_REGISTRY_KEY = "HKLM\\SOFTWARE\\GitForWindows";
const GIT_REGISTRY_VALUE = "InstallPath";
/** Git Bash inside a Git for Windows install. */
const GIT_BASH = ["bin", "bash.exe"] as const;
/**
 * The folder in a packaged Windows app's resources that holds Genex's own Git for Windows
 * (`scripts/package-git.cjs` copies it there; `scripts/vendor-git-for-windows.ts` makes it).
 */
export const BUNDLED_GIT_DIR = "git";
/** `git --exec-path` is `<root>/<mingw64|clangarm64>/libexec/git-core`: three levels below the root. */
const EXEC_PATH_DEPTH = 3;
/** A path on a drive letter, as Git for Windows reports its own folders. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/**
 * How often an ancestor grant is tried, and the wait between tries, while another process edits
 * the same folder's entries.
 */
const GRANT_ATTEMPTS = 3;
const GRANT_RETRY_MS = 1 * SECOND_MS;
/** Asks of `srt-win user status` for the sandbox user's SID, once it is set up, before giving up. */
const SID_ATTEMPTS = 3;
const SID_RETRY_MS = 1 * SECOND_MS;
/** A shell variable name the env file may assign. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * PATH folders under the profile that are never granted: the Store's app-execution aliases
 * refuse extra ACL entries, and a failed grant would fail the whole session.
 */
const UNGRANTABLE_TOOL_DIRS = [["AppData", "Local", "Microsoft", "WindowsApps"]] as const;
/**
 * Variables that stay the sandbox user's own: its profile, its home and srt's proxy plumbing.
 * The caller may still set one of them explicitly; a value inherited from the studio never wins.
 */
const SANDBOX_OWNED = new Set([
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATHEXT",
  "SYSTEMROOT",
  "PATH",
]);
/** What every sandboxed Windows command starts with, whatever the caller passed. */
const FIXED_ENV = {
  // Git never waits for a password nobody can type.
  GIT_TERMINAL_PROMPT: "0",
  // Node's fetch goes through srt's proxy like curl and git do.
  NODE_USE_ENV_PROXY: "1",
  // Windows paths reach native programs unchanged.
  MSYS_NO_PATHCONV: "1",
} as const;
/** curl's schannel revocation check cannot reach its CRL servers through the proxy. */
const CURLRC = "ssl-revoke-best-effort\n";

const MESSAGE = {
  BadEnvName: (name: string) => `refusing to write the environment variable ${JSON.stringify(name)}`,
  AncestorGrant: (dir: string, error: unknown) =>
    `could not let the sandbox user see the folder ${dir}: ${errorMessage(error)}`,
  OwnDeny: (dir: string, error: unknown) => `could not deny the sandbox user ${dir}: ${errorMessage(error)}`,
  /** srt-win's stamp walks each denied path's parent again, so a later stamp timeout reads as this. */
  OwnDeniesOff: (count: number) =>
    `own denies off: srt-win stamps all ${count} denies (no sandbox users' group, or PowerShell could not set them)`,
  LauncherNotGranted: (why: string) => `launcher folders not granted: ${why}`,
  NoLauncherSid: "srt-win did not say the sandbox user's id",
  NoAnswer: "no answer for this folder",
  NoSandboxSid: "could not read the sandbox user's id from srt-win, so the folders above its grants stay closed to it",
  NoMembers: "the Windows sandbox session has no members",
  UserNotSetUp: (user: boolean, cred: boolean) => `Sandbox user is not provisioned (user=${user}, cred=${cred}).`,
  FiltersNotSetUp: "WFP filters are not installed for the sandbox user.",
  LogonServiceDisabled:
    "The Secondary Logon service (seclogon) is disabled, so Windows refuses to start commands as the sandbox user.",
} as const;

/** Folders the sandbox user may write and read, for the whole session. */
export interface WindowsGrants {
  write: string[];
  read: string[];
}

/** A Windows path's identity: resolved and case-folded, as NTFS compares names. */
function pathKey(p: string): string {
  return win.resolve(p).toLowerCase();
}

/** Is `target` `root` itself or inside it, by Windows path rules? */
export function insideWindowsPath(root: string, target: string): boolean {
  const rootKey = pathKey(root);
  const targetKey = pathKey(target);
  const prefix = rootKey.endsWith("\\") ? rootKey : `${rootKey}\\`;
  return targetKey === rootKey || targetKey.startsWith(prefix);
}

/** `paths` without duplicates and without any folder already inside another one or inside `covered`. */
function outermost(paths: readonly string[], covered: readonly string[]): string[] {
  const unique = [...new Map(paths.map((p) => [pathKey(p), win.resolve(p)])).values()];
  unique.sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const candidate of unique) {
    const inside = [...covered, ...kept].some((root) => insideWindowsPath(root, candidate));
    if (!inside) kept.push(candidate);
  }
  return kept.sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
}

/** The union of several grant sets: nested and repeated folders collapse, a read inside a write goes. */
export function grantUnion(parts: readonly WindowsGrants[]): WindowsGrants {
  const write = outermost(
    parts.flatMap((part) => part.write),
    [],
  );
  const read = outermost(
    parts.flatMap((part) => part.read),
    write,
  );
  return { write, read };
}

/** Does `applied` already give everything `needed` asks for? A write root also grants reading. */
export function grantsCover(applied: WindowsGrants, needed: WindowsGrants): boolean {
  const readable = [...applied.write, ...applied.read];
  const writes = needed.write.every((dir) => applied.write.some((root) => insideWindowsPath(root, dir)));
  return writes && needed.read.every((dir) => readable.some((root) => insideWindowsPath(root, dir)));
}

/**
 * Every folder strictly between `profile` and a root, outermost first, for the read-attributes
 * grant. A folder that is itself a root, or inside one, is left out: the root's own inheritable
 * grant covers it, and taking the grant back later must never touch a root's entry.
 */
export function ancestorDirs(profile: string, roots: readonly string[]): string[] {
  const found = new Map<string, string>();
  for (const root of roots) {
    if (!insideWindowsPath(profile, root)) continue;
    for (let dir = win.dirname(win.resolve(root)); pathKey(dir) !== pathKey(profile); dir = win.dirname(dir)) {
      if (!insideWindowsPath(profile, dir)) break;
      found.set(pathKey(dir), dir);
    }
  }
  const covered = (dir: string) => roots.some((root) => insideWindowsPath(root, dir));
  return [...found.values()].filter((dir) => !covered(dir)).sort((a, b) => a.length - b.length);
}

/** One folder's `icacls` listing, or why there is none. */
async function icaclsListing(dir: string): Promise<string> {
  try {
    return (await run("icacls", [dir], TOOL_RUN)).stdout;
  } catch (error) {
    return `${dir}: ${errorMessage(error)}`;
  }
}

/**
 * Who may open each folder from the profile down to `paths`, as `icacls` lists it: the profile,
 * every folder between it and each path, and the paths, one line per entry. It goes in the log when
 * a sandboxed process could not walk to its files, which only a person's own PC has shown.
 */
export async function windowsAccessReport(
  profile: string,
  paths: readonly string[],
  listing: (dir: string) => Promise<string> = icaclsListing,
): Promise<string[]> {
  const dirs = [profile, ...ancestorDirs(profile, paths), ...paths];
  const lines: string[] = [];
  for (const dir of dirs) {
    lines.push(...(await listing(dir)).split(/\r?\n/).filter((line) => line.trim()));
  }
  return lines;
}

/**
 * The PATH folders under `profile` the sandbox user must read to run the toolchain (nvm, Volta,
 * Scoop, `%LOCALAPPDATA%\Programs`): existing folders only, never the profile or one of its
 * ancestors, never a folder that holds a denied path, never an ungrantable one.
 */
export function grantableToolDirs(
  entries: readonly string[],
  profile: string,
  denied: readonly string[],
  exists: (dir: string) => boolean = existsSync,
): string[] {
  const ungrantable = UNGRANTABLE_TOOL_DIRS.map((parts) => win.join(profile, ...parts));
  const grantable = (dir: string) =>
    win.isAbsolute(dir) &&
    insideWindowsPath(profile, dir) &&
    pathKey(dir) !== pathKey(profile) &&
    !denied.some((deny) => insideWindowsPath(dir, deny)) &&
    !ungrantable.some((root) => insideWindowsPath(root, dir)) &&
    exists(dir);
  return outermost(entries.filter(grantable), []);
}

/** Where a deny path is judged: the session's grant roots and the real user's profile. */
export interface DenyScope {
  roots: readonly string[];
  profile: string;
}

/**
 * The deny paths worth sending to srt-win. For a path that does not exist srt-win creates a
 * placeholder chain to stamp, which must never litter the user's profile with a `.aws` or a
 * browser folder they never had. Nothing in the profile outside a grant is readable anyway, so a
 * missing path there is dropped. Off the profile (another drive) BUILTIN\Users can usually read,
 * so a missing path there is kept, as is one a grant would cover once it appears.
 */
export function keepWindowsDenies(
  paths: readonly string[],
  scope: DenyScope,
  exists: (p: string) => boolean = existsSync,
): string[] {
  const unreadable = (p: string) =>
    insideWindowsPath(scope.profile, p) && !scope.roots.some((root) => insideWindowsPath(root, p));
  const kept = paths.filter((p) => exists(p) || !unreadable(p));
  return [...new Map(kept.map((p) => [pathKey(p), p])).values()];
}

/**
 * The write denies left once the read denies are stamped. srt-win's read deny is full access, so
 * it already forbids writing; and a path sent in both lists came out denied for writing only (the
 * Windows runner showed a secrets folder readable that way), so it goes in the read list alone.
 */
export function writeDeniesBeyondRead(denyWrite: readonly string[], denyRead: readonly string[]): string[] {
  const read = new Set(denyRead.map(pathKey));
  return denyWrite.filter((p) => !read.has(pathKey(p)));
}

/**
 * Paths no agent process may read on Windows, under `home` and the roaming and local app-data
 * folders: SSH and cloud credentials, Git and GitHub CLI tokens, the Windows credential and DPAPI
 * stores, browser profiles and Roblox's sign-ins. The coding CLIs' homes come from
 * `credentialHomes()`.
 */
export function windowsDenyRead(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".config", "gh"),
    path.join(home, ".git-credentials"),
    path.join(home, "_netrc"),
    path.join(home, ".netrc"),
    path.join(appData, "Microsoft", "Credentials"),
    path.join(appData, "Microsoft", "Protect"),
    path.join(appData, "GitHub CLI"),
    path.join(appData, "gcloud"),
    path.join(appData, "Mozilla", "Firefox", "Profiles"),
    path.join(appData, "Opera Software"),
    path.join(localAppData, "Microsoft", "Credentials"),
    path.join(localAppData, "Google", "Chrome", "User Data"),
    path.join(localAppData, "Microsoft", "Edge", "User Data"),
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    ...ROBLOX_WINDOWS_SIGN_IN_STORES.map((parts) => path.join(localAppData, ...parts)),
  ];
}

// ── environment ──────────────────────────────────────────────────────────────────────────────

/** `C:\Program Files\nodejs` as Git Bash spells it: `/c/Program Files/nodejs`. */
export function msysPath(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):(\/|$)(.*)$/.exec(slashed);
  if (!drive) return slashed;
  const [, letter = "", , rest = ""] = drive;
  return `/${letter.toLowerCase()}${rest ? `/${rest}` : ""}`.replace(/\/+$/, "") || "/";
}

/** A Windows `PATH` value (`;`-separated) as a Git Bash one (`:`-separated). */
export function msysPathList(value: string): string {
  return value
    .split(";")
    .filter((entry) => entry.trim())
    .map(msysPath)
    .join(":");
}

/** A Windows path with forward slashes, which Git Bash, Node and Git all accept: `C:/x/y`. */
export function mixedPath(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Single-quote a value for POSIX shells. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What goes into one run's env file. */
export interface EnvFileInput {
  /** Variables to export, verbatim. */
  vars: Record<string, string>;
  /** The resolved toolchain PATH in Windows form, put ahead of Git Bash's own; empty for none. */
  toolPath: string;
}

/**
 * The env file a Git Bash command sources first (`. file`): every variable exported under its
 * own single quotes, the toolchain PATH put after Git's `/usr/bin` (so the POSIX tools beat
 * `System32`'s `find` and `sort`), and Git's credential helper switched off by appending to the
 * `GIT_CONFIG_*` list srt already set (its `safe.directory` entries stay).
 */
export function renderEnvFile(input: EnvFileInput): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(input.vars)) {
    if (!ENV_NAME.test(name)) throw new Error(MESSAGE.BadEnvName(name));
    lines.push(`export ${name}=${quote(value)}`);
  }
  const tools = msysPathList(input.toolPath);
  lines.push(`export PATH=${quote(tools ? `/usr/bin:${tools}` : "/usr/bin")}":$PATH"`);
  lines.push(
    "__genex_n=${GIT_CONFIG_COUNT:-0}",
    'export "GIT_CONFIG_KEY_${__genex_n}=credential.helper" "GIT_CONFIG_VALUE_${__genex_n}="',
    "export GIT_CONFIG_COUNT=$((__genex_n + 1))",
    "unset __genex_n",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The variables a Windows run exports: the child's environment as `ProcessSandbox` built it,
 * minus what stays the sandbox user's own (unless the caller set it), with its temp folders in
 * forward-slash form, curl's config home, and the fixed Git, Node and MSYS settings.
 */
export function windowsRunEnv(input: {
  env: Record<string, string>;
  own: Record<string, string>;
  scratch: string;
  curlHome: string;
}): Record<string, string> {
  const inherited = Object.entries(input.env).filter(([name]) => !SANDBOX_OWNED.has(name.toUpperCase()));
  const tmp = mixedPath(input.scratch);
  return {
    ...Object.fromEntries(inherited),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    CURL_HOME: mixedPath(input.curlHome),
    ...FIXED_ENV,
    ...Object.fromEntries(Object.entries(input.own).filter(([name]) => name !== "PATH")),
  };
}

/** Write the curl config every run points `CURL_HOME` at; returns its folder. */
export async function writeCurlHome(scratch: string): Promise<string> {
  const dir = path.join(scratch, ".curl");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".curlrc"), CURLRC);
  return dir;
}

// ── install discovery ────────────────────────────────────────────────────────────────────────

/** A launch path without 8.3 short names (they crashed Git Credential Manager); as given when missing. */
export function longPath(p: string, platform: string = process.platform): string {
  if (platform !== StudioPlatform.Windows) return p;
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Git for Windows' install folder from `reg query` output, or null. */
export function gitRootFromRegistry(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Git for Windows' install folder from `git --exec-path`, or null. */
export function gitRootFromExecPath(execPath: string): string | null {
  const trimmed = execPath.trim();
  if (!DRIVE_PATH.test(trimmed)) return null;
  let root = win.resolve(trimmed);
  for (let level = 0; level < EXEC_PATH_DEPTH; level++) root = win.dirname(root);
  return root;
}

/**
 * Genex's own Git for Windows in a packaged app (`<resources>\git`), or null outside one: Electron
 * sets `process.resourcesPath`, plain Node does not.
 */
export function bundledGitRoot(resources: string | undefined = process.resourcesPath): string | null {
  return resources ? win.join(resources, BUNDLED_GIT_DIR) : null;
}

/**
 * Set to "1", Genex uses only its own Git, as on a PC without Git: the Windows package job runs
 * its chat turn this way, since its runner has Git installed.
 */
export const BUNDLED_GIT_ONLY_ENV = "STUDIO_WINDOWS_BUNDLED_GIT_ONLY";

/** How Git Bash is looked up; the defaults ask the registry, then `git`, then Genex's own Git. */
export interface GitBashLookup {
  /** Genex's own Git for Windows (default: {@link bundledGitRoot}). */
  bundled?: string | null;
  /** Skip an installed Git (default: {@link BUNDLED_GIT_ONLY_ENV}). */
  bundledOnly?: boolean;
  registry?: () => Promise<string>;
  execPath?: () => Promise<string>;
  exists?: (file: string) => boolean;
}

/**
 * Git Bash (`<Git>\bin\bash.exe`): an installed Git for Windows from the registry or from
 * `git --exec-path` first, so a PC with Git keeps its own (with its credential manager, which the
 * trimmed copy leaves out), then Genex's own copy in a packaged app; null when none has it.
 */
export async function findGitBash(lookup: GitBashLookup = {}): Promise<string | null> {
  const bundled = lookup.bundled === undefined ? bundledGitRoot() : lookup.bundled;
  const registry =
    lookup.registry ??
    (async () => (await run("reg", ["query", GIT_REGISTRY_KEY, "/v", GIT_REGISTRY_VALUE], TOOL_RUN)).stdout);
  const execPath = lookup.execPath ?? (async () => (await run("git", ["--exec-path"], TOOL_RUN)).stdout);
  const exists = lookup.exists ?? existsSync;
  const bundledOnly = lookup.bundledOnly ?? process.env[BUNDLED_GIT_ONLY_ENV] === "1";
  const installed = [
    () => registry().then(gitRootFromRegistry, () => null),
    () => execPath().then(gitRootFromExecPath, () => null),
  ];
  const lookups = [...(bundledOnly ? [] : installed), async () => bundled];
  for (const lookupRoot of lookups) {
    const root = await lookupRoot();
    const bash = root ? win.join(root, ...GIT_BASH) : null;
    if (bash && exists(bash)) return longPath(bash);
  }
  return null;
}

/** The Git install a Git Bash path belongs to. */
export function gitRootOf(bash: string): string {
  return win.dirname(win.dirname(bash));
}

/**
 * Make the host's own `git` (game snapshots, the harness workspace) the one {@link findGitBash}
 * chose: that Git's `cmd` folder goes first on PATH when it is not there yet, as for Genex's own
 * Git or after installing Git while Genex was open. False when there is no Git for Windows.
 */
export async function ensureHostGit(
  lookup: GitBashLookup = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const bash = await findGitBash(lookup);
  if (!bash) return false;
  const cmd = win.join(gitRootOf(bash), "cmd");
  const entries = (env.PATH ?? "").split(win.delimiter).filter(Boolean);
  const onPath = entries.some((dir) => dir.toLowerCase() === cmd.toLowerCase());
  if (!onPath) env.PATH = [cmd, ...entries].join(win.delimiter);
  return true;
}

/**
 * The vendored `srt-win.exe`, from the unpacked copy in a packaged app: Windows cannot execute a
 * file inside Electron's asar archive, and srt only ever uses the path it is given.
 */
export function srtWinPath(
  packageDir: string = path.dirname(
    createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"),
  ),
  arch: string = process.arch,
): string {
  const unpacked = packageDir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return path.join(unpacked, "vendor", "srt-win", arch, "srt-win.exe");
}

// ── ancestor read-attributes grants ──────────────────────────────────────────────────────────

/** The read-attributes grants on the folders above the session's roots. */
export interface AncestorGrants {
  /**
   * Grant exactly `dirs` (outermost first), every one of them again even when granted before, and
   * take the grant back from every other recorded one.
   */
  sync(dirs: readonly string[]): Promise<void>;
  /** Take back grants without blocking the event loop during normal release or shutdown. */
  revokeAll(): Promise<void>;
  /** Take back every recorded grant synchronously on process exit. */
  revokeAllSync(): void;
}

/** What one holder's grant record keeps: whose grants, and on which folders. */
interface GrantRecord {
  sid: string;
  dirs: string[];
}

/** A holder's record file: `<pid>.json`. */
const HOLDER_RECORD = /^(\d+)\.json$/;

function readRecord(file: string): GrantRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GrantRecord>;
    const valid = typeof parsed.sid === "string" && Array.isArray(parsed.dirs);
    return valid
      ? { sid: parsed.sid as string, dirs: (parsed.dirs as unknown[]).filter((d) => typeof d === "string") }
      : null;
  } catch {
    return null;
  }
}

/**
 * Every other holder's record in `holders`, read by `read`: `live` for processes that still run,
 * `stale` for those that are gone. A running holder's unreadable record is skipped (it may be
 * mid-write).
 */
function otherHolders<R>(
  holders: string,
  self: number,
  alive: (pid: number) => boolean,
  read: (file: string) => R | null,
) {
  const live: R[] = [];
  const stale: Array<{ file: string; record: R | null }> = [];
  const names = existsSync(holders) ? readdirSync(holders) : [];
  for (const name of names) {
    const pid = Number(HOLDER_RECORD.exec(name)?.[1] ?? Number.NaN);
    if (!Number.isInteger(pid) || pid === self) continue;
    const file = path.join(holders, name);
    const record = read(file);
    if (!alive(pid)) stale.push({ file, record });
    else if (record) live.push(record);
  }
  return { live, stale };
}

/** Is process `pid` still running? A process we may not signal still runs. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How the default ancestor grants reach Windows: the sandbox user's SID and a folder-only editor. */
export interface AncestorGrantDeps {
  /** Whom the grants name (`srtAncestorGrantee`), or null when it cannot be read (a sync only runs once it is set up). */
  sid: () => Promise<string | null>;
  /** Applies a batch of entry changes, each to its folder alone (default {@link editFolderAces}). */
  edit?: FolderAceEditor;
  /** The same on process exit (default {@link editFolderAcesSync}). */
  editSync?: FolderAceEditorSync;
  /** This holder (default: this process). */
  pid?: number;
  /** Whether another holder's process still runs (default: signal 0). */
  alive?: (pid: number) => boolean;
  /** The wait before a failed grant is tried again (default {@link GRANT_RETRY_MS}). */
  retryDelayMs?: number;
  /** Whether a folder still exists (default: `existsSync`); one that is gone has nothing to grant. */
  exists?: (dir: string) => boolean;
}

/**
 * The ancestor grants, set as the real user (who owns their profile's folders) on each folder
 * alone, addressed by SID to the sandbox user's group (or the user, outside it).
 *
 * Every Genex on the machine shares the one sandbox user, and so the one grant on each folder: a
 * dev profile runs beside the app, and CI runs test files side by side. Each process records its
 * folders in `holders/<pid>.json` before it grants them (a crash between the two still leaves a
 * record), and takes a grant back only when no other running holder's record names the folder.
 * A record whose process is gone is swept on the next sync: its folders are taken back unless a
 * running holder still needs them.
 */
export function ancestorGrants(holders: string, deps: AncestorGrantDeps): AncestorGrants {
  const edit = deps.edit ?? editFolderAces;
  const editSync = deps.editSync ?? editFolderAcesSync;
  const self = deps.pid ?? process.pid;
  const alive = deps.alive ?? processAlive;
  const exists = deps.exists ?? existsSync;
  const recordFile = path.join(holders, `${self}.json`);
  const save = async (record: GrantRecord) => {
    await mkdir(holders, { recursive: true });
    await writeFile(recordFile, JSON.stringify(record));
  };
  const grantAll = (dirs: readonly string[], sid: string) =>
    grantEach(edit, dirs, sid, deps.retryDelayMs ?? GRANT_RETRY_MS);
  // A folder since removed has no grant left to take back, so a removal that fails is let go.
  const takeBackOf = async (records: readonly GrantRecord[], keep: ReadonlySet<string>) => {
    const removals = takeBack(records, keep);
    if (removals.length > 0) await edit(removals).catch(() => []);
  };
  return {
    async sync(dirs) {
      // A sync follows a successful initialize, so the user exists: without its SID, every
      // process started now would fail to open the folders above its grants (EPERM on AppData).
      const sid = await deps.sid();
      if (!sid) throw new Error(MESSAGE.NoSandboxSid);
      const previous = readRecord(recordFile) ?? { sid, dirs: [] };
      const had = new Set(previous.dirs.map(pathKey));
      await save({ sid, dirs: [...previous.dirs, ...dirs.filter((dir) => !had.has(pathKey(dir)))] });
      // srt-win may have removed the sandbox user's entry on a folder granted before: grant them
      // all, except one that is gone (a member's deleted read root), where the grant would fail.
      await grantAll(dirs.filter(exists), sid);
      const others = otherHolders(holders, self, alive, readRecord);
      const keep = new Set([...neededBy(others.live), ...dirs.map(pathKey)]);
      const stale = others.stale.flatMap((holder) => (holder.record ? [holder.record] : []));
      await takeBackOf([previous, ...stale], keep);
      await save({ sid, dirs: [...dirs] });
      for (const holder of others.stale) rmSync(holder.file, { force: true });
    },
    async revokeAll() {
      const record = readRecord(recordFile);
      rmSync(recordFile, { force: true });
      if (!record) return;
      await takeBackOf([record], neededBy(otherHolders(holders, self, alive, readRecord).live));
    },
    revokeAllSync() {
      const record = readRecord(recordFile);
      rmSync(recordFile, { force: true });
      if (!record) return;
      const removals = takeBack([record], neededBy(otherHolders(holders, self, alive, readRecord).live));
      try {
        if (removals.length > 0) editSync(removals);
      } catch {
        /* nothing more can be done on the way out */
      }
    },
  };
}

/**
 * Grant `dirs` in one batch, and those refused in another, up to {@link GRANT_ATTEMPTS} in all:
 * another process changing the same folder's entries at that moment can refuse one once.
 */
async function grantEach(edit: FolderAceEditor, dirs: readonly string[], sid: string, retryMs: number) {
  let pending = [...dirs];
  for (let attempt = 1; pending.length > 0; attempt++) {
    const outcomes = await edit(pending.map((dir) => ({ dir, sid, op: FolderAceOp.Grant })));
    const refused = pending.flatMap((dir, i) => {
      const outcome = outcomes[i];
      return outcome?.ok ? [] : [{ dir, error: outcome ? outcome.error : MESSAGE.NoAnswer }];
    });
    const first = refused[0];
    if (!first) return;
    if (attempt >= GRANT_ATTEMPTS) throw new Error(MESSAGE.AncestorGrant(first.dir, first.error));
    await sleep(retryMs);
    pending = refused.map((r) => r.dir);
  }
}

/** Every folder `records` name, as path keys. */
function neededBy(records: readonly GrantRecord[]): Set<string> {
  return new Set(records.flatMap((record) => record.dirs.map(pathKey)));
}

/** The removals that take back each record's grants on the folders `keep` does not name, once each. */
function takeBack(records: readonly GrantRecord[], keep: ReadonlySet<string>): FolderAceEdit[] {
  const seen = new Set<string>();
  const edits: FolderAceEdit[] = [];
  for (const record of records) {
    for (const dir of record.dirs) {
      const key = `${pathKey(dir)}|${record.sid}`;
      if (keep.has(pathKey(dir)) || seen.has(key)) continue;
      seen.add(key);
      edits.push({ dir, sid: record.sid, op: FolderAceOp.Remove });
    }
  }
  return edits;
}

// ── Genex's own denies ───────────────────────────────────────────────────────────────────────
//
// srt-win's stamp puts an inheritable FILE_DELETE_CHILD deny on the parent of every path it
// denies, and Windows passes that down through everything under the parent, once per denied path.
// For `~\.ssh` or `~\.claude` the parent is the profile, for a game's `.claude` the whole game, and
// a large profile or a few large games took longer than srt-win's 60-second deadline. Genex sets
// every deny on a path that exists itself, as upstream sandbox-runtime proposes to
// (anthropic-experimental/sandbox-runtime#523): the deny on the path, passed down through what is
// under it, and FILE_DELETE_CHILD denied on its parent folder alone, which walks nothing. They name
// the sandbox users' group: srt-win's recompose of a path drops every explicit entry for the
// user's own SID, whoever set it.

/**
 * What Genex keeps denied on one path, for the sandbox users' group: a deny on the path, passed
 * down to everything under it; FILE_DELETE_CHILD on the path alone (a denied path's parent, so the
 * path cannot be deleted or renamed through it); or both.
 */
export interface OwnDenyEntry {
  path: string;
  deny: DenyAccess | null;
  guard: boolean;
}

/** Who sets each deny path: srt-win (its lists, as given) or Genex ({@link OwnDenyEntry}). */
export interface DenyRoutes {
  srt: { read: string[]; write: string[] };
  own: OwnDenyEntry[];
}

/** The stronger of two denies: a read deny refuses everything, writing included. */
function strongerDeny(a: DenyAccess | null, b: DenyAccess | null): DenyAccess | null {
  if (a === DenyAccess.Read || b === DenyAccess.Read) return DenyAccess.Read;
  return a ?? b;
}

/** Both entries' denies on one path, spelled as the first. */
function mergeEntry(a: OwnDenyEntry, b: OwnDenyEntry): OwnDenyEntry {
  return { path: a.path, deny: strongerDeny(a.deny, b.deny), guard: a.guard || b.guard };
}

/** One entry per path, comparing names as NTFS does, sorted by path. */
function mergeEntries(entries: readonly OwnDenyEntry[]): OwnDenyEntry[] {
  const merged = new Map<string, OwnDenyEntry>();
  for (const entry of entries) {
    const key = pathKey(entry.path);
    const had = merged.get(key);
    merged.set(key, had ? mergeEntry(had, entry) : entry);
  }
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
}

/** A network share (`\\server\share\…`): srt-win leaves a missing one alone, and Genex sets nothing there. */
const UNC_PATH = /^[\\/]{2}/;

/** How {@link routeWindowsDenies} sees the disk; each default is the real one. */
export interface DenyRouteDeps {
  /** Where a path really is (default: Windows' own resolution, links followed, {@link longPath}). */
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/**
 * Whether Genex denies `real` itself: a path that exists, on a drive, with a folder above it to
 * guard. srt-win keeps a missing one, which needs its placeholder, and a drive root or a share.
 */
function deniedByGenex(real: string, exists: (p: string) => boolean): boolean {
  const guardable = !UNC_PATH.test(real) && pathKey(win.dirname(real)) !== pathKey(real);
  return guardable && exists(real);
}

/**
 * Split the session's deny paths between srt-win and Genex ({@link deniedByGenex}), each judged and
 * denied where it really is: a link is denied at its target, as srt-win's stamp would.
 */
export function routeWindowsDenies(
  deny: { read: readonly string[]; write: readonly string[] },
  deps: DenyRouteDeps = {},
): DenyRoutes {
  const realpath = deps.realpath ?? ((p: string) => longPath(p));
  const exists = deps.exists ?? existsSync;
  const srt = { read: [] as string[], write: [] as string[] };
  const own: OwnDenyEntry[] = [];
  const route = (p: string, access: DenyAccess, sent: string[]) => {
    const real = realpath(p);
    if (!deniedByGenex(real, exists)) {
      sent.push(p);
      return;
    }
    own.push({ path: real, deny: access, guard: false }, { path: win.dirname(real), deny: null, guard: true });
  };
  for (const p of deny.read) route(p, DenyAccess.Read, srt.read);
  for (const p of deny.write) route(p, DenyAccess.Write, srt.write);
  return { srt, own: mergeEntries(own) };
}

/** What one holder's deny record keeps: whose entries, and which. */
interface DenyRecord {
  sid: string;
  entries: OwnDenyEntry[];
}

function isDenyEntry(value: unknown): value is OwnDenyEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<OwnDenyEntry>;
  const deny = entry.deny === null || entry.deny === DenyAccess.Read || entry.deny === DenyAccess.Write;
  return typeof entry.path === "string" && deny && typeof entry.guard === "boolean";
}

function readDenyRecord(file: string): DenyRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DenyRecord>;
    if (typeof parsed.sid !== "string" || !Array.isArray(parsed.entries)) return null;
    return { sid: parsed.sid, entries: (parsed.entries as unknown[]).filter(isDenyEntry) };
  } catch {
    return null;
  }
}

/** What every record in `records` needs on each path, by SID and path identity. */
function neededDenies(records: readonly DenyRecord[]): Map<string, OwnDenyEntry> {
  const needed = new Map<string, OwnDenyEntry>();
  for (const record of records) {
    for (const entry of record.entries) {
      const key = `${record.sid}|${pathKey(entry.path)}`;
      const had = needed.get(key);
      needed.set(key, had ? mergeEntry(had, entry) : entry);
    }
  }
  return needed;
}

/**
 * The edits that make each path `mine` names, then each path only `touched` (this holder's earlier
 * record, a gone holder's) names, exactly what `mine` and every running holder need there.
 */
function denyEdits(
  mine: DenyRecord,
  touched: readonly (DenyRecord | null)[],
  live: readonly DenyRecord[],
): FolderDenyEdit[] {
  const needed = neededDenies([mine, ...live]);
  const edits = new Map<string, FolderDenyEdit>();
  const add = (sid: string, dir: string) => {
    const key = `${sid}|${pathKey(dir)}`;
    if (edits.has(key)) return;
    const want = needed.get(key);
    edits.set(key, { dir, sid, op: FolderAceOp.Deny, deny: want?.deny ?? null, guard: want?.guard ?? false });
  };
  for (const entry of mine.entries) add(mine.sid, entry.path);
  for (const record of touched) {
    if (!record) continue;
    for (const entry of record.entries) add(record.sid, entry.path);
  }
  return [...edits.values()];
}

/** Whether an edit sets something, rather than taking it back. */
function setsDeny(edit: FolderDenyEdit): boolean {
  return edit.deny !== null || edit.guard;
}

/**
 * Apply `edits`, and again those that set something and were refused, up to
 * {@link GRANT_ATTEMPTS} in all: another process changing the same entries can refuse one once.
 * A take-back that fails is let go (its path may be gone). False when PowerShell could not apply
 * a batch here.
 */
async function denyEach(edit: FolderDenyEditor, edits: readonly FolderDenyEdit[], retryMs: number) {
  let pending = [...edits];
  for (let attempt = 1; pending.length > 0; attempt++) {
    const outcomes = await edit(pending);
    if (!outcomes) return false;
    const refused = pending.flatMap((one, i) => {
      const outcome = outcomes[i];
      if (outcome?.ok || !setsDeny(one)) return [];
      return [{ edit: one, error: outcome ? outcome.error : MESSAGE.NoAnswer }];
    });
    const first = refused[0];
    if (!first) return true;
    if (attempt >= GRANT_ATTEMPTS) throw new Error(MESSAGE.OwnDeny(first.edit.dir, first.error));
    await sleep(retryMs);
    pending = refused.map((r) => r.edit);
  }
  return true;
}

/** How Genex's own denies reach Windows: whom they name, and the editor that sets them. */
export interface OwnDenyDeps {
  /** The sandbox users' group SID; null where there is none to name ({@link srtSandboxGroup}). */
  sid: () => Promise<string | null>;
  /** Applies a batch of deny edits (default {@link editFolderDenies}). */
  edit?: FolderDenyEditor;
  /** The same on process exit (default {@link editFolderDeniesSync}). */
  editSync?: FolderDenyEditorSync;
  /** This holder (default: this process). */
  pid?: number;
  /** Whether another holder's process still runs (default: signal 0). */
  alive?: (pid: number) => boolean;
  /** The wait before a refused edit is tried again (default {@link GRANT_RETRY_MS}). */
  retryDelayMs?: number;
}

/** Genex's own deny entries for this process, shared with every other running Genex. */
export interface OwnDenyStamps {
  /**
   * Set `entries`, and take back what this holder set before and no running one still needs.
   * False where Genex cannot set them here (no sandbox users' group, PowerShell locked down or
   * not answering): srt-win stamps them instead. Throws when Windows refused one.
   */
  sync(entries: readonly OwnDenyEntry[]): Promise<boolean>;
  /** Take back every entry this holder recorded, except what another running Genex needs. */
  revokeAll(): Promise<void>;
  /** The same synchronously, on process exit. */
  revokeAllSync(): void;
}

/**
 * Genex's own deny entries, held like the ancestor grants ({@link ancestorGrants}): each process
 * records its entries in `holders/<pid>.json` before it sets them, and every edit makes a path
 * exactly what this process and every other running holder's record need there, so one Genex
 * never takes back a deny another still relies on. A gone holder's entries go on the next sync.
 */
export function ownDenyStamps(holders: string, deps: OwnDenyDeps): OwnDenyStamps {
  const edit = deps.edit ?? editFolderDenies;
  const editSync = deps.editSync ?? editFolderDeniesSync;
  const self = deps.pid ?? process.pid;
  const alive = deps.alive ?? processAlive;
  const retryMs = deps.retryDelayMs ?? GRANT_RETRY_MS;
  const recordFile = path.join(holders, `${self}.json`);
  const save = async (record: DenyRecord) => {
    await mkdir(holders, { recursive: true });
    await writeFile(recordFile, JSON.stringify(record));
  };
  const takeBackAll = () => {
    const record = readDenyRecord(recordFile);
    rmSync(recordFile, { force: true });
    if (!record) return [];
    const live = otherHolders(holders, self, alive, readDenyRecord).live;
    return denyEdits({ sid: record.sid, entries: [] }, [record], live);
  };
  return {
    async sync(entries) {
      const sid = await deps.sid();
      if (!sid) return false;
      const wanted = mergeEntries(entries);
      const previous = readDenyRecord(recordFile);
      const others = otherHolders(holders, self, alive, readDenyRecord);
      const stale = others.stale.flatMap((holder) => (holder.record ? [holder.record] : []));
      const edits = denyEdits({ sid, entries: wanted }, [previous, ...stale], others.live);
      if (edits.length > 0) {
        // Recorded first, with what this holder set before: a crash between the two leaves a record.
        const before = previous?.sid === sid ? previous.entries : [];
        await save({ sid, entries: mergeEntries([...before, ...wanted]) });
        if (!(await denyEach(edit, edits, retryMs))) return false;
        await save({ sid, entries: wanted });
      }
      for (const holder of others.stale) rmSync(holder.file, { force: true });
      return true;
    },
    async revokeAll() {
      const edits = takeBackAll();
      if (edits.length > 0) await edit(edits).catch(() => null);
    },
    revokeAllSync() {
      try {
        const edits = takeBackAll();
        if (edits.length > 0) editSync(edits);
      } catch {
        /* nothing more can be done on the way out */
      }
    },
  };
}

// ── the session ──────────────────────────────────────────────────────────────────────────────

/** The part of sandbox-runtime's `SandboxManager` the session drives. */
export interface SessionRuntime {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  reset(): Promise<void>;
  updateConfig(config: SandboxRuntimeConfig): void;
}

/** What one `ProcessSandbox` brings to the session. */
export interface SessionMember {
  grants: WindowsGrants;
  /**
   * Its runtime config: the session keeps the latest one's settings, every member's domains and
   * every member's deny paths. The denies are session-wide: srt-win stamps a deny for the sandbox
   * user, so a per-command one would bind every running command anyway, and costs an ACL round
   * trip per command.
   */
  config: SandboxRuntimeConfig;
}

/** Every deny path a member asks for. */
function memberDenies(member: SessionMember): string[] {
  return [...member.config.filesystem.denyRead, ...member.config.filesystem.denyWrite];
}

/** The session's collaborators. */
export interface WindowsSessionDeps {
  runtime: SessionRuntime;
  /** The real user's profile folder (`USERPROFILE`). */
  profile: string;
  ancestors: AncestorGrants;
  /** Filters deny paths before they reach srt-win ({@link keepWindowsDenies}). */
  keepDenies?: (paths: readonly string[], scope: DenyScope) => string[];
  /**
   * Lets the sandbox user start srt-win, before an initialize ({@link grantLauncherFolders});
   * answers how to take that back, which a failed initialize does.
   */
  launcher?: () => Promise<() => void | Promise<void>>;
  /** Where the session says how long each step of a start took (Genex's log). */
  log?: (line: string) => void;
  /** Genex's own denies for the paths that exist ({@link ownDenyStamps}); without it srt-win stamps them all. */
  denies?: OwnDenyStamps;
  /** Where a deny path really is (default: Windows' own resolution, {@link longPath}). */
  realpath?: (p: string) => string;
  /** Whether a deny path exists (default: `existsSync`); srt-win makes the placeholder of one that does not. */
  exists?: (p: string) => boolean;
}

/** Whether sandbox-runtime failed because srt-win's egress check (`wfp`) ran out of time. */
function egressCheckTimedOut(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const timedOut = "code" in error && error.code === SRT_WIN_TIMEOUT;
  return timedOut && "subcommand" in error && error.subcommand === SrtWinSubcommand.Wfp;
}

/**
 * One grant session for the whole process, shared by every `ProcessSandbox`. It initializes on
 * the first join; a later member or folder that needs more, or a member leaving with folders only
 * it needed, queues a regrant, which runs when no sandboxed command holds the session and takes
 * in everything queued by then. Commands wait only while a regrant is actually being applied.
 * The last member out releases every grant.
 */
export class WindowsSandboxSession {
  readonly #deps: WindowsSessionDeps;
  readonly #members = new Map<object, SessionMember>();
  #applied: WindowsGrants | null = null;
  /** The deny paths the applied config was built from, by path identity. */
  #appliedDenies = new Set<string>();
  /** What Genex itself denies for the applied session ({@link ownDenyStamps}); empty when srt-win stamps every deny. */
  #ownDenied: OwnDenyEntry[] = [];
  #applying: Promise<void> | null = null;
  #queued = false;
  /** A network change arrived while a regrant was being applied, which may have built its config before it. */
  #networkChanged = false;
  #active = 0;
  #regrants = 0;
  /** An initialize succeeded, so its once-per-process egress check has run srt-win as the sandbox user. */
  #started = false;
  /** The last apply left the denies on paths that exist to Genex ({@link ownDenyStamps}), not srt-win. */
  #ownRouted = false;

  constructor(deps: WindowsSessionDeps) {
    this.#deps = deps;
  }

  /** What the sandbox user can reach right now; null before the first initialize. */
  get applied(): WindowsGrants | null {
    return this.#applied;
  }

  /** How many times the grants were re-applied after the first initialize. */
  get regrants(): number {
    return this.#regrants;
  }

  /** Commands currently holding the session. */
  get active(): number {
    return this.#active;
  }

  /**
   * Add or update a member. The first join initializes the session and resolves once it has
   * (rejecting with the runtime's error); a later one that needs more only queues a regrant.
   */
  async join(owner: object, member: SessionMember): Promise<void> {
    this.#members.set(owner, member);
    if (this.#applying) await this.#applying.catch(() => {});
    if (!this.#applied) return this.#apply();
    if (this.#needsRegrant(member)) this.#queue();
  }

  /** A member's grants grew (a folder opened later): queue a regrant when they are not covered yet. */
  update(owner: object, grants: WindowsGrants): void {
    const member = this.#members.get(owner);
    if (!member) return;
    const updated = { ...member, grants };
    this.#members.set(owner, updated);
    if (this.#applied && this.#needsRegrant(updated)) this.#queue();
  }

  /** Does `member` need a grant or a deny the applied session does not have yet? */
  #needsRegrant(member: SessionMember): boolean {
    if (!this.#applied) return true;
    const denied = memberDenies(member).every((p) => this.#appliedDenies.has(pathKey(p)));
    return !denied || !grantsCover(this.#applied, member.grants);
  }

  /**
   * A member is gone (its `ProcessSandbox` disposed): queue a regrant that takes back what only it
   * needed. Its deny paths stay until then, which only ever denies more.
   */
  leave(owner: object): void {
    if (!this.#members.delete(owner) || !this.#applied) return;
    const needed = grantUnion([...this.#members.values()].map((member) => member.grants));
    if (this.#members.size === 0 || !grantsCover(needed, this.#applied)) this.#queue();
  }

  /** A member's network settings changed: srt applies network changes live, without a regrant. */
  network(owner: object, config: SandboxRuntimeConfig): void {
    const member = this.#members.get(owner);
    if (!member) return;
    this.#members.set(owner, { ...member, config });
    if (this.#applied && !this.#applying) this.#deps.runtime.updateConfig(this.#config(this.#applied));
    else if (this.#applying) this.#networkChanged = true;
  }

  /**
   * `paths` without those Genex's own entries already deny for `access`: srt-win would stamp each
   * again for the one command, walking everything under its parent folder.
   */
  withoutOwnDenies(paths: readonly string[], access: DenyAccess): string[] {
    const realpath = this.#deps.realpath ?? longPath;
    const denying = this.#ownDenied.filter((entry) => entry.deny === DenyAccess.Read || entry.deny === access);
    return paths.filter((p) => !denying.some((entry) => insideWindowsPath(entry.path, realpath(p))));
  }

  /** Is everything `needed` asks for granted right now? */
  covers(needed: WindowsGrants): boolean {
    return this.#applied !== null && grantsCover(this.#applied, needed);
  }

  /**
   * Hold the session for one command: waits while a regrant is being applied (retrying a failed
   * one), and hands back the release. The release is idempotent; the last one out starts a
   * queued regrant.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.#applying || !this.#applied) {
      signal?.throwIfAborted();
      if (this.#applying) await this.#applying.catch(() => {});
      else await this.#apply();
    }
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      if (this.#active === 0 && this.#queued) void this.#regrant();
    };
  }

  /**
   * Set the read-attributes grants above the applied roots again, for a caller that holds the
   * session ({@link acquire}) and is about to start a process that must outlive it: anything that
   * rewrote one of those folders' entries since the apply (another holder's srt-win pass) would
   * otherwise stop it at its first path walk. A folder that still has its entry is left untouched.
   */
  async refreshAncestors(): Promise<void> {
    const applied = this.#applied;
    if (!applied) return;
    await this.#deps.ancestors.sync(ancestorDirs(this.#deps.profile, [...applied.write, ...applied.read]));
  }

  /** Resolves once no regrant is queued or being applied (tests, quit). */
  async settled(): Promise<void> {
    while (this.#applying || (this.#queued && this.#active === 0)) await (this.#applying ?? this.#regrant());
  }

  /** Release every grant: srt's own, the folders above them and Genex's own denies. */
  async dispose(): Promise<void> {
    await this.#applying?.catch(() => {});
    this.#queued = false;
    if (this.#applied) await this.#deps.runtime.reset();
    this.#applied = null;
    this.#ownDenied = [];
    await this.#deps.ancestors.revokeAll();
    await this.#deps.denies?.revokeAll();
  }

  /**
   * Initialize, again when only srt-win's egress check ran out of time; any other failure is final.
   * A timed-out ACL step is not retried: it re-applies permissions below each granted folder and
   * each denied path's parent folder, so a retry repeats that walk.
   */
  async #initialize(config: SandboxRuntimeConfig): Promise<void> {
    const launcher = this.#started ? undefined : this.#deps.launcher;
    const release = launcher ? await this.#timed("launcher folders", launcher) : undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#timed("initialize", () => this.#deps.runtime.initialize(config));
        this.#started = true;
        return;
      } catch (error) {
        if (egressCheckTimedOut(error) && attempt < INITIALIZE_ATTEMPTS) continue;
        // srt's reset takes back only what an initialize recorded; the launcher's grant is ours.
        await release?.();
        throw error;
      }
    }
  }

  /** Run `step`, logging how long it took whether it ends or throws. */
  async #timed<T>(step: string, run: () => Promise<T>): Promise<T> {
    const log = this.#deps.log;
    if (!log) return run();
    const started = performance.now();
    try {
      return await run();
    } finally {
      log(`${step}: ${Math.round(performance.now() - started)} ms`);
    }
  }

  #queue(): void {
    this.#queued = true;
    if (this.#active === 0) void this.#regrant();
  }

  #regrant(): Promise<void> {
    if (this.#applying) return this.#applying.catch(() => {});
    if (!this.#queued) return Promise.resolve();
    this.#regrants++;
    return this.#apply().catch(() => {
      /* the next acquire retries and reports the error to its command */
    });
  }

  /** Reset (when initialized) and initialize with the union of every member's grants; with none, release. */
  #apply(): Promise<void> {
    this.#queued = false;
    const applying = (async () => {
      if (this.#members.size === 0) return this.#release();
      const grants = grantUnion([...this.#members.values()].map((member) => member.grants));
      const wasApplied = this.#applied;
      this.#applied = null;
      if (wasApplied) await this.#deps.runtime.reset();
      const denies = [...this.#members.values()].flatMap(memberDenies);
      const plan = await this.#denyOwn(grants);
      await this.#initialize(plan.config);
      await this.#grantAncestors(grants);
      this.#applied = grants;
      this.#appliedDenies = new Set(denies.map(pathKey));
      this.#ownDenied = plan.own;
      if (this.#networkChanged) this.#deps.runtime.updateConfig(this.#config(grants));
      this.#networkChanged = false;
    })();
    this.#applying = applying;
    const settle = () => {
      if (this.#applying === applying) this.#applying = null;
      if (this.#queued && this.#active === 0) void this.#regrant();
    };
    applying.then(settle, settle);
    return applying;
  }

  /** No member is left: take back srt's grants, the folders above them and Genex's denies; a later join starts again. */
  async #release(): Promise<void> {
    const wasApplied = this.#applied;
    this.#applied = null;
    this.#appliedDenies = new Set();
    this.#ownDenied = [];
    if (wasApplied) await this.#deps.runtime.reset();
    await this.#deps.ancestors.revokeAll();
    await this.#deps.denies?.revokeAll();
  }

  /**
   * Set the denies on paths that exist Genex's own way ({@link routeWindowsDenies}), before srt-win
   * grants anything, and answer the config that leaves srt-win the rest. Where Genex cannot set
   * them here, srt-win stamps every deny, as before.
   */
  async #denyOwn(grants: WindowsGrants): Promise<{ config: SandboxRuntimeConfig; own: OwnDenyEntry[] }> {
    const denies = this.#deps.denies;
    if (denies) {
      const plan = this.#plan(grants, true);
      this.#ownRouted = await this.#timed("own denies", () => denies.sync(plan.own));
      if (this.#ownRouted) return plan;
    }
    this.#ownRouted = false;
    const all = this.#plan(grants, false);
    const sent = all.config.filesystem.denyRead.length + all.config.filesystem.denyWrite.length;
    if (denies) this.#deps.log?.(MESSAGE.OwnDeniesOff(sent));
    return all;
  }

  /**
   * The read-attributes grants above the roots, after srt-win's own grants and deny stamps (which
   * replace the sandbox user's entry on a denied path's parent). A failure undoes the initialize,
   * so the next apply starts clean.
   */
  async #grantAncestors(grants: WindowsGrants): Promise<void> {
    try {
      const dirs = ancestorDirs(this.#deps.profile, [...grants.write, ...grants.read]);
      await this.#timed("folders above the grants", () => this.#deps.ancestors.sync(dirs));
    } catch (error) {
      await this.#deps.runtime.reset().catch(() => {});
      throw error;
    }
  }

  /** The session's runtime config, with the denies routed as the last apply routed them. */
  #config(grants: WindowsGrants): SandboxRuntimeConfig {
    return this.#plan(grants, this.#ownRouted).config;
  }

  /**
   * The session's runtime config: the latest member's settings, every member's grants, domains and
   * denies; with `own`, srt-win's share of the denies and Genex's own entries for the rest.
   */
  #plan(grants: WindowsGrants, own: boolean): { config: SandboxRuntimeConfig; own: OwnDenyEntry[] } {
    const members = [...this.#members.values()];
    const latest = members.at(-1)?.config;
    if (!latest) throw new Error(MESSAGE.NoMembers);
    const roots = [...grants.write, ...grants.read];
    const keep = this.#deps.keepDenies ?? ((paths, scope) => keepWindowsDenies(paths, scope));
    const scope = { roots, profile: this.#deps.profile };
    const union = (pick: (member: SessionMember) => readonly string[]) => keep(members.flatMap(pick), scope);
    const domains = [...new Set(members.flatMap((member) => member.config.network.allowedDomains ?? []))];
    const read = union((member) => member.config.filesystem.denyRead);
    const deny = {
      read,
      write: writeDeniesBeyondRead(
        union((member) => member.config.filesystem.denyWrite),
        read,
      ),
    };
    const route = { realpath: this.#deps.realpath, exists: this.#deps.exists };
    const routes = own ? routeWindowsDenies(deny, route) : { srt: deny, own: [] };
    const config = {
      ...latest,
      network: { ...latest.network, allowedDomains: domains },
      filesystem: {
        ...latest.filesystem,
        allowWrite: grants.write,
        allowRead: grants.read,
        denyRead: routes.srt.read,
        denyWrite: routes.srt.write,
      },
    };
    return { config, own: routes.own };
  }
}

/**
 * The folder, under `%LOCALAPPDATA%`, where every Genex process of this user records its ancestor
 * grants: shared by all profiles, outside every grant, and not the Squirrel install folder
 * (`%LOCALAPPDATA%\genex`), which an uninstall removes before its hook could read it.
 */
const GRANT_HOLDERS = "genex-sandbox-grants";
/** The folder beside it where they record their own deny entries ({@link ownDenyStamps}). */
const DENY_HOLDERS = "genex-sandbox-denies";
const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";

/** Where this user's Genex processes record their ancestor grants (uninstall takes back what is left). */
export function windowsGrantHolders(profile: string, localAppData = process.env.LOCALAPPDATA): string {
  return win.join(localAppData || win.join(profile, "AppData", "Local"), GRANT_HOLDERS);
}

/** Where this user's Genex processes record their own deny entries, beside the ancestor grants. */
export function windowsDenyHolders(profile: string, localAppData = process.env.LOCALAPPDATA): string {
  return win.join(localAppData || win.join(profile, "AppData", "Local"), DENY_HOLDERS);
}

/** The `srt-sandbox` user's SID, or null while the sandbox is not provisioned. */
export async function srtSandboxSid(srtWin: string): Promise<string | null> {
  try {
    const srt = await import(SRT_PACKAGE);
    const status = await srt.getWindowsSandboxUserStatusAsync({ srtWin: srt.resolveSrtWin({ path: srtWin }) });
    return status.sid ?? null;
  } catch {
    return null;
  }
}

/**
 * Whom the ancestor grants name: the sandbox users' group when `srt-sandbox` is in it, else the
 * user. Every srt host on the machine (Claude Code 2.1 runs one for its own shell) stamps, grants
 * and cleans up entries for the user's SID, and its cleanup took Genex's entry on `AppData` with
 * its own, so the harness's boot failed with EPERM there. srt-win leaves the group's entries alone,
 * and Windows checks them for every process that runs as the user.
 */
export async function srtAncestorGrantee(srtWin: string): Promise<string | null> {
  try {
    const srt = await import(SRT_PACKAGE);
    const status = await srt.getWindowsSandboxUserStatusAsync({ srtWin: srt.resolveSrtWin({ path: srtWin }) });
    return granteeOf(status);
  } catch {
    return null;
  }
}

/** The group's SID when the sandbox user is in it, else the user's own; null before it exists. */
export function granteeOf(status: { sid?: string; groupSid?: string; inSandboxGroup?: boolean }): string | null {
  return sandboxGroupOf(status) ?? status.sid ?? null;
}

/** The sandbox users' group SID when the sandbox user is in it; null otherwise. */
export function sandboxGroupOf(status: { groupSid?: string; inSandboxGroup?: boolean }): string | null {
  return status.inSandboxGroup && status.groupSid ? status.groupSid : null;
}

/**
 * Whom Genex's own denies name: the sandbox users' group, never the sandbox user, whose explicit
 * entries srt-win's recompose of a path drops (any host's, so another host's cleanup would undo a
 * deny). Null while there is no group to name; throws when srt-win could not say.
 */
export async function srtSandboxGroup(srtWin: string): Promise<string | null> {
  const srt = await import(SRT_PACKAGE);
  return sandboxGroupOf(await srt.getWindowsSandboxUserStatusAsync({ srtWin: srt.resolveSrtWin({ path: srtWin }) }));
}

/**
 * The group's SID by `lookup`, asked up to {@link SID_ATTEMPTS} times while srt-win cannot say and
 * kept once found. "No group" is asked again on the next call: Set up may add it while Genex runs.
 */
export function groupSidOnce(
  lookup: () => Promise<string | null>,
  retryMs: number = SID_RETRY_MS,
): () => Promise<string | null> {
  let found: string | null = null;
  return async () => {
    for (let attempt = 1; !found && attempt <= SID_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(retryMs);
      const answer = await lookup().then(
        (sid) => ({ sid }),
        () => null,
      );
      if (!answer) continue;
      found = answer.sid;
      return found;
    }
    return found;
  };
}

/**
 * The sandbox user's SID by `lookup`, asked up to {@link SID_ATTEMPTS} times (a status probe can
 * time out while Windows scans a freshly installed srt-win) and kept once found: the user keeps its
 * SID until it is removed, which no running Genex does.
 */
export function sandboxSidOnce(
  lookup: () => Promise<string | null>,
  retryMs: number = SID_RETRY_MS,
): () => Promise<string | null> {
  let found: string | null = null;
  return async () => {
    for (let attempt = 1; !found && attempt <= SID_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(retryMs);
      found = await lookup();
    }
    return found;
  };
}

/** How the launcher grant reaches srt-win ({@link grantLauncherFolders}); the session's are srt-win's own. */
export interface LauncherGrantDeps {
  /** The sandbox user's SID, asked again while srt-win cannot say ({@link sandboxSidOnce}); null before it exists. */
  sid: () => Promise<string | null>;
  /** Grant `dirs` for reading to `sid`, held for this process; throws when srt-win refuses. */
  grant: (sid: string, dirs: readonly string[]) => Promise<void>;
  /** Take back what this process granted `sid`. */
  revoke: (sid: string) => Promise<void>;
  /** Where a grant that did not happen is said (Genex's log). */
  log?: (line: string) => void;
}

/** srt-win's own grant and take-back for {@link grantLauncherFolders}, run off the event loop. */
export function srtLauncherGrants(srtWin: string): Pick<LauncherGrantDeps, "grant" | "revoke"> {
  const acl = async (sid: string) => {
    const srt = await import(SRT_PACKAGE);
    return { srt, acl: { sandboxUserSid: sid, srtWin: srt.resolveSrtWin({ path: srtWin }) } };
  };
  return {
    async grant(sid, dirs) {
      const { srt, acl: target } = await acl(sid);
      // The async grant (patched into sandbox-runtime): a sync one holds the start window's thread.
      await srt.grantWindowsAclAsync({ ...target, read: [...dirs], write: [] });
    },
    async revoke(sid) {
      const { srt, acl: target } = await acl(sid);
      await srt.revokeWindowsAclAsync(target);
    },
  };
}

/**
 * Let the sandbox user open the folders srt-win starts from: initialize's egress check runs
 * srt-win as that user before it applies any grant, and a per-user install (Squirrel's, under
 * `%LOCALAPPDATA%`) sits in the profile, where that user may open nothing, so Windows refused it
 * ("CreateProcessWithLogonW(srt-sandbox): Access is denied"). The grant is srt's own, held for
 * this process like the session's, so a reset after a successful initialize takes it back with
 * them; the answer takes it back after a failed one. Before the sandbox is set up there is no user
 * to grant to, and initialize says so. A grant that fails is taken back at once and leaves
 * initialize to report what that costs (an install outside the profile needs none); either way the
 * log says the folders were not granted, the cause of that refusal.
 */
export async function grantLauncherFolders(
  dirs: readonly string[],
  deps: LauncherGrantDeps,
): Promise<() => Promise<void>> {
  const sid = await deps.sid();
  if (!sid) {
    deps.log?.(MESSAGE.LauncherNotGranted(MESSAGE.NoLauncherSid));
    return async () => {};
  }
  const release = async () => {
    // A read grant on the app's own files; the next start's grant replaces it.
    await deps.revoke(sid).catch(() => {});
  };
  try {
    await deps.grant(sid, dirs);
  } catch (error) {
    deps.log?.(MESSAGE.LauncherNotGranted(errorMessage(error)));
    await release();
  }
  return release;
}

/** srt-win's `wfp status` answer for filters that were never installed (or were removed). */
const WFP_ABSENT = "absent";

/** srt-win's `user status` and `wfp status` answers, as far as setup goes. */
export interface SrtSetupStatus {
  user: { provisioned: boolean; credPresent: boolean };
  wfp: { state: string };
}

/** What setup depends on: srt-win's status answers and the Secondary Logon service's start type. */
export interface WindowsSetupStatus extends SrtSetupStatus {
  /** Null when `sc` could not say. */
  logonService: ServiceStartType | null;
}

/** One part of the Windows sandbox not set up yet: what Set up does about it, and the words for Details. */
export interface WindowsSetupGap {
  need: WindowsSetupNeed;
  detail: string;
}

/** What srt-win says is missing: the sandbox user, its credential, or the WFP filters once the user exists. */
function srtGaps({ user, wfp }: SrtSetupStatus): string[] {
  if (!user.provisioned || !user.credPresent) {
    return [MESSAGE.UserNotSetUp(user.provisioned, user.credPresent)];
  }
  return wfp.state === WFP_ABSENT ? [MESSAGE.FiltersNotSetUp] : [];
}

/**
 * What is not set up yet: what srt-win's status answers say is missing, and a disabled Secondary
 * Logon service, without which every start is refused. Empty when everything is in place, even if
 * a start failed.
 */
export function setupGaps(status: WindowsSetupStatus): WindowsSetupGap[] {
  const gaps = srtGaps(status).map((detail) => ({ need: WindowsSetupNeed.Sandbox, detail }));
  if (status.logonService !== ServiceStartType.Disabled) return gaps;
  return [...gaps, { need: WindowsSetupNeed.LogonService, detail: MESSAGE.LogonServiceDisabled }];
}

/** How {@link windowsSetupGaps} asks: srt-win's status, and the Secondary Logon service's start type. */
export interface WindowsSetupProbes {
  status: () => Promise<SrtSetupStatus>;
  logonService: () => Promise<ServiceStartType | null>;
}

/** srt-win's two status probes, asked directly. */
async function srtSetupStatus(srtWin: string): Promise<SrtSetupStatus> {
  const srt = await import(SRT_PACKAGE);
  const opts = { srtWin: srt.resolveSrtWin({ path: srtWin }) };
  const [user, wfp] = await Promise.all([
    srt.getWindowsSandboxUserStatusAsync(opts),
    srt.getWindowsWfpStatusAsync(opts),
  ]);
  return { user, wfp };
}

/** The probes the app asks: the srt-win this build ships, and `sc`. */
function setupProbes(): WindowsSetupProbes {
  return { status: () => srtSetupStatus(srtWinPath()), logonService: () => logonServiceStartType() };
}

/**
 * The parts of the Windows sandbox not set up yet: the ones `initialize` checks first, and the
 * Secondary Logon service every start goes through. `initialize` reports its refusal as a plain
 * Error with no code, so a failed start asks again here to tell "not set up yet" from a fault. It
 * asks srt-win's two status probes directly, not srt's dependency check: that one also lists a
 * probe that failed (a slow first scan, a missing srt-win), which would turn a set-up PC's fault
 * into a second approval prompt. An srt-win probe that fails throws, and the start's own error
 * stands; a service `sc` cannot read is no gap.
 */
export async function windowsSetupGaps(probes: WindowsSetupProbes = setupProbes()): Promise<WindowsSetupGap[]> {
  const [srt, logonService] = await Promise.all([probes.status(), probes.logonService().catch(() => null)]);
  return setupGaps({ ...srt, logonService });
}

const sessions = new WeakMap<object, WindowsSandboxSession>();

/** Hand srt-win's own step times (the network check, the folder grants) to `log`: Genex's patch adds them. */
async function logSrtSteps(log: (line: string) => void): Promise<void> {
  const srt = await import(SRT_PACKAGE).catch(() => null);
  srt?.setStudioStepLog?.((step: string, ms: number) => log(`srt-win ${step}: ${ms} ms`));
}

/**
 * The process's one session for `runtime` (sandbox-runtime's singleton), created by the first
 * `ProcessSandbox` to need it. Its ancestor grants and own denies are recorded under
 * {@link windowsGrantHolders} and {@link windowsDenyHolders} and taken back when the process exits,
 * except where another running Genex still needs them.
 */
export function windowsSessionFor(
  runtime: SessionRuntime,
  options: { profile: string; srtWin: string; installDir: string; log?: (line: string) => void },
): WindowsSandboxSession {
  const existing = sessions.get(runtime);
  if (existing) return existing;
  const holders = windowsGrantHolders(options.profile);
  const ancestors = ancestorGrants(holders, { sid: sandboxSidOnce(() => srtAncestorGrantee(options.srtWin)) });
  const denies = ownDenyStamps(windowsDenyHolders(options.profile), {
    sid: groupSidOnce(() => srtSandboxGroup(options.srtWin)),
  });
  const srtWinDir = win.dirname(options.srtWin);
  const launchDirs = insideWindowsPath(options.installDir, srtWinDir)
    ? [options.installDir]
    : [options.installDir, srtWinDir];
  const log = options.log;
  // Asked again while srt-win cannot say, and kept once found: one probe that timed out used to
  // skip the grant, and srt-win's egress check then could not start.
  const userSid = sandboxSidOnce(() => srtSandboxSid(options.srtWin));
  const launcher = () =>
    grantLauncherFolders(launchDirs, { sid: userSid, ...srtLauncherGrants(options.srtWin), ...(log ? { log } : {}) });
  if (log) void logSrtSteps(log);
  const session = new WindowsSandboxSession({
    runtime,
    profile: options.profile,
    ancestors,
    denies,
    launcher,
    ...(log ? { log } : {}),
  });
  process.once("exit", () => {
    ancestors.revokeAllSync();
    denies.revokeAllSync();
  });
  sessions.set(runtime, session);
  return session;
}

/** Exit status `srt-win exec` reports a typed launch failure with (a mapped-drive working folder). */
export const SRT_WIN_EXEC_FAILED_EXIT = 16;

/** The typed error line `srt-win exec` prints on a launch failure, as `{ code }`; null when absent. */
export function srtWinExecFailure(stderr: string): { code: string; message: string } | null {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string")
        return { code: parsed.code, message: typeof parsed.message === "string" ? parsed.message : parsed.code };
    } catch {
      /* the child's own output */
    }
  }
  return null;
}
