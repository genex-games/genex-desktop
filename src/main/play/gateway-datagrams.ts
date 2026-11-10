/**
 * A native game's fast@1 datagrams (multiplayer PROTOCOL.md §17.12), carried between its sandbox
 * and Genex's authority rooms. The gateway binds its datagram ports on 127.0.0.1 before the game
 * starts (its sandbox names them); a port is given to one fast endpoint once a room's binding names
 * it (`gateway-frames.ts`). Each socket of the game that sends to the port gets a socket of its own
 * towards the endpoint, so the room sees one stable address per game socket and its path check
 * works as it does for any client; an answer goes back only to the socket it belongs to, and only
 * when it came from the endpoint. A datagram larger than the channel's largest is dropped either
 * way, and the senders a port keeps are capped: past it a new sender takes the place of the one the
 * room answered least lately (one it never answered first), so senders the room ignores take each
 * other's places and never a seat's.
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { MINUTE_MS } from "../../shared/duration.ts";

/** Datagram ports a game's gateway reserves: a room's endpoint each, with room for a move or two. */
export const GATEWAY_DATAGRAM_PORTS = 8;
/** The largest datagram the channel sends either way (`FAST_MAX_DATAGRAM_BYTES`). */
export const DATAGRAM_MAX_BYTES = 1200;
/** The most game sockets one port carries at once: a game's seats and their reconnects. */
export const DATAGRAM_SENDERS_MAX = 8;
/** How long a port's endpoint must have been silent before the port may go to another endpoint. */
const ENDPOINT_IDLE_MS = MINUTE_MS;
const LOOPBACK = "127.0.0.1";

/** Where a fast endpoint is: an address and port the gateway sends to. */
export interface DatagramTarget {
  address: string;
  port: number;
}

/** How a fast endpoint's host is found: an address, or null when it may not be reached. */
export type DatagramResolve = (host: string) => Promise<string | null>;

/** The clock the forwarder reads to tell an idle endpoint. */
export interface DatagramClock {
  now(): number;
}

/** What a game's datagram ports are, how one is given to an endpoint, and their end. */
export interface DatagramRelay {
  ports: number[];
  portOf(host: string, port: number): number | undefined;
  close(): Promise<void>;
}

/** One game socket on a port: its own socket to the endpoint and when the room last answered it. */
interface Sender {
  upstream: Socket;
  answeredAt: number;
}

/** One reserved port: its socket, the endpoint it reaches (once given) and its senders. */
interface Lane {
  socket: Socket;
  port: number;
  endpoint: string | null;
  target: Promise<DatagramTarget | null> | null;
  usedAt: number;
  senders: Map<number, Sender>;
}

/** Whether `address` is an IPv4 or IPv6 address a Genex server may have: public unicast only. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    const local = a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
    const reserved = (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    return !local && !reserved;
  }
  if (!net.isIPv6(address)) return false;
  const lower = address.toLowerCase();
  const local = lower === "::" || lower === "::1" || lower.startsWith("fe8") || lower.startsWith("fe9");
  const site =
    lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("ff") || lower.startsWith("::ffff:");
  return !local && !site && !lower.startsWith("fea") && !lower.startsWith("feb");
}

/** The default lookup: the host's first address, refused unless public (a name can't lead to this Mac or its network). */
export const publicLookup: DatagramResolve = async (host) => {
  const address = net.isIP(host) ? host : (await lookup(host).catch(() => null))?.address;
  return address && isPublicAddress(address) ? address : null;
};

/** A socket bound to a free port of 127.0.0.1, and that port. */
async function bindLoopback(): Promise<{ socket: Socket; port: number }> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, LOOPBACK, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return { socket, port: socket.address().port };
}

/** The sender a full port gives up: the one its endpoint answered least lately, never answered first. */
function quietest(senders: Map<number, Sender>): number | undefined {
  let pick: number | undefined;
  let at = Number.POSITIVE_INFINITY;
  for (const [port, sender] of senders)
    if (sender.answeredAt < at) {
      at = sender.answeredAt;
      pick = port;
    }
  return pick;
}

/** Closes a socket that may be closed already. */
function closeQuietly(socket: Socket): void {
  try {
    socket.close();
  } catch {
    // Closed already.
  }
}

/** Ends a lane's senders, its upstream sockets with them. */
function dropSenders(lane: Lane): void {
  for (const sender of lane.senders.values()) closeQuietly(sender.upstream);
  lane.senders.clear();
}

/** The game socket at `from` on `lane`: its own socket to the endpoint, made on its first datagram. */
function senderFor(lane: Lane, from: number, target: DatagramTarget, clock: DatagramClock): Sender {
  const known = lane.senders.get(from);
  if (known) return known;
  if (lane.senders.size >= DATAGRAM_SENDERS_MAX) {
    const gone = quietest(lane.senders);
    if (gone !== undefined) {
      const old = lane.senders.get(gone);
      if (old) closeQuietly(old.upstream);
      lane.senders.delete(gone);
    }
  }
  const upstream = createSocket(net.isIPv6(target.address) ? "udp6" : "udp4");
  const sender: Sender = { upstream, answeredAt: Number.NEGATIVE_INFINITY };
  upstream.on("error", () => {
    closeQuietly(upstream);
    if (lane.senders.get(from) === sender) lane.senders.delete(from);
  });
  upstream.on("message", (bytes: Buffer, back: RemoteInfo) => {
    const fromEndpoint = back.address === target.address && back.port === target.port;
    if (!fromEndpoint || bytes.length > DATAGRAM_MAX_BYTES || lane.senders.get(from) !== sender) return;
    sender.answeredAt = clock.now();
    lane.usedAt = sender.answeredAt;
    lane.socket.send(bytes, from, LOOPBACK);
  });
  lane.senders.set(from, sender);
  return sender;
}

/** One datagram from the game on `lane`: on to its endpoint, or dropped with nothing sent. */
async function fromGame(lane: Lane, bytes: Buffer, from: RemoteInfo, clock: DatagramClock): Promise<void> {
  if (from.address !== LOOPBACK || bytes.length === 0 || bytes.length > DATAGRAM_MAX_BYTES || !lane.target) return;
  const endpoint = lane.endpoint;
  const target = await lane.target;
  // The port went to another endpoint while this one was looked up: the datagram is no longer its.
  if (!target || lane.endpoint !== endpoint) return;
  lane.usedAt = clock.now();
  senderFor(lane, from.port, target, clock).upstream.send(bytes, target.port, target.address);
}

/** Whether a lane may be given to a new endpoint: never given, or its endpoint silent long enough. */
const reusable = (lane: Lane, now: number) => lane.endpoint === null || now - lane.usedAt >= ENDPOINT_IDLE_MS;

/**
 * Binds `count` datagram ports for one game. `portOf` gives an endpoint its port (the same one each
 * time; a new one while any is free or idle), and starts looking its host up through `resolve`.
 */
export async function openDatagramRelay(options: {
  count: number;
  resolve?: DatagramResolve;
  clock?: DatagramClock;
}): Promise<DatagramRelay> {
  const resolve = options.resolve ?? publicLookup;
  const clock = options.clock ?? { now: Date.now };
  const lanes: Lane[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const { socket, port } = await bindLoopback();
    const lane: Lane = { socket, port, endpoint: null, target: null, usedAt: 0, senders: new Map() };
    socket.on("message", (bytes: Buffer, from: RemoteInfo) => void fromGame(lane, bytes, from, clock).catch(() => {}));
    socket.on("error", () => {});
    lanes.push(lane);
  }
  const give = (lane: Lane, host: string, port: number, key: string): number => {
    dropSenders(lane);
    lane.endpoint = key;
    lane.usedAt = clock.now();
    lane.target = resolve(host)
      .then((address) => (address ? { address, port } : null))
      .catch(() => null);
    return lane.port;
  };
  return {
    ports: lanes.map((lane) => lane.port),
    portOf(host, port) {
      const key = `${host}:${port}`;
      const known = lanes.find((lane) => lane.endpoint === key);
      if (known) return known.port;
      const now = clock.now();
      const free = lanes.find((lane) => reusable(lane, now));
      return free ? give(free, host, port, key) : undefined;
    },
    close: async () => {
      for (const lane of lanes) {
        dropSenders(lane);
        await new Promise<void>((done) => lane.socket.close(() => done()));
      }
    },
  };
}
