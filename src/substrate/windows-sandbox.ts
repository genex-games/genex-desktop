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
import { StudioPlatform } from "../shared/boot.ts";
import { errorMessage } from "../shared/errors.ts";
import { windowsHelperAccess, type WindowsHelperAccess } from "./windows-helper-access.ts";
import {
  editFolderAces,
  editFolderAcesSync,
  type FolderAceEdit,
  type FolderAceEditor,
  type FolderAceEditorSync,
  FolderAceOp,
} from "./windows-folder-ace.ts";

const win = path.win32;
const run = promisify(execFile);

/** How long one `reg` or `git` call may take. */
const TOOL_TIMEOUT_MS = 15 * SECOND_MS;
/**
 * How often `initialize` is tried when srt-win times out. Its first egress check runs 17-23 s
 * against a 30 s limit on a hosted runner, so a busy machine can miss it once.
 */
const INITIALIZE_ATTEMPTS = 3;
/** sandbox-runtime's code for an srt-win call that ran out of time. */
const SRT_WIN_TIMEOUT = "srt_win_timeout";
/** The registry key Git for Windows records its install folder under. */
const GIT_REGISTRY_KEY = "HKLM\\SOFTWARE\\GitForWindows";
const GIT_REGISTRY_VALUE = "InstallPath";
/** Git Bash inside a Git for Windows install. */
const GIT_BASH = ["bin", "bash.exe"] as const;
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
  // Match host Git: ambient configuration must not rewrite bytes or select external programs.
  // Repository configuration and .gitattributes still apply.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // Node's fetch goes through srt's proxy like curl and git do.
  NODE_USE_ENV_PROXY: "1",
  // Windows paths reach native programs unchanged.
  MSYS_NO_PATHCONV: "1",
} as const;
/** curl's schannel revocation check cannot reach its CRL servers through the proxy. */
const CURLRC = "ssl-revoke-best-effort\n";
/** Git defaults added after srt-win's safe-directory and CA entries, without replacing them. */
const WINDOWS_GIT_DEFAULTS = { "credential.helper": "", "core.longpaths": "true" } as const;

const MESSAGE = {
  BadEnvName: (name: string) => `refusing to write the environment variable ${JSON.stringify(name)}`,
  AncestorGrant: (dir: string, error: unknown) =>
    `could not let the sandbox user see the folder ${dir}: ${errorMessage(error)}`,
  NoAnswer: "no answer for this folder",
  NoMembers: "the Windows sandbox session has no members",
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
 * stores, and browser profiles. The coding CLIs' homes come from `credentialHomes()`.
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
 * `GIT_CONFIG_*` list srt already set (its `safe.directory` entries stay). Long paths are enabled.
 */
export function renderEnvFile(input: EnvFileInput): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(input.vars)) {
    if (!ENV_NAME.test(name)) throw new Error(MESSAGE.BadEnvName(name));
    lines.push(`export ${name}=${quote(value)}`);
  }
  const tools = msysPathList(input.toolPath);
  lines.push(`export PATH=${quote(tools ? `/usr/bin:${tools}` : "/usr/bin")}":$PATH"`);
  lines.push("__genex_n=${GIT_CONFIG_COUNT:-0}");
  for (const [key, value] of Object.entries(WINDOWS_GIT_DEFAULTS)) {
    lines.push(
      `export "GIT_CONFIG_KEY_\${__genex_n}=${key}" "GIT_CONFIG_VALUE_\${__genex_n}=${value}"`,
      "__genex_n=$((__genex_n + 1))",
    );
  }
  lines.push("export GIT_CONFIG_COUNT=$__genex_n", "unset __genex_n");
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

/** How Git Bash is looked up; the defaults ask the registry, then `git`. */
export interface GitBashLookup {
  registry?: () => Promise<string>;
  execPath?: () => Promise<string>;
  exists?: (file: string) => boolean;
}

/** Git Bash (`<Git>\bin\bash.exe`), from the registry or from `git --exec-path`; null when neither finds it. */
export async function findGitBash(lookup: GitBashLookup = {}): Promise<string | null> {
  const registry =
    lookup.registry ??
    (async () =>
      (await run("reg", ["query", GIT_REGISTRY_KEY, "/v", GIT_REGISTRY_VALUE], { timeout: TOOL_TIMEOUT_MS })).stdout);
  const execPath =
    lookup.execPath ?? (async () => (await run("git", ["--exec-path"], { timeout: TOOL_TIMEOUT_MS })).stdout);
  const exists = lookup.exists ?? existsSync;
  const lookups = [
    () => registry().then(gitRootFromRegistry, () => null),
    () => execPath().then(gitRootFromExecPath, () => null),
  ];
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
 * Every other holder's record in `holders`: `live` for processes that still run, `stale` for
 * those that are gone. A running holder's unreadable record is skipped (it may be mid-write).
 */
function otherHolders(holders: string, self: number, alive: (pid: number) => boolean) {
  const live: GrantRecord[] = [];
  const stale: Array<{ file: string; record: GrantRecord | null }> = [];
  const names = existsSync(holders) ? readdirSync(holders) : [];
  for (const name of names) {
    const pid = Number(HOLDER_RECORD.exec(name)?.[1] ?? Number.NaN);
    if (!Number.isInteger(pid) || pid === self) continue;
    const file = path.join(holders, name);
    const record = readRecord(file);
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
  /** The `srt-sandbox` SID, or null while the sandbox is not provisioned. */
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
 * alone, addressed to the sandbox user by SID.
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
      const sid = await deps.sid();
      if (!sid) return;
      const previous = readRecord(recordFile) ?? { sid, dirs: [] };
      const had = new Set(previous.dirs.map(pathKey));
      await save({ sid, dirs: [...previous.dirs, ...dirs.filter((dir) => !had.has(pathKey(dir)))] });
      // srt-win may have removed the sandbox user's entry on a folder granted before: grant them
      // all, except one that is gone (a member's deleted read root), where the grant would fail.
      await grantAll(dirs.filter(exists), sid);
      const others = otherHolders(holders, self, alive);
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
      await takeBackOf([record], neededBy(otherHolders(holders, self, alive).live));
    },
    revokeAllSync() {
      const record = readRecord(recordFile);
      rmSync(recordFile, { force: true });
      if (!record) return;
      const removals = takeBack([record], neededBy(otherHolders(holders, self, alive).live));
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
  /** The broker must be readable before its sandbox-user egress probe, including per-user installs. */
  helper?: Pick<WindowsHelperAccess, "grant" | "revoke">;
  /** Filters deny paths before they reach srt-win ({@link keepWindowsDenies}). */
  keepDenies?: (paths: readonly string[], scope: DenyScope) => string[];
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
  #applying: Promise<void> | null = null;
  #queued = false;
  /** A network change arrived while a regrant was being applied, which may have built its config before it. */
  #networkChanged = false;
  #active = 0;
  #regrants = 0;

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

  /** Resolves once no regrant is queued or being applied (tests, quit). */
  async settled(): Promise<void> {
    while (this.#applying || (this.#queued && this.#active === 0)) await (this.#applying ?? this.#regrant());
  }

  /** Release every grant: srt's own and the folders above them. */
  async dispose(): Promise<void> {
    await this.#applying?.catch(() => {});
    this.#queued = false;
    await this.#release();
  }

  /** Initialize, again when srt-win only ran out of time; any other failure is final. */
  async #initialize(config: SandboxRuntimeConfig): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#deps.runtime.initialize(config);
        return;
      } catch (error) {
        const timedOut =
          typeof error === "object" && error !== null && "code" in error && error.code === SRT_WIN_TIMEOUT;
        if (!timedOut || attempt >= INITIALIZE_ATTEMPTS) throw error;
      }
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
      try {
        await this.#deps.helper?.grant();
        await this.#initialize(this.#config(grants));
        await this.#grantAncestors(grants);
      } catch (error) {
        await this.#revokeAccess();
        throw error;
      }
      this.#applied = grants;
      this.#appliedDenies = new Set(denies.map(pathKey));
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

  /** No member is left: take back srt's grants and the folders above them; a later join starts again. */
  async #release(): Promise<void> {
    const wasApplied = this.#applied;
    this.#applied = null;
    this.#appliedDenies = new Set();
    try {
      if (wasApplied) await this.#deps.runtime.reset();
    } finally {
      await this.#revokeAccess();
    }
  }

  /** Attempt both cleanup steps even when the helper is gone or its journal refuses cleanup. */
  async #revokeAccess(): Promise<void> {
    try {
      await this.#deps.helper?.revoke();
    } finally {
      await this.#deps.ancestors.revokeAll();
    }
  }

  /**
   * The read-attributes grants above the roots, after srt-win's own grants and deny stamps (which
   * replace the sandbox user's entry on a denied path's parent). A failure undoes the initialize,
   * so the next apply starts clean.
   */
  async #grantAncestors(grants: WindowsGrants): Promise<void> {
    try {
      await this.#deps.ancestors.sync(ancestorDirs(this.#deps.profile, [...grants.write, ...grants.read]));
    } catch (error) {
      await this.#deps.runtime.reset().catch(() => {});
      throw error;
    }
  }

  /** The session's runtime config: the latest member's settings, every member's grants, domains and denies. */
  #config(grants: WindowsGrants): SandboxRuntimeConfig {
    const members = [...this.#members.values()];
    const latest = members.at(-1)?.config;
    if (!latest) throw new Error(MESSAGE.NoMembers);
    const roots = [...grants.write, ...grants.read];
    const keep = this.#deps.keepDenies ?? ((paths, scope) => keepWindowsDenies(paths, scope));
    const scope = { roots, profile: this.#deps.profile };
    const union = (pick: (member: SessionMember) => readonly string[]) => keep(members.flatMap(pick), scope);
    const domains = [...new Set(members.flatMap((member) => member.config.network.allowedDomains ?? []))];
    const denyRead = union((member) => member.config.filesystem.denyRead);
    const denyWrite = union((member) => member.config.filesystem.denyWrite);
    return {
      ...latest,
      network: { ...latest.network, allowedDomains: domains },
      filesystem: {
        ...latest.filesystem,
        allowWrite: grants.write,
        allowRead: grants.read,
        denyRead,
        denyWrite: writeDeniesBeyondRead(denyWrite, denyRead),
      },
    };
  }
}

/**
 * The folder, under `%LOCALAPPDATA%`, where every Genex process of this user records its ancestor
 * grants: shared by all profiles, outside every grant, and not the Squirrel install folder
 * (`%LOCALAPPDATA%\genex`), which an uninstall removes before its hook could read it.
 */
const GRANT_HOLDERS = "genex-sandbox-grants";
const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";

/** Where this user's Genex processes record their ancestor grants (uninstall takes back what is left). */
export function windowsGrantHolders(profile: string, localAppData = process.env.LOCALAPPDATA): string {
  return win.join(localAppData || win.join(profile, "AppData", "Local"), GRANT_HOLDERS);
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

const sessions = new WeakMap<object, WindowsSandboxSession>();

/**
 * The process's one session for `runtime` (sandbox-runtime's singleton), created by the first
 * `ProcessSandbox` to need it. Its ancestor grants are recorded under {@link windowsGrantHolders}
 * and taken back when the process exits, except where another running Genex still needs them.
 */
export function windowsSessionFor(
  runtime: SessionRuntime,
  options: { profile: string; srtWin: string },
): WindowsSandboxSession {
  const existing = sessions.get(runtime);
  if (existing) return existing;
  const holders = windowsGrantHolders(options.profile);
  const ancestors = ancestorGrants(holders, { sid: () => srtSandboxSid(options.srtWin) });
  const helper = windowsHelperAccess(options.srtWin);
  const session = new WindowsSandboxSession({ runtime, profile: options.profile, ancestors, helper });
  process.once("exit", () => {
    try {
      helper.revokeSync();
    } finally {
      ancestors.revokeAllSync();
    }
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
