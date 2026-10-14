/**
 * The host matrix as a Windows or Linux host meets it (plan M7, D19 = C), with the platform
 * injected: a Mac destination is never built there, the host's own OS runs only through its game
 * box, the other OS is built and labelled but never run, and a run root that is not the run's own
 * folder in the native-runs root is refused before anything starts.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack, type GameProject } from "../../src/shared/game-project.ts";
import { TargetRefusal, runRefusal } from "../../src/shared/game-targets.ts";
import { GameBoxProblem, NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import type { NativePrepareRequest } from "../../src/main/core/native-runs.ts";
import { type GameBoxSeams, type GameSpawnRequest, ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { raylibLanes } from "../helpers/game-lanes.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const HOSTS = [StudioPlatform.Windows, StudioPlatform.Linux] as const;
type CrossHost = (typeof HOSTS)[number];
const OWN_OS = { [StudioPlatform.Windows]: BuildTarget.Windows, [StudioPlatform.Linux]: BuildTarget.Linux } as const;
const OTHER_OS = { [StudioPlatform.Windows]: BuildTarget.Linux, [StudioPlatform.Linux]: BuildTarget.Windows } as const;

describe("what a Windows or Linux host builds and runs", () => {
  for (const host of HOSTS) {
    it(`${host}: a Mac destination is mac-builds-need-a-mac, its own OS needs a box, the other OS is not run`, () => {
      for (const gameBox of [true, false]) {
        assert.equal(runRefusal(host, BuildTarget.Mac, { gameBox }), TargetRefusal.MacBuildsNeedAMac);
        assert.equal(runRefusal(host, OTHER_OS[host], { gameBox }), TargetRefusal.NotRunnableHere);
        assert.equal(runRefusal(host, BuildTarget.Web, { gameBox }), null);
      }
      assert.equal(runRefusal(host, OWN_OS[host], { gameBox: true }), null);
      assert.equal(runRefusal(host, OWN_OS[host], { gameBox: false }), TargetRefusal.NoGameBox);
    });
  }
});

// ── a run's preparation on an injected host ─────────────────────────────────────────────────

const LOCK = { digest: "d84d34a63e45d84d34a63e45d84d34a63e45d84d34a63e45d84d34a63e45d84d" } as unknown as ToolchainLock;

function game(targets: BuildTarget[]): GameProject {
  return {
    name: "pong",
    dir: "/games/pong",
    title: "Pong",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/pong",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    shape: {
      entry: "index.html",
      main: "src/main.cpp",
      build: null,
      install: null,
      own: false,
      kind: "raylib-cpp",
      serve: ".",
    },
    built: false,
    destinations: { stack: GameStack.RaylibCpp, targets },
  } as GameProject;
}

/** A preparation whose every step is recorded; the build ends it, so a row sees how far a run got. */
function prepareDeps(host: CrossHost, gameBox: boolean) {
  const steps: string[] = [];
  const deps: NativePrepareDeps = {
    root: "/runs",
    host,
    gameBox: () => gameBox,
    games: {
      list: async () => [game([BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux])],
      bundleIdFor: async () => "games.genex.game.0123456789ab",
    },
    gameBuilds: raylibLanes({
      ensure: async () => {
        steps.push("build");
        return { ok: false, output: null, lastGood: null, problem: null, ran: true };
      },
    }),
    toolchains: {
      currentLock: async () => LOCK,
      locate: async () => ({ ok: false, missing: [] }),
    } as unknown as NativePrepareDeps["toolchains"],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, steps };
}

async function prepared(host: CrossHost, target: BuildTarget, gameBox: boolean) {
  const { deps, steps } = prepareDeps(host, gameBox);
  const request: NativePrepareRequest = { project: "pong", target, mode: NativeRunMode.Window, runId: "0123456789ab" };
  const refused = await prepareNativeRun(deps, request, new AbortController().signal).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(refused instanceof NativeError, String(refused));
  return { refusal: refused.refusal, steps };
}

describe("a native run on an injected Windows or Linux host", () => {
  for (const host of HOSTS) {
    it(`${host}: a Mac destination is refused not-runnable-here, with nothing built`, async () => {
      const { refusal, steps } = await prepared(host, BuildTarget.Mac, true);
      assert.equal(refusal, NativeRefusal.NotRunnableHere);
      assert.deepEqual(steps, []);
    });

    it(`${host}: its own OS is built when the host has a game box, and no-game-box without one`, async () => {
      const boxed = await prepared(host, OWN_OS[host], true);
      assert.equal(boxed.refusal, NativeRefusal.BuildFailed, "the run reached the build");
      assert.deepEqual(boxed.steps, ["build"]);
      const unboxed = await prepared(host, OWN_OS[host], false);
      assert.equal(unboxed.refusal, NativeRefusal.NoGameBox);
      assert.deepEqual(unboxed.steps, []);
    });

    it(`${host}: the other OS is not-runnable-here, with nothing built`, async () => {
      const { refusal, steps } = await prepared(host, OTHER_OS[host], true);
      assert.equal(refusal, NativeRefusal.NotRunnableHere);
      assert.deepEqual(steps, []);
    });
  }
});

// ── the sandbox's box on an injected host ───────────────────────────────────────────────────

/** A spawn that records each call; nothing here may ever reach it. */
function recordingSpawn() {
  const calls: string[][] = [];
  const spawn: NonNullable<GameBoxSeams["spawn"]> = (file, args) => {
    calls.push([file, ...args]);
    const child = Object.assign(new EventEmitter(), {
      pid: 9001,
      stdio: [null, new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()],
      // Already reaped as far as `dispose` can tell: a fake's pid must never reach a real process.
      exitCode: 0,
      signalCode: null,
      kill: () => true,
    });
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

const sandboxes: ProcessSandbox[] = [];
after(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.dispose()));
});

const WIN_ROOT = "C:\\Users\\Ada\\AppData\\Roaming\\Genex\\native-runs";
const LAUNCHER = "C:\\Program Files\\Genex\\resources\\native\\genex-game-launcher.exe";
const RUN_ID = "0199a1b2c3d4e5f6";
const OTHER_RUN_ID = "aaaabbbbccccdddd";

/** A box on `host` that has everything a window run needs, over `root`; `boxed: false` leaves out the launcher or the security-context helper. */
async function hostBox(
  host: CrossHost,
  root: string,
  options: { boxed?: boolean; links?: Record<string, string> } = {},
) {
  const spawned = recordingSpawn();
  const boxed = options.boxed ?? true;
  const links = options.links ?? {};
  const windowsRealpath = async (target: string) => {
    const link = Object.keys(links).find((from) => target === from || target.startsWith(`${from}\\`));
    return link ? `${links[link]}${target.slice(link.length)}` : target;
  };
  const bwrap = path.join(await realpath(await tmpDir("host-matrix-bwrap-")), "bwrap");
  await writeFile(bwrap, "#!bwrap\n", { mode: 0o755 });
  const seams: GameBoxSeams = {
    spawn: spawned.spawn,
    launcherStat: (file) => (file === LAUNCHER ? { isFile: () => true, isSymbolicLink: () => false } : null),
    windows: { hostEnv: { SystemRoot: "C:\\Windows" }, realpath: windowsRealpath, claimRun: async () => true },
    bwrap,
    bwrapVersion: () => "bubblewrap 0.9.0\n",
    session: { WAYLAND_DISPLAY: "wayland-0" },
    renderNodes: async () => [],
    ...(boxed ? { waylandContext: async () => null } : {}),
  };
  const sandbox = await ProcessSandbox.create({
    writableRoots: [],
    scratchDir: await tmpDir("host-matrix-scratch-"),
    secretPaths: [],
    enabled: false,
    platform: host,
    nativeRunsRoot: root,
    ...(host === StudioPlatform.Windows && boxed ? { gameLauncher: LAUNCHER } : {}),
    linux: { read: () => null },
    gameBoxSeams: seams,
  });
  sandboxes.push(sandbox);
  return { sandbox, spawned };
}

describe("an injected Windows or Linux host's own game box", () => {
  for (const host of HOSTS) {
    it(`${host}: available for Play with the launcher or the security-context helper, and not without`, async () => {
      const root = host === StudioPlatform.Windows ? WIN_ROOT : await tmpDir("host-matrix-runs-");
      assert.equal((await hostBox(host, root)).sandbox.gameBoxAvailable(), true);
      const without = (await hostBox(host, root, { boxed: false })).sandbox;
      assert.equal(without.gameBoxAvailable(), false);
      assert.equal(
        without.gameBox(NativeRunMode.Window),
        host === StudioPlatform.Windows ? GameBoxProblem.LauncherMissing : GameBoxProblem.WaylandHelperMissing,
      );
    });
  }
});

// ── hostile run roots ────────────────────────────────────────────────────────────────────────

/** Every entry under `dir` with a file's bytes or a link's target: what a refusal must leave as it was. */
async function tree(dir: string): Promise<string[]> {
  const listed: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const info = await lstat(full);
    let what = "/";
    if (info.isSymbolicLink()) what = `-> ${await readlink(full)}`;
    else if (info.isFile()) what = await readFile(full, "utf8");
    listed.push(`${path.relative(dir, full)} ${what}`);
  }
  return listed.sort();
}

/** A run laid out under `runDir` with the game named for `host`. */
function runAt(host: CrossHost, runId: string, runDir: string): GameSpawnRequest {
  const join = host === StudioPlatform.Windows ? path.win32.join : (...parts: string[]) => parts.join("/");
  const bundle = join(runDir, "bundle");
  return {
    runId,
    runDir,
    bundle,
    exe: join(bundle, host === StudioPlatform.Windows ? "game.exe" : "game"),
    state: join(runDir, "state"),
    mode: NativeRunMode.Window,
    nonce: "a1b2c3d4e5f60718",
  };
}

/** A real native-runs root and a game folder beside it (bundle, game and state, as a run's), on this disk. */
async function linuxDisk() {
  const base = await realpath(await tmpDir("host-matrix-"));
  const root = path.join(base, "runs");
  const pong = path.join(base, "games", "pong");
  for (const dir of [root, path.join(pong, "bundle"), path.join(pong, "state")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(pong, "bundle", "game"), "#!game\n", { mode: 0o755 });
  await writeFile(path.join(pong, "save.txt"), "the person's own file\n");
  await symlink(pong, path.join(root, RUN_ID));
  const climbing = path.join(base, "x");
  await mkdir(path.join(climbing, "bundle"), { recursive: true });
  await mkdir(path.join(climbing, "state"));
  return { base, root, pong, climbing };
}

describe("hostile run roots on an injected Windows or Linux host spawn nothing", () => {
  it("linux: '../x', a link to another game's folder, and another game's folder are refused, nothing written", async () => {
    const disk = await linuxDisk();
    const { sandbox, spawned } = await hostBox(StudioPlatform.Linux, disk.root);
    const rows: Array<[string, GameSpawnRequest]> = [
      ["'../x'", runAt(StudioPlatform.Linux, "x", `${disk.root}/../x`)],
      [
        "'../runs/<id>' (not normalized)",
        runAt(StudioPlatform.Linux, OTHER_RUN_ID, `${disk.root}/../runs/${OTHER_RUN_ID}`),
      ],
      [
        "a run folder that is a link to another game's folder",
        runAt(StudioPlatform.Linux, RUN_ID, path.join(disk.root, RUN_ID)),
      ],
      ["another game's folder", runAt(StudioPlatform.Linux, RUN_ID, disk.pong)],
      ["a relative run folder", runAt(StudioPlatform.Linux, RUN_ID, `runs/${RUN_ID}`)],
    ];
    const before = await tree(disk.base);
    for (const [name, request] of rows) {
      await assert.rejects(sandbox.spawnGame(request), (error: unknown) => {
        assert.ok(error instanceof NativeError, `${name}: ${String(error)}`);
        assert.equal(error.refusal, NativeRefusal.NoGameBox, name);
        assert.equal(error.box, GameBoxProblem.BoxRefused, name);
        return true;
      });
    }
    assert.equal(spawned.calls.length, 0);
    assert.deepEqual(await tree(disk.base), before, "no claim, no HOME, nothing else");
  });

  it("win32: '..\\x', a link to another game's folder, and another game's folder are refused", async () => {
    const pong = "C:\\Users\\Ada\\AI Games\\pong";
    const { sandbox, spawned } = await hostBox(StudioPlatform.Windows, WIN_ROOT, {
      links: { [path.win32.join(WIN_ROOT, RUN_ID)]: pong },
    });
    const rows: Array<[string, GameSpawnRequest]> = [
      ["'..\\x'", runAt(StudioPlatform.Windows, RUN_ID, `${WIN_ROOT}\\..\\x`)],
      [
        "a run folder that is a link to another game's folder",
        runAt(StudioPlatform.Windows, RUN_ID, path.win32.join(WIN_ROOT, RUN_ID)),
      ],
      ["another game's folder", runAt(StudioPlatform.Windows, RUN_ID, pong)],
      ["a relative run folder", runAt(StudioPlatform.Windows, RUN_ID, `native-runs\\${RUN_ID}`)],
    ];
    for (const [name, request] of rows) {
      await assert.rejects(sandbox.spawnGame(request), (error: unknown) => {
        assert.ok(error instanceof NativeError, `${name}: ${String(error)}`);
        assert.equal(error.refusal, NativeRefusal.NoGameBox, name);
        assert.equal(error.box, GameBoxProblem.BoxRefused, name);
        return true;
      });
    }
    assert.equal(spawned.calls.length, 0);
  });
});
