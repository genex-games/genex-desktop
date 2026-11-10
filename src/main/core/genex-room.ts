/**
 * A server-authoritative game's room on this Mac (`genex__room`): Genex's own room-module
 * toolchain (`@genex-ai/authority-dev`, pinned in the Genex plugin's payload) validates the game's
 * room module, or serves it on 127.0.0.1 with bots, inside ProcessSandbox like every program a game
 * brings. The room reads the game and the toolchain, writes only its own scratch folder, opens no
 * network beyond this Mac's loopback, needs no account and spends nothing.
 *
 * One room per game: starting another ends the last. While it runs, the game's preview (served on
 * its loopback origin) is loaded with the room's address, which the Genex SDK's local test mode
 * takes (`genex_authority_url`), so the person plays in the room the bots are in.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { lstat, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Writable } from "node:stream";
import { SECOND_MS, MINUTE_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { PluginBinding } from "../../shared/plugins.ts";
import { readGenexGameManifest } from "../../substrate/genex-game-manifest.ts";
import { nameRoom, unnameRoom } from "./genex-room-handoff.ts";
import { roomModulePath } from "../../substrate/genex-room-stage.ts";
import { LoopbackProtocol } from "../../substrate/linux-loopback-bridge.ts";
import { containedReal } from "../../substrate/paths.ts";
import { treeKiller } from "../../substrate/plugins/native-process.ts";
import {
  type LoopbackExpose,
  OutputKept,
  type RunRequest,
  type RunResult,
  type SandboxPolicy,
  shellQuote,
} from "../../substrate/spawn.ts";

/** What `genex__room` does. */
export const GenexRoomAction = {
  Validate: "validate",
  Start: "start",
  Status: "status",
  Stop: "stop",
} as const;
/** One of {@link GenexRoomAction}. */
export type GenexRoomAction = (typeof GenexRoomAction)[keyof typeof GenexRoomAction];

/** The toolchain's stdout: one protocol line per event (its README's `start` and `validate`). */
const RoomLine = {
  Listen: "LISTEN",
  Fast: "FAST",
  Report: "REPORT",
  Log: "LOG",
  Error: "ERROR",
  Validate: "VALIDATE",
} as const;
type RoomLine = (typeof RoomLine)[keyof typeof RoomLine];

/** The address the room listens on and its own clients reach it at. */
const ROOM_HOST = "127.0.0.1";
/** The transports a room listens on: its WebSocket and its fast@1 datagrams (the loopback bridge's table). */
export const RoomPortProtocol = LoopbackProtocol;
/** One of {@link RoomPortProtocol}. */
export type RoomPortProtocol = LoopbackProtocol;
/** What went wrong on this computer's side of a running room, kept with its errors. */
const RoomHostFault = { FastUnreachable: "fast_unreachable" } as const;
/** The toolchain's FAST state while its fast@1 channel is on. */
const FAST_ON = "on";

/** The toolchain's command line, inside its package. */
const CLI_IN_PACKAGE = "dist/cli.js";
/** The most bots a local room takes: a room module seats at most 64, a Mac runs a handful well. */
export const ROOM_MAX_BOTS = 8;
/** Bots when the call names none: enough to see a fight. */
const ROOM_DEFAULT_BOTS = 3;
/** The most one-way delay a room adds: a long intercontinental link. */
export const ROOM_MAX_LATENCY_MS = 300;
/** How long a starting room may take to listen before it is ended. */
const ROOM_LISTEN_TIMEOUT_MS = 30 * SECOND_MS;
/** How long validation may take: 30 simulated seconds fuzzed and replayed twice, physics included. */
const ROOM_VALIDATE_TIMEOUT_MS = 5 * MINUTE_MS;
/** How often a running room reports. */
const ROOM_REPORT_EVERY_MS = SECOND_MS;
/** How long this computer waits for the room to answer at its address before it is unreachable. */
const ROOM_REACH_TIMEOUT_MS = 5 * SECOND_MS;
/** How long a stopping room may take to print its last report and exit before it is killed. */
const ROOM_STOP_GRACE_MS = 3 * SECOND_MS;
/** The room's own log lines and errors kept for `status`. */
const ROOM_KEPT_LINES = 20;
/** The most a validation's output is read. */
const ROOM_OUTPUT_MAX_BYTES = 1024 * 1024;
/** Keys a call may carry. */
const CALL_KEYS = new Set(["action", "bots", "latencyMs"]);

const MESSAGE = {
  Action: `genex__room's action is one of ${Object.values(GenexRoomAction).join(", ")}`,
  UnknownKey: (key: string) => `genex__room takes no ${JSON.stringify(key)}`,
  Bots: `bots is a whole number from 0 to ${ROOM_MAX_BOTS}`,
  Latency: `latencyMs is a whole number from 0 to ${ROOM_MAX_LATENCY_MS}`,
  NoRoom:
    'This game declares no room module: put {"authority":{"module":"server/room.js"}} in genex.json (package.json genex.authority for a game with one), with the module in server/',
  NoModule: (module: string) => `The room module ${module} is not a file in this game`,
  NoToolchain: "This build of Genex carries no room-module toolchain",
  NoListen: (detail: string) => `The room did not start: ${detail}`,
  TimedOut: `The room did not start within ${ROOM_LISTEN_TIMEOUT_MS / SECOND_MS} s`,
  Exited: (code: number | null) => `the toolchain exited (${code})`,
  NoVerdict: (detail: string) => `Validation gave no verdict: ${detail}`,
  NoDelay:
    "A room on Windows adds no delay yet: its sandbox lets the room's bots reach only the room's own ports. Start it with latencyMs 0",
  NoFreePort: "This computer has no free loopback port for the room",
  NoPort: (range: readonly [number, number]) =>
    `No port in ${range.join("-")} is free for the room: close another game's room and try again`,
} as const;

/** A validation's verdict, as the toolchain printed it (`passed`, `moduleSha256`, typed `failures`). */
export type RoomVerdict = Record<string, unknown> & { passed: boolean };

/** How a game's room stands. */
export interface RoomStatus {
  running: boolean;
  /** The room's address while it runs (`ws://127.0.0.1:<port>`). */
  url: string | null;
  /** Whether this computer (the preview's side, outside the sandbox) reaches the room at `url`. */
  reachable: boolean;
  /** Whether the game's preview was loaded into the room: never while it is unreachable. */
  previewJoined: boolean;
  /** The room's last REPORT: rooms, players, tick times, faults, bots. */
  report: unknown;
  /** Its last `ctx.log` lines and errors, oldest first. */
  logs: unknown[];
  errors: unknown[];
}

/** One running room. */
interface Room {
  child: ChildProcess;
  input: Writable;
  /** Linux: opens a port of the room's on this computer's loopback; absent where it shares it. */
  expose: LoopbackExpose | undefined;
  url: string | null;
  reachable: boolean;
  /** The game's real folder, where the room is named for an engine's editor while it runs. */
  game: string;
  /** Whether the preview was told the room's address, so is told again when it ends. */
  told: boolean;
  previewJoined: boolean;
  report: unknown;
  logs: unknown[];
  errors: unknown[];
  closed: Promise<void>;
  /** Settles once the room is forgotten and the preview is out of it. */
  ended: Promise<void>;
}

/** What the rooms need: the sandbox, the toolchain and the bound game. */
export interface GenexRoomDeps {
  /** ProcessSandbox's `run`, for a validation. */
  run: (request: RunRequest) => Promise<RunResult>;
  /** ProcessSandbox's `spawnLongLived`, for a room. */
  spawn: (request: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    label?: string;
    policy?: Partial<SandboxPolicy>;
    /** Input written to `input` for the life of the process: on Windows it reaches it only so. */
    liveInput?: boolean;
    /** The process serves on its loopback for this computer: on Linux it is started under the bridge. */
    loopbackServer?: boolean;
  }) => Promise<{ child: ChildProcess; input: Writable; expose?: LoopbackExpose }>;
  /** The pinned `@genex-ai/authority-dev` folder in the Genex plugin's payload. */
  toolDir: string;
  /** Where each run keeps its scratch: never a game. */
  scratch: string;
  /** The bound game's real folder (`genex-bound-game.ts`). */
  boundGame: (binding: PluginBinding) => Promise<string>;
  /** The Node that runs the toolchain: Electron as node in the app. */
  execPath?: string;
  /** Told when a game's room starts (its address) or ends (null); answers whether the preview joined. */
  onRoom?: (project: string, url: string | null) => Promise<boolean>;
  listenTimeoutMs?: number;
  /**
   * The only loopback ports the room's own sandboxed clients may connect to (ProcessSandbox's
   * `loopbackPorts`, Windows'), where it then listens; null or absent where any port is reachable.
   */
  loopbackPorts?: () => readonly [number, number] | null;
  /** Whether this Mac or PC can listen on `port` on loopback now (default: tried and let go). */
  portFree?: (port: number, protocol: RoomPortProtocol) => Promise<boolean>;
  /**
   * Whether the room's loopback is its own (ProcessSandbox's `ownLoopback`, Linux'): its listeners
   * then take ports free on this computer's loopback too, where the bridge opens them.
   */
  ownLoopback?: () => boolean;
  /** Whether this computer gets an answer from the room at its address (default: an HTTP request). */
  reaches?: (url: string) => Promise<boolean>;
}

/** A call's checked arguments. */
interface RoomCall {
  action: GenexRoomAction;
  bots: number;
  latencyMs: number;
}

const isWhole = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/** The call checked whole: its action, and for a start its bots and delay. */
export function roomCall(args: Record<string, unknown>): RoomCall {
  const unknown = Object.keys(args).find((key) => !CALL_KEYS.has(key));
  if (unknown !== undefined) throw new Error(MESSAGE.UnknownKey(unknown));
  const action = Object.values(GenexRoomAction).find((value) => value === args.action);
  if (!action) throw new Error(MESSAGE.Action);
  const bots = args.bots ?? ROOM_DEFAULT_BOTS;
  const latencyMs = args.latencyMs ?? 0;
  if (!isWhole(bots, ROOM_MAX_BOTS)) throw new Error(MESSAGE.Bots);
  if (!isWhole(latencyMs, ROOM_MAX_LATENCY_MS)) throw new Error(MESSAGE.Latency);
  return { action, bots, latencyMs };
}

/** A protocol line's kind and its JSON (or text) value; null for any other line. */
export function roomLine(line: string): { kind: RoomLine; value: unknown } | null {
  const space = line.indexOf(" ");
  const head = space === -1 ? line : line.slice(0, space);
  const kind = Object.values(RoomLine).find((value) => value === head);
  if (!kind) return null;
  const rest = space === -1 ? "" : line.slice(space + 1).trim();
  try {
    return { kind, value: JSON.parse(rest) };
  } catch {
    return { kind, value: rest };
  }
}

/** Whether a listener on `port` of {@link ROOM_HOST} can open now: opened and closed again. */
export async function loopbackPortFree(port: number, protocol: RoomPortProtocol): Promise<boolean> {
  if (protocol === RoomPortProtocol.Udp) {
    const socket = createSocket("udp4");
    const bound = await new Promise<boolean>((resolve) => {
      socket.once("error", () => resolve(false));
      socket.bind(port, ROOM_HOST, () => resolve(true));
    });
    if (bound) await new Promise<void>((resolve) => socket.close(() => resolve()));
    return bound;
  }
  const server = createServer();
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ port, host: ROOM_HOST, exclusive: true }, () => resolve(true));
  });
  if (listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  return listening;
}

/** A port of {@link ROOM_HOST} free for `protocol` now: the system's pick, opened and closed again. */
export async function anyLoopbackPort(protocol: RoomPortProtocol): Promise<number> {
  if (protocol === RoomPortProtocol.Udp) {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, ROOM_HOST, () => resolve());
    });
    const { port } = socket.address();
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    return port;
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, ROOM_HOST, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error(MESSAGE.NoFreePort);
  return address.port;
}

/** Whether the room at `url` answers an HTTP request from this process, within {@link ROOM_REACH_TIMEOUT_MS}. */
export function roomAnswers(url: string): Promise<boolean> {
  const target = URL.canParse(url) ? new URL(url) : null;
  if (!target?.port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const request = http.get(
      { host: target.hostname, port: target.port, path: "/", agent: false, timeout: ROOM_REACH_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

/** The room's listeners where loopback is fenced: its WebSocket (TCP) and fast@1 (UDP) ports. */
interface RoomPorts {
  port: number;
  fastPort: number;
}

/** Keep the last {@link ROOM_KEPT_LINES} of `list`. */
const keep = (list: unknown[], value: unknown) => {
  list.push(value);
  if (list.length > ROOM_KEPT_LINES) list.splice(0, list.length - ROOM_KEPT_LINES);
};

/** The game's local rooms, each in the sandbox, one per game. */
export class GenexRoomService {
  readonly #deps: GenexRoomDeps;
  readonly #rooms = new Map<string, Room>();
  /** The studio is stopping: its preview goes with it, so no room reloads it on the way out. */
  #closing = false;
  constructor(deps: GenexRoomDeps) {
    this.#deps = deps;
  }

  /** `genex__room`: the call checked, then run for the bound game. */
  async call(args: Record<string, unknown>, binding: PluginBinding): Promise<unknown> {
    const call = roomCall(args);
    if (call.action === GenexRoomAction.Status) return this.status(binding.project);
    if (call.action === GenexRoomAction.Stop) return this.stop(binding.project);
    const game = await this.#deps.boundGame(binding);
    const module = await this.#module(game);
    if (call.action === GenexRoomAction.Validate) return this.#validate(game, module);
    return this.#start(binding.project, game, module, call);
  }

  /** How the game's room stands. */
  status(project: string): RoomStatus {
    const room = this.#rooms.get(project);
    if (!room)
      return { running: false, url: null, reachable: false, previewJoined: false, report: null, logs: [], errors: [] };
    const { url, reachable, previewJoined, report, logs, errors } = room;
    return { running: true, url, reachable, previewJoined, report, logs: [...logs], errors: [...errors] };
  }

  /** End the game's room: its last report, then its process tree. */
  async stop(project: string): Promise<RoomStatus> {
    const room = this.#rooms.get(project);
    if (!room) return this.status(project);
    const last = { ...this.status(project), running: false, url: null, reachable: false, previewJoined: false };
    room.input.end();
    const ended = await Promise.race([room.closed.then(() => true), sleep(ROOM_STOP_GRACE_MS).then(() => false)]);
    if (!ended) await treeKiller(room.child)();
    await room.ended;
    return { ...last, report: room.report };
  }

  /** End every room (the studio stops). */
  async stopAll(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#rooms.keys()].map((project) => this.stop(project)));
  }

  /** The room module the game declares, a real file in it; refused when there is none. */
  async #module(game: string): Promise<string> {
    const manifest = await readGenexGameManifest(game);
    const module = roomModulePath(manifest?.genex?.authority);
    if (module === null) throw new Error(MESSAGE.NoRoom);
    const file = await containedReal(game, module).catch(() => null);
    const info = file ? await lstat(file).catch(() => null) : null;
    if (!file || !info?.isFile()) throw new Error(MESSAGE.NoModule(module));
    return file;
  }

  /**
   * The toolchain's command line for `args`, run by Electron as node: the variable is set on the
   * line itself, as Windows' live-input relay starts the command without the one it ran under.
   */
  async #command(args: string[]): Promise<string> {
    const cli = path.join(this.#deps.toolDir, CLI_IN_PACKAGE);
    if (!(await lstat(cli).catch(() => null))?.isFile()) throw new Error(MESSAGE.NoToolchain);
    return `ELECTRON_RUN_AS_NODE=1 ${[this.#deps.execPath ?? process.execPath, cli, ...args].map(shellQuote).join(" ")}`;
  }

  /**
   * Where a fenced loopback needs the room: a free port of the range for each listener, the top
   * first (the sandbox's proxies take the range from the bottom). A delay is refused there, as the
   * toolchain's delay proxies listen on a port of their own choosing. Where the room's loopback is
   * its own, ports free on this computer's too, for the bridge to open. Null where it may take any.
   */
  async #ports(latencyMs: number): Promise<RoomPorts | null> {
    const range = this.#deps.loopbackPorts?.() ?? null;
    if (range === null && this.#deps.ownLoopback?.())
      return {
        port: await anyLoopbackPort(RoomPortProtocol.Tcp),
        fastPort: await anyLoopbackPort(RoomPortProtocol.Udp),
      };
    if (range === null) return null;
    if (latencyMs > 0) throw new Error(MESSAGE.NoDelay);
    const port = await this.#freePort(range, RoomPortProtocol.Tcp);
    const fastPort = await this.#freePort(range, RoomPortProtocol.Udp);
    if (port === null || fastPort === null) throw new Error(MESSAGE.NoPort(range));
    return { port, fastPort };
  }

  /** The highest port of `range` free for `protocol`, or null. */
  async #freePort(range: readonly [number, number], protocol: RoomPortProtocol): Promise<number | null> {
    const free = this.#deps.portFree ?? loopbackPortFree;
    const [low, high] = range;
    for (let port = high; port >= low; port--) if (await free(port, protocol)) return port;
    return null;
  }

  /** A run's own scratch folder and TMPDIR. */
  async #scratch(): Promise<{ dir: string; tmp: string }> {
    const dir = path.join(this.#deps.scratch, randomUUID());
    const tmp = path.join(dir, "tmp");
    await mkdir(tmp, { recursive: true });
    return { dir, tmp };
  }

  /** The publish gate on this Mac: the toolchain's verdict on the module. */
  async #validate(game: string, module: string): Promise<RoomVerdict> {
    const command = await this.#command(["validate", "--module", module, "--root", game]);
    const { dir, tmp } = await this.#scratch();
    try {
      const result = await this.#deps.run({
        command,
        cwd: game,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        timeoutMs: ROOM_VALIDATE_TIMEOUT_MS,
        maxOutputBytes: ROOM_OUTPUT_MAX_BYTES,
        keepOutput: OutputKept.Tail,
        label: "genex-room:validate",
        confine: { write: [dir], tmp },
        // Windows takes no confinement (srt-win's grants are the session's): the deny holds there too.
        policy: { denyWrite: [game] },
      });
      const verdict = result.stdout
        .split("\n")
        .map(roomLine)
        .find((line) => line?.kind === RoomLine.Validate)?.value;
      if (typeof verdict === "object" && verdict !== null && "passed" in verdict) return verdict as RoomVerdict;
      throw new Error(MESSAGE.NoVerdict((result.stderr || result.stdout).trim().slice(-2000)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Serve the module with bots, once it listens; the last room of the game ends first. */
  async #start(project: string, game: string, module: string, call: RoomCall): Promise<RoomStatus> {
    await this.stop(project);
    const ports = await this.#ports(call.latencyMs);
    const listeners = ports ? ["--port", String(ports.port), "--fast-port", String(ports.fastPort)] : [];
    const command = await this.#command([
      "start",
      "--module",
      module,
      "--root",
      game,
      "--bots",
      String(call.bots),
      "--latency",
      String(call.latencyMs),
      "--report",
      "--report-every",
      String(ROOM_REPORT_EVERY_MS),
      "--stop-on-stdin-close",
      ...listeners,
    ]);
    // The toolchain writes nothing of the game's; the module itself runs in QuickJS with no files at all.
    // Its own clients (the bots) reach it directly, never through the sandbox's proxy, which Node's
    // clients take on Windows (`NODE_USE_ENV_PROXY`); the sandbox still decides what they reach.
    const { child, input, expose } = await this.#deps.spawn({
      command,
      cwd: game,
      env: { no_proxy: ROOM_HOST },
      label: "genex-room:start",
      policy: { denyWrite: [game] },
      liveInput: true,
      loopbackServer: true,
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const room: Room = {
      child,
      input,
      expose,
      url: null,
      reachable: false,
      game,
      told: false,
      previewJoined: false,
      report: null,
      logs: [],
      errors: [],
      closed,
      ended: Promise.resolve(),
    };
    room.ended = closed.then(() => this.#ended(project, room));
    this.#rooms.set(project, room);
    room.url = await this.#listening(room);
    room.reachable = await this.#reach(room, room.url);
    // A room this computer cannot reach is never handed to the preview: it would load into nothing.
    if (!room.reachable) return this.status(project);
    // An editor's Play (Unreal's GenexMultiplayer) joins it from here; a link in the way names it nowhere.
    await nameRoom(game, room.url).catch(() => undefined);
    room.told = true;
    room.previewJoined = (await this.#deps.onRoom?.(project, room.url).catch(() => false)) ?? false;
    return this.status(project);
  }

  /** Open the room's WebSocket on this computer's loopback where it has its own, then ask it at `url`. */
  async #reach(room: Room, url: string): Promise<boolean> {
    const port = URL.canParse(url) ? Number(new URL(url).port) : 0;
    const opened = await (room.expose?.(port, RoomPortProtocol.Tcp) ?? Promise.resolve()).then(
      () => true,
      () => false,
    );
    return opened && (await (this.#deps.reaches ?? roomAnswers)(url));
  }

  /** Open the room's fast@1 port on this computer's loopback where it has its own; a failure is kept. */
  #exposeFast(room: Room, fast: unknown): void {
    const url = typeof fast === "object" && fast !== null ? Reflect.get(fast, "url") : null;
    const on = typeof fast === "object" && fast !== null && Reflect.get(fast, "state") === FAST_ON;
    if (!room.expose || !on || typeof url !== "string" || !URL.canParse(url)) return;
    room.expose(Number(new URL(url).port), RoomPortProtocol.Udp).catch((error: unknown) => {
      keep(room.errors, { reason: RoomHostFault.FastUnreachable, detail: errorMessage(error) });
    });
  }

  /** The room's address once it prints LISTEN; the room is ended when it fails or takes too long. */
  async #listening(room: Room): Promise<string> {
    const timeoutMs = this.#deps.listenTimeoutMs ?? ROOM_LISTEN_TIMEOUT_MS;
    const listened = new Promise<string>((resolve, reject) => {
      let pending = "";
      room.child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const text of lines) {
          const line = roomLine(text.trim());
          if (line?.kind === RoomLine.Listen && typeof line.value === "string") resolve(line.value);
          this.#note(room, line, reject);
        }
      });
      void room.closed.then(() => reject(new Error(MESSAGE.NoListen(MESSAGE.Exited(room.child.exitCode)))));
    });
    const timer = sleep(timeoutMs).then(() => {
      throw new Error(MESSAGE.TimedOut);
    });
    try {
      return await Promise.race([listened, timer]);
    } catch (error) {
      await treeKiller(room.child)();
      throw error;
    }
  }

  /** Keep what a protocol line says; an ERROR before the room listens fails the start. */
  #note(room: Room, line: ReturnType<typeof roomLine>, fail: (error: Error) => void): void {
    if (line?.kind === RoomLine.Report) room.report = line.value;
    else if (line?.kind === RoomLine.Fast) this.#exposeFast(room, line.value);
    else if (line?.kind === RoomLine.Log) keep(room.logs, line.value);
    else if (line?.kind === RoomLine.Error) {
      keep(room.errors, line.value);
      if (room.url === null) fail(new Error(MESSAGE.NoListen(JSON.stringify(line.value).slice(0, 2000))));
    }
  }

  /** A room's process ended: forget it, and take the preview out of it. */
  async #ended(project: string, room: Room): Promise<void> {
    if (this.#rooms.get(project) !== room) return;
    this.#rooms.delete(project);
    if (room.url !== null) await unnameRoom(room.game, room.url).catch(() => undefined);
    if (room.told && !this.#closing) await this.#deps.onRoom?.(project, null).catch(() => false);
  }
}
