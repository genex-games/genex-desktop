/**
 * The game boxes `ProcessSandbox.spawnGame` starts a game in when Genex itself runs on Windows or
 * Linux (plan M7, D19 = C), on any platform, with the platform, the box's host facts and the spawn
 * injected:
 *  - which problem keeps a host from having a box (`gameBox(mode)`), each refused typed with
 *    nothing spawned, claimed or written;
 *  - on Windows, the AppContainer launcher's invocation exactly as `planWindowsGameLaunch` writes
 *    it, its refusals and its exit codes read as the run's own;
 *  - on Linux, bubblewrap's argv exactly as `linuxGameBoxArgs` writes it, with the seccomp program
 *    on fd 4, and the planner's refusals as the run's own.
 * No launcher and no bubblewrap ever runs here: the spawn is a recording fake.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import {
  GameBoxProblem,
  NATIVE_GAME_MEMORY_MAX_BYTES,
  NATIVE_STUDIO_AI_ON,
  NativeEnv,
  NativeError,
  NativeRefusal,
  NativeRunMode,
} from "../../src/shared/native-contract.ts";
import {
  LinuxBoxAudio,
  LinuxBoxError,
  LinuxBoxRefusal,
  type LinuxBoxStats,
  type LinuxBoxSystem,
  bubblewrapVersion,
  linuxBoxError,
  linuxGameBoxArgs,
  planLinuxGameBox,
} from "../../src/substrate/linux-game-box.ts";
import { linuxGameSeccompProgram } from "../../src/substrate/linux-game-seccomp.ts";
import { type GameBoxSeams, ProcessSandbox } from "../../src/substrate/spawn.ts";
import {
  LAUNCHER_EXIT_CODES,
  LauncherDesktop,
  LauncherFailure,
  WindowsBoxError,
  WindowsLaunchRefusal,
  launcherGameExit,
  launcherPipeName,
  launchRefusalError,
  planWindowsGameLaunch,
} from "../../src/substrate/windows-game-launch.ts";
import { tmpDir } from "../helpers/tmp.ts";

const win = path.win32;

// ── a recording spawn ─────────────────────────────────────────────────────────────────────

/** A started process as Node's spawn hands one back: fd 3 a duplex, fd 4 (Linux) the seccomp sink. */
class FakeProcess extends EventEmitter {
  readonly pid: number;
  readonly stdio: [null, PassThrough, PassThrough, PassThrough, PassThrough];
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  /** What the box read from fd 4. */
  readonly seccomp: Buffer[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => this.seccomp.push(chunk));
    this.stdio = [null, this.stdout, this.stderr, new PassThrough(), sink];
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return true;
  }

  /** The process ends: Node's `exit` event with its code or signal. */
  end(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

/**
 * Every fake started, so each is ended before its sandbox is disposed: `dispose` signals the
 * process group of a game still running, and a fake's pid must never reach a real process.
 */
const fakes: FakeProcess[] = [];

interface SpawnCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  child: FakeProcess;
}

/** A spawn that records each call and hands back a fake that says it started. */
function recordingSpawn(): { calls: SpawnCall[]; spawn: NonNullable<GameBoxSeams["spawn"]> } {
  const calls: SpawnCall[] = [];
  let pid = 7000;
  return {
    calls,
    spawn: (file, args, options) => {
      pid += 1;
      const child = new FakeProcess(pid);
      fakes.push(child);
      calls.push({ file, args: [...args], options: { ...options }, child });
      setImmediate(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
  };
}

const refusedWith = (refusal: NativeRefusal, box: GameBoxProblem) => (error: unknown) => {
  assert.ok(error instanceof NativeError, `typed: ${String(error)}`);
  assert.equal(error.refusal, refusal, error.message);
  assert.equal(error.box, box, error.message);
  return true;
};

const sandboxes: ProcessSandbox[] = [];
after(async () => {
  for (const fake of fakes) if (fake.exitCode === null && fake.signalCode === null) fake.end(0);
  await Promise.all(sandboxes.map((sandbox) => sandbox.dispose()));
});

/** Ubuntu 24.04 with its user-namespace switch on, read by a process its restriction applies to (unconfined). */
const restrictedRead = (file: string) => (file.includes("restrict") ? "1\n" : "unconfined\n");

/** A sandbox for `platform`, with the sandbox itself off and the game box's host facts injected. */
async function box(
  platform: NodeJS.Platform,
  options: { nativeRunsRoot: string; gameLauncher?: string; seams: GameBoxSeams; usernsRestricted?: boolean },
): Promise<ProcessSandbox> {
  const scratch = await tmpDir("host-game-box-scratch-");
  const restricted = options.usernsRestricted === true;
  const sandbox = await ProcessSandbox.create({
    writableRoots: [],
    scratchDir: scratch,
    secretPaths: [],
    enabled: false,
    platform,
    nativeRunsRoot: options.nativeRunsRoot,
    ...(options.gameLauncher ? { gameLauncher: options.gameLauncher } : {}),
    // Ubuntu 24.04's switch on and this process unconfined, or nothing to read at all.
    linux: { read: (file) => (restricted ? restrictedRead(file) : null) },
    gameBoxSeams: options.seams,
  });
  sandboxes.push(sandbox);
  return sandbox;
}

// ── Windows ───────────────────────────────────────────────────────────────────────────────

const WIN_ROOT = "C:\\Users\\Ada\\AppData\\Roaming\\Genex\\native-runs";
const LAUNCHER = "C:\\Program Files\\Genex\\resources\\native\\genex-game-launcher.exe";
const WIN_RUN_ID = "0199a1b2c3d4e5f6";
const OTHER_WIN_RUN_ID = "aaaabbbbccccdddd";
const NONCE = "a1b2c3d4e5f60718";

/** The run a Windows host prepared: `<native-runs>\<id>\{bundle\game.exe,state}`. */
function winRun(runId = WIN_RUN_ID, mode: NativeRunMode = NativeRunMode.Window) {
  const runDir = win.join(WIN_ROOT, runId);
  const bundle = win.join(runDir, "bundle");
  return {
    runId,
    runDir,
    bundle,
    exe: win.join(bundle, "game.exe"),
    state: win.join(runDir, "state"),
    mode,
    nonce: NONCE,
  };
}

/** A regular file, a link or a folder, as `lstat` reports one. */
const fileKind = (kind: "file" | "link" | "dir") => ({
  isFile: () => kind === "file",
  isSymbolicLink: () => kind === "link",
});

/** Windows' realpath over a table of links, the run claim over a set of claimed files, and what each saw. */
function windowsFs(options: { links?: Record<string, string>; claimed?: Set<string>; claimFails?: boolean } = {}) {
  const claims: string[] = [];
  const claimed = options.claimed ?? new Set<string>();
  const links = options.links ?? {};
  const hostEnv = {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    USERPROFILE: "C:\\Users\\Ada",
    SECRET: "x",
  };
  const realpathOf = async (target: string) => {
    const link = Object.keys(links).find((from) => target === from || target.startsWith(`${from}\\`));
    return link ? `${links[link]}${target.slice(link.length)}` : target;
  };
  const windows: NonNullable<GameBoxSeams["windows"]> = {
    hostEnv,
    realpath: realpathOf,
    claimRun: async (file) => {
      claims.push(file);
      if (options.claimFails) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      if (claimed.has(file)) return false;
      claimed.add(file);
      return true;
    },
  };
  return { windows, claims, claimed, hostEnv, realpath: realpathOf };
}

async function windowsBox(
  options: { launcher?: "file" | "link" | "dir" | "absent" | "none"; fs?: ReturnType<typeof windowsFs> } = {},
) {
  const spawned = recordingSpawn();
  const fs = options.fs ?? windowsFs();
  const kind = options.launcher ?? "file";
  const present = kind === "file" || kind === "link" || kind === "dir";
  const sandbox = await box(StudioPlatform.Windows, {
    nativeRunsRoot: WIN_ROOT,
    ...(kind === "none" ? {} : { gameLauncher: LAUNCHER }),
    seams: {
      spawn: spawned.spawn,
      launcherStat: (file) => (file === LAUNCHER && present ? fileKind(kind) : null),
      windows: fs.windows,
    },
  });
  return { sandbox, spawned, fs };
}

describe("a Windows host's game box", () => {
  it("is launcher-missing without a launcher file, and spawns and claims nothing", async () => {
    for (const launcher of ["none", "absent", "link", "dir"] as const) {
      const { sandbox, spawned, fs } = await windowsBox({ launcher });
      assert.equal(sandbox.gameBox(NativeRunMode.Window), GameBoxProblem.LauncherMissing, launcher);
      assert.equal(sandbox.gameBoxAvailable(), false, launcher);
      await assert.rejects(
        sandbox.spawnGame(winRun()),
        refusedWith(NativeRefusal.NoGameBox, GameBoxProblem.LauncherMissing),
      );
      assert.equal(spawned.calls.length, 0, launcher);
      assert.deepEqual(fs.claims, [], launcher);
    }
  });

  it("has a box for a window run with the launcher file, and none for an agent's headless run", async () => {
    const { sandbox } = await windowsBox();
    assert.equal(sandbox.gameBox(NativeRunMode.Window), null);
    assert.equal(sandbox.gameBoxAvailable(), true);
    assert.equal(sandbox.gameBox(NativeRunMode.Headless), GameBoxProblem.NoHeadlessBuild);
    assert.equal(sandbox.gameBoxAvailable(NativeRunMode.Headless), false);
  });

  it("starts the launcher once with planWindowsGameLaunch's argv, hidden, fd 3 overlapped, and a claim first", async () => {
    const { sandbox, spawned, fs } = await windowsBox();
    const game = await sandbox.spawnGame(winRun());
    assert.equal(spawned.calls.length, 1);
    const [call] = spawned.calls;
    const run = winRun();
    const plan = await planWindowsGameLaunch(
      {
        launcher: LAUNCHER,
        runId: WIN_RUN_ID,
        runDir: run.runDir,
        bundle: run.bundle,
        state: run.state,
        exe: "game.exe",
        desktop: LauncherDesktop.Interactive,
        nonce: NONCE,
        memoryBytes: NATIVE_GAME_MEMORY_MAX_BYTES,
      },
      { runsRoot: WIN_ROOT, hostEnv: fs.hostEnv, realpath: fs.realpath },
    );
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.equal(call?.file, LAUNCHER);
    assert.deepEqual(call?.args, plan.launch.args);
    assert.deepEqual(call?.options.stdio, ["ignore", "pipe", "pipe", "overlapped"]);
    assert.equal(call?.options.windowsHide, true);
    assert.deepEqual(fs.claims, [win.join(run.runDir, "launch.claim")]);
    assert.equal(game.pid, call?.child.pid);
    assert.equal(game.fd3, call?.child.stdio[3], "the launcher's fd 3 is the protocol relay");
  });

  it("hands the launcher only SystemRoot, the nonce and the state folder; the per-run pipe is the launcher's to set", async () => {
    const { sandbox, spawned } = await windowsBox();
    await sandbox.spawnGame(winRun());
    await sandbox.spawnGame(winRun(OTHER_WIN_RUN_ID));
    const [first, second] = spawned.calls;
    assert.deepEqual(first?.options.env, {
      SystemRoot: "C:\\Windows",
      [NativeEnv.Nonce]: NONCE,
      [NativeEnv.StateDir]: winRun().state,
    });
    const pipeOf = (call: SpawnCall | undefined) => {
      const args = call?.args ?? [];
      return args[args.indexOf("--pipe") + 1];
    };
    assert.equal(pipeOf(first), launcherPipeName(WIN_RUN_ID));
    assert.equal(pipeOf(second), launcherPipeName(OTHER_WIN_RUN_ID));
    assert.notEqual(pipeOf(first), pipeOf(second), "each run has its own pipe");
    assert.equal(Object.hasOwn(first?.options.env ?? {}, NativeEnv.StudioPipe), false);
  });

  it("hands the launcher GENEX_STUDIO_AI=1 only for a run whose play-time AI the studio answers", async () => {
    const { sandbox, spawned } = await windowsBox();
    await sandbox.spawnGame({ ...winRun(), ai: true });
    await sandbox.spawnGame(winRun(OTHER_WIN_RUN_ID));
    const [answered, plain] = spawned.calls;
    const env: Record<string, string | undefined> = { ...(answered?.options.env ?? {}) };
    assert.equal(env[NativeEnv.StudioAi], NATIVE_STUDIO_AI_ON);
    assert.equal(Object.hasOwn(plain?.options.env ?? {}, NativeEnv.StudioAi), false);
  });

  it("asks the launcher for the person's desktop and the host's memory cap", async () => {
    const { sandbox, spawned } = await windowsBox();
    await sandbox.spawnGame(winRun());
    const args = spawned.calls[0]?.args ?? [];
    assert.equal(args[args.indexOf("--desktop") + 1], LauncherDesktop.Interactive);
    assert.equal(args[args.indexOf("--memory-bytes") + 1], String(NATIVE_GAME_MEMORY_MAX_BYTES));
  });
});

describe("a Windows host's game box: what it refuses before anything starts", () => {
  /** Requests a Windows box must refuse before it spawns anything. */
  const hostile: Array<{
    name: string;
    request: ReturnType<typeof winRun>;
    fs?: () => ReturnType<typeof windowsFs>;
    reason: WindowsLaunchRefusal;
  }> = [
    {
      name: "a run folder that climbs ('..')",
      request: { ...winRun(), runDir: `${WIN_ROOT}\\..\\x` },
      reason: WindowsLaunchRefusal.Path,
    },
    {
      name: "another game's folder as the run folder",
      request: {
        ...winRun(),
        runDir: "C:\\Users\\Ada\\AI Games\\pong",
        bundle: "C:\\Users\\Ada\\AI Games\\pong\\bundle",
        state: "C:\\Users\\Ada\\AI Games\\pong\\state",
        exe: "C:\\Users\\Ada\\AI Games\\pong\\bundle\\game.exe",
      },
      reason: WindowsLaunchRefusal.RunDir,
    },
    {
      name: "a run folder that is a link to another game's folder",
      request: winRun(),
      fs: () => windowsFs({ links: { [winRun().runDir]: "C:\\Users\\Ada\\AI Games\\pong" } }),
      reason: WindowsLaunchRefusal.RunDir,
    },
    {
      name: "a run folder that already holds launch.claim",
      request: winRun(),
      fs: () => windowsFs({ claimed: new Set([win.join(winRun().runDir, "launch.claim")]) }),
      reason: WindowsLaunchRefusal.AlreadyStarted,
    },
    {
      name: "a run folder that cannot be claimed",
      request: winRun(),
      fs: () => windowsFs({ claimFails: true }),
      reason: WindowsLaunchRefusal.ClaimFailed,
    },
    {
      name: "a bundle that is another run's",
      request: { ...winRun(), bundle: win.join(winRun(OTHER_WIN_RUN_ID).runDir, "bundle") },
      reason: WindowsLaunchRefusal.FolderLayout,
    },
  ];

  for (const row of hostile) {
    it(`refuses ${row.name} as the box's own refusal, and spawns nothing`, async () => {
      const { sandbox, spawned } = await windowsBox(row.fs ? { fs: row.fs() } : {});
      // The game must be the request's own bundle's game.exe, so a moved bundle moves it too.
      const request = { ...row.request, exe: win.join(row.request.bundle, "game.exe") };
      await assert.rejects(sandbox.spawnGame(request), (error: unknown) => {
        refusedWith(NativeRefusal.NoGameBox, GameBoxProblem.BoxRefused)(error);
        assert.ok(error instanceof WindowsBoxError);
        assert.equal(error.reason, row.reason);
        return true;
      });
      assert.equal(spawned.calls.length, 0);
    });
  }

  it("refuses a game that is not the bundle's own game.exe, and claims and spawns nothing", async () => {
    for (const exe of [win.join(winRun().bundle, "other.exe"), win.join(winRun().state, "game.exe"), "game.exe"]) {
      const { sandbox, spawned, fs } = await windowsBox();
      await assert.rejects(
        sandbox.spawnGame({ ...winRun(), exe }),
        refusedWith(NativeRefusal.NoGameBox, GameBoxProblem.BoxRefused),
      );
      assert.equal(spawned.calls.length, 0, exe);
      assert.deepEqual(fs.claims, [], exe);
    }
  });
});

describe("a Windows host's game box: refusals and exits as the run's own", () => {
  it("maps every launch refusal onto no-game-box with box-refused, keeping its code and detail", () => {
    for (const reason of Object.values(WindowsLaunchRefusal)) {
      const error = launchRefusalError({ ok: false, refusal: reason, detail: `detail of ${reason}` });
      assert.ok(error instanceof WindowsBoxError);
      assert.ok(error instanceof NativeError);
      assert.equal(error.refusal, NativeRefusal.NoGameBox);
      assert.equal(error.box, GameBoxProblem.BoxRefused);
      assert.equal(error.reason, reason);
      assert.equal(error.message, `detail of ${reason}`);
    }
  });

  it("reads the launcher's exit: a stop is a clean exit, a reserved game code a crash, a launcher failure a refusal", () => {
    const rows: Array<{ code: number | null; expect: "clean" | "crash" | "refused" | "game" }> = [
      { code: 0, expect: "game" },
      { code: 3, expect: "game" },
      { code: null, expect: "game" },
      { code: LAUNCHER_EXIT_CODES[LauncherFailure.Stopped], expect: "clean" },
      // A signed 32-bit reading of the same code reads the same.
      { code: LAUNCHER_EXIT_CODES[LauncherFailure.Stopped] | 0, expect: "clean" },
      { code: LAUNCHER_EXIT_CODES[LauncherFailure.GameReserved], expect: "crash" },
      ...Object.values(LauncherFailure)
        .filter((failure) => failure !== LauncherFailure.Stopped && failure !== LauncherFailure.GameReserved)
        .map((failure) => ({ code: LAUNCHER_EXIT_CODES[failure], expect: "refused" as const })),
    ];
    for (const row of rows) {
      const exit = launcherGameExit({ code: row.code, signal: null });
      const { code, refused } = exit;
      const label = `exit ${row.code}`;
      if (row.expect === "game") assert.deepEqual(exit, { code: row.code, signal: null }, label);
      if (row.expect === "clean") assert.deepEqual(exit, { code: 0, signal: null }, label);
      if (row.expect === "crash") {
        assert.notEqual(code, 0, label);
        assert.equal(refused, undefined, label);
      }
      if (row.expect === "refused") {
        assert.ok(refused instanceof WindowsBoxError, label);
        assert.equal(refused.refusal, NativeRefusal.NoGameBox, label);
        assert.equal(refused.box, GameBoxProblem.BoxRefused, label);
      }
    }
    assert.deepEqual(launcherGameExit({ code: null, signal: "SIGTERM" }), { code: null, signal: "SIGTERM" });
  });

  it("a started game's exit is read through the launcher, and its stops never signal a process group", async () => {
    const { sandbox, spawned } = await windowsBox();
    const game = await sandbox.spawnGame(winRun());
    const launcher = spawned.calls[0]?.child;
    assert.ok(launcher);
    let fd3Ended = false;
    game.fd3.on("finish", () => {
      fd3Ended = true;
    });
    game.fd3.resume();
    game.kill("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fd3Ended, true, "SIGTERM closes fd 3: the launcher's own Stop ends the job");
    assert.deepEqual(launcher.kills, [], "no signal for SIGTERM");
    game.kill("SIGKILL");
    assert.equal(launcher.kills.length, 1, "SIGKILL ends the launcher itself; the job's kill-on-close ends the game");
    launcher.end(LAUNCHER_EXIT_CODES[LauncherFailure.Spawn]);
    const exit = await game.exited;
    assert.ok(exit.refused instanceof WindowsBoxError);
    assert.equal(exit.refused.reason, LauncherFailure.Spawn);
    game.kill("SIGKILL");
    assert.equal(launcher.kills.length, 1, "nothing is signalled once the launcher is reaped");
    assert.equal(spawned.calls.length, 1, "a launcher that exited by itself cleaned up after itself");
  });

  it("a launcher that was killed cannot delete its AppContainer profile: the host runs --delete-profile once", async () => {
    const { sandbox, spawned } = await windowsBox();
    const game = await sandbox.spawnGame(winRun());
    const launcher = spawned.calls[0]?.child;
    assert.ok(launcher);
    game.kill("SIGKILL");
    launcher.end(null, "SIGTERM");
    assert.deepEqual(await game.exited, { code: null, signal: "SIGTERM" });
    assert.equal(spawned.calls.length, 2);
    const cleanup = spawned.calls[1];
    assert.equal(cleanup?.file, LAUNCHER);
    assert.deepEqual(cleanup?.args, ["--delete-profile", "--run-id", WIN_RUN_ID]);
    assert.equal(cleanup?.options.windowsHide, true);
    assert.deepEqual(cleanup?.options.env, { SystemRoot: "C:\\Windows" });
    cleanup?.child.end(0);
  });

  it("dispose ends a running launcher through its own kill, never a process group, and deletes its profile once", async (t) => {
    // Windows reports a launcher killed by pid (not through its ChildProcess) as exit 1, no signal.
    const signalled: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const { sandbox, spawned } = await windowsBox();
    await sandbox.spawnGame(winRun());
    const launcher = spawned.calls[0]?.child;
    assert.ok(launcher);
    t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      signalled.push([pid, signal]);
      if (Math.abs(pid) === launcher.pid) setImmediate(() => launcher.end(1));
      return true;
    });
    const killed = launcher.kill.bind(launcher);
    launcher.kill = (signal?: NodeJS.Signals | number) => {
      setImmediate(() => launcher.end(1));
      return killed(signal);
    };
    await sandbox.dispose();
    assert.deepEqual(signalled, [], "no pid or process group is signalled on Windows");
    assert.equal(launcher.kills.length, 1, "the launcher is ended through its own handle");
    const cleanups = spawned.calls.filter((call) => call.args[0] === "--delete-profile");
    assert.deepEqual(
      cleanups.map((call) => call.args),
      [["--delete-profile", "--run-id", WIN_RUN_ID]],
    );
    for (const call of cleanups) call.child.end(0);
  });

  it("a launcher that ends with a code of no launcher failure (a crash, a kill by pid) has its profile deleted once", async () => {
    for (const code of [1, 0xc0000005]) {
      const { sandbox, spawned } = await windowsBox();
      const game = await sandbox.spawnGame(winRun());
      spawned.calls[0]?.child.end(code);
      assert.deepEqual(await game.exited, { code, signal: null });
      const cleanups = spawned.calls.filter((call) => call.args[0] === "--delete-profile");
      assert.equal(cleanups.length, 1, `exit ${code}`);
      for (const call of cleanups) call.child.end(0);
    }
  });
});

// ── Linux ─────────────────────────────────────────────────────────────────────────────────

const UID = process.getuid?.() ?? 1000;
const BWRAP = "/usr/bin/bwrap";
const LINUX_RUN_ID = "0199a1b2c3d4e5f6";

function stats(kind: "dir" | "file" | "link", uid: number, mode = 0o755): LinuxBoxStats {
  return {
    uid,
    mode,
    rdev: 0,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSocket: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => kind === "link",
  };
}

const SYSTEM_LAYOUT: Readonly<Record<string, { stats: LinuxBoxStats; link?: string; real?: string }>> = {
  "/usr": { stats: stats("dir", 0) },
  "/usr/bin": { stats: stats("dir", 0) },
  [BWRAP]: { stats: stats("file", 0) },
  "/lib": { stats: stats("link", 0), link: "usr/lib", real: "/usr/lib" },
  "/lib64": { stats: stats("link", 0), link: "usr/lib64", real: "/usr/lib64" },
};
/** Folders the fake system owns: anything there it does not list is missing. */
const SYSTEM_PREFIXES = ["/usr/", "/lib", "/dev/", "/sys/"];
const systemOnly = (target: string) => target === "/usr" || SYSTEM_PREFIXES.some((prefix) => target.startsWith(prefix));
const missing = (target: string) => Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });

/** The real file system for the run's folders, with a Linux system layout injected. */
const LINUX_SYSTEM: LinuxBoxSystem = {
  uid: UID,
  async lstat(target) {
    const entry = SYSTEM_LAYOUT[target];
    if (entry) return entry.stats;
    if (systemOnly(target)) throw missing(target);
    return lstat(target);
  },
  async realpath(target) {
    const entry = SYSTEM_LAYOUT[target];
    if (entry) return entry.real ?? target;
    if (systemOnly(target)) throw missing(target);
    return realpath(target);
  },
  async readlink(target) {
    return SYSTEM_LAYOUT[target]?.link ?? readlink(target);
  },
};

const servers: net.Server[] = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A native-runs root with one prepared run (`bundle/game`, the SwiftShader ICD, `state/`), real paths throughout. */
async function linuxRuns() {
  // Short: a Unix socket path has a 104-byte limit on macOS.
  const base = await realpath(await tmpDir("hgb-"));
  const root = path.join(base, "runs");
  const runDir = path.join(root, LINUX_RUN_ID);
  const bundle = path.join(runDir, "bundle");
  const state = path.join(runDir, "state");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await writeFile(path.join(bundle, "game"), "#!game\n", { mode: 0o755 });
  await writeFile(path.join(bundle, "vk_swiftshader_icd.json"), "{}\n");
  const context = path.join(base, "ctx", "wl");
  await mkdir(path.dirname(context), { mode: 0o700 });
  await chmod(path.dirname(context), 0o700);
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(context, () => resolve()));
  const run = {
    runId: LINUX_RUN_ID,
    runDir,
    bundle,
    exe: path.join(bundle, "game"),
    state,
    mode: NativeRunMode.Window,
    nonce: NONCE,
  };
  return { base, root, run, context };
}

/** Every entry under `dir` with a file's bytes or a link's target: what a refusal must leave as it was. */
async function tree(dir: string): Promise<string[]> {
  const listed: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const info = await lstat(full);
    let what = "/";
    if (info.isSymbolicLink()) what = `-> ${await readlink(full)}`;
    else if (info.isFile()) what = await readFile(full, "utf8");
    else if (info.isSocket()) what = "socket";
    listed.push(`${path.relative(dir, full)} ${what}`);
  }
  return listed.sort();
}

/** What a Linux host's box sees: bubblewrap's version, a session, a security-context helper or none. */
interface LinuxFacts {
  version?: string | null;
  session?: Record<string, string>;
  context?: string | null;
  restricted?: boolean;
}

const WAYLAND_SESSION = { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", DISPLAY: ":0" };

async function linuxBox(root: string, facts: LinuxFacts = {}) {
  const spawned = recordingSpawn();
  const versions: number[] = [];
  const context = facts.context;
  const seams: GameBoxSeams = {
    spawn: spawned.spawn,
    bwrap: BWRAP,
    bwrapVersion: () => {
      versions.push(1);
      return facts.version === undefined ? "bubblewrap 0.9.0\n" : facts.version;
    },
    session: facts.session ?? WAYLAND_SESSION,
    renderNodes: async () => [],
    linuxSystem: LINUX_SYSTEM,
    ...(context === undefined ? {} : { waylandContext: async () => context }),
  };
  const sandbox = await box(StudioPlatform.Linux, {
    nativeRunsRoot: root,
    seams,
    usernsRestricted: facts.restricted === true,
  });
  return { sandbox, spawned, versions };
}

describe("a Linux host's game box", () => {
  const rows: Array<{ name: string; facts: LinuxFacts; mode?: NativeRunMode; problem: GameBoxProblem }> = [
    { name: "no bubblewrap", facts: { version: null, context: "/x" }, problem: GameBoxProblem.BubblewrapMissing },
    {
      name: "bubblewrap 0.7 (no --disable-userns)",
      facts: { version: "bubblewrap 0.7.0\n", context: "/x" },
      problem: GameBoxProblem.BubblewrapMissing,
    },
    {
      name: "a bwrap that is not bubblewrap",
      facts: { version: "bwrap: unknown option\n", context: "/x" },
      problem: GameBoxProblem.BubblewrapMissing,
    },
    {
      name: "Ubuntu's user-namespace restriction",
      facts: { restricted: true, context: "/x" },
      problem: GameBoxProblem.UsernsRestricted,
    },
    {
      name: "an X11-only session",
      facts: { session: { DISPLAY: ":0" }, context: "/x" },
      problem: GameBoxProblem.X11Only,
    },
    { name: "no display at all", facts: { session: {}, context: "/x" }, problem: GameBoxProblem.NoWayland },
    {
      name: "Wayland, and no per-run security-context helper in this build",
      facts: {},
      problem: GameBoxProblem.WaylandHelperMissing,
    },
    {
      name: "an agent's headless run, everything else in place",
      facts: { context: "/x" },
      mode: NativeRunMode.Headless,
      problem: GameBoxProblem.NoHeadlessBuild,
    },
    {
      name: "an embedded run, everything else in place",
      facts: { context: "/x" },
      mode: NativeRunMode.Embedded,
      problem: GameBoxProblem.NoHeadlessBuild,
    },
  ];

  for (const row of rows) {
    it(`${row.name} is ${row.problem}, refused typed with nothing spawned or written`, async () => {
      const { base, root, run } = await linuxRuns();
      const { sandbox, spawned } = await linuxBox(root, row.facts);
      const mode = row.mode ?? NativeRunMode.Window;
      assert.equal(sandbox.gameBox(mode), row.problem);
      assert.equal(sandbox.gameBoxAvailable(mode), false);
      const before = await tree(base);
      await assert.rejects(sandbox.spawnGame({ ...run, mode }), refusedWith(NativeRefusal.NoGameBox, row.problem));
      assert.equal(spawned.calls.length, 0);
      assert.deepEqual(await tree(base), before);
    });
  }

  it("checks bubblewrap first, and asks for its version once", async () => {
    const { root } = await linuxRuns();
    const { sandbox, versions } = await linuxBox(root, { version: null, restricted: true, session: {} });
    assert.equal(sandbox.gameBox(NativeRunMode.Window), GameBoxProblem.BubblewrapMissing);
    sandbox.gameBox(NativeRunMode.Window);
    sandbox.gameBoxAvailable();
    assert.equal(versions.length, 1);
  });

  it("reads bubblewrap's version line, and nothing else as one", () => {
    assert.deepEqual(bubblewrapVersion("bubblewrap 0.9.0\n"), { major: 0, minor: 9, patch: 0 });
    assert.deepEqual(bubblewrapVersion("bubblewrap 0.11.0"), { major: 0, minor: 11, patch: 0 });
    assert.deepEqual(bubblewrapVersion("bubblewrap 1.0"), { major: 1, minor: 0, patch: 0 });
    for (const text of [null, "", "bubblewrap", "bubblewrap x.y", "flatpak 1.14.6", "bubblewrap 0.9.0 extra\nmore"]) {
      assert.equal(bubblewrapVersion(text), null, String(text));
    }
  });
});

describe("a Linux host's game box: the start", () => {
  it("with a security-context socket, starts bubblewrap once with linuxGameBoxArgs' argv and the seccomp program on fd 4", async () => {
    const { root, run, context } = await linuxRuns();
    const { sandbox, spawned } = await linuxBox(root, { context });
    assert.equal(sandbox.gameBox(NativeRunMode.Window), null);
    const game = await sandbox.spawnGame(run);
    assert.equal(spawned.calls.length, 1);
    const [call] = spawned.calls;
    const planned = await planLinuxGameBox(
      {
        mode: NativeRunMode.Window,
        bundle: run.bundle,
        exe: run.exe,
        state: run.state,
        nonce: NONCE,
        renderNodes: [],
        softwareIcd: path.join(run.bundle, "vk_swiftshader_icd.json"),
        waylandContext: context,
        audio: LinuxBoxAudio.Muted,
        session: WAYLAND_SESSION,
      },
      LINUX_SYSTEM,
    );
    assert.ok(planned.ok, planned.ok ? "" : planned.detail);
    assert.equal(call?.file, BWRAP);
    assert.deepEqual(call?.args, linuxGameBoxArgs(planned.plan));
    assert.deepEqual(call?.options, {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      env: {},
      detached: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      Buffer.concat(call?.child.seccomp ?? []),
      Buffer.from(linuxGameSeccompProgram({ unixSockets: true })),
    );
    assert.equal(game.fd3, call?.child.stdio[3]);
    assert.ok((await lstat(path.join(run.runDir, "launch.claim"))).isFile(), "the run folder is claimed");
    assert.ok((await lstat(path.join(run.state, "home"))).isDirectory(), "the game's HOME is made in state/");
  });

  it("a Rust game's headless run has a box, and starts bubblewrap with the Rust stack's plan", async () => {
    const { root, run } = await linuxRuns();
    const { sandbox, spawned } = await linuxBox(root, { context: "/x" });
    assert.equal(sandbox.gameBox(NativeRunMode.Headless), GameBoxProblem.NoHeadlessBuild, "raylib: no headless build");
    assert.equal(sandbox.gameBox(NativeRunMode.Headless, GameStack.RustWgpu), null);
    await sandbox.spawnGame({ ...run, mode: NativeRunMode.Headless, stack: GameStack.RustWgpu });
    assert.equal(spawned.calls.length, 1);
    const planned = await planLinuxGameBox(
      {
        mode: NativeRunMode.Headless,
        stack: GameStack.RustWgpu,
        bundle: run.bundle,
        exe: run.exe,
        state: run.state,
        nonce: NONCE,
        renderNodes: [],
        softwareIcd: path.join(run.bundle, "vk_swiftshader_icd.json"),
        waylandContext: null,
        audio: LinuxBoxAudio.Muted,
        session: WAYLAND_SESSION,
      },
      LINUX_SYSTEM,
    );
    assert.ok(planned.ok, planned.ok ? "" : planned.detail);
    assert.deepEqual(spawned.calls[0]?.args, linuxGameBoxArgs(planned.plan));
  });

  it("sets GENEX_STUDIO_AI=1 in the box only for a run whose play-time AI the studio answers", async () => {
    const { root, run } = await linuxRuns();
    const { sandbox, spawned } = await linuxBox(root, { context: "/x" });
    await sandbox.spawnGame({ ...run, mode: NativeRunMode.Headless, stack: GameStack.RustWgpu, ai: true });
    const args = spawned.calls[0]?.args ?? [];
    const at = args.findIndex((arg, index) => arg === "--setenv" && args[index + 1] === NativeEnv.StudioAi);
    assert.ok(at >= 0, "the variable is set");
    assert.equal(args[at + 2], NATIVE_STUDIO_AI_ON);
    const other = await linuxRuns();
    const plain = await linuxBox(other.root, { context: "/x" });
    await plain.sandbox.spawnGame({ ...other.run, mode: NativeRunMode.Headless, stack: GameStack.RustWgpu });
    assert.equal((plain.spawned.calls[0]?.args ?? []).includes(NativeEnv.StudioAi), false);
  });

  it("starts a run folder once: a second start is already-started, and spawns nothing more", async () => {
    const { root, run, context } = await linuxRuns();
    const { sandbox, spawned } = await linuxBox(root, { context });
    await sandbox.spawnGame(run);
    await assert.rejects(sandbox.spawnGame(run), (error: unknown) => {
      refusedWith(NativeRefusal.NoGameBox, GameBoxProblem.BoxRefused)(error);
      assert.ok(error instanceof LinuxBoxError);
      assert.equal(error.reason, LinuxBoxRefusal.AlreadyStarted);
      return true;
    });
    assert.equal(spawned.calls.length, 1);
  });

  it("maps the planner's display refusals onto their own box problem, and every other one onto box-refused", () => {
    const aliased: Partial<Record<LinuxBoxRefusal, GameBoxProblem>> = {
      [LinuxBoxRefusal.X11Only]: GameBoxProblem.X11Only,
      [LinuxBoxRefusal.NoWayland]: GameBoxProblem.NoWayland,
      [LinuxBoxRefusal.WaylandUnrestricted]: GameBoxProblem.WaylandUnrestricted,
    };
    for (const reason of Object.values(LinuxBoxRefusal)) {
      const error = linuxBoxError({ ok: false, refusal: reason, detail: `detail of ${reason}` });
      assert.ok(error instanceof LinuxBoxError);
      assert.equal(error.refusal, NativeRefusal.NoGameBox, reason);
      assert.equal(error.box, aliased[reason] ?? GameBoxProblem.BoxRefused, reason);
      assert.equal(error.reason, reason);
      assert.equal(error.message, `detail of ${reason}`);
    }
  });
});
