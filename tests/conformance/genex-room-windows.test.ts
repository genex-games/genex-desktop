/**
 * A local room could not work on Windows: srt-win's egress filter lets a sandboxed process connect
 * only to its proxies' loopback range, machine-wide, and Genex installs it that way
 * (`allowLocalBinding` cannot open loopback for one process there). The room listened on any port,
 * so its own bots, sandboxed with it, could never reach it; its stdin, which ends the room, never
 * reached it either (srt-win does not pass stdin on).
 *
 * Now a room on a fenced loopback names its listeners inside that range, its own clients go to it
 * directly rather than to the sandbox's proxy, and its input goes through the live-input relay.
 * Nothing else is granted: no domain, no loopback beyond the range, the game write-denied. These
 * drive the service over a recording spawn and the srt config a Windows sandbox builds for it, on
 * any machine; tests/conformance/genex-room.test.ts runs the real thing (in the Windows suite).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout as sleep, setImmediate as turn } from "node:timers/promises";
import { GenexRoomService, type RoomStatus } from "../../src/main/core/genex-room.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { ProcessSandbox, type SandboxPolicy } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long an ended process may take to be seen gone; only a failing test waits this long. */
const GONE_WITHIN_MS = 10_000;

const ROOM_JS = "export default { contract: 1, init: () => ({}), onJoin() {}, onLeave() {}, onInput() {}, step() {} };";

/** What the room asked the sandbox for. */
interface SpawnRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  policy?: Partial<SandboxPolicy>;
  liveInput?: boolean;
}

/** What a spawn hands the service: the room's process and its input. */
interface RoomProcess {
  child: ChildProcess;
  input: PassThrough;
}

/** The value after `flag` on a command line of single-quoted or bare words. */
function option(command: string, flag: string): number | null {
  const match = new RegExp(`${flag}'? '?(\\d+)'?`).exec(command);
  return match ? Number(match[1]) : null;
}

/**
 * A room that says it listens on the port its command names (or 41234) and ends once its input
 * closes, as `--stop-on-stdin-close` does. It has no pid: nothing here may signal a real process.
 */
function listeningRoom(command: string): RoomProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const input = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough(), exitCode: null, signalCode: null });
  input.on("finish", () => {
    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0, null);
  });
  input.resume();
  const port = option(command, "--port") ?? 41234;
  queueMicrotask(() => stdout.write(`LISTEN "ws://127.0.0.1:${port}"\n`));
  return { child, input };
}

/**
 * A room the toolchain refuses before it listens: its ERROR line, then its exit (`error` undefined:
 * the exit alone).
 */
function refusedRoom(error?: unknown): RoomProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const input = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough(), exitCode: null, signalCode: null });
  input.resume();
  // A process closes once its output was read to its end.
  stdout.once("end", () => {
    Object.assign(child, { exitCode: 1 });
    child.emit("close", 1, null);
  });
  queueMicrotask(() => stdout.end(error === undefined ? "" : `ERROR ${JSON.stringify(error)}\n`));
  return { child, input };
}

/**
 * A room that is refused its port as it is asked to stop: once its input closes it prints the
 * toolchain's ERROR line and ends.
 */
function refusedOnStop(error: unknown): RoomProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const input = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough(), exitCode: null, signalCode: null });
  stdout.once("end", () => {
    Object.assign(child, { exitCode: 1 });
    child.emit("close", 1, null);
  });
  input.on("finish", () => stdout.end(`ERROR ${JSON.stringify(error)}\n`));
  input.resume();
  return { child, input };
}

/**
 * A real process that never reads its input, as a room on Windows whose input was closed before the
 * live-input relay took it: only the end of its process tree ends it.
 */
function deafRoom(): RoomProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  return { child, input: new PassThrough() };
}

/** What the toolchain says when another program holds the fast@1 port its command names. */
const fastPortTaken = (command: string) => {
  const port = option(command, "--fast-port");
  const detail = `cannot bind the fast@1 UDP endpoint on 127.0.0.1:${port}: bind EADDRINUSE 127.0.0.1:${port}`;
  return { reason: "listen_failed", detail };
};

/**
 * A game with a room, a sandbox built for `platform` (not started), and a service recording its
 * spawns; `room` is what each spawn starts (a room that listens, by default).
 */
async function setup(
  platform: StudioPlatform,
  portFree: (port: number) => boolean = () => true,
  room: (command: string) => RoomProcess | Promise<RoomProcess> = listeningRoom,
) {
  const root = await tmpDir("studio-room-windows-");
  const game = path.join(root, "games", "arena");
  const toolDir = path.join(root, "tool");
  await mkdir(path.join(game, "server"), { recursive: true });
  await mkdir(path.join(toolDir, "dist"), { recursive: true });
  await writeFile(path.join(game, "server", "room.js"), ROOM_JS);
  await writeFile(path.join(game, "index.html"), "<!doctype html>");
  await writeFile(path.join(game, "genex.json"), JSON.stringify({ authority: { module: "server/room.js" } }));
  await writeFile(path.join(toolDir, "dist", "cli.js"), "");
  const sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: path.join(root, "sandbox"),
    secretPaths: [],
    platform,
    enabled: false,
  });
  const spawned: SpawnRequest[] = [];
  const rooms = new GenexRoomService({
    run: () => Promise.reject(new Error("no validation here")),
    spawn: async (request) => {
      spawned.push(request);
      return room(request.command);
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => game,
    loopbackPorts: () => sandbox.loopbackPorts(),
    portFree: async (port) => portFree(port),
  });
  return { rooms, sandbox, spawned, game, binding: { project: "arena", directory: game } };
}

describe("a room on Windows listens where its sandboxed bots may connect, and is granted nothing else", () => {
  it("names its WebSocket and fast@1 ports inside srt-win's loopback range", async () => {
    const { rooms, sandbox, spawned, binding } = await setup(StudioPlatform.Windows);
    const range = sandbox.loopbackPorts();
    assert.ok(range, "Windows fences loopback to a range");
    const started = (await rooms.call({ action: "start", bots: 2 }, binding)) as RoomStatus;
    const command = spawned[0]?.command ?? "";
    const [low, high] = range;
    for (const flag of ["--port", "--fast-port"]) {
      const port = option(command, flag);
      assert.ok(port !== null && port >= low && port <= high, `${flag} ${port} lies in ${low}-${high}`);
    }
    assert.equal(started.url, `ws://127.0.0.1:${option(command, "--port")}`);
    await rooms.stopAll();
  });

  it("asks the Windows sandbox for no domain and no open loopback, writes nothing of the game, and keeps its input", async () => {
    const { rooms, sandbox, spawned, game, binding } = await setup(StudioPlatform.Windows);
    await rooms.call({ action: "start" }, binding);
    const request = spawned[0];
    assert.ok(request);
    assert.deepEqual(request.policy, { denyWrite: [game] }, "the room's own policy only takes the game's writes away");
    const config = sandbox.toRuntimeConfig({ ...sandbox.policy, ...request.policy });
    assert.deepEqual(config.network.allowedDomains, [], "no domain through the proxy");
    assert.equal(config.network.allowLocalBinding, false, "loopback stays the install's, closed");
    assert.ok(config.filesystem.denyWrite.includes(game), "the game is write-denied");
    assert.equal(request.env?.no_proxy, "127.0.0.1", "its clients reach the room directly, only the room's host");
    assert.equal(request.liveInput, true, "its stdin, which ends it, reaches it on Windows");
    await rooms.stopAll();
  });

  it("refuses what a fenced loopback cannot give, and runs nothing", async () => {
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      free: (port: number) => boolean;
      refused: RegExp;
    }> = [
      {
        name: "a delay (the toolchain's delay proxies listen on any port)",
        args: { action: "start", latencyMs: 80 },
        free: () => true,
        refused: /delay/i,
      },
      {
        name: "every port of the range taken",
        args: { action: "start" },
        free: () => false,
        refused: /60080-60089/,
      },
    ];
    for (const { name, args, free, refused } of cases) {
      const { rooms, spawned, binding } = await setup(StudioPlatform.Windows, free);
      await assert.rejects(rooms.call(args, binding), refused, name);
      assert.deepEqual(spawned, [], `${name}: nothing ran`);
      assert.equal(rooms.status(binding.project).running, false);
    }
  });

  it("leaves macOS and Linux rooms on any port, with a delay", async () => {
    for (const platform of [StudioPlatform.Mac, StudioPlatform.Linux]) {
      const { rooms, sandbox, spawned, binding } = await setup(platform);
      assert.equal(sandbox.loopbackPorts(), null, platform);
      await rooms.call({ action: "start", latencyMs: 80 }, binding);
      const command = spawned[0]?.command ?? "";
      assert.equal(option(command, "--port"), null, `${platform}: the room picks its own port`);
      assert.equal(option(command, "--latency"), 80);
      await rooms.stopAll();
    }
  });
});

/** Starts the toolchain refuses: what each spawn does, how many starts it takes, what the last one says. */
const REFUSED_STARTS: Array<{
  name: string;
  platform: StudioPlatform;
  room: (command: string) => RoomProcess;
  starts: number;
  refused: RegExp;
}> = [
  {
    name: "a port taken at every start",
    platform: StudioPlatform.Windows,
    room: (command) => refusedRoom(fastPortTaken(command)),
    starts: 3,
    refused: /did not start: .*EADDRINUSE/,
  },
  {
    name: "a refusal that is no listener's",
    platform: StudioPlatform.Windows,
    room: () => refusedRoom({ reason: "module_failed", detail: "the module threw in init" }),
    starts: 1,
    refused: /did not start: .*module_failed/,
  },
  {
    name: "an error that names no reason",
    platform: StudioPlatform.Windows,
    room: () => refusedRoom("listen_failed"),
    starts: 1,
    refused: /did not start/,
  },
  {
    name: "an exit with no word",
    platform: StudioPlatform.Windows,
    room: () => refusedRoom(),
    starts: 1,
    refused: /did not start: the toolchain exited \(1\)/,
  },
  {
    name: "a listener the room picked itself (macOS names none)",
    platform: StudioPlatform.Mac,
    room: () => refusedRoom({ reason: "listen_failed", detail: "listen EACCES 127.0.0.1" }),
    starts: 1,
    refused: /did not start: .*EACCES/,
  },
];

/** What can be asked of a game's room while a start of it is under way, and how many rooms the ask itself starts. */
const ASKS: Array<{
  name: string;
  ask: (rooms: GenexRoomService, binding: { project: string; directory: string }) => unknown;
  starts: number;
}> = [
  { name: "genex__room stop", ask: (rooms, at) => rooms.call({ action: "stop" }, at), starts: 0 },
  { name: "the studio stopping", ask: (rooms) => rooms.stopAll(), starts: 0 },
  { name: "a later start", ask: (rooms, at) => rooms.call({ action: "start" }, at), starts: 1 },
];

/**
 * Where an ask overtakes a start: at its `nth` process, which either runs and is refused its port
 * as the ask ends it, or is still being started (`starting`) when the ask comes. Each process
 * before it was refused its port.
 */
const OVERTAKEN_AT: Array<{ name: string; nth: number; starting: boolean; refused: RegExp }> = [
  { name: "as its room is refused its port", nth: 1, starting: false, refused: /did not start: .*EADDRINUSE/ },
  {
    name: "as its first room is being started",
    nth: 1,
    starting: true,
    refused: /did not start: it was asked to stop/,
  },
  { name: "as its next room is being started", nth: 2, starting: true, refused: /did not start: it was asked to stop/ },
];

/**
 * A start under way up to `moment`, there for an ask to overtake it: `refused` settles once the
 * start failed as the moment says, `letGo` lets a process that is still being started come up (as
 * `late`, a room that would listen by default), and `children` are the processes started so far.
 */
async function overtaken(
  moment: (typeof OVERTAKEN_AT)[number],
  label: string,
  late: (command: string) => RoomProcess = listeningRoom,
) {
  const children: ChildProcess[] = [];
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let letGo = () => {};
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const roomAt = async (nth: number, command: string): Promise<RoomProcess> => {
    if (nth < moment.nth) return refusedRoom(fastPortTaken(command));
    if (nth > moment.nth) return listeningRoom(command);
    arrive();
    if (!moment.starting) return refusedOnStop(fastPortTaken(command));
    await held;
    return late(command);
  };
  const made = await setup(
    StudioPlatform.Windows,
    () => true,
    async (command) => {
      const room = await roomAt(made.spawned.length, command);
      children.push(room.child);
      return room;
    },
  );
  const refused = assert.rejects(made.rooms.call({ action: "start" }, made.binding), moment.refused, label);
  await arrived;
  await turn();
  return { ...made, refused, children, letGo };
}

describe("a room whose port another program took before the room could listen on it", () => {
  it("starts on other ports when another program took one before the room could listen on it", async () => {
    // The incident: two rooms started at the same moment on one PC. Each found 60089 free for fast@1;
    // the second to open it was refused (EADDRINUSE) and its start failed, with 60088 free.
    const taken = new Set<number>();
    const { rooms, spawned, binding } = await setup(
      StudioPlatform.Windows,
      (port) => !taken.has(port),
      (command) => {
        if (option(command, "--fast-port") !== 60089) return listeningRoom(command);
        taken.add(60089);
        return refusedRoom(fastPortTaken(command));
      },
    );
    const started = (await rooms.call({ action: "start" }, binding)) as RoomStatus;
    assert.deepEqual(
      spawned.map((request) => option(request.command, "--fast-port")),
      [60089, 60088],
      "started again, on a port free by then",
    );
    assert.equal(started.running, true);
    assert.equal(started.url, `ws://127.0.0.1:${option(spawned[1]?.command ?? "", "--port")}`);
    assert.deepEqual(started.errors, [], "the room that runs carries no error of the start before it");
    await rooms.stopAll();
  });

  it("starts again only for a listener Studio named, a few times, and says why the last start failed", async () => {
    for (const { name, platform, room, starts, refused } of REFUSED_STARTS) {
      const { rooms, spawned, binding } = await setup(platform, () => true, room);
      await assert.rejects(rooms.call({ action: "start" }, binding), refused, name);
      assert.equal(spawned.length, starts, `${name}: started ${starts} time(s)`);
      assert.equal(rooms.status(binding.project).running, false, name);
    }
  });

  it("ends a start that a stop or a later start of the game overtook, and leaves no process of it running", async () => {
    // No room comes up behind a stop that already answered "not running", and none takes the place
    // of a later start's room, which nothing would end then.
    for (const moment of OVERTAKEN_AT) {
      for (const { name, ask, starts } of ASKS) {
        const label = `${name}, ${moment.name}`;
        const { rooms, spawned, binding, refused, children, letGo } = await overtaken(moment, label);
        await ask(rooms, binding);
        letGo();
        await refused;
        assert.equal(spawned.length, moment.nth + starts, `${label}: the overtaken start runs nothing more`);
        assert.equal(rooms.status(binding.project).running, starts > 0, label);
        await rooms.stopAll();
        // A process whose input was closed ends on the stream's next tick.
        await turn();
        const running = children.filter((child) => child.exitCode === null).length;
        assert.equal(running, 0, `${label}: every process the game's room started has ended`);
      }
    }
  });

  it("ends an overtaken process that never hears its input close", async () => {
    const starting = OVERTAKEN_AT.find((moment) => moment.starting);
    assert.ok(starting);
    const { rooms, binding, refused, children, letGo } = await overtaken(starting, "a deaf process", deafRoom);
    await rooms.call({ action: "stop" }, binding);
    letGo();
    await refused;
    const [deaf] = children;
    assert.ok(deaf);
    const gone = () => deaf.exitCode !== null || deaf.signalCode !== null;
    try {
      if (!gone()) await Promise.race([once(deaf, "exit"), sleep(GONE_WITHIN_MS, undefined, { ref: false })]);
      assert.equal(gone(), true, "the process itself was ended, not only its input closed");
    } finally {
      deaf.kill("SIGKILL");
    }
  });
});
