/**
 * The Windows game launcher (plan M7, D19 = C), on every platform:
 *  - the TypeScript builder's argv, environment and stdio for `genex-game-launcher.exe`, and its
 *    hostile inputs, each refused with its typed code before anything is claimed or spawned;
 *  - the launcher's own command line, container policy, environment and exit reporting
 *    (native/genex-game-launcher/launch_args.c), built for this machine as `args_probe` with zig,
 *    fed exactly what the builder writes and what a hostile caller could write instead;
 *  - the launcher cross-compiled for x86_64-windows-gnu, its PE imports read with llvm-readobj.
 * Nothing here starts a game: the launcher runs only on Windows (spike S9, a Windows runner).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NativeEnv, NativeRunMode } from "../../src/shared/native-contract.ts";
import {
  DEFAULT_GAME_MEMORY_BYTES,
  GAME_MEMORY_MAX_BYTES,
  GAME_MEMORY_MIN_BYTES,
  LAUNCHER_EXIT_CODES,
  LauncherDesktop,
  LauncherFailure,
  LauncherOutcomeKind,
  WindowsGameEnv,
  type WindowsGameLaunchRequest,
  type WindowsLaunchDeps,
  WindowsLaunchRefusal,
  type WindowsStartDeps,
  classifyLauncherExit,
  launcherDesktopFor,
  planProfileCleanup,
  planWindowsGameLaunch,
  startWindowsGame,
  windowsLaunchDeps,
} from "../../src/substrate/windows-game-launch.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const SOURCE = fileURLToPath(new URL("../../native/genex-game-launcher/", import.meta.url));
const win = path.win32;

const RUN_ID = "0199a1b2c3d47e5f8a9b0c1d2e3f4a5b";
const OTHER_RUN_ID = "0123456789ab";
const ROOT = "C:\\Users\\Ada\\AppData\\Roaming\\Genex\\native-runs";
const RUN = `${ROOT}\\${RUN_ID}`;
const BUNDLE = `${RUN}\\bundle`;
const STATE = `${RUN}\\state`;
const LAUNCHER = "C:\\Program Files\\Genex\\resources\\native\\genex-game-launcher.exe";
const NONCE = "n0nce-abcdefghijklmnop_0123";
const PIPE = `\\\\.\\pipe\\genex-game-${RUN_ID}`;

/** Windows' own access-mask values (winnt.h), so the policy rows read as the grants they are. */
const WIN = {
  FILE_GENERIC_READ: 0x120089,
  FILE_GENERIC_WRITE: 0x120116,
  FILE_GENERIC_EXECUTE: 0x1200a0,
  DELETE: 0x10000,
  FILE_DELETE_CHILD: 0x40,
  SUB_CONTAINERS_AND_OBJECTS_INHERIT: 3,
} as const;

function request(overrides: Partial<WindowsGameLaunchRequest> = {}): WindowsGameLaunchRequest {
  return {
    launcher: LAUNCHER,
    runId: RUN_ID,
    runDir: RUN,
    bundle: BUNDLE,
    state: STATE,
    exe: "game.exe",
    desktop: LauncherDesktop.Interactive,
    nonce: NONCE,
    ...overrides,
  };
}

/** A path with its longest linked prefix replaced, as a real file system resolves a folder link for everything below it. */
function followLinks(target: string, links: Readonly<Record<string, string>>): string {
  let from = "";
  for (const link of Object.keys(links)) {
    const covers = target === link || target.startsWith(`${link}\\`);
    if (covers && link.length > from.length) from = link;
  }
  return from ? `${links[from]}${target.slice(from.length)}` : target;
}

/** A realpath over a table of links, with some paths missing; it records every call. */
function fakeFs(links: Record<string, string> = {}, missing: readonly string[] = [], runsRoot = ROOT) {
  const calls: string[] = [];
  const deps: WindowsLaunchDeps = {
    runsRoot,
    hostEnv: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\Ada" },
    async realpath(target) {
      calls.push(target);
      if (missing.includes(target)) throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
      return followLinks(target, links);
    },
  };
  return { deps, calls };
}

/** Start deps over `fs` whose claim and spawn record their calls and never touch anything; `claimed` is shared between starts. */
function recordingStart(fs: ReturnType<typeof fakeFs>, claimed = new Set<string>()) {
  const spawns: unknown[][] = [];
  const claims: string[] = [];
  const deps: WindowsStartDeps<{ pid: number }> = {
    ...fs.deps,
    async claimRun(file) {
      claims.push(file);
      if (claimed.has(file)) return false;
      claimed.add(file);
      return true;
    },
    spawn: (...args: unknown[]) => {
      spawns.push(args);
      return { pid: 4242 };
    },
  };
  return { deps, spawns, claims };
}

describe("the launcher invocation", () => {
  it("passes the real run folders, the run's own pipe and profile, the memory limit and the desktop", async () => {
    const plan = await planWindowsGameLaunch(request({ desktop: LauncherDesktop.Hidden }), fakeFs().deps);
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.equal(plan.launch.command, LAUNCHER);
    assert.deepEqual(plan.launch.args, [
      "--run-id",
      RUN_ID,
      "--bundle",
      BUNDLE,
      "--state",
      STATE,
      "--exe",
      "game.exe",
      "--pipe",
      PIPE,
      "--memory-bytes",
      String(DEFAULT_GAME_MEMORY_BYTES),
      "--desktop",
      "hidden",
    ]);
    assert.equal(plan.launch.pipeName, PIPE);
    assert.equal(plan.launch.profileName, `genex.game.${RUN_ID}`);
  });

  it("gives the launcher only SystemRoot and the game's GENEX_* variables; the pipe is the launcher's to name", async () => {
    const plan = await planWindowsGameLaunch(request({ env: { GENEX_SEED: "7" } }), fakeFs().deps);
    assert.ok(plan.ok);
    assert.equal(Object.hasOwn(plan.launch.env, WindowsGameEnv.StudioPipe), false);
    assert.deepEqual(plan.launch.env, {
      SystemRoot: "C:\\Windows",
      [NativeEnv.Nonce]: NONCE,
      [NativeEnv.StateDir]: STATE,
      GENEX_SEED: "7",
    });
  });

  it("hands the protocol over fd 3 opened overlapped, so the launcher can read and write it at once", async () => {
    const plan = await planWindowsGameLaunch(request(), fakeFs().deps);
    assert.ok(plan.ok);
    assert.deepEqual(plan.launch.stdio, ["ignore", "pipe", "pipe", "overlapped"]);
  });

  it("follows links before anything reaches argv: a run root reached through a link is passed by its real path", async () => {
    const realRoot = "D:\\GenexData\\native-runs";
    const plan = await planWindowsGameLaunch(request(), fakeFs({ [ROOT]: realRoot }).deps);
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.equal(plan.launch.args[3], `${realRoot}\\${RUN_ID}\\bundle`);
    assert.equal(plan.launch.args[5], `${realRoot}\\${RUN_ID}\\state`);
    assert.equal(plan.launch.env[NativeEnv.StateDir], `${realRoot}\\${RUN_ID}\\state`);
  });

  it("compares Windows paths case-blind, as NTFS does", async () => {
    const plan = await planWindowsGameLaunch(request(), fakeFs({ [RUN]: RUN.toUpperCase() }).deps);
    assert.ok(plan.ok, JSON.stringify(plan));
  });

  it("takes an explicit memory limit inside its bounds", async () => {
    for (const memoryBytes of [GAME_MEMORY_MIN_BYTES, GAME_MEMORY_MAX_BYTES, 3 * 1024 ** 3]) {
      const plan = await planWindowsGameLaunch(request({ memoryBytes }), fakeFs().deps);
      assert.ok(plan.ok);
      assert.equal(plan.launch.args[11], String(memoryBytes));
    }
  });
});

describe("starting the launcher and cleaning up after it", () => {
  it("puts Play on the person's desktop, and headless and embedded runs on a desktop of their own", () => {
    assert.equal(launcherDesktopFor(NativeRunMode.Window), LauncherDesktop.Interactive);
    assert.equal(launcherDesktopFor(NativeRunMode.Headless), LauncherDesktop.Hidden);
    assert.equal(launcherDesktopFor(NativeRunMode.Embedded), LauncherDesktop.Hidden);
  });

  it("claims the run folder, then starts the launcher through the injected spawn, hidden, with the plan's argv, env and stdio", async () => {
    const recorded = recordingStart(fakeFs());
    const started = await startWindowsGame(request(), recorded.deps);
    assert.ok(started.ok);
    assert.equal(recorded.claims.length, 1);
    assert.equal(win.dirname(recorded.claims[0] ?? ""), RUN);
    assert.equal(recorded.spawns.length, 1);
    const [command, args, options] = recorded.spawns[0] ?? [];
    assert.equal(command, LAUNCHER);
    assert.deepEqual(args, started.launch.args);
    assert.deepEqual(options, {
      env: started.launch.env,
      stdio: ["ignore", "pipe", "pipe", "overlapped"],
      windowsHide: true,
    });
  });

  it("starts a run once: a second start of the same run folder is refused and spawns nothing", async () => {
    const claimed = new Set<string>();
    const first = recordingStart(fakeFs(), claimed);
    assert.ok((await startWindowsGame(request(), first.deps)).ok);
    const second = recordingStart(fakeFs(), claimed);
    const again = await startWindowsGame(request({ desktop: LauncherDesktop.Hidden }), second.deps);
    assert.equal(again.ok || again.refusal, WindowsLaunchRefusal.AlreadyStarted);
    assert.equal(second.spawns.length, 0);
  });

  it("refuses a run whose folder cannot be claimed, and spawns nothing", async () => {
    const recorded = recordingStart(fakeFs());
    const deps = {
      ...recorded.deps,
      claimRun: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    const started = await startWindowsGame(request(), deps);
    assert.equal(started.ok || started.refusal, WindowsLaunchRefusal.ClaimFailed);
    assert.equal(recorded.spawns.length, 0);
  });

  it("claims a run folder on the real file system once, and never through a link left in the claim's place", async () => {
    const dir = await tmpDir("genex-launch-claim-");
    const { claimRun } = windowsLaunchDeps(dir);
    const claim = path.join(dir, "launch.claim");
    assert.equal(await claimRun(claim), true);
    assert.equal(await claimRun(claim), false);
    assert.equal(await readFile(claim, "utf8"), "");
    const elsewhere = path.join(dir, "elsewhere");
    const planted = path.join(dir, "planted.claim");
    await symlink(elsewhere, planted);
    assert.equal(await claimRun(planted), false);
    assert.equal(existsSync(elsewhere), false);
  });

  it("deletes a run's profile with --delete-profile after a launcher that could not clean up", () => {
    const cleanup = planProfileCleanup(LAUNCHER, RUN_ID);
    assert.ok(cleanup.ok);
    assert.deepEqual(cleanup.args, ["--delete-profile", "--run-id", RUN_ID]);
    for (const runId of ["../other", 123456789012 as unknown as string]) {
      const refused = planProfileCleanup(LAUNCHER, runId);
      assert.equal(refused.ok || refused.refusal, WindowsLaunchRefusal.RunId);
    }
  });
});

describe("the launcher's exit status", () => {
  it("is the game's own status unless it is one of the launcher's reserved codes", () => {
    for (const code of [0, 1, 3, 0xc0000005, 0xc0000409]) {
      assert.deepEqual(classifyLauncherExit(code), { kind: LauncherOutcomeKind.Game, code });
    }
    assert.deepEqual(classifyLauncherExit(null), { kind: LauncherOutcomeKind.Game, code: null });
    for (const [failure, code] of Object.entries(LAUNCHER_EXIT_CODES)) {
      assert.deepEqual(classifyLauncherExit(code), { kind: LauncherOutcomeKind.Launcher, failure });
    }
  });

  it("names a game that exited with a reserved code itself, never as the host's own Stop", () => {
    assert.deepEqual(classifyLauncherExit(LAUNCHER_EXIT_CODES[LauncherFailure.GameReserved]), {
      kind: LauncherOutcomeKind.Launcher,
      failure: LauncherFailure.GameReserved,
    });
    assert.notEqual(LAUNCHER_EXIT_CODES[LauncherFailure.GameReserved], LAUNCHER_EXIT_CODES[LauncherFailure.Stopped]);
  });

  it("reads a reserved code given as a signed 32-bit number too", () => {
    const signed = LAUNCHER_EXIT_CODES[LauncherFailure.Stopped] | 0;
    assert.ok(signed < 0);
    assert.deepEqual(classifyLauncherExit(signed), {
      kind: LauncherOutcomeKind.Launcher,
      failure: LauncherFailure.Stopped,
    });
  });
});

/** One hostile input: what it changes, and the refusal it must get. */
interface HostileRow {
  name: string;
  change: Partial<WindowsGameLaunchRequest>;
  refusal: WindowsLaunchRefusal;
  links?: Record<string, string>;
  missing?: string[];
  runsRoot?: string;
}

/** A request field set to a value of the wrong type, as a malformed `native.*` parameter could carry it. */
const wrongType = (change: Record<string, unknown>) => change as Partial<WindowsGameLaunchRequest>;

const LONG_FOLDER = `C:\\${"a".repeat(256)}\\run`;
const HOSTILE_RUN_IDS = [
  "",
  "A",
  "-run",
  "run/1",
  "run\\1",
  "../run",
  "run 1",
  "rün",
  "run.1",
  "r".repeat(49),
  "0199a1b2-c3d4-7e5f",
  "0123456789AB",
  "0123456789a",
  "0".repeat(33),
  "g123456789ab",
];

/** Variables a caller could try to hand the game, each refused. */
const HOSTILE_ENVS: Record<string, string>[] = [
  { PATH: "C:\\evil" },
  { genex_lower: "1" },
  { [WindowsGameEnv.StudioPipe]: "\\\\.\\pipe\\someone-else" },
  { [NativeEnv.Nonce]: "another-nonce-0123456789" },
  { [NativeEnv.StateDir]: "C:\\Users\\Ada" },
  { [NativeEnv.StudioFd]: "3" },
  { GENEX_X: "a\u0000b" },
  { GENEX_X: "x".repeat(4097) },
];

/** A whole run folder and its two folders, somewhere else. */
const runAt = (runDir: string) => ({ runDir, bundle: `${runDir}\\bundle`, state: `${runDir}\\state` });

const HOSTILE: HostileRow[] = [
  ...HOSTILE_RUN_IDS.map((runId) => ({
    name: `run id ${JSON.stringify(runId)}`,
    change: { runId },
    refusal: WindowsLaunchRefusal.RunId,
  })),
  {
    name: "a relative launcher",
    change: { launcher: "genex-game-launcher.exe" },
    refusal: WindowsLaunchRefusal.Launcher,
  },
  {
    name: "a launcher on a share",
    change: { launcher: "\\\\server\\share\\genex-game-launcher.exe" },
    refusal: WindowsLaunchRefusal.Launcher,
  },
  {
    name: "a launcher that is not an exe",
    change: { launcher: "C:\\Genex\\launcher.bat" },
    refusal: WindowsLaunchRefusal.Launcher,
  },
  { name: "a relative run folder", change: { runDir: "native-runs\\x" }, refusal: WindowsLaunchRefusal.Path },
  { name: "a run folder on a share", change: { runDir: "\\\\server\\share\\run" }, refusal: WindowsLaunchRefusal.Path },
  { name: "a device-namespace bundle", change: { bundle: `\\\\?\\${BUNDLE}` }, refusal: WindowsLaunchRefusal.Path },
  {
    name: "a pipe as the state folder",
    change: { state: "\\\\.\\pipe\\genex-game-x" },
    refusal: WindowsLaunchRefusal.Path,
  },
  { name: "forward slashes", change: { bundle: BUNDLE.replaceAll("\\", "/") }, refusal: WindowsLaunchRefusal.Path },
  { name: "a trailing separator", change: { state: `${STATE}\\` }, refusal: WindowsLaunchRefusal.Path },
  { name: "a dot segment", change: { bundle: `${RUN}\\.\\bundle` }, refusal: WindowsLaunchRefusal.Path },
  { name: "a dot-dot segment", change: { state: `${RUN}\\bundle\\..\\state` }, refusal: WindowsLaunchRefusal.Path },
  { name: "a trailing dot Windows would strip", change: { bundle: `${BUNDLE}.` }, refusal: WindowsLaunchRefusal.Path },
  { name: "an alternate data stream", change: { state: `${STATE}:hidden` }, refusal: WindowsLaunchRefusal.Path },
  { name: "a control character", change: { bundle: `${RUN}\\bun\ndle` }, refusal: WindowsLaunchRefusal.Path },
  { name: "a quote", change: { bundle: `${RUN}\\bun"dle` }, refusal: WindowsLaunchRefusal.Path },
  { name: "a path over MAX_PATH", change: { runDir: LONG_FOLDER }, refusal: WindowsLaunchRefusal.Path },
  { name: "a drive root as the run folder", change: { runDir: "C:\\" }, refusal: WindowsLaunchRefusal.Path },
  { name: "a relative runs root", change: {}, runsRoot: "native-runs", refusal: WindowsLaunchRefusal.Path },
  {
    name: "a runs root that does not resolve",
    change: {},
    missing: [ROOT],
    refusal: WindowsLaunchRefusal.Unresolvable,
  },
  {
    name: "a run folder outside the runs root",
    change: runAt(`C:\\Users\\Ada\\${RUN_ID}`),
    refusal: WindowsLaunchRefusal.OutsideRunRoot,
  },
  {
    name: "a run folder whose parent links out of the runs root",
    change: runAt(`C:\\Users\\Ada\\runs\\${RUN_ID}`),
    links: { "C:\\Users\\Ada\\runs": "C:\\Users\\Ada\\Documents" },
    refusal: WindowsLaunchRefusal.OutsideRunRoot,
  },
  {
    name: "a run folder named for another run",
    change: runAt(`${ROOT}\\${OTHER_RUN_ID}`),
    refusal: WindowsLaunchRefusal.RunDir,
  },
  {
    name: "a person's own folders as the run (their Desktop and Documents)",
    change: {
      runDir: "C:\\Users\\Ada",
      bundle: "C:\\Users\\Ada\\Desktop",
      state: "C:\\Users\\Ada\\Documents",
      exe: "evil.exe",
    },
    refusal: WindowsLaunchRefusal.RunDir,
  },
  {
    name: "a run folder that is a link out of the runs root",
    change: {},
    links: { [RUN]: `D:\\elsewhere\\${RUN_ID}` },
    refusal: WindowsLaunchRefusal.RunDir,
  },
  {
    name: "a run folder that is a link onto another run",
    change: {},
    links: { [RUN]: `${ROOT}\\${OTHER_RUN_ID}` },
    refusal: WindowsLaunchRefusal.RunDir,
  },
  { name: "a bundle named other", change: { bundle: `${RUN}\\other` }, refusal: WindowsLaunchRefusal.FolderLayout },
  {
    name: "the person's Documents as the state",
    change: { state: "C:\\Users\\Ada\\Documents" },
    refusal: WindowsLaunchRefusal.FolderLayout,
  },
  {
    name: "a bundle that is a junction out of the run",
    change: {},
    links: { [BUNDLE]: "C:\\Users\\Ada\\Documents" },
    refusal: WindowsLaunchRefusal.FolderLayout,
  },
  {
    name: "a state folder that resolves onto the bundle",
    change: {},
    links: { [STATE]: BUNDLE },
    refusal: WindowsLaunchRefusal.FolderLayout,
  },
  {
    name: "a bundle nested in the state folder",
    change: { bundle: `${STATE}\\bundle` },
    refusal: WindowsLaunchRefusal.FolderLayout,
  },
  {
    name: "a state folder nested in the bundle",
    change: { state: `${BUNDLE}\\state` },
    refusal: WindowsLaunchRefusal.FolderLayout,
  },
  { name: "the run folder itself as the state", change: { state: RUN }, refusal: WindowsLaunchRefusal.FolderLayout },
  {
    name: "a game that links out to the system",
    change: {},
    links: { [`${BUNDLE}\\game.exe`]: "C:\\Windows\\System32\\cmd.exe" },
    refusal: WindowsLaunchRefusal.OutsideRunRoot,
  },
  {
    name: "a game that links to another file in the bundle",
    change: {},
    links: { [`${BUNDLE}\\game.exe`]: `${BUNDLE}\\other.exe` },
    refusal: WindowsLaunchRefusal.OutsideRunRoot,
  },
  {
    name: "a real path on a share",
    change: {},
    links: { [STATE]: "\\\\server\\share\\state" },
    refusal: WindowsLaunchRefusal.Path,
  },
  { name: "a missing bundle", change: {}, missing: [BUNDLE], refusal: WindowsLaunchRefusal.Unresolvable },
  { name: "a missing game", change: {}, missing: [`${BUNDLE}\\game.exe`], refusal: WindowsLaunchRefusal.Unresolvable },
  ...[
    "",
    "game",
    "..\\game.exe",
    "sub\\game.exe",
    "/game.exe",
    ".exe",
    "-game.exe",
    "game.exe ",
    "game.bat",
    `${"g".repeat(61)}.exe`,
  ].map((exe) => ({ name: `game ${JSON.stringify(exe)}`, change: { exe }, refusal: WindowsLaunchRefusal.Exe })),
  ...[
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    GAME_MEMORY_MIN_BYTES - 1,
    GAME_MEMORY_MAX_BYTES + 1,
    2 ** 60,
  ].map((memoryBytes) => ({
    name: `memory ${memoryBytes}`,
    change: { memoryBytes },
    refusal: WindowsLaunchRefusal.Memory,
  })),
  ...["", "short", "has space in it ok?", `${"n".repeat(129)}`].map((nonce) => ({
    name: `nonce ${JSON.stringify(nonce.slice(0, 20))}`,
    change: { nonce },
    refusal: WindowsLaunchRefusal.Nonce,
  })),
  ...HOSTILE_ENVS.map((env) => ({
    name: `env ${Object.keys(env).join()}`,
    change: { env },
    refusal: WindowsLaunchRefusal.Env,
  })),
  {
    name: "an unknown desktop",
    change: wrongType({ desktop: "visible" }),
    refusal: WindowsLaunchRefusal.Desktop,
  },
  // Values of the wrong type, as a malformed request could carry them: each a typed refusal, never a throw.
  { name: "a numeric run id", change: wrongType({ runId: 123456789012 }), refusal: WindowsLaunchRefusal.RunId },
  { name: "a numeric launcher", change: wrongType({ launcher: 1 }), refusal: WindowsLaunchRefusal.Launcher },
  { name: "a run folder that is a list", change: wrongType({ runDir: [RUN] }), refusal: WindowsLaunchRefusal.Path },
  { name: "a numeric bundle", change: wrongType({ bundle: 7 }), refusal: WindowsLaunchRefusal.Path },
  { name: "a boolean state", change: wrongType({ state: true }), refusal: WindowsLaunchRefusal.Path },
  { name: "a game that is an object", change: wrongType({ exe: {} }), refusal: WindowsLaunchRefusal.Exe },
  {
    name: "a memory limit given as text",
    change: wrongType({ memoryBytes: "4294967296" }),
    refusal: WindowsLaunchRefusal.Memory,
  },
  { name: "a numeric nonce", change: wrongType({ nonce: 5 }), refusal: WindowsLaunchRefusal.Nonce },
  { name: "a null desktop", change: wrongType({ desktop: null }), refusal: WindowsLaunchRefusal.Desktop },
  { name: "a numeric variable", change: wrongType({ env: { GENEX_X: 5 } }), refusal: WindowsLaunchRefusal.Env },
  { name: "variables given as a list", change: wrongType({ env: ["GENEX_X=1"] }), refusal: WindowsLaunchRefusal.Env },
  { name: "variables given as text", change: wrongType({ env: "GENEX_X=1" }), refusal: WindowsLaunchRefusal.Env },
  { name: "null variables", change: wrongType({ env: null }), refusal: WindowsLaunchRefusal.Env },
];

describe("hostile launch requests", () => {
  for (const row of HOSTILE) {
    it(`refuses ${row.name}, and claims and spawns nothing`, async () => {
      const recorded = recordingStart(fakeFs(row.links, row.missing, row.runsRoot));
      const started = await startWindowsGame(request(row.change), recorded.deps);
      assert.equal(started.ok, false, JSON.stringify(started));
      assert.equal(started.ok || started.refusal, row.refusal);
      assert.equal(recorded.claims.length, 0);
      assert.equal(recorded.spawns.length, 0);
    });
  }

  it("refuses a request that is not an object, and claims and spawns nothing", async () => {
    for (const value of [null, "run", 7]) {
      const recorded = recordingStart(fakeFs());
      const started = await startWindowsGame(value as unknown as WindowsGameLaunchRequest, recorded.deps);
      assert.equal(started.ok || started.refusal, WindowsLaunchRefusal.Request);
      assert.equal(recorded.claims.length + recorded.spawns.length, 0);
    }
  });

  it("refuses a lexically bad request before resolving any path", async () => {
    for (const change of [
      { bundle: `${RUN}\\..\\elsewhere` },
      runAt(`${ROOT}\\${OTHER_RUN_ID}`),
      { bundle: `${RUN}\\x` },
    ]) {
      const fs = fakeFs();
      const plan = await planWindowsGameLaunch(request(change), fs.deps);
      assert.equal(plan.ok, false);
      assert.deepEqual(fs.calls, []);
    }
  });
});

/** What args_probe prints for one command line. */
type ProbeResult =
  | {
      ok: true;
      mode: string;
      runId: string;
      bundle?: string;
      state?: string;
      exe?: string;
      pipe?: string;
      memoryBytes?: number;
      desktop?: string;
    }
  | { ok: false; error: string; flag: string | null };

/** The zig-built probe's path, set once by the suite that builds it. */
let probePath = "";

async function probe(args: readonly string[]): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(probePath, [...args]);
    return JSON.parse(stdout);
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    if (failed.code === 1 && typeof failed.stdout === "string") return JSON.parse(failed.stdout);
    throw error;
  }
}

/** The environment for one zig run: its caches under `dir`, never the developer's own. */
function zigEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: path.join(dir, "zig-global-cache"),
    ZIG_LOCAL_CACHE_DIR: path.join(dir, "zig-local-cache"),
  };
}

const ZIG_WARNINGS = ["-std=c11", "-Wall", "-Wextra", "-Werror"];
const LAUNCHER_SOURCES = ["launcher.c", "launch_args.c"].map((file) => path.join(SOURCE, file));
const PROBE_SOURCES = ["args_probe.c", "launch_args.c"].map((file) => path.join(SOURCE, file));

/** The argv the builder writes for the default request. */
async function plannedArgs(change: Partial<WindowsGameLaunchRequest> = {}): Promise<string[]> {
  const plan = await planWindowsGameLaunch(request(change), fakeFs().deps);
  assert.ok(plan.ok, JSON.stringify(plan));
  return plan.launch.args;
}

/** The planned argv with one flag's value replaced. */
async function withValue(flag: string, value: string): Promise<string[]> {
  return withValues({ [flag]: value });
}

/** The planned argv with several flags' values replaced. */
async function withValues(values: Readonly<Record<string, string>>): Promise<string[]> {
  const args = await plannedArgs();
  for (const flag of Object.keys(values)) assert.ok(args.includes(flag), flag);
  return args.map((word, index) => values[args[index - 1] ?? ""] ?? word);
}

/** The game's environment the launcher's builder writes for `args`, given the launcher's own `env`. */
async function probeEnvironment(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const { stdout } = await execFileAsync(probePath, ["--env", ...args], { env });
  return JSON.parse(stdout);
}

/** What the launcher reports for a game that exited with `game` after the launcher ended its job with `ended` (0: never). */
async function probeExit(game: number, ended: number): Promise<number> {
  const { stdout } = await execFileAsync(probePath, ["--exit", String(game), String(ended)]);
  return JSON.parse(stdout);
}

/** One command line a hostile caller could write: how it is built and the refusal the launcher gives. */
const ARGV_ROWS: Array<{ name: string; argv: () => Promise<string[]>; error: string }> = [
  {
    name: "a capability request (no flag can grant internetClient)",
    argv: async () => [...(await plannedArgs()), "--capability", "internetClient"],
    error: "unknown-flag",
  },
  {
    name: "a repeated flag",
    argv: async () => [...(await plannedArgs()), "--exe", "game.exe"],
    error: "duplicate-flag",
  },
  { name: "a flag without its value", argv: async () => (await plannedArgs()).slice(0, -1), error: "missing-value" },
  { name: "a missing flag", argv: async () => (await plannedArgs()).slice(0, -2), error: "missing-flag" },
  { name: "another run's pipe", argv: () => withValue("--pipe", "\\\\.\\pipe\\genex-game-other"), error: "bad-pipe" },
  {
    name: "a pipe outside the namespace",
    argv: () => withValue("--pipe", `\\\\.\\pipe\\x\\..\\genex-game-${RUN_ID}`),
    error: "bad-pipe",
  },
  {
    name: "a remote pipe",
    argv: () => withValue("--pipe", `\\\\server\\pipe\\genex-game-${RUN_ID}`),
    error: "bad-pipe",
  },
  { name: "a relative bundle", argv: () => withValue("--bundle", "bundle"), error: "bad-folder" },
  { name: "a UNC state folder", argv: () => withValue("--state", "\\\\server\\share\\state"), error: "bad-folder" },
  { name: "a dot-dot bundle", argv: () => withValue("--bundle", `${RUN}\\..\\bundle`), error: "bad-folder" },
  { name: "a state stream", argv: () => withValue("--state", `${STATE}:x`), error: "bad-folder" },
  { name: "the bundle as the state", argv: () => withValue("--state", BUNDLE.toUpperCase()), error: "folder-layout" },
  { name: "a state inside the bundle", argv: () => withValue("--state", `${BUNDLE}\\state`), error: "folder-layout" },
  { name: "folders of two runs", argv: () => withValue("--state", "C:\\other-run\\state"), error: "folder-layout" },
  {
    name: "folders at a drive root",
    argv: () => withValues({ "--bundle": "C:\\bundle", "--state": "C:\\state" }),
    error: "folder-layout",
  },
  {
    name: "a person's Desktop and Documents",
    argv: () => withValues({ "--bundle": "C:\\Users\\Ada\\Desktop", "--state": "C:\\Users\\Ada\\Documents" }),
    error: "folder-layout",
  },
  {
    name: "the person's Documents as the state",
    argv: () => withValue("--state", "C:\\Users\\Ada\\Documents"),
    error: "folder-layout",
  },
  { name: "a bundle named other", argv: () => withValue("--bundle", `${RUN}\\other`), error: "folder-layout" },
  {
    name: "the folders of another run",
    argv: () =>
      withValues({ "--bundle": `${ROOT}\\${OTHER_RUN_ID}\\bundle`, "--state": `${ROOT}\\${OTHER_RUN_ID}\\state` }),
    error: "folder-layout",
  },
  {
    name: "bundle and state under a folder not named for the run",
    argv: () => withValues({ "--bundle": "C:\\Users\\Ada\\x\\bundle", "--state": "C:\\Users\\Ada\\x\\state" }),
    error: "folder-layout",
  },
  { name: "a game path", argv: () => withValue("--exe", "..\\game.exe"), error: "bad-exe" },
  { name: "a game that is not an exe", argv: () => withValue("--exe", "game.com"), error: "bad-exe" },
  { name: "a memory limit with a sign", argv: () => withValue("--memory-bytes", "+4294967296"), error: "bad-memory" },
  {
    name: "a memory limit with a leading zero",
    argv: () => withValue("--memory-bytes", "04294967296"),
    error: "bad-memory",
  },
  {
    name: "a memory limit past 2^64",
    argv: () => withValue("--memory-bytes", "99999999999999999999"),
    error: "bad-memory",
  },
  { name: "a memory limit below the floor", argv: () => withValue("--memory-bytes", "1048576"), error: "bad-memory" },
  { name: "an unknown desktop", argv: () => withValue("--desktop", "visible"), error: "bad-desktop" },
  {
    name: "a cleanup that also names folders",
    argv: async () => ["--delete-profile", "--run-id", RUN_ID, "--bundle", BUNDLE],
    error: "extra-flag",
  },
];

const codes = LAUNCHER_EXIT_CODES;
/** A game's exit code, the code the launcher ended its job with (0: never), and what the launcher reports. */
const EXIT_ROWS: Array<[game: number, ended: number, reported: number]> = [
  [0, 0, 0],
  [3, 0, 3],
  [0xc0000005, 0, 0xc0000005],
  [5, codes[LauncherFailure.Stopped], 5],
  [codes[LauncherFailure.Stopped], codes[LauncherFailure.Stopped], codes[LauncherFailure.Stopped]],
  [codes[LauncherFailure.PipeClient], codes[LauncherFailure.PipeClient], codes[LauncherFailure.PipeClient]],
  [codes[LauncherFailure.Stopped], 0, codes[LauncherFailure.GameReserved]],
  [codes[LauncherFailure.Grant], 0, codes[LauncherFailure.GameReserved]],
  [codes[LauncherFailure.PipeClient], codes[LauncherFailure.Stopped], codes[LauncherFailure.GameReserved]],
  [0xe04700ff, 0, codes[LauncherFailure.GameReserved]],
];

describe("the launcher's own command line and policy (zig-built args_probe)", { ...needsTools("zig") }, () => {
  before(async () => {
    const zig = devTool("zig");
    if ("skip" in zig) return;
    const dir = await tmpDir("genex-launcher-probe-");
    probePath = path.join(dir, "args_probe");
    await execFileAsync(zig.path, ["cc", ...ZIG_WARNINGS, "-O1", "-o", probePath, ...PROBE_SOURCES], {
      env: zigEnv(dir),
    });
  });

  it("reserves exactly the exit codes the host classifies", async () => {
    const { stdout } = await execFileAsync(probePath, ["--exit-codes"]);
    assert.deepEqual(JSON.parse(stdout), LAUNCHER_EXIT_CODES);
  });

  it("accepts exactly what the builder writes, for both desktops", async () => {
    for (const desktop of Object.values(LauncherDesktop)) {
      const args = await plannedArgs({ desktop, memoryBytes: GAME_MEMORY_MAX_BYTES });
      assert.deepEqual(await probe(args), {
        ok: true,
        mode: "run",
        runId: RUN_ID,
        bundle: BUNDLE,
        state: STATE,
        exe: "game.exe",
        pipe: PIPE,
        memoryBytes: GAME_MEMORY_MAX_BYTES,
        desktop,
      });
    }
  });

  it("accepts the run's own folders in another case, as NTFS names the same folders", async () => {
    const result = await probe(await withValues({ "--bundle": BUNDLE.toUpperCase(), "--state": STATE.toUpperCase() }));
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("accepts the builder's profile cleanup", async () => {
    const cleanup = planProfileCleanup(LAUNCHER, RUN_ID);
    assert.ok(cleanup.ok);
    assert.deepEqual(await probe(cleanup.args), { ok: true, mode: "delete-profile", runId: RUN_ID });
  });

  it("refuses every run id the builder refuses", async () => {
    for (const runId of HOSTILE_RUN_IDS.filter(Boolean)) {
      const result = await probe(await withValue("--run-id", runId));
      assert.deepEqual(result, { ok: false, error: "bad-run-id", flag: "--run-id" }, runId);
    }
  });

  it("gives the container no capabilities, read and execute on the bundle, and read, write and delete on state", async () => {
    const { stdout } = await execFileAsync(probePath, ["--policy"]);
    assert.deepEqual(JSON.parse(stdout), {
      capabilities: [],
      grants: [
        {
          folder: "bundle",
          access: WIN.FILE_GENERIC_READ | WIN.FILE_GENERIC_EXECUTE,
          inheritance: WIN.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
          label: null,
        },
        {
          folder: "state",
          access: WIN.FILE_GENERIC_READ | WIN.FILE_GENERIC_WRITE | WIN.DELETE | WIN.FILE_DELETE_CHILD,
          inheritance: WIN.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
          label: "S:(ML;OICI;NW;;;LW)",
        },
      ],
    });
  });

  it("hands the game Windows' folders, state as its temp and app data, the run's pipe and only the launcher's GENEX_* variables", async () => {
    const entries = await probeEnvironment(await plannedArgs(), {
      [NativeEnv.Nonce]: NONCE,
      GENEX_SEED: "7",
      [WindowsGameEnv.StudioPipe]: "\\\\.\\pipe\\someone-else",
      genex_studio_pipe: "\\\\.\\pipe\\someone-else",
      SystemRoot: "D:\\evil",
      PATH: "/usr/bin",
      HOME: "/Users/ada",
    });
    assert.deepEqual(entries.slice(0, 8), [
      "SystemRoot=C:\\Windows",
      "windir=C:\\Windows",
      "PATH=C:\\Windows\\System32",
      `TEMP=${STATE}`,
      `TMP=${STATE}`,
      `APPDATA=${STATE}`,
      `LOCALAPPDATA=${STATE}`,
      `${WindowsGameEnv.StudioPipe}=${PIPE}`,
    ]);
    assert.deepEqual(entries.slice(8).sort(), ["GENEX_SEED=7", `${NativeEnv.Nonce}=${NONCE}`].sort());
  });

  it("reports a game's own reserved exit code as game-reserved, and only its own job end as the launcher's", async () => {
    for (const [game, ended, reported] of EXIT_ROWS) {
      assert.equal(await probeExit(game, ended), reported, `${game.toString(16)} after ${ended.toString(16)}`);
    }
  });

  for (const row of ARGV_ROWS) {
    it(`refuses ${row.name}`, async () => {
      const result = await probe(await row.argv());
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.ok || result.error, row.error);
    });
  }
});

/** The DLLs and functions one PE imports, as llvm-readobj --coff-imports prints them. */
function parseImports(text: string): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const line of text.split("\n")) {
    const dll = /^\s*Name: (\S+)$/.exec(line);
    const symbol = /^\s*Symbol: (\S+) \(\d+\)$/.exec(line);
    if (dll?.[1]) {
      current = new Set();
      imports.set(dll[1].toLowerCase(), current);
    } else if (symbol?.[1] && current) {
      current.add(symbol[1]);
    }
  }
  return imports;
}

/** The only DLLs the launcher may load at link time: Windows' own, and the Universal CRT. */
const ALLOWED_DLLS = new Set(["kernel32.dll", "advapi32.dll", "userenv.dll", "user32.dll"]);
const UCRT_DLL = /^api-ms-win-crt-[a-z]+-l1-1-0\.dll$/;
/** What the launcher's isolation is made of; a build that lost one of them is not the launcher. */
const REQUIRED_FUNCTIONS: Record<string, readonly string[]> = {
  "userenv.dll": [
    "CreateAppContainerProfile",
    "DeriveAppContainerSidFromAppContainerName",
    "DeleteAppContainerProfile",
  ],
  "advapi32.dll": ["SetEntriesInAclW", "SetNamedSecurityInfoW", "ConvertStringSecurityDescriptorToSecurityDescriptorW"],
  "kernel32.dll": [
    "CreateJobObjectW",
    "SetInformationJobObject",
    "AssignProcessToJobObject",
    "UpdateProcThreadAttribute",
    "CreateProcessW",
    "CreateNamedPipeW",
    "GetNamedPipeClientProcessId",
    "TerminateJobObject",
  ],
};

describe("the launcher cross-compiled for x86_64-windows-gnu", { ...needsTools("zig", "llvmMingw") }, () => {
  it("builds warning-free with zig and imports only Windows' own DLLs, nothing of the network or OpenGL", async () => {
    const zig = devTool("zig");
    const mingw = devTool("llvmMingw");
    if ("skip" in zig || "skip" in mingw) return;
    const dir = await tmpDir("genex-launcher-pe-");
    const exe = path.join(dir, "genex-game-launcher.exe");
    const target = ["-target", "x86_64-windows-gnu", "-municode", "-static", "-O2"];
    const libraries = ["-ladvapi32", "-luserenv"];
    await execFileAsync(zig.path, ["cc", ...target, ...ZIG_WARNINGS, "-o", exe, ...LAUNCHER_SOURCES, ...libraries], {
      env: zigEnv(dir),
    });
    const readobj = path.join(mingw.path, "bin", "llvm-readobj");
    const { stdout } = await execFileAsync(readobj, ["--file-headers", "--coff-imports", exe]);
    assert.match(stdout, /Machine: IMAGE_FILE_MACHINE_AMD64/);
    assert.match(stdout, /Subsystem: IMAGE_SUBSYSTEM_WINDOWS_CUI/);
    const imports = parseImports(stdout.slice(stdout.indexOf("Import {")));
    const foreign = [...imports.keys()].filter((dll) => !ALLOWED_DLLS.has(dll) && !UCRT_DLL.test(dll));
    assert.deepEqual(foreign, []);
    for (const [dll, functions] of Object.entries(REQUIRED_FUNCTIONS)) {
      const imported = imports.get(dll) ?? new Set();
      assert.deepEqual(
        functions.filter((name) => !imported.has(name)),
        [],
        dll,
      );
    }
  });
});
