/**
 * A game from Play on Linux, in bubblewrap: the system read-only (`/usr`, `/etc` and the library
 * folders), its own app read-only, its saves folder its home and the one place it keeps anything,
 * a fresh `/tmp`, `/run` and process table, and none of the person's files. It gets what a game
 * needs to be played: the display (the X11 socket and its cookie, or the Wayland socket), the
 * GPU's device nodes and what Mesa and NVIDIA read of `/sys`, sound (PulseAudio or PipeWire) and
 * gamepads. Its network is a namespace of its own with nothing in it but loopback: when it has a
 * Genex gateway (`main/play/genex-gateway.ts`), socat inside listens on the gateway's ports on
 * 127.0.0.1 and passes each connection through a unix socket to the gateway outside, so Genex is
 * all it can reach. Its fast@1 datagrams cross the same way: socat inside listens on each datagram
 * port and gives each game socket a SOCK_SEQPACKET connection of its own (`u<port>`), whose
 * messages keep each datagram whole; socat outside, Genex's own and run with fixed arguments,
 * passes each connection on as a UDP socket of its own to the gateway's datagram port. It shares the session's IPC namespace, which X11's shared memory needs. It is
 * its own process group (Node's `detached` starts a new session, so it has no terminal either), and
 * dies with Genex.
 */
import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Readable } from "node:stream";
import { ownBubblewrap } from "../linux-bubblewrap.ts";
import { gameGenexEnv, type NativeGameRequest, treeKiller } from "./native-process.ts";

/** Where the gateway's unix sockets are inside the sandbox, one per port, named by it. */
export const GAME_NET_DIR = "/run/genex-net";
/** The `PATH` a game runs with. */
const GAME_PATH = "/usr/bin:/bin";
/** The system folders a game reads: the programs and libraries every Linux program loads. */
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc"];
/** What else of the system a game may read when it is there: fonts' caches and the machine id sound uses. */
const SYSTEM_EXTRAS = ["/var/cache/fontconfig", "/var/lib/dbus/machine-id"];
/** What Mesa and NVIDIA read of `/sys` to find the GPU, read-only. */
const SYS_DIRS = ["/sys/block", "/sys/bus", "/sys/class", "/sys/dev", "/sys/devices"];
/** The device folders a game uses: the GPU (`/dev/dri`) and gamepads (`/dev/input`). */
const DEVICE_DIRS = ["/dev/dri", "/dev/input"];
/** NVIDIA's own device nodes in `/dev`: `nvidia0`, `nvidiactl`, `nvidia-modeset`, `nvidia-uvm`, `nvidia-caps`. */
const NVIDIA_DEVICE = /^nvidia/;
/** X11's local sockets, and the number of a local display (`:0`, `:1.0`). */
const X11_SOCKETS = "/tmp/.X11-unix";
const LOCAL_DISPLAY = /^(?:unix)?:(\d{1,4})(?:\.\d{1,3})?$/;
/** Where a game finds the X11 cookie inside the sandbox. */
const GAME_XAUTHORITY = "/run/genex-xauthority";
/** A Wayland display name: one plain socket name, never a path. */
const WAYLAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The sound servers' sockets in the person's runtime folder. */
const SOUND_SOCKETS = ["pulse/native", "pipewire-0"];
/** Where socat may be; it is on the sandbox's own `PATH` already (the setup screen asks for it). */
const SOCAT_PATHS = ["/usr/bin/socat", "/bin/socat", "/usr/local/bin/socat"];
/** Where bubblewrap is when the app has no copy of its own. */
const BUBBLEWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
/** How long the bridge waits for socat to listen before the game starts anyway, in tries of `BRIDGE_TRY_S`. */
const BRIDGE_TRIES = 100;
const BRIDGE_TRY_S = "0.02";
/** The game sockets one datagram port carries at once, each a socat child on both sides. */
const DATAGRAM_PEERS_MAX = 16;
/** How long a datagram flow may be silent, in seconds, before its socat children end and free their place. */
const DATAGRAM_IDLE_S = 30;
/** How long the outside waits for its datagram sockets to be there before the game starts anyway. */
const DATAGRAM_LISTEN_WAIT_MS = 2_000;
const DATAGRAM_LISTEN_POLL_MS = 20;
/** A datagram port's unix socket in the bridge's folder: `u` and the port, beside the TCP ports' bare numbers. */
const datagramSocket = (port: number) => `u${port}`;

const MESSAGE = { NoBubblewrap: "bubblewrap is not installed" } as const;

/**
 * Inside the sandbox, before the game: socat listening on each gateway port on 127.0.0.1 and
 * passing each connection on to the port's unix socket, and on each datagram port, each game
 * socket's datagrams to the port's SOCK_SEQPACKET socket; then (for a moment, until each listens)
 * a wait, then the game in its place. Its arguments: socat, the ports, `--`, the datagram ports,
 * `--`, the game and its own.
 */
const BRIDGE_SCRIPT = `socat=$1; shift; ports=; datagrams=
while [ "$1" != "--" ]; do
  "$socat" -lf /dev/null TCP-LISTEN:"$1",bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${GAME_NET_DIR}/"$1" &
  ports="$ports $1"; shift
done
shift
while [ "$1" != "--" ]; do
  "$socat" -lf /dev/null -T ${DATAGRAM_IDLE_S} UDP4-LISTEN:"$1",bind=127.0.0.1,fork,reuseaddr,max-children=${DATAGRAM_PEERS_MAX} UNIX-CONNECT:${GAME_NET_DIR}/u"$1",type=5 &
  datagrams="$datagrams $1"; shift
done
shift
await() {
  hex=$(printf '%04X' "$2"); tries=0
  while [ "$tries" -lt ${BRIDGE_TRIES} ] && ! grep -q ":$hex 00000000:0000 $3" "$1"; do
    sleep ${BRIDGE_TRY_S}; tries=$((tries + 1))
  done
}
for port in $ports; do await /proc/net/tcp "$port" 0A; done
for port in $datagrams; do await /proc/net/udp "$port" 07; done
exec "$@"`;

/** A port a game may reach its gateway on: an unprivileged one, a plain number. */
const isGatewayPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/** What of this computer's session a game is given, each found before it starts. */
export interface LinuxGameHost {
  /** The bubblewrap to run. */
  bubblewrap: string;
  /** System folders and files there are (`SYSTEM_DIRS`, `SYSTEM_EXTRAS`, `SYS_DIRS`). */
  system: string[];
  /** Device folders and nodes there are: the GPU's, NVIDIA's and gamepads'. */
  devices: string[];
  /** The X11 display: its number and its socket, and the cookie file when there is one. */
  x11?: { display: string; socket: string; xauthority?: string };
  /** The person's runtime folder, where Wayland's and the sound servers' sockets are. */
  runtimeDir?: string;
  /** The Wayland socket's name in the runtime folder. */
  wayland?: string;
  /** The sound servers' sockets there are, relative to the runtime folder. */
  sound: string[];
  /** The bridge to the gateway: socat, and the folder of unix sockets outside, one per port and datagram port. */
  bridge?: { socat: string; dir: string; ports: number[]; datagramPorts?: number[] };
}

/** One game's start: the program, its arguments and environment, and its folder. */
export interface LinuxGameCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** A plain absolute path: one a mount may name. */
const isPlainAbsolute = (value: string) => path.isAbsolute(value) && path.normalize(value) === value;

/** Read-only mounts of `paths` at the same place. */
const readOnly = (paths: readonly string[]) => paths.filter(isPlainAbsolute).flatMap((at) => ["--ro-bind", at, at]);

/** The display mounts and environment: X11's socket and cookie, Wayland's socket. */
function display(host: LinuxGameHost): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const x11 = host.x11;
  if (x11 && LOCAL_DISPLAY.test(x11.display) && isPlainAbsolute(x11.socket)) {
    const number = LOCAL_DISPLAY.exec(x11.display)?.[1] ?? "0";
    args.push("--ro-bind", x11.socket, path.posix.join(X11_SOCKETS, `X${number}`));
    env.DISPLAY = `:${number}`;
    if (x11.xauthority && isPlainAbsolute(x11.xauthority)) {
      args.push("--ro-bind", x11.xauthority, GAME_XAUTHORITY);
      env.XAUTHORITY = GAME_XAUTHORITY;
    }
  }
  const runtime = host.runtimeDir;
  if (runtime && isPlainAbsolute(runtime) && host.wayland && WAYLAND_NAME.test(host.wayland)) {
    const socket = path.posix.join(runtime, host.wayland);
    args.push("--ro-bind", socket, socket);
    env.WAYLAND_DISPLAY = host.wayland;
  }
  return { args, env };
}

/** The sound servers' sockets, at their own place in the runtime folder. */
function sound(host: LinuxGameHost): { args: string[]; env: Record<string, string> } {
  const runtime = host.runtimeDir;
  if (!runtime || !isPlainAbsolute(runtime)) return { args: [], env: {} };
  const sockets = host.sound
    .filter((name) => SOUND_SOCKETS.includes(name))
    .map((name) => path.posix.join(runtime, name));
  const pulse = path.posix.join(runtime, "pulse/native");
  return {
    args: sockets.flatMap((socket) => ["--ro-bind", socket, socket]),
    env: sockets.includes(pulse) ? { PULSE_SERVER: `unix:${pulse}` } : {},
  };
}

/** The gateway's ports and datagram ports a game may reach through the bridge; none without a bridge. */
function bridgePorts(host: LinuxGameHost, request: NativeGameRequest): { tcp: number[]; udp: number[] } {
  const bridge = host.bridge;
  if (!bridge || !isPlainAbsolute(bridge.dir) || !isPlainAbsolute(bridge.socat)) return { tcp: [], udp: [] };
  const given = (bridged: readonly number[], asked: readonly number[] | undefined) =>
    bridged.filter((port) => isGatewayPort(port) && (asked ?? []).includes(port));
  const tcp = given(bridge.ports, request.genex?.ports);
  // A datagram port goes with the gateway it belongs to: none without a TCP port to reach Genex by.
  return { tcp, udp: tcp.length ? given(bridge.datagramPorts ?? [], request.genex?.datagramPorts) : [] };
}

/**
 * How a game is started in bubblewrap on `host`: every mount named, the process table and the
 * network its own, the gateway's ports its only way out (and the Genex address and ticket in its
 * environment only then). Paths that are not plain and absolute, a display on another computer,
 * a port that is not the gateway's: none is mounted or reached.
 */
export function linuxGameCommand(request: NativeGameRequest, host: LinuxGameHost): LinuxGameCommand {
  const shown = display(host);
  const heard = sound(host);
  const { tcp: ports, udp: datagramPorts } = bridgePorts(host, request);
  const runtime = host.runtimeDir && isPlainAbsolute(host.runtimeDir) ? host.runtimeDir : null;
  const game = [request.binary, ...(request.args ?? [])];
  const bridge = host.bridge;
  const command =
    ports.length && bridge
      ? [
          "/bin/sh",
          "-c",
          BRIDGE_SCRIPT,
          "sh",
          bridge.socat,
          ...ports.map(String),
          "--",
          ...datagramPorts.map(String),
          "--",
          ...game,
        ]
      : game;
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-cgroup-try",
    ...readOnly(host.system),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...host.devices
      .filter((at) => at.startsWith("/dev/") && isPlainAbsolute(at))
      .flatMap((at) => ["--dev-bind", at, at]),
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    ...(runtime ? ["--dir", runtime] : []),
    ...shown.args,
    ...heard.args,
    ...(ports.length && bridge ? ["--ro-bind", bridge.dir, GAME_NET_DIR] : []),
    "--ro-bind",
    request.app,
    request.app,
    "--bind",
    request.saves,
    request.saves,
    "--bind",
    request.scratch,
    request.scratch,
    "--chdir",
    path.dirname(request.binary),
    "--",
    ...command,
  ];
  const env = {
    HOME: request.saves,
    TMPDIR: request.scratch,
    TMP: request.scratch,
    TEMP: request.scratch,
    PATH: GAME_PATH,
    LANG: "en_US.UTF-8",
    ...(runtime ? { XDG_RUNTIME_DIR: runtime } : {}),
    ...shown.env,
    ...heard.env,
    ...(ports.length ? gameGenexEnv(request.genex?.env) : {}),
  };
  return { file: host.bubblewrap, args, env, cwd: path.dirname(request.binary) };
}

/** The first of `paths` that is a program this process may run, or null. */
async function firstProgram(paths: readonly string[]): Promise<string | null> {
  for (const candidate of paths) {
    const runnable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (runnable) return candidate;
  }
  return null;
}

/** What of `paths` exists, by its own spelling. */
const existing = (paths: readonly string[]) => paths.filter((at) => existsSync(at));

/** The GPU's and gamepads' device folders and NVIDIA's nodes there are. */
async function deviceNodes(): Promise<string[]> {
  const nvidia = (await readdir("/dev").catch(() => [] as string[])).filter((name) => NVIDIA_DEVICE.test(name));
  return [...existing(DEVICE_DIRS), ...nvidia.map((name) => path.posix.join("/dev", name))];
}

/** The X11 display of this session, when it is a local one with its socket there. */
async function x11Of(env: NodeJS.ProcessEnv): Promise<LinuxGameHost["x11"]> {
  const number = LOCAL_DISPLAY.exec(env.DISPLAY ?? "")?.[1];
  if (number === undefined) return undefined;
  const socket = path.posix.join(X11_SOCKETS, `X${number}`);
  if (!(await lstat(socket).catch(() => null))?.isSocket()) return undefined;
  const cookie = env.XAUTHORITY || path.join(os.homedir(), ".Xauthority");
  const xauthority = (await lstat(cookie).catch(() => null))?.isFile() ? await realpath(cookie) : undefined;
  return { display: `:${number}`, socket, ...(xauthority ? { xauthority } : {}) };
}

/**
 * The bridge's outside for datagrams: socat on a SOCK_SEQPACKET socket `u<port>` in `dir`, each
 * connection (one game socket inside) its own UDP socket to the gateway's datagram port, in a
 * process group of its own so closing ends its children too. Answers once the socket is there.
 */
async function openDatagramSocket(socat: string, dir: string, port: number): Promise<ChildProcess> {
  const at = path.join(dir, datagramSocket(port));
  const child = spawn(
    socat,
    [
      "-lf",
      "/dev/null",
      "-T",
      String(DATAGRAM_IDLE_S),
      `UNIX-LISTEN:${at},type=5,fork,max-children=${DATAGRAM_PEERS_MAX}`,
      `UDP4:127.0.0.1:${port}`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", () => {});
  const until = Date.now() + DATAGRAM_LISTEN_WAIT_MS;
  while (!existsSync(at) && child.exitCode === null && Date.now() < until) await sleep(DATAGRAM_LISTEN_POLL_MS);
  return child;
}

/** Ends a datagram socket's socat and every child it forked. */
function endGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    // Gone already.
  }
}

/**
 * The bridge's outside: one unix socket per port in a fresh folder of the person's own, each
 * connection passed on to the gateway's port on 127.0.0.1, and (with socat) one per datagram port
 * (`openDatagramSocket`). Closing it ends every connection.
 */
async function openBridge(
  ports: readonly number[],
  datagrams: { socat: string; ports: readonly number[] } | null,
): Promise<{ dir: string; datagramPorts: number[]; close(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "genex-net-"));
  const sockets = new Set<net.Socket>();
  const servers = await Promise.all(
    ports.map(
      (port) =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer((inside) => {
            const outside = net.connect(port, "127.0.0.1");
            for (const socket of [inside, outside]) {
              sockets.add(socket);
              socket.once("close", () => sockets.delete(socket));
              socket.once("error", () => {
                inside.destroy();
                outside.destroy();
              });
            }
            inside.pipe(outside).pipe(inside);
          });
          server.once("error", reject);
          server.listen(path.join(dir, String(port)), () => resolve(server));
        }),
    ),
  );
  const relays = datagrams
    ? await Promise.all(datagrams.ports.map((port) => openDatagramSocket(datagrams.socat, dir, port)))
    : [];
  return {
    dir,
    datagramPorts: datagrams ? [...datagrams.ports] : [],
    close: async () => {
      for (const relay of relays) endGroup(relay);
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The session's runtime folder, and the Wayland socket and sound servers' sockets in it. */
function runtimeOf(env: NodeJS.ProcessEnv): Pick<LinuxGameHost, "runtimeDir" | "wayland" | "sound"> {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !isPlainAbsolute(runtimeDir)) return { sound: [] };
  const named = env.WAYLAND_DISPLAY ?? "";
  const wayland = WAYLAND_NAME.test(named) && existsSync(path.join(runtimeDir, named)) ? named : undefined;
  const sound = SOUND_SOCKETS.filter((name) => existsSync(path.join(runtimeDir, name)));
  return { runtimeDir, sound, ...(wayland ? { wayland } : {}) };
}

/** This session's display, sound, GPU and system as a game is given them, and its bridge when it reaches Genex. */
async function hostFor(
  request: NativeGameRequest,
  socat: string | null,
  bridge: { dir: string; datagramPorts: number[] } | null,
): Promise<LinuxGameHost> {
  const bubblewrap = ownBubblewrap() ?? (await firstProgram(BUBBLEWRAP_PATHS));
  if (!bubblewrap) throw new Error(MESSAGE.NoBubblewrap);
  const x11 = await x11Of(process.env);
  return {
    bubblewrap,
    system: existing([...SYSTEM_DIRS, ...SYSTEM_EXTRAS, ...SYS_DIRS]),
    devices: await deviceNodes(),
    ...runtimeOf(process.env),
    ...(x11 ? { x11 } : {}),
    ...(socat && bridge
      ? {
          bridge: {
            socat,
            dir: bridge.dir,
            ports: [...(request.genex?.ports ?? [])],
            datagramPorts: bridge.datagramPorts,
          },
        }
      : {}),
  };
}

/**
 * A game from Play in bubblewrap with a window, the GPU and sound, its saves folder its home, and
 * no network but its Genex gateway's ports when it has one (`linuxGameCommand`). Nothing it
 * starts outlives it, and its bridge to the gateway closes when it ends.
 */
export async function spawnLinuxGame(p: NativeGameRequest): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const request = {
    ...p,
    binary: await realpath(p.binary),
    app: await realpath(p.app),
    saves: await realpath(p.saves),
    scratch: await realpath(p.scratch),
  };
  const ports = (p.genex?.ports ?? []).filter(isGatewayPort);
  const datagramPorts = (p.genex?.datagramPorts ?? []).filter(isGatewayPort);
  const socat = ports.length ? await firstProgram(SOCAT_PATHS) : null;
  const datagrams = socat && datagramPorts.length ? { socat, ports: datagramPorts } : null;
  const bridge = ports.length ? await openBridge(ports, datagrams) : null;
  try {
    const command = linuxGameCommand(request, await hostFor(request, socat, bridge));
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killAll = treeKiller(child);
    child.once("exit", () => {
      void killAll();
      void bridge?.close();
    });
    child.once("error", () => void bridge?.close());
    return child;
  } catch (error) {
    await bridge?.close();
    throw error;
  }
}
