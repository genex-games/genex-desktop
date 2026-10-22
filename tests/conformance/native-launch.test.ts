/**
 * Native games being played. The launcher owns each game's process: one copy per game, its window
 * found and brought forward, Show game and Quit from the page, everything it started ended on quit,
 * and an earlier Genex's leftover ended at start only while it is still that process. The game
 * sandbox itself is proven from inside with a real app on this Mac: its saves are its home, its
 * install is read-only, the person's Library and the network are out of reach.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
import {
  gameGenexEnv,
  type NativeGameRequest,
  nativeSandboxProfile,
  spawnNativeGame,
} from "../../src/substrate/plugins/native-process.ts";
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
  engine: "unity",
  windowed: false,
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
/** A ticket the fake Genex mints: no log line may carry it. */
const TICKET = "tk_secret_0123456789abcdef";

async function rig(
  options: {
    installed?: string[];
    windowAfter?: number;
    spawnFails?: boolean;
    record?: Partial<InstallRecord>;
    genex?: "open" | "fails";
    /** The game ends as it is brought forward, and bringing it forward returns only once its end is handled. */
    endsOnShow?: boolean;
  } = {},
) {
  const root = await realpath(await tmpDir("native-launch-"));
  const games: FakeGame[] = [];
  const shown: number[] = [];
  const signals: Array<[number, string]> = [];
  const killed: number[] = [];
  const played: string[] = [];
  const ended: string[] = [];
  const reported: string[] = [];
  const logs: string[] = [];
  const pushes: NativeSession[][] = [];
  const starts = new Map<number, string>();
  const requests: NativeGameRequest[] = [];
  let looks = 0;
  const gateways = { opened: [] as string[], closed: 0 };
  const genex = async (slug: string) => {
    if (options.genex === "fails") throw new Error(`no free port for ${slug}`);
    gateways.opened.push(slug);
    return {
      ports: [41000, 41001],
      env: { GENEX_API_URL: "http://127.0.0.1:41000", GENEX_EMBED_TICKET: TICKET },
      close: async () => {
        gateways.closed++;
      },
    };
  };
  const clock = heldClock();
  const sessions = nativeSessions({
    ...(options.genex ? { genex } : {}),
    root,
    record: async (slug) =>
      (options.installed ?? ["dust-runners"]).includes(slug) ? { ...record(slug), ...options.record } : null,
    spawn: async (request: NativeGameRequest) => {
      if (options.spawnFails) throw new Error("sandbox-exec refused the profile");
      requests.push(request);
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
      if (!options.endsOnShow) return;
      games.find((game) => game.pid === pid)?.exit(0);
      await until(() => ended.length > 0);
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
    presence: {
      started: (slug) => reported.push(`started ${slug}`),
      ended: (slug) => reported.push(`ended ${slug}`),
    },
    log: (line) => logs.push(line),
  });
  return {
    sessions,
    root,
    games,
    shown,
    signals,
    killed,
    played,
    ended,
    reported,
    logs,
    pushes,
    clock,
    starts,
    requests,
    gateways,
  };
}

describe("native game sessions", () => {
  it("starts a game, finds its window, brings it forward and counts it as played", async () => {
    const { sessions, games, shown, played, reported, pushes, clock } = await rig({ windowAfter: 1 });
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
    assert.deepEqual(reported, ["started dust-runners"], "genex.games hears of the play once its window is up");
    assert.ok(pushes.some((state) => state[0]?.phase === NativeSessionPhase.Running));
    games[0]?.exit(0);
    await until(() => reported.length === 2);
    assert.deepEqual(reported, ["started dust-runners", "ended dust-runners"]);
  });

  it("opens a game full screen with its engine's own argument, and in a window when its app asks for one", async () => {
    const cases: Array<[Partial<InstallRecord>, string[]]> = [
      [{ engine: "unity" }, ["-screen-fullscreen", "1"]],
      [{ engine: "godot" }, ["--fullscreen"]],
      [{ engine: "unreal" }, ["-fullscreen"]],
      [{ engine: "unity", windowed: true }, []],
      [{ engine: null }, []],
      [{ engine: "gamemaker" }, []],
    ];
    for (const [over, args] of cases) {
      const { sessions, requests } = await rig({ record: over });
      await sessions.launch("dust-runners");
      assert.deepEqual(requests[0]?.args, args, JSON.stringify(over));
    }
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
    const { sessions, games, logs, reported } = await rig({ windowAfter: 1000 });
    await sessions.launch("dust-runners");
    games[0]?.stderr.write("dyld: Library not loaded: @rpath/UnityPlayer.dylib\n");
    games[0]?.exit(6);
    await until(() => sessions.sessions()[0]?.phase === NativeSessionPhase.Failed);
    const [failed] = sessions.sessions();
    assert.equal(failed?.phase, NativeSessionPhase.Failed);
    assert.equal(failed?.failure, LaunchFailure.QuitEarly);
    assert.match(logs.join("\n"), /UnityPlayer\.dylib/);
    assert.deepEqual(reported, [], "a game that never showed a window was not played");
    await sessions.quit("dust-runners");
    assert.deepEqual(sessions.sessions(), [], "a failure is forgotten when dismissed");
  });

  it("reports a game's start before its end, even when it ends as it is brought forward", async () => {
    const { sessions, reported, clock } = await rig({ windowAfter: 1, endsOnShow: true });
    await sessions.launch("dust-runners");
    while (reported.length < 2) {
      clock.fire();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.deepEqual(reported, ["started dust-runners", "ended dust-runners"]);
  });

  it("counts a game still up a minute on as played, though no window of it was seen", async () => {
    const { sessions, played, reported, clock } = await rig({ windowAfter: Number.POSITIVE_INFINITY });
    await sessions.launch("dust-runners");
    while (sessions.sessions()[0]?.phase !== NativeSessionPhase.Running) {
      clock.fire();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.deepEqual(played, ["dust-runners"]);
    assert.deepEqual(reported, ["started dust-runners"]);
  });

  it("never brings forward, plays or counts a game quit while it starts, even as its window appears", async () => {
    const { sessions, games, shown, played, reported, clock } = await rig({ windowAfter: 1 });
    await sessions.launch("dust-runners");
    await settle();
    const quitting = sessions.quit("dust-runners");
    clock.fire();
    await settle();
    await settle();
    games[0]?.exit(0);
    await quitting;
    assert.deepEqual(shown, []);
    assert.deepEqual(played, []);
    assert.deepEqual(reported, []);
    assert.deepEqual(sessions.sessions(), [], "a quit is no failure");
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

describe("a native game's way to Genex", () => {
  it("gives a game its gateway's ports and Genex's address and ticket, and closes the gateway once it ends", async () => {
    const { sessions, games, requests, gateways } = await rig({ genex: "open" });
    await sessions.launch("dust-runners");
    assert.deepEqual(requests[0]?.genex, {
      ports: [41000, 41001],
      env: { GENEX_API_URL: "http://127.0.0.1:41000", GENEX_EMBED_TICKET: TICKET },
    });
    assert.equal(gateways.closed, 0, "open while it plays");
    games[0]?.exit(0);
    await until(() => gateways.closed === 1);
  });

  it("closes the gateway when the game's sandbox doesn't start", async () => {
    const { sessions, gateways } = await rig({ genex: "open", spawnFails: true });
    await sessions.launch("dust-runners");
    assert.equal(sessions.sessions()[0]?.failure, LaunchFailure.StartFailed);
    assert.deepEqual(gateways, { opened: ["dust-runners"], closed: 1 });
  });

  it("plays a game offline when its gateway can't open, and logs no ticket", async () => {
    const { sessions, requests, logs } = await rig({ genex: "fails" });
    await sessions.launch("dust-runners");
    assert.equal(requests.length, 1, "it still starts");
    assert.equal(requests[0]?.genex, undefined, "with no network at all");
    assert.ok(
      logs.some((line) => line.includes("dust-runners")),
      "the reason is logged",
    );
    assert.ok(!logs.some((line) => line.includes(TICKET)));
  });
});

describe("what a game's sandbox and environment take of its way to Genex", () => {
  const good = { GENEX_API_URL: "http://127.0.0.1:41000", GENEX_EMBED_TICKET: "t".repeat(32) };

  it("passes Genex's address and ticket on as they are", () => {
    assert.deepEqual(gameGenexEnv(good), good);
    assert.deepEqual(gameGenexEnv({ GENEX_API_URL: good.GENEX_API_URL }), { GENEX_API_URL: good.GENEX_API_URL });
  });

  it("drops an address that isn't its gateway's, and a ticket that isn't one", () => {
    const addresses = [
      "https://api.genex.games",
      "http://127.0.0.1:80",
      "http://127.0.0.1:41000/api",
      "http://localhost:41000",
      "http://127.0.0.1:41000@evil.test",
      "http://127.0.0.2:41000",
      "http://127.0.0.1:99999",
    ];
    for (const address of addresses)
      assert.deepEqual(gameGenexEnv({ ...good, GENEX_API_URL: address }), {}, `${address}: nothing at all`);
    const tickets = [
      "short",
      "has space in it 0123456789",
      "line\nbreak0123456789abcdef",
      "$(rm -rf ~)0123456789abcdef",
    ];
    for (const ticket of tickets)
      assert.deepEqual(
        gameGenexEnv({ ...good, GENEX_EMBED_TICKET: ticket }),
        { GENEX_API_URL: good.GENEX_API_URL },
        `${ticket}: a guest`,
      );
    assert.deepEqual(gameGenexEnv(undefined), {});
  });

  it("names only unprivileged local ports in its profile, after the network is denied", () => {
    const profile = (genexPorts: number[]) =>
      nativeSandboxProfile({
        binaryRoot: "/Applications/Game.app",
        reads: [],
        writes: [],
        denied: [],
        gpu: true,
        game: { bundleId: "games.genex.play.dust", bundleName: "Dust", userTemp: "/private/var/folders/x", genexPorts },
      });
    const lines = profile([41000, 80, 70000, 1.5, Number.NaN, 41001]).split("\n");
    const deny = lines.indexOf("(deny network*)");
    const allow = lines.findIndex((line) => line.startsWith("(allow network-outbound"));
    assert.ok(deny >= 0 && allow > deny, "the allow narrows the deny, after it");
    assert.equal(lines[allow], '(allow network-outbound (remote ip "localhost:41000") (remote ip "localhost:41001"))');
    assert.ok(!profile([]).includes("network-outbound"), "no gateway, no network at all");
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
async function probeInSandbox(
  root: string,
  slug: string,
  cache: string,
  more: Pick<NativeGameRequest, "genex"> & { args?: string[] } = {},
): Promise<Probe[]> {
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
    args: ["--probe", ...(more.args ?? [])],
    ...(more.genex ? { genex: more.genex } : {}),
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

  it("reaches only its Genex gateway's ports, and is told the gateway and that a ticket waits", async () => {
    const root = await realpath(await tmpDir("native-sandbox-genex-"));
    const slug = `genex-${process.pid}`;
    const listening = async (body: string) => {
      const server = http.createServer((_req, res) => res.writeHead(200).end(body));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return { server, port: (server.address() as AddressInfo).port };
    };
    const gateway = await listening("gateway");
    const other = await listening("other");
    try {
      const lines = await probeInSandbox(root, slug, path.join(root, ".program"), {
        args: [`--other-port=${other.port}`],
        genex: {
          ports: [gateway.port],
          env: { GENEX_API_URL: `http://127.0.0.1:${gateway.port}`, GENEX_EMBED_TICKET: "t".repeat(32) },
        },
      });
      const step = (name: string): Probe => lines.find((line) => line.step === name) ?? { step: name };
      assert.equal(step("genex").status, 200, "its gateway answers");
      assert.equal(step("genex").api, `http://127.0.0.1:${gateway.port}`);
      assert.equal(step("genex").ticket, true, "the ticket is in its environment");
      assert.equal(step("other-local").reached, false, "another port of this Mac stays out");
      assert.equal(step("network").reached, false, "and so does the internet");
    } finally {
      gateway.server.close();
      other.server.close();
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
