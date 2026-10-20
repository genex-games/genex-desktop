/**
 * Native games being played. The launcher owns each game's process: one copy per game, its window
 * found and brought forward, Show game and Quit from the page, everything it started ended on quit,
 * and an earlier Genex's leftover ended at start only while it is still that process. The game
 * sandbox itself is proven from inside with a real app on this Mac: its saves are its home, its
 * install is read-only, the person's Library and the network are out of reach.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runShutdown, shutdownSteps } from "../../src/main/app-lifecycle.ts";
import { canBuildFixtureApp, buildFixtureApp } from "../../src/main/dev/fixture-native-app.ts";
import type { InstallRecord } from "../../src/main/play/native-installs.ts";
import { GAME_QUIT_GRACE_MS, type GameProcess, nativeSessions } from "../../src/main/play/native-launch.ts";
import { hasGameWindow, showGameWindow } from "../../src/main/play/native-windows.ts";
import { psProbe, type JobClock } from "../../src/substrate/job-process.ts";
import { type NativeGameRequest, spawnNativeGame } from "../../src/substrate/plugins/native-process.ts";
import {
  LaunchFailure,
  NativeArch,
  type NativeSession,
  NativeSessionPhase,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const record = (slug: string): InstallRecord => ({
  slug,
  title: "Dust Runners",
  coverUrl: null,
  version: "1.3",
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  bytes: 1,
  installedAt: "2026-10-20T00:00:00.000Z",
  lastPlayedAt: null,
  entry: "Dust Runners.app",
  executable: "Contents/MacOS/FixtureGame",
  bundleId: `games.genex.play.${slug}`,
  bundleName: "Dust Runners",
});

/** A started game the test ends: its exit, its output and the signals it gets. */
class FakeGame extends EventEmitter implements GameProcess {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

/** A clock whose timers fire when the test says. */
function heldClock(): JobClock & { fire(): void } {
  let now = 1_000_000;
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      next++;
      timers.set(next, () => {
        now += ms;
        fn();
      });
      return next;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    fire() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Wait until `done` says what the test waits for has happened. */
async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise<void>((resolve) => setTimeout(resolve, 2));
}

/** A launcher over a temporary folder with fakes for every outside call. */
async function rig(options: { installed?: string[]; windowAfter?: number; spawnFails?: boolean } = {}) {
  const root = await realpath(await tmpDir("native-launch-"));
  const games: FakeGame[] = [];
  const shown: number[] = [];
  const signals: Array<[number, string]> = [];
  const killed: number[] = [];
  const played: string[] = [];
  const ended: string[] = [];
  const logs: string[] = [];
  const pushes: NativeSession[][] = [];
  const starts = new Map<number, string>();
  let looks = 0;
  const clock = heldClock();
  const sessions = nativeSessions({
    root,
    record: async (slug) => ((options.installed ?? ["dust-runners"]).includes(slug) ? record(slug) : null),
    spawn: async (request: NativeGameRequest) => {
      if (options.spawnFails) throw new Error("sandbox-exec refused the profile");
      assert.ok(request.binary.startsWith(path.join(root, "dust-runners", "1.3", "Dust Runners.app")));
      assert.equal(request.saves, path.join(root, "dust-runners", "saves"));
      const game = new FakeGame(4000 + games.length);
      starts.set(game.pid, `start-${game.pid}`);
      games.push(game);
      return game;
    },
    hasWindow: async () => {
      looks++;
      return looks > (options.windowAfter ?? 0);
    },
    show: async (pid) => {
      shown.push(pid);
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
    },
    killTree: async (pid) => {
      killed.push(pid);
    },
    probe: { startTime: async (pid) => starts.get(pid) ?? null },
    clock,
    publish: (state) => pushes.push(state),
    played: async (slug) => {
      played.push(slug);
    },
    ended: async (slug) => {
      ended.push(slug);
    },
    log: (line) => logs.push(line),
  });
  return { sessions, root, games, shown, signals, killed, played, ended, logs, pushes, clock, starts };
}

describe("native game sessions", () => {
  it("starts a game, finds its window, brings it forward and counts it as played", async () => {
    const { sessions, games, shown, played, pushes, clock } = await rig({ windowAfter: 1 });
    await sessions.launch("dust-runners");
    assert.equal(sessions.sessions()[0]?.phase, NativeSessionPhase.Starting);
    await settle();
    assert.equal(sessions.sessions()[0]?.phase, NativeSessionPhase.Starting, "no window yet");
    const looked = () => sessions.sessions()[0]?.phase === NativeSessionPhase.Running;
    while (!looked()) {
      clock.fire();
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(shown, [games[0]?.pid]);
    assert.deepEqual(played, ["dust-runners"]);
    assert.ok(pushes.some((state) => state[0]?.phase === NativeSessionPhase.Running));
  });

  it("runs one copy of a game: a second launch brings the first forward", async () => {
    const { sessions, games, shown } = await rig();
    await sessions.launch("dust-runners");
    await sessions.launch("dust-runners");
    assert.equal(games.length, 1);
    assert.ok(shown.includes(games[0]?.pid ?? -1));
    assert.equal(sessions.playing("dust-runners"), true);
  });

  it("quits a game by its group, kills its tree when it does not end, and forgets it once ended", async () => {
    const polite = await rig();
    await polite.sessions.launch("dust-runners");
    const quitting = polite.sessions.quit("dust-runners");
    const game = polite.games[0];
    assert.ok(game);
    assert.deepEqual(polite.signals, [[-game.pid, "SIGTERM"]]);
    game.exit(0);
    await quitting;
    assert.deepEqual(polite.killed, [], "it ended in time");
    assert.deepEqual(polite.sessions.sessions(), []);
    assert.deepEqual(polite.ended, ["dust-runners"]);
    const stubborn = await rig();
    await stubborn.sessions.launch("dust-runners");
    const stopping = stubborn.sessions.quit("dust-runners");
    await settle();
    stubborn.clock.fire();
    await settle();
    assert.deepEqual(stubborn.killed, [stubborn.games[0]?.pid], `killed after ${GAME_QUIT_GRACE_MS} ms`);
    stubborn.games[0]?.exit(null);
    await stopping;
    assert.equal(stubborn.sessions.playing("dust-runners"), false);
  });

  it("fails a game that quits before its window, logging its last words, not showing them", async () => {
    const { sessions, games, logs } = await rig({ windowAfter: 1000 });
    await sessions.launch("dust-runners");
    games[0]?.stderr.write("dyld: Library not loaded: @rpath/UnityPlayer.dylib\n");
    games[0]?.exit(6);
    await until(() => sessions.sessions()[0]?.phase === NativeSessionPhase.Failed);
    const [failed] = sessions.sessions();
    assert.equal(failed?.phase, NativeSessionPhase.Failed);
    assert.equal(failed?.failure, LaunchFailure.QuitEarly);
    assert.match(logs.join("\n"), /UnityPlayer\.dylib/);
    await sessions.quit("dust-runners");
    assert.deepEqual(sessions.sessions(), [], "a failure is forgotten when dismissed");
  });

  it("fails a game that is not installed or whose sandbox does not start, and leaves no folder", async () => {
    const missing = await rig({ installed: [] });
    await missing.sessions.launch("dust-runners");
    assert.equal(missing.sessions.sessions()[0]?.failure, LaunchFailure.NotInstalled);
    const refused = await rig({ spawnFails: true });
    await refused.sessions.launch("dust-runners");
    assert.equal(refused.sessions.sessions()[0]?.failure, LaunchFailure.StartFailed);
    const left = (await readdir(refused.root)).filter((name) => name.startsWith(".scratch-"));
    assert.deepEqual(left, []);
    await assert.rejects(refused.sessions.launch("../evil"), /not a game address/);
  });

  it("ends every game on quit, and at the next start ends a leftover only while it is the same process", async () => {
    const { sessions, games, signals, root, killed, starts } = await rig({ installed: ["dust-runners", "frigate"] });
    await sessions.launch("dust-runners");
    const stopping = sessions.stopAll();
    assert.deepEqual(signals, [[-(games[0]?.pid ?? 0), "SIGTERM"]]);
    games[0]?.exit(0);
    await stopping;
    const records = path.join(root, ".sessions");
    await mkdir(records, { recursive: true });
    starts.set(7001, "the same start");
    starts.set(7002, "a later start");
    await writeFile(
      path.join(records, "frigate.json"),
      JSON.stringify({ slug: "frigate", pid: 7001, procStart: "the same start" }),
    );
    await writeFile(
      path.join(records, "dust-runners.json"),
      JSON.stringify({ slug: "dust-runners", pid: 7002, procStart: "an earlier start" }),
    );
    await writeFile(path.join(records, "puck-rush.json"), "not json");
    await mkdir(path.join(root, ".scratch-frigate-abc"));
    await sessions.reconcile();
    assert.deepEqual(killed, [7001], "a reused process id is never hit");
    assert.deepEqual(await readdir(records), []);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith(".scratch-")),
      [],
    );
  });
});

describe("quitting Genex", () => {
  it("ends every native game as one of its steps, first", async () => {
    let ended = 0;
    const idle = { release() {}, dismiss() {}, cancel() {}, dispose() {} };
    const games = {
      stopAll: async () => {
        ended++;
      },
    };
    const steps = shutdownSteps({
      keepAwake: idle,
      codexLogin: idle,
      claudeLogin: idle,
      terminals: idle,
      core: null,
      games,
    });
    assert.equal(steps[0]?.name, "end native games");
    assert.deepEqual(await runShutdown(steps, { log: () => {} }), []);
    assert.equal(ended, 1);
  });
});

const SKIP = (await canBuildFixtureApp()) ? false : "needs a Mac with the Xcode toolchain";
const LIVE = process.env.STUDIO_NATIVE_LIVE === "1" ? false : "opens a game window: STUDIO_NATIVE_LIVE=1";

/** A probe line the fixture app prints. */
type Probe = Record<string, unknown> & { step: string };

/** Install the fixture app as `slug` would be, and run its `--probe` in the game sandbox. */
async function probeInSandbox(root: string, slug: string, cache: string): Promise<Probe[]> {
  const versionDir = path.join(root, slug, "1.0");
  await mkdir(versionDir, { recursive: true });
  const app = await buildFixtureApp(
    { title: "Probe Game", bundleId: `games.genex.play.${slug}`, hue: 100, version: "1.0", arch: "arm64" },
    versionDir,
    cache,
  ).catch(async () => path.join(versionDir, "Probe Game.app"));
  const saves = path.join(root, slug, "saves");
  await mkdir(saves, { recursive: true });
  const scratch = path.join(root, `.scratch-${slug}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch);
  const child = await spawnNativeGame({
    binary: path.join(app, "Contents/MacOS/FixtureGame"),
    app,
    saves,
    scratch,
    bundleId: `games.genex.play.${slug}`,
    bundleName: "Probe Game",
    args: ["--probe"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.resume();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Probe);
}

describe("the game sandbox on this Mac", { skip: SKIP }, () => {
  it("makes the saves folder the game's home, keeps its install read-only and the Library and network out", async () => {
    const root = await realpath(await tmpDir("native-sandbox-game-"));
    const slug = `probe-${process.pid}`;
    const cache = path.join(root, ".program");
    try {
      const first = await probeInSandbox(root, slug, cache);
      const step = (lines: Probe[], name: string): Probe => lines.find((line) => line.step === name) ?? { step: name };
      assert.ok(String(step(first, "home").home).endsWith(path.join(slug, "saves")), "Application Support is in saves");
      assert.equal(step(first, "save").plays, 1, "an atomic save is written");
      assert.equal(step(first, "defaults").synced, true, "its own preferences are written");
      assert.equal(step(first, "install").written, false, "its install is read-only");
      assert.equal(step(first, "user-library")?.listed, false, "the person's Library is out of reach");
      assert.equal(step(first, "network").reached, false, "no network");
      assert.ok(step(first, "done"));
      const second = await probeInSandbox(root, slug, cache);
      assert.equal(step(second, "save").plays, 2, "its save is there next time");
      assert.equal(step(second, "defaults").before, 1, "and so are its preferences");
    } finally {
      await rm(path.join(process.env.HOME ?? "", "Library", "Preferences", `games.genex.play.${slug}.plist`), {
        force: true,
      });
    }
  });

  it("plays a real game in its own window, brings it forward and quits it with everything it started", {
    skip: LIVE,
  }, async () => {
    const root = await realpath(await tmpDir("native-live-"));
    const versionDir = path.join(root, "dust-runners", "1.3");
    await mkdir(versionDir, { recursive: true });
    await buildFixtureApp(
      { title: "Dust Runners", bundleId: "games.genex.play.dust-runners", hue: 28, version: "1.3", arch: "arm64" },
      versionDir,
      path.join(root, ".program"),
    );
    const pids: number[] = [];
    const sessions = nativeSessions({
      root,
      record: async (slug) => ({ ...record(slug), version: "1.3" }),
      spawn: async (request) => {
        const child = await spawnNativeGame(request);
        if (child.pid) pids.push(child.pid);
        return child;
      },
      hasWindow: hasGameWindow,
      show: showGameWindow,
      kill: (pid, signal) => process.kill(pid, signal),
      killTree: async (pid) => {
        process.kill(-pid, "SIGKILL");
      },
      probe: psProbe(),
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
      },
      publish: () => undefined,
      played: async () => undefined,
      ended: async () => undefined,
      log: () => undefined,
    });
    await sessions.launch("dust-runners");
    const deadline = Date.now() + 30_000;
    while (sessions.sessions()[0]?.phase !== NativeSessionPhase.Running && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(sessions.sessions()[0]?.phase, NativeSessionPhase.Running, "its window appeared");
    await sessions.quit("dust-runners");
    assert.deepEqual(sessions.sessions(), []);
    for (const pid of pids) assert.equal(running(pid), false, `${pid} ended`);
  });
});
