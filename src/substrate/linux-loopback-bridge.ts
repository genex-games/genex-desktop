/**
 * A sandboxed server this computer must reach, on Linux.
 *
 * sandbox-runtime runs every Linux command in bubblewrap with `--unshare-net`: the command gets a
 * network namespace of its own holding only loopback, and its 127.0.0.1 is not this computer's.
 * Its socat relays carry the command's traffic out to the sandbox's filtering proxies; nothing
 * carries this computer's traffic in. So a server the command starts (a game's local room) is
 * out of reach of the preview and of every other program here.
 *
 * The bridge carries it in, and nothing else. The command is started under a small relay, run by
 * the studio's own Node in the same sandbox, holding a Node IPC channel to the host (a socket pair
 * made before the sandbox starts; the sandbox's seccomp filter refuses the command a unix socket of
 * its own, not one it inherits). For each port exposed, the host listens on that port of its own
 * loopback: a TCP connection it accepts is handed to the relay whole (the socket itself), which
 * joins it to the same port on the sandbox's loopback; a datagram it receives goes to the relay,
 * which sends it on from a socket of its own per sender and passes the answers back, and the host
 * sends an answer only to a sender it heard from. The relay never holds a listening socket or a
 * datagram socket of this computer's, so the command still reaches no network of the host's.
 *
 * The host keeps at most {@link BRIDGE_PEER_MAX} senders a port and decides which one a new sender
 * replaces: the one the server answered least lately, any it never answered first. Every program
 * here may send to the port, and the server answers only its own clients, so senders it ignores
 * take each other's places and never a client's: a client keeps its socket in the sandbox, and so
 * its address at the server, however many others send.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

/** The transports a bridged port carries. */
export const LoopbackProtocol = { Tcp: "tcp", Udp: "udp" } as const;
/** One of {@link LoopbackProtocol}. */
export type LoopbackProtocol = (typeof LoopbackProtocol)[keyof typeof LoopbackProtocol];

/** The variables the relay reads its command and shell from, removed before the command starts. */
export const LoopbackBridgeEnv = {
  Command: "GENEX_BRIDGE_COMMAND",
  Shell: "GENEX_BRIDGE_SHELL",
} as const;
/** One of {@link LoopbackBridgeEnv}. */
export type LoopbackBridgeEnv = (typeof LoopbackBridgeEnv)[keyof typeof LoopbackBridgeEnv];

/** The address bridged on both sides: this computer's loopback, and the sandbox's own. */
const LOOPBACK = "127.0.0.1";
/** The most datagram senders a bridged port keeps, each with its own socket in the sandbox. */
export const BRIDGE_PEER_MAX = 64;
/** The largest datagram over IPv4, and so the largest one passed either way. */
const DATAGRAM_MAX_BYTES = 65_507;
/** Its length in base64, as it crosses the channel. */
const DATAGRAM_MAX_BASE64 = Math.ceil(DATAGRAM_MAX_BYTES / 3) * 4;

/** What crosses the channel, each way: a connection to join (with its socket) or one datagram. */
export interface BridgeMessage {
  kind: LoopbackProtocol;
  port: number;
  /** A datagram's sender on this computer, `address:port`, as the host names it. */
  peer?: string;
  /** A datagram's bytes, base64. */
  data?: string;
  /** A sender the host no longer keeps, from host to relay: its socket in the sandbox is closed. */
  forget?: string;
}

/**
 * The relay, run as CommonJS by Node (or Electron as Node) inside the sandbox. It deletes its own
 * file first, starts the command with the terminal's stdio (so the command's stdin, stdout and
 * stderr are the host's pipes) and exits with it.
 */
const RELAY_SOURCE = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const { spawn } = require("node:child_process");
try { fs.rmSync(__filename, { force: true }); } catch {}
const env = { ...process.env };
const take = (name) => { const value = env[name] ?? ""; delete env[name]; return value; };
const command = take(${JSON.stringify(LoopbackBridgeEnv.Command)});
const shell = take(${JSON.stringify(LoopbackBridgeEnv.Shell)});
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(shell, ["-c", command], { env, stdio: "inherit" });
child.on("error", (error) => { process.stderr.write(String(error) + "\\n"); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
const flows = new Map();
const flow = (port, peer) => {
  const key = port + " " + peer;
  const known = flows.get(key);
  if (known) { flows.delete(key); flows.set(key, known); return known; }
  if (flows.size >= ${BRIDGE_PEER_MAX}) forget(flows.keys().next().value);
  const socket = dgram.createSocket("udp4");
  socket.on("message", (data, from) => {
    if (from.port !== port || !process.connected) return;
    process.send({ kind: "udp", port, peer, data: data.toString("base64") });
  });
  socket.on("error", () => { if (flows.get(key) === socket) flows.delete(key); try { socket.close(); } catch {} });
  flows.set(key, socket);
  return socket;
};
const forget = (key) => { const gone = flows.get(key); flows.delete(key); try { gone?.close(); } catch {} };
process.on("message", (message, handle) => {
  if (!message || typeof message !== "object" || !Number.isInteger(message.port)) return;
  if (message.kind === "udp" && typeof message.forget === "string") forget(message.port + " " + message.forget);
  else if (message.kind === "tcp" && handle instanceof net.Socket) {
    const inner = net.connect(message.port, "127.0.0.1");
    const end = () => { handle.destroy(); inner.destroy(); };
    for (const side of [handle, inner]) { side.on("error", end); side.on("close", end); }
    handle.pipe(inner);
    inner.pipe(handle);
    handle.resume();
  } else if (message.kind === "udp" && typeof message.peer === "string" && typeof message.data === "string") {
    flow(message.port, message.peer).send(Buffer.from(message.data, "base64"), message.port, "127.0.0.1");
  }
});
`;

/** One datagram sender the host heard on a bridged port. */
interface Peer {
  address: string;
  port: number;
  /** When the server last answered it, as the port's count of answers then; 0 if it never has. */
  answered: number;
}

/** A bridged UDP port: the host's socket on it, the senders it may answer (the least lately heard first), and its answers so far. */
interface DatagramPort {
  socket: DatagramSocket;
  peers: Map<string, Peer>;
  answers: number;
}

/** One process's bridge: its relay's file and variables, and the host's side of its ports. */
export interface LoopbackBridge {
  /** The relay's file, for the studio's own Node to run with `ELECTRON_RUN_AS_NODE` set. */
  file: string;
  /** The relay's variables, for the run's environment. */
  env: Record<LoopbackBridgeEnv, string>;
  /** The started process: its IPC channel is the relay's. */
  attach(child: ChildProcess): void;
  /** Listen on `port` of this computer's loopback and carry what arrives to the same port in the sandbox. */
  expose(port: number, protocol: LoopbackProtocol): Promise<void>;
  /** Stop listening, and remove the relay's file if it never ran. */
  close(): Promise<void>;
}

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;

/** A datagram's sender as the channel names it. */
const peerKey = (peer: Pick<Peer, "address" | "port">) => `${peer.address}:${peer.port}`;

/** A TCP listener on `port` of this computer's loopback, holding each connection until it is handed on. */
function listenTcp(port: number, onSocket: (socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer({ pauseOnConnect: true }, onSocket);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** A UDP socket bound to `port` of this computer's loopback. */
function bindUdp(port: number): Promise<DatagramSocket> {
  const socket = createSocket("udp4");
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, LOOPBACK, () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

/**
 * The sender a new one replaces on a full port: the one the server answered least lately (one it
 * never answered before any it did), the least lately heard of equals.
 */
function replaced(peers: ReadonlyMap<string, Peer>): string | undefined {
  let chosen: [string, Peer] | undefined;
  for (const entry of peers) if (chosen === undefined || entry[1].answered < chosen[1].answered) chosen = entry;
  return chosen?.[0];
}

/**
 * Remember `from` on `bound` as the latest heard; past {@link BRIDGE_PEER_MAX} senders, the one
 * {@link replaced} chooses is forgotten first, and named.
 */
function hear(bound: DatagramPort, from: { address: string; port: number }): { key: string; forgot?: string } {
  const key = peerKey(from);
  const known = bound.peers.get(key);
  bound.peers.delete(key);
  const full = known === undefined && bound.peers.size >= BRIDGE_PEER_MAX;
  const forgot = full ? replaced(bound.peers) : undefined;
  if (forgot !== undefined) bound.peers.delete(forgot);
  bound.peers.set(key, known ?? { address: from.address, port: from.port, answered: 0 });
  return forgot === undefined ? { key } : { key, forgot };
}

/**
 * The relay's answer, sent on only when it is a datagram for a bridged port, to a sender that port
 * heard from, no longer than a datagram: anything else the relay says is dropped unheard.
 */
function answer(datagrams: ReadonlyMap<number, DatagramPort>, message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const [kind, port, peer, data]: unknown[] = ["kind", "port", "peer", "data"].map((key) => Reflect.get(message, key));
  if (kind !== LoopbackProtocol.Udp || !isPort(port) || typeof peer !== "string" || typeof data !== "string") return;
  const bound = datagrams.get(port);
  const to = bound?.peers.get(peer);
  if (!bound || !to || data.length > DATAGRAM_MAX_BASE64) return;
  bound.answers++;
  to.answered = bound.answers;
  bound.socket.send(Buffer.from(data, "base64"), to.port, to.address);
}

/**
 * Prepare a bridge for `command`, run under `shell` by the relay, whose file is written in
 * `scratchDir` (the sandbox reads it; the relay deletes it as it starts).
 */
export async function openLoopbackBridge(options: {
  command: string;
  shell: string;
  scratchDir: string;
}): Promise<LoopbackBridge> {
  const file = path.join(options.scratchDir, `.loopback-bridge-${randomUUID()}.cjs`);
  await writeFile(file, RELAY_SOURCE, { mode: 0o600 });
  const servers = new Map<number, net.Server>();
  const datagrams = new Map<number, DatagramPort>();
  let relay: ChildProcess | null = null;
  const send = (message: BridgeMessage, socket?: net.Socket) => {
    if (!relay?.connected) {
      socket?.destroy();
      return;
    }
    relay.send(message, socket, { keepOpen: false }, (error) => {
      if (error) socket?.destroy();
    });
  };
  const exposeTcp = async (port: number) => {
    servers.set(port, await listenTcp(port, (socket) => send({ kind: LoopbackProtocol.Tcp, port }, socket)));
  };
  const exposeUdp = async (port: number) => {
    const bound: DatagramPort = { socket: await bindUdp(port), peers: new Map(), answers: 0 };
    bound.socket.on("message", (data, from) => {
      const { key, forgot } = hear(bound, from);
      if (forgot !== undefined) send({ kind: LoopbackProtocol.Udp, port, forget: forgot });
      send({ kind: LoopbackProtocol.Udp, port, peer: key, data: data.toString("base64") });
    });
    bound.socket.on("error", () => {});
    datagrams.set(port, bound);
  };
  return {
    file,
    env: { [LoopbackBridgeEnv.Command]: options.command, [LoopbackBridgeEnv.Shell]: options.shell },
    attach(child) {
      relay = child;
      child.on("message", (message: unknown) => answer(datagrams, message));
    },
    async expose(port, protocol) {
      if (!isPort(port)) throw new RangeError(`not a port: ${port}`);
      if (protocol === LoopbackProtocol.Tcp && !servers.has(port)) await exposeTcp(port);
      if (protocol === LoopbackProtocol.Udp && !datagrams.has(port)) await exposeUdp(port);
    },
    async close() {
      relay = null;
      const closing = [...servers.values()].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      for (const { socket } of datagrams.values()) socket.close();
      servers.clear();
      datagrams.clear();
      await Promise.all(closing);
      await rm(file, { force: true });
    },
  };
}
