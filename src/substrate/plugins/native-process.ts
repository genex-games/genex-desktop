import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { constants } from "node:fs";
import { access, mkdir, lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { isGenexSlug } from "../genex-game-settings.ts";
import { killProcessTree } from "../process-tree.ts";
import { type ProcessSandbox, shellQuote } from "../spawn.ts";
import { mixedPath } from "../windows-sandbox.ts";
const quote = (s: string) => JSON.stringify(s);
const exec = promisify(execFile);
/**
 * Mach services every job may look up: logging, notifications, preferences and user lookup, which
 * libSystem and Foundation reach while a runtime starts. Nothing that launches or lists
 * applications (LaunchServices), reads the pasteboard or reaches the window server.
 */
const MACH_SERVICES = [
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.diagnosticd",
  "com.apple.system.notification_center",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.bsd.dirhelper",
];
/**
 * A GPU job (Blender's Metal renders) still gets the other mach services. A render starts an AppKit
 * session, and AppKit's RegisterApplication checks in with LaunchServices, the quarantine resolver
 * and TCC; refusing those aborts Blender before it draws. What
 * stays refused by name is what a job could use to act outside its sandbox: opening other
 * applications, the pasteboard, screen capture and the Dock.
 */
const GPU_DENIED_MACH_SERVICES = [
  "com.apple.lsd.open",
  "com.apple.pasteboard.1",
  "com.apple.pbs.fetch_services",
  "com.apple.dock.server",
  "com.apple.ScreenCapture",
];
/** How long a job's pipes may stay open after it exited before the result is recorded anyway. */
const CLOSE_GRACE_MS = 2 * SECOND_MS;
/** How long a quick system probe (`plutil`, `getconf`, `ps`) may take. */
const PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** The process table can be long on a busy Mac. */
const PROCESS_LIST_MAX_BYTES = 16 * 1024 ** 2;
/** Enough of a script's first line to read its `#!` interpreter. */
const SHEBANG_READ_BYTES = 256;
/** Why a native runtime's cache folder is refused. */
const MESSAGE = {
  InvalidCacheIdentity: "Invalid native application cache identity",
  CacheCrossesSymlink: "Native runtime cache crosses a symlink",
} as const;

/** The folder a runtime may start programs from: its `.app` bundle, or the executable's own directory. */
export function runtimeRoot(binary: string): string {
  const end = binary.indexOf(".app/");
  return end < 0 ? path.dirname(binary) : binary.slice(0, end + 4);
}
/** Metal's compiler uses the application's OS cache, ignoring HOME/TMPDIR. Resolve only
 * this executable's bundle identifier; never grant the whole user cache or Library. */
async function gpuCache(binary: string): Promise<string[]> {
  const end = binary.indexOf(".app/");
  if (end < 0) return [];
  const bundle = binary.slice(0, end + 4);
  const id = (
    await exec(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")],
      { timeout: PROBE_TIMEOUT_MS },
    )
  ).stdout.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,150}$/.test(id)) throw new Error(MESSAGE.InvalidCacheIdentity);
  const base = await realpath(
    (await exec("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { timeout: PROBE_TIMEOUT_MS })).stdout.trim(),
  );
  const cache = path.join(base, id);
  await mkdir(cache, { recursive: true });
  if ((await lstat(cache)).isSymbolicLink() || (await realpath(cache)) !== cache)
    throw new Error(MESSAGE.CacheCrossesSymlink);
  return [cache];
}
/**
 * The extension class a GPU job may issue for its Metal cache, to Metal's shader compiler: that
 * compiler is a system process of its own that builds Metal's shader module there, and a refused
 * extension fails every shader the cache has not compiled yet (a new Mac, a macOS or Blender
 * update), which crashes the first render.
 */
const READ_WRITE_EXTENSION = "com.apple.app-sandbox.read-write";
/**
 * setsid(2) and setpgid(2), by their macOS syscall numbers: a descendant that could call them
 * would leave the job's process group, and the group is how a job is stopped.
 */
const LEAVE_GROUP_SYSCALLS = [147, 82];
/**
 * The system programs every job may start besides its runtime: text utilities a shell recipe
 * reaches for (`dirname "$1"`, `yes | head -c`). None opens or lists applications, talks to a
 * system service or changes privileges; a program one of them would start in turn (`env`,
 * `xargs`) still has to be allowed on its own. Everything else in `/usr/bin` (`open`,
 * `lsappinfo`, `osascript`, `curl`) stays refused.
 */
export const JOB_UTILITIES = [
  "basename",
  "dirname",
  "head",
  "tail",
  "yes",
  "tr",
  "cut",
  "wc",
  "sort",
  "uniq",
  "sed",
  "awk",
  "grep",
  "env",
  "xargs",
].map((name) => `/usr/bin/${name}`);
/**
 * The Seatbelt profile for one job. Everything is named: programs only from the runtime's folder,
 * its interpreter and `JOB_UTILITIES`; signals and process details only for the job and the
 * processes it started (its children and its own process group, which `runNativeProcess` makes
 * the job's alone), never Studio or another app; reads and writes only under the given paths; a
 * read-write extension only for `extensions`; no network. Forking stays allowed — a runtime may use helper processes — but a descendant cannot
 * leave the job's process group, and `runNativeProcess` stops the group when the job ends.
 */
export function nativeSandboxProfile(p: {
  binaryRoot: string;
  interpreters?: string[];
  reads: string[];
  writes: string[];
  /** Files the job may write whose names only start so (a program's own temporary names): plain absolute paths only. */
  writePrefixes?: string[];
  /** Folders the job may hand to a system service as a read-write extension: its GPU cache, never more. */
  extensions?: string[];
  denied: string[];
  gpu: boolean;
  /** A game from Play: what it adds to a job's profile (`gameRules`). */
  game?: GameSandbox;
}): string {
  const subpaths = (values: string[]) => values.map((v) => `(subpath ${quote(v)})`).join(" ");
  const prefixes = (p.writePrefixes ?? []).filter((v) => PLAIN_PREFIX.test(v));
  const programs = [...new Set([...(p.interpreters ?? []), ...JOB_UTILITIES])];
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (subpath ${quote(p.binaryRoot)}))`,
    `(allow process-exec ${programs.map((v) => `(literal ${quote(v)})`).join(" ")})`,
    "(allow process-fork)",
    ...["self", "children", "pgrp"].flatMap((target) => [
      `(allow signal (target ${target}))`,
      `(allow process-info* (target ${target}))`,
    ]),
    `(deny syscall-unix (syscall-number ${LEAVE_GROUP_SYSCALLS.join(" ")}))`,
    '(allow file-write* (literal "/dev/null"))',
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    ...(p.gpu
      ? [
          "(allow mach-lookup)",
          `(deny mach-lookup ${GPU_DENIED_MACH_SERVICES.map((n) => `(global-name ${quote(n)})`).join(" ")})`,
          "(allow iokit-open)",
          "(allow iokit-get-properties)",
          "(allow ipc-posix*)",
        ]
      : [`(allow mach-lookup ${MACH_SERVICES.map((n) => `(global-name ${quote(n)})`).join(" ")})`]),
    `(allow file-read* ${subpaths(p.reads)})`,
    `(allow file-read* file-write* ${subpaths(p.writes)})`,
    ...(prefixes.length ? [`(allow file-read* file-write* ${prefixes.map(prefixRule).join(" ")})`] : []),
    ...(p.extensions?.length
      ? [
          `(allow file-issue-extension (require-all (require-any ${subpaths(p.extensions)}) (extension-class ${quote(READ_WRITE_EXTENSION)})))`,
        ]
      : []),
    ...(p.denied.length ? [`(deny file-read* ${subpaths(p.denied)})`] : []),
    ...(p.game ? gameRules(p.game) : []),
    "(deny network*)",
    ...gameNetwork(p.game),
  ].join("\n");
}

/** What a game from Play adds to a job's profile. */
export interface GameSandbox {
  /** Its bundle id, its own preference domain: Genex gives every installed game `games.genex.play.<slug>`. */
  bundleId: string;
  /** Its bundle name: macOS names the folders an atomic save goes through after it. */
  bundleName: string;
  /** The person's temporary folder (`DARWIN_USER_TEMP_DIR`) by its real path, where those folders are. */
  userTemp: string;
  /** Its Genex gateway's ports on 127.0.0.1 (`main/play/genex-gateway.ts`): its only network. */
  genexPorts?: readonly number[];
}

/** A port a game's profile may name: an unprivileged one, written as a plain number. */
const isGatewayPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/**
 * A game's one way onto the network: TCP to its Genex gateway's ports on this Mac. It comes after
 * the profile's `(deny network*)`, which it narrows, since Seatbelt's last matching rule wins.
 */
function gameNetwork(game: GameSandbox | undefined): string[] {
  const ports = (game?.genexPorts ?? []).filter(isGatewayPort);
  if (!ports.length) return [];
  return [`(allow network-outbound ${ports.map((port) => `(remote ip "localhost:${port}")`).join(" ")})`];
}

/** A game's own preference domain: Genex's prefix and a slug. */
const GAME_DOMAIN = /^games\.genex\.play\.[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** A bundle name the atomic-save rule may name: plain words, so it cannot change the rule's meaning. */
const PLAIN_BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/**
 * The preference domains every game reads but never writes: the system's global defaults and the
 * accessibility, input and graphics settings AppKit reads while a window opens.
 */
const GAME_GLOBAL_PREFERENCES = [
  "kCFPreferencesAnyApplication",
  "com.apple.universalaccess",
  "com.apple.accessibility",
  "com.apple.hitoolbox",
  "com.apple.coregraphics",
  "com.apple.gms.availability",
];
/** System folders a game reads beside a job's: keyboard layouts, input methods and audio plug-ins. */
export const GAME_SYSTEM_READS = ["/Library/Keyboard Layouts", "/Library/Input Methods", "/Library/Audio"];

/** A regular expression's special characters escaped, for a Seatbelt `regex`. */
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A game's rules: read and write its own preferences (and read the system's), ask the system for
 * facts such as free space, and use the temporary folders macOS makes for its atomic saves. A
 * domain or name that is not plain gets no rule: that game's preferences or atomic saves fail.
 */
function gameRules(game: GameSandbox): string[] {
  const own = GAME_DOMAIN.test(game.bundleId)
    ? [`(allow user-preference-read user-preference-write (preference-domain ${quote(game.bundleId)}))`]
    : [];
  const name = PLAIN_BUNDLE_NAME.test(game.bundleName) && path.isAbsolute(game.userTemp);
  const saves = `${escapeRegex(path.join(game.userTemp, "TemporaryItems", `NSIRD_${game.bundleName}_`))}[^/]+(/|$)`;
  return [
    ...own,
    `(allow user-preference-read (preference-domain ${GAME_GLOBAL_PREFERENCES.map(quote).join(" ")}))`,
    "(allow system-info)",
    ...(name ? [`(allow file-read* file-write* (regex #"^${saves}"))`] : []),
  ];
}
/** A write prefix the profile accepts: an absolute path of plain characters, never a folder's whole contents. */
const PLAIN_PREFIX = /^\/[A-Za-z0-9._/-]*[A-Za-z0-9_-]$/;

/** A write prefix as a Seatbelt rule: every file in its folder whose name starts with it (never a path below), its dots matched as dots. */
const prefixRule = (prefix: string) => `(regex #"^${prefix.replaceAll(".", "\\.")}[^/]*$")`;

/** The `PATH` a job runs with; `/usr/bin/env <program>` looks the program up here. */
const JOB_PATH = "/usr/bin:/bin";
/**
 * `program` as the job would start it: its path, its real path, and for macOS's `/bin/sh` shim
 * the shell `/private/var/select/sh` points at, which the shim starts in turn.
 */
async function programPaths(program: string): Promise<string[]> {
  const resolved = await realpath(program).catch(() => program);
  const shell = program === "/bin/sh" ? [await realpath("/private/var/select/sh").catch(() => "/bin/bash")] : [];
  return [program, resolved, ...shell];
}
/**
 * The interpreter a script runtime's own `#!` line names (absolute paths only), which the kernel
 * starts to run it: a script runtime needs exactly that program, a binary one none. For
 * `#!/usr/bin/env <program>` it is also the program `env` finds on the job's `PATH`. A shim that
 * starts yet another program (`/usr/bin/python3` asking Xcode for the real one) is not followed:
 * name the real interpreter on the `#!` line instead.
 */
async function scriptInterpreters(binary: string): Promise<string[]> {
  const handle = await open(binary, "r").catch(() => null);
  if (!handle) return [];
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(SHEBANG_READ_BYTES), 0, SHEBANG_READ_BYTES, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8");
    if (!line.startsWith("#!")) return [];
    const [interpreter = "", ...args] = (line.slice(2).split("\n")[0] ?? "").trim().split(/\s+/);
    if (!path.isAbsolute(interpreter)) return [];
    const found = [...(await programPaths(interpreter))];
    const named =
      path.basename(interpreter) === "env" ? args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) : undefined;
    if (named && !named.includes("/")) {
      for (const dir of JOB_PATH.split(":")) {
        const candidate = path.join(dir, named);
        if (
          await access(candidate, constants.X_OK).then(
            () => true,
            () => false,
          )
        ) {
          found.push(...(await programPaths(candidate)));
          break;
        }
      }
    }
    return [...new Set(found)];
  } finally {
    await handle.close();
  }
}
/**
 * Every live descendant of `root`, by parent id. A child posix_spawn()ed into a session of its own
 * is outside the process group; while its parent lives it is still in this tree.
 */
async function descendants(root: number): Promise<number[]> {
  const listing = await exec("/bin/ps", ["-axo", "pid=,ppid="], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROCESS_LIST_MAX_BYTES,
  }).catch(() => ({ stdout: "" }));
  const children = new Map<number, number[]>();
  for (const line of listing.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [],
    queue = [root];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const pid of children.get(parent) ?? []) {
      if (!found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}
/** Why a native process ended (`NativeProcessResult.reason`); a signal at exit replaces `exit` with its name. */
export const NativeEndReason = { Exit: "exit", Cancelled: "cancelled", Timeout: "timeout" } as const;
export type NativeEndReason = (typeof NativeEndReason)[keyof typeof NativeEndReason];

/** One confined native run: what it runs, what it may read and write, and its limits. */
export interface NativeProcessRequest {
  binary: string;
  binaryRoot?: string;
  args: string[];
  cwd: string;
  scratch: string;
  reads: string[];
  writes: string[];
  /** Files written under names that only start so (`nativeSandboxProfile`): real absolute paths. */
  writePrefixes?: string[];
  denyRead: string[];
  gpu?: boolean;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface NativeProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  reason: string;
  pid: number | null;
}

/** System folders every job may read: the OS, its tools, fonts and device nodes. */
export const SYSTEM_READS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library/Fonts",
  "/Library/Apple",
  "/private/var/db",
  "/dev",
];

/** Each path as given and as resolved, so a rule holds whichever spelling the kernel sees. */
const aliases = async (values: string[]) => [
  ...new Set(
    (
      await Promise.all(values.map(async (v) => [path.resolve(v), await realpath(v).catch(() => path.resolve(v))]))
    ).flat(),
  ),
];

/** What a confined process may reach: its program, the folders it reads and writes, and the GPU. */
type SandboxRequest = Pick<
  NativeProcessRequest,
  "binary" | "binaryRoot" | "scratch" | "reads" | "writes" | "writePrefixes" | "denyRead" | "gpu"
>;

/** Write the job's sandbox profile and make its private HOME; returns both paths. */
async function prepareSandbox(p: SandboxRequest): Promise<{ profile: string; home: string }> {
  const root = p.binaryRoot ?? runtimeRoot(p.binary);
  const binaryRoot = await realpath(root).catch(() => path.resolve(root));
  const extensions = p.gpu ? await gpuCache(p.binary) : [];
  const reads = await aliases([...p.reads, binaryRoot, ...SYSTEM_READS]),
    writes = await aliases([...p.writes, p.scratch, ...extensions]),
    denied = await aliases(p.denyRead);
  const home = path.join(p.scratch, "home");
  await mkdir(home, { recursive: true });
  const interpreters = await scriptInterpreters(p.binary);
  const profile = path.join(p.scratch, "native.sb");
  const writePrefixes = p.writePrefixes ?? [];
  await writeFile(
    profile,
    nativeSandboxProfile({ binaryRoot, interpreters, reads, writes, writePrefixes, extensions, denied, gpu: !!p.gpu }),
  );
  return { profile, home };
}

/** Kill a child's whole tree: descendants are listed first, while each still has its parent. */
export function treeKiller(child: ChildProcess) {
  const kill = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  };
  const killGroup = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      kill(child.pid);
    }
  };
  // The tree is read before the group is stopped, while every descendant still has its parent.
  // Windows has no `ps` or process groups: `taskkill /T` walks the tree itself.
  return async () => {
    const running = child.pid && child.exitCode === null && child.signalCode === null;
    if (process.platform === StudioPlatform.Windows) {
      if (running) await killProcessTree(child.pid);
      return;
    }
    const tree = running ? await descendants(child.pid as number) : [];
    killGroup();
    for (const pid of tree) kill(pid);
  };
}

/** The tail of a child's stdout and stderr, each kept to `maxBytes`. */
function captureOutput(child: ChildProcessByStdio<null, Readable, Readable>, maxBytes: number) {
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  child.stdout.on("data", (b) => {
    output.stdout = Buffer.concat([output.stdout, b]).subarray(-maxBytes);
  });
  child.stderr.on("data", (b) => {
    output.stderr = Buffer.concat([output.stderr, b]).subarray(-maxBytes);
  });
  return output;
}

/**
 * Watch a started job until it is recorded: a stop or the timeout kills its whole tree, and its
 * exit settles the result once its pipes close (or a short grace later).
 */
function superviseJob(
  child: ChildProcessByStdio<null, Readable, Readable>,
  p: NativeProcessRequest,
  resolve: (result: NativeProcessResult) => void,
  reject: (error: Error) => void,
) {
  let reason: string = NativeEndReason.Exit,
    settled = false;
  const killAll = treeKiller(child);
  const abort = () => {
    reason = NativeEndReason.Cancelled;
    void killAll();
  };
  const timer = setTimeout(() => {
    reason = NativeEndReason.Timeout;
    void killAll();
  }, p.timeoutMs);
  timer.unref();
  p.signal.addEventListener("abort", abort, { once: true });
  if (p.signal.aborted) abort();
  const output = captureOutput(child, p.maxOutputBytes);
  const cleanup = () => {
    clearTimeout(timer);
    p.signal.removeEventListener("abort", abort);
  };
  const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    // Nothing the job started may keep writing to its output once the job is recorded.
    await killAll();
    resolve({
      code,
      signal,
      stdout: output.stdout.toString("utf8"),
      stderr: output.stderr.toString("utf8"),
      reason: reason === NativeEndReason.Exit && signal ? `Runtime terminated by ${signal}` : reason,
      pid: child.pid ?? null,
    });
  };
  child.on("error", (e) => {
    if (settled) return;
    settled = true;
    cleanup();
    void killAll().finally(() => reject(e));
  });
  // 'close' waits for every pipe. A descendant holding one must not keep the job running after
  // it exited: wait a bounded moment for the last output, then record the result regardless.
  child.on("exit", (code, signal) => {
    void killAll();
    const grace = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      void finish(code, signal);
    }, CLOSE_GRACE_MS);
    grace.unref();
    child.once("close", () => {
      clearTimeout(grace);
      void finish(code, signal);
    });
  });
}

/**
 * A long-lived confined process with its stdin and stdout open: a game an engine plugin's runtime
 * plays for the studio's computer tool (Play Protocol), in the same profile as a job (`gpu` for an
 * engine that draws), its own process group, its whole tree stopped once it exits. No deadline:
 * its owner quits or kills it; the caller removes `scratch` after it exits.
 */
export async function spawnNativeLongLived(
  p: SandboxRequest & { args: string[]; cwd: string },
): Promise<ChildProcessByStdio<Writable, Readable, Readable>> {
  const { profile, home } = await prepareSandbox(p);
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, p.binary, ...p.args], {
    cwd: p.cwd,
    env: { HOME: home, TMPDIR: p.scratch, TMP: p.scratch, TEMP: p.scratch, PATH: JOB_PATH, LANG: "en_US.UTF-8" },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const killAll = treeKiller(child);
  // Nothing the game started outlives it.
  child.once("exit", () => void killAll());
  return child;
}

export async function runNativeProcess(p: NativeProcessRequest): Promise<NativeProcessResult> {
  p.signal.throwIfAborted();
  const { profile, home } = await prepareSandbox(p);
  return new Promise<NativeProcessResult>((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, p.binary, ...p.args], {
      cwd: p.cwd,
      env: { HOME: home, TMPDIR: p.scratch, TMP: p.scratch, TEMP: p.scratch, PATH: JOB_PATH, LANG: "en_US.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    superviseJob(child, p, resolve, reject);
  });
}

/** The part of the process sandbox (`ProcessSandbox`) a Windows native job runs in. */
export type NativeJobSandbox = Pick<ProcessSandbox, "run" | "allowRead">;

/**
 * A native job on Windows: the runtime started by Git Bash inside the process sandbox, as the
 * sandbox user (srt-win), with no network, the run's temp folders in its scratch, and srt-win's
 * job object holding its whole tree. `reads` and `writes` are the folders the run needs granted:
 * the sandbox refuses the run when its grants do not cover them yet (`SandboxLaunchCode.NotGranted`),
 * because srt-win changes grants only while no sandboxed command runs. Folders every Windows user
 * reads (Program Files) need no grant and are not listed.
 */
export async function runSandboxedNativeProcess(
  sandbox: NativeJobSandbox,
  p: NativeProcessRequest,
): Promise<NativeProcessResult> {
  p.signal.throwIfAborted();
  // The sandbox keeps the head of a run's output and a job's record keeps its end (the result line
  // a runtime prints last), so each stream goes to a file in the job's scratch, read from its end.
  const logs = { stdout: path.join(p.scratch, "stdout.log"), stderr: path.join(p.scratch, "stderr.log") };
  const program = [shellQuote(mixedPath(p.binary)), ...p.args.map(shellQuote)].join(" ");
  const command = `exec ${program} >${shellQuote(mixedPath(logs.stdout))} 2>${shellQuote(mixedPath(logs.stderr))}`;
  const result = await sandbox.run({
    command,
    cwd: p.cwd,
    env: { TMPDIR: p.scratch, TMP: p.scratch, TEMP: p.scratch },
    timeoutMs: p.timeoutMs,
    maxOutputBytes: p.maxOutputBytes,
    signal: p.signal,
    label: `native ${path.basename(p.binary)}`,
    policy: { allowWrite: [...p.writes, p.scratch], allowRead: p.reads, denyRead: p.denyRead },
  });
  return {
    code: result.code,
    signal: result.signal,
    stdout: await fileTail(logs.stdout, p.maxOutputBytes),
    // What the sandbox itself said (a refused launch) comes after what the runtime printed.
    stderr: (await fileTail(logs.stderr, p.maxOutputBytes)) + result.stderr,
    reason: sandboxedEndReason(result, p.signal),
    pid: null,
  };
}

/** The last `maxBytes` of a log file as text; empty when the run never wrote it. */
async function fileTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Why a sandboxed run ended, in a job record's words (`NativeEndReason`, or the signal that ended it). */
function sandboxedEndReason(result: { timedOut: boolean; signal: NodeJS.Signals | null }, stop: AbortSignal): string {
  if (stop.aborted) return NativeEndReason.Cancelled;
  if (result.timedOut) return NativeEndReason.Timeout;
  return result.signal ? `Runtime terminated by ${result.signal}` : NativeEndReason.Exit;
}

/** One game from Play to run: its app, its saves folder (its home) and what its profile names. */
export interface NativeGameRequest {
  /** The game's executable inside its installed app. */
  binary: string;
  /** The installed app bundle: what it may run programs from, read-only. */
  app: string;
  /** Its saves folder: its HOME (and Foundation's, `CFFIXED_USER_HOME`), the one place it writes. */
  saves: string;
  /** A fresh folder for its temporary files, removed by the caller after it exits. */
  scratch: string;
  bundleId: string;
  bundleName: string;
  /** Arguments for the game: a game from Play gets its engine's full-screen one (`launchArgs`), or none. */
  args?: string[];
  /** Its way to Genex: its gateway's ports and what it tells the game (`GameGenexEnv`); none, no network at all. */
  genex?: { ports: readonly number[]; env: GameGenexEnv };
}

/**
 * What a launched game is told about Genex (CLI_INTEGRATION §6b): its API's address, which is its
 * gateway's, a single-use sign-in ticket while the person is signed in, and its own project on
 * Genex, so a build made before its first publish still knows which game's rooms to join.
 */
export interface GameGenexEnv {
  GENEX_API_URL: string;
  GENEX_EMBED_TICKET?: string;
  GENEX_GAME?: string;
}
/** A gateway address a game may be told: plain http on this Mac, an unprivileged port. */
const GATEWAY_URL = /^http:\/\/127\.0\.0\.1:(\d{4,5})$/;
/** A ticket as Genex mints one: a short token of URL-safe characters. */
const TICKET = /^[A-Za-z0-9._~-]{16,4096}$/;

/** The Genex part of a game's environment, each value checked; nothing that doesn't hold up. */
export function gameGenexEnv(env: GameGenexEnv | undefined): Record<string, string> {
  const port = Number(GATEWAY_URL.exec(env?.GENEX_API_URL ?? "")?.[1]);
  if (!env || !isGatewayPort(port)) return {};
  const ticket = env.GENEX_EMBED_TICKET && TICKET.test(env.GENEX_EMBED_TICKET) ? env.GENEX_EMBED_TICKET : undefined;
  const game = env.GENEX_GAME && isGenexSlug(env.GENEX_GAME) ? env.GENEX_GAME : undefined;
  return {
    GENEX_API_URL: env.GENEX_API_URL,
    ...(ticket ? { GENEX_EMBED_TICKET: ticket } : {}),
    ...(game ? { GENEX_GAME: game } : {}),
  };
}

/**
 * A game from Play in the native-job sandbox with a window, the GPU and sound: its app read-only,
 * its saves folder its home (Foundation's too, so Application Support lands there), its own
 * preferences, no network but its Genex gateway's ports when it has one (and the Genex address and
 * ticket in its environment), its own process group, stdin closed and its output for the caller to
 * drain. Nothing it starts outlives it.
 */
export async function spawnNativeGame(p: NativeGameRequest): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const binaryRoot = await realpath(p.app);
  const extensions = await gpuCache(p.binary);
  const userTemp = await realpath(
    (await exec("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { timeout: PROBE_TIMEOUT_MS })).stdout.trim(),
  );
  const reads = await aliases([binaryRoot, ...SYSTEM_READS, ...GAME_SYSTEM_READS]);
  const writes = await aliases([p.saves, p.scratch, ...extensions]);
  const game = { bundleId: p.bundleId, bundleName: p.bundleName, userTemp, genexPorts: p.genex?.ports ?? [] };
  const profile = path.join(p.scratch, "game.sb");
  await writeFile(
    profile,
    nativeSandboxProfile({ binaryRoot, reads, writes, extensions, denied: [], gpu: true, game }),
  );
  const home = await realpath(p.saves);
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, p.binary, ...(p.args ?? [])], {
    cwd: path.dirname(binaryRoot),
    env: {
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: p.scratch,
      TMP: p.scratch,
      TEMP: p.scratch,
      PATH: JOB_PATH,
      LANG: "en_US.UTF-8",
      ...gameGenexEnv(p.genex?.env),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killAll = treeKiller(child);
  child.once("exit", () => void killAll());
  return child;
}
